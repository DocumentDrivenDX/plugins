// The Claude Docs adapter: changed-blocks reads to file edits, and file changes to doc edits.
import { opcodes, ratio } from "./difflib.ts";
import { escapeFootnotes, hasFormatting, literal, unescapeMarkdown } from "./markers.ts";
import {
  blockSource, normWord, parse, Refused, splitCells, splitFrontMatter, words,
  type Block, type Kind, type Op,
} from "./markdown.ts";
import { merge3 } from "./merge.ts";
import { elements, innerText, parseXml, type Element } from "./xml.ts";

// ---- reading a doc ------------------------------------------------------------

/**
 * The doc as it says today: comment marks and suggestion lists removed, proposed
 * insertions left out and proposed deletions kept. Returns the open suggestion ids.
 */
export function readDoc(xml: string): { root: Element; suggestions: Set<string> } {
  const root = parseXml(xml);
  const suggestions = new Set<string>();
  const count = (e: Element) => {
    if (e.attrs.s && (e.tag === "ins" || e.tag === "del")) suggestions.add(e.attrs.s);
    elements(e).forEach(count);
  };
  count(root);
  const clean = (e: Element) => {
    e.children = e.children.flatMap((c): (Element | string)[] => {
      if (typeof c === "string") return [c];
      if (["comment", "pending-suggestions", "suggestions", "ins"].includes(c.tag)) return [];
      if (c.attrs.suggest === "ins") return [];
      clean(c);
      return c.tag === "del" ? c.children : [c];
    });
  };
  clean(root);
  return { root, suggestions };
}

const MARKS: Record<string, string> = { bold: "**", italic: "*", code: "`", strike: "~~" };

type Token = { text: string } | { raw: string } | { mark: string; inner: Token[] };

function tokens(e: Element, into: Token[] = []): Token[] {
  for (const c of e.children) {
    if (typeof c === "string") into.push({ text: c });
    else if (c.tag === "text") tokens(c, into);
    else if (c.tag === "code") {
      const raw = innerText(c);
      const fence = raw.includes("`") ? "``" : "`";
      into.push({ raw: fence + raw + fence });
    } else if (c.tag in MARKS) {
      // The doc can split one marked phrase into several runs.
      const last = into.at(-1);
      if (last && "mark" in last && last.mark === c.tag) tokens(c, last.inner);
      else into.push({ mark: c.tag, inner: tokens(c) });
    } else if (c.tag === "link") {
      into.push({ raw: `[${render(tokens(c))}](${c.attrs.href ?? ""})` });
    } else {
      throw new Refused(`the doc has <${c.tag}> inside a paragraph, which has no Markdown form here`);
    }
  }
  return into;
}

function render(list: Token[]): string {
  let out = "";
  let plain = "";
  // Neighbouring plain runs are joined first: a marker can span two of them.
  const flush = () => {
    out += literal(plain);
    plain = "";
  };
  for (const t of list) {
    if ("text" in t) {
      plain += t.text;
      continue;
    }
    flush();
    if ("raw" in t) out += t.raw;
    else {
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(render(t.inner))!;
      const mark = MARKS[t.mark]!;
      out += lead! + (core ? mark + core + mark : "") + trail!;
    }
  }
  flush();
  return out;
}

export const runsToMarkdown = (e: Element) => render(tokens(e));

/** A read prints a session's first id in full and later ones short (`.90`). */
function fullIds(root: Element): void {
  let session = "";
  const walk = (e: Element) => {
    const id = e.attrs.id;
    if (id && !["comment", "s"].includes(e.tag)) {
      if (id.startsWith(".")) {
        if (!session) throw new Refused(`id ${id} is short and no full id came before it, so its session is unknown`);
        e.attrs.id = session + id;
      } else session = id.split(".")[0]!;
    }
    elements(e).forEach(walk);
  };
  walk(root);
}

const alnum = (text: string) => (text.match(/[\p{L}\p{N}]/gu) ?? []).join("");

interface Cell {
  id: string;
  md: string;
  plain: string;
}

/** A full read of a doc: its tree of ids, and its units numbered like a file's blocks. */
export class Doc {
  rev: string | undefined;
  node: string | undefined;
  suggestions: number;
  kids = new Map<string, string[]>([["root", []]]);
  tag = new Map<string, string>();
  src = new Map<string, number>();
  first = new Map<string, number>();
  last = new Map<string, number>();
  attrs = new Map<string, Record<string, string>>();
  md = new Map<string, string>();
  plain = new Map<string, string>();
  cells = new Map<string, Cell[]>();
  hash = new Map<string, string>();
  top = new Map<string, string>();
  tableOf = new Map<string, string>();
  quoteOf = new Map<string, string>();
  order: string[] = [];

  constructor(xml: string, file?: { lines: string[]; blocks: Block[] }) {
    const { root, suggestions } = readDoc(xml);
    fullIds(root);
    this.rev = root.attrs.rev;
    this.node = root.attrs.node;
    this.suggestions = suggestions.size;
    const kinds: Kind[] = [];
    const seen: string[] = [];

    const unit = (e: Element, kind: Kind, id: string) => {
      this.src.set(id, kinds.length);
      kinds.push(kind);
      this.order.push(id);
      this.hash.set(id, e.attrs.h ?? "");
      if (kind === "row") {
        const cells = elements(e, "cell").map((c) => {
          const paragraphs = elements(c, "paragraph");
          return {
            id: c.attrs.id!,
            md: unescapeMarkdown(paragraphs.map(runsToMarkdown).join(" ")),
            plain: paragraphs.map(innerText).join(" "),
          };
        });
        this.cells.set(id, cells);
        seen.push(alnum(cells.map((c) => c.md).join(" ")));
      } else if (kind === "other") {
        this.plain.set(id, innerText(e));
        seen.push("");
      } else {
        const paragraph = e.tag === "paragraph" ? e : elements(e, "paragraph")[0];
        const md = paragraph ? runsToMarkdown(paragraph) : "";
        this.md.set(id, unescapeMarkdown(md));
        this.plain.set(id, paragraph ? innerText(paragraph) : "");
        seen.push(alnum(md));
      }
    };

    const leaf = (e: Element, parent: string) => {
      const id = e.attrs.id!;
      this.kids.get(parent)!.push(id);
      this.tag.set(id, e.tag);
      this.kids.set(id, []);
      this.top.set(id, parent === "root" ? id : this.top.get(parent)!);
      this.hash.set(id, e.attrs.h ?? "");
      return id;
    };

    const walk = (e: Element, parent: string) => {
      const id = leaf(e, parent);
      if (e.tag === "row") this.tableOf.set(id, parent);
      const { id: _id, rev: _rev, h: _h, ...rest } = e.attrs;
      this.attrs.set(id, rest);
      const before = kinds.length;
      const quoted = elements(e);
      if (e.tag === "paragraph") unit(e, e.attrs.heading ? "heading" : "paragraph", id);
      else if (e.tag === "list") elements(e, "listItem").forEach((li) => walk(li, id));
      else if (e.tag === "table") elements(e, "row").forEach((r) => walk(r, id));
      else if (e.tag === "blockquote" && quoted.every((c) => c.tag === "paragraph" && !c.attrs.heading)) {
        for (const p of quoted) {
          const pid = leaf(p, id);
          this.quoteOf.set(pid, id);
          unit(p, "quote", pid);
          this.first.set(pid, kinds.length - 1);
          this.last.set(pid, kinds.length - 1);
        }
      } else if (e.tag === "listItem") {
        unit(e, "item", id);
        for (const c of elements(e)) {
          if (c.tag === "paragraph") leaf(c, id);
          else if (c.tag === "list") walk(c, id);
        }
        if (elements(e, "paragraph").length !== 1) kinds[this.src.get(id)!] = "other";
      } else if (e.tag === "row") {
        unit(e, "row", id);
        elements(e, "cell").forEach((c) => leaf(c, id));
      } else unit(e, "other", id);
      if (kinds.length > before) {
        this.first.set(id, before);
        this.last.set(id, kinds.length - 1);
      }
    };

    for (const e of elements(root)) walk(e, "root");
    if (!file) return;
    const want = file.blocks.map((b) => b.kind);
    if (kinds.length !== want.length || kinds.some((k, i) => k !== want[i])) {
      let at = kinds.findIndex((k, i) => k !== want[i]);
      if (at < 0) at = kinds.length;
      throw new Refused(
        `the doc at the synced revision and the file do not line up: block ${at} is ` +
          `${kinds[at] ?? "missing"} in the doc and ${want[at] ?? "missing"} in the file`,
      );
    }
    file.blocks.forEach((b, i) => {
      if (b.kind === "other") return;
      if (alnum(blockSource(file.lines, b)) !== seen[i])
        throw new Refused(
          `block ${i} has different text in the doc at the synced revision and in the file ` +
            "(was the doc made from another version of the file?)",
        );
    });
  }
}

// ---- doc -> git ---------------------------------------------------------------

export function editsFromRead(oldXml: string, deltaXml: string, text: string): { ops: Op[]; report: string[] } {
  const file = parse(splitFrontMatter(text)[1]);
  const { blocks } = file;
  const old = new Doc(oldXml, file);
  const { root: delta, suggestions } = readDoc(deltaXml);
  fullIds(delta);
  if (delta.attrs.since === "unavailable")
    throw new Refused("the read is the whole doc (since='unavailable'), not the changes; compare it with the file by hand");
  if (
    (delta.attrs.node && old.node && delta.attrs.node !== old.node) ||
    (delta.attrs.sinceRev && old.rev && delta.attrs.sinceRev !== old.rev)
  )
    throw new Refused("the read of changes and the read at the synced revision are not of the same doc and revision");
  const ops: Op[] = [];

  const blockText = (p: Element) => {
    const out = runsToMarkdown(p);
    if (!out.trim()) throw new Refused("a paragraph is empty in the doc; delete the block in the repository instead");
    return out;
  };

  const insertAfter = (previous: string | undefined, make: Omit<Extract<Op, { op: "insert" }>, "op" | "after">) => {
    const at = previous === undefined ? undefined : old.last.get(previous);
    if (at === undefined) throw new Refused("a new block has nothing before it to anchor to; add it in the repository");
    ops.push({ op: "insert", after: at, ...make });
  };

  const container = (e: Element, oldId: string) => {
    const olds = old.kids.get(oldId)!;
    let pointer = 0;
    for (const c of elements(e)) {
      const id = c.attrs.id!;
      if (c.tag === "gap") {
        const n = Number(c.attrs.blocks);
        if (!Number.isInteger(n) || n < 0) throw new Refused("the read has a bad gap");
        pointer += n;
      } else if (c.tag === "gone") {
        if (!old.tag.has(id)) continue; // made and deleted after the synced revision
        if (olds.indexOf(id) !== pointer) throw new Refused(`deleted block ${id} is not where the synced doc had it`);
        const first = old.first.get(id);
        if (first === undefined)
          throw new Refused(`deleted block ${id} is a cell or a paragraph inside another block; edit it in the repository`);
        pointer++;
        for (let i = first; i <= old.last.get(id)!; i++) ops.push({ op: "delete", block: i });
      } else if (olds.includes(id)) {
        if (olds.indexOf(id) !== pointer)
          throw new Refused(`block ${id} is not where the synced doc had it (moved, or the gaps do not add up)`);
        pointer++;
        changed(c, id, oldId);
      } else {
        if (pointer > olds.length) throw new Refused("the read's gaps are longer than the synced doc");
        inserted(c, oldId, pointer ? olds[pointer - 1] : undefined);
      }
    }
  };

  const changed = (c: Element, id: string, parent: string) => {
    const was = old.attrs.get(id) ?? {};
    const { id: _id, rev: _rev, h: _h, ...now } = c.attrs;
    for (const k of new Set([...Object.keys(now), ...Object.keys(was)]))
      if (k !== "heading" && now[k] !== was[k])
        throw new Refused(`${c.tag} ${id} changed its \`${k}\` (${was[k]} to ${now[k]}); change it in the repository`);
    if (c.tag === "paragraph" && parent !== "root") {
      // The paragraph of a quote is its own block; that of a list item is the item.
      const n = old.quoteOf.has(id) ? old.src.get(id)! : old.src.get(parent)!;
      ops.push({ op: "replace", block: n, text: blockText(c) });
    } else if (c.tag === "paragraph") {
      const b = blocks[old.src.get(id)!]!;
      if ((b.kind === "heading") !== Boolean(c.attrs.heading))
        throw new Refused(`block ${old.src.get(id)} changed between heading and paragraph; change it in the repository`);
      if (c.attrs.heading && Number(c.attrs.heading) !== b.prefix.trim().length)
        throw new Refused(`block ${old.src.get(id)} changed heading level; change it in the repository`);
      ops.push({ op: "replace", block: old.src.get(id)!, text: blockText(c) });
    } else if (["list", "table", "listItem", "row"].includes(c.tag) || (c.tag === "blockquote" && !old.src.has(id))) {
      container(c, id);
    } else if (c.tag === "cell") {
      const only = elements(c);
      if (only.length !== 1 || only[0]!.tag !== "paragraph")
        throw new Refused(`cell ${id} has more than one paragraph or other content; edit it in the repository`);
      ops.push({
        op: "replace",
        block: old.src.get(parent)!,
        cell: old.kids.get(parent)!.indexOf(id),
        text: runsToMarkdown(only[0]!),
      });
    } else throw new Refused(`block ${id} is a <${c.tag}>; edit it in the repository`);
  };

  const inserted = (c: Element, parent: string, previous: string | undefined) => {
    const parentTag = old.tag.get(parent);
    if (c.tag === "paragraph" && parent === "root") {
      const level = c.attrs.heading;
      insertAfter(previous, level
        ? { kind: "heading", level: Number(level), text: blockText(c) }
        : { kind: "paragraph", text: blockText(c) });
    } else if (c.tag === "paragraph" && parentTag === "blockquote" && !c.attrs.heading) {
      insertAfter(previous, { kind: "quote", text: blockText(c) });
    } else if (c.tag === "blockquote" && parent === "root") {
      const paragraphs = elements(c);
      if (!paragraphs.every((p) => p.tag === "paragraph" && !p.attrs.heading))
        throw new Refused("a new quote holding anything but paragraphs is not supported; add it in the repository");
      insertAfter(previous, { kind: "blockquote", paragraphs: paragraphs.map(blockText) });
    } else if (c.tag === "row") {
      const cells = elements(c, "cell").map((cell) => {
        if (elements(cell).some((x) => x.tag !== "paragraph"))
          throw new Refused("a new row has a cell with a list or other content; add it in the repository");
        return elements(cell, "paragraph").map(runsToMarkdown).join(" ");
      });
      insertAfter(previous, { kind: "row", cells });
    } else if (c.tag === "list" && parentTag === "listItem") {
      if (c.attrs.kind !== "bullet" || old.kids.get(parent)!.some((k) => old.tag.get(k) === "list"))
        throw new Refused("a new nested list must be a bullet list under an item with no nested list; add it in the repository");
      for (const li of elements(c, "listItem")) {
        if (elements(li, "list").length || elements(li, "paragraph").length !== 1)
          throw new Refused("a new nested item with nested items or several paragraphs is not supported");
        ops.push({
          op: "insert", after: old.last.get(parent)!, kind: "item", like: old.src.get(parent)!, indent: 4,
          text: blockText(elements(li, "paragraph")[0]!),
        });
      }
    } else if (c.tag === "listItem") {
      if (elements(c, "list").length || elements(c, "paragraph").length !== 1)
        throw new Refused("a new list item with nested items or several paragraphs is not supported; add it in the repository");
      const like = previous === undefined ? undefined : old.src.get(previous);
      insertAfter(previous, {
        kind: "item", ...(like === undefined ? {} : { like }), text: blockText(elements(c, "paragraph")[0]!),
      });
    } else throw new Refused(`a new <${c.tag}> is not supported; add it in the repository`);
  };

  container(delta, "root");
  const open = suggestions.size;
  return {
    ops,
    report: open ? [`${open} suggestion(s) in the doc are not accepted, so their changes were left out`] : [],
  };
}

// ---- git -> doc ---------------------------------------------------------------

/** A block's text as the doc holds it: unwrapped words, or a row's cells. */
function blockTexts(lines: string[], b: Block): string[] {
  if (b.kind === "row") return splitCells(lines[b.start]!).cells.map((c) => c.trim().replaceAll("\\|", "|"));
  const text = words(blockSource(lines, b)).join(" ");
  return [b.kind === "heading" ? text.replace(/\s+#+$/, "") : text];
}

type File = { lines: string[]; blocks: Block[] };
const signature = (f: File, b: Block) => `${b.kind}\0${alnum(blockTexts(f.lines, b).join(" "))}`;
const likeness = (a: string, b: string) => ratio([...a], [...b]);

/** Which base block each surviving file block was, and the file blocks that are new. */
function alignBlocks(base: File, now: File): { mapping: Map<number, number>; added: number[] } {
  const a = base.blocks.map((b) => signature(base, b));
  const b = now.blocks.map((x) => signature(now, x));
  const kind = (s: string) => s.split("\0")[0];
  const text = (s: string) => s.split("\0")[1]!;
  const similar = (x: string, y: string) => kind(x) === kind(y) && likeness(text(x), text(y)) >= 0.5;
  if (a.length === b.length && a.every((x, i) => similar(x, b[i]!)))
    return { mapping: new Map(a.map((_, i) => [i, i])), added: [] };
  const mapping = new Map<number, number>();
  for (const [tag, a1, a2, b1, b2] of opcodes(a, b)) {
    const sameShape = a2 - a1 === b2 - b1 && a.slice(a1, a2).every((x, k) => kind(x) === kind(b[b1 + k]!));
    if (tag === "equal" || (tag === "replace" && sameShape)) {
      for (let k = 0; k < a2 - a1; k++) mapping.set(a1 + k, b1 + k);
    } else if (tag === "replace") {
      // Pair edited blocks in order by how much text they share.
      let at = b1;
      for (let i = a1; i < a2; i++) {
        let best: number | undefined;
        let bestRatio = 0.5;
        for (let j = at; j < b2; j++) {
          if (kind(a[i]!) !== kind(b[j]!)) continue;
          const r = likeness(text(a[i]!), text(b[j]!));
          if (r > bestRatio) [best, bestRatio] = [j, r];
        }
        if (best !== undefined) {
          mapping.set(i, best);
          at = best + 1;
        }
      }
    }
  }
  const matched = new Set(mapping.values());
  return { mapping, added: now.blocks.flatMap((_, i) => (matched.has(i) ? [] : [i])) };
}

function prefixSignature(b: Block): string {
  if (b.kind === "heading") return b.prefix.trim();
  if (b.kind !== "item") return "";
  const m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\])?/.exec(b.prefix)!;
  return `${m[1]!.length} ${/\d/.test(m[2]!) ? "1" : m[2]} ${(m[3] ?? "").toLowerCase()}`;
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) n++;
  return n;
}

const sameText = (a: string, b: string) => {
  const x = words(a).map(normWord);
  const y = words(b).map(normWord);
  return x.length === y.length && x.every((w, i) => w === y[i]);
};

export type DocOp = Record<string, unknown> & { op: "replace" | "delete" | "insert" };

/**
 * The doc `update` ops that bring the file's changes since the base into the doc as
 * it is now. `record` wins where both changed the same words. Anything that cannot
 * be written as plain words with certainty is named in the report. Send the ops in
 * the order given.
 */
export function docOps(
  baseText: string,
  fileText: string,
  oldXml: string,
  nowXml: string,
  record: "git" | "doc",
): { ops: DocOp[]; report: string[] } {
  const base = parse(splitFrontMatter(baseText)[1]);
  const file = parse(splitFrontMatter(fileText)[1]);
  const old = new Doc(oldXml, base);
  const now = new Doc(nowXml);
  const { mapping, added } = alignBlocks(base, file);
  const unitOf = new Map([...old.src].map(([id, n]) => [n, id]));
  const prefer = record === "git" ? "ours" : "theirs";
  const present = new Set(now.order);
  const report: string[] = [];
  if (now.suggestions)
    report.push(`${now.suggestions} suggestion(s) in the doc are open; an edit touching one is refused by the doc`);
  const replaces: [number, DocOp][] = [];
  const deletes: DocOp[] = [];
  const inserts: [number, DocOp][] = [];

  // Every text the doc can be searched in, in document order.
  const flat: [string, string][] = [];
  for (const id of now.order) {
    const cells = now.cells.get(id);
    if (cells) flat.push(...cells.map((c): [string, string] => [c.id, c.plain]));
    else if (now.plain.has(id)) flat.push([id, now.plain.get(id)!]);
  }
  const position = new Map(flat.map(([k], i) => [k, i]));
  const codeText = now.order
    .filter((id) => now.plain.has(id) && !["paragraph", "listItem"].includes(now.tag.get(id)!))
    .map((id) => now.plain.get(id)!);

  const replaceIn = (
    key: string,
    baseMd: string,
    targetMd: string,
    current: string,
    currentPlain: string,
    within?: Record<string, unknown>,
  ) => {
    const merged = merge3(baseMd, targetMd, current, prefer);
    for (const c of merged.conflicts)
      report.push(`conflict in ${key} resolved for ${record}: git '${c.ours}' / doc '${c.theirs}'`);
    if (sameText(merged.text, current)) return;
    const cw = words(current);
    const mw = words(merged.text);
    if (currentPlain !== cw.join(" ") || current !== currentPlain) {
      report.push(`${key}: changed in the file, but the doc's text has formatting or odd spacing; sync it by hand`);
      return;
    }
    const changes = opcodes(cw, mw).filter((c) => c[0] !== "equal");
    let [lo, hi] = [changes[0]![1], changes.at(-1)![2]];
    const fileWords = mw.slice(changes[0]![3], changes.at(-1)![4]);
    if (hasFormatting(fileWords.join(" "))) {
      report.push(`${key}: the file's new words contain formatting; sync it by hand`);
      return;
    }
    let replacement = fileWords.map(unescapeMarkdown);
    if (lo === hi && !cw.length) {
      report.push(`${key}: empty in the doc; sync it by hand`);
      return;
    }
    if (lo === hi) {
      // A pure insertion needs an anchor word.
      if (lo > 0) replacement = [cw[--lo]!, ...replacement];
      else replacement = [...replacement, cw[hi++]!];
    } else if (!replacement.length) {
      // A pure deletion keeps a neighbour, so the new text is not empty.
      if (lo > 0) replacement = [cw[--lo]!];
      else if (hi < cw.length) replacement = [cw[hi++]!];
      else {
        report.push(`${key}: the file empties it; delete the block by hand`);
        return;
      }
    }
    // Widen the quoted words until they are unique.
    let [start, end] = [lo, hi];
    for (;;) {
      const quoted = cw.slice(start, end).join(" ");
      const unique =
        occurrences(currentPlain, quoted) <= 1 &&
        (within !== undefined || flat.reduce((n, [, t]) => n + occurrences(t, quoted), 0) <= 1);
      if (unique || (start === 0 && end === cw.length)) break;
      if (start > 0) start--;
      if (end < cw.length) end++;
    }
    const find = cw.slice(start, end).join(" ");
    if (codeText.some((t) => t.includes(find))) {
      report.push(`${key}: the words to change also appear in a block docsync does not edit; sync it by hand`);
      return;
    }
    const text = [...cw.slice(start, lo), ...replacement, ...cw.slice(hi, end)].join(" ");
    const offset = cw.slice(0, start).join(" ").length + (start ? 1 : 0);
    const inside = offset ? Math.max(occurrences(currentPlain.slice(0, offset + find.length - 1), find) - 1, 0) : 0;
    const before = within ? 0 : flat.slice(0, position.get(key)!).reduce((n, [, t]) => n + occurrences(t, find), 0);
    replaces.push([position.get(key)!, {
      op: "replace",
      target: { kind: "find", text: find, nth: before + inside + 1, ...(within ? { within } : {}) },
      with: { from: { kind: "inline", content: text }, as: "text" },
    }]);
  };

  const blockDelete = (id: string): DocOp => ({
    op: "delete",
    target: { kind: "blocks", ids: [id] },
    ifHash: now.hash.get(id),
    ifRev: Number(now.rev ?? 0),
  });

  const signatures = new Map<string, number>();
  for (const b of base.blocks) {
    const s = signature(base, b);
    signatures.set(s, (signatures.get(s) ?? 0) + 1);
  }
  const textOf = (f: File, i: number) => JSON.stringify(blockTexts(f.lines, f.blocks[i]!));

  for (const [n, id] of [...unitOf].sort((x, y) => x[0] - y[0])) {
    const target = mapping.get(n);
    const b = base.blocks[n]!;
    const fileChanged = target !== undefined && textOf(base, n) !== textOf(file, target);
    if (b.kind === "other") {
      if (target === undefined || fileChanged) report.push(`block ${n}: changed in the file; sync it by hand`);
      continue;
    }
    if (!present.has(id)) {
      if (fileChanged) report.push(`block ${n}: deleted in the doc and changed in the file; left deleted`);
      continue;
    }
    if (target === undefined) {
      if (signatures.get(signature(base, b))! > 1) {
        report.push(`block ${n}: one of several identical blocks is gone from the file; sync it by hand`);
        continue;
      }
      if (now.tag.get(id) === "listItem" && now.kids.get(id)!.some((k) => now.tag.get(k) === "list")) {
        report.push(`block ${n}: a list item with nested items was deleted in the file; sync it by hand`);
        continue;
      }
      const untouched =
        b.kind === "row"
          ? JSON.stringify(now.cells.get(id)) === JSON.stringify(old.cells.get(id))
          : now.md.get(id) === old.md.get(id);
      if (untouched || record === "git") deletes.push(blockDelete(id));
      if (!untouched)
        report.push(`block ${n}: deleted in the file but edited in the doc; the ${record === "git" ? "file" : "doc"} wins`);
      continue;
    }
    if (prefixSignature(b) !== prefixSignature(file.blocks[target]!))
      report.push(`block ${n}: its heading level, list marker, checkbox or indent changed in the file; sync it by hand`);
    const goal = blockTexts(file.lines, file.blocks[target]!);
    if (b.kind === "row") {
      const was = old.cells.get(id)!;
      const is = now.cells.get(id)!;
      if (goal.length !== was.length || is.length !== was.length) {
        report.push(`block ${n}: the row's cells differ in number; edit it by hand`);
        continue;
      }
      const table = now.tableOf.get(id)!;
      const row = now.kids.get(table)!.indexOf(id);
      was.forEach((cell, col) => {
        replaceIn(cell.id, cell.md, goal[col]!, is[col]!.md, is[col]!.plain, { kind: "cell", table, row, col });
      });
    } else replaceIn(id, old.md.get(id)!, goal[0]!, now.md.get(id)!, now.plain.get(id)!);
  }

  const anchors = new Map<number, string>();
  for (const [n, target] of mapping) {
    const id = unitOf.get(n);
    if (id !== undefined && present.has(id)) anchors.set(target, id);
  }
  const isNew = new Set(added);
  const insertAfter = (m: number, id: string, source: Record<string, unknown>) =>
    inserts.push([m, { op: "insert", target: { kind: "blocks", ids: [id] }, side: "after", source }]);
  const markdown = (content: string) => ({ as: "markdown", from: { kind: "inline", content } });

  // A block added in the doc and since landed in the file is new on both sides.
  const bornInDoc = new Set(now.order.filter((id) => !old.tag.has(id)));
  const docWords = (id: string) => now.cells.get(id)?.map((c) => c.md).join(" ") ?? now.md.get(id) ?? "";
  const fileWords = (m: number) => unescapeMarkdown(blockTexts(file.lines, file.blocks[m]!).join(" "));
  const landed = new Set<number>();
  // Every exact pair is found before any near one is guessed.
  for (const m of added) {
    const id = [...bornInDoc].find((x) => alnum(fileWords(m)) !== "" && sameText(docWords(x), fileWords(m)));
    if (id === undefined) continue;
    bornInDoc.delete(id);
    landed.add(m);
  }
  const nearly = new Set<number>();
  for (const id of bornInDoc) {
    let best: number | undefined;
    let bestRatio = 0.8;
    for (const m of added) {
      if (landed.has(m) || nearly.has(m)) continue;
      const r = likeness(alnum(docWords(id)), alnum(fileWords(m)));
      if (r >= bestRatio) [best, bestRatio] = [m, r];
    }
    if (best !== undefined) nearly.add(best);
  }

  for (const m of added) {
    const b = file.blocks[m]!;
    if (landed.has(m)) continue;
    if (nearly.has(m)) {
      report.push(`file block ${m}: the doc added a block much like it, with different text; compare them by hand`);
      continue;
    }
    let previous: string | undefined;
    for (let k = m - 1; k >= 0 && previous === undefined; k--) previous = anchors.get(k);
    const before = file.blocks[m - 1];
    const after = file.blocks[m + 1]?.kind;
    const listy = (k?: Kind) => k === "item" || k === "row";
    // A quote new in the file goes in whole, from its first paragraph.
    const members = b.quote ? file.blocks.flatMap((x, i) => (x.quote === b.quote ? [i] : [])) : [];
    const wholeQuote = members.length > 0 && members.every((i) => isNew.has(i));
    if (wholeQuote && members[0] !== m) continue;
    if (previous === undefined) {
      report.push(`file block ${m}: new, with nothing before it in the doc to anchor to; add it by hand`);
    } else if (b.kind === "paragraph" || b.kind === "heading" || wholeQuote) {
      const texts = (wholeQuote ? members : [m]).map((i) => blockTexts(file.lines, file.blocks[i]!)[0]!);
      if (listy(before?.kind) && listy(after)) {
        report.push(`file block ${m}: new between list items or table rows; add it to the doc by hand`);
      } else if (texts.some(hasFormatting)) {
        report.push(`file block ${m}: new, with formatting; add it to the doc by hand`);
      } else {
        const escaped = texts.map(escapeFootnotes);
        const content = wholeQuote
          ? escaped.map((t) => "> " + t).join("\n>\n")
          : (b.kind === "heading" ? b.prefix.trim() + " " : "") + escaped[0]!;
        insertAfter(m, now.top.get(previous) ?? previous, markdown(content));
      }
    } else if (
      b.kind === "row" && before?.kind === "row" && b.start - before.end <= 1 &&
      now.tag.get(previous) === "row" && (anchors.get(m - 1) === previous || isNew.has(m - 1))
    ) {
      const cells = blockTexts(file.lines, b);
      if (cells.length !== now.cells.get(previous)!.length) {
        report.push(`file block ${m}: a new table row with a different number of cells than its table; add it by hand`);
      } else if (cells.some(hasFormatting)) {
        report.push(`file block ${m}: a new table row with formatting; add it to the doc by hand`);
      } else {
        insertAfter(m, previous, {
          as: "blocks",
          from: {
            kind: "inline",
            content: [{
              type: "row",
              content: cells.map((c) => ({
                type: "cell",
                content: [{ type: "paragraph", content: [{ type: "text", text: unescapeMarkdown(c) }] }],
              })),
            }],
          },
        });
      }
    } else report.push(`file block ${m} (${b.kind}): new in the file; add it to the doc by hand`);
  }

  // Deleting every row of a table, or paragraph of a quote, deletes the whole block.
  const groups = new Map<string, DocOp[]>();
  const idOf = (d: DocOp) => (d.target as { ids: string[] }).ids[0]!;
  for (const d of deletes) {
    const parent = now.tableOf.get(idOf(d)) ?? now.quoteOf.get(idOf(d)) ?? "";
    groups.set(parent, [...(groups.get(parent) ?? []), d]);
  }
  let finalDeletes: DocOp[] = [];
  for (const [parent, group] of groups) {
    const gone = new Set(group.map(idOf));
    const members = parent ? now.kids.get(parent)! : [];
    if (!parent) finalDeletes.push(...group);
    else if (members.every((k) => gone.has(k))) finalDeletes.push(blockDelete(parent));
    else if (now.tag.get(parent) === "table" && gone.has(members[0]!)) {
      report.push(`table ${parent}: the file removes its header row but keeps other rows; sync it by hand`);
      finalDeletes.push(...group.filter((d) => idOf(d) !== members[0]));
    } else finalDeletes.push(...group);
  }
  if (report.some((r) => r.includes("nothing before it in the doc"))) {
    const firstKept = Math.min(base.blocks.length, ...[...anchors.values()].map((id) => old.src.get(id)!));
    finalDeletes = finalDeletes.filter((d) => {
      const at = old.src.get(idOf(d)) ?? old.first.get(idOf(d)) ?? base.blocks.length;
      if (at >= firstKept) return true;
      report.push(`${idOf(d)}: not deleted, because the file also adds a block before the doc's first surviving one`);
      return false;
    });
  }
  const lastFirst = (list: [number, DocOp][]) => list.sort((x, y) => y[0] - x[0]).map((x) => x[1]);
  return { ops: [...lastFirst(replaces), ...finalDeletes, ...lastFirst(inserts)], report };
}
