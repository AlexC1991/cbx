//! CBX's native byte engine.
//!
//! The compatibility contract (see README.md): every object name, chunk cut,
//! frame and store layout this crate writes is one the TypeScript CBX already
//! writes and reads, so histories and everything stored on CodeRook keep
//! working unchanged. New, faster or smaller shapes live only where nothing
//! outside this machine reads them, and are always checked against the
//! SHA-256 names before use.

pub mod chunking;
pub mod delta;
pub mod frame;
pub mod quick;
pub mod rules;
pub mod scan;
pub mod snapshot;
pub mod store;
