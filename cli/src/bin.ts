#!/usr/bin/env node
/**
 * The cbx command.
 *
 * `cbx status` in a folder with a local history is the command people run
 * most, and it needs only that history: no sign-in, no network, none of the
 * upload, project or workspace code. Answered here it loads a handful of
 * modules instead of all of the CLI's, which was most of its time. It prints
 * through the same function the full command table uses (local_status.ts).
 *
 * Everything else goes to cli.ts unchanged, and so does status whenever
 * anything about it is out of the ordinary: other arguments, a Node that is
 * too old, no local history here, or the unread-messages reminder being due.
 */
import { reminderDue } from "./reminder_gate.js";

async function quickStatus(): Promise<number | null> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || argv[0] !== "status") return null;
  const { nodeTooOld } = await import("./node_check.js");
  if (nodeTooOld()) return null;
  if (await reminderDue("status")) return null;
  /*
    A folder that is exactly its last save is answered by the engine alone,
    from the stamp the last status left (engine/src/quick.rs): one walk and
    four small reads, and none of the history code loaded here. Anything it
    cannot vouch for is answered below as before.
  */
  const { engineQuickStatus } = await import("../../cbx/src/shared/native_engine.js");
  const quick = await engineQuickStatus(process.cwd());
  if (quick?.answer === "clean" || quick?.answer === "changed") {
    const { accent, bold, dim, short } = await import("./paint.js");
    console.log(
      `${bold(quick.project)} on ${accent(quick.line)}` +
        dim(`  last saved ${short(quick.head)}: ${quick.message.split("\n")[0]}`),
    );
    if (quick.answer === "clean") {
      console.log("Nothing has changed since the last save.");
    } else {
      const { printChangedSummary } = await import("./status_lines.js");
      printChangedSummary({ added: quick.added, modified: quick.modified, deleted: quick.deleted });
    }
    return 0;
  }
  const { Repository } = await import("../../cbx/src/local/repository.js");
  const repository = await Repository.find(process.cwd());
  if (!repository) return null;
  const { printLocalStatus, red } = await import("./local_status.js");
  try {
    return await printLocalStatus(repository);
  } catch (error) {
    /* What localStatus's wrapper prints for anything status itself can raise. */
    console.error(red(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}

quickStatus().then(
  (code) => {
    if (code === null) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require("./cli.js") as typeof import("./cli.js")).start();
    } else {
      process.exitCode = code;
    }
  },
  () => {
    /* Anything unexpected here: the full command line answers instead. */
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require("./cli.js") as typeof import("./cli.js")).start();
  },
);
