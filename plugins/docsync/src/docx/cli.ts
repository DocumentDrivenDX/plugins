// The commands for a Word target. Like the rest, they work on files only.
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { bodySha, committedBodySha, loadBindings, locate, mark, marked, read, tryGit, type Binding } from "../binding.ts";
import { Refused, refuseCrlf, splitFrontMatter } from "../markdown.ts";
import { createDocx, toMarkdown } from "./create.ts";
import { digest, readShared, replaceShared } from "./files.ts";
import { readWord } from "./read.ts";
import { backupDir, checkName, loadSnapshot, location, nameOf, saveState, setLocation, type Snapshot, snapshotPath, TOOL } from "./state.ts";
import { baseUnits, bindSnapshot, known, pull, push } from "./sync.ts";
import { align, differences, mdUnits } from "./units.ts";

export interface Options {
  word?: string;
  name?: string;
  record?: "git" | "doc";
  prefer?: "git" | "doc";
  write?: boolean;
  /** Writes even when the Word file looks to have lost its structure. */
  acceptLoss?: boolean;
  /** Runs the project's guard on the file before and after. */
  guard?: (current: string, next: string) => void;
  /** Prints the diff of the Markdown file. */
  diff: (current: string, next: string) => void;
}

const lines = (list: string[]) => {
  for (const line of list) console.log(`- ${line}`);
};

/** `import DOCX`: Markdown on standard output, notes on standard error. */
export function importDocx(path: string): number {
  const shared = readShared(path);
  const word = readWord(shared.bytes);
  process.stdout.write(toMarkdown(word));
  for (const note of [...shared.notes, ...word.notes]) console.error(`note: ${note}`);
  return 0;
}

/** `create FILE --word OUT`: a first .docx. It never overwrites. */
export function create(file: string, out: string): number {
  const current = read(file);
  refuseCrlf(current);
  if (extname(out).toLowerCase() !== ".docx") throw new Refused("the new file's name must end in .docx");
  if (existsSync(out)) throw new Refused(`${out} exists; create never overwrites a file`);
  writeFileSync(out, createDocx(current), { flag: "wx" });
  console.log(`wrote ${out}\nBind it with: bind ${basename(file)} --word <path>`);
  return 0;
}

const slug = (path: string) =>
  basename(path, extname(path)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "document";

export function bindWord(file: string, options: Options): number {
  const current = read(file);
  refuseCrlf(current);
  const { root, path } = locate(file);
  if (committedBodySha(root, path) !== bodySha(current))
    throw new Refused("the file's body differs from the committed one; commit it first");
  const existing = loadBindings(root);
  const held = existing.find((e) => e.path === path);
  if (held && held.tool !== TOOL)
    throw new Refused(`${path} is bound to a ${held.tool} target; a file has one binding. Remove that entry first`);
  const name = checkName(options.name ?? (held ? nameOf(held) : slug(path)));
  if (existing.some((e) => e.path !== path && e.origin === `word:${name}`))
    throw new Refused(`the name ${name} is used by another file; pass --name`);
  const docx = realpathSync(options.word!);
  const shared = readShared(docx);
  const { snapshot, word } = bindSnapshot(splitFrontMatter(current)[1], shared.bytes, shared.sha);
  mark(root, path);
  saveState(root, { path, tool: TOOL, origin: `word:${name}`, record: options.record ?? held?.record ?? "git" }, snapshot);
  setLocation(root, name, docx);
  lines([...shared.notes, ...word.notes]);
  console.log(`bound ${path} to the Word file as word:${name}\ncommit .docsync.json, .gitattributes and ${snapshotPath(name)} together`);
  return 0;
}

interface Bound {
  root: string;
  path: string;
  entry: Binding;
  current: string;
  front: string;
  body: string;
}

function bound(file: string): Bound {
  const current = read(file);
  refuseCrlf(current);
  const { root, path } = locate(file);
  const entry = loadBindings(root).find((e) => e.path === path);
  if (!entry || entry.tool !== TOOL) throw new Refused(`${path} is not bound to a Word file`);
  if (!marked(root, path)) throw new Refused(`${path} has no docsync git attribute; restore .gitattributes`);
  const [front, body] = splitFrontMatter(current);
  return { root, path, entry, current, front, body };
}

export function locateWord(file: string, docx: string): number {
  const { root, entry } = bound(file);
  const snapshot = loadSnapshot(root, entry);
  const path = realpathSync(docx);
  const shared = readShared(path);
  const word = readWord(shared.bytes, known(snapshot));
  const base = baseUnits(snapshot);
  const { mapping } = align(base, word.units, false);
  // A different document shares few blocks with the base.
  if (shared.sha !== snapshot.docxSha256 && mapping.size * 2 < base.length)
    throw new Refused("that Word file shares fewer than half its blocks with the base; it looks like a different document");
  setLocation(root, nameOf(entry), path);
  lines(shared.notes);
  console.log(`this clone now reads word:${nameOf(entry)} from ${path}`);
  return 0;
}

export function statusWord(file: string): number {
  const { root, path, entry, body } = bound(file);
  const snapshot = loadSnapshot(root, entry);
  const out: Record<string, unknown> = {
    path, bound: true, tool: TOOL, name: nameOf(entry), record: entry.record,
    fileChangedSinceBase: differences(mdUnits(snapshot.markdown), mdUnits(body)).length > 0 || body !== snapshot.markdown,
  };
  try {
    const docx = location(root, nameOf(entry));
    out.word = docx;
    const shared = readShared(docx);
    const word = readWord(shared.bytes, known(snapshot));
    out.wordChangedSinceBase = differences(baseUnits(snapshot), word.units).length > 0;
    out.notes = [...shared.notes, ...word.notes];
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    out.problem = e.message;
  }
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

function checkLoss(lost: string | undefined, options: Options): void {
  if (!lost) return;
  console.log(`WARNING: ${lost}. An editor may have saved the file without its structure. Look in the service's version history for an earlier copy.`);
  if (options.write && !options.acceptLoss)
    throw new Refused("nothing was written because the Word file looks to have lost its structure; pass --accept-loss only if the loss is intended");
}

const movesBase = (was: Snapshot, now: Snapshot) =>
  was.markdown !== now.markdown || JSON.stringify(was.noteIds) !== JSON.stringify(now.noteIds);

const side = (choice: "git" | "doc") => (choice === "git" ? "ours" : "theirs");

export function pullWord(file: string, options: Options): number {
  const { root, entry, current, front, body } = bound(file);
  const snapshot = loadSnapshot(root, entry);
  const shared = readShared(location(root, nameOf(entry)));
  const result = pull(snapshot, body, shared.bytes, shared.sha, side(options.prefer ?? entry.record));
  const next = front + result.body;
  options.guard?.(current, next);
  options.diff(current, next);
  lines([...shared.notes, ...result.report]);
  checkLoss(result.lost, options);
  const fileChanges = next !== current;
  const baseMoves = movesBase(snapshot, result.snapshot);
  console.log(`file ${fileChanges ? "changes" : "unchanged"}`);
  if (!options.write) {
    console.log("nothing written; pass --write to apply this");
  } else if (fileChanges || baseMoves) {
    if (read(file) !== current) throw new Refused("the Markdown file changed during the pull; run it again");
    if (fileChanges) writeFileSync(file, next);
    saveState(root, entry, result.snapshot);
    console.log(`wrote ${fileChanges ? `${basename(file)} and ` : ""}${snapshotPath(nameOf(entry))}; commit or discard them together`);
  }
  return 0;
}

export function pushWord(file: string, options: Options): number {
  const { root, entry, current, body } = bound(file);
  const snapshot = loadSnapshot(root, entry);
  const name = nameOf(entry);
  if (committedBodySha(root, entry.path) !== bodySha(current))
    throw new Refused("the file's body differs from the committed one; commit it before pushing");
  const committed = tryGit(root, "show", `HEAD:${snapshotPath(name)}`);
  if (!committed.ok || committed.out !== read(join(root, snapshotPath(name))))
    throw new Refused(`${snapshotPath(name)} differs from the committed one; commit it with the file before pushing`);
  const docx = location(root, name);
  const shared = readShared(docx);
  const result = push(snapshot, body, shared.bytes, side(options.prefer ?? entry.record));
  console.log(result.changes.length ? `changes to the Word file:\n${result.changes.map((c) => `  ${c}`).join("\n")}` : "the Word file needs no change");
  lines([...shared.notes, ...result.report]);
  checkLoss(result.lost, options);
  if (!options.write) {
    console.log("nothing written; pass --write to apply this");
    return 0;
  }
  let sha = shared.sha;
  if (result.docx) {
    const backup = replaceShared(docx, result.docx, shared.sha, backupDir(root));
    sha = digest(result.docx);
    console.log(`wrote ${docx}\nthe file it replaced is kept at ${backup}`);
  }
  if (movesBase(snapshot, result.snapshot)) {
    saveState(root, entry, { ...result.snapshot, docxSha256: sha });
    console.log(`updated the base in ${snapshotPath(name)} and .docsync.json; commit them`);
  }
  const left = differences(mdUnits(body), readWord(readShared(docx).bytes, known(result.snapshot)).units);
  if (left.length) console.log(`the file and the Word file still differ:\n${left.slice(0, 20).map((l) => `  ${l}`).join("\n")}`);
  else console.log("the file and the Word file now say the same thing");
  return 0;
}

