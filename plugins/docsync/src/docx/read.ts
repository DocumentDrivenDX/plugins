// A .docx as a list of units, each the Markdown of one block, with the place in the
// XML of every character so that a patch can change just those.
import { likeness } from "../align.ts";
import { ratio } from "../difflib.ts";
import { Refused } from "../markdown.ts";
import { markerSpans } from "../markers.ts";
import { type Atom, render, visible } from "./inline.ts";
import { kid, kids, type Node, parsePart, textOf, walk } from "./xml.ts";
import { entryText, type Entry, readZip } from "./zip.ts";

/** Raised when a change to how a .docx is read would make old snapshots wrong. */
export const READER = 1;

export type UnitKind = "heading" | "paragraph" | "quote" | "item" | "row" | "footnote";

export interface Unit {
  kind: UnitKind;
  /** Markdown without any block prefix. For a row, "". */
  text: string;
  cells?: string[];
  level?: number;
  ordered?: boolean;
  /** Which table a row is in, counted from 0. */
  table?: number;
  label?: string;
  noteId?: string;
}

/** One character of a paragraph: where it sits in a text element, or nowhere editable. */
export interface Char extends Atom {
  at?: { t: Node; offset: number; run: Node };
}

export interface Para {
  node: Node;
  chars: Char[];
}

export interface Place {
  part: "word/document.xml" | "word/footnotes.xml";
  /** The paragraph, or the table row. */
  node: Node;
  /** For a row, its table. */
  table?: Node;
  paras: Para[];
  /** Why push must not edit this unit, when it must not. */
  locked?: string;
}

export interface Style {
  name: string;
  numbered: boolean;
  basedOn?: string;
  b?: boolean;
  i?: boolean;
}

export interface Word {
  entries: Entry[];
  parts: Map<string, { text: string; root: Node }>;
  units: Unit[];
  places: Place[];
  styles: Map<string, Style>;
  /** The paragraphs, tables and footnotes left out of `units`, each with how many units come before it. */
  unread: { text: string; after: number }[];
  /** What a person should know: pending changes, content left out. */
  notes: string[];
}

const NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REVISION_OUT = new Set(["w:ins", "w:moveTo"]);
const REVISION_KEPT = new Set(["w:del", "w:moveFrom"]);
/** Elements of a paragraph that hold no text of their own. */
const MARKS = /^w:(pPr|proofErr|bookmark(Start|End)|comment(RangeStart|RangeEnd)|perm(Start|End)|move(From|To)Range(Start|End)|customXml\w*Range(Start|End)|sdtPr|sdtEndPr|smartTagPr|customXmlPr)$/;
const TRANSPARENT = new Set(["w:smartTag", "w:customXml", "w:dir", "w:bdo"]);
/** Content that stays in place while the text around it is synced. */
const OBJECTS = new Set(["w:drawing", "w:pict", "w:object"]);
const CURLY: Record<string, string> = { "“": '"', "”": '"', "‘": "'", "’": "'" };
/** Paragraphs in this style are written by `create` for blocks Word cannot edit safely. */
export const FIXED_STYLE = "docsync fixed";

const toggled = (e: Node | undefined) => (e ? !["0", "false", "off", "none"].includes(e.attrs["w:val"] ?? "") : undefined);

/** True when an element holds words that leaving it out would lose. */
const holdsText = (n: Node) => [...walk(n)].some((x) => ["w:t", "w:delText", "m:t", "w:sym"].includes(x.name));
const isObject = (n: Node) =>
  OBJECTS.has(n.name) || (n.name === "mc:AlternateContent" && [...walk(n)].some((x) => OBJECTS.has(x.name)));

/** Every word in an element, for knowing what is in content left unread. */
const allText = (n: Node): string =>
  n.name === "w:t" || n.name === "w:delText" || n.name === "m:t"
    ? textOf(n)
    : n.name === "w:instrText"
      ? ""
      : kids(n).map(allText).join(n.name === "w:p" || n.name === "w:tc" ? "" : " ");

interface Context {
  styles: Map<string, Style>;
  rels: Map<string, string>;
  /** Word's footnote ID to the Markdown label. */
  labels: Map<string, string>;
}

interface Read {
  chars: Char[];
  pending: number;
  locked?: string;
  /** Content with no Markdown form that makes the whole paragraph unreadable. */
  opaque?: string;
  /** Pictures and the like, which stay in place. */
  objects: number;
  notes: string[];
}

function readParagraph(p: Node, context: Context): Read {
  const out: Read = { chars: [], pending: 0, objects: 0, notes: [] };
  let field = 0;
  const lock = (why: string) => (out.locked ??= why);
  const add = (c: string, run: Node, style: { b: boolean; i: boolean }, href?: string, at?: Char["at"]) =>
    out.chars.push({ c, ...style, ...(href === undefined ? {} : { href }), ...(at ? { at } : {}) });
  /** Bold or italic from the run itself, or else from its character style. */
  const styled = (properties: Node | undefined, key: "b" | "i") => {
    const own = toggled(kid(properties, `w:${key}`));
    if (own !== undefined) return own;
    let id = kid(properties, "w:rStyle")?.attrs["w:val"];
    for (let depth = 0; id !== undefined && depth < 10; depth++) {
      const style = context.styles.get(id);
      if (style?.[key] !== undefined) return style[key]!;
      id = style?.basedOn;
    }
    return false;
  };
  const run = (r: Node, href: string | undefined, kept: boolean) => {
    const properties = kid(r, "w:rPr");
    const style = { b: styled(properties, "b"), i: styled(properties, "i") };
    if (toggled(kid(properties, "w:vanish")) && holdsText(r)) out.opaque ??= "hidden text";
    if (properties && kid(properties, "w:rPrChange")) out.pending++;
    for (const c of kids(r)) {
      if (c.name === "w:t" || (kept && c.name === "w:delText")) {
        const text = textOf(c);
        for (let k = 0; k < text.length; k++) {
          const ch = /[\t\r\n]/.test(text[k]!) ? " " : text[k]!;
          add(ch, r, style, href, field || kept || c.name !== "w:t" ? undefined : { t: c, offset: k, run: r });
        }
      } else if (c.name === "w:tab" || c.name === "w:ptab" || c.name === "w:cr" || c.name === "w:br") add(" ", r, style, href);
      else if (c.name === "w:noBreakHyphen") add("-", r, style, href);
      else if (c.name === "w:footnoteReference") {
        const label = context.labels.get(c.attrs["w:id"] ?? "");
        if (label !== undefined) out.chars.push({ c: "", b: false, i: false, fn: label });
      } else if (c.name === "w:endnoteReference") out.opaque ??= "an endnote";
      else if (c.name === "w:sym") out.opaque ??= "a symbol character";
      else if (c.name === "w:fldChar") {
        lock("a field, such as a cross-reference or a reference manager's citation");
        if (c.attrs["w:fldCharType"] === "begin") field++;
        if (c.attrs["w:fldCharType"] === "end") field = Math.max(0, field - 1);
      } else if (isObject(c)) out.objects++;
      else if (!["w:instrText", "w:delInstrText", "w:delText", "w:rPr"].includes(c.name) && holdsText(c))
        out.opaque ??= "content docsync does not know";
    }
  };
  const inside = (node: Node, href: string | undefined, kept: boolean) => {
    for (const c of kids(node)) {
      if (c.name === "w:r") run(c, href, kept);
      else if (REVISION_OUT.has(c.name)) out.pending++;
      else if (REVISION_KEPT.has(c.name)) {
        out.pending++;
        inside(c, href, true);
      } else if (c.name === "w:hyperlink") {
        let target = context.rels.get(c.attrs["r:id"] ?? "");
        const anchor = c.attrs["w:anchor"];
        if (target && anchor && !target.includes("#")) target += `#${anchor}`;
        if (target && /[\s()]/.test(target)) lock("a link whose address Markdown cannot hold");
        inside(c, target && !/[\s()]/.test(target) ? target : href, kept);
      } else if (c.name === "w:fldSimple") {
        lock("a field, such as a cross-reference or a page number");
        field++;
        inside(c, href, kept);
        field--;
      } else if (c.name === "w:sdt") {
        const content = kid(c, "w:sdtContent");
        if (content) inside(content, href, kept);
      } else if (TRANSPARENT.has(c.name)) inside(c, href, kept);
      else if (c.name === "m:oMath" || c.name === "m:oMathPara") out.opaque ??= "an equation";
      else if (isObject(c)) out.objects++;
      else if (!MARKS.test(c.name) && holdsText(c)) out.opaque ??= "content docsync does not know";
    }
  };
  inside(p, undefined, false);
  const mark = kid(kid(p, "w:pPr"), "w:rPr");
  if (mark && (kid(mark, "w:ins") || kid(mark, "w:del"))) out.pending++;
  if (kid(kid(p, "w:pPr"), "w:pPrChange")) out.pending++;
  if (out.pending) out.locked = "a pending tracked change";
  straightenMarkers(out.chars);
  return out;
}

/** Word's autocorrect curls quotation marks; inside a marker they are syntax. */
function straightenMarkers(chars: Char[]): void {
  const plain = chars.map((c) => (c.fn === undefined ? c.c : "\u0000")).join("");
  const straight = plain.replace(/[“”‘’]/g, (c) => CURLY[c]!);
  for (const [a, b] of markerSpans(straight))
    for (let k = a; k < b; k++) {
      // Only attribute values and syntax: curly marks inside a value are the author's words.
      if (CURLY[plain[k]!] && /(=\s*|\{)$/.test(straight.slice(a, k))) {
        const close = plain.slice(k + 1, b).search(/[“”"](?=\s*[;\]}]|\s+[\w-]+=|\s+[.#])/);
        chars[k]!.c = '"';
        if (close >= 0) chars[k + 1 + close]!.c = '"';
      }
    }
}

/** Space at either end is not part of a Markdown block. */
const trimmed = (chars: Char[]): Char[] => {
  let a = 0;
  let b = chars.length;
  while (a < b && /^\s$/.test(chars[a]!.c)) a++;
  while (b > a && /^\s$/.test(chars[b - 1]!.c)) b--;
  return chars.slice(a, b);
};

/** The elements named, looking through content controls and other wrappers. */
function* within(node: Node, names: string[], tracked: { pending: number } = { pending: 0 }): Generator<Node> {
  for (const c of kids(node)) {
    if (names.includes(c.name)) yield c;
    else if (c.name === "w:sdt") {
      const content = kid(c, "w:sdtContent");
      // A generated table of contents is not the author's text.
      if (content && !kid(kid(c, "w:sdtPr"), "w:docPartObj")) yield* within(content, names, tracked);
    } else if (c.name === "w:customXml") yield* within(c, names, tracked);
    else if (c.name === "w:ins" || c.name === "w:moveTo") tracked.pending++;
    else if (c.name === "w:del" || c.name === "w:moveFrom") {
      tracked.pending++;
      yield* within(c, names, tracked);
    }
  }
}

const bodyBlocks = (node: Node, tracked?: { pending: number }) => within(node, ["w:p", "w:tbl"], tracked);

/** A footnote the base already knows, so that it keeps its label. */
export interface KnownNote {
  noteId?: string;
  label: string;
  text: string;
  /** The words before its reference, and the whole block that cites it. */
  before?: string;
  block?: string;
}

export function readWord(bytes: Uint8Array, known: KnownNote[] = []): Word {
  const entries = readZip(bytes);
  const parts = new Map<string, { text: string; root: Node }>();
  const part = (name: string) => {
    const text = entryText(entries, name);
    if (text === undefined) return undefined;
    const root = parsePart(text);
    parts.set(name, { text, root });
    return root;
  };
  if (entries.some((e) => /vbaProject\.bin$/i.test(e.name))) throw new Refused("the Word file holds macros, which docsync does not open");
  const main = part("word/document.xml");
  if (!main) throw new Refused("the file has no word/document.xml; it is not a Word document");
  if (main.attrs["xmlns:w"] !== NAMESPACE)
    throw new Refused("the Word file uses a form of the format docsync does not read (such as Strict Open XML)");

  const styles = new Map<string, Style>();
  const styleRoot = part("word/styles.xml");
  for (const s of styleRoot ? kids(styleRoot, "w:style") : []) {
    const rPr = kid(s, "w:rPr");
    const [b, i] = [toggled(kid(rPr, "w:b")), toggled(kid(rPr, "w:i"))];
    const basedOn = kid(s, "w:basedOn")?.attrs["w:val"];
    styles.set(s.attrs["w:styleId"] ?? "", {
      name: (kid(s, "w:name")?.attrs["w:val"] ?? "").toLowerCase(),
      numbered: Boolean(kid(kid(s, "w:pPr"), "w:numPr")),
      ...(basedOn === undefined ? {} : { basedOn }), ...(b === undefined ? {} : { b }), ...(i === undefined ? {} : { i }),
    });
  }
  const formats = new Map<string, string>();
  const numbering = part("word/numbering.xml");
  if (numbering) {
    const abstract = new Map(kids(numbering, "w:abstractNum").map((a) => [a.attrs["w:abstractNumId"], a]));
    for (const num of kids(numbering, "w:num")) {
      const definition = abstract.get(kid(num, "w:abstractNumId")?.attrs["w:val"]);
      for (const level of definition ? kids(definition, "w:lvl") : [])
        formats.set(`${num.attrs["w:numId"]} ${level.attrs["w:ilvl"]}`, kid(level, "w:numFmt")?.attrs["w:val"] ?? "");
    }
  }
  const rels = new Map<string, string>();
  const relRoot = part("word/_rels/document.xml.rels");
  // Targets are only ever read back as text; nothing is fetched or opened.
  for (const r of relRoot ? kids(relRoot, "Relationship") : [])
    if (r.attrs.TargetMode === "External") rels.set(r.attrs.Id ?? "", r.attrs.Target ?? "");

  const left = new Map<string, number>();
  const leave = (what: string, n = 1) => left.set(what, (left.get(what) ?? 0) + n);
  const tracked = { pending: 0 };
  const unread: { text: string; after: number }[] = [];
  let pending = 0;
  const notes: string[] = [];

  // Footnotes are read first, so that each has its label before the body names it.
  const context: Context = { styles, rels: new Map(), labels: new Map() };
  const footRels = part("word/_rels/footnotes.xml.rels");
  for (const r of footRels ? kids(footRels, "Relationship") : [])
    if (r.attrs.TargetMode === "External") context.rels.set(r.attrs.Id ?? "", r.attrs.Target ?? "");
  const foot = part("word/footnotes.xml");
  const found: { id: string; unit: Unit; place: Place }[] = [];
  /** Footnotes left unread, which the body must still name. */
  const closed: { id: string; unit: Unit }[] = [];
  const markdown = (chars: Char[]) =>
    render(chars, () => leave("formatting that Markdown cannot show, in a paragraph read as plain text"));
  for (const note of foot ? kids(foot, "w:footnote") : []) {
    if (note.attrs["w:type"] && note.attrs["w:type"] !== "normal") continue;
    const id = note.attrs["w:id"] ?? "";
    const paragraphs = [...within(note, ["w:p"], tracked)];
    const read = paragraphs.map((p) => ({ p, r: readParagraph(p, context) }));
    const full = read.filter((x) => trimmed(x.r.chars).length);
    pending += read.reduce((n, x) => n + x.r.pending, 0);
    if (read.some((x) => x.r.opaque) || [...walk(note)].some((n) => n.name === "w:tbl")) {
      leave(`a footnote with ${read.find((x) => x.r.opaque)?.r.opaque ?? "a table"}`);
      unread.push({ text: allText(note), after: -1 });
      closed.push({ id, unit: { kind: "footnote", text: allText(note).trim(), noteId: id } });
      continue;
    }
    if (!full.length) continue;
    const chars = full.flatMap((x, k) => [...(k ? [{ c: " ", b: false, i: false }] : []), ...trimmed(x.r.chars)]);
    const locked = full.length > 1 ? "a footnote of several paragraphs" : full[0]!.r.locked;
    found.push({
      id,
      unit: { kind: "footnote", text: markdown(chars), noteId: id },
      place: {
        part: "word/footnotes.xml", node: full[0]!.p,
        paras: [{ node: full[0]!.p, chars }], ...(locked ? { locked } : {}),
      },
    });
  }
  labelNotes([...found, ...closed].map((f) => f.unit), known, citations(kid(main, "w:body")));
  const bodyContext: Context = { styles, rels, labels: new Map([...found, ...closed].map((f) => [f.id, f.unit.label!])) };

  const units: Unit[] = [];
  const places: Place[] = [];
  const referenced: string[] = [];
  let tables = 0;
  const body = kid(main, "w:body");
  if (!body) throw new Refused("the Word file has no body");
  for (const block of bodyBlocks(body, tracked)) {
    if (block.name === "w:tbl") {
      const table = tables++;
      const rows = [...within(block, ["w:tr"], tracked)];
      const read = rows.map((tr) =>
        [...within(tr, ["w:tc"])].map((tc) => [...within(tc, ["w:p"])].map((p) => ({ p, r: readParagraph(p, bodyContext) }))));
      if (read.some((row) => !row.length ||
            row.some((cell) => !cell.length || cell.filter((x) => x.r.chars.length).length > 1 || cell.some((x) => x.r.opaque))) ||
          [...walk(block)].some((n) => n !== block && n.name === "w:tbl")) {
        leave("a table with several paragraphs or no paragraph in a cell, a nested table or content with no Markdown form");
        unread.push({ text: allText(block), after: units.length });
        continue;
      }
      read.forEach((row, k) => {
        const paras = row.map((cell) => {
          const x = cell.find((y) => y.r.chars.length) ?? cell[0]!;
          return { node: x.p, chars: trimmed(x.r.chars) };
        });
        const all = row.flat().map((x) => x.r);
        pending += all.reduce((n, r) => n + r.pending, 0);
        const locked = all.find((r) => r.locked)?.locked ?? (kid(kid(rows[k]!, "w:trPr"), "w:del") ? "a pending tracked change" : undefined);
        if (kid(kid(rows[k]!, "w:trPr"), "w:ins")) {
          pending++;
          return;
        }
        for (const p of paras) for (const c of p.chars) if (c.fn !== undefined) referenced.push(c.fn);
        units.push({ kind: "row", text: "", cells: paras.map((p) => markdown(p.chars)), table });
        places.push({ part: "word/document.xml", node: rows[k]!, table: block, paras, ...(locked ? { locked } : {}) });
      });
      continue;
    }
    const properties = kid(block, "w:pPr");
    const styleId = kid(properties, "w:pStyle")?.attrs["w:val"] ?? "";
    const style = styles.get(styleId) ?? { name: styleId.toLowerCase(), numbered: false };
    const read = readParagraph(block, bodyContext);
    pending += read.pending;
    if (read.objects) leave("a picture, shape or embedded object (it stays in the Word file)", read.objects);
    const chars = trimmed(read.chars);
    if (style.name === FIXED_STYLE) continue;
    if (read.opaque) {
      leave(`a paragraph with ${read.opaque}`);
      unread.push({ text: allText(block), after: units.length });
      continue;
    }
    if (!chars.length) continue;
    if (/^(toc ?\d|toc heading)/.test(style.name)) continue;
    for (const c of chars) if (c.fn !== undefined) referenced.push(c.fn);
    const heading = /^heading ?([1-6])$/.exec(style.name)?.[1] ?? (style.name === "title" ? "1" : undefined);
    const numbered = kid(properties, "w:numPr");
    const numId = kid(numbered, "w:numId")?.attrs["w:val"];
    let unit: Unit;
    if (heading) unit = { kind: "heading", level: Number(heading), text: markdown(chars) };
    else if (/quote|block text/.test(style.name)) unit = { kind: "quote", text: markdown(chars) };
    else if ((numbered && numId !== "0") || (!numbered && style.numbered)) {
      const level = Number(kid(numbered, "w:ilvl")?.attrs["w:val"] ?? "0");
      const format = formats.get(`${numId} ${level}`);
      const ordered = format ? format !== "bullet" : /number/.test(style.name);
      unit = { kind: "item", level, ordered, text: markdown(chars) };
    } else unit = { kind: "paragraph", text: markdown(chars) };
    units.push(unit);
    places.push({ part: "word/document.xml", node: block, paras: [{ node: block, chars }], ...(read.locked ? { locked: read.locked } : {}) });
  }
  // Footnotes follow the body, in the order the body refers to them. A reference
  // from a paragraph left unread still keeps its footnote.
  for (const n of walk(body)) {
    const label = n.name === "w:footnoteReference" ? bodyContext.labels.get(n.attrs["w:id"] ?? "") : undefined;
    if (label !== undefined && !referenced.includes(label)) referenced.push(label);
  }
  const order = new Map([...new Set(referenced)].map((label, k) => [label, k]));
  for (const f of found
    .filter((f) => order.has(f.unit.label!))
    .sort((a, b) => order.get(a.unit.label!)! - order.get(b.unit.label!)!)) {
    units.push(f.unit);
    places.push(f.place);
  }
  pending += tracked.pending;
  if (pending)
    notes.push(`${pending} pending tracked change(s) in the Word file: pending insertions are left out and pending deletions kept; accept or reject them in Word to settle them`);
  for (const [what, n] of left) notes.push(`not synced: ${n} × ${what}`);
  const comments = part("word/comments.xml");
  if (comments && kids(comments, "w:comment").length) notes.push("the Word file has comments; docsync leaves them in place and does not read them");
  return { entries, parts, units, places, styles, unread, notes };
}

interface Citations {
  /** For each footnote ID, the words before its reference and its paragraph. */
  of: Map<string, { before: string; block: string }>;
  paragraphs: string[];
}

function citations(body: Node | undefined): Citations {
  const out: Citations = { of: new Map(), paragraphs: [] };
  for (const p of body ? walk(body) : []) {
    if (p.name !== "w:p") continue;
    let before = "";
    const here: [string, string][] = [];
    const visit = (n: Node) => {
      if (REVISION_OUT.has(n.name)) return;
      if (n.name === "w:t" || n.name === "w:delText") before += textOf(n);
      else if (n.name === "w:footnoteReference") here.push([n.attrs["w:id"] ?? "", before]);
      else for (const c of kids(n)) visit(c);
    };
    visit(p);
    out.paragraphs.push(before);
    for (const [id, words] of here) out.of.set(id, { before: words, block: before });
  }
  return out;
}

/** True when two footnotes are cited after the same words. */
function citedAlike(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const tail = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(-6);
  const [x, y] = [tail(a), tail(b)];
  return ratio(x, y) >= 0.6;
}

/**
 * Give each footnote the label the base knows it by, or a new one. Citations
 * look much alike, so a footnote whose words changed is only taken to be an old
 * one when it is cited at the same place.
 */
function labelNotes(units: Unit[], known: KnownNote[], cited: Citations): void {
  const free = new Set(known);
  const take = (u: Unit, k: KnownNote) => {
    u.label = k.label;
    free.delete(k);
  };
  const words = (md: string) => visible(md);
  const here = (u: Unit) => cited.of.get(u.noteId ?? "")?.before;
  const closeness = new Map<string, number>();
  /** True when no other paragraph is more like the one that cited the old note. */
  const sameParagraph = (k: KnownNote, u: Unit) => {
    const at = cited.of.get(u.noteId ?? "")?.block;
    if (k.block === undefined || at === undefined) return false;
    let best = closeness.get(k.label);
    if (best === undefined) {
      best = Math.max(0, ...cited.paragraphs.map((p) => likeness(k.block!, p)));
      closeness.set(k.label, best);
    }
    const mine = likeness(k.block, at);
    return mine >= 0.6 && mine >= best;
  };
  const unchanged = (x: KnownNote, u: Unit) => words(x.text) === words(u.text);
  // Among equal notes, as with a repeated "Ibid.", the place cited decides.
  for (const alike of [
    (x: KnownNote, u: Unit) => citedAlike(x.before, here(u)) && x.noteId === u.noteId,
    (x: KnownNote, u: Unit) => citedAlike(x.before, here(u)),
    (x: KnownNote, u: Unit) => x.noteId === u.noteId,
    () => true,
  ])
    for (const u of units) {
      if (u.label !== undefined) continue;
      const k = [...free].find((x) => unchanged(x, u) && alike(x, u));
      if (k) take(u, k);
    }
  for (const u of units) {
    if (u.label !== undefined) continue;
    let best: KnownNote | undefined;
    let score = 0.5;
    for (const k of free) {
      if (!citedAlike(k.before, here(u)) || !sameParagraph(k, u)) continue;
      // Word may renumber notes, so an equal ID only breaks a near tie.
      const s = likeness(words(k.text), words(u.text)) + (k.noteId === u.noteId ? 0.05 : 0);
      if (s > score) [best, score] = [k, s];
    }
    if (best) take(u, best);
  }
  const used = new Set([...known.map((k) => k.label), ...units.flatMap((u) => (u.label === undefined ? [] : [u.label]))]);
  let n = 1;
  for (const u of units) {
    if (u.label !== undefined) continue;
    while (used.has(`w${n}`)) n++;
    u.label = `w${n}`;
    used.add(u.label);
  }
}
