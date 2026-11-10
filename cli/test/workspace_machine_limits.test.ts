import assert from "node:assert/strict";
import test from "node:test";

import { readWhole } from "../dist/cli/src/workspace_machine.js";

/**
 * Checking out a draft whose text file was left out of a diff page (the page's
 * 4 MiB budget) reads that file in full, a page of lines at a time. The pages
 * must put it back exactly: line endings, an empty line, a final newline.
 */

/** The server's paging (remote_workspace_routes.ts: split on \n, slice, join). */
function server(text: string) {
  const lines = text.split("\n");
  let calls = 0;
  const read = async (route: string) => {
    calls += 1;
    const query = new URL(route, "https://x.invalid").searchParams;
    const start = Number(query.get("startLine")) - 1;
    const limit = Number(query.get("lines"));
    return { content: lines.slice(start, start + limit).join("\n"), truncated: start + limit < lines.length };
  };
  return { read, calls: () => calls };
}

test("a large stylesheet comes back byte for byte across page boundaries", async () => {
  const css = Array.from({ length: 5_123 }, (_, i) => (i % 700 === 0 ? "" : `.r${i} { color: #8c968f; }`)).join("\r\n") + "\r\n";
  const fake = server(css);
  assert.equal(await readWhole("/v1/repositories/p/workspaces/w", "website/app/globals.css", fake.read), css);
  assert.equal(fake.calls(), 3);
});

test("a short file is one request", async () => {
  const fake = server("one\ntwo\n");
  assert.equal(await readWhole("/d", "a.txt", fake.read), "one\ntwo\n");
  assert.equal(fake.calls(), 1);
});
