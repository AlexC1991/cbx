//! `cbx-engine`: the byte engine's command line, spoken to by the cbx command
//! and by the cross-tests. Every command answers with one JSON value on stdout;
//! failures go to stderr with a non-zero exit.
//!
//!   cbx-engine cuts <file> [auto|<profile id>]        chunk ends (chunkBoundaries) and names
//!   cbx-engine digest <file>...                       SHA-256 and size of each
//!   cbx-engine store <objects dir> <root> [--progress]   stdin [{"path","size"}] -> {files:[{"path","sha256","chunks"}]}
//!   cbx-engine measure <root> [--progress]            stdin [{"path","count"}] -> {files:[{"path","size","sha256","lines","binary"}]}
//!   cbx-engine get <objects dir> <name> <out file>    an object's bytes, checked
//!   cbx-engine scan                                   stdin {root,shared,local,trackedFiles?,trackedFolders?} -> {files:[{path,size,mtimeMs,mode}]}
//!   cbx-engine check <objects dir>                    stdin [names] -> every one read back and checked
//!   cbx-engine put <objects dir> <file> [loose]       one object in, its name out
//!   cbx-engine delta-make <out> <target> <base>...    a v4 delta
//!   cbx-engine delta-apply <out> <delta> <base>...    the target again
//!   cbx-engine quick-status [root]                   a quiet status, or why it cannot say: {answer:"clean",…}|{answer:"unknown",reason}
//!   cbx-engine version
//!
//! Run under the name `cbx` (a copy or link of this program, as a standalone
//! CBX installs it), it is the cbx command itself: a quiet `cbx status` is
//! answered here, with no Node to start, and everything else is handed to the
//! JavaScript command line (CBX_CLI, or cli/dist/cli/src/bin.js beside it).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use cbx_engine::chunking::{self, profile_for_file_size};
use cbx_engine::delta::{apply_delta, make_delta};
use cbx_engine::frame::sha256;
use cbx_engine::snapshot::{cut_file_pipelined, digest_file, store_files};
use cbx_engine::store::{parse_name, ObjectStore};
use serde_json::{json, Value};

type Fallible<T> = Result<T, Box<dyn std::error::Error>>;

fn need<'a>(args: &'a [String], index: usize, what: &str) -> Fallible<&'a str> {
    args.get(index).map(|s| s.as_str()).ok_or_else(|| format!("missing {what}").into())
}

fn cuts(args: &[String]) -> Fallible<Value> {
    let file = PathBuf::from(need(args, 0, "file")?);
    let size = std::fs::metadata(&file)?.len();
    let choice = args.get(1).map(|s| s.as_str()).unwrap_or("auto");
    let profile = if choice == "auto" {
        profile_for_file_size(size)
    } else {
        Some(chunking::profile_named(choice).ok_or_else(|| format!("no profile called {choice}"))?)
    };
    let Some(profile) = profile else {
        let (digest, size) = digest_file(&file)?;
        return Ok(json!({ "size": size, "sha256": hex::encode(digest), "profile": null, "bounds": [], "chunks": [] }));
    };
    let started = Instant::now();
    let lengths = std::sync::Mutex::new(Vec::<(usize, u64)>::new());
    let (digest, size, pieces) = cut_file_pipelined(&file, profile, 8, |index, chunk| {
        lengths.lock().unwrap().push((index, chunk.len() as u64));
        Ok(sha256(chunk))
    })?;
    let names: Vec<String> = pieces.iter().map(hex::encode).collect();
    let mut lengths = lengths.into_inner().unwrap();
    lengths.sort();
    let mut at = 0u64;
    let offsets: Vec<u64> = lengths.iter().map(|&(_, n)| { at += n; at }).collect();
    Ok(json!({
        "size": size,
        "sha256": hex::encode(digest),
        "profile": profile.id,
        "bounds": offsets,
        "chunks": names,
        "ms": started.elapsed().as_millis() as u64,
    }))
}

fn digest(args: &[String]) -> Fallible<Value> {
    let mut out = Vec::new();
    for file in args {
        let (digest, size) = digest_file(Path::new(file))?;
        out.push(json!({ "path": file, "size": size, "sha256": hex::encode(digest) }));
    }
    Ok(Value::Array(out))
}

#[derive(serde::Deserialize)]
struct Wanted {
    path: String,
    size: u64,
}

fn store(args: &[String]) -> Fallible<Value> {
    let objects = ObjectStore::open(need(args, 0, "objects folder")?)?;
    let root = PathBuf::from(need(args, 1, "root")?);
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let wanted: Vec<Wanted> = serde_json::from_str(&input)?;
    let files: Vec<(String, u64)> = wanted.into_iter().map(|w| (w.path, w.size)).collect();
    let started = Instant::now();
    let progress = Progress::from_args(args);
    progress.total(files.len());
    let results = store_files(&objects, &root, &files, &|path| progress.one(path));
    /* Nothing may name an object that is not on disk yet. */
    objects.flush()?;
    if std::env::var_os("CBX_ENGINE_TIMING").is_some() {
        eprintln!("{} ms wall; {}", started.elapsed().as_millis(), cbx_engine::store::timing::report());
    }
    let mut out = Vec::with_capacity(files.len());
    for ((path, _), result) in files.iter().zip(results) {
        match result {
            Ok(stored) => out.push(json!({
                "path": path,
                "size": stored.size,
                "sha256": hex::encode(stored.sha256),
                "chunks": stored.chunks.iter().map(hex::encode).collect::<Vec<_>>(),
            })),
            Err(error) => out.push(json!({ "path": path, "error": error.to_string() })),
        }
    }
    Ok(json!({ "files": out, "ms": started.elapsed().as_millis() as u64 }))
}

fn get(args: &[String]) -> Fallible<Value> {
    let objects = ObjectStore::open(need(args, 0, "objects folder")?)?;
    let name = parse_name(need(args, 1, "object name")?).ok_or("not an object name")?;
    let bytes = objects.get(&name)?;
    std::fs::write(need(args, 2, "output file")?, &bytes)?;
    Ok(json!({ "size": bytes.len() }))
}

/// Read back every object named on stdin (a JSON list), each checked against its name.
fn check(args: &[String]) -> Fallible<Value> {
    use rayon::prelude::*;
    let objects = ObjectStore::open(need(args, 0, "objects folder")?)?;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let names: Vec<String> = serde_json::from_str(&input)?;
    let started = Instant::now();
    let bad: Vec<Value> = names
        .par_iter()
        .filter_map(|text| {
            let problem = match parse_name(text) {
                None => Some("not an object name".to_string()),
                Some(name) => objects.get(&name).err().map(|e| e.to_string()),
            };
            problem.map(|p| json!({ "name": text, "problem": p }))
        })
        .collect();
    Ok(json!({ "checked": names.len(), "bad": bad, "ms": started.elapsed().as_millis() as u64 }))
}

#[derive(serde::Deserialize)]
struct ToMeasure {
    path: String,
    /// Count lines and look for NUL bytes too, which needs the whole file in memory.
    #[serde(default)]
    count: bool,
}

/// What `measure` in worktree.ts works out for a file: lines, binary, digest. In parallel.
///
/// lines: binary ? 0 : number of LF bytes + 1 (what splitting the UTF-8 text on CR LF or LF gives,
/// since LF never occurs inside a UTF-8 sequence); binary: a NUL in the first 8192 bytes.
fn measure(args: &[String]) -> Fallible<Value> {
    use rayon::prelude::*;
    let root = PathBuf::from(need(args, 0, "root")?);
    let progress = Progress::from_args(args);
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let wanted: Vec<ToMeasure> = serde_json::from_str(&input)?;
    let started = Instant::now();
    progress.total(wanted.len());
    let out: Vec<Value> = wanted
        .par_iter()
        .map(|one| {
            let full = root.join(&one.path);
            let answer = (|| -> std::io::Result<Value> {
                /* Looked at before and after reading: an answer is only given for bytes that held still. */
                let before = std::fs::metadata(&full)?;
                let mut value = if one.count {
                    let bytes = std::fs::read(&full)?;
                    let binary = bytes[..bytes.len().min(8192)].contains(&0);
                    let lines = if binary { 0 } else { bytes.iter().filter(|&&b| b == 10).count() + 1 };
                    json!({ "path": one.path, "size": bytes.len(), "sha256": hex::encode(sha256(&bytes)), "lines": lines, "binary": binary })
                } else {
                    let (digest, size) = digest_file(&full)?;
                    json!({ "path": one.path, "size": size, "sha256": hex::encode(digest), "lines": 0, "binary": true })
                };
                let after = std::fs::metadata(&full)?;
                let (was, now) = (mtime_ms(&before), mtime_ms(&after));
                if before.len() != after.len() || was != now || value["size"].as_u64() != Some(after.len()) {
                    return Err(std::io::Error::other("changed while it was being read"));
                }
                value["mtimeMs"] = json!(now);
                Ok(value)
            })();
            progress.one(&one.path);
            answer.unwrap_or_else(|error| json!({ "path": one.path, "error": error.to_string() }))
        })
        .collect();
    Ok(json!({ "files": out, "ms": started.elapsed().as_millis() as u64 }))
}

/// A modification time as Node's `Stats.mtimeMs` gives it: seconds * 1e3 + nanoseconds / 1e6, in a double.
fn mtime_ms(meta: &std::fs::Metadata) -> Option<f64> {
    meta.modified().ok()?;
    Some(cbx_engine::scan::mtime_ms(meta))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToScan {
    root: String,
    shared: String,
    #[serde(default)]
    local: String,
    #[serde(default)]
    tracked_files: Option<Vec<String>>,
    #[serde(default)]
    tracked_folders: Option<Vec<String>>,
    /// Stat every file rather than trusting the listing's sizes and times (see ScanRequest).
    #[serde(default = "exact_by_default")]
    exact: bool,
}

fn exact_by_default() -> bool {
    true
}

/// The files the ignore rules let into a save, as `surveyFiles` / `changedFiles` walk them,
/// each with size, mtimeMs and mode from one stat. In the TypeScript walk's breadth-first order.
fn scan_command() -> Fallible<Value> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let wanted: ToScan = serde_json::from_str(&input)?;
    let started = Instant::now();
    let request = cbx_engine::scan::ScanRequest {
        root: PathBuf::from(&wanted.root),
        shared: wanted.shared,
        local: wanted.local,
        tracked_files: wanted.tracked_files.map(|list| list.into_iter().collect()),
        tracked_folders: wanted.tracked_folders.map(|list| list.into_iter().collect()),
        exact: wanted.exact,
    };
    /* A rule JavaScript could not compile is an answer, not a failure: the caller's own walk reports it. */
    let result = match cbx_engine::scan::scan(&request) {
        Ok(result) => result,
        Err(problem) => return Ok(json!({ "invalidRule": problem })),
    };
    let files: Vec<Value> = result
        .files
        .iter()
        .map(|f| json!({ "path": f.path, "size": f.size, "mtimeMs": f.mtime_ms, "mode": f.mode }))
        .collect();
    Ok(json!({ "files": files, "layers": result.layers, "folders": result.folders, "ms": started.elapsed().as_millis() as u64 }))
}

/// Progress lines on stderr, `{"done":n,"total":t,"path":p}`, at most ten a second, when asked for with --progress.
struct Progress {
    on: bool,
    state: std::sync::Mutex<(usize, usize, Instant)>,
}

impl Progress {
    fn from_args(args: &[String]) -> Self {
        let on = args.iter().any(|a| a == "--progress");
        let long_ago = Instant::now() - std::time::Duration::from_secs(1);
        Progress { on, state: std::sync::Mutex::new((0, 0, long_ago)) }
    }
    fn total(&self, total: usize) {
        self.state.lock().unwrap().1 = total;
    }
    fn one(&self, path: &str) {
        if !self.on {
            return;
        }
        let mut state = self.state.lock().unwrap();
        state.0 += 1;
        if state.2.elapsed().as_millis() >= 100 || state.0 == state.1 {
            state.2 = Instant::now();
            eprintln!("{}", json!({ "done": state.0, "total": state.1, "path": path }));
        }
    }
}

fn put(args: &[String]) -> Fallible<Value> {
    let objects = ObjectStore::open(need(args, 0, "objects folder")?)?;
    let bytes = std::fs::read(need(args, 1, "file")?)?;
    let name = objects.put(&bytes, args.get(2).map(|s| s == "loose").unwrap_or(false))?;
    objects.flush()?;
    Ok(json!({ "name": hex::encode(name) }))
}

fn delta_make(args: &[String]) -> Fallible<Value> {
    let out = need(args, 0, "output file")?;
    let target = std::fs::read(need(args, 1, "target")?)?;
    let owned: Vec<Vec<u8>> = args[2..].iter().map(std::fs::read).collect::<Result<_, _>>()?;
    let bases: Vec<&[u8]> = owned.iter().map(|b| b.as_slice()).collect();
    let started = Instant::now();
    let delta = make_delta(&bases, &target);
    std::fs::write(out, &delta.bytes)?;
    Ok(json!({ "bytes": delta.bytes.len(), "used": delta.used_order, "ms": started.elapsed().as_millis() as u64 }))
}

fn delta_apply(args: &[String]) -> Fallible<Value> {
    let out = need(args, 0, "output file")?;
    let delta = std::fs::read(need(args, 1, "delta")?)?;
    let owned: Vec<Vec<u8>> = args[2..].iter().map(std::fs::read).collect::<Result<_, _>>()?;
    let bases: Vec<&[u8]> = owned.iter().map(|b| b.as_slice()).collect();
    let target = apply_delta(&bases, &delta)?;
    std::fs::write(out, &target)?;
    Ok(json!({ "size": target.len(), "sha256": hex::encode(sha256(&target)) }))
}

fn quick_status_command(args: &[String]) -> Fallible<Value> {
    let from = match args.first() {
        Some(root) => PathBuf::from(root),
        None => std::env::current_dir()?,
    };
    let Some(root) = cbx_engine::quick::find_root(&from) else {
        return Ok(json!({ "answer": "unknown", "reason": "no history here" }));
    };
    Ok(match cbx_engine::quick::quick_status(&root)? {
        cbx_engine::quick::Quick::Clean { project, line, head, message } => {
            json!({ "answer": "clean", "root": root.to_string_lossy(), "project": project, "line": line, "head": head, "message": message })
        }
        cbx_engine::quick::Quick::Changed { project, line, head, message, added, modified, deleted } => json!({
            "answer": "changed", "root": root.to_string_lossy(), "project": project, "line": line, "head": head,
            "message": message, "added": added, "modified": modified, "deleted": deleted,
        }),
        cbx_engine::quick::Quick::Unknown(reason) => json!({ "answer": "unknown", "reason": reason }),
    })
}

/* A count as JavaScript's toLocaleString prints it in English: 12,345. */
fn grouped(count: usize) -> String {
    let digits = count.to_string();
    let mut out = String::new();
    for (at, digit) in digits.chars().enumerate() {
        if at > 0 && (digits.len() - at) % 3 == 0 {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

type ChangeLists<'a> = (&'a [String], &'a [String], &'a [String]);

/* What the JavaScript `cbx status` prints, colours and all (cli/src/local_status.ts, status_lines.ts). */
fn print_status(project: &str, line: &str, head: &str, message: &str, changes: Option<ChangeLists>) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::{
            GetConsoleMode, GetStdHandle, SetConsoleMode, ENABLE_VIRTUAL_TERMINAL_PROCESSING, STD_OUTPUT_HANDLE,
        };
        let handle = GetStdHandle(STD_OUTPUT_HANDLE);
        let mut mode = 0;
        if GetConsoleMode(handle, &mut mode) != 0 {
            SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
        }
    }
    let first = message.split('\n').next().unwrap_or("");
    println!(
        "\u{1b}[1m{project}\u{1b}[0m on \u{1b}[33m{line}\u{1b}[0m\u{1b}[2m  last saved {}: {first}\u{1b}[0m",
        &head[..10]
    );
    let Some((added, modified, deleted)) = changes else {
        println!("Nothing has changed since the last save.");
        return;
    };
    let count = added.len() + modified.len() + deleted.len();
    println!("{} {} changed since the last save:", grouped(count), if count == 1 { "file" } else { "files" });
    let mut rows: Vec<(&str, &String)> = Vec::with_capacity(count);
    rows.extend(added.iter().map(|file| ("\u{1b}[32madded   \u{1b}[0m", file)));
    rows.extend(modified.iter().map(|file| ("\u{1b}[33mchanged \u{1b}[0m", file)));
    rows.extend(deleted.iter().map(|file| ("\u{1b}[31mdeleted \u{1b}[0m", file)));
    rows.sort_by(|left, right| left.1.encode_utf16().cmp(right.1.encode_utf16()));
    for (mark, file) in rows.iter().take(50) {
        println!("  {mark}{file}");
    }
    if rows.len() > 50 {
        println!("\u{1b}[2m  … and {} more\u{1b}[0m", rows.len() - 50);
    }
    println!("\u{1b}[2mcbx diff shows the lines; cbx save -m \"…\" records them.\u{1b}[0m");
}

/// The `cbx` command, when this program is installed under that name.
fn front(args: &[String]) -> ExitCode {
    if args.len() == 1 && args[0] == "status" {
        if let Ok(cwd) = std::env::current_dir() {
            if let Some(root) = cbx_engine::quick::find_root(&cwd) {
                match cbx_engine::quick::quick_status(&root) {
                    Ok(cbx_engine::quick::Quick::Clean { project, line, head, message }) => {
                        print_status(&project, &line, &head, &message, None);
                        return ExitCode::SUCCESS;
                    }
                    Ok(cbx_engine::quick::Quick::Changed { project, line, head, message, added, modified, deleted }) => {
                        print_status(&project, &line, &head, &message, Some((&added, &modified, &deleted)));
                        return ExitCode::SUCCESS;
                    }
                    _ => {}
                }
            }
        }
    }
    /* Everything else is the JavaScript command line's. */
    let beside = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    let entry = std::env::var_os("CBX_CLI").map(PathBuf::from).or_else(|| {
        beside.and_then(|dir| {
            [dir.join("cli").join("dist").join("cli").join("src").join("bin.js"), dir.join("bin.js")]
                .into_iter()
                .find(|candidate| candidate.is_file())
        })
    });
    let Some(entry) = entry else {
        eprintln!("cbx: the full command line was not found beside this program; set CBX_CLI to its bin.js.");
        return ExitCode::from(2);
    };
    let node = std::env::var_os("CBX_NODE").unwrap_or_else(|| "node".into());
    let mut command = std::process::Command::new(node);
    command.arg(entry).args(args);
    /*
      The command line uses this same program as its engine unless told
      otherwise; the marker says that a call it makes here is an engine
      call, not somebody typing cbx.
    */
    if std::env::var_os("CBX_ENGINE").is_none() {
        if let Ok(me) = std::env::current_exe() {
            command.env("CBX_ENGINE", me).env("CBX_ENGINE_SELF", "1");
        }
    }
    match command.status() {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1).clamp(0, 255) as u8),
        Err(error) => {
            eprintln!("cbx: could not start Node to run the command line ({error}).");
            ExitCode::from(2)
        }
    }
}

fn main() -> ExitCode {
    let invoked = std::env::args().next().map(PathBuf::from);
    let named = invoked
        .as_ref()
        .and_then(|path| path.file_stem())
        .map(|stem| stem.to_string_lossy().to_lowercase());
    const ENGINE_COMMANDS: [&str; 12] = [
        "cuts", "digest", "store", "get", "check", "measure", "scan", "put", "delta-make", "delta-apply", "quick-status",
        "version",
    ];
    let engine_call = std::env::var_os("CBX_ENGINE_SELF").is_some_and(|flag| flag == "1")
        && std::env::args().nth(1).is_some_and(|first| ENGINE_COMMANDS.contains(&first.as_str()));
    if named.as_deref() == Some("cbx") && !engine_call {
        /*
          A status walks folders, which gains nothing past a few threads, and
          starting one per core was a measurable part of a 50 ms answer.
        */
        let _ = rayon::ThreadPoolBuilder::new().num_threads(std::thread::available_parallelism().map_or(4, |n| n.get().min(8))).build_global();
        let args: Vec<String> = std::env::args().skip(1).collect();
        return front(&args);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first() else {
        eprintln!("usage: cbx-engine <cuts|digest|store|get|put|delta-make|delta-apply|version> …");
        return ExitCode::from(2);
    };
    let rest = &args[1..];
    /* CBX_ENGINE_LOG=<file>: one line per command run, for checking that callers really use the engine. */
    if let Some(log) = std::env::var_os("CBX_ENGINE_LOG") {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
            let _ = writeln!(file, "{command}");
        }
    }
    let result = match command.as_str() {
        "cuts" => cuts(rest),
        "digest" => digest(rest),
        "store" => store(rest),
        "get" => get(rest),
        "check" => check(rest),
        "measure" => measure(rest),
        "scan" => scan_command(),
        "put" => put(rest),
        "delta-make" => delta_make(rest),
        "delta-apply" => delta_apply(rest),
        "quick-status" => {
            let _ = rayon::ThreadPoolBuilder::new().num_threads(std::thread::available_parallelism().map_or(4, |n| n.get().min(8))).build_global();
            quick_status_command(rest)
        }
        "version" => Ok(json!({ "engine": env!("CARGO_PKG_VERSION"), "protocol": 1, "store": "cbx-local 1", "delta": 4 })),
        other => Err(format!("unknown command {other}").into()),
    };
    match result {
        Ok(mut value) => {
            /* Every answer says which protocol it speaks; the caller checks it rather than asking first. */
            if let Some(object) = value.as_object_mut() {
                object.insert("protocol".into(), json!(1));
            }
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("cbx-engine: {error}");
            ExitCode::FAILURE
        }
    }
}
