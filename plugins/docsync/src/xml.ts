// A strict reader for the XML that Claude Docs reads return: elements, attributes
// and text. No document types, so no entity expansion.
export class XmlError extends Error {}

export interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: (Element | string)[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&([^;&]*);|&/g, (whole, name?: string) => {
    if (name !== undefined) {
      if (name in ENTITIES) return ENTITIES[name]!;
      const m = /^#(?:x([0-9a-fA-F]+)|(\d+))$/.exec(name);
      const code = m ? parseInt(m[1] ?? m[2]!, m[1] ? 16 : 10) : NaN;
      if (code <= 0x10ffff) return String.fromCodePoint(code);
    }
    throw new XmlError(`bad entity ${whole}`);
  });
}

const TOKEN =
  /<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)/y;
const ATTRIBUTE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXml(source: string): Element {
  const text = source.trim().replace(/^<\?xml[^>]*\?>\s*/, "");
  const stack: Element[] = [];
  let root: Element | undefined;
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < text.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(text);
    if (!m) throw new XmlError(`not well-formed XML at offset ${at}`);
    const [, closing, tag, attributes, selfClosing, chars] = m;
    const parent = stack.at(-1);
    if (closing) {
      if (stack.pop()?.tag !== closing) throw new XmlError(`unexpected </${closing}>`);
    } else if (tag) {
      const element: Element = { tag, attrs: {}, children: [] };
      for (const a of attributes!.matchAll(ATTRIBUTE)) element.attrs[a[1]!] = decode(a[2] ?? a[3]!);
      if (parent) parent.children.push(element);
      else if (root) throw new XmlError("more than one root element");
      else root = element;
      if (!selfClosing) stack.push(element);
    } else if (parent) {
      parent.children.push(decode(chars!));
    } else if (chars!.trim()) {
      throw new XmlError("text outside the root element");
    }
  }
  if (!root || stack.length) throw new XmlError("the XML is incomplete");
  return root;
}

export const elements = (e: Element, tag?: string): Element[] =>
  e.children.filter((c): c is Element => typeof c !== "string" && (!tag || c.tag === tag));

export const innerText = (e: Element): string =>
  e.children.map((c) => (typeof c === "string" ? c : innerText(c))).join("");
