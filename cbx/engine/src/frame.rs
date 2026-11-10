//! Chunk frames, the shape every object takes in a `.cbx` bundle and in the local store.
//!
//! Byte layout, the same as `chunkFrame` in `cbx/src/core/cbx.ts`:
//!
//! ```text
//!   0  "CHNK"
//!   4  codec (0 none, 1 zstd), then three zero bytes
//!   8  raw size, u64 little-endian
//!  16  stored size, u64 little-endian
//!  24  SHA-256 of the raw bytes      (the object's name)
//!  56  SHA-256 of the stored bytes
//!  88  the stored bytes
//! ```
//!
//! Stored bytes are zstd at level 3 when that saves at least two percent. A
//! different zstd build may squeeze the same bytes differently; that changes
//! the stored bytes and their digest, never the object's name, and every
//! reader checks both, so frames from either implementation read in the other.

use sha2::{Digest, Sha256};

pub const MAGIC: &[u8; 4] = b"CHNK";
pub const HEADER_BYTES: usize = 88;
pub const CODEC_NONE: u8 = 0;
pub const CODEC_ZSTD: u8 = 1;
pub const ZSTD_LEVEL: i32 = 3;
const MIN_COMPRESSION_SAVING: f64 = 0.02;

#[derive(Debug)]
pub enum FrameError {
    NotAFrame,
    Damaged,
    UnknownCodec(u8),
    WrongIdentity,
    Zstd(std::io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::NotAFrame => write!(f, "not a chunk frame"),
            FrameError::Damaged => write!(f, "chunk frame is damaged"),
            FrameError::UnknownCodec(codec) => write!(f, "chunk uses an unknown codec ({codec})"),
            FrameError::WrongIdentity => write!(f, "chunk does not match its identity"),
            FrameError::Zstd(error) => write!(f, "chunk did not decompress: {error}"),
        }
    }
}

impl std::error::Error for FrameError {}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub struct Framed {
    pub frame: Vec<u8>,
    pub digest: [u8; 32],
    pub codec: u8,
    pub stored_size: usize,
}

/// The frame for `raw`, compressed at `ZSTD_LEVEL` when worth it.
pub fn chunk_frame(raw: &[u8]) -> Framed {
    chunk_frame_at(raw, ZSTD_LEVEL)
}

/// zstd with one compression context per thread and level, kept between calls. Making a fresh
/// context for every object cost more than compressing most small objects.
pub fn compress(bytes: &[u8], level: i32) -> std::io::Result<Vec<u8>> {
    use std::cell::RefCell;
    thread_local! {
        static CONTEXTS: RefCell<Vec<(i32, zstd::bulk::Compressor<'static>)>> = const { RefCell::new(Vec::new()) };
    }
    CONTEXTS.with(|contexts| {
        let mut contexts = contexts.borrow_mut();
        let at = match contexts.iter().position(|(l, _)| *l == level) {
            Some(at) => at,
            None => {
                contexts.push((level, zstd::bulk::Compressor::new(level)?));
                contexts.len() - 1
            }
        };
        contexts[at].1.compress(bytes)
    })
}

/// Bytes taken from each of three places to judge whether a large object compresses at all.
const PROBE_BYTES: usize = 32 * 1024;
/// Objects at least this big are probed before the whole of them is compressed.
const PROBE_FROM: usize = 1024 * 1024;

/// Whether compressing `raw` could save anything: false only when the start, middle and end
/// all save less than one percent, the mark of bytes that are already compressed (archives,
/// media, jars). Such an object is stored as it is, which both readers accept; its name is the
/// same either way. Skipping the attempt is most of a first save's time on folders of those files.
pub fn worth_compressing(raw: &[u8], level: i32) -> bool {
    if raw.len() < PROBE_FROM {
        return true;
    }
    let spots = [0, raw.len() / 2 - PROBE_BYTES / 2, raw.len() - PROBE_BYTES];
    spots.iter().any(|&at| {
        let sample = &raw[at..at + PROBE_BYTES];
        match compress(sample, level) {
            Ok(z) => (z.len() as f64) < sample.len() as f64 * 0.99,
            Err(_) => true,
        }
    })
}

pub fn chunk_frame_at(raw: &[u8], level: i32) -> Framed {
    chunk_frame_named(raw, sha256(raw), level)
}

/// The frame for `raw` whose SHA-256 the caller has already taken.
pub fn chunk_frame_named(raw: &[u8], digest: [u8; 32], level: i32) -> Framed {
    let mut codec = CODEC_NONE;
    let mut squeezed = None;
    if !raw.is_empty() && worth_compressing(raw, level) {
        if let Ok(z) = compress(raw, level) {
            if (z.len() as f64) <= raw.len() as f64 * (1.0 - MIN_COMPRESSION_SAVING) {
                codec = CODEC_ZSTD;
                squeezed = Some(z);
            }
        }
    }
    let stored: &[u8] = squeezed.as_deref().unwrap_or(raw);
    let stored_digest = sha256(stored);
    let mut frame = Vec::with_capacity(HEADER_BYTES + stored.len());
    frame.extend_from_slice(MAGIC);
    frame.push(codec);
    frame.extend_from_slice(&[0, 0, 0]);
    frame.extend_from_slice(&(raw.len() as u64).to_le_bytes());
    frame.extend_from_slice(&(stored.len() as u64).to_le_bytes());
    frame.extend_from_slice(&digest);
    frame.extend_from_slice(&stored_digest);
    frame.extend_from_slice(stored);
    Framed { stored_size: stored.len(), frame, digest, codec }
}

/// The raw bytes of a frame, checked against the name it was filed under.
pub fn open_chunk_frame(frame: &[u8], expected: &[u8; 32]) -> Result<Vec<u8>, FrameError> {
    if frame.len() < HEADER_BYTES || &frame[0..4] != MAGIC {
        return Err(FrameError::NotAFrame);
    }
    let codec = frame[4];
    let raw_size = u64::from_le_bytes(frame[8..16].try_into().unwrap()) as usize;
    let stored_size = u64::from_le_bytes(frame[16..24].try_into().unwrap()) as usize;
    let stored = &frame[HEADER_BYTES..];
    if stored.len() != stored_size || sha256(stored) != frame[56..88] {
        return Err(FrameError::Damaged);
    }
    let raw = match codec {
        CODEC_NONE => stored.to_vec(),
        CODEC_ZSTD => zstd::bulk::decompress(stored, raw_size).map_err(FrameError::Zstd)?,
        other => return Err(FrameError::UnknownCodec(other)),
    };
    if raw.len() != raw_size || &sha256(&raw) != expected {
        return Err(FrameError::WrongIdentity);
    }
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_checks() {
        for raw in [Vec::new(), b"hello".to_vec(), vec![7u8; 100_000]] {
            let framed = chunk_frame(&raw);
            assert_eq!(open_chunk_frame(&framed.frame, &framed.digest).unwrap(), raw);
            let mut damaged = framed.frame.clone();
            if damaged.len() > HEADER_BYTES {
                let last = damaged.len() - 1;
                damaged[last] ^= 1;
                assert!(open_chunk_frame(&damaged, &framed.digest).is_err());
            }
            assert!(open_chunk_frame(&framed.frame, &[0u8; 32]).is_err());
        }
        assert_eq!(chunk_frame(&vec![7u8; 100_000]).codec, CODEC_ZSTD);
        assert_eq!(chunk_frame(b"hello").codec, CODEC_NONE);
    }
}
