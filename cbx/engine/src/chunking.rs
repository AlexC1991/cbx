//! Content-defined chunking, cut for cut the same as `cbx/src/shared/chunking.ts`.
//!
//! The cut points are part of what CodeRook already stores: a chunk's name is
//! the SHA-256 of its bytes, so a chunker that cut one byte differently would
//! name different objects and nothing already uploaded would be reused. This
//! module therefore copies the TypeScript rules exactly — the same GEAR table,
//! the same profiles, the same "hash every byte, test once past the minimum"
//! loop — and the cross-tests compare the two on real files.
//!
//! One thing is done faster without changing any answer. The rolling hash is
//! `hash = (hash << 1) + GEAR[byte]` in 32 bits, so after 32 bytes nothing of
//! the earlier bytes is left in it. The TypeScript hashes every byte of the
//! minimum-size stretch it never tests; here hashing starts 32 bytes before the
//! first byte that is tested, which gives the same hash there and skips most of
//! the work in that stretch.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Profile {
    pub id: &'static str,
    pub algorithm: &'static str,
    pub min_size: usize,
    pub target_size: usize,
    pub max_size: usize,
    pub strict_mask: u32,
    pub loose_mask: u32,
}

const KIB: usize = 1024;
const MIB: usize = 1024 * KIB;

pub const LEGACY: Profile = Profile {
    id: "gear-legacy-v1",
    algorithm: "gear-streaming",
    min_size: 2 * MIB,
    target_size: 8 * MIB,
    max_size: 32 * MIB,
    strict_mask: 0x0003_5403,
    loose_mask: 0x0003_5000,
};

pub const MEDIUM: Profile = Profile {
    id: "fastcdc-v2-medium",
    algorithm: "fastcdc-v2",
    min_size: 256 * KIB,
    target_size: MIB,
    max_size: 4 * MIB,
    strict_mask: 0x001f_ffff,
    loose_mask: 0x0007_ffff,
};

pub const LARGE: Profile = Profile {
    id: "fastcdc-v2-large",
    algorithm: "fastcdc-v2",
    min_size: MIB,
    target_size: 4 * MIB,
    max_size: 16 * MIB,
    strict_mask: 0x007f_ffff,
    loose_mask: 0x001f_ffff,
};

pub const HUGE: Profile = Profile {
    id: "fastcdc-v2-huge",
    algorithm: "fastcdc-v2",
    min_size: 2 * MIB,
    target_size: 8 * MIB,
    max_size: 32 * MIB,
    strict_mask: 0x00ff_ffff,
    loose_mask: 0x003f_ffff,
};

pub const MICRO: Profile = Profile {
    id: "fastcdc-v3-micro",
    algorithm: "fastcdc-v2",
    min_size: 256 * KIB,
    target_size: MIB,
    max_size: 4 * MIB,
    strict_mask: 0x001f_ffff,
    loose_mask: 0x0007_ffff,
};

pub const DEFAULT: Profile = HUGE;

pub const ALL: [Profile; 5] = [LEGACY, MEDIUM, LARGE, HUGE, MICRO];

pub fn profile_named(id: &str) -> Option<Profile> {
    ALL.iter().copied().find(|profile| profile.id == id)
}

/// The profile a file of `size` bytes is cut with; `None` below 8 MiB, where a file is one object.
pub fn profile_for_file_size(size: u64) -> Option<Profile> {
    const M: u64 = MIB as u64;
    if size < 8 * M {
        None
    } else if size < 128 * M {
        Some(MEDIUM)
    } else if size < 2 * 1024 * M {
        Some(LARGE)
    } else {
        Some(HUGE)
    }
}

/// The profile when the service advertises `microchunk-map-v1`.
pub fn microchunk_profile_for_file_size(size: u64) -> Option<Profile> {
    profile_for_file_size(size).map(|_| MICRO)
}

pub static GEAR: [u32; 256] = gear_table();

const fn gear_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut seed: u32 = 0x9e37_79b9;
    let mut index = 0;
    while index < 256 {
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        table[index] = seed;
        index += 1;
    }
    table
}

/// The hash carries the last 32 bytes and nothing older.
const HASH_MEMORY: usize = 32;

/// A chunker fed a file piece by piece, giving the cut points `cutPoints` gives for the whole file.
pub struct Chunker {
    profile: Profile,
    /// Bytes since the last cut, across every piece fed so far.
    length: usize,
    hash: u32,
}

impl Chunker {
    pub fn new(profile: Profile) -> Self {
        Self { profile, length: 0, hash: 0 }
    }

    /// Feed the next bytes of the file. Cut points are pushed as offsets within `bytes`, each the end of a chunk.
    pub fn feed(&mut self, bytes: &[u8], cuts: &mut Vec<usize>) {
        let profile = self.profile;
        let mut at = 0usize;
        while at < bytes.len() {
            /* Jump over the stretch no test is made in, keeping only the bytes the hash still holds. */
            let untested = profile.min_size.saturating_sub(1);
            if self.length + HASH_MEMORY < untested {
                let skip = (untested - HASH_MEMORY - self.length).min(bytes.len() - at);
                self.length += skip;
                at += skip;
                if self.length + HASH_MEMORY >= untested {
                    /* Whatever the hash held is about to be shifted out entirely. */
                    self.hash = 0;
                }
                continue;
            }
            /* Hash, testing nothing, up to the minimum size. */
            if self.length + 1 < profile.min_size {
                let n = (profile.min_size - 1 - self.length).min(bytes.len() - at);
                let mut hash = self.hash;
                for &byte in &bytes[at..at + n] {
                    hash = (hash << 1).wrapping_add(GEAR[byte as usize]);
                }
                self.hash = hash;
                self.length += n;
                at += n;
                continue;
            }
            /* Then test each byte: the strict mask below the target size, the loose one above, a forced cut at the maximum. */
            let (mask, limit) = if self.length + 1 < profile.target_size {
                (profile.strict_mask, profile.target_size - 1)
            } else {
                (profile.loose_mask, profile.max_size)
            };
            let n = (limit - self.length).min(bytes.len() - at);
            let mut hash = self.hash;
            let mut found = None;
            for (offset, &byte) in bytes[at..at + n].iter().enumerate() {
                hash = (hash << 1).wrapping_add(GEAR[byte as usize]);
                if hash & mask == 0 {
                    found = Some(offset);
                    break;
                }
            }
            match found {
                Some(offset) => {
                    at += offset + 1;
                    cuts.push(at);
                    self.length = 0;
                    self.hash = 0;
                }
                None => {
                    self.hash = hash;
                    self.length += n;
                    at += n;
                    if self.length >= profile.max_size {
                        cuts.push(at);
                        self.length = 0;
                        self.hash = 0;
                    }
                }
            }
        }
    }
}

/// Cut points for a whole buffer, as `cutPoints(bytes, profile)` returns them.
pub fn cut_points(bytes: &[u8], profile: Profile) -> Vec<usize> {
    let mut cuts = Vec::new();
    Chunker::new(profile).feed(bytes, &mut cuts);
    cuts
}

/// The plain loop, byte for byte the TypeScript one. Kept for the tests that prove the fast one equal.
pub fn cut_points_reference(bytes: &[u8], profile: Profile) -> Vec<usize> {
    let mut cuts = Vec::new();
    let mut from = 0usize;
    let mut hash: u32 = 0;
    for at in 0..bytes.len() {
        hash = (hash << 1).wrapping_add(GEAR[bytes[at] as usize]);
        let length = at - from + 1;
        if length < profile.min_size {
            continue;
        }
        let mask = if length < profile.target_size { profile.strict_mask } else { profile.loose_mask };
        if length >= profile.max_size || (hash & mask) == 0 {
            cuts.push(at + 1);
            from = at + 1;
            hash = 0;
        }
    }
    cuts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(len: usize, seed: u32) -> Vec<u8> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                (state >> 24) as u8
            })
            .collect()
    }

    #[test]
    fn gear_table_matches_the_typescript_seed() {
        /* First entries of the table chunking.ts builds. */
        let mut seed: u32 = 0x9e37_79b9;
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        assert_eq!(GEAR[0], seed);
    }

    #[test]
    fn fast_equals_reference_on_noise_and_runs() {
        let mut data = noise(40 * MIB, 7);
        /* Long flat stretches, where only max_size cuts. */
        for byte in &mut data[10 * MIB..19 * MIB] {
            *byte = 0;
        }
        for profile in [MEDIUM, LARGE, HUGE, MICRO, LEGACY] {
            assert_eq!(cut_points(&data, profile), cut_points_reference(&data, profile), "{}", profile.id);
        }
    }

    #[test]
    fn feeding_in_pieces_equals_whole() {
        let data = noise(20 * MIB, 99);
        let whole = cut_points(&data, MEDIUM);
        for piece in [1usize, 31, 32, 33, 4096, 262_143, 262_144, 1 << 20, 3 << 20] {
            let mut chunker = Chunker::new(MEDIUM);
            let mut cuts = Vec::new();
            let mut base = 0usize;
            for part in data.chunks(piece) {
                let mut local = Vec::new();
                chunker.feed(part, &mut local);
                cuts.extend(local.into_iter().map(|cut| cut + base));
                base += part.len();
            }
            assert_eq!(cuts, whole, "piece {piece}");
        }
    }
}
