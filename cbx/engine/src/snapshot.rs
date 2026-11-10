//! Reading files into the store, with the same objects `storeFile` in
//! `cbx/src/local/snapshot.ts` makes: under 8 MiB a file is one object; above,
//! it is cut with the profile CodeRook uses for a file that size.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use rayon::prelude::*;
use sha2::{Digest, Sha256};

use crate::chunking::{profile_for_file_size, Chunker, Profile};
use crate::store::{Name, ObjectStore};

const READ_SIZE: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Stored {
    pub sha256: Name,
    pub chunks: Vec<Name>,
    pub size: u64,
}

fn read_full(file: &mut File, buffer: &mut [u8]) -> io::Result<usize> {
    let mut done = 0;
    while done < buffer.len() {
        let read = file.read(&mut buffer[done..])?;
        if read == 0 {
            break;
        }
        done += read;
    }
    Ok(done)
}

/// Cut a file with `profile`, handing each chunk to `each` in order; returns the whole-file digest and size.
pub fn cut_file(full: &Path, profile: Profile, mut each: impl FnMut(&[u8]) -> io::Result<()>) -> io::Result<(Name, u64)> {
    let mut file = File::open(full)?;
    let mut whole = Sha256::new();
    let mut chunker = Chunker::new(profile);
    let mut pending: Vec<u8> = Vec::with_capacity(profile.max_size + READ_SIZE);
    let mut block = vec![0u8; READ_SIZE];
    let mut cuts = Vec::new();
    let mut size = 0u64;
    loop {
        let read = read_full(&mut file, &mut block)?;
        if read == 0 {
            break;
        }
        let piece = &block[..read];
        whole.update(piece);
        size += read as u64;
        cuts.clear();
        chunker.feed(piece, &mut cuts);
        let mut from = 0usize;
        for &cut in &cuts {
            if pending.is_empty() {
                each(&piece[from..cut])?;
            } else {
                pending.extend_from_slice(&piece[from..cut]);
                each(&pending)?;
                pending.clear();
            }
            from = cut;
        }
        pending.extend_from_slice(&piece[from..]);
    }
    if !pending.is_empty() {
        each(&pending)?;
    }
    Ok((whole.finalize().into(), size))
}

/// Cut a file the way `cut_file` does, with reading, the whole-file hash, cutting and `put` on
/// separate threads. `put(index, bytes)` runs on `lanes` threads of its own; names come back in
/// file order. Its own threads, not a shared pool: waiting on pool tasks from inside the pool
/// deadlocked once three big files were cut at once.
pub fn cut_file_pipelined(
    full: &Path,
    profile: Profile,
    lanes: usize,
    put: impl Fn(usize, &[u8]) -> io::Result<Name> + Sync,
) -> io::Result<(Name, u64, Vec<Name>)> {
    use std::sync::mpsc::sync_channel;
    use std::sync::{Arc, Mutex};

    let mut file = File::open(full)?;
    let lanes = lanes.max(1);
    let (hash_tx, hash_rx) = sync_channel::<Arc<Vec<u8>>>(4);
    let (cut_tx, cut_rx) = sync_channel::<Arc<Vec<u8>>>(4);
    /* A bounded queue: at most `lanes` chunks wait, however slow `put` is. */
    let (work_tx, work_rx) = sync_channel::<(usize, Vec<u8>)>(lanes);
    let work_rx = Mutex::new(work_rx);
    let names: Mutex<Vec<(usize, io::Result<Name>)>> = Mutex::new(Vec::new());

    std::thread::scope(|scope| -> io::Result<(Name, u64, Vec<Name>)> {
        let reader = scope.spawn(move || -> io::Result<u64> {
            let mut size = 0u64;
            loop {
                let mut block = vec![0u8; READ_SIZE];
                let read = read_full(&mut file, &mut block)?;
                if read == 0 {
                    break;
                }
                block.truncate(read);
                size += read as u64;
                let block = Arc::new(block);
                if hash_tx.send(block.clone()).is_err() || cut_tx.send(block).is_err() {
                    break;
                }
            }
            Ok(size)
        });
        let hasher = scope.spawn(move || {
            let mut whole = Sha256::new();
            for block in hash_rx {
                whole.update(&block[..]);
            }
            let digest: Name = whole.finalize().into();
            digest
        });
        let (names, work_rx, put) = (&names, &work_rx, &put);
        for _ in 0..lanes {
            scope.spawn(move || loop {
                let next = work_rx.lock().unwrap().recv();
                let Ok((index, chunk)) = next else { break };
                let result = put(index, &chunk);
                names.lock().unwrap().push((index, result));
            });
        }

        let mut chunker = Chunker::new(profile);
        let mut pending: Vec<u8> = Vec::with_capacity(profile.max_size);
        let mut cuts = Vec::new();
        let mut count = 0usize;
        let cutting = || -> Result<(), ()> {
            for block in cut_rx {
                cuts.clear();
                chunker.feed(&block, &mut cuts);
                let mut from = 0usize;
                for &cut in &cuts {
                    pending.extend_from_slice(&block[from..cut]);
                    let chunk = std::mem::replace(&mut pending, Vec::with_capacity(profile.max_size));
                    work_tx.send((count, chunk)).map_err(|_| ())?;
                    count += 1;
                    from = cut;
                }
                pending.extend_from_slice(&block[from..]);
            }
            if !pending.is_empty() {
                work_tx.send((count, std::mem::take(&mut pending))).map_err(|_| ())?;
                count += 1;
            }
            Ok(())
        };
        let _ = cutting();
        drop(work_tx);
        let size = reader.join().expect("reader thread")?;
        let digest = hasher.join().expect("hash thread");
        Ok((digest, size, Vec::new()))
    })
    .and_then(|(digest, size, _)| {
        let mut done = names.into_inner().unwrap();
        done.sort_by_key(|(index, _)| *index);
        let mut out = Vec::with_capacity(done.len());
        for (expected, (index, result)) in done.into_iter().enumerate() {
            if index != expected {
                return Err(io::Error::new(io::ErrorKind::Other, "a chunk went missing while cutting"));
            }
            out.push(result?);
        }
        Ok((digest, size, out))
    })
}

/// One file into the store.
pub fn store_file(store: &ObjectStore, full: &Path, size: u64) -> io::Result<Stored> {
    match profile_for_file_size(size) {
        None => {
            let started = std::time::Instant::now();
            let bytes = std::fs::read(full)?;
            crate::store::timing::add(&crate::store::timing::READ, started);
            let name = store.put(&bytes, false)?;
            Ok(Stored {
                sha256: name,
                chunks: if bytes.is_empty() { Vec::new() } else { vec![name] },
                size: bytes.len() as u64,
            })
        }
        Some(profile) => {
            let (sha256, size, chunks) = cut_file_pipelined(full, profile, 4, |_, chunk| store.put(chunk, false))?;
            Ok(Stored { sha256, chunks, size })
        }
    }
}

/// A file's SHA-256, streamed.
pub fn digest_file(full: &Path) -> io::Result<(Name, u64)> {
    let mut file = File::open(full)?;
    let length = file.metadata().map(|m| m.len()).unwrap_or(0);
    let mut hash = Sha256::new();
    if length <= READ_SIZE as u64 {
        let mut bytes = Vec::with_capacity(length as usize);
        file.read_to_end(&mut bytes)?;
        hash.update(&bytes);
        return Ok((hash.finalize().into(), bytes.len() as u64));
    }
    let mut block = vec![0u8; READ_SIZE];
    let mut size = 0u64;
    loop {
        let read = read_full(&mut file, &mut block)?;
        if read == 0 {
            break;
        }
        hash.update(&block[..read]);
        size += read as u64;
    }
    Ok((hash.finalize().into(), size))
}

/// Many files into the store at once; results in the order given. Small files and large ones run side by side.
pub fn store_files(
    store: &ObjectStore,
    root: &Path,
    files: &[(String, u64)],
    done: &(dyn Fn(&str) + Sync),
) -> Vec<io::Result<Stored>> {
    let large = |size: u64| profile_for_file_size(size).is_some();
    let mut results: Vec<Option<io::Result<Stored>>> = (0..files.len()).map(|_| None).collect();
    let (small_jobs, large_jobs): (Vec<usize>, Vec<usize>) = (0..files.len()).partition(|&i| !large(files[i].1));
    let run = |jobs: &[usize]| -> Vec<(usize, io::Result<Stored>)> {
        jobs.par_iter()
            .map(|&i| {
                let result = store_file(store, &root.join(&files[i].0), files[i].1);
                done(&files[i].0);
                (i, result)
            })
            .collect()
    };
    let (small, big) = rayon::join(
        || run(&small_jobs),
        || {
            /* A few at a time: each holds up to a chunk and a read block in memory. */
            let pool = rayon::ThreadPoolBuilder::new().num_threads(3).build().unwrap();
            pool.install(|| run(&large_jobs))
        },
    );
    for (i, result) in small.into_iter().chain(big) {
        results[i] = Some(result);
    }
    results.into_iter().map(|r| r.unwrap()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Several big files at once once deadlocked the cutter; this is that case, and a check of the names.
    #[test]
    fn many_big_files_at_once() {
        let dir = std::env::temp_dir().join(format!("cbx-engine-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("files")).unwrap();
        let mut state = 12345u64;
        let mut files = Vec::new();
        for n in 0..7 {
            let size = 9 * 1024 * 1024 + n * 77_777;
            let bytes: Vec<u8> = (0..size)
                .map(|_| {
                    state ^= state << 13;
                    state ^= state >> 7;
                    state ^= state << 17;
                    state as u8
                })
                .collect();
            let name = format!("big{n}.bin");
            std::fs::write(dir.join("files").join(&name), &bytes).unwrap();
            files.push((name, size as u64, bytes));
        }
        let store = ObjectStore::open(dir.join("objects")).unwrap();
        let wanted: Vec<(String, u64)> = files.iter().map(|(n, s, _)| (n.clone(), *s)).collect();
        let results = store_files(&store, &dir.join("files"), &wanted, &|_| {});
        store.flush().unwrap();
        for ((_, _, bytes), result) in files.iter().zip(results) {
            let stored = result.unwrap();
            assert_eq!(stored.sha256, crate::frame::sha256(bytes));
            let cuts = crate::chunking::cut_points(bytes, crate::chunking::MEDIUM);
            let mut from = 0;
            let mut expected = Vec::new();
            for cut in cuts.iter().copied().chain(std::iter::once(bytes.len())) {
                if cut > from {
                    expected.push(crate::frame::sha256(&bytes[from..cut]));
                }
                from = cut;
            }
            assert_eq!(stored.chunks, expected);
            let mut rebuilt = Vec::new();
            for chunk in &stored.chunks {
                rebuilt.extend(store.get(chunk).unwrap());
            }
            assert_eq!(&rebuilt, bytes);
        }
        store.release();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
