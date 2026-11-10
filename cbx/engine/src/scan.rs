//! Which files the rules let into a save, found the way `cbx/src/core/worktree.ts` finds them.
//!
//! Two passes, as there: `collectLayers` first walks every folder the rules so far do not
//! exclude, one at a time in the order the disk lists them, gathering each nested `.gitignore`;
//! then the listing walks breadth first with every layer known, deciding each folder and file.
//! The order matters in the first pass (a folder listed before its parent's `.gitignore` is
//! judged without it), so that pass is kept sequential and in disk order, exactly as the
//! TypeScript does it. The second pass reads a whole level of folders at once, then puts the
//! answers back in the order the TypeScript queue would have produced them.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rayon::prelude::*;

use crate::rules::{decide, excludes, is_uncounted, parse_rules, Layer, Matchers, Negations};

pub struct ScanRequest {
    pub root: PathBuf,
    /// The `.gitignore` at the root (or the starter rules), as `readRules` returned it.
    pub shared: String,
    /// `.git/info/exclude`, personal rules that apply at the root.
    pub local: String,
    /// What git already tracks, when the folder is a repository: kept whatever a rule says.
    pub tracked_files: Option<HashSet<String>>,
    pub tracked_folders: Option<HashSet<String>>,
    /// Stat every file. Otherwise, on Windows, the size and time the folder listing already
    /// carries are used, which costs nothing per file. A file still open for writing can show
    /// its previous size and time there until it is closed, so whatever saves asks for exact.
    pub exact: bool,
}

#[derive(Debug, Clone)]
pub struct Found {
    pub path: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub mode: u32,
}

pub struct ScanResult {
    /// In the order the TypeScript walk meets them: breadth first, each folder in disk order.
    pub files: Vec<Found>,
    pub layers: usize,
    pub folders: usize,
}

pub struct Entry {
    name: String,
    is_dir: bool,
    is_file: bool,
    is_link: bool,
    /// Size, mtimeMs and mode from the listing itself, where the system gives them for free.
    listed: Option<(u64, f64, u32)>,
}

/// A folder's entries in the order the disk gives them. Names that are not UTF-8 are left out:
/// Node would turn them into names that cannot be opened, and the TypeScript walk skips those too.
#[cfg(not(windows))]
fn listing(directory: &Path) -> io::Result<Vec<Entry>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(directory)? {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        let Ok(kind) = entry.file_type() else { continue };
        out.push(Entry { name, is_dir: kind.is_dir(), is_file: kind.is_file(), is_link: kind.is_symlink(), listed: None });
    }
    Ok(out)
}

/// A folder's entries on Windows, typed the way Node's `readdir` types them.
///
/// libuv calls anything carrying a reparse point a link: symbolic links and junctions, and also
/// cloud placeholders (OneDrive), deduplicated files and the like. The TypeScript walk therefore
/// skips all of those, and so must this. Rust's own listing calls the last kinds files, so the
/// listing is read here directly, with the large-fetch, basic-information form Git's file
/// system cache uses; each file's size and times come with it.
#[cfg(windows)]
fn listing(directory: &Path) -> io::Result<Vec<Entry>> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW, FindNextFileW, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_REPARSE_POINT, FIND_FIRST_EX_LARGE_FETCH, WIN32_FIND_DATAW,
    };
    let mut pattern: Vec<u16> = directory
        .as_os_str()
        .encode_wide()
        .map(|unit| if unit == b'/' as u16 { b'\\' as u16 } else { unit })
        .collect();
    if pattern.len() > 240 {
        /* Long paths need the \\?\ form; the standard listing handles them. */
        return listing_standard(directory);
    }
    if pattern.last() != Some(&(b'\\' as u16)) {
        pattern.push(b'\\' as u16);
    }
    pattern.extend([b'*' as u16, 0]);
    let mut data: WIN32_FIND_DATAW = Default::default();
    // SAFETY: the pattern is NUL-terminated and `data` is a WIN32_FIND_DATAW, as the call requires.
    let handle = unsafe {
        FindFirstFileExW(
            pattern.as_ptr(),
            FindExInfoBasic,
            (&mut data as *mut WIN32_FIND_DATAW).cast(),
            FindExSearchNameMatch,
            std::ptr::null(),
            FIND_FIRST_EX_LARGE_FETCH,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut out = Vec::new();
    loop {
        let length = data.cFileName.iter().position(|&unit| unit == 0).unwrap_or(data.cFileName.len());
        let wide = &data.cFileName[..length];
        let dot = b'.' as u16;
        if wide != [dot] && wide != [dot, dot] {
            if let Ok(name) = String::from_utf16(wide) {
                let attributes = data.dwFileAttributes;
                let is_link = attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
                let is_dir = !is_link && attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
                let is_file = !is_link && !is_dir;
                let listed = is_file.then(|| {
                    let size = ((data.nFileSizeHigh as u64) << 32) | data.nFileSizeLow as u64;
                    let ticks = ((data.ftLastWriteTime.dwHighDateTime as u64) << 32) | data.ftLastWriteTime.dwLowDateTime as u64;
                    let mode = 0o100000 | if attributes & FILE_ATTRIBUTE_READONLY != 0 { 0o444 } else { 0o666 };
                    (size, filetime_ms(ticks), mode)
                });
                out.push(Entry { name, is_dir, is_file, is_link, listed });
            }
        }
        // SAFETY: `handle` came from FindFirstFileExW and is still open.
        if unsafe { FindNextFileW(handle, &mut data) } == 0 {
            break;
        }
    }
    // SAFETY: closed once, here.
    unsafe { FindClose(handle) };
    Ok(out)
}

/// The standard listing, typed as libuv types it: any reparse point is a link.
#[cfg(windows)]
fn listing_standard(directory: &Path) -> io::Result<Vec<Entry>> {
    use std::os::windows::fs::MetadataExt;
    const REPARSE_POINT: u32 = 0x400;
    let mut out = Vec::new();
    for entry in fs::read_dir(directory)? {
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        let is_link = meta.file_attributes() & REPARSE_POINT != 0;
        let is_dir = !is_link && meta.is_dir();
        let is_file = !is_link && !is_dir;
        let listed = is_file.then(|| (meta.len(), mtime_ms(&meta), mode_of(&meta)));
        out.push(Entry { name, is_dir, is_file, is_link, listed });
    }
    Ok(out)
}

/// A FILETIME (100 ns ticks since 1601) as Node's mtimeMs.
#[cfg(windows)]
fn filetime_ms(ticks: u64) -> f64 {
    const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;
    if ticks >= UNIX_EPOCH_TICKS {
        let since = ticks - UNIX_EPOCH_TICKS;
        (since / 10_000_000) as f64 * 1e3 + ((since % 10_000_000) * 100) as f64 / 1e6
    } else {
        let before = UNIX_EPOCH_TICKS - ticks;
        let mut seconds = -((before / 10_000_000) as f64);
        let mut nanos = ((before % 10_000_000) * 100) as f64;
        if nanos > 0.0 {
            seconds -= 1.0;
            nanos = 1e9 - nanos;
        }
        seconds * 1e3 + nanos / 1e6
    }
}

/// `collectLayers`: the root's rules, then every nested `.gitignore` in a folder not already excluded.
///
/// The TypeScript walks one folder at a time, in disk order, and judges each folder with the
/// layers gathered so far. Of those, only the folder's own ancestors can speak about it, and an
/// ancestor's `.gitignore` has been gathered by then exactly when the disk lists it before the
/// child that leads down to this folder. That is a property of each path, so folders are
/// walked here a level at a time, in parallel, each carrying the layers its path would have
/// seen; the answers are the TypeScript's. Each folder's listing is kept for the second pass.
pub fn collect_layers(
    matchers: &Matchers,
    root: &Path,
    shared: &str,
    local: &str,
) -> (Vec<Arc<Layer>>, HashMap<String, Vec<Entry>>) {
    let mut layers: Vec<Arc<Layer>> = Vec::new();
    if !local.trim().is_empty() {
        layers.push(Arc::new(Layer::new(String::new(), parse_rules(local))));
    }
    layers.push(Arc::new(Layer::new(String::new(), parse_rules(shared))));
    struct Folder {
        full: PathBuf,
        base: String,
        seen: Vec<Arc<Layer>>,
    }
    let mut listings = HashMap::new();
    let mut level = vec![Folder { full: root.to_path_buf(), base: String::new(), seen: layers.clone() }];
    while !level.is_empty() {
        let answers: Vec<(String, Option<Vec<Entry>>, Option<Arc<Layer>>, Vec<Folder>)> = level
            .into_par_iter()
            .map(|folder| {
                let Ok(entries) = listing(&folder.full) else { return (folder.base, None, None, Vec::new()) };
                let mut own: Option<Arc<Layer>> = None;
                let mut deeper = Vec::new();
                for entry in &entries {
                    if is_uncounted(&entry.name) || entry.is_link {
                        continue;
                    }
                    let relative = if folder.base.is_empty() { entry.name.clone() } else { format!("{}/{}", folder.base, entry.name) };
                    if entry.is_dir {
                        let mut seen = folder.seen.clone();
                        if let Some(layer) = &own {
                            seen.push(layer.clone());
                        }
                        if excludes(matchers, &relative, true, &seen, None) {
                            continue;
                        }
                        deeper.push(Folder { full: folder.full.join(&entry.name), base: relative, seen });
                    } else if entry.name == ".gitignore" && !folder.base.is_empty() {
                        if let Ok(bytes) = fs::read(folder.full.join(&entry.name)) {
                            let contents = String::from_utf8_lossy(&bytes);
                            if !contents.is_empty() {
                                own = Some(Arc::new(Layer::new(folder.base.clone(), parse_rules(&contents))));
                            }
                        }
                    }
                }
                (folder.base, Some(entries), own, deeper)
            })
            .collect();
        let mut next = Vec::new();
        for (base, entries, own, deeper) in answers {
            if let Some(entries) = entries {
                listings.insert(base, entries);
            }
            if let Some(layer) = own {
                layers.push(layer);
            }
            next.extend(deeper);
        }
        level = next;
    }
    (layers, listings)
}

/// A modification time as Node's `Stats.mtimeMs`.
pub fn mtime_ms(meta: &fs::Metadata) -> f64 {
    let Ok(modified) = meta.modified() else { return 0.0 };
    match modified.duration_since(std::time::UNIX_EPOCH) {
        Ok(after) => after.as_secs() as f64 * 1e3 + after.subsec_nanos() as f64 / 1e6,
        Err(before) => {
            let back = before.duration();
            let mut seconds = -(back.as_secs() as f64);
            let mut nanos = back.subsec_nanos() as f64;
            if nanos > 0.0 {
                seconds -= 1.0;
                nanos = 1e9 - nanos;
            }
            seconds * 1e3 + nanos / 1e6
        }
    }
}

/// `Stats.mode` as Node reports it.
#[cfg(unix)]
fn mode_of(meta: &fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    meta.mode()
}

#[cfg(windows)]
fn mode_of(meta: &fs::Metadata) -> u32 {
    /* libuv: a regular file, readable by all, writable unless read-only. */
    let base = 0o100000;
    if meta.permissions().readonly() { base | 0o444 } else { base | 0o666 }
}

/// Every file the rules let in, with what `stat` says about it.
pub fn scan(request: &ScanRequest) -> Result<ScanResult, String> {
    let matchers = Matchers::default();
    let started = std::time::Instant::now();
    let (layers, listings) = collect_layers(&matchers, &request.root, &request.shared, &request.local);
    let first_pass = started.elapsed();
    let tracked_file = |path: &str| request.tracked_files.as_ref().is_some_and(|set| set.contains(path));
    let tracked_folder = |path: &str| request.tracked_folders.as_ref().is_some_and(|set| set.contains(path));

    let listings_len = listings.len();
    let mut files = Vec::new();
    let mut folders = 0usize;
    let negations = Negations::new(&layers);
    /*
      Each folder carries whether it, or a folder above it, is excluded: `decidingRule` asks the
      ancestors outermost first and the first that excludes settles it, so everything below an
      excluded folder has that answer without asking again.
    */
    let is_excluding = |path: &str, is_directory: bool| decide(&matchers, path, is_directory, &layers).is_some_and(|rule| !rule.negated);
    /* (full path, relative path, settled) of each folder on this level, in queue order. */
    let mut level: Vec<(PathBuf, String, bool)> = vec![(request.root.clone(), String::new(), false)];
    while !level.is_empty() {
        folders += level.len();
        let answers: Vec<(Vec<Found>, Vec<(PathBuf, String, bool)>)> = level
            .par_iter()
            .map(|(full, base, settled)| {
                /* The first pass's listing when it read this folder; read now when it did not. */
                let read_now;
                let entries = match listings.get(base) {
                    Some(entries) => entries,
                    None => match listing(full) {
                        Ok(entries) => {
                            read_now = entries;
                            &read_now
                        }
                        Err(_) => return (Vec::new(), Vec::new()),
                    },
                };
                let mut wanted = Vec::new();
                let mut deeper = Vec::new();
                for entry in entries.iter() {
                    if entry.is_link || is_uncounted(&entry.name) {
                        continue;
                    }
                    let relative = if base.is_empty() { entry.name.clone() } else { format!("{base}/{}", entry.name) };
                    if entry.is_dir {
                        let excluded = *settled || is_excluding(&relative, true);
                        if excluded && !negations.reach_into(&matchers, &relative) && !tracked_folder(&relative) {
                            continue;
                        }
                        deeper.push((full.join(&entry.name), relative, excluded));
                        continue;
                    }
                    if !entry.is_file {
                        continue;
                    }
                    if (*settled || is_excluding(&relative, false)) && !tracked_file(&relative) {
                        continue;
                    }
                    wanted.push((full.join(&entry.name), relative, entry.listed));
                }
                let found: Vec<Found> = wanted
                    .par_iter()
                    .filter_map(|(full, relative, listed)| {
                        if let (false, Some((size, mtime_ms, mode))) = (request.exact, listed) {
                            return Some(Found { path: relative.clone(), size: *size, mtime_ms: *mtime_ms, mode: *mode });
                        }
                        /* Gone or unreadable since the walk began: left out, as the TypeScript does. */
                        let meta = fs::metadata(full).ok()?;
                        Some(Found { path: relative.clone(), size: meta.len(), mtime_ms: mtime_ms(&meta), mode: mode_of(&meta) })
                    })
                    .collect();
                (found, deeper)
            })
            .collect();
        let mut next = Vec::new();
        for (found, deeper) in answers {
            files.extend(found);
            next.extend(deeper);
        }
        level = next;
    }
    if std::env::var_os("CBX_ENGINE_TIMING").is_some() {
        eprintln!("scan: first pass {} ms ({} folders listed), whole walk {} ms", first_pass.as_millis(), listings_len, started.elapsed().as_millis());
    }
    if matchers.saw_invalid() {
        return Err("an ignore rule is not a pattern the rules can read".to_string());
    }
    Ok(ScanResult { files, layers: layers.len(), folders })
}
