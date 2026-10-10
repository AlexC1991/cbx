/*
  The Node this needs, said before anything else runs.

  The package said Node 20.11, and that was wrong: bundles and local histories
  use zstd, which Node gained in 23.8 and 22.15. On Linux, Node 22.12 got as
  far as reading a project and then died with
  "(0 , node_zlib_1.zstdDecompressSync) is not a function", which names
  nothing anybody can act on.
*/
import process from "node:process";
import zlib from "node:zlib";

export const MINIMUM_NODE = "22.15";

/** A sentence for a Node that is too old, or null when this one will do. */
export function nodeTooOld(): string | null {
  if (typeof (zlib as { zstdDecompressSync?: unknown }).zstdDecompressSync === "function") return null;
  return (
    `CodeRook needs Node ${MINIMUM_NODE} or later; this is Node ${process.versions.node} (${process.execPath}).\n` +
    `Install a current Node (https://nodejs.org), or put a newer one first on your PATH.`
  );
}
