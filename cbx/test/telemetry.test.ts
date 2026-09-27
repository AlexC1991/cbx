import assert from "node:assert/strict";
import test from "node:test";

import { RepositoryTelemetry } from "../dist/shared/telemetry.js";

test("publication telemetry reconciles request bodies and retries", () => {
  const metrics = new RepositoryTelemetry();
  metrics.request("objects", "abc", 7, 4);
  metrics.request("objects", new Uint8Array(5), 2, 3);
  metrics.retry();
  metrics.memory(100);
  metrics.memory(80);
  const result = metrics.snapshot();
  assert.equal(result.requests, 2);
  assert.equal(result.retries, 1);
  assert.equal(result.requestBodyBytes, 8);
  assert.equal(result.responseBodyBytes, 9);
  assert.equal(result.peakMemoryBytes, 100);
  assert.deepEqual(result.routes.objects, {
    requests: 2,
    sentBytes: 8,
    receivedBytes: 9,
    elapsedMs: 7,
  });
});
