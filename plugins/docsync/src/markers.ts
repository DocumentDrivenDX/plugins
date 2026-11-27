// Markers are footnote references, citation brackets and attribute lists. They are
// how a manuscript marks citations and spans, and a Claude Doc holds them as
// plain text, so nothing inside one is escaped or read as formatting.

const FOOTNOTE = /\[\^[^\]\s]+\]/g;
const ATTRIBUTES =
  /\{(?:\s*(?:\.[A-Za-z][\w-]*|#[A-Za-z][\w:.-]*|[A-Za-z][\w-]*="(?:[^"\\]|\\.)*"))+\s*\}/g;
const BRACKETED = /\[(?:[^\[\]"]|"(?:[^"\\]|\\.)*")*\]/g;
const CITES = /(?:^\[|[\s;-])@[\p{L}\p{N}_?{]/u;

export const ESCAPED = /\\([!-/:-@[-`{-~])/g;

export function unescapeMarkdown(text: string): string {
  return text.replace(ESCAPED, "$1");
}

/** Sorted, non-overlapping [start, end) ranges of the markers in `text`. */
export function markerSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const re of [FOOTNOTE, ATTRIBUTES, BRACKETED]) {
    for (const m of text.matchAll(re)) {
      if (re === BRACKETED && !CITES.test(m[0])) continue;
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] < last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

const WORD = /[\p{L}\p{N}]/u;

/** Text a doc holds literally, as Markdown: escape what Markdown would otherwise read. */
export function literal(text: string): string {
  const spans = markerSpans(text);
  let out = "";
  let next = 0;
  for (let i = 0; i < text.length; i++) {
    while (next < spans.length && spans[next]![1] <= i) next++;
    const ch = text[i]!;
    const inMarker = next < spans.length && spans[next]![0] <= i;
    let escape = false;
    if (!inMarker) {
      if (ch === "*" || ch === "`" || ch === "\\") escape = true;
      else if (ch === "<") escape = /[A-Za-z/!?]/.test(text[i + 1] ?? "");
      else if (ch === "_") {
        // An underscore run inside a word starts no emphasis.
        let a = i;
        let b = i;
        while (text[a - 1] === "_") a--;
        while (text[b + 1] === "_") b++;
        escape = !(WORD.test(text[a - 1] ?? "") && WORD.test(text[b + 1] ?? ""));
      }
    }
    out += escape ? "\\" + ch : ch;
  }
  return out;
}

/** True when Markdown would read part of `text` as formatting, a link or HTML. */
export function hasFormatting(text: string): boolean {
  let bare = text.replace(ESCAPED, " ");
  for (const [a, b] of markerSpans(bare).reverse()) bare = bare.slice(0, a) + " " + bare.slice(b);
  return /[*`]|~~|\]\(|<[A-Za-z/!?]|(?<![\p{L}\p{N}_])_|_(?![\p{L}\p{N}_])/u.test(bare);
}

/** Footnote syntax as a Claude Doc accepts it: literal text. Code spans are left alone. */
export function escapeFootnotes(text: string): string {
  return text
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(?<!\\)\[\^([^\]\s]+)\]/g, "\\[\\^$1\\]")))
    .join("");
}
