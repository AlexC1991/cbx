import assert from "node:assert/strict";
import test from "node:test";
import { UploadDisplay } from "../dist/cli/src/upload_progress.js";
const publishing = {
  stage: "publish" as const, files: 1000, totalFiles: 1000, bytes: 100, totalBytes: 100,
  percent: 99, bytesPerSecond: 0, path: "Waiting for CodeRook to confirm the save",
  completion: { phase: "confirming" as const, elapsedSeconds: 65 },
};
test("a terminal sees activity and elapsed time rather than a stuck percentage", () => {
  const output: string[] = [];
  const display = new UploadDisplay(true, (line) => output.push(line));
  display.report(publishing);
  display.report({ ...publishing, completion: { ...publishing.completion, elapsedSeconds: 66 } });
  display.done();
  assert.ok(output[0]!.includes("Finalizing save"));
  assert.ok(output[0]!.includes("1:05 elapsed"));
  assert.ok(!output[0]!.includes("99%"));
  assert.notEqual(output[0], output[1]);
  assert.equal(output.at(-1), "\r\x1b[2K");
});
test("redirected output announces completion phases once without animation", () => {
  const output: string[] = [];
  const display = new UploadDisplay(false, (line) => output.push(line));
  display.report(publishing);
  display.report(publishing);
  display.report({ ...publishing, path: "Confirmed · updating local records" });
  display.done();
  assert.equal(output.length, 2);
  assert.ok(output.every((line) => !line.includes("\x1b") && line.endsWith("\n")));
});
