// A first .docx from a Markdown file, and Markdown from a .docx that has none.
import { Refused, parse, splitFrontMatter } from "../markdown.ts";
import { type Atom, parseInline } from "./inline.ts";
import { FIXED_STYLE, type Unit, type Word } from "./read.ts";
import { runs, textElement } from "./patch.ts";
import { mdUnits } from "./units.ts";
import { escapeXml } from "./xml.ts";
import { newEntry, writeZip } from "./zip.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const ML = "application/vnd.openxmlformats-officedocument.wordprocessingml";

const style = (id: string, name: string, pPr = "", rPr = "") =>
  `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${id === "Normal" ? "" : '<w:basedOn w:val="Normal"/>'}<w:qFormat/>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}</w:style>`;

function styles(): string {
  const headings = [32, 28, 26, 24, 22, 22].map((size, k) =>
    style(`Heading${k + 1}`, `heading ${k + 1}`, `<w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${k}"/>`, `<w:b/><w:sz w:val="${size}"/>`));
  return `${HEAD}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    style("Normal", "Normal") + headings.join("") +
    style("Quote", "Quote", '<w:ind w:left="720" w:right="720"/>') +
    style("ListParagraph", "List Paragraph", '<w:spacing w:after="60"/>') +
    style("FootnoteText", "footnote text", '<w:spacing w:after="0"/>', '<w:sz w:val="18"/>') +
    style("Fixed", FIXED_STYLE, "", '<w:color w:val="808080"/>') +
    '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>' +
    "</w:styles>";
}

function numbering(ordered: number): string {
  const levels = (format: (k: number) => string, text: (k: number) => string) =>
    Array.from({ length: 9 }, (_, k) =>
      `<w:lvl w:ilvl="${k}"><w:start w:val="1"/><w:numFmt w:val="${format(k)}"/><w:lvlText w:val="${text(k)}"/><w:pPr><w:ind w:left="${720 * (k + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join("");
  const nums = Array.from({ length: ordered }, (_, k) =>
    `<w:num w:numId="${k + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`);
  return `${HEAD}<w:numbering ${W}><w:abstractNum w:abstractNumId="0">${levels(() => "bullet", () => "•")}</w:abstractNum><w:abstractNum w:abstractNumId="1">${levels(() => "decimal", (k) => `%${k + 1}.`)}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>${nums.join("")}</w:numbering>`;
}

/** The bytes of a new .docx saying what the Markdown file says. */
export function createDocx(markdown: string): Buffer {
  const body = splitFrontMatter(markdown)[1];
  const { lines, blocks } = parse(body);
  const units = mdUnits(body);
  const byBlock = new Map(units.map((u) => [u.block, u]));
  const notes = new Map(units.filter((u) => u.kind === "footnote").map((u) => [u.label!, u.text]));
  const noteIds = new Map<string, number>();
  const links: string[] = [];
  const noteLinks: string[] = [];

  const inline = (md: string, inNote: boolean): string => {
    const atoms = parseInline(md);
    let out = "";
    for (let k = 0; k < atoms.length; ) {
      const { fn, href } = atoms[k]!;
      if (fn !== undefined) {
        k++;
        if (inNote || !notes.has(fn) || noteIds.has(fn)) {
          // A reference with no note of its own stays as typed.
          if (!inNote && noteIds.has(fn)) throw new Refused(`the footnote [^${fn}] is referred to twice, which Word cannot hold`);
          out += runs([...`[^${fn}]`].map((c) => ({ c, b: false, i: false })));
          continue;
        }
        noteIds.set(fn, noteIds.size + 1);
        out += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${noteIds.get(fn)}"/></w:r>`;
        continue;
      }
      const group: Atom[] = [];
      while (k < atoms.length && atoms[k]!.fn === undefined && atoms[k]!.href === href) group.push(atoms[k++]!);
      if (href === undefined) out += runs(group);
      else {
        const list = inNote ? noteLinks : links;
        list.push(href);
        out += `<w:hyperlink r:id="link${list.length}">${runs(group)}</w:hyperlink>`;
      }
    }
    return out;
  };
  const paragraph = (content: string, properties = "") => `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${content}</w:p>`;
  const styled = (id: string) => `<w:pStyle w:val="${id}"/>`;

  const out: string[] = [];
  let ordered = 0;
  let numberedList: number | undefined;
  for (let n = 0; n < blocks.length; n++) {
    const b = blocks[n]!;
    const u = byBlock.get(n);
    if (!(u?.kind === "item" && u.ordered)) numberedList = undefined;
    if (!u) {
      // An HTML comment is a private note.
      if (lines[b.start]!.trimStart().startsWith("<!--")) continue;
      // Code, HTML and the like: shown as written, and not synced.
      for (const line of lines.slice(b.start, b.end))
        out.push(paragraph(`<w:r>${textElement(line)}</w:r>`, styled("Fixed")));
    } else if (u.kind === "row") {
      const rows = [u];
      while (byBlock.get(n + 1)?.kind === "row" && byBlock.get(n + 1)!.table === u.table) rows.push(byBlock.get(++n)!);
      const columns = Math.max(...rows.map((r) => r.cells!.length));
      const border = ["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join("");
      out.push(`<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders></w:tblPr><w:tblGrid>${'<w:gridCol/>'.repeat(columns)}</w:tblGrid>` +
        rows.map((r) => `<w:tr>${r.cells!.map((c) => `<w:tc>${paragraph(inline(c, false))}</w:tc>`).join("")}</w:tr>`).join("") + "</w:tbl>");
      // Word joins tables that touch.
      if (byBlock.get(n + 1)?.kind === "row") out.push("<w:p/>");
    } else if (u.kind === "heading") out.push(paragraph(inline(u.text, false), styled(`Heading${u.level}`)));
    else if (u.kind === "quote") out.push(paragraph(inline(u.text, false), styled("Quote")));
    else if (u.kind === "item") {
      if (u.ordered && numberedList === undefined) numberedList = ++ordered + 1;
      out.push(paragraph(inline(u.text, false),
        `${styled("ListParagraph")}<w:numPr><w:ilvl w:val="${Math.min(u.level ?? 0, 8)}"/><w:numId w:val="${u.ordered ? numberedList : 1}"/></w:numPr>`));
    } else if (u.kind === "paragraph") out.push(paragraph(inline(u.text, false)));
  }
  const unused = [...notes.keys()].filter((label) => !noteIds.has(label));
  if (unused.length) throw new Refused(`footnote(s) ${unused.map((l) => `[^${l}]`).join(", ")} are never referred to; Word cannot hold them`);

  const footnote = (id: number, content: string, type = "") =>
    `<w:footnote${type ? ` w:type="${type}"` : ""} w:id="${id}">${content}</w:footnote>`;
  const footnotes = `${HEAD}<w:footnotes ${W}>` +
    footnote(-1, "<w:p><w:r><w:separator/></w:r></w:p>", "separator") +
    footnote(0, "<w:p><w:r><w:continuationSeparator/></w:r></w:p>", "continuationSeparator") +
    [...noteIds].map(([label, id]) => footnote(id, paragraph(
      `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r>${textElement(" ")}</w:r>${inline(notes.get(label)!, true)}`,
      styled("FootnoteText")))).join("") + "</w:footnotes>";

  const relationships = (list: [string, string, string, boolean?][]) =>
    `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target, external]) =>
      `<Relationship Id="${id}" Type="${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
  const external = (list: string[]) => list.map((href, k): [string, string, string, boolean] => [`link${k + 1}`, `${REL}/hyperlink`, href, true]);
  const types = ["document.main", "styles", "numbering", "footnotes"].map((t) =>
    `<Override PartName="/word/${t === "document.main" ? "document" : t}.xml" ContentType="${ML}.${t}+xml"/>`).join("");
  const parts: [string, string][] = [
    ["[Content_Types].xml", `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types}</Types>`],
    ["_rels/.rels", relationships([["rId1", `${REL}/officeDocument`, "word/document.xml"]])],
    ["word/_rels/document.xml.rels", relationships([
      ["rId1", `${REL}/styles`, "styles.xml"], ["rId2", `${REL}/numbering`, "numbering.xml"],
      ["rId3", `${REL}/footnotes`, "footnotes.xml"], ...external(links)])],
    ["word/document.xml", `${HEAD}<w:document ${W}><w:body>${out.join("")}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`],
    ["word/styles.xml", styles()],
    ["word/numbering.xml", numbering(ordered)],
    ["word/footnotes.xml", footnotes],
    ...(noteLinks.length ? [["word/_rels/footnotes.xml.rels", relationships(external(noteLinks))] as [string, string]] : []),
  ];
  return writeZip(parts.map(([name, text]) => newEntry(name, text)));
}

/** Markdown for the units of a .docx. */
export function toMarkdown(word: Word): string {
  const out: string[] = [];
  let previous: Unit | undefined;
  /** Keeps text that would start a list, heading, table or quote as text. */
  const guard = (text: string) => text.replace(/^(#|>|\||<|[-+](?=\s)|\d+(?=[.)]\s)|[-_]{3})/, (m) => (/^\d/.test(m) ? m : `\\${m}`))
    .replace(/^(\d+)([.)])(?=\s)/, "$1\\$2");
  for (const u of word.units) {
    const joined = previous && ((u.kind === "item" && previous.kind === "item") || (u.kind === "row" && previous.kind === "row" && u.table === previous.table));
    if (previous && !joined) out.push(u.kind === "quote" && previous.kind === "quote" ? ">" : "");
    if (u.kind === "heading") out.push(`${"#".repeat(u.level!)} ${u.text}`);
    else if (u.kind === "quote") out.push(`> ${guard(u.text)}`);
    else if (u.kind === "item") out.push(`${"    ".repeat(u.level ?? 0)}${u.ordered ? "1." : "-"} ${u.text}`);
    else if (u.kind === "footnote") out.push(`[^${u.label}]: ${u.text}`);
    else if (u.kind === "row") {
      const row = `| ${u.cells!.map((c) => c.replaceAll("|", "\\|")).join(" | ")} |`;
      out.push(row);
      if (!joined) out.push(`|${" --- |".repeat(u.cells!.length)}`);
    } else out.push(guard(u.text));
    previous = u;
  }
  return out.join("\n") + "\n";
}
