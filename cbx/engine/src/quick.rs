//! A quiet `cbx status`, answered without Node.
//!
//! The common case of the command people run most is "nothing has changed".
//! A cbx-local 2 history records, beside its index, the save the folder last
//! matched and whether it matched it exactly (the stamp `status` writes). When
//! the line still points at that save, nothing is merging, and every file the
//! walk finds has the size and time its index entry recorded, with none
//! missing and none new, the folder is that save, and that can be said after a
//! walk and four small reads.
//!
//! Anything else is not answered here: the caller runs the full status. That
//! covers a v1 history, a folder that is also a Git repository (its tracked
//! files change what the rules let in), one with no `.gitignore` (its rules
//! come from a starter template), a merge waiting, an index or stamp that does
//! not match, and any difference at all, however small. So this can only ever
//! give the answer the full status would give.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::frame::open_chunk_frame;
use crate::scan::{scan, ScanRequest};
use crate::snapshot::digest_file;

pub const FORMAT_V2: &str = "cbx-local 2";

pub enum Quick {
    /// The folder is exactly the line's newest save.
    Clean { project: String, line: String, head: String, message: String },
    /// What changed since the line's newest save, each list in the order the full status sorts it.
    Changed {
        project: String,
        line: String,
        head: String,
        message: String,
        added: Vec<String>,
        modified: Vec<String>,
        deleted: Vec<String>,
    },
    /// Not answered here, and why; the full status answers instead.
    Unknown(String),
}

/* More changed files than this is a big change, and the full status, which keeps what it reads, is the one to run. */
const MOST_TO_HASH: usize = 256;

/* JavaScript's sort: by UTF-16 code units, which is not always UTF-8 byte order. */
fn sort_like_javascript(list: &mut [String]) {
    list.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
}

/* A compact index (cbx/src/local/repository.ts), as much of it as status needs. */
#[derive(serde::Deserialize)]
struct Stamp {
    head: Option<String>,
    clean: bool,
    #[serde(default)]
    complete: bool,
}

#[derive(serde::Deserialize)]
struct CompactIndex {
    compact: u8,
    stamp: Option<Stamp>,
    files: Vec<IndexRow>,
}

/* [path, size, mtimeMs, sha256, objects, runs?] */
struct IndexRow {
    path: String,
    size: u64,
    mtime: f64,
    sha256: String,
    runs: Option<bool>,
}

impl<'de> serde::Deserialize<'de> for IndexRow {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Row;
        impl<'de> serde::de::Visitor<'de> for Row {
            type Value = IndexRow;
            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("an index entry")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<IndexRow, A::Error> {
                use serde::de::Error;
                let path: String = seq.next_element()?.ok_or_else(|| A::Error::custom("no path"))?;
                let size: u64 = seq.next_element()?.ok_or_else(|| A::Error::custom("no size"))?;
                let mtime: f64 = seq.next_element()?.ok_or_else(|| A::Error::custom("no time"))?;
                let sha256: String = seq.next_element()?.ok_or_else(|| A::Error::custom("no digest"))?;
                let _: Option<serde::de::IgnoredAny> = seq.next_element()?;
                let runs: Option<u8> = seq.next_element()?;
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(IndexRow { path, size, mtime, sha256, runs: runs.map(|flag| flag == 1) })
            }
        }
        deserializer.deserialize_seq(Row)
    }
}

fn unknown(reason: &str) -> Result<Quick, String> {
    Ok(Quick::Unknown(reason.to_string()))
}

/// The folder holding the history `from` is in, looking upward.
pub fn find_root(from: &Path) -> Option<std::path::PathBuf> {
    /* Absolute, so the project's name (the folder's own) is there to print. */
    let mut at = if from.is_absolute() { from.to_path_buf() } else { std::env::current_dir().ok()?.join(from) };
    at = at.components().collect();
    loop {
        if at.join(".cbx").join("format").is_file() {
            return Some(at);
        }
        if !at.pop() {
            return None;
        }
    }
}

fn is_digest(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn quick_status(root: &Path) -> Result<Quick, String> {
    let started = std::time::Instant::now();
    let timing = std::env::var_os("CBX_ENGINE_TIMING").is_some();
    let mark = |what: &str| {
        if timing {
            eprintln!("quick-status {what}: {:.1} ms", started.elapsed().as_secs_f64() * 1000.0);
        }
    };
    let store = root.join(".cbx");
    /* Read and decoded while the folder is walked: the two do not wait on each other. */
    let index_path = store.join("index.json");
    let loading = std::thread::spawn(move || -> Result<CompactIndex, String> {
        let bytes = fs::read(index_path).map_err(|error| error.to_string())?;
        serde_json::from_slice(&bytes).map_err(|error| error.to_string())
    });
    let format = fs::read_to_string(store.join("format")).map_err(|error| error.to_string())?;
    if format.trim() != FORMAT_V2 {
        return unknown("not a cbx-local 2 history");
    }
    if store.join("merge.json").exists() {
        return unknown("a merge is waiting");
    }
    if root.join(".git").exists() {
        return unknown("the folder is also a Git repository");
    }
    let Ok(shared) = fs::read_to_string(root.join(".gitignore")) else {
        return unknown("no .gitignore");
    };

    let state: Value = serde_json::from_str(&fs::read_to_string(store.join("state.json")).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    let Some(line) = state.get("line").and_then(Value::as_str) else {
        return unknown("no current line");
    };
    if line.is_empty() || line.contains("..") || line.starts_with('/') || line.contains('\\') {
        return unknown("an unusual line name");
    }
    let Ok(tip) = fs::read_to_string(store.join("lines").join(line)) else {
        return unknown("nothing saved yet");
    };
    let head = tip.trim().to_string();
    if !is_digest(&head) {
        return unknown("the line names no save");
    }

    let found = scan(&ScanRequest {
        root: root.to_path_buf(),
        shared,
        local: String::new(),
        tracked_files: None,
        tracked_folders: None,
        exact: false,
    })?;
    /*
      Whether a file runs, as the full status reads it: from its mode where
      there is one, and on Windows, which has no execute bit, whatever was
      saved, so it never differs there.
    */
    mark("folder walked");
    let index = match loading.join() {
        Ok(Ok(index)) => index,
        _ => return unknown("the index is not readable"),
    };
    if index.compact != 1 {
        return unknown("the index is not compact");
    }
    let Some(stamp) = index.stamp.as_ref().filter(|stamp| stamp.clean && stamp.head.as_deref() == Some(head.as_str()))
    else {
        return unknown("the index does not say the folder was this save");
    };
    /* Every file in the index: then each entry's digest is the save's, and a file not in it is new. */
    let complete = stamp.complete;
    struct Known<'a> {
        size: u64,
        mtime: f64,
        sha256: &'a str,
        runs: Option<bool>,
    }
    let mut known: HashMap<&str, Known> = HashMap::with_capacity(index.files.len());
    for row in &index.files {
        known.insert(row.path.as_str(), Known { size: row.size, mtime: row.mtime, sha256: &row.sha256, runs: row.runs });
    }

    mark("index read");
    let runs_now = |mode: u32, before: Option<bool>| -> Option<bool> {
        if cfg!(windows) {
            before
        } else {
            Some(mode & 0o100 != 0)
        }
    };
    let mut added = Vec::new();
    let mut modified = Vec::new();
    let mut seen = 0usize;
    let mut hashed = 0usize;
    for file in &found.files {
        let Some(entry) = known.get(file.path.as_str()) else {
            if !complete {
                return unknown("a file the index does not hold");
            }
            added.push(file.path.clone());
            continue;
        };
        seen += 1;
        let runs = runs_now(file.mode, entry.runs);
        if entry.runs.is_none() && !cfg!(windows) {
            return unknown("the index does not say which files run");
        }
        if runs != entry.runs {
            modified.push(file.path.clone());
            continue;
        }
        if entry.size == file.size && entry.mtime == file.mtime_ms {
            continue;
        }
        if !complete {
            return unknown("a file changed");
        }
        hashed += 1;
        if hashed > MOST_TO_HASH {
            return unknown("many files changed");
        }
        let (digest, _) = digest_file(&root.join(&file.path)).map_err(|error| error.to_string())?;
        if hex::encode(digest) != entry.sha256 {
            modified.push(file.path.clone());
        }
    }
    let mut deleted = Vec::new();
    if seen != known.len() {
        if !complete {
            return unknown("a file is missing");
        }
        let present: std::collections::HashSet<&str> = found.files.iter().map(|file| file.path.as_str()).collect();
        deleted = known.keys().filter(|path| !present.contains(*path)).map(|path| path.to_string()).collect();
    }

    mark("compared");
    /* The save's message, from its own object: saves are kept loose. */
    let frame = fs::read(store.join("objects").join(&head[..2]).join(&head[2..])).map_err(|error| error.to_string())?;
    let mut expected = [0u8; 32];
    hex::decode_to_slice(&head, &mut expected).map_err(|error| error.to_string())?;
    let raw = open_chunk_frame(&frame, &expected).map_err(|error| format!("{error:?}"))?;
    let save: Value = serde_json::from_slice(&raw).map_err(|error| error.to_string())?;
    if save.get("format").and_then(Value::as_str) != Some("cbx-save") {
        return unknown("the line's head is not a save");
    }
    let message = save.get("message").and_then(Value::as_str).unwrap_or("").to_string();
    let project = root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    if added.is_empty() && modified.is_empty() && deleted.is_empty() {
        return Ok(Quick::Clean { project, line: line.to_string(), head, message });
    }
    sort_like_javascript(&mut added);
    sort_like_javascript(&mut modified);
    sort_like_javascript(&mut deleted);
    Ok(Quick::Changed { project, line: line.to_string(), head, message, added, modified, deleted })
}
