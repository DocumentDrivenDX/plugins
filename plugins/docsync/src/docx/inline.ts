// One block's text as characters with their formatting, and the two ways between
// that and Markdown. Markers stay literal text.
import { literal, markerSpans } from "../markers.ts";

export interface Atom {
  /** One character, or "" for a footnote reference. */
  c: string;
  b: boolean;
  i: boolean;
  href?: string;
  fn?: string;
}

const delimiter = (x: Atom) => (x.b ? "**" : "") + (x.i ? "*" : "");

const shown = (atoms: Atom[]) =>
  atoms.map((a) => (/^\s$/.test(a.c) ? " " : `${a.fn ?? a.c}${+a.b}${+a.i}`)).join("\u0000");

/**
 * Markdown for characters with their formatting. Italics are written `*…*`, or
 * `_…_` where asterisks beside each other would be read another way. Where
 * Markdown cannot say the formatting, the text is written without it and
 * `unsaid` is called.
 */
export function render(atoms: Atom[], unsaid?: () => void): string {
  const first = write(atoms, "*");
  if (!atoms.some((a) => a.b || a.i)) return first;
  const want = shown(atoms);
  if (shown(parseInline(first)) === want) return first;
  const second = write(atoms, "_");
  if (shown(parseInline(second)) === want) return second;
  unsaid?.();
  return write(atoms.map((a) => ({ ...a, b: false, i: false })), "*");
}

function write(atoms: Atom[], italic: "*" | "_"): string {
  // Formatting on a space shows nothing, so it takes its neighbours' common formatting.
  const list = atoms.map((a) => ({ ...a }));
  for (let k = 0; k < list.length; k++) {
    if (!/^\s$/.test(list[k]!.c)) continue;
    let lo = k - 1;
    let hi = k + 1;
    while (lo >= 0 && /^\s$/.test(atoms[lo]!.c)) lo--;
    while (hi < atoms.length && /^\s$/.test(atoms[hi]!.c)) hi++;
    list[k]!.b = Boolean(atoms[lo]?.b && atoms[hi]?.b);
    list[k]!.i = Boolean(atoms[lo]?.i && atoms[hi]?.i);
  }
  // Escaping looks at the whole plain text, so that markers are seen whole.
  const plain = list.map((a) => (a.fn === undefined ? a.c : "\u0000")).join("");
  const escaped = escapeEach(plain);
  let out = "";
  const open: string[] = [];
  let href: string | undefined;
  const closeTo = (n: number) => {
    while (open.length > n) out += open.pop()!;
  };
  list.forEach((a, k) => {
    // The formatting that lasts longer opens first, so that it need not be reopened.
    const lasts = (key: "b" | "i") => {
      let n = k;
      while (n < list.length && list[n]![key] && list[n]!.href === a.href) n++;
      return n - k;
    };
    const want = ([["b", "**"], ["i", italic]] as const)
      .filter(([key]) => a[key])
      .sort((x, y) => lasts(y[0]) - lasts(x[0]))
      .map(([, d]) => d as string);
    if (a.href !== href) {
      closeTo(0);
      if (href !== undefined) out += `](${href})`;
      if (a.href !== undefined) out += "[";
      href = a.href;
    }
    let keep = 0;
    while (keep < open.length && want.includes(open[keep]!)) keep++;
    closeTo(keep);
    // A delimiter never opens just before a space.
    if (!/^\s$/.test(a.c)) for (const d of want) if (!open.includes(d)) out += (open.push(d), d);
    out += a.fn === undefined ? escaped[k]! : `[^${a.fn}]`;
  });
  closeTo(0);
  if (href !== undefined) out += `](${href})`;
  return out;
}

/** `literal` of the whole text, cut back into one piece per character. */
function escapeEach(plain: string): string[] {
  const whole = literal(plain);
  const out: string[] = [];
  let at = 0;
  for (let k = 0; k < plain.length; k++) {
    const escaped = whole[at] === "\\" && (plain[k] !== "\\" || whole[at + 1] === "\\");
    out.push(whole.slice(at, at + (escaped ? 2 : 1)));
    at += escaped ? 2 : 1;
  }
  return out;
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const LINK = /^\[((?:\\.|[^\[\]\\]|\[(?:\\.|[^\[\]\\])*\])*)\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)\)/;
const FOOTNOTE = /^\[\^([^\]\s]+)\]/;

interface Piece {
  atom?: Atom;
  run?: { ch: "*" | "_"; length: number; whole: number; opens: boolean; closes: boolean };
}

/** The characters and formatting that Markdown text means. UTF-16 units, one atom each. */
export function parseInline(md: string): Atom[] {
  const markers = markerSpans(md);
  const pieces: Piece[] = [];
  const text = (s: string) => {
    for (let k = 0; k < s.length; k++) pieces.push({ atom: { c: s[k]!, b: false, i: false } });
  };
  for (let at = 0; at < md.length; ) {
    const rest = md.slice(at);
    const marker = markers.find(([a]) => a === at);
    const note = FOOTNOTE.exec(rest);
    if (note) {
      pieces.push({ atom: { c: "", b: false, i: false, fn: note[1]! } });
      at += note[0].length;
    } else if (marker) {
      text(md.slice(at, marker[1]));
      at = marker[1];
    } else if (md[at] === "\\" && PUNCTUATION.test(md[at + 1] ?? "")) {
      text(md[at + 1]!);
      at += 2;
    } else if (md[at] === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const end = md.indexOf(ticks, at + ticks.length);
      const stop = end < 0 ? at + ticks.length : end + ticks.length;
      text(md.slice(at, stop));
      at = stop;
    } else if (md[at] === "[" && LINK.test(rest)) {
      const link = LINK.exec(rest)!;
      for (const atom of parseInline(link[1]!)) pieces.push({ atom: { ...atom, href: link[2]! } });
      at += link[0].length;
    } else if (md[at] === "*" || md[at] === "_") {
      const ch = md[at] as "*" | "_";
      let n = 1;
      while (md[at + n] === ch) n++;
      const before = md[at - 1] ?? " ";
      const after = md[at + n] ?? " ";
      const inWord = ch === "_" && WORD.test(before) && WORD.test(after);
      pieces.push({ run: { ch, length: n, whole: n, opens: !/\s/.test(after) && !inWord, closes: !/\s/.test(before) && !inWord } });
      at += n;
    } else {
      text(md[at]!);
      at++;
    }
  }
  // Pair delimiter runs, innermost first.
  const marks = new Map<number, { b: number; i: number }>();
  const mark = (k: number) => marks.get(k) ?? (marks.set(k, { b: 0, i: 0 }), marks.get(k)!);
  const stack: { at: number; ch: string; left: number; whole: number; closes: boolean }[] = [];
  pieces.forEach((p, k) => {
    const run = p.run;
    if (!run) return;
    if (run.closes) {
      while (run.length) {
        let j = stack.length - 1;
        // CommonMark's rule of three keeps `**a*b***` nesting as written.
        const refused = (o: (typeof stack)[number]) =>
          (run.opens || o.closes) && (o.whole + run.whole) % 3 === 0 && !(o.whole % 3 === 0 && run.whole % 3 === 0);
        while (j >= 0 && (stack[j]!.ch !== run.ch || refused(stack[j]!))) j--;
        if (j < 0) break;
        const opener = stack[j]!;
        const use = opener.left >= 2 && run.length >= 2 ? 2 : 1;
        const key = use === 2 ? "b" : "i";
        mark(opener.at)[key]++;
        mark(k)[key]--;
        opener.left -= use;
        run.length -= use;
        stack.length = opener.left ? j + 1 : j;
      }
    }
    if (run.opens && run.length) stack.push({ at: k, ch: run.ch, left: run.length, whole: run.whole, closes: run.closes });
  });
  const atoms: Atom[] = [];
  const depth = { b: 0, i: 0 };
  const unused = new Map(stack.map((s) => [s.at, s.left]));
  pieces.forEach((p, k) => {
    if (p.atom) {
      atoms.push({ ...p.atom, b: p.atom.b || depth.b > 0, i: p.atom.i || depth.i > 0 });
      return;
    }
    const m = marks.get(k);
    if (m && (m.b < 0 || m.i < 0)) {
      depth.b += m.b;
      depth.i += m.i;
    }
    // Delimiters that paired with nothing are text.
    const left = unused.get(k) ?? (p.run!.opens ? 0 : p.run!.length);
    for (let n = 0; n < left; n++) atoms.push({ c: p.run!.ch, b: depth.b > 0, i: depth.i > 0 });
    if (m && !(m.b < 0 || m.i < 0)) {
      depth.b += m.b;
      depth.i += m.i;
    }
  });
  return atoms;
}

/** The words a block shows, without formatting. */
export const visible = (md: string) =>
  parseInline(md).map((a) => (a.fn === undefined ? a.c : `[^${a.fn}]`)).join("").replace(/\s+/g, " ").trim();

/** Words, formatting and link targets in one comparable string. Spacing is alike. */
export function canon(md: string): string {
  let out = "";
  let last = "";
  for (const a of parseInline(md)) {
    if (/^\s$/.test(a.c)) {
      if (out && !out.endsWith(" ")) out += " ";
      continue;
    }
    const style = delimiter(a) + (a.href === undefined ? "" : `<${a.href}>`);
    if (style !== last) out += `\u0001${style}\u0001`;
    last = style;
    out += a.fn === undefined ? a.c : `\u0002${a.fn}\u0002`;
  }
  return out.trimEnd();
}

export const same = (a: string, b: string) => a === b || canon(a) === canon(b);
