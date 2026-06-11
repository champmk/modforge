/**
 * Tiny Levenshtein edit distance + nearest-candidate suggestion, dependency-free.
 *
 * Shared by the CLI flag registry (src/cli/flags.ts) and the MCP argument-key
 * validator (src/mcp/server.ts) so the "did you mean --X / key 'Y'" hint is one
 * implementation, computed identically on both surfaces. No I/O, no deps — pure.
 */

/** Classic Levenshtein distance (substitution/insertion/deletion all cost 1). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Two rolling rows — O(n) memory, O(m*n) time; inputs here are short flag names.
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n]!;
}

/**
 * The candidate closest to `target` within a SMALL edit distance, or undefined.
 *
 * "Small" = distance <= 2 AND strictly less than the candidate's own length, so a
 * 2-char flag/key is only suggested for a distance-1 typo (a distance-2 match
 * against a 2-char word is coincidence, not a typo). Deterministic: ties resolve
 * to the first candidate in iteration order, so the same input always suggests
 * the same thing.
 */
export function suggest(target: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(target, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  if (best !== undefined && bestDist <= 2 && bestDist < best.length) return best;
  return undefined;
}
