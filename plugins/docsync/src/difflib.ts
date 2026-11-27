// The part of Python's difflib.SequenceMatcher that draftsync relies on, without
// junk heuristics (autojunk=False), so that merges match the original's.

export type Tag = "equal" | "replace" | "delete" | "insert";
export type Opcode = [Tag, number, number, number, number];

function longestMatch<T>(
  a: readonly T[],
  index: Map<T, number[]>,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): [number, number, number] {
  let bestI = alo;
  let bestJ = blo;
  let bestSize = 0;
  let lengths = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const next = new Map<number, number>();
    for (const j of index.get(a[i]!) ?? []) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (lengths.get(j - 1) ?? 0) + 1;
      next.set(j, k);
      if (k > bestSize) {
        bestI = i - k + 1;
        bestJ = j - k + 1;
        bestSize = k;
      }
    }
    lengths = next;
  }
  return [bestI, bestJ, bestSize];
}

function matchingBlocks<T>(a: readonly T[], b: readonly T[]): [number, number, number][] {
  const index = new Map<T, number[]>();
  b.forEach((x, j) => {
    const at = index.get(x);
    if (at) at.push(j);
    else index.set(x, [j]);
  });
  const queue: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  const found: [number, number, number][] = [];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop()!;
    const [i, j, k] = longestMatch(a, index, alo, ahi, blo, bhi);
    if (!k) continue;
    found.push([i, j, k]);
    if (alo < i && blo < j) queue.push([alo, i, blo, j]);
    if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
  }
  found.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: [number, number, number][] = [];
  for (const [i, j, k] of found) {
    const last = merged[merged.length - 1];
    if (last && last[0] + last[2] === i && last[1] + last[2] === j) last[2] += k;
    else merged.push([i, j, k]);
  }
  merged.push([a.length, b.length, 0]);
  return merged;
}

export function opcodes<T>(a: readonly T[], b: readonly T[]): Opcode[] {
  const out: Opcode[] = [];
  let i = 0;
  let j = 0;
  for (const [ai, bj, size] of matchingBlocks(a, b)) {
    if (i < ai && j < bj) out.push(["replace", i, ai, j, bj]);
    else if (i < ai) out.push(["delete", i, ai, j, bj]);
    else if (j < bj) out.push(["insert", i, ai, j, bj]);
    i = ai + size;
    j = bj + size;
    if (size) out.push(["equal", ai, i, bj, j]);
  }
  return out;
}

export function ratio<T>(a: readonly T[], b: readonly T[]): number {
  const total = a.length + b.length;
  if (!total) return 1;
  return (2 * matchingBlocks(a, b).reduce((n, m) => n + m[2], 0)) / total;
}
