// Pull and push: what each does is worked out in full before anything is written.
import { markerSpans } from "../markers.ts";
import { Refused } from "../markdown.ts";
import { Conflicted, merge3, type Side } from "../merge.ts";
import { parseInline, visible } from "./inline.ts";
import { deleteUnit, editUnit, insertUnit, type PartEdit, patched } from "./patch.ts";
import { READER, readWord, type Unit, type Word } from "./read.ts";
import type { Snapshot } from "./state.ts";
import { align, bare, broughtBack, carry, differences, entangled, hidden, mdUnits, places, sameContent, shape, stillReads, wordsOf } from "./units.ts";
import { splice } from "./xml.ts";

/** The units the base's Markdown says: the base of both sides. */
export const baseUnits = (snapshot: Snapshot): Unit[] => mdUnits(snapshot.markdown).map(bare);

/** Where each footnote is cited: the words before its reference, and its whole block. */
function citedAt(units: Unit[]): Map<string, { before: string; block: string }> {
  const out = new Map<string, { before: string; block: string }>();
  for (const u of units) {
    if (u.kind === "footnote") continue;
    const atoms = parseInline(u.cells?.join(" ") ?? u.text);
    const block = atoms.map((a) => a.c).join("");
    let before = "";
    for (const atom of atoms)
      if (atom.fn === undefined) before += atom.c;
      else out.set(atom.fn, { before, block });
  }
  return out;
}

const knownNotes = (units: Unit[], ids: Record<string, string>) => {
  const cited = citedAt(units);
  return units
    .filter((u) => u.kind === "footnote")
    .map((u) => ({ label: u.label!, text: u.text, noteId: ids[u.label!] ?? u.noteId, ...cited.get(u.label!) }));
};

/** The labels the base knows its footnotes by. */
export const known = (snapshot: Snapshot) => knownNotes(baseUnits(snapshot), snapshot.noteIds);

const noteIds = (units: Unit[]) =>
  Object.fromEntries(units.flatMap((u) => (u.kind === "footnote" && u.noteId !== undefined ? [[u.label!, u.noteId]] : [])));

/** Reads a .docx for a first binding, labelling its footnotes as the Markdown does. */
export function bindSnapshot(body: string, bytes: Uint8Array, sha: string): { snapshot: Snapshot; word: Word } {
  const md = mdUnits(body);
  const labels = md.filter((u) => u.kind === "footnote").map((u) => ({ label: u.label!, text: u.text }));
  const word = readWord(bytes, labels);
  const found = differences(md, word.units);
  if (found.length)
    throw new Refused(`the Word file and the Markdown file do not say the same thing:\n  ${found.slice(0, 20).join("\n  ")}` +
      (found.length > 20 ? `\n  and ${found.length - 20} more` : ""));
  return { snapshot: { version: 1, reader: READER, markdown: body, noteIds: noteIds(word.units), docxSha256: sha }, word };
}

const markersOf = (md: string): string[] => markerSpans(md).map(([a, b]) => md.slice(a, b));

/** Every citation, footnote reference and attribute list that an edit takes away or brings. */
export function markerChanges(before: string, after: string): string[] {
  const count = new Map<string, number>();
  for (const m of markersOf(before)) count.set(m, (count.get(m) ?? 0) - 1);
  for (const m of markersOf(after)) count.set(m, (count.get(m) ?? 0) + 1);
  const report = [...count].flatMap(([m, n]) =>
    n ? [`marker ${n < 0 ? "removed or changed" : "added or changed"}: ${m}${Math.abs(n) > 1 ? ` (×${Math.abs(n)})` : ""}`] : []);
  // A marker can keep its count and still move to another block.
  const [a, b] = [mdUnits(before), mdUnits(after)];
  const where = (units: Unit[]) =>
    new Map(units.flatMap((u, k) => markersOf(u.cells?.join(" ") ?? u.text).map((m) => [m, k] as const)));
  const paired = align(a, b).mapping;
  const now = where(b);
  for (const [m, k] of where(a))
    if (!count.get(m) && now.has(m) && paired.has(k) && paired.get(k) !== now.get(m)) report.push(`marker moved to another block: ${m}`);
  // Brackets or braces that were a marker and no longer parse leave a stray citation key.
  for (const u of b) {
    let rest = u.cells?.join(" ") ?? u.text;
    for (const [x, y] of markerSpans(rest).reverse()) rest = rest.slice(0, x) + rest.slice(y);
    if (/\[[^\]]*@[\p{L}\p{N}]|\{\s*[.#][A-Za-z]/u.test(rest)) report.push(`a marker no longer reads as one in: "${wordsOf(u).slice(0, 60)}"`);
  }
  return report;
}

/**
 * Why `word` looks like a copy that an editor saved without its structure, or
 * undefined. Writing from such a copy would strip the Markdown file, and writing
 * into it would sync with a damaged document.
 */
export function lostStructure(base: Unit[], word: Unit[]): string | undefined {
  const notes = (list: Unit[]) => list.filter((u) => u.kind === "footnote").length;
  const [before, after] = [notes(base), notes(word)];
  if (before && !after) return `the base has ${before} footnote(s) and the Word file has none`;
  if (before >= 4 && after * 2 < before) return `${before - after} of ${before} footnotes are gone from the Word file`;
  if (base.some((u) => u.kind === "row") && !word.some((u) => u.kind === "row"))
    return "the base has a table and the Word file has none";
  const structured = base.flatMap((u, i) => (u.kind === "heading" || u.kind === "quote" || u.kind === "item" ? [i] : []));
  const { mapping } = align(base, word);
  const flattened = structured.filter((i) => mapping.has(i) && word[mapping.get(i)!]!.kind === "paragraph").length;
  if (flattened >= 3 && flattened * 2 >= structured.length)
    return `${flattened} of ${structured.length} headings, quotes and list items are now plain paragraphs`;
  return undefined;
}

export interface Pulled {
  /** Set when the Word file looks to have lost its structure. */
  lost?: string;
  /** The new body of the Markdown file. */
  body: string;
  snapshot: Snapshot;
  report: string[];
}

export function pull(snapshot: Snapshot, body: string, bytes: Uint8Array, sha: string, prefer: Side): Pulled {
  const word = readWord(bytes, known(snapshot));
  const old = baseUnits(snapshot);
  const unread = word.unread;
  // The base takes Word's changes alone; the file takes them beside its own.
  let base = carry(snapshot.markdown, old, word.units, { unread });
  let file = body === snapshot.markdown ? base : carry(body, old, word.units, { unread, prefer, skip: base.left });
  // What the file could not take keeps its old base, and what the base then
  // holds back is held back in the file too. Each set only grows, so this ends.
  // The reasons are those of the first attempt; later ones only say "left".
  const first = [...base.report, ...file.report];
  if (body === snapshot.markdown) file = base;
  else
    for (;;) {
      const refused = new Set([...base.left, ...file.left]);
      if (refused.size === base.left.size && refused.size === file.left.size) break;
      base = carry(snapshot.markdown, old, word.units, { unread, skip: refused });
      file = carry(body, old, word.units, { unread, prefer, skip: refused });
    }
  const report = [...new Set([...word.notes, ...first, ...base.report, ...file.report])];
  const changed = align(old, word.units);
  const inFile = align(old, mdUnits(body), false).mapping;
  const applied = [...changed.mapping.keys()].map(String).concat(changed.added.map((j) => `+${j}`)).filter((k) => !file.left.has(k));
  report.push(...broughtBack(old, word.units, changed, applied, old.filter((u, i) => !inFile.has(i)), "the file"));
  report.push(...markerChanges(body, file.markdown));
  const lost = lostStructure(old, word.units);
  return {
    ...(lost ? { lost } : {}),
    body: file.markdown,
    snapshot: {
      ...snapshot, markdown: base.markdown,
      noteIds: { ...snapshot.noteIds, ...noteIds(word.units) }, docxSha256: sha,
    },
    report,
  };
}

export interface Pushed {
  /** Set when the Word file looks to have lost its structure. */
  lost?: string;
  /** The new .docx, or undefined when it needs no change. */
  docx?: Buffer;
  snapshot: Snapshot;
  /** Each change to the Word file's words. */
  changes: string[];
  report: string[];
}

export function push(snapshot: Snapshot, body: string, bytes: Uint8Array, prefer: Side): Pushed {
  // As in `carry`: what is entangled with a refused change is held back too.
  const held = new Set<string>();
  const base = baseUnits(snapshot);
  const file = mdUnits(body);
  const found = align(base, file);
  for (;;) {
    const { refused, finish } = plan(snapshot, body, bytes, prefer, held);
    const more = [...entangled(base, file, found, refused)].filter((key) => !held.has(key));
    if (!more.length) return finish();
    for (const key of more) held.add(key);
  }
}

function plan(snapshot: Snapshot, body: string, bytes: Uint8Array, prefer: Side, held: Set<string>) {
  const word = readWord(bytes, known(snapshot));
  const old = baseUnits(snapshot);
  const file = mdUnits(body);
  const report = [...word.notes];
  const changes: string[] = [];
  const skip = new Set<string>();
  let partial = false;
  const change = align(old, file);
  const { mapping, moved } = change;
  // Which Word block each base block is decides what gets overwritten.
  const inWord = align(old, word.units, false).mapping;
  let edits: PartEdit[] = [];
  /** What the patched file must read as: each unit of `word`, with what follows it. */
  const result = word.units.map((u) => ({ unit: u as Unit | undefined, after: [] as Unit[] }));
  const winner = prefer === "ours" ? "git" : "doc";
  const show = (u: Unit) => `"${wordsOf(u).slice(0, 60)}"`;
  const leave = (why: string, ...keys: string[]) => {
    partial = true;
    for (const key of keys) skip.add(key);
    report.push(why);
  };

  for (const i of moved) leave(`${show(old[i]!)} was moved in the file; move it in Word`);

  for (const [i, j] of mapping) {
    const [was, now] = [old[i]!, file[j]!];
    if (shape(was) !== shape(now)) leave(`${show(now)} is now a ${shape(now)} in the file; change that in Word`);
    if (sameContent(was, now)) continue;
    if (held.has(`${i}`)) {
      leave(`${show(was)} is held back: its words go with a change that could not be made; do both in Word`, `${i}`);
      continue;
    }
    const d = inWord.get(i);
    if (d === undefined) {
      leave(`${show(was)} changed in the file, but no block in the Word file is clearly it; make this change in Word`, `${i}`);
      continue;
    }
    const there = word.units[d]!;
    if (sameContent(there, now)) continue;
    try {
      // A citation made of both sides' words could name a page neither side meant.
      if (was.kind === "footnote" && !sameContent(there, was))
        throw new Refused(`the footnote changed on both sides; Word has "${wordsOf(there)}"`);
      const conflicts: string[] = [];
      const join = (a: string, ours: string, theirs: string) => {
        const merged = merge3(a, ours, theirs, prefer);
        for (const c of merged.conflicts) conflicts.push(`conflict resolved for ${winner}: git '${c.ours}' / Word '${c.theirs}'`);
        return merged.text;
      };
      let goal: Unit;
      if (was.cells) {
        if (!now.cells || !there.cells || was.cells.length !== now.cells.length || there.cells.length !== now.cells.length)
          throw new Refused("the number of cells changed");
        goal = { ...there, cells: was.cells.map((c, k) => join(c, now.cells![k]!, there.cells![k]!)) };
      } else goal = { ...there, text: join(was.text, now.text, there.text) };
      if (conflicts.length && !stillReads(was, there)) throw new Refused("the paragraph was rewritten in Word");
      if (!sameContent(there, goal)) {
        if (now.held) throw new Refused(`the file's block holds ${now.held}`);
        edits.push(...editUnit(word.places[d]!, there, goal).map((e) => ({ ...e, part: word.places[d]!.part })));
        result[d]!.unit = goal;
        changes.push(`change ${show(there)} to ${show(goal)}`);
      }
      report.push(...conflicts);
    } catch (e) {
      if (!(e instanceof Refused) && !(e instanceof Conflicted)) throw e;
      leave(`${show(was)}: ${e.message}; make this change in Word`, `${i}`);
    }
  }

  // Blocks made in Word since the base, which a new file block may already match.
  const paired = new Set(inWord.values());
  const born = new Set(word.units.flatMap((_, d) => (paired.has(d) ? [] : [d])));
  const back = new Map([...mapping].map(([i, j]) => [j, i]));
  /** The Word unit each file block is, or follows. */
  const placed = new Map<number, number>();
  for (const [i, j] of mapping) {
    const d = inWord.get(i);
    if (d !== undefined && !moved.has(i)) placed.set(j, d);
  }

  // What leaves one place and what arrives there are written together or not at all.
  for (const place of places(old, file, change)) {
    const here: PartEdit[] = [];
    const planned: (() => void)[] = [];
    const used: number[] = [];
    const added: [number, number][] = [];
    const done: string[] = [];
    let failure: string | undefined;
    try {
      if (place.removed.some((i) => held.has(`${i}`)) || place.added.some((j) => held.has(`+${j}`)))
        throw new Refused("their words go with a change that could not be made");
      for (const j of place.added) {
        const now = file[j]!;
        const already = [...born].find((d) =>
          !used.includes(d) && shape(word.units[d]!) === shape(now) && word.units[d]!.label === now.label && sameContent(word.units[d]!, now));
        if (already !== undefined) {
          used.push(already);
          placed.set(j, already);
          added.push([j, already]);
          continue;
        }
        if (now.kind === "footnote") throw new Refused("a new footnote is added in Word");
        if (now.held) throw new Refused(`the file's block holds ${now.held}`);
        let anchor: number | undefined;
        for (let k = j - 1; k >= 0 && anchor === undefined; k--) {
          if (file[k]!.kind === "footnote") continue;
          anchor = placed.get(k);
          if (anchor === undefined && !back.has(k)) break;
        }
        if (anchor === undefined) throw new Refused("nothing before it is in the Word file");
        // Rows join only the table their own rows are in.
        if (now.kind === "row" && !(file[j - 1]?.kind === "row" && file[j - 1]!.table === now.table))
          throw new Refused("a new table is added in Word");
        here.push({ ...insertUnit(word, anchor, now), part: "word/document.xml" });
        const at = anchor;
        // A new row is in the Word table of the row it follows.
        const written = now.kind === "row" ? { ...now, table: word.units[at]!.table } : now;
        planned.push(() => result[at]!.after.push(written));
        placed.set(j, anchor);
        added.push([j, anchor]);
        done.push(`add ${show(now)}`);
      }
      for (const i of place.removed) {
        const d = inWord.get(i);
        if (d === undefined) {
          if (hidden(old[i]!, word.unread)) throw new Refused("it may still be in the Word file, in content docsync cannot read");
          continue;
        }
        const there = word.units[d]!;
        // A co-author's edit is never deleted, whichever side wins conflicts.
        if (!sameContent(there, old[i]!)) throw new Refused(`it was edited in Word, to "${wordsOf(there)}", and that text stays`);
        here.push({ ...deleteUnit(word.places[d]!, there, word.parts.get(word.places[d]!.part)!.text), part: word.places[d]!.part });
        planned.push(() => (result[d]!.unit = undefined));
        done.push(`delete ${show(there)}`);
      }
      if (joinedTables(word, [...edits, ...here]) > joinedTables(word, edits)) throw new Refused("it would join two tables");
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      failure = e.message;
    }
    if (failure !== undefined) {
      for (const [j] of added) placed.delete(j);
      const what = [...place.removed.map((i) => `removal of ${show(old[i]!)}`), ...place.added.map((j) => `new ${show(file[j]!)}`)];
      leave(`${what.join(", ")}: ${failure}; do this in Word`, ...place.removed.map(String), ...place.added.map((j) => `+${j}`));
      continue;
    }
    for (const d of used) born.delete(d);
    edits = [...edits, ...here];
    for (const apply of planned) apply();
    changes.push(...done);
  }

  const finish = (): Pushed => {
  const applied = [...mapping.keys()].map(String).concat(change.added.map((j) => `+${j}`)).filter((k) => !skip.has(k));
  report.push(...broughtBack(old, file, change, applied, old.filter((u, i) => !inWord.has(i)), "Word's side"));
  const lost = lostStructure(old, word.units);
  // The base moves toward the file for what was carried, and only for that.
  let markdown = body;
  if (partial) {
    const carried = carry(snapshot.markdown, old, file.map(bare), { skip });
    markdown = carried.markdown;
  }
  const next: Snapshot = { ...snapshot, markdown, noteIds: { ...snapshot.noteIds, ...noteIds(word.units) } };
  const out = { ...(lost ? { lost } : {}), snapshot: next, changes, report };
  if (!edits.length) return out;
  const docx = patched(word, edits);
  verify(docx, result.flatMap((r) => [...(r.unit ? [r.unit] : []), ...r.after]));
  return { ...out, docx };
  };
  return { refused: skip, finish };
}

/** How many places in the body would have one table directly after another. */
function joinedTables(word: Word, edits: PartEdit[]): number {
  const main = "word/document.xml";
  const xml = splice(word.parts.get(main)!.text, edits.filter((e) => e.part === main));
  return xml.match(/<\/w:tbl>\s*<w:tbl[ >]/g)?.length ?? 0;
}

/** Reads the result back: the changed blocks must read as intended and the rest as before. */
function verify(docx: Buffer, expected: Unit[]): void {
  const got = readWord(docx, knownNotes(expected, {})).units;
  const text = (list: Unit[]) => list.filter((u) => u.kind !== "footnote");
  const notes = (list: Unit[]) => JSON.stringify(list.filter((u) => u.kind === "footnote").map((u) => [u.label, visible(u.text)]).sort());
  const tables = (list: Unit[]) =>
    list.filter((u) => u.cells).map((u, k, rows) => (k && rows[k - 1]!.table === u.table ? "+" : "|")).join("");
  const [a, b] = [text(expected), text(got)];
  const matches = a.length === b.length && a.every((u, k) => sameContent(u, b[k]!) && Boolean(u.cells) === Boolean(b[k]!.cells)) &&
    notes(expected) === notes(got);
  if (!matches || tables(got) !== tables(expected))
    throw new Refused("the patched Word file did not read back as intended, so nothing was written; this is a docsync defect");
}
