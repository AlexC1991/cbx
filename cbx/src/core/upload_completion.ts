import type { UploadProgress } from "../shared/types.js";

/** Keep a pending completion visible without inventing server-side progress.
 * Every phase change comes from the uploader; ticks only measure elapsed time.
 */
export async function withCompletionProgress<T>(
  initial: UploadProgress,
  report: (progress: UploadProgress) => void,
  work: (report: (progress: UploadProgress) => void) => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let latest = initial;
  let active = true;
  const emit = (progress: UploadProgress) => {
    latest = progress;
    if (progress.stage !== "publish") active = false;
    report(progress.stage === "publish" ? {
      ...progress,
      completion: {
        phase: progress.completion?.phase ?? "preparing",
        elapsedSeconds: Math.max(0, (performance.now() - started) / 1000),
      },
    } : progress);
  };
  emit(initial);
  const timer = setInterval(() => { if (active) emit(latest); }, 1000);
  timer.unref?.();
  try {
    return await work(emit);
  } finally {
    active = false;
    clearInterval(timer);
  }
}
