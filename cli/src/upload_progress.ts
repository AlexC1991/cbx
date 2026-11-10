import process from "node:process";
import type { UploadProgress } from "../../cbx/src/shared/types";
import { bar } from "./progress";

/** The timer in the shared uploader keeps finalization visible in every client. */
export class UploadDisplay {
  private phase = "";
  private frame = 0;
  constructor(
    private readonly interactive = Boolean(process.stdout.isTTY),
    private readonly write = (text: string) => { process.stdout.write(text); },
  ) {}

  report(progress: UploadProgress): void {
    const finishing = progress.stage === "publish";
    const phase = finishing ? progress.path : progress.stage;
    if (!this.interactive) {
      if (finishing && phase !== this.phase) this.write(`  ${phase}\n`);
      this.phase = phase;
      return;
    }
    this.phase = phase;
    const seconds = Math.floor(progress.completion?.elapsedSeconds ?? 0);
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    const detail = finishing
      ? `${["|", "/", "-", "\\"][this.frame++ % 4]} Finalizing save · ${clock} elapsed · ${progress.path}`
      : `${bar(progress.percent / 100, 18, (text) => text)} ${progress.percent}% ${progress.stage} ${progress.files}/${progress.totalFiles} ${progress.path}`;
    // Keep status on one terminal row, including narrow windows.
    const width = Math.max(1, (process.stdout.columns ?? 120) - 3);
    this.write(`\r\x1b[2K  ${detail.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, width)}`);
  }

  done(): void { if (this.interactive) this.write("\r\x1b[2K"); }
}
