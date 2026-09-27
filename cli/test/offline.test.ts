import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { queueOfflineCandidate, readOfflineCandidate } from "../dist/cli/src/offline.js";

test("an offline candidate is durable and preserves its base Version", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "coderook-offline-"));
  const queued = await queueOfflineCandidate(folder, {
    repositoryId: "repo",
    baseVersionId: "version-30",
    message: "waiting for a connection",
    files: [{ path: "src/app.ts", sha256: "a".repeat(64), size: 12 }],
  });
  const result = await readOfflineCandidate(queued);
  assert.equal(result.baseVersionId, "version-30");
  assert.equal(result.files[0]?.path, "src/app.ts");
});
