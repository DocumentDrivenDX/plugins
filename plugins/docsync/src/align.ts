// Which entry of one list each entry of another is, for lists of blocks.
import { opcodes, ratio } from "./difflib.ts";

export const likeness = (a: string, b: string) => ratio([...a], [...b]);

/** A signature is a block's kind, a NUL, and its comparable text. */
export function alignSignatures(a: string[], b: string[]): { mapping: Map<number, number>; added: number[] } {
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
  return { mapping, added: b.flatMap((_, i) => (matched.has(i) ? [] : [i])) };
}
