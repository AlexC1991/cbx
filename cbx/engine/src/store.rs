//! The "cbx-local 1" object store under `.cbx/objects`, read and written exactly as
//! `cbx/src/local/store.ts` does, so a history made by either is the other's.
//!
//! ```text
//!   objects/ab/cdef…          one object on its own ("loose"), a chunk frame
//!   objects/packs/<id>.pack   small objects, frame after frame, sorted by name
//!   objects/packs/<id>.idx    {"<name>":[offset,length],…} as JSON
//! ```
//!
//! `<id>` is the SHA-256 of the pack's bytes. A pack is renamed into place
//! before its index, so an index on disk always describes a finished pack.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};

use crate::frame::{chunk_frame_named, open_chunk_frame, sha256};

pub const PACKED_OBJECT_LIMIT: usize = 256 * 1024;
const PACK_BYTES: usize = 32 * 1024 * 1024;

pub type Name = [u8; 32];

/// Time spent in each stage, summed across threads, when CBX_ENGINE_TIMING is set.
pub mod timing {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;
    pub static READ: AtomicU64 = AtomicU64::new(0);
    pub static HAS: AtomicU64 = AtomicU64::new(0);
    pub static FRAME: AtomicU64 = AtomicU64::new(0);
    pub static WRITE: AtomicU64 = AtomicU64::new(0);
    pub fn add(counter: &AtomicU64, since: Instant) {
        counter.fetch_add(since.elapsed().as_micros() as u64, Ordering::Relaxed);
    }
    pub fn report() -> String {
        let ms = |c: &AtomicU64| c.load(Ordering::Relaxed) / 1000;
        format!("read {} ms, has {} ms, frame {} ms, write {} ms (summed over threads)", ms(&READ), ms(&HAS), ms(&FRAME), ms(&WRITE))
    }
}

#[derive(Clone)]
struct Located {
    pack: usize,
    offset: u64,
    length: u64,
}

struct Pending {
    frames: BTreeMap<Name, Vec<u8>>,
    bytes: usize,
}

pub struct ObjectStore {
    directory: PathBuf,
    packs: RwLock<(Vec<PathBuf>, HashMap<Name, Located>)>,
    pending: Mutex<Pending>,
    /* One pack written at a time, as the TypeScript store does. */
    flushing: Mutex<()>,
    /* Packs held open: opening one per object made restores crawl on Windows. */
    handles: Mutex<HashMap<usize, Arc<File>>>,
}

#[cfg(windows)]
fn read_at(file: &File, buffer: &mut [u8], mut offset: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut done = 0;
    while done < buffer.len() {
        let read = file.seek_read(&mut buffer[done..], offset)?;
        if read == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "object runs past the end of its pack"));
        }
        done += read;
        offset += read as u64;
    }
    Ok(())
}

#[cfg(unix)]
fn read_at(file: &File, buffer: &mut [u8], offset: u64) -> io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.read_exact_at(buffer, offset)
}

fn unique_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{:x}{:x}{:x}", std::process::id(), nanos, COUNTER.fetch_add(1, Ordering::Relaxed))
}

pub fn parse_name(text: &str) -> Option<Name> {
    if text.len() != 64 || !text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let mut name = [0u8; 32];
    hex::decode_to_slice(text, &mut name).ok()?;
    Some(name)
}

impl ObjectStore {
    pub fn open(directory: impl Into<PathBuf>) -> io::Result<Self> {
        let directory = directory.into();
        let store = ObjectStore {
            directory,
            packs: RwLock::new((Vec::new(), HashMap::new())),
            pending: Mutex::new(Pending { frames: BTreeMap::new(), bytes: 0 }),
            flushing: Mutex::new(()),
            handles: Mutex::new(HashMap::new()),
        };
        store.read_packs()?;
        Ok(store)
    }

    fn pack_directory(&self) -> PathBuf {
        self.directory.join("packs")
    }

    pub fn loose_path(&self, name: &Name) -> PathBuf {
        let text = hex::encode(name);
        self.directory.join(&text[..2]).join(&text[2..])
    }

    fn read_packs(&self) -> io::Result<()> {
        let mut found = (Vec::new(), HashMap::new());
        let mut names: Vec<String> = match fs::read_dir(self.pack_directory()) {
            Ok(entries) => entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|name| name.ends_with(".idx"))
                .collect(),
            Err(_) => Vec::new(),
        };
        names.sort();
        for name in names {
            let text = fs::read_to_string(self.pack_directory().join(&name))?;
            let index: HashMap<String, (u64, u64)> = serde_json::from_str(&text)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, format!("{name}: {error}")))?;
            let pack = found.0.len();
            found.0.push(self.pack_directory().join(name.trim_end_matches(".idx").to_string() + ".pack"));
            for (digest, (offset, length)) in index {
                if let Some(object) = parse_name(&digest) {
                    found.1.insert(object, Located { pack, offset, length });
                }
            }
        }
        *self.packs.write().unwrap() = found;
        Ok(())
    }

    pub fn has(&self, name: &Name) -> bool {
        if self.pending.lock().unwrap().frames.contains_key(name) {
            return true;
        }
        if self.packs.read().unwrap().1.contains_key(name) {
            return true;
        }
        self.loose_path(name).is_file()
    }

    /// Keep `raw`, returning its name. Small objects wait for a pack; call `flush` before reading them back from disk.
    pub fn put(&self, raw: &[u8], loose: bool) -> io::Result<Name> {
        let started = std::time::Instant::now();
        let name = sha256(raw);
        let present = self.has(&name);
        timing::add(&timing::HAS, started);
        if present {
            return Ok(name);
        }
        let started = std::time::Instant::now();
        let framed = chunk_frame_named(raw, name, crate::frame::ZSTD_LEVEL);
        timing::add(&timing::FRAME, started);
        if !loose && raw.len() <= PACKED_OBJECT_LIMIT {
            let full = {
                let mut pending = self.pending.lock().unwrap();
                if !pending.frames.contains_key(&name) {
                    pending.bytes += framed.frame.len();
                    pending.frames.insert(name, framed.frame);
                }
                pending.bytes >= PACK_BYTES
            };
            if full {
                self.flush()?;
            }
            return Ok(name);
        }
        let started = std::time::Instant::now();
        self.write_loose(&name, &framed.frame)?;
        timing::add(&timing::WRITE, started);
        Ok(name)
    }

    fn write_loose(&self, name: &Name, frame: &[u8]) -> io::Result<()> {
        let target = self.loose_path(name);
        fs::create_dir_all(target.parent().unwrap())?;
        let partial = PathBuf::from(format!("{}.{}.partial", target.display(), unique_suffix()));
        fs::write(&partial, frame)?;
        if let Err(error) = fs::rename(&partial, &target) {
            let _ = fs::remove_file(&partial);
            /* Another writer got there first with the same bytes. */
            if !target.is_file() {
                return Err(error);
            }
        }
        Ok(())
    }

    /// Write whatever small objects are waiting as one pack.
    pub fn flush(&self) -> io::Result<()> {
        let _one_at_a_time = self.flushing.lock().unwrap();
        let taken = {
            let mut pending = self.pending.lock().unwrap();
            if pending.frames.is_empty() {
                return Ok(());
            }
            pending.bytes = 0;
            std::mem::take(&mut pending.frames)
        };
        let started = std::time::Instant::now();
        let result = self.write_pack(&taken);
        timing::add(&timing::WRITE, started);
        if result.is_err() {
            /* Keep them readable and waiting rather than lose them. */
            let mut pending = self.pending.lock().unwrap();
            for (name, frame) in taken {
                pending.bytes += frame.len();
                pending.frames.insert(name, frame);
            }
        }
        result
    }

    fn write_pack(&self, objects: &BTreeMap<Name, Vec<u8>>) -> io::Result<()> {
        fs::create_dir_all(self.pack_directory())?;
        let total: usize = objects.values().map(|frame| frame.len()).sum();
        let mut body = Vec::with_capacity(total);
        let mut index = String::with_capacity(objects.len() * 90 + 2);
        let mut entries = Vec::with_capacity(objects.len());
        index.push('{');
        /* BTreeMap order is the digests' order, the order the TypeScript store sorts into. */
        for (count, (name, frame)) in objects.iter().enumerate() {
            let offset = body.len() as u64;
            if count > 0 {
                index.push(',');
            }
            index.push_str(&format!("\"{}\":[{},{}]", hex::encode(name), offset, frame.len()));
            body.extend_from_slice(frame);
            entries.push((*name, offset, frame.len() as u64));
        }
        index.push('}');
        let id = hex::encode(sha256(&body));
        let pack = self.pack_directory().join(format!("{id}.pack"));
        let idx = self.pack_directory().join(format!("{id}.idx"));
        let pack_partial = PathBuf::from(format!("{}.partial", pack.display()));
        let idx_partial = PathBuf::from(format!("{}.partial", idx.display()));
        fs::write(&pack_partial, &body)?;
        fs::rename(&pack_partial, &pack)?;
        fs::write(&idx_partial, index.as_bytes())?;
        fs::rename(&idx_partial, &idx)?;
        let mut packs = self.packs.write().unwrap();
        let number = packs.0.len();
        packs.0.push(pack);
        for (name, offset, length) in entries {
            packs.1.insert(name, Located { pack: number, offset, length });
        }
        Ok(())
    }

    /// An object's bytes, checked against its name.
    pub fn get(&self, name: &Name) -> io::Result<Vec<u8>> {
        let invalid = |error: crate::frame::FrameError| {
            io::Error::new(io::ErrorKind::InvalidData, format!("object {}: {error}", &hex::encode(name)[..12]))
        };
        if let Some(frame) = self.pending.lock().unwrap().frames.get(name) {
            return open_chunk_frame(frame, name).map_err(invalid);
        }
        let located = {
            let packs = self.packs.read().unwrap();
            packs.1.get(name).map(|at| (packs.0[at.pack].clone(), at.clone()))
        };
        if let Some((pack, at)) = located {
            let file = {
                let mut handles = self.handles.lock().unwrap();
                match handles.get(&at.pack) {
                    Some(file) => file.clone(),
                    None => {
                        let file = Arc::new(File::open(&pack)?);
                        handles.insert(at.pack, file.clone());
                        file
                    }
                }
            };
            let mut frame = vec![0u8; at.length as usize];
            read_at(&file, &mut frame, at.offset)?;
            return open_chunk_frame(&frame, name).map_err(invalid);
        }
        let frame = fs::read(self.loose_path(name)).map_err(|_| {
            io::Error::new(io::ErrorKind::NotFound, format!("the history is missing object {}", &hex::encode(name)[..12]))
        })?;
        open_chunk_frame(&frame, name).map_err(invalid)
    }

    /// Close the packs held open, so the folder can be moved or deleted.
    pub fn release(&self) {
        self.handles.lock().unwrap().clear();
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }
}
