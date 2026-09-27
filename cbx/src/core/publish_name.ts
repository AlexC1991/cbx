/**
 * A name for one publishing attempt, derived from what is being published.
 *
 * It has to be the same across retries of the same attempt and different for
 * a genuinely new one — and it cannot be kept on disk, because the crash it
 * exists to survive is exactly the kind that loses whatever was written just
 * before it. Deriving it from the content solves both: the same files
 * against the same head produce the same name, and anything else does not.
 *
 * Kept apart from the uploader because it depends on nothing, which is what
 * lets it be tested without a network, a filesystem or an account.
 */
import { createHash } from "node:crypto";

export function publishAttemptName(input: {
  repositoryId: string | null;
  expectedHeadVersionId?: string | null;
  message: string;
  files: Array<{ path: string; objectId: string }>;
}): string {
  const shape = [
    input.repositoryId ?? "new",
    input.expectedHeadVersionId ?? "none",
    input.message,
    // Sorted, so the order the scanner happened to walk the folder in
    // cannot make the same attempt look like a different one.
    ...[...input.files].map((file) => `${file.path}:${file.objectId}`).sort(),
  ].join("\n");
  return createHash("sha256").update(shape).digest("hex").slice(0, 40);
}
