#!/usr/bin/env node
/*
  The executable half of `git-remote-coderook`.

  Split from the module that does the work so that module can be imported by a
  test without starting the protocol loop. Merging the two costs nothing to
  write and means every test of a pure function first has to stop a process
  from reading stdin and answering git.
*/
import process from "node:process";

import { AlreadyReported, main } from "./git_remote.js";

/**
 * Finish, without cutting the pipe to git mid-sentence.
 *
 * `process.exit()` ends the process immediately, while stdout may still hold
 * writes queued for git. On Windows that surfaced as
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
 *
 * on the way out of a clone — libuv tearing down a handle that was still
 * being written to. Setting the code instead lets the loop drain what is
 * owed and end on its own, which is also the only way git reliably sees the
 * last of the protocol.
 *
 * The timer is the belt: it only fires if something else is still holding
 * the loop open, and being unreferenced it cannot be the thing holding it.
 */
function finish(code: number): void {
  process.exitCode = code;
  /* stdin is already at EOF by the time main returns; this releases it. */
  process.stdin.pause();
  setTimeout(() => process.exit(code), 5000).unref();
}

main(process.argv.slice(2))
  .then(finish)
  .catch((error: unknown) => {
    /*
      Said once. A refusal that has already set itself out in full does not
      want the same paragraph printed again with a program name in front of
      it — which is what a reader got when a push was turned down for
      carrying a credential.
    */
    if (!(error instanceof AlreadyReported)) {
      process.stderr.write(
        `git-remote-coderook: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    finish(1);
  });
