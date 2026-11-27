// What a Word binding keeps: the base snapshot, which is committed, and the path
// of the .docx on this machine, which is not.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Binding, git, read, saveBinding, sha256, tryGit, writeInRepo } from "../binding.ts";
import { Refused } from "../markdown.ts";
import { READER } from "./read.ts";

export const TOOL = "word";

export interface Snapshot {
  version: 1;
  reader: number;
  /** What both sides last agreed on. Its blocks are the base of each side. */
  markdown: string;
  /** Word's ID for each footnote label, to help tell footnotes apart. */
  noteIds: Record<string, string>;
  docxSha256: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function checkName(name: string): string {
  if (!NAME.test(name)) throw new Refused("a binding name is 1 to 63 lowercase letters, digits and hyphens, and starts with a letter or digit");
  return name;
}

export const nameOf = (entry: Binding): string => {
  if (!entry.origin.startsWith("word:")) throw new Refused(`the origin ${entry.origin} is not word:<name>`);
  return checkName(entry.origin.slice(5));
};

export const snapshotPath = (name: string) => `.docsync/word/${name}.json`;

const serialize = (s: Snapshot) => JSON.stringify(s, null, 2) + "\n";

export function loadSnapshot(root: string, entry: Binding): Snapshot {
  const path = snapshotPath(nameOf(entry));
  if (!existsSync(join(root, path))) throw new Refused(`the base snapshot ${path} is missing; restore it from git`);
  const text = read(join(root, path));
  if (sha256(text) !== entry.syncedRev)
    throw new Refused(`${path} and .docsync.json do not agree; restore both from the same commit`);
  const snapshot = JSON.parse(text) as Snapshot;
  if (snapshot.version !== 1 || typeof snapshot.markdown !== "string" || typeof snapshot.noteIds !== "object" || !snapshot.noteIds)
    throw new Refused(`${path} is not a snapshot this version reads`);
  if (snapshot.reader !== READER)
    throw new Refused(`${path} was made by reader ${snapshot.reader}, and this is reader ${READER}; bind the file again`);
  if (sha256(snapshot.markdown) !== entry.baseSha256) throw new Refused(`${path} does not hold the recorded base`);
  return snapshot;
}

/** Writes the snapshot and the binding that names it. */
export function saveState(root: string, entry: Omit<Binding, "syncedRev" | "baseSha256">, snapshot: Snapshot): void {
  const text = serialize(snapshot);
  writeInRepo(root, snapshotPath(checkName(entry.origin.slice(5))), text);
  saveBinding(root, { ...entry, syncedRev: sha256(text), baseSha256: sha256(snapshot.markdown) });
}

export const setLocation = (root: string, name: string, docx: string) => {
  git(root, "config", "--local", `docsync.${name}.path`, docx);
};

/** The path comes only from this clone's own git configuration. */
export function location(root: string, name: string): string {
  const r = tryGit(root, "config", "--local", "--get", `docsync.${name}.path`);
  if (!r.ok || !r.out.trim())
    throw new Refused(`this clone does not know where the Word file is; run \`locate <file> --word <path>\``);
  return r.out.replace(/\n$/, "");
}

/** Copies of replaced files stay inside .git, out of the synced folder and the tree. */
export function backupDir(root: string): string {
  return resolve(root, git(root, "rev-parse", "--git-path", "docsync-backups").replace(/\n$/, ""));
}
