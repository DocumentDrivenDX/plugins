// The docsync command line. It works on files only and never uses the network.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json";
import {
  bodySha, committedBodySha, entryFor, findBase, git, loadBindings, locate, mark, read, saveBinding, sha256, status,
  type Binding,
} from "./binding.ts";
import { Doc, docOps, editsFromRead } from "./claude-docs.ts";
import { applyText, parse, prepare, refuseCrlf, Refused, splitFrontMatter } from "./markdown.ts";
import { bindWord, create, importDocx, locateWord, pullWord, pushWord, statusWord, type Options } from "./docx/cli.ts";
import { Conflicted, merge3 } from "./merge.ts";
import { parseXml, XmlError } from "./xml.ts";

const USAGE = `usage:
  docsync prepare FILE                      print the Markdown to create the doc from
  docsync blocks FILE                       list the file's blocks
  docsync bind FILE --origin URL --synced-rev N [--record git|doc] [--connector NAME]
  docsync status FILE
  docsync edits FILE --old OLD.xml --delta DELTA.xml [--from-binding | --base-commit REV]
  docsync apply FILE --edits EDITS.json [--from-binding | --base-commit REV]
                [--prefer git|doc] [--guard PROGRAM] [--write]
  docsync doc-ops FILE --old OLD.xml --now NOW.xml [--from-binding | --base-commit REV]
                [--prefer git|doc]
  docsync rebind FILE --synced-rev N --old OLD.xml
  docsync version

for a Word file:
  docsync import DOCX                       print Markdown read from a .docx
  docsync create FILE --word OUT.docx       write a first .docx; never overwrites
  docsync bind FILE --word DOCX [--name NAME] [--record git|doc]
  docsync locate FILE --word DOCX           say where this machine's copy is
  docsync status FILE
  docsync pull FILE [--prefer git|doc] [--guard PROGRAM] [--write] [--accept-loss]
  docsync push FILE [--prefer git|doc] [--write] [--accept-loss]`;

class Usage extends Error {}

const options = {
  old: { type: "string" },
  delta: { type: "string" },
  now: { type: "string" },
  edits: { type: "string" },
  origin: { type: "string" },
  connector: { type: "string" },
  record: { type: "string" },
  word: { type: "string" },
  name: { type: "string" },
  prefer: { type: "string" },
  guard: { type: "string" },
  "synced-rev": { type: "string" },
  "base-commit": { type: "string" },
  "from-binding": { type: "boolean" },
  write: { type: "boolean" },
  "accept-loss": { type: "boolean" },
} as const;

/**
 * A check a project supplies: a program given one file, exiting 0 for pass and 1
 * for fail. It is refused when the file passes before an edit and fails after it.
 * It is only ever named on the command line, never read from the repository.
 */
function passes(program: string, file: string, text: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "docsync-guard-"));
  try {
    // A copy outside the repository, under the file's own name.
    const probe = join(dir, basename(file));
    writeFileSync(probe, text);
    const r = Bun.spawnSync([program, probe], { stdin: "ignore" });
    if (r.exitCode === 0 || r.exitCode === 1) return r.exitCode === 0;
    throw new Refused(`the guard could not run (exit ${r.exitCode}): ${r.stderr.toString().trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** git renders the diff, from two copies outside the repository. */
function showDiff(current: string, result: string): void {
  if (result === current) return;
  const dir = mkdtempSync(join(tmpdir(), "docsync-diff-"));
  try {
    writeFileSync(join(dir, "current"), current);
    writeFileSync(join(dir, "patched"), result);
    const diff = Bun.spawnSync(["git", "diff", "--no-index", "--no-color", "--no-ext-diff", "--", "current", "patched"], { cwd: dir });
    process.stdout.write(diff.stdout.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A binding the Claude Docs commands may use. */
function docEntry(root: string, path: string): Binding {
  const entry = entryFor(root, path);
  if (entry.tool === "word") throw new Refused(`${path} is bound to a Word file; use pull and push`);
  return entry;
}

function isWordBound(file: string): boolean {
  const { root, path } = locate(file);
  return loadBindings(root).some((e) => e.path === path && e.tool === "word");
}

export function main(argv: string[], cwd = process.cwd()): number {
  const { values, positionals } = (() => {
    try {
      return parseArgs({ args: argv, options, allowPositionals: true });
    } catch (e) {
      throw new Usage((e as Error).message);
    }
  })();
  const [command, name] = positionals;
  if (command === "version") {
    console.log(pkg.version);
    return 0;
  }
  if (!command || !name || positionals.length > 2) throw new Usage("name a command and a file");
  const at = (path: string) => resolve(cwd, path);
  const need = (key: keyof typeof options): string => {
    const v = values[key];
    if (typeof v !== "string") throw new Usage(`${command} needs --${key}`);
    return v;
  };
  const side = (key: "record" | "prefer"): "git" | "doc" | undefined => {
    const v = values[key];
    if (v !== undefined && v !== "git" && v !== "doc") throw new Usage(`--${key} is git or doc`);
    return v;
  };
  const file = at(name);
  const guard = (before: string, after: string) => {
    if (!values.guard) return;
    const program = values.guard.includes("/") ? at(values.guard) : values.guard;
    if (passes(program, file, before) && !passes(program, file, after))
      throw new Refused(`the guard ${basename(program)} passes on the file and fails on the edited file`);
  };
  if (command === "import") return importDocx(file);
  if (command === "create") return create(file, at(need("word")));
  const word = (): Options => ({
    ...(values.word === undefined ? {} : { word: at(values.word) }),
    name: values.name, record: side("record"), prefer: side("prefer"), write: values.write, acceptLoss: values["accept-loss"], guard, diff: showDiff,
  });
  if (command === "bind" && values.word !== undefined) return bindWord(file, word());
  if (command === "locate") return locateWord(file, at(need("word")));
  if (command === "pull") return pullWord(file, word());
  if (command === "push") return pushWord(file, word());
  if (command === "status" && isWordBound(file)) return statusWord(file);

  const current = read(file);
  refuseCrlf(current);
  const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

  const binding = (): Binding => {
    const { root, path } = locate(file);
    return docEntry(root, path);
  };
  /** The file as it was when the doc last matched it. */
  const baseText = (): string => {
    if (values["from-binding"]) {
      const { root, path } = locate(file);
      return findBase(root, path, docEntry(root, path).baseSha256);
    }
    const commit = values["base-commit"];
    if (!commit) return current;
    if (commit.startsWith("-")) throw new Refused("--base-commit must be a commit, not an option");
    const { root, path } = locate(file);
    return git(root, "show", `${commit}:${path}`);
  };
  const record = () => side("prefer") ?? (values["from-binding"] ? binding().record : undefined);

  switch (command) {
    case "prepare":
      process.stdout.write(prepare(current));
      return 0;
    case "blocks": {
      const { lines, blocks } = parse(splitFrontMatter(current)[1]);
      blocks.forEach((b, n) => console.log(`${n}\t${b.kind}\t${lines[b.start]!.slice(0, 70)}`));
      return 0;
    }
    case "status":
      print(status(file));
      return 0;
    case "bind": {
      const { root, path } = locate(file);
      if (committedBodySha(root, path) !== bodySha(current))
        throw new Refused("the file's body differs from the committed one; commit it first so the base is in history");
      if (loadBindings(root).some((e) => e.path === path && e.tool === "word"))
        throw new Refused(`${path} is bound to a Word file; a file has one binding. Remove that entry first`);
      const connector = values.connector;
      const entry: Binding = {
        path, tool: "claude-docs", origin: need("origin"), ...(connector ? { connector } : {}),
        syncedRev: need("synced-rev"), baseSha256: bodySha(current), record: side("record") ?? "git",
      };
      mark(root, path);
      saveBinding(root, entry);
      console.log(`bound ${path} to the doc at revision ${entry.syncedRev}`);
      return 0;
    }
    case "rebind": {
      const { root, path } = locate(file);
      const entry = docEntry(root, path);
      if (committedBodySha(root, path) !== bodySha(current))
        throw new Refused("the file's body differs from the committed one; commit it first");
      const xml = read(at(need("old")));
      const rev = need("synced-rev");
      if (parseXml(xml).attrs.rev !== rev)
        throw new Refused(`--synced-rev ${rev} is not the revision of the doc read in ${values.old}`);
      // Refuses unless the doc at that revision equals the file.
      new Doc(xml, parse(splitFrontMatter(current)[1]));
      saveBinding(root, { ...entry, syncedRev: rev, baseSha256: bodySha(current) });
      console.log(`rebound ${path} to revision ${rev}`);
      return 0;
    }
    case "edits":
      print(editsFromRead(read(at(need("old"))), read(at(need("delta"))), baseText()));
      return 0;
    case "doc-ops":
      print(docOps(
        baseText(), current, read(at(need("old"))), read(at(need("now"))),
        side("prefer") ?? (values["from-binding"] ? binding().record : "git"),
      ));
      return 0;
    case "apply": {
      const parsed = JSON.parse(read(at(need("edits"))));
      const base = baseText();
      let result = applyText(base, parsed?.ops);
      if (base !== current) {
        const winner = record();
        try {
          const merged = merge3(base, current, result, winner && (winner === "git" ? "ours" : "theirs"));
          result = merged.text;
          for (const c of merged.conflicts)
            console.error(`conflict resolved for ${winner}: git '${c.ours}' / doc '${c.theirs}'`);
        } catch (e) {
          if (!(e instanceof Conflicted)) throw e;
          const shown = e.conflicts.slice(0, 3).map((c) => `git: '${c.ours}' / doc: '${c.theirs}'`).join("; ");
          throw new Refused(
            `the file changed since the base and ${e.conflicts.length} change(s) conflict (${shown}); ` +
              "pass --prefer git or --prefer doc, or ask which text wins",
          );
        }
      }
      guard(current, result);
      showDiff(current, result);
      console.log(`sha256 before ${sha256(current)}\nsha256 after  ${sha256(result)}`);
      console.log(`file hash ${result === current ? "unchanged" : "changed"}`);
      if (values.write && result !== current) {
        writeFileSync(file, result);
        console.log(`wrote ${file}`);
      }
      return 0;
    }
    default:
      throw new Usage(`unknown command ${command}`);
  }
}

if (import.meta.main) {
  try {
    // The launcher runs from the plugin's directory and passes the caller's.
    process.exitCode = main(process.argv.slice(2), process.env.DOCSYNC_CWD || process.cwd());
  } catch (e) {
    if (e instanceof Refused) {
      console.error(`refused: ${e.message}`);
      process.exitCode = 1;
    } else {
      const kind = e instanceof Usage ? "usage" : e instanceof XmlError ? "bad XML" : "error";
      console.error(`${kind}: ${(e as Error).message}`);
      if (e instanceof Usage) console.error(USAGE);
      process.exitCode = 2;
    }
  }
}
