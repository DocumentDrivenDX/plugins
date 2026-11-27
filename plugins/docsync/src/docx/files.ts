// The Word file as it sits in a folder that a sync service may be changing.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Refused } from "../markdown.ts";

export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface Shared {
  bytes: Buffer;
  sha: string;
  notes: string[];
}

/** Files that say an editor on this machine, or one sharing the folder, has the document open. */
export function openMarks(path: string): string[] {
  const [dir, name] = [dirname(path), basename(path)];
  // Word drops the first two characters of a longer name from its owner file.
  return [`~$${name}`, `~$${name.slice(2)}`, `.~lock.${name}#`].filter((n) => existsSync(join(dir, n)));
}

/** Other .docx files here whose names suggest a copy a sync service or a person made of this one. */
export function copies(path: string): string[] {
  const name = basename(path);
  const stem = name.slice(0, name.length - extname(name).length).toLowerCase();
  return readdirSync(dirname(path))
    .filter((other) => {
      const lower = other.toLowerCase();
      return other !== name && lower.endsWith(".docx") && !other.startsWith("~$") && !other.startsWith(".") &&
        lower.startsWith(stem) && /^[ ()_-]/.test(lower.slice(stem.length));
    })
    .sort();
}

export function readShared(path: string): Shared {
  const ext = extname(path).toLowerCase();
  if (ext !== ".docx") throw new Refused(`${basename(path)} is not a .docx file${ext === ".docm" ? "; docsync does not open macro files" : ""}`);
  if (!existsSync(path)) {
    if (existsSync(join(dirname(path), `.${basename(path)}.icloud`)))
      throw new Refused(`${basename(path)} is in iCloud but not on this computer; download it, then run this again`);
    throw new Refused(`there is no file at ${path}`);
  }
  const notes: string[] = [];
  const before = statSync(path);
  if (!before.isFile()) throw new Refused(`${path} is not a file`);
  if (before.size > 100 * 1024 * 1024) throw new Refused("the Word file is over 100 MB");
  if (before.size > 0 && before.blocks === 0) notes.push("the file looked online-only, so reading it may have downloaded it");
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
    if (!bytes.equals(readFileSync(path))) throw new Refused("the Word file changed while it was read; wait for syncing to finish");
  } catch (e) {
    if (e instanceof Refused) throw e;
    throw new Refused(`the Word file could not be read (${(e as Error).message}); if it is online-only, download it first`);
  }
  const marks = openMarks(path);
  if (marks.length) notes.push(`the file appears to be open (${marks.join(", ")}); unsaved changes are not in it`);
  const others = copies(path);
  if (others.length)
    notes.push(`other files here may be conflict copies or other versions, and are not read: ${others.join(", ")}`);
  return { bytes, sha: digest(bytes), notes };
}

/**
 * Replaces the Word file with `bytes` if it is still the file that was read. The
 * old file is first copied into `backups`. The new one is written beside it and
 * renamed over it, so a reader never sees half a file. Returns the copy's path.
 */
export function replaceShared(path: string, bytes: Uint8Array, expected: string, backups: string): string {
  const check = () => {
    const marks = openMarks(path);
    if (marks.length) throw new Refused(`the file appears to be open (${marks.join(", ")}); close it, then push again`);
    if (digest(readFileSync(path)) !== expected)
      throw new Refused("the Word file changed during the push; nothing was written. Run it again");
  };
  check();
  mkdirSync(backups, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(backups, `${stamp}-${expected.slice(0, 8)}-${basename(path)}`);
  writeFileSync(backup, readFileSync(path), { flag: "wx" });
  const temporary = join(dirname(path), `.docsync-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    chmodSync(temporary, statSync(path).mode & 0o777);
    check();
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return backup;
}
