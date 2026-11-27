// Markdown blocks as units, how two lists of units line up, and how the changes
// between them are carried into a Markdown body.
//
// Two rules keep text from being lost. A block is only taken to be another when
// their words say so. And what is removed and added in one place is carried
// together or not at all, so that a rewrite never turns into a bare removal.
import { likeness } from "../align.ts";
import { opcodes, ratio } from "../difflib.ts";
import { applyOps, type Block, blockSource, type Op, parse, Refused, splitCells, words } from "../markdown.ts";
import { Conflicted, merge3, type Side } from "../merge.ts";
import { parseInline, same, visible } from "./inline.ts";
import type { Unit, UnitKind } from "./read.ts";

export interface MdUnit extends Unit {
  /** The block's number in the Markdown body. */
  block: number;
  /** Why docsync must not rewrite this block. */
  held?: string;
}

const SEPARATOR = /^\s*\|?[\s:|-]*-[\s:|-]*$/;
const NOTE = /^\[\^([^\]\s]+)\]:\s*/;
export const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;
const HARD_BREAK = /(?:\\| {2,})\n/;
const unwrap = (source: string) =>
  words(source.replace(new RegExp(HARD_BREAK, "g"), " \n").replace(COMMENT, " ")).join(" ");

/** Raw HTML and hard breaks do not survive a rewrite of their words. */
function heldBy(source: string): string | undefined {
  if (source.includes("<!--")) return "an HTML comment";
  if (/<[A-Za-z/!?]/.test(source.replace(/\\</g, ""))) return "HTML or a bracketed address";
  if (HARD_BREAK.test(source)) return "a hard line break";
  return undefined;
}

export function mdUnits(body: string): MdUnit[] {
  const { lines, blocks } = parse(body);
  const out: MdUnit[] = [];
  let table = -1;
  let previous: Block | undefined;
  blocks.forEach((b, block) => {
    if (b.kind === "row") {
      // Rows of one table touch, or have only its separator line between them.
      const joined = previous?.kind === "row" &&
        (b.start === previous.end || (b.start - previous.end === 1 && SEPARATOR.test(lines[previous.end]!)));
      if (!joined) table++;
      const source = lines[b.start]!;
      const cells = splitCells(source).cells.map((c) => unwrap(c.replaceAll("\\|", "|")));
      const held = heldBy(source);
      out.push({ block, kind: "row", text: "", cells, table, ...(held ? { held } : {}) });
    } else if (b.kind !== "other") {
      const source = blockSource(lines, b);
      const text = unwrap(source);
      const reason = heldBy(source);
      const held = reason ? { held: reason } : {};
      const note = b.kind === "paragraph" ? NOTE.exec(text) : null;
      // A block that is only a comment says nothing.
      if (!text) return;
      if (note) out.push({ block, kind: "footnote", label: note[1]!, text: text.slice(note[0].length), ...held });
      else if (b.kind === "heading")
        out.push({ block, kind: "heading", level: b.prefix.trim().length, text: text.replace(/\s+#+$/, ""), ...held });
      else if (b.kind === "item") {
        const indent = /^\s*/.exec(b.prefix)![0].replaceAll("\t", "    ").length;
        out.push({ block, kind: "item", level: Math.floor(indent / 2), ordered: /^\s*\d/.test(b.prefix), text, ...held });
      } else out.push({ block, kind: b.kind as UnitKind, text, ...held });
    }
    previous = b;
  });
  return out;
}

export const bare = ({ block: _, held: __, ...unit }: Unit & { block?: number; held?: string }): Unit => unit;

export const sameContent = (a: Unit, b: Unit) =>
  a.cells || b.cells
    ? a.cells !== undefined && b.cells !== undefined && a.cells.length === b.cells.length &&
      a.cells.every((c, k) => same(c, b.cells![k]!))
    : same(a.text, b.text);

/** The shape of a block as docsync compares it. A list's depth is not counted: the two sides state it differently. */
export const shape = (u: Unit) =>
  u.kind + (u.kind === "heading" ? ` ${u.level}` : u.kind === "item" ? ` ${u.ordered ? "numbered" : "bulleted"}` : "");

export const wordsOf = (u: Unit) => (u.cells ? u.cells.map(visible).join(" | ") : visible(u.text));

export interface Alignment {
  /** Index in `from` to index in `to`. */
  mapping: Map<number, number>;
  added: number[];
  removed: number[];
  /** Indexes in `from` of paired blocks that are in another order. */
  moved: Set<number>;
}

/** How much two blocks' words say they are one block, from 0 to 1. */
function kinship(a: Unit, b: Unit): number {
  const [x, y] = [wordsOf(a), wordsOf(b)];
  const shared = ratio(x.toLowerCase().split(" "), y.toLowerCase().split(" "));
  if (shared >= 0.4) return shared;
  // A short block with one word changed shares few words and most letters.
  const letters = likeness(x, y);
  return letters >= 0.75 ? letters / 2 : 0;
}

/**
 * True when `now` still has most of the words of `was`. Only then may a conflict
 * between the two sides be settled for one of them: a paragraph replaced by
 * another is not an edit of it, and settling would rewrite someone's new text.
 */
export function stillReads(was: Unit, now: Unit): boolean {
  const [a, b] = [wordsOf(was).toLowerCase().split(" "), wordsOf(now).toLowerCase().split(" ")];
  return ratio(a, b) > 0.5 || likeness(a.join(" "), b.join(" ")) >= 0.85;
}

/** The pairs, in `from` order, that keep their order: a longest rising run. */
function inOrder(pairs: [number, number][]): Set<number> {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const length = sorted.map(() => 1);
  const before = sorted.map(() => -1);
  let best = -1;
  sorted.forEach(([, to], k) => {
    for (let n = 0; n < k; n++)
      if (sorted[n]![1] < to && length[n]! + 1 > length[k]!) [length[k], before[k]] = [length[n]! + 1, n];
    if (best < 0 || length[k]! > length[best]!) best = k;
  });
  const kept = new Set<number>();
  for (let k = best; k >= 0; k = before[k]!) kept.add(sorted[k]![0]);
  return kept;
}

/**
 * Footnotes pair by label. Other blocks pair when equal, wherever they went, and
 * then when their words are close. With `rewrites`, one block that alone stands
 * where one other block stood is also paired, though its words are all new; leave
 * it off where the pairing decides which block gets overwritten.
 */
export function align(from: Unit[], to: Unit[], rewrites = true): Alignment {
  const body = (list: Unit[]) => list.flatMap((u, i) => (u.kind === "footnote" ? [] : [i]));
  const [a, b] = [body(from), body(to)];
  const mapping = new Map<number, number>();
  const taken = new Set<number>();
  const pair = (i: number, j: number) => {
    mapping.set(i, j);
    taken.add(j);
  };
  const exact = (u: Unit) => `${shape(u)}\0${wordsOf(u)}`;
  for (const [tag, a1, a2, b1] of opcodes(a.map((i) => exact(from[i]!)), b.map((j) => exact(to[j]!))))
    if (tag === "equal") for (let k = 0; k < a2 - a1; k++) pair(a[a1 + k]!, b[b1 + k]!);
  const rows = (u: Unit) => Boolean(u.cells);
  // The same words elsewhere: moved, or given another shape.
  for (const i of a) {
    if (mapping.has(i)) continue;
    const found = b
      .filter((j) => !taken.has(j) && rows(from[i]!) === rows(to[j]!) && wordsOf(from[i]!) === wordsOf(to[j]!))
      .sort((x, y) => Math.abs(x - i) - Math.abs(y - i))[0];
    if (found !== undefined) pair(i, found);
  }
  const close: { i: number; j: number; score: number }[] = [];
  for (const i of a) {
    if (mapping.has(i)) continue;
    for (const j of b) {
      if (taken.has(j) || rows(from[i]!) !== rows(to[j]!)) continue;
      const score = kinship(from[i]!, to[j]!);
      if (score) close.push({ i, j, score: score + (from[i]!.kind === to[j]!.kind ? 0.01 : 0) });
    }
  }
  close.sort((x, y) => y.score - x.score || Math.abs(x.i - x.j) - Math.abs(y.i - y.j));
  // Blocks that pair where they stand come first. One that would have had to
  // move needs much closer words, or a new block would pass for an old one.
  const staying = inOrder([...mapping]);
  const crosses = (i: number, j: number) => [...staying].some((x) => x < i !== mapping.get(x)! < j);
  for (const { i, j } of close)
    if (!mapping.has(i) && !taken.has(j) && !crosses(i, j)) {
      pair(i, j);
      staying.add(i);
    }
  for (const { i, j, score } of close) if (!mapping.has(i) && !taken.has(j) && score >= 0.7) pair(i, j);
  if (rewrites) {
    const kept = inOrder([...mapping]);
    let low = -1;
    for (const high of [...[...kept].sort((x, y) => x - y), from.length]) {
      const end = high === from.length ? to.length : mapping.get(high)!;
      const start = low < 0 ? -1 : mapping.get(low)!;
      const olds = a.filter((i) => i > low && i < high && !mapping.has(i));
      const news = b.filter((j) => j > start && j < end && !taken.has(j));
      if (olds.length === 1 && news.length === 1 && from[olds[0]!]!.kind === to[news[0]!]!.kind && !rows(from[olds[0]!]!))
        pair(olds[0]!, news[0]!);
      low = high;
    }
  }
  const kept = inOrder([...mapping]);
  const moved = new Set([...mapping.keys()].filter((i) => !kept.has(i)));
  const labels = new Map(to.flatMap((u, i) => (u.kind === "footnote" ? [[u.label!, i] as const] : [])));
  from.forEach((u, i) => {
    const j = u.kind === "footnote" ? labels.get(u.label!) : undefined;
    if (j !== undefined) {
      pair(i, j);
      labels.delete(u.label!);
    }
  });
  return {
    mapping,
    moved,
    added: to.flatMap((_, j) => (taken.has(j) ? [] : [j])),
    removed: from.flatMap((_, i) => (mapping.has(i) ? [] : [i])),
  };
}

export interface Place {
  removed: number[];
  added: number[];
}

/** What was removed and added, grouped by the block that stays before it. */
export function places(from: Unit[], to: Unit[], found: Alignment): Place[] {
  const groups = new Map<string, Place>();
  const at = (key: string) => groups.get(key) ?? (groups.set(key, { removed: [], added: [] }), groups.get(key)!);
  const stays = (i: number) => from[i]!.kind !== "footnote" && !found.moved.has(i);
  const back = new Map([...found.mapping].map(([i, j]) => [j, i]));
  for (const i of found.removed) {
    // A footnote is removed with the paragraph that referred to it, wherever that was.
    if (from[i]!.kind === "footnote") {
      at(`note ${i}`).removed.push(i);
      continue;
    }
    let k = i - 1;
    while (k >= 0 && !(found.mapping.has(k) && stays(k))) k--;
    at(`${k}`).removed.push(i);
  }
  for (const j of found.added) {
    if (to[j]!.kind === "footnote") {
      at(`new note ${j}`).added.push(j);
      continue;
    }
    let k = j - 1;
    while (k >= 0 && !(back.has(k) && stays(back.get(k)!))) k--;
    at(`${k >= 0 ? back.get(k)! : -1}`).added.push(j);
  }
  return [...groups.values()];
}

/** Where each block of the first list differs from the second, one line each. */
export function differences(md: Unit[], word: Unit[]): string[] {
  const { mapping, added, removed, moved } = align(md, word);
  const show = (u: Unit) => `${u.kind}${u.label ? ` [^${u.label}]` : ""} "${wordsOf(u).slice(0, 60)}"`;
  const out: string[] = [];
  if (moved.size) out.push("the blocks are in a different order");
  for (const [i, j] of mapping) {
    const [a, b] = [md[i]!, word[j]!];
    if (shape(a) !== shape(b)) out.push(`a ${shape(a)} in the file is a ${shape(b)} in Word: ${show(a)}`);
    else if (!sameContent(a, b)) out.push(`text or formatting differs: file ${show(a)}; Word ${show(b)}`);
  }
  // Two tables must not have become one.
  const tables = (list: Unit[]) =>
    list.filter((u) => u.cells).map((u, k, rows) => (k && rows[k - 1]!.table === u.table ? "+" : "|")).join("");
  if (!added.length && !removed.length && tables(md) !== tables(word)) out.push("rows are grouped into different tables");
  for (const i of removed) out.push(`only in the file: ${show(md[i]!)}`);
  for (const j of added) out.push(`only in Word: ${show(word[j]!)}`);
  return out;
}

/** True when most of a block's words are in content docsync could not read. */
export function hidden(u: Unit, unread: Unread[]): boolean {
  const own = wordsOf(u).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return own.length > 0 && unread.some(({ text }) => {
    const there = new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    return own.filter((w) => there.has(w)).length * 2 >= own.length;
  });
}

const letters = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** The runs of words a change takes out of a block, and the runs it puts in. */
function moves(from: Unit[], to: Unit[], found: Alignment, key: string): { out: string[][]; in: string[][] } {
  if (key.startsWith("+")) return { out: [], in: [letters(wordsOf(to[Number(key.slice(1))]!))] };
  const i = Number(key);
  const was = letters(wordsOf(from[i]!));
  const j = found.mapping.get(i);
  if (j === undefined) return { out: [was], in: [] };
  const now = letters(wordsOf(to[j]!));
  const result = { out: [] as string[][], in: [] as string[][] };
  for (const [tag, a1, a2, b1, b2] of opcodes(was, now)) {
    if (tag === "equal") continue;
    if (a2 > a1) result.out.push(was.slice(a1, a2));
    if (b2 > b1) result.in.push(now.slice(b1, b2));
  }
  return result;
}

const triples = (run: string[]) => run.slice(2).map((_, k) => run.slice(k, k + 3).join(" "));

/** True when two runs look like the same words: three in a row, or all of a shorter one. */
function sameWordsIn(a: string[][], b: string[][]): boolean {
  return a.some((x) => b.some((y) => {
    if (!x.length || !y.length) return false;
    if (x.length < 3 || y.length < 3) {
      const [short, long] = x.length <= y.length ? [x, y] : [y, x];
      return short.length === 1 ? long.length === 1 && short[0] === long[0] : short.every((w) => long.includes(w));
    }
    const there = new Set(triples(y));
    return triples(x).some((t) => there.has(t));
  }));
}

/**
 * The changes that must be held back because one in `refused` was: those that
 * take out words a refused change was to put in elsewhere, or put in words a
 * refused change was to take out. Splitting, joining and moving text are made of
 * two changes, and half of one loses the words or doubles them.
 */
export function entangled(from: Unit[], to: Unit[], found: Alignment, refused: Set<string>): Set<string> {
  const keys = [
    ...[...found.mapping].flatMap(([i, j]) => (sameContent(from[i]!, to[j]!) ? [] : [`${i}`])),
    ...found.removed.map(String),
    ...found.added.map((j) => `+${j}`),
  ];
  const words = new Map(keys.map((key) => [key, moves(from, to, found, key)]));
  const held = new Set<string>();
  const queue = keys.filter((key) => refused.has(key));
  /** Changes that take whole blocks, or several words together, out. */
  const taking = new Set(keys.filter((key) =>
    found.removed.includes(Number(key)) || words.get(key)!.out.some((run) => run.length >= 2)));
  let holding = false;
  while (queue.length) {
    const next = queue.pop()!;
    const bad = words.get(next);
    if (!bad) continue;
    // New text that could not be written may be old text, rewritten beyond
    // recognition. So while any is left out, no block is removed and no change
    // takes more than a word out of one.
    if (!holding && (next.startsWith("+") || bad.in.reduce((n, run) => n + run.length, 0) >= 5)) {
      holding = true;
      for (const key of taking)
        if (!refused.has(key) && !held.has(key)) {
          held.add(key);
          queue.push(key);
        }
    }
    for (const key of keys) {
      if (refused.has(key) || held.has(key)) continue;
      const here = words.get(key)!;
      if (sameWordsIn(here.out, bad.in) || sameWordsIn(here.in, bad.out)) {
        held.add(key);
        queue.push(key);
      }
    }
  }
  return held;
}

/**
 * One line for each change that puts back words the other side had taken out:
 * `gone` holds the base blocks that side no longer has. A join on one side and a
 * removal on the other would otherwise undo the removal without a word.
 */
export function broughtBack(from: Unit[], to: Unit[], found: Alignment, keys: Iterable<string>, gone: Unit[], who: string): string[] {
  const lost = gone.map((u) => ({ u, words: [letters(wordsOf(u))] }));
  const out: string[] = [];
  for (const key of keys) {
    const { in: arriving } = moves(from, to, found, key);
    const run = arriving.filter((r) => r.length >= 3);
    for (const { u, words } of lost)
      if (sameWordsIn(run, words))
        out.push(`check this: a change brings back words that ${who} removed, from "${wordsOf(u).slice(0, 80)}"`);
  }
  return [...new Set(out)];
}

/** Content docsync could not read, and how many units come before it. */
export interface Unread {
  text: string;
  after: number;
}

export interface CarryOptions {
  /**
   * Changes to leave out: an index into `from` for an edit or a removal, "+n"
   * for the addition of `to[n]`.
   */
  skip?: Set<string>;
  /** Which side wins where `markdown` and `to` changed the same thing: ours is `markdown`. */
  prefer?: Side;
  /** What docsync could not read where `to` came from. */
  unread?: Unread[];
}

export interface Carried {
  markdown: string;
  report: string[];
  /** The changes not made, keyed as `skip` is. */
  left: Set<string>;
  /** True when `markdown` now differs from `to` in nothing it was given. */
  complete: boolean;
}

interface Plan {
  replaced: Map<number, Unit>;
  deleted: Set<number>;
  inserted: Map<number, Unit[]>;
}

const copy = (p: Plan): Plan => ({
  replaced: new Map(p.replaced),
  deleted: new Set(p.deleted),
  inserted: new Map([...p.inserted].map(([k, v]) => [k, [...v]])),
});

/** True when `after` reads as `before` with the planned changes and nothing else. */
function reads(before: MdUnit[], after: MdUnit[], plan: Plan): boolean {
  const expected: Unit[] = [];
  for (const u of before) {
    if (!plan.deleted.has(u.block)) expected.push(plan.replaced.get(u.block) ?? u);
    expected.push(...(plan.inserted.get(u.block) ?? []));
  }
  const text = (list: Unit[]) => list.filter((u) => u.kind !== "footnote");
  const notes = (list: Unit[]) => list.filter((u) => u.kind === "footnote").sort((a, b) => a.label!.localeCompare(b.label!));
  const equal = (a: Unit[], b: Unit[]) =>
    a.length === b.length && a.every((u, k) => shape(u) === shape(b[k]!) && u.label === b[k]!.label && sameContent(u, b[k]!));
  return equal(text(expected), text(after)) && equal(notes(expected), notes(after));
}

/**
 * Carries the changes from `from` to `to` into `markdown`. `markdown` may hold
 * changes of its own since `from`; each block is merged by itself, so what each
 * side added stays. Every change made is read back from the result. When one is
 * refused, those entangled with it are held back and the rest planned again.
 */
export function carry(markdown: string, from: Unit[], to: Unit[], options: CarryOptions = {}): Carried {
  const skip = new Set(options.skip);
  const held = new Set<string>();
  const found = align(from, to);
  for (;;) {
    const result = carryOnce(markdown, from, to, { ...options, skip }, held);
    const more = [...entangled(from, to, found, new Set([...result.left, ...skip]))].filter((key) => !skip.has(key));
    if (!more.length) {
      for (const key of skip) result.left.add(key);
      return result;
    }
    for (const key of more) {
      skip.add(key);
      held.add(key);
    }
  }
}

function carryOnce(markdown: string, from: Unit[], to: Unit[], options: CarryOptions, held: Set<string>): Carried {
  const { skip = new Set<string>(), prefer, unread = [] } = options;
  const md = mdUnits(markdown);
  // Which block of the file each old block is decides what gets overwritten.
  const home = align(from, md, false).mapping;
  const found = align(from, to);
  const { mapping, moved } = found;
  const report: string[] = [];
  const left = new Set<string>();
  let complete = skip.size === 0;
  const leave = (why: string, ...keys: string[]) => {
    complete = false;
    report.push(why);
    for (const key of keys) left.add(key);
  };
  const quoted = (u: Unit) => `${u.kind} "${wordsOf(u).slice(0, 60)}"`;
  const winner = prefer === "theirs" ? "doc" : "git";
  const lost = (git: Unit | undefined, word: Unit | undefined) =>
    report.push(`conflict resolved for ${winner}: git '${git ? wordsOf(git) : "(removed)"}' / Word '${word ? wordsOf(word) : "(removed)"}'`);

  let ops: Op[] = [];
  let plan: Plan = { replaced: new Map(), deleted: new Set(), inserted: new Map() };
  /** Takes the ops if the patcher accepts them and the result reads as planned. */
  const take = (next: Op[], change: (p: Plan) => void): string | undefined => {
    const wanted = copy(plan);
    change(wanted);
    try {
      const result = applyOps(markdown, [...ops, ...next]);
      if (!reads(md, mdUnits(result), wanted)) return "Markdown would not read the result as meant";
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      return e.message;
    }
    ops = [...ops, ...next];
    plan = wanted;
    return undefined;
  };

  for (const i of moved) leave(`moved: ${quoted(from[i]!)}; move it by hand`);

  for (const [i, j] of mapping) {
    const [a, b] = [from[i]!, to[j]!];
    if (shape(a) !== shape(b)) leave(`${quoted(a)} is now a ${shape(b)}; change that by hand`);
    if (held.has(`${i}`)) {
      leave(`${quoted(a)} is held back: its words go with a change that could not be made; do both by hand`, `${i}`);
      continue;
    }
    if (sameContent(a, b) || skip.has(`${i}`)) continue;
    const at = home.get(i);
    if (at === undefined) {
      leave(`${quoted(a)} changed, and its block in the file was removed or rewritten: '${wordsOf(b)}' was not applied`, `${i}`);
      continue;
    }
    const target = md[at]!;
    if (sameContent(target, b)) continue;
    if (target.held) {
      leave(`${quoted(a)} changed, but its block holds ${target.held}; edit it by hand`, `${i}`);
      continue;
    }
    let conflicted = false;
    const join = (was: string, ours: string, theirs: string) => {
      const merged = merge3(was, ours, theirs, prefer);
      conflicted ||= merged.conflicts.length > 0;
      return merged.text;
    };
    try {
      /** The block with the merged words, or with `to`'s own words when the file has none of its own to keep. */
      const attempts: Unit[] = [];
      if (a.cells || b.cells) {
        if (!a.cells || !b.cells || a.cells.length !== b.cells.length || target.cells?.length !== b.cells.length) {
          leave(`${quoted(a)}: the number of cells changed; edit it by hand`, `${i}`);
          continue;
        }
        attempts.push({ ...bare(target), cells: a.cells.map((c, k) => join(c, target.cells![k]!, b.cells![k]!)) });
        if (sameContent(target, a)) attempts.push({ ...bare(target), cells: b.cells });
      } else {
        attempts.push({ ...bare(target), text: join(a.text, target.text, b.text) });
        if (sameContent(target, a) && !target.text.includes("`")) attempts.push({ ...bare(target), text: b.text });
      }
      // A citation made of both sides' words could name a page neither side meant.
      if (a.kind === "footnote" && !sameContent(target, a)) {
        leave(`footnote [^${a.label}] changed on both sides, to '${wordsOf(target)}' in the file and '${wordsOf(b)}' in Word; settle it by hand`, `${i}`);
        continue;
      }
      if (conflicted && !stillReads(a, b)) {
        leave(`${quoted(a)} was rewritten in Word and edited in the file: Word has '${wordsOf(b)}'; combine them by hand`, `${i}`);
        continue;
      }
      let why: string | undefined;
      for (const goal of attempts) {
        const next: Op[] = goal.cells
          ? goal.cells.flatMap((c, cell) => (c === target.cells![cell] ? [] : [{ op: "replace" as const, block: target.block, cell, text: c }]))
          : [{ op: "replace", block: target.block, text: target.kind === "footnote" ? `[^${target.label}]: ${goal.text}` : goal.text }];
        why = take(next, (p) => p.replaced.set(target.block, goal));
        if (why === undefined) break;
      }
      if (why !== undefined) leave(`${quoted(a)}: ${why}; edit it by hand`, `${i}`);
      else if (conflicted) lost(target, b);
    } catch (e) {
      if (!(e instanceof Conflicted)) throw e;
      leave(`${quoted(a)}: the changed words are ones the file writes differently from Word; edit it by hand`, `${i}`);
    }
  }

  const back = new Map([...mapping].map(([i, j]) => [j, i]));
  const anchorOf = new Map<number, MdUnit>();
  const parsed = parse(markdown).blocks;
  // Blocks of the file that are new since `from`: one may be an addition already made.
  const claimed = new Set(home.values());
  const born = new Set(md.flatMap((_, k) => (claimed.has(k) ? [] : [k])));
  // Footnotes come last, once it is known which paragraphs still refer to them.
  const notesOnly = (p: Place) =>
    p.removed.every((i) => from[i]!.kind === "footnote") && p.added.every((j) => to[j]!.kind === "footnote");
  const grouped = places(from, to, found).sort((x, y) => Number(notesOnly(x)) - Number(notesOnly(y)));
  /** Whether the Markdown as planned still refers to a footnote. */
  const refersTo = (label: string) => {
    const planned = ops.length ? applyOps(markdown, ops) : markdown;
    return mdUnits(planned).some((u) =>
      parseInline(u.cells?.join(" ") ?? u.text).some((atom) => atom.fn === label));
  };
  /** For a removed block, the kept block before it; unread content there may be what it became. */
  const unreadAt = new Set(unread.map(({ after }) => {
    const back = new Map([...mapping].map(([i, j]) => [j, i]));
    for (let k = after - 1; k >= 0; k--) {
      const i = back.get(k);
      if (i !== undefined && to[k]!.kind !== "footnote" && !moved.has(i)) return i;
    }
    return -1;
  }));
  const keptBefore = (i: number) => {
    for (let k = i - 1; k >= 0; k--) if (mapping.has(k) && from[k]!.kind !== "footnote" && !moved.has(k)) return k;
    return -1;
  };

  for (const place of grouped) {
    const removals = place.removed.filter((i) => !skip.has(`${i}`));
    const additions = place.added.filter((j) => !skip.has(`+${j}`));
    const keys = [...removals.map(String), ...additions.map((j) => `+${j}`)];
    if (!keys.length) continue;
    if (removals.length < place.removed.length || additions.length < place.added.length) {
      leave(`left with a related change: ${[...removals.map((i) => quoted(from[i]!)), ...additions.map((j) => quoted(to[j]!))].join(", ")}`, ...keys);
      continue;
    }
    const [wereOps, werePlan] = [ops, plan];
    const anchors: [number, MdUnit][] = [];
    const conflicts: [Unit | undefined, Unit | undefined][] = [];
    const used: number[] = [];
    let failure: string | undefined;

    for (const j of additions) {
      const u = to[j]!;
      const already = [...born].find((k) =>
        !used.includes(k) && shape(md[k]!) === shape(u) && md[k]!.label === u.label && sameContent(md[k]!, u));
      if (already !== undefined) {
        used.push(already);
        anchors.push([j, md[already]!]);
        anchorOf.set(j, md[already]!);
        continue;
      }
      if (u.kind === "footnote" && !refersTo(u.label!)) {
        failure = `new ${quoted(u)}: nothing in the file refers to it`;
        break;
      }
      let anchor: MdUnit | undefined;
      let previous: Unit | undefined;
      if (u.kind === "footnote") {
        const last = [...md].reverse().find((x) => x.kind === "footnote" && !plan.deleted.has(x.block));
        const end = parsed.length - 1;
        anchor = last ?? (end >= 0 ? ({ block: end, kind: "paragraph", text: "" } as MdUnit) : undefined);
      } else {
        for (let k = j - 1; k >= 0 && anchor === undefined; k--) {
          if (to[k]!.kind === "footnote") continue;
          previous ??= to[k];
          const i = back.get(k);
          const at = i === undefined || moved.has(i) ? undefined : home.get(i);
          anchor = anchorOf.get(k) ?? (at === undefined ? undefined : md[at]);
          // A new block that could not be placed is not skipped over.
          if (anchor === undefined && i === undefined) break;
        }
      }
      if (!anchor) {
        failure = `new ${quoted(u)} has nothing before it to anchor to`;
        break;
      }
      const after = anchor.block;
      let op: Op | undefined;
      if (u.kind === "paragraph") op = { op: "insert", after, kind: "paragraph", text: u.text };
      else if (u.kind === "footnote") op = { op: "insert", after, kind: "paragraph", text: `[^${u.label}]: ${u.text}` };
      else if (u.kind === "heading") op = { op: "insert", after, kind: "heading", level: u.level, text: u.text };
      else if (u.kind === "quote")
        op = parsed[after]?.kind === "quote" && previous?.kind === "quote"
          ? { op: "insert", after, kind: "quote", text: u.text }
          : { op: "insert", after, kind: "blockquote", paragraphs: [u.text] };
      else if (u.kind === "item" && anchor.kind === "item" && Boolean(anchor.ordered) === Boolean(u.ordered))
        op = { op: "insert", after, kind: "item", text: u.text };
      else if (u.kind === "row" && anchor.kind === "row" && previous?.kind === "row" && previous.table === u.table)
        op = { op: "insert", after, kind: "row", cells: u.cells! };
      if (!op) {
        failure = `new ${quoted(u)}: a new list or table is not carried`;
        break;
      }
      const why = take([op], (p) => p.inserted.set(after, [...(p.inserted.get(after) ?? []), u]));
      if (why !== undefined) {
        failure = `new ${quoted(u)}: ${why}`;
        break;
      }
      anchorOf.set(j, anchor);
      anchors.push([j, anchor]);
    }

    // Removals together, since a table or a quote can only go whole.
    const doomed: MdUnit[] = [];
    for (const i of failure === undefined ? removals : []) {
      const u = from[i]!;
      if (hidden(u, unread)) {
        failure = `${quoted(u)} may still be in the Word file, in content docsync cannot read`;
        break;
      }
      if (u.kind !== "footnote" && unreadAt.has(keptBefore(i))) {
        failure = `${quoted(u)} is gone, and there is content docsync cannot read in its place, which may be what it became`;
        break;
      }
      const at = home.get(i);
      if (at === undefined) continue;
      const target = md[at]!;
      if (target.kind === "footnote" && refersTo(target.label!)) {
        failure = `the file still refers to ${quoted(target)} [^${target.label}]`;
        break;
      }
      if (!sameContent(target, u)) {
        conflicts.push([target, undefined]);
        if (prefer !== "theirs") continue;
      }
      doomed.push(target);
    }
    if (failure === undefined && doomed.length) {
      const why = take(doomed.map((u) => ({ op: "delete" as const, block: u.block })), (p) => {
        for (const u of doomed) p.deleted.add(u.block);
      });
      if (why !== undefined) failure = `removed ${doomed.map(quoted).join(", ")}: ${why}`;
    }

    if (failure !== undefined) {
      [ops, plan] = [wereOps, werePlan];
      for (const [j] of anchors) anchorOf.delete(j);
      const others = [...removals.map((i) => `removal of ${quoted(from[i]!)}`), ...additions.map((j) => `new ${quoted(to[j]!)}`)];
      leave(`${failure}; do this by hand (not carried: ${others.join(", ")})`, ...keys);
      continue;
    }
    // Two new texts at one spot may be two versions of one paragraph.
    if (prefer !== undefined)
      for (const [j, anchor] of anchors)
        if (to[j]!.kind !== "footnote" && born.has(md.indexOf(anchor) + 1) && !used.includes(md.indexOf(anchor) + 1))
          report.push(`both sides have new text here; check that these are not two versions of one: '${wordsOf(md[md.indexOf(anchor) + 1]!)}' and '${wordsOf(to[j]!)}'`);
    for (const k of used) born.delete(k);
    for (const [git, word] of conflicts) lost(git, word);
  }

  return { markdown: ops.length ? applyOps(markdown, ops) : markdown, report, left, complete };
}
