/**
 * Number formatting in the design's phrasing, where both sides can reach it.
 *
 * Byte sizes started out in the renderer, because only the renderer showed
 * them. Then the detector began writing a person-facing sentence of its own —
 * "10.7 GB of 10.8 GB, and no source in it" — and a second formatter in the
 * main process would have meant the same folder described two ways in two
 * places. The renderer re-exports these, so nothing that already imports from
 * `renderer/format` had to change.
 */

/** Short byte text: "812 MB", "3.6 GB", "24 GB". A fraction only when there is one. */
export function formatBytes(value: number): string {
  let size = value;
  for (const unit of ["B", "KB", "MB", "GB", "TB"]) {
    if (size < 1024 || unit === "TB") {
      if (unit === "B") return `${Math.round(size)} B`;
      const text = size >= 100 ? size.toFixed(0) : size.toFixed(1);
      return `${text.endsWith(".0") ? text.slice(0, -2) : text} ${unit}`;
    }
    size /= 1024;
  }
  return `${value} B`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
