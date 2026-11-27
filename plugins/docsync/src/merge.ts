// Three-way merge of words, with the whitespace between them merged separately.
import { opcodes } from "./difflib.ts";
import { normWord } from "./markdown.ts";

export type Side = "ours" | "theirs";
export interface Conflict {
  base: string;
  ours: string;
  theirs: string;
}

export class Conflicted extends Error {
  constructor(readonly conflicts: Conflict[]) {
    super(`${conflicts.length} conflict(s)`);
  }
}

type Name = "base" | Side;
type At = Partial<Record<Name, number>>;
type Item = [string, At];
type Hunk = [baseStart: number, baseEnd: number, start: number, end: number];

function split(text: string) {
  const pieces = [...text.matchAll(/(\s*)(\S+)/g)];
  return { words: pieces.map((p) => p[2]!), gaps: pieces.map((p) => p[1]!), tail: /\s*$/.exec(text)![0] };
}

function hunks(base: string[], other: string[]): Hunk[] {
  let lo = 0;
  while (lo < base.length && lo < other.length && base[lo] === other[lo]) lo++;
  let hiBase = base.length;
  let hiOther = other.length;
  while (hiBase > lo && hiOther > lo && base[hiBase - 1] === other[hiOther - 1]) {
    hiBase--;
    hiOther--;
  }
  const out: Hunk[] = [];
  for (const [tag, a1, a2, b1, b2] of opcodes(base.slice(lo, hiBase), other.slice(lo, hiOther))) {
    if (tag === "equal") continue;
    if (tag === "replace" && a2 - a1 === b2 - b1)
      // Keep unrelated neighbours apart.
      for (let k = 0; k < a2 - a1; k++) out.push([a1 + k + lo, a1 + k + 1 + lo, b1 + k + lo, b1 + k + 1 + lo]);
    else out.push([a1 + lo, a2 + lo, b1 + lo, b2 + lo]);
  }
  return out;
}

const sameWords = (a: Item[], b: Item[]) =>
  a.length === b.length && a.every((x, k) => normWord(x[0]) === normWord(b[k]![0]));

/**
 * Both sides' word changes apply. A conflict is the same words changed differently,
 * or two insertions at one spot. Without `prefer` a conflict throws Conflicted;
 * with it the preferred side's words are kept and the conflict is returned.
 */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
  prefer?: Side,
): { text: string; conflicts: Conflict[] } {
  if (ours === base || ours === theirs) return { text: theirs, conflicts: [] };
  if (theirs === base) return { text: ours, conflicts: [] };
  const texts = { base: split(base), ours: split(ours), theirs: split(theirs) };
  const baseKeys = texts.base.words.map(normWord);
  const sideHunks = {
    ours: hunks(baseKeys, texts.ours.words.map(normWord)),
    theirs: hunks(baseKeys, texts.theirs.words.map(normWord)),
  };
  const all = (["ours", "theirs"] as const)
    .flatMap((name) => sideHunks[name].map((h) => ({ name, h })))
    .sort((x, y) => x.h[0] - y.h[0] || x.h[1] - y.h[1] || x.name.localeCompare(y.name));
  const groups: (typeof all)[] = [];
  for (const entry of all) {
    const group = groups.at(-1);
    if (group) {
      const last = group.at(-1)!.h;
      const end = Math.max(...group.map((x) => x.h[1]));
      const bothInsert = last[0] === last[1] && entry.h[0] === entry.h[1] && last[0] === entry.h[0];
      if (entry.h[0] < end || bothInsert) {
        group.push(entry);
        continue;
      }
    }
    groups.push([entry]);
  }

  // For each side, where each unchanged base word sits.
  const where = { ours: new Map<number, number>(), theirs: new Map<number, number>() };
  for (const name of ["ours", "theirs"] as const) {
    let bi = 0;
    let oi = 0;
    for (const [b1, b2, , o2] of sideHunks[name]) {
      while (bi < b1) where[name].set(bi++, oi++);
      bi = b2;
      oi = o2;
    }
    while (bi < baseKeys.length) where[name].set(bi++, oi++);
  }

  const baseItem = (i: number): Item => [
    texts.base.words[i]!,
    { base: i, ours: where.ours.get(i), theirs: where.theirs.get(i) },
  ];
  const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, k) => baseItem(from + k));

  const sideItems = (group: typeof all, name: Side, from: number, to: number): Item[] => {
    const w = texts[name].words;
    const other: Side = name === "ours" ? "theirs" : "ours";
    const result: Item[] = [];
    let at = from;
    for (const { h } of group.filter((x) => x.name === name)) {
      const [b1, b2, o1, o2] = h;
      result.push(...range(at, b1));
      if (b2 - b1 === 1 && o2 - o1 === 1)
        // A one-for-one substitution keeps the word's place for whitespace.
        result.push([w[o1]!, { [name]: o1, base: b1, [other]: where[other].get(b1) }]);
      else for (let j = o1; j < o2; j++) result.push([w[j]!, { [name]: j }]);
      at = b2;
    }
    return result.concat(range(at, to));
  };

  const items: Item[] = [];
  const conflicts: Conflict[] = [];
  let pos = 0;
  for (const group of groups) {
    const from = Math.min(...group.map((x) => x.h[0]));
    const to = Math.max(...group.map((x) => x.h[1]));
    items.push(...range(pos, from));
    const names = new Set(group.map((x) => x.name));
    if (names.size === 1) {
      items.push(...sideItems(group, group[0]!.name, from, to));
    } else {
      const mine = sideItems(group, "ours", from, to);
      const yours = sideItems(group, "theirs", from, to);
      if (sameWords(mine, yours)) {
        mine.forEach(([w, at], k) => items.push([w, { ...yours[k]![1], ...at }]));
      } else {
        const join = (list: Item[]) => list.map((x) => x[0]).join(" ");
        conflicts.push({ base: texts.base.words.slice(from, to).join(" "), ours: join(mine), theirs: join(yours) });
        items.push(...(prefer === "theirs" ? yours : mine));
      }
    }
    pos = to;
  }
  items.push(...range(pos, baseKeys.length));
  if (conflicts.length && !prefer) throw new Conflicted(conflicts);

  // The side that changed a piece of whitespace wins over the base.
  const pick = (b: string | undefined, o: string | undefined, t: string | undefined): string | undefined => {
    if (o !== undefined && t !== undefined) {
      if (o === t) return o;
      if (b !== undefined && o !== b && t === b) return o;
      if (b !== undefined && t !== b && o === b) return t;
      return prefer === "theirs" ? t : o;
    }
    return o ?? t ?? b;
  };

  const gapBefore = (x: Item, y: Item): string => {
    const gap = (name: Name) => {
      const ix = x[1][name];
      const iy = y[1][name];
      return ix !== undefined && iy !== undefined && iy === ix + 1 ? texts[name].gaps[iy] : undefined;
    };
    const found = pick(gap("base"), gap("ours"), gap("theirs"));
    if (found !== undefined) return found;
    // A boundary only the merge made.
    for (const name of prefer === "theirs" ? (["theirs", "ours"] as const) : (["ours", "theirs"] as const)) {
      const iy = y[1][name];
      if (iy !== undefined && iy > 0) return texts[name].gaps[iy]!;
    }
    return " ";
  };

  const lead = (name: Name) => texts[name].gaps[0] ?? "";
  const tail = pick(texts.base.tail, texts.ours.tail, texts.theirs.tail)!;
  if (!items.length) return { text: tail, conflicts };
  let text = pick(lead("base"), lead("ours"), lead("theirs"))! + items[0]![0];
  for (let k = 1; k < items.length; k++) text += gapBefore(items[k - 1]!, items[k]!) + items[k]![0];
  return { text: text + tail, conflicts };
}
