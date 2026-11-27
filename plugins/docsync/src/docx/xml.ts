// An XML reader that keeps where everything was, so that a part can be patched by
// replacing ranges of its text. No document types, so no entity expansion.
import { XmlError } from "../xml.ts";

export interface Node {
  name: string;
  attrs: Record<string, string>;
  children: (Node | string)[];
  /** Offsets of `<`, of the first content, of the closing tag, and past the element. */
  start: number;
  inner: number;
  close: number;
  end: number;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decode(text: string): string {
  return text.replace(/&([^;&]*);|&/g, (whole, name?: string) => {
    if (name !== undefined) {
      if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name]!;
      const m = /^#(?:x([0-9a-fA-F]+)|(\d+))$/.exec(name);
      const code = m ? parseInt(m[1] ?? m[2]!, m[1] ? 16 : 10) : NaN;
      if (code <= 0x10ffff) return String.fromCodePoint(code);
    }
    throw new XmlError(`bad entity ${whole}`);
  });
}

export const escapeXml = (text: string) =>
  text
    // Characters XML 1.0 cannot hold.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const TOKEN =
  /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s<>/]+)\s*>|<([^\s<>/!?]+)((?:\s+[^\s<>/=]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)/y;
const ATTRIBUTE = /([^\s<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const MAX_DEPTH = 200;

export function parsePart(text: string): Node {
  const stack: Node[] = [];
  let root: Node | undefined;
  TOKEN.lastIndex = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (TOKEN.lastIndex < text.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(text);
    if (!m) throw new XmlError(`not well-formed XML at offset ${at}`);
    const [, cdata, closing, tag, attributes, selfClosing, chars] = m;
    const parent = stack.at(-1);
    if (closing) {
      const open = stack.pop();
      if (open?.name !== closing) throw new XmlError(`unexpected </${closing}>`);
      open.close = at;
      open.end = TOKEN.lastIndex;
    } else if (tag) {
      const node: Node = {
        name: tag, attrs: {}, children: [], start: at, inner: TOKEN.lastIndex, close: TOKEN.lastIndex, end: TOKEN.lastIndex,
      };
      for (const a of attributes!.matchAll(ATTRIBUTE)) node.attrs[a[1]!] = decode(a[2] ?? a[3]!);
      if (parent) parent.children.push(node);
      else if (root) throw new XmlError("more than one root element");
      else root = node;
      if (!selfClosing) {
        stack.push(node);
        if (stack.length > MAX_DEPTH) throw new XmlError("nested too deeply");
      }
    } else if (chars !== undefined || cdata !== undefined) {
      if (parent) parent.children.push(cdata ?? decode(chars!));
      else if ((cdata ?? chars!).trim()) throw new XmlError("text outside the root element");
    }
  }
  if (!root || stack.length) throw new XmlError("the XML is incomplete");
  return root;
}

export const kids = (n: Node, name?: string): Node[] =>
  n.children.filter((c): c is Node => typeof c !== "string" && (!name || c.name === name));

export const kid = (n: Node | undefined, name: string): Node | undefined => (n ? kids(n, name)[0] : undefined);

export const textOf = (n: Node): string => n.children.map((c) => (typeof c === "string" ? c : textOf(c))).join("");

export function* walk(n: Node): Generator<Node> {
  yield n;
  for (const c of kids(n)) yield* walk(c);
}

export interface Splice {
  start: number;
  end: number;
  text: string;
}

export function splice(source: string, edits: Splice[]): string {
  // Last first; two insertions at one place keep the order they were given.
  const ordered = edits.map((e, i) => ({ e, i })).sort((x, y) => y.e.start - x.e.start || y.e.end - x.e.end || y.i - x.i);
  let out = source;
  let limit = Infinity;
  for (const { e } of ordered) {
    if (e.end > limit) throw new XmlError("two patches overlap");
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }
  return out;
}
