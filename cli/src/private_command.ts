/**
 * `cbx private` — files and folders only the project's own people may see.
 *
 * Patterns in the shape of a .gitignore, kept on the project rather than in a
 * file inside it, so they cover every version from the moment they are set,
 * old ones included, and a save can never undo them. Visitors, the public
 * API, git clone, zips and Pages leave those files out; members see them.
 */
import { getPrivatePaths, putPrivatePaths } from "./api.js";
import { accent, bold, dim, green, red } from "./colour.js";
import { resolveProject } from "./project_commands.js";
import type { Parsed } from "./registry.js";

export async function commandPrivate(parsed: Parsed): Promise<number> {
  const sub = parsed.positional[0] ?? "list";
  const named = parsed.flags.get("project");
  const project = await resolveProject(typeof named === "string" ? named : undefined);
  if (!project) return 1;
  const current = await getPrivatePaths(project.id);

  if (sub === "list") {
    if (!current.length) {
      console.log(`Nothing in ${bold(project.slug)} is private on its own.`);
      console.log(dim(`  Keep files to the project's people: cbx private add "design/" "*.psd"`));
      return 0;
    }
    console.log(bold(`Private in ${project.slug}`) + dim(" — only the project's people see these"));
    for (const pattern of current) console.log(`  ${pattern}`);
    return 0;
  }

  const given = parsed.positional.slice(1);
  if (!given.length) {
    console.error(red(`Name at least one pattern: cbx private ${sub} "design/"`));
    return 1;
  }
  let next: string[];
  if (sub === "add") {
    next = [...current, ...given.filter((one) => !current.includes(one))];
  } else if (sub === "remove") {
    const missing = given.filter((one) => !current.includes(one));
    if (missing.length) {
      console.error(red(`Not in the list: ${missing.join(", ")}. See: cbx private list`));
      return 1;
    }
    next = current.filter((one) => !given.includes(one));
  } else if (sub === "set") {
    next = given;
  } else {
    console.error(red(`cbx private has no "${sub}". `) + "See: " + accent("cbx help private"));
    return 1;
  }
  const saved = await putPrivatePaths(project.id, next);
  console.log(`${green("Saved.")} ${saved.length ? `Private in ${bold(project.slug)}:` : `Nothing in ${project.slug} is private on its own now.`}`);
  for (const pattern of saved) console.log(`  ${pattern}`);
  if (sub !== "remove" && saved.length) {
    console.log(dim("  Every version obeys this now, old ones included. Members still see everything."));
  }
  return 0;
}
