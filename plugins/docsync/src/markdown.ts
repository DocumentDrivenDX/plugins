// A file as a list of addressable blocks, patched without touching other bytes.
import { opcodes } from "./difflib.ts";
import { ESCAPED, escapeFootnotes } from "./markers.ts";

export class Refused extends Error {}

export type Kind = "heading" | "paragraph" | "item" | "row" | "quote" | "other";

export interface Block {
  kind: Kind;
  start: number;
  end: number;
  prefix: string;
  /** For a quote paragraph: the lines of its whole quote, without and with its attribute line. */
  quote?: { start: number; end: number; attrEnd: number };
}

export type Op =
  | { op: "replace"; block: number; text: string; cell?: number }
  | { op: "delete"; block: number }
  | {
      op: "insert";
      after: number;
      kind?: "paragraph" | "heading" | "item" | "row" | "quote" | "blockquote";
      text?: string;
      level?: number;
      like?: number;
      indent?: number;
      cells?: string[];
      paragraphs?: string[];
    };

const ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;
const HEADING = /^#{1,6}\s/;
const SEPARATOR = /^\s*\|?[\s:|-]+\|?\s*$/;
const FENCE = /^\s*(```|~~~)/;
const THEMATIC = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const SETEXT = /^\s*(=+|-+)\s*$/;
const FOOTNOTE_DEF = /^\[\^[^\]\s]+\]:/;
const QUOTE = /^ {0,3}> ?/;
const ATTRIBUTE_LINE = /^\s{0,3}\{[.#A-Za-z](?:[^{}"]|"(?:[^"\\]|\\.)*")*\}\s*$/;

const blank = (line: string) => !line.trim();
const isSeparator = (line: string) => SEPARATOR.test(line) && line.includes("-");

function startsBlock(line: string): boolean {
  return (
    blank(line) ||
    HEADING.test(line) ||
    ITEM.test(line) ||
    FENCE.test(line) ||
    FOOTNOTE_DEF.test(line) ||
    /^\s*[|><]/.test(line)
  );
}

export function wouldStartABlock(text: string): boolean {
  return (
    HEADING.test(text) ||
    ITEM.test(text) ||
    FENCE.test(text) ||
    THEMATIC.test(text) ||
    SETEXT.test(text) ||
    /^\s*[|><]/.test(text)
  );
}

export function splitFrontMatter(text: string): [string, string] {
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 3);
    if (end >= 0) return [text.slice(0, end + 5), text.slice(end + 5)];
    if (text.endsWith("\n---")) return [text, ""];
  }
  return ["", text];
}

/** The quote starting at line i: one block per paragraph, or one `other` block. */
function parseQuote(lines: string[], i: number): { blocks: Block[]; next: number } {
  let end = i;
  while (end < lines.length && QUOTE.test(lines[end]!)) end++;
  const attribute = end < lines.length && ATTRIBUTE_LINE.test(lines[end]!);
  const attrEnd = attribute ? end + 1 : end;
  const content = lines.slice(i, end).map((l) => l.replace(QUOTE, ""));
  const lazy = attrEnd < lines.length && !startsBlock(lines[attrEnd]!);
  const nested = content.some((c) => !blank(c) && (wouldStartABlock(c) || /^( {4}|\t)/.test(c)));
  if (lazy || nested || content.every(blank)) {
    let j = end;
    while (j < lines.length && !blank(lines[j]!)) j++;
    return { blocks: [{ kind: "other", start: i, end: j, prefix: "" }], next: j };
  }
  const quote = { start: i, end, attrEnd };
  const blocks: Block[] = [];
  for (let k = 0; k < content.length; ) {
    if (blank(content[k]!)) {
      k++;
      continue;
    }
    let m = k;
    while (m < content.length && !blank(content[m]!)) m++;
    blocks.push({
      kind: "quote",
      start: i + k,
      end: i + m,
      prefix: QUOTE.exec(lines[i + k]!)![0],
      quote,
    });
    k = m;
  }
  return { blocks, next: attrEnd };
}

export function parse(body: string): { lines: string[]; blocks: Block[] } {
  const lines = body.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const push = (kind: Kind, end: number, prefix = "") => {
    blocks.push({ kind, start: i, end, prefix });
    i = end;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (blank(line)) {
      i++;
    } else if (fence) {
      let j = i + 1;
      while (j < lines.length && !lines[j]!.trimStart().startsWith(fence[1]!)) j++;
      push("other", Math.min(j + 1, lines.length));
    } else if (HEADING.test(line)) {
      push("heading", i + 1, HEADING.exec(line)![0]);
    } else if (line.trimStart().startsWith("|")) {
      while (i < lines.length && lines[i]!.trimStart().startsWith("|")) {
        if (!isSeparator(lines[i]!)) blocks.push({ kind: "row", start: i, end: i + 1, prefix: "" });
        i++;
      }
    } else if (QUOTE.test(line)) {
      const quoted = parseQuote(lines, i);
      blocks.push(...quoted.blocks);
      i = quoted.next;
    } else if (line.trimStart().startsWith("<")) {
      let j = i + 1;
      while (j < lines.length && !blank(lines[j]!)) j++;
      push("other", j);
    } else if (THEMATIC.test(line)) {
      push("other", i + 1);
    } else if (ITEM.test(line)) {
      let j = i + 1;
      while (j < lines.length && !startsBlock(lines[j]!)) j++;
      push("item", j, ITEM.exec(line)![0]);
    } else {
      let j = i + 1;
      while (j < lines.length && !startsBlock(lines[j]!)) j++;
      push("paragraph", j);
    }
  }
  return { lines, blocks };
}

/** A block's source text without its list, heading or quote prefix, line breaks kept. */
export function blockSource(lines: string[], b: Block): string {
  if (b.kind === "quote") return lines.slice(b.start, b.end).map((l) => l.replace(QUOTE, "")).join("\n");
  return [lines[b.start]!.slice(b.prefix.length), ...lines.slice(b.start + 1, b.end)].join("\n");
}

export const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** A word with escapes, emphasis style, autolinks and a hard-break backslash made alike. */
export function normWord(word: string): string {
  let w = word.replace(ESCAPED, "$1");
  w = w.replace(/^<(https?:\/\/[^>\s]+)>$/, "[$1]($1)");
  w = w.replace(/^_+|_+$/g, (m) => "*".repeat(m.length));
  return w.endsWith("\\") && w.length > 1 ? w.slice(0, -1) : w;
}

/** `old` with only the words that differ from `next` replaced; kept words keep spacing and escapes. */
export function patchWords(old: string, next: string): string {
  const pieces = [...old.matchAll(/(\s*)(\S+)/g)];
  const seps = pieces.map((p) => p[1]!);
  const oldWords = pieces.map((p) => p[2]!);
  const newWords = words(next);
  const a = oldWords.map(normWord);
  const b = newWords.map(normWord);
  if (a.length === b.length && a.every((w, k) => w === b[k])) return old;
  const lead = seps[0] ?? "";
  const out: string[] = [];
  const emit = (sep: string, word: string) => out.push((out.length ? sep : lead) + word);
  for (const [tag, a1, a2, b1, b2] of opcodes(a, b)) {
    if (tag === "equal") for (let k = a1; k < a2; k++) emit(k ? seps[k]! : " ", oldWords[k]!);
    else if (tag !== "delete") for (let k = b1; k < b2; k++) emit(" ", newWords[k]!);
  }
  return out.join("") + /\s*$/.exec(old)![0];
}

export function splitCells(line: string): { indent: string; cells: string[]; closed: boolean; trail: string } {
  const indent = /^\s*/.exec(line)![0];
  const trail = /\s*$/.exec(line)![0];
  let inner = line.trim().slice(1);
  const closed = inner.endsWith("|") && !inner.endsWith("\\|");
  if (closed) inner = inner.slice(0, -1);
  return { indent, cells: inner.split(/(?<!\\)\|/), closed, trail };
}

const escapeCell = (text: string) => text.replace(/(?<!\\)\|/g, "\\|");

const numbered = (b: Block) => /^\s*\d/.test(b.prefix);

/** The indexes of the items that form one list with item k. */
function listGroup(blocks: Block[], k: number): number[] {
  let lo = k;
  let hi = k;
  while (lo > 0 && blocks[lo - 1]!.kind === "item" && blocks[lo]!.start <= blocks[lo - 1]!.end + 1) lo--;
  while (hi + 1 < blocks.length && blocks[hi + 1]!.kind === "item" && blocks[hi + 1]!.start <= blocks[hi]!.end + 1)
    hi++;
  return Array.from({ length: hi - lo + 1 }, (_, n) => lo + n);
}

function plainText(text: unknown, what: string, emptyOk = false): string {
  if (typeof text !== "string") throw new Refused(`${what} needs \`text\` as a string`);
  if (text.includes("\n")) throw new Refused(`${what}: \`text\` is one paragraph and has no line breaks`);
  if (!text.trim() && !emptyOk) throw new Refused(`${what}: the new text is empty; delete the block instead`);
  return text;
}

function newText(text: unknown, what: string): string {
  const t = plainText(text, what);
  if (wouldStartABlock(t)) throw new Refused(`${what} would read as a heading, list, table or quote`);
  return t;
}

export function validateOps(ops: unknown): asserts ops is Op[] {
  if (!Array.isArray(ops) || !ops.every((o) => o && typeof o === "object" && !Array.isArray(o)))
    throw new Refused("`ops` must be a list of operations");
  for (const o of ops as Record<string, unknown>[]) {
    for (const key of ["block", "after", "cell", "like", "level", "indent"])
      if (key in o && !Number.isInteger(o[key]))
        throw new Refused(`\`${key}\` must be an integer in ${JSON.stringify(o)}`);
    if ("level" in o && !((o.level as number) >= 1 && (o.level as number) <= 6))
      throw new Refused(`\`level\` must be 1 to 6 in ${JSON.stringify(o)}`);
    for (const key of ["cells", "paragraphs"])
      if (key in o && !(Array.isArray(o[key]) && (o[key] as unknown[]).every((c) => typeof c === "string")))
        throw new Refused(`\`${key}\` must be a list of strings in ${JSON.stringify(o)}`);
  }
}

export function applyOps(body: string, ops: unknown): string {
  validateOps(ops);
  const { lines, blocks } = parse(body);
  const edits: { start: number; end: number; repl: string[] }[] = [];
  const inserts = new Map<number, string[]>();
  const seen = new Set<string>();
  const cellEdits = new Map<number, Map<number, string>>();
  const deleted = new Set(ops.flatMap((o) => (o.op === "delete" ? [o.block] : [])));
  const numberedAdds = new Map<number, number>();
  const goneQuotes = new Set<number>();

  const block = (n: number): Block => {
    const b = Number.isInteger(n) ? blocks[n] : undefined;
    if (!b) throw new Refused(`block ${n} does not exist (the file has ${blocks.length} blocks, numbered from 0)`);
    return b;
  };
  const insertAt = (at: number, add: string[]) => inserts.set(at, [...(inserts.get(at) ?? []), ...add]);

  const tableRows = (n: number): number[] => {
    // Rows a and b are lines of one table when adjacent or split only by its separator.
    const joined = (a: number, b: number) => {
      const gap = blocks[b]!.start - blocks[a]!.end;
      return gap === 0 || (gap === 1 && isSeparator(lines[blocks[a]!.end]!));
    };
    let lo = n;
    let hi = n;
    while (lo > 0 && blocks[lo - 1]!.kind === "row" && joined(lo - 1, lo)) lo--;
    while (hi + 1 < blocks.length && blocks[hi + 1]!.kind === "row" && joined(hi, hi + 1)) hi++;
    return Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
  };

  const quoteMembers = (b: Block) => blocks.flatMap((x, k) => (x.quote === b.quote ? [k] : []));

  for (const op of ops) {
    if (op.op === "replace" || op.op === "delete") {
      const n = op.block;
      const b = block(n);
      const cell = op.op === "replace" ? op.cell : undefined;
      const key = op.op === "replace" && b.kind === "row" ? `${n}:${cell}` : `${n}`;
      const touched = [...seen].some((s) => s === `${n}` || s.startsWith(`${n}:`));
      if (seen.has(key) || (touched && (op.op === "delete" || key === `${n}`)) || seen.has(`${n}`))
        throw new Refused(`block ${n} is edited twice`);
      seen.add(key);
      if (b.kind === "other")
        throw new Refused(`block ${n} is code, HTML, a rule or a quote with structure; edit it in the repository`);
      if (cell !== undefined && b.kind !== "row")
        throw new Refused(`block ${n} is not a table row, so \`cell\` does not apply`);
      if (op.op === "delete") {
        let start = b.start;
        let end = b.end;
        if (b.kind === "item" && numbered(b) && listGroup(blocks, n).some((k) => k > n && !deleted.has(k)))
          throw new Refused(`block ${n} is a numbered item that is not last; deleting it would renumber the list`);
        if (b.kind === "row") {
          const rows = tableRows(n);
          if (n === rows[0]) {
            if (rows.some((k) => !deleted.has(k)))
              throw new Refused(`block ${n} is the header row of a table that keeps other rows; edit it in the repository`);
            if (end < lines.length && isSeparator(lines[end]!)) end++;
          }
        }
        if (b.kind === "quote") {
          const members = quoteMembers(b);
          if (members.every((k) => deleted.has(k))) {
            if (goneQuotes.has(b.quote!.start)) continue;
            goneQuotes.add(b.quote!.start);
            start = b.quote!.start;
            end = b.quote!.attrEnd;
            if (end < lines.length - 1 && blank(lines[end]!)) end++;
          } else if (members.some((k) => k > n && !deleted.has(k))) {
            // The bare `>` lines after this paragraph go with it.
            while (end < b.quote!.end && blank(lines[end]!.replace(QUOTE, ""))) end++;
          } else {
            // The last paragraphs go with the bare `>` lines before them.
            while (start > b.quote!.start && blank(lines[start - 1]!.replace(QUOTE, ""))) start--;
          }
        }
        if ((b.kind === "paragraph" || b.kind === "heading") && end < lines.length - 1 && blank(lines[end]!)) end++;
        edits.push({ start, end, repl: [] });
      } else if (b.kind === "row") {
        const count = splitCells(lines[b.start]!).cells.length;
        if (cell === undefined || cell < 0 || cell >= count)
          throw new Refused(`block ${n} is a table row with ${count} cells; \`cell\` is required`);
        const row = cellEdits.get(n) ?? new Map<number, string>();
        cellEdits.set(n, row.set(cell, plainText(op.text, `block ${n}`, true)));
      } else {
        const text = plainText(op.text, `block ${n}`);
        const old = blockSource(lines, b);
        const next = patchWords(old, text);
        if (next === old) continue;
        if (b.kind !== "heading" && wouldStartABlock(next.trimStart().split("\n")[0]!) && !wouldStartABlock(old))
          throw new Refused(`the new text of block ${n} would read as a heading, list, table or quote`);
        const repl =
          b.kind === "quote"
            ? next.split("\n").map((l, k) => {
                const original = k < b.end - b.start ? QUOTE.exec(lines[b.start + k]!)![0] : b.prefix;
                return original + l;
              })
            : (b.prefix + next).split("\n");
        edits.push({ start: b.start, end: b.end, repl });
      }
    } else if (op.op === "insert") {
      const b = block(op.after);
      const what = op.kind ?? "paragraph";
      // Anything but another quote paragraph goes after the whole quote.
      let at = b.end;
      if (b.kind === "quote" && what !== "quote") {
        if (quoteMembers(b).at(-1) !== op.after)
          throw new Refused(`cannot insert inside the quote after block ${op.after}; edit it in the repository`);
        at = b.quote!.attrEnd;
      }
      const spaced = (add: string[]) => ["", ...add, ...(at < lines.length && !blank(lines[at]!) ? [""] : [])];
      if (what === "row") {
        if (b.kind !== "row") throw new Refused(`cannot insert a row after block ${op.after}: it is not a table row`);
        if (!op.cells) throw new Refused("a row insert needs `cells`");
        for (const c of op.cells) plainText(c, "a new row's cell", true);
        const count = splitCells(lines[b.start]!).cells.length;
        if (op.cells.length !== count)
          throw new Refused(`a new row needs ${count} cells like its table, not ${op.cells.length}`);
        const below = b.end < lines.length && isSeparator(lines[b.end]!) ? b.end + 1 : b.end;
        insertAt(below, ["| " + op.cells.map(escapeCell).join(" | ") + " |"]);
      } else if (what === "item") {
        const likeIndex = op.like ?? op.after;
        const like = block(likeIndex);
        if (like.kind !== "item")
          throw new Refused(`cannot insert an item after block ${op.after}: it is not a list item`);
        const text = newText(op.text, "the new item text");
        let prefix = like.prefix;
        if (op.indent !== undefined) {
          prefix = /^\s*/.exec(like.prefix)![0] + " ".repeat(op.indent) + "- ";
        } else if (numbered(like)) {
          const group = listGroup(blocks, likeIndex);
          if (likeIndex !== group.at(-1) || group.some((k) => deleted.has(k)))
            throw new Refused(`cannot insert after numbered item ${likeIndex}: items would need renumbering`);
          const added = (numberedAdds.get(likeIndex) ?? 0) + 1;
          numberedAdds.set(likeIndex, added);
          prefix = prefix.replace(/\d+/, (d) => String(Number(d) + added));
        }
        insertAt(b.end, [prefix.replace(/\[[xX]\]/, "[ ]") + text]);
      } else if (what === "quote") {
        if (b.kind !== "quote")
          throw new Refused(`cannot insert a quoted paragraph after block ${op.after}: it is not quoted`);
        insertAt(at, [b.prefix.trimEnd(), b.prefix + newText(op.text, "a new quoted paragraph")]);
      } else if (what === "blockquote") {
        if (!op.paragraphs?.length) throw new Refused("a new quote needs `paragraphs`");
        const quoted = op.paragraphs.flatMap((p, k) => [
          ...(k ? [">"] : []),
          "> " + newText(p, "a new quoted paragraph"),
        ]);
        insertAt(at, spaced(quoted));
      } else if (what === "paragraph") {
        insertAt(at, spaced([newText(op.text, "the new paragraph")]));
      } else if (what === "heading") {
        insertAt(at, spaced(["#".repeat(op.level ?? 2) + " " + plainText(op.text, "an inserted heading")]));
      } else {
        throw new Refused(`unknown insert kind ${JSON.stringify(what)}`);
      }
    } else {
      throw new Refused(`unknown op ${JSON.stringify((op as { op?: unknown }).op)}`);
    }
  }
  for (const [n, row] of cellEdits) {
    const b = blocks[n]!;
    const { indent, cells, closed, trail } = splitCells(lines[b.start]!);
    for (const [c, text] of row) {
      const cell = cells[c]!;
      const empty = !cell.trim();
      const lead = empty ? " " : /^\s*/.exec(cell)![0];
      const tail = empty ? " " : /\s*$/.exec(cell)![0];
      cells[c] = lead + escapeCell(patchWords(cell.trim().replaceAll("\\|", "|"), text)) + tail;
    }
    edits.push({ start: b.start, end: b.end, repl: [indent + "|" + cells.join("|") + (closed ? "|" : "") + trail] });
  }
  for (const [at, repl] of inserts) edits.push({ start: at, end: at, repl });
  edits.sort((x, y) => y.start - x.start || y.end - x.end);
  for (const e of edits) lines.splice(e.start, e.end - e.start, ...e.repl);
  return lines.join("\n");
}

export function applyText(text: string, ops: unknown): string {
  refuseCrlf(text);
  const [front, body] = splitFrontMatter(text);
  return front + applyOps(body, ops);
}

export function refuseCrlf(text: string): void {
  if (text.includes("\r"))
    throw new Refused("the file has CRLF line endings; convert it to LF or edit it in the repository");
}

/**
 * The Markdown to create a doc from: the body with each paragraph on one line,
 * footnotes as literal text, and without front matter or quote attribute lines.
 */
export function prepare(text: string): string {
  refuseCrlf(text);
  const { lines, blocks } = parse(splitFrontMatter(text)[1]);
  const out: string[] = [];
  let at = 0;
  const unwrap = (source: string) =>
    source
      .split(/(?<=\\|  )\n/)
      .map((part) => part.trim().replace(/\s*\n\s*/g, " "))
      .join("\\\n");
  let previous: Block | undefined;
  for (const b of blocks) {
    if (b.start < at) continue;
    const between = lines.slice(at, b.start);
    out.push(...between);
    // Adjacent footnote definitions must stay separate paragraphs in the doc.
    if (b.kind === "paragraph" && previous && !between.length) out.push("");
    if (b.kind === "other") {
      out.push(...lines.slice(b.start, b.end));
      at = b.end;
    } else if (b.kind === "row") {
      out.push(escapeFootnotes(lines[b.start]!));
      at = b.end;
    } else if (b.kind === "quote") {
      const members = blocks.filter((x) => x.quote === b.quote);
      members.forEach((m, k) => {
        if (k) out.push(">");
        out.push("> " + escapeFootnotes(unwrap(blockSource(lines, m))));
      });
      at = b.quote!.attrEnd;
    } else {
      out.push(escapeFootnotes(b.prefix + unwrap(blockSource(lines, b))));
      at = b.end;
    }
    previous = b;
  }
  out.push(...lines.slice(at));
  return out.join("\n");
}
