// Changes to a .docx, made as replacements of ranges in its XML. Whatever is not
// replaced stays byte for byte. A change with no certain form is refused.
import { opcodes } from "../difflib.ts";
import { Refused } from "../markdown.ts";
import { type Atom, parseInline } from "./inline.ts";
import { type Char, type Place, type Unit, type Word } from "./read.ts";
import { escapeXml, kid, kids, type Node, type Splice, splice, textOf, walk } from "./xml.ts";
import { replaceParts, writeZip } from "./zip.ts";

export const textElement = (text: string) => `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`;

interface Token {
  key: string;
  from: number;
  to: number;
}

/** Words, runs of space, single other characters and footnote references. */
function tokens(atoms: Atom[]): Token[] {
  const plain = atoms.map((a) => (a.fn === undefined ? a.c : "\u0000")).join("");
  return [...plain.matchAll(/\s+|[\p{L}\p{N}\p{M}]+|\u0000|[^]/gu)].map((m) => {
    const from = m.index;
    const to = from + m[0].length;
    const key = m[0] === "\u0000" ? `\u0000${atoms[from]!.fn}` : /^\s/.test(m[0]) ? " " : m[0];
    return { key, from, to };
  });
}

const space = (a: Atom) => a.fn === undefined && /^\s$/.test(a.c);
const alike = (a: Atom, b: Atom) => a.b === b.b && a.i === b.i && a.href === b.href;
/** Formatting on a space shows nothing. */
const sameStyle = (a: Atom, b: Atom) => space(a) || space(b) || alike(a, b);

/** Text a .docx cannot take. */
function refuseUnwritable(md: string): void {
  if (md.includes("<!--")) throw new Refused("it holds an HTML comment, which co-authors would see");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(md)) throw new Refused("it holds a control character");
}

/** The splices that turn the characters of one paragraph into what `goal` means. */
function editParagraph(chars: Char[], current: string, goal: string): Splice[] {
  refuseUnwritable(goal);
  const read = parseInline(current);
  if (read.length !== chars.length ||
      read.some((a, k) => a.c !== chars[k]!.c || a.fn !== chars[k]!.fn || !sameStyle(a, chars[k]!)))
    throw new Refused("the paragraph holds text Markdown reads another way, such as a written-out link");
  const next = parseInline(goal);
  const [a, b] = [tokens(chars), tokens(next)];
  /** For each text element: characters to drop, and text to put before an offset. */
  const touched = new Map<Node, { drop: Set<number>; put: Map<number, string> }>();
  const edit = (t: Node) => touched.get(t) ?? (touched.set(t, { drop: new Set(), put: new Map() }), touched.get(t)!);
  for (const [tag, a1, a2, b1, b2] of opcodes(a.map((t) => t.key), b.map((t) => t.key))) {
    if (tag === "equal") {
      for (let k = 0; k < a2 - a1; k++) {
        const [old, now] = [a[a1 + k]!, b[b1 + k]!];
        for (let n = 0; n < old.to - old.from && n < now.to - now.from; n++)
          if (!sameStyle(chars[old.from + n]!, next[now.from + n]!))
            throw new Refused("its formatting or a link changed");
      }
      continue;
    }
    const x = a1 < a.length ? a[a1]!.from : chars.length;
    const y = a2 > a1 ? a[a2 - 1]!.to : x;
    const p = b1 < b.length ? b[b1]!.from : next.length;
    const q = b2 > b1 ? b[b2 - 1]!.to : p;
    const gone = chars.slice(x, y);
    const add = next.slice(p, q);
    if (gone.some((c) => c.fn !== undefined) || add.some((c) => c.fn !== undefined))
      throw new Refused("a footnote reference was added, removed or moved");
    if (gone.some((c) => !c.at)) throw new Refused("the change touches a tab, a line break or other text docsync cannot edit");
    // New words go only into a run formatted as they are, whatever its own character is.
    const fits = (host: Char | undefined) => Boolean(host?.at) && add.every((c) => space(c) || alike(c, host!));
    const text = add.map((c) => c.c).join("");
    if (gone.length) {
      if (add.length && !fits(gone[0])) throw new Refused("the new words have different formatting");
      for (const c of gone) edit(c.at!.t).drop.add(c.at!.offset);
      if (add.length) {
        const { t, offset } = gone[0]!.at!;
        edit(t).put.set(offset, (edit(t).put.get(offset) ?? "") + text);
      }
    } else if (add.length) {
      const before = chars[x - 1];
      const after = chars[x];
      const host = fits(before) ? before : fits(after) ? after : undefined;
      if (!host) throw new Refused("there is no editable text with matching formatting beside the new words");
      const t = host.at!.t;
      const offset = host === before ? host.at!.offset + 1 : host.at!.offset;
      edit(t).put.set(offset, (edit(t).put.get(offset) ?? "") + text);
    }
  }
  return [...touched].map(([t, { drop, put }]) => {
    const old = textOf(t);
    let out = "";
    for (let k = 0; k <= old.length; k++) {
      out += put.get(k) ?? "";
      if (k < old.length && !drop.has(k)) out += old[k];
    }
    return { start: t.start, end: t.end, text: textElement(out) };
  });
}

export function editUnit(place: Place, unit: Unit, goal: Unit): Splice[] {
  if (place.locked) throw new Refused(`it holds ${place.locked}`);
  if (unit.cells) {
    if (!goal.cells || goal.cells.length !== unit.cells.length) throw new Refused("the number of cells changed");
    return unit.cells.flatMap((cell, k) =>
      cell === goal.cells![k] ? [] : editParagraph(place.paras[k]!.chars, cell, goal.cells![k]!));
  }
  return editParagraph(place.paras[0]!.chars, unit.text, goal.text);
}

const ANCHORS: Record<string, string> = {
  "w:footnoteReference": "a footnote reference", "w:commentRangeStart": "a comment", "w:commentRangeEnd": "a comment",
  "w:commentReference": "a comment", "w:bookmarkStart": "a bookmark", "w:sectPr": "a section break",
  "w:drawing": "a picture", "w:pict": "a picture", "w:object": "an embedded object", "w:fldChar": "a field",
  "w:bookmarkEnd": "the end of a bookmark", "w:permStart": "an editing permission", "w:permEnd": "an editing permission",
};

export function deleteUnit(place: Place, unit: Unit, source: string): Splice {
  if (unit.kind === "footnote") throw new Refused("removing a footnote is done in Word");
  if (place.locked) throw new Refused(`it holds ${place.locked}`);
  const all = [...walk(place.node)];
  // Word's own "last edit" bookmark goes with its paragraph when both its ends are there.
  const goBack = new Set(all.filter((n) => n.name === "w:bookmarkStart" && n.attrs["w:name"] === "_GoBack").map((n) => n.attrs["w:id"]));
  const ends = new Set(all.filter((n) => n.name === "w:bookmarkEnd").map((n) => n.attrs["w:id"]));
  for (const n of all) {
    if (n.name.startsWith("w:bookmark") && goBack.has(n.attrs["w:id"]) && ends.has(n.attrs["w:id"])) continue;
    if (ANCHORS[n.name]) throw new Refused(`it holds ${ANCHORS[n.name]}`);
  }
  if (unit.kind === "row" && kids(place.table!, "w:tr")[0] === place.node)
    throw new Refused("it is the first row of its table");
  if (unit.kind !== "row" && /<\/w:tbl>\s*$/.test(source.slice(0, place.node.start)) && /^\s*<w:tbl[ >]/.test(source.slice(place.node.end)))
    throw new Refused("it is what keeps two tables apart");
  if (/<w:sdtContent>\s*$/.test(source.slice(0, place.node.start)) && /^\s*<\/w:sdtContent>/.test(source.slice(place.node.end)))
    throw new Refused("it is all that a content control holds");
  return { start: place.node.start, end: place.node.end, text: "" };
}

/** Runs for new text. */
export function runs(atoms: Atom[]): string {
  let out = "";
  for (let k = 0; k < atoms.length; ) {
    const { b, i } = atoms[k]!;
    let text = "";
    while (k < atoms.length && atoms[k]!.b === b && atoms[k]!.i === i) text += atoms[k++]!.c;
    out += `<w:r>${b || i ? `<w:rPr>${b ? "<w:b/>" : ""}${i ? "<w:i/>" : ""}</w:rPr>` : ""}${textElement(text)}</w:r>`;
  }
  return out;
}

function newAtoms(md: string): Atom[] {
  refuseUnwritable(md);
  const atoms = parseInline(md);
  if (atoms.some((a) => a.fn !== undefined)) throw new Refused("a new footnote is added in Word");
  if (atoms.some((a) => a.href !== undefined)) throw new Refused("a new link is added in Word");
  return atoms;
}

/** A paragraph's properties, without what belongs only to the paragraph it came from. */
function propertiesOf(source: string, p: Node): string {
  const pPr = kid(p, "w:pPr");
  if (!pPr) return "";
  const keep = kids(pPr).filter((c) => !["w:sectPr", "w:pPrChange", "w:rPr"].includes(c.name));
  return keep.length ? `<w:pPr>${keep.map((c) => source.slice(c.start, c.end)).join("")}</w:pPr>` : "";
}

/** The XML of a new block that follows `anchor`, and where it goes. */
export function insertUnit(word: Word, anchor: number, unit: Unit): Splice {
  const source = word.parts.get("word/document.xml")!.text;
  const place = word.places[anchor]!;
  const before = word.units[anchor]!;
  if (unit.kind === "footnote") throw new Refused("a new footnote is added in Word");
  if (unit.kind === "row") {
    if (before.kind !== "row" || before.cells!.length !== unit.cells!.length)
      throw new Refused("a new table is added in Word");
    const row = place.node;
    const cells = kids(row, "w:tc").map((tc, k) => {
      const tcPr = kid(tc, "w:tcPr");
      return `<w:tc>${tcPr ? source.slice(tcPr.start, tcPr.end) : ""}<w:p>${propertiesOf(source, place.paras[k]!.node)}${runs(newAtoms(unit.cells![k]!))}</w:p></w:tc>`;
    });
    return { start: row.end, end: row.end, text: `<w:tr>${cells.join("")}</w:tr>` };
  }
  if (place.table && word.places.slice(anchor + 1).some((later) => later.table === place.table))
    throw new Refused("it would go between two rows of a table");
  const atoms = newAtoms(unit.text);
  const sameKind = (u: Unit) =>
    u.kind === unit.kind && (unit.kind !== "heading" || u.level === unit.level) &&
    (unit.kind !== "item" || Boolean(u.ordered) === Boolean(unit.ordered));
  // The nearest block of the same kind lends its paragraph properties.
  const donor = word.units
    .map((u, k) => ({ u, k }))
    .filter(({ u, k }) => sameKind(u) && word.places[k]!.part === "word/document.xml")
    .sort((x, y) => Math.abs(x.k - anchor) - Math.abs(y.k - anchor))[0];
  let properties: string;
  if (donor) properties = propertiesOf(source, word.places[donor.k]!.node);
  else if (unit.kind === "paragraph") properties = "";
  else {
    const name = unit.kind === "heading" ? `heading ${unit.level}` : unit.kind === "quote" ? "quote" : undefined;
    const style = name && [...word.styles].find(([, s]) => s.name === name || s.name === name.replace(" ", ""))?.[0];
    if (!style) throw new Refused(`the Word file has no ${unit.kind} to copy the style from; add it in Word`);
    properties = `<w:pPr><w:pStyle w:val="${escapeXml(style)}"/></w:pPr>`;
  }
  const at = (place.table ?? place.node).end;
  return { start: at, end: at, text: `<w:p>${properties}${runs(atoms)}</w:p>` };
}

export interface PartEdit extends Splice {
  part: Place["part"];
}

/** The .docx with the edits made. */
export function patched(word: Word, edits: PartEdit[]): Buffer {
  const parts = new Map<string, string>();
  for (const part of new Set(edits.map((e) => e.part)))
    parts.set(part, splice(word.parts.get(part)!.text, edits.filter((e) => e.part === part)));
  return writeZip(replaceParts(word.entries, parts));
}

