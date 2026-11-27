// Which doc a file is bound to: one entry in .docsync.json and a `docsync` git attribute.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { Refused, splitFrontMatter } from "./markdown.ts";

export const BINDINGS = ".docsync.json";

export interface Binding {
  path: string;
  tool: string;
  origin: string;
  connector?: string;
  /** A doc revision whose text equals the file body with this digest. */
  syncedRev: string;
  baseSha256: string;
  /** Which side wins a conflict. */
  record: "git" | "doc";
}

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const bodySha = (text: string) => sha256(splitFrontMatter(text)[1]);

/** The file's text. Bytes that are not UTF-8 are refused, and a byte-order mark is kept. */
export function read(path: string): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
}

export function tryGit(dir: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(["git", "-C", dir, ...args]);
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
}

export function git(dir: string, ...args: string[]): string {
  const r = tryGit(dir, ...args);
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.err.trim()}`);
  return r.out;
}

/** The repository holding `file`, and the file's path in it with `/` separators. */
export function locate(file: string): { root: string; path: string } {
  const real = realpathSync(file);
  const root = realpathSync(git(dirname(real), "rev-parse", "--show-toplevel").replace(/\n$/, ""));
  return { root, path: relative(root, real).split(sep).join("/") };
}

export function loadBindings(root: string): Binding[] {
  const file = join(root, BINDINGS);
  if (!existsSync(file)) return [];
  let data: { version?: unknown; bindings?: unknown };
  try {
    data = JSON.parse(read(file));
  } catch (e) {
    throw new Refused(`${BINDINGS} is not valid JSON: ${(e as Error).message}`);
  }
  const text = ["path", "tool", "origin", "syncedRev", "baseSha256"] as const;
  if (
    data?.version !== 1 ||
    !Array.isArray(data.bindings) ||
    !data.bindings.every(
      (e) => e && text.every((k) => typeof e[k] === "string") && (e.record === "git" || e.record === "doc"),
    )
  )
    throw new Refused(`${BINDINGS} must hold version 1 and a list of complete \`bindings\``);
  return data.bindings as Binding[];
}

export function saveBinding(root: string, entry: Binding): void {
  const bindings = [...loadBindings(root).filter((e) => e.path !== entry.path), entry].sort((a, b) =>
    a.path < b.path ? -1 : 1,
  );
  writeFileSync(join(root, BINDINGS), JSON.stringify({ version: 1, bindings }, null, 2) + "\n");
}

export function entryFor(root: string, path: string): Binding {
  const found = loadBindings(root).find((e) => e.path === path);
  if (!found) throw new Refused(`${path} has no entry in ${BINDINGS}`);
  return found;
}

export function marked(root: string, path: string): boolean {
  const value = git(root, "check-attr", "-z", "docsync", "--", path).split("\0")[2];
  return value !== "unspecified" && value !== "unset";
}

/** Add the .gitattributes line that marks exactly `path`. */
export function mark(root: string, path: string): void {
  if (marked(root, path)) return;
  let pattern = "/" + path.replace(/[\\[\]*?#!]/g, "\\$&");
  if (/[\s"]/.test(pattern)) pattern = `"${pattern.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const file = join(root, ".gitattributes");
  const before = existsSync(file) ? read(file) : "";
  writeFileSync(file, before + (!before || before.endsWith("\n") ? "" : "\n") + `${pattern} docsync\n`);
  if (!marked(root, path)) {
    writeFileSync(file, before);
    throw new Refused(`could not write a .gitattributes line that marks ${path}; add one by hand`);
  }
}

export function committedBodySha(root: string, path: string): string | undefined {
  const r = tryGit(root, "show", `HEAD:${path}`);
  return r.ok ? bodySha(r.out) : undefined;
}

/** The newest committed version of the file whose body has this digest. */
export function findBase(root: string, path: string, digest: string): string {
  const commits = git(root, "log", "--follow", "--name-only", "--format=%x00%H", "--", path).split("\0");
  for (const entry of commits) {
    const [commit, ...names] = entry.split("\n").filter(Boolean);
    if (!commit || !names[0]) continue;
    const r = tryGit(root, "show", `${commit}:${names[0]}`);
    if (r.ok && bodySha(r.out) === digest) return r.out;
  }
  throw new Refused(`no version of ${path} in git history has the body ${digest.slice(0, 12)}; bind it again`);
}

export function status(file: string): Record<string, unknown> {
  const { root, path } = locate(file);
  const entry = loadBindings(root).find((e) => e.path === path);
  const attribute = marked(root, path);
  if (!entry || !attribute) return { path, bound: false, attribute };
  return { ...entry, bound: true, attribute, fileChangedSinceBase: bodySha(read(file)) !== entry.baseSha256 };
}
