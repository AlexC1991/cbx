/**
 * Paths from the base Version that remain in a candidate snapshot.
 *
 * A Version is a complete immutable view, never a list of changed files.
 * Selected paths are replaced by freshly read declarations, or removed when
 * explicitly marked as deletions. Everything unselected retains the exact
 * object, chunk list, or pack slice from the base.
 */
export function retainedBasePaths(
  basePaths: Iterable<string>,
  selectedPaths: ReadonlySet<string>,
): string[] {
  return [...basePaths]
    .filter((path) => !selectedPaths.has(path))
    .sort((left, right) => left.localeCompare(right));
}

/** Digest map returned by the accepted server manifest after an auto-merge. */
export function acceptedManifestDigests(
  files: Iterable<{ path?: string; sha256?: string }> | null | undefined,
): Record<string, string> {
  return Object.fromEntries(
    [...(files ?? [])].flatMap((file) =>
      file.path && file.sha256 ? [[file.path, file.sha256] as const] : [],
    ),
  );
}
