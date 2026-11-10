import assert from "node:assert/strict";
import test from "node:test";
import { withCompletionProgress } from "../dist/core/upload_completion.js";
import type { UploadProgress } from "../src/shared/types.ts";

const initial: UploadProgress = {
  stage: "publish", files: 50000, totalFiles: 50000, bytes: 100, totalBytes: 100,
  percent: 96, bytesPerSecond: 0, path: "Waiting for CodeRook",
  completion: { phase: "confirming", elapsedSeconds: 0 },
};

for (const outcome of ["success", "failure", "cancellation"] as const) {
  test(`completion keeps reporting during a quiet request and stops after ${outcome}`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const events: UploadProgress[] = [];
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const error = new Error(outcome === "cancellation" ? "Upload cancelled" : "Request failed");
    const pending = withCompletionProgress(initial, (event) => events.push(event), async (report) => {
      await gate;
      if (outcome !== "success") throw error;
      report({ ...initial, path: "Confirmed · updating local records", completion: { phase: "local", elapsedSeconds: 0 } });
      report({ ...initial, stage: "done", percent: 100 });
      return "saved";
    });
    assert.equal(events.length, 1);
    t.mock.timers.tick(3000);
    assert.ok(events.length >= 4, "quiet HTTP waits still report activity");
    assert.ok(events.every((event) => event.stage === "publish" && event.percent < 100));
    finish();
    if (outcome === "success") {
      assert.equal(await pending, "saved");
      assert.equal(events.at(-2)?.completion?.phase, "local");
      assert.equal(events.at(-1)?.stage, "done");
    } else {
      await assert.rejects(pending, (received) => received === error);
      assert.ok(events.every((event) => event.stage !== "done"));
    }
    const count = events.length;
    t.mock.timers.tick(60000);
    assert.equal(events.length, count, "no timer leaks or ghost success after finishing");
  });
}
