/*
  The CBX engine is compiled into dist/cbx/, and it is Apache-2.0 licensed.

  That licence asks for itself and the NOTICE file to go with every copy that
  is passed on. Publishing this package passes one on, so both are put beside
  the compiled engine on every build rather than remembered at release time.
*/
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "..", "..", "cbx");
const target = path.resolve(here, "..", "dist", "cbx");

await mkdir(target, { recursive: true });
for (const name of ["LICENSE", "NOTICE"]) {
  await copyFile(path.join(source, name), path.join(target, name));
}
console.log("Copied the CBX engine's LICENSE and NOTICE into dist/cbx/.");
