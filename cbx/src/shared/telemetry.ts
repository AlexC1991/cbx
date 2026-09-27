/** Small, dependency-free publication telemetry shared by native and browser clients. */
export type RepositoryTelemetrySnapshot = {
  elapsedMs: number;
  requests: number;
  retries: number;
  requestBodyBytes: number;
  responseBodyBytes: number;
  peakMemoryBytes: number | null;
  routes: Record<string, { requests: number; sentBytes: number; receivedBytes: number; elapsedMs: number }>;
};

const byteLength = (body: string | Uint8Array | undefined): number =>
  typeof body === "string" ? new TextEncoder().encode(body).byteLength : body?.byteLength ?? 0;

export class RepositoryTelemetry {
  private readonly started = performance.now();
  private requests = 0;
  private retries = 0;
  private requestBodyBytes = 0;
  private responseBodyBytes = 0;
  private peakMemoryBytes: number | null = null;
  private readonly routes = new Map<string, { requests: number; sentBytes: number; receivedBytes: number; elapsedMs: number }>();

  retry(): void {
    this.retries += 1;
  }

  request(route: string, body: string | Uint8Array | undefined, responseBytes: number, elapsedMs: number): void {
    this.requestBytes(route, byteLength(body), responseBytes, elapsedMs);
  }

  requestBytes(route: string, sentBytes: number, responseBytes: number, elapsedMs: number): void {
    this.requests += 1;
    this.requestBodyBytes += sentBytes;
    this.responseBodyBytes += responseBytes;
    const prior = this.routes.get(route) ?? { requests: 0, sentBytes: 0, receivedBytes: 0, elapsedMs: 0 };
    prior.requests += 1;
    prior.sentBytes += sentBytes;
    prior.receivedBytes += responseBytes;
    prior.elapsedMs += elapsedMs;
    this.routes.set(route, prior);
  }

  memory(bytes: number | null | undefined): void {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return;
    this.peakMemoryBytes = Math.max(this.peakMemoryBytes ?? 0, bytes);
  }

  snapshot(): RepositoryTelemetrySnapshot {
    return {
      elapsedMs: performance.now() - this.started,
      requests: this.requests,
      retries: this.retries,
      requestBodyBytes: this.requestBodyBytes,
      responseBodyBytes: this.responseBodyBytes,
      peakMemoryBytes: this.peakMemoryBytes,
      routes: Object.fromEntries([...this.routes.entries()].sort(([left], [right]) => left.localeCompare(right))),
    };
  }
}
