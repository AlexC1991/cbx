//! A copy/insert byte delta against one or more bases — CBX v2's way of storing
//! a changed object as the bytes that changed. Local storage only: what goes to
//! CodeRook is still whole objects (or the existing CRP transport patches), so
//! nothing the service holds depends on this format.
//!
//! Format (version 4), all numbers LEB128:
//!
//! ```text
//!   4, used-base count, each used base's length, target length, flag,
//!   ops (zstd-compressed when flag = 1):
//!     0x00 len bytes…        insert literal bytes
//!     0x01 base offset len   copy from bases[base][offset..]
//!     0x02 zigzag(d) len     copy from the last copy's base, at
//!                            (where it ended + bytes inserted since) + d
//! ```
//!
//! Only the bases a copy reads are recorded, numbered in first-use order.
//! Ported from the research prototype (`proto/delta.mjs`); the decoders accept
//! each other's output, which the cross-tests check.

use std::fmt;

pub const VERSION: u8 = 4;
const BLOCK: usize = 16;
const P: u32 = 0x0100_0193;
const LITERAL_RUN_LIMIT: usize = 1 << 20;

#[derive(Debug)]
pub enum DeltaError {
    NotADelta,
    Truncated,
    WrongBase,
    PastTheEnd,
    UnknownOp(u8),
    WrongLength,
    Zstd(std::io::Error),
}

impl fmt::Display for DeltaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DeltaError::NotADelta => write!(f, "not a version {VERSION} delta"),
            DeltaError::Truncated => write!(f, "delta is cut short"),
            DeltaError::WrongBase => write!(f, "copy from a missing or wrong base"),
            DeltaError::PastTheEnd => write!(f, "delta writes past the end"),
            DeltaError::UnknownOp(op) => write!(f, "unknown delta op {op}"),
            DeltaError::WrongLength => write!(f, "delta produced the wrong length"),
            DeltaError::Zstd(error) => write!(f, "delta ops did not decompress: {error}"),
        }
    }
}

impl std::error::Error for DeltaError {}

fn varint(out: &mut Vec<u8>, mut n: u64) {
    loop {
        let mut byte = (n & 127) as u8;
        n >>= 7;
        if n != 0 {
            byte |= 128;
        }
        out.push(byte);
        if n == 0 {
            break;
        }
    }
}

fn read_varint(buf: &[u8], at: &mut usize) -> Result<u64, DeltaError> {
    let mut n = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *buf.get(*at).ok_or(DeltaError::Truncated)?;
        *at += 1;
        if shift > 63 {
            return Err(DeltaError::Truncated);
        }
        n |= ((byte & 127) as u64) << shift;
        shift += 7;
        if byte & 128 == 0 {
            return Ok(n);
        }
    }
}

fn zig(n: i64) -> u64 {
    if n >= 0 { (n as u64) * 2 } else { ((-n) as u64) * 2 - 1 }
}

fn unzig(n: u64) -> i64 {
    if n % 2 == 0 { (n / 2) as i64 } else { -(((n + 1) / 2) as i64) }
}

const fn power_of_p() -> u32 {
    let mut pw: u32 = 1;
    let mut i = 0;
    while i < BLOCK {
        pw = pw.wrapping_mul(P);
        i += 1;
    }
    pw
}
const PW: u32 = power_of_p();

#[inline]
fn hash_at(buf: &[u8], i: usize) -> u32 {
    let mut h: u32 = 0;
    for &byte in &buf[i..i + BLOCK] {
        h = h.wrapping_mul(P).wrapping_add(byte as u32);
    }
    h
}

enum Op {
    Literal { start: usize, len: usize },
    Copy { base: usize, offset: usize, len: usize },
}

pub struct Delta {
    pub bytes: Vec<u8>,
    /// Indexes into the bases given, in the order the delta numbers them.
    pub used_order: Vec<usize>,
    /// The `[start, length]` runs that had to be inserted.
    pub literals: Vec<(usize, usize)>,
}

#[inline]
fn same_run(a: &[u8], b: &[u8]) -> usize {
    a.iter().zip(b).take_while(|(x, y)| x == y).count()
}

/// The ops that turn `bases` into `target`.
pub fn make_delta(bases: &[&[u8]], target: &[u8]) -> Delta {
    let mut ops: Vec<Op> = Vec::new();
    let mut literals = Vec::new();
    let mut literal_start = 0usize;
    let total: usize = bases.iter().map(|b| b.len()).sum();
    if total >= BLOCK && target.len() >= BLOCK {
        let wanted = ((total / BLOCK) * 2 + 1) as f64;
        let bits = (wanted.log2().ceil() as u32).max(10).min(30);
        let slots = 1usize << bits;
        let mask = (slots - 1) as u32;
        let mut t_base = vec![-1i32; slots];
        let mut t_off = vec![0u32; slots];
        for (bi, base) in bases.iter().enumerate() {
            let mut i = 0;
            while i + BLOCK <= base.len() {
                let s = (hash_at(base, i) & mask) as usize;
                t_base[s] = bi as i32;
                t_off[s] = i as u32;
                i += BLOCK;
            }
        }
        let mut i = 0usize;
        let mut h = hash_at(target, 0);
        let mut last_base: i32 = -1;
        let mut last_end = 0usize;
        while i + BLOCK <= target.len() {
            let s = (h & mask) as usize;
            let mut cand_base = t_base[s];
            let mut cand_off = t_off[s] as usize;
            if last_base >= 0 {
                let cb = bases[last_base as usize];
                let co = last_end + (i - literal_start);
                if co + BLOCK <= cb.len() && cb[co..co + BLOCK] == target[i..i + BLOCK] {
                    /* Text repeats itself: carry on where we were rather than jump to another copy. */
                    cand_base = last_base;
                    cand_off = co;
                }
            }
            let mut matched = false;
            if cand_base >= 0 {
                let base = bases[cand_base as usize];
                if cand_off + BLOCK <= base.len() && base[cand_off..cand_off + BLOCK] == target[i..i + BLOCK] {
                    let (mut bs, mut ts) = (cand_off, i);
                    while bs > 0 && ts > literal_start && base[bs - 1] == target[ts - 1] {
                        bs -= 1;
                        ts -= 1;
                    }
                    let mut len = i - ts + BLOCK;
                    len += same_run(&base[bs + len..], &target[ts + len..]);
                    if ts > literal_start {
                        ops.push(Op::Literal { start: literal_start, len: ts - literal_start });
                        literals.push((literal_start, ts - literal_start));
                    }
                    ops.push(Op::Copy { base: cand_base as usize, offset: bs, len });
                    last_base = cand_base;
                    last_end = bs + len;
                    i = ts + len;
                    literal_start = i;
                    if i + BLOCK <= target.len() {
                        h = hash_at(target, i);
                    }
                    matched = true;
                }
            }
            if !matched {
                if i + BLOCK < target.len() {
                    h = h
                        .wrapping_mul(P)
                        .wrapping_sub((target[i] as u32).wrapping_mul(PW))
                        .wrapping_add(target[i + BLOCK] as u32);
                }
                i += 1;
            }
        }
    }
    if target.len() > literal_start {
        ops.push(Op::Literal { start: literal_start, len: target.len() - literal_start });
        literals.push((literal_start, target.len() - literal_start));
    }

    /* Number the bases actually used, then encode. */
    let mut used_order = Vec::new();
    let mut renumber = vec![usize::MAX; bases.len()];
    for op in &ops {
        if let Op::Copy { base, .. } = op {
            if renumber[*base] == usize::MAX {
                renumber[*base] = used_order.len();
                used_order.push(*base);
            }
        }
    }
    let mut body = Vec::new();
    let mut last: usize = usize::MAX;
    let (mut expected, mut inserted_since) = (0usize, 0usize);
    for op in &ops {
        match *op {
            Op::Literal { start, len } => {
                let (mut at, mut left) = (start, len);
                while left > 0 {
                    let n = left.min(LITERAL_RUN_LIMIT);
                    body.push(0x00);
                    varint(&mut body, n as u64);
                    body.extend_from_slice(&target[at..at + n]);
                    at += n;
                    left -= n;
                }
                inserted_since += len;
            }
            Op::Copy { base, offset, len } => {
                let bi = renumber[base];
                if bi == last {
                    body.push(0x02);
                    varint(&mut body, zig(offset as i64 - (expected + inserted_since) as i64));
                    varint(&mut body, len as u64);
                } else {
                    body.push(0x01);
                    varint(&mut body, bi as u64);
                    varint(&mut body, offset as u64);
                    varint(&mut body, len as u64);
                }
                last = bi;
                expected = offset + len;
                inserted_since = 0;
            }
        }
    }
    let mut bytes = vec![VERSION];
    varint(&mut bytes, used_order.len() as u64);
    for &bi in &used_order {
        varint(&mut bytes, bases[bi].len() as u64);
    }
    varint(&mut bytes, target.len() as u64);
    let packed = if body.len() > 48 { zstd::bulk::compress(&body, 3).ok() } else { None };
    match packed {
        Some(z) if z.len() < body.len() => {
            bytes.push(1);
            bytes.extend_from_slice(&z);
        }
        _ => {
            bytes.push(0);
            bytes.extend_from_slice(&body);
        }
    }
    Delta { bytes, used_order, literals }
}

/// What a delta says about itself, without applying it.
pub struct DeltaHeader {
    pub base_lengths: Vec<u64>,
    pub target_length: u64,
}

pub fn read_header(delta: &[u8]) -> Result<(DeltaHeader, usize), DeltaError> {
    if delta.first() != Some(&VERSION) {
        return Err(DeltaError::NotADelta);
    }
    let mut at = 1;
    let count = read_varint(delta, &mut at)? as usize;
    if count > 1 << 16 {
        return Err(DeltaError::Truncated);
    }
    let mut base_lengths = Vec::with_capacity(count);
    for _ in 0..count {
        base_lengths.push(read_varint(delta, &mut at)?);
    }
    let target_length = read_varint(delta, &mut at)?;
    Ok((DeltaHeader { base_lengths, target_length }, at))
}

/// The target, from its delta and the bases it names, in the delta's own order.
pub fn apply_delta(bases: &[&[u8]], delta: &[u8]) -> Result<Vec<u8>, DeltaError> {
    let (header, mut at) = read_header(delta)?;
    let flag = *delta.get(at).ok_or(DeltaError::Truncated)?;
    at += 1;
    let decompressed;
    let ops: &[u8] = if flag == 1 {
        decompressed = zstd::stream::decode_all(&delta[at..]).map_err(DeltaError::Zstd)?;
        &decompressed
    } else {
        &delta[at..]
    };
    let target_len = header.target_length as usize;
    let mut out: Vec<u8> = Vec::with_capacity(target_len);
    let mut last: usize = usize::MAX;
    let (mut expected, mut inserted_since) = (0i64, 0i64);
    let mut p = 0usize;
    let copy = |out: &mut Vec<u8>, bi: usize, off: i64, n: usize| -> Result<(), DeltaError> {
        let base = *bases.get(bi).ok_or(DeltaError::WrongBase)?;
        let wanted = *header.base_lengths.get(bi).ok_or(DeltaError::WrongBase)?;
        if base.len() as u64 != wanted || off < 0 || off as usize + n > base.len() || out.len() + n > target_len {
            return Err(DeltaError::WrongBase);
        }
        out.extend_from_slice(&base[off as usize..off as usize + n]);
        Ok(())
    };
    while p < ops.len() {
        let op = ops[p];
        p += 1;
        match op {
            0x00 => {
                let n = read_varint(ops, &mut p)? as usize;
                if out.len() + n > target_len || p + n > ops.len() {
                    return Err(DeltaError::PastTheEnd);
                }
                out.extend_from_slice(&ops[p..p + n]);
                p += n;
                inserted_since += n as i64;
            }
            0x01 => {
                let bi = read_varint(ops, &mut p)? as usize;
                let off = read_varint(ops, &mut p)? as i64;
                let n = read_varint(ops, &mut p)? as usize;
                copy(&mut out, bi, off, n)?;
                last = bi;
                expected = off + n as i64;
                inserted_since = 0;
            }
            0x02 => {
                let off = expected + inserted_since + unzig(read_varint(ops, &mut p)?);
                let n = read_varint(ops, &mut p)? as usize;
                copy(&mut out, last, off, n)?;
                expected = off + n as i64;
                inserted_since = 0;
            }
            other => return Err(DeltaError::UnknownOp(other)),
        }
    }
    if out.len() != target_len {
        return Err(DeltaError::WrongLength);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n.max(1) as u64) as usize
        }
    }

    fn mutate(rng: &mut Rng, data: &[u8]) -> Vec<u8> {
        let mut out = data.to_vec();
        for _ in 0..1 + rng.below(6) {
            let at = rng.below(out.len().max(1));
            match rng.below(5) {
                0 => {
                    if !out.is_empty() {
                        let index = at.min(out.len() - 1);
                        out[index] ^= 1 + rng.below(255) as u8;
                    }
                }
                1 => {
                    let n = 1 + rng.below(300);
                    let bytes: Vec<u8> = (0..n).map(|_| rng.next() as u8).collect();
                    out.splice(at.min(out.len())..at.min(out.len()), bytes);
                }
                2 => {
                    let end = (at + 1 + rng.below(5000)).min(out.len());
                    if at < end {
                        out.drain(at..end);
                    }
                }
                3 => {
                    let end = (at + rng.below(65536)).min(out.len());
                    let block: Vec<u8> = out.drain(at.min(end)..end).collect();
                    let to = rng.below(out.len().max(1)).min(out.len());
                    out.splice(to..to, block);
                }
                _ => out.truncate(out.len().saturating_sub(rng.below(8000))),
            }
        }
        out
    }

    #[test]
    fn single_base_round_trips() {
        let mut rng = Rng(0x1234_5678);
        let mut data: Vec<u8> = (0..300_000).map(|i| ((i * 7) % 251) as u8 ^ (rng.next() as u8 & 3)).collect();
        for _ in 0..200 {
            let next = mutate(&mut rng, &data);
            let delta = make_delta(&[&data], &next);
            let bases: Vec<&[u8]> = delta.used_order.iter().map(|_| data.as_slice()).collect();
            assert_eq!(apply_delta(&bases, &delta.bytes).unwrap(), next);
            data = next;
        }
    }

    #[test]
    fn multi_base_round_trips() {
        let mut rng = Rng(42);
        for _ in 0..200 {
            let count = 1 + rng.below(5);
            let bases_owned: Vec<Vec<u8>> = (0..count)
                .map(|_| (0..rng.below(50_000)).map(|_| rng.next() as u8).collect())
                .collect();
            let mut target = Vec::new();
            for _ in 0..rng.below(12) {
                let b = &bases_owned[rng.below(count)];
                if b.is_empty() {
                    continue;
                }
                let at = rng.below(b.len());
                let end = (at + rng.below(8000)).min(b.len());
                target.extend_from_slice(&b[at..end]);
                for _ in 0..rng.below(40) {
                    target.push(rng.next() as u8);
                }
            }
            let bases: Vec<&[u8]> = bases_owned.iter().map(|b| b.as_slice()).collect();
            let delta = make_delta(&bases, &target);
            let used: Vec<&[u8]> = delta.used_order.iter().map(|&i| bases[i]).collect();
            assert_eq!(apply_delta(&used, &delta.bytes).unwrap(), target);
        }
    }

    #[test]
    fn one_byte_change_is_tiny() {
        let mut rng = Rng(7);
        let data: Vec<u8> = (0..1_000_000).map(|_| rng.next() as u8).collect();
        let mut next = data.clone();
        next[500_000] ^= 0xff;
        let delta = make_delta(&[&data], &next);
        assert!(delta.bytes.len() < 32, "{} bytes", delta.bytes.len());
        assert_eq!(apply_delta(&[&data], &delta.bytes).unwrap(), next);
    }

    #[test]
    fn refuses_wrong_base() {
        let a = vec![1u8; 1000];
        let b: Vec<u8> = a.iter().map(|x| x + 1).chain(a.iter().copied()).collect();
        let delta = make_delta(&[&a], &b);
        assert!(apply_delta(&[&a[..999]], &delta.bytes).is_err());
    }
}
