/**
 * Pure decision logic for the `bridge` source-namespace autodetect (item P1-4).
 *
 * THE PROBLEM: a mod's classes are written in exactly ONE old-era namespace —
 * yarn `named` (Fabric) or mojmap `source` (NeoForge / modern multiloader). The
 * CLI defaults to `named`, so a NeoForge/mojmap tree scanned with the default
 * resolves almost nothing (yarn lookups miss every mojmap class) and the user is
 * handed thousands of UNRESOLVED with no hint that `--namespace source` exists —
 * even though the engine already supports both. This is pure routing.
 *
 * THE PROBE: the bridge resolves a class under namespace X only if that class
 * name lives in X's source table (yarn `named` vs mojmap `source`); a name from
 * the wrong namespace fails at the very first table lookup. So treating a class
 * name as a hit under X exactly when the engine maps it (EXACT or CANDIDATE — i.e.
 * confidence !== UNRESOLVED) is a deterministic membership signal. We count hits
 * for a deterministic sample of the scanned class names under BOTH namespaces and
 * decide here, with NO I/O — the caller supplies the counts, so this is unit
 * testable in isolation (mirrors the bridge-era.ts pattern).
 *
 * THE RULE (the one hard constraint): the decision is advisory and overridable.
 * An explicit `--namespace` is always respected (the caller never invokes this);
 * autodetect only flips the default on clearly lopsided evidence, says so loudly
 * on one line, and always names the override. Ambiguous evidence keeps the
 * default and names both flags. Same counts in → same choice out (determinism).
 */
import type { SourceNamespace } from '../bridge/bridge.ts';
export type { SourceNamespace };

/** Hit counts from probing a fixed class-name sample under both namespaces. */
export interface NamespaceProbe {
  /** distinct sampled class names the engine maps under yarn `named`. */
  namedHits: number;
  /** distinct sampled class names the engine maps under mojmap `source`. */
  sourceHits: number;
  /** size of the probed sample (distinct Minecraft class names, capped). */
  sampled: number;
}

export interface NamespaceDecision {
  /** the namespace the scan/resolve pass should use. */
  namespace: SourceNamespace;
  /** true only when this flipped the default because the evidence was lopsided. */
  autodetected: boolean;
  /** one stderr line to print, or null to stay silent (the confident-default case). */
  notice: string | null;
}

// --- thresholds (explicit constants; a real tree is single-namespace, so a
//     correctly-routed scan is overwhelmingly lopsided — observed ~6/4954 hits
//     under the WRONG namespace on a mojmap mod) ------------------------------

/** Default cap on the probe sample: enough signal, bounded cost on huge trees. */
export const PROBE_SAMPLE_CAP = 200;

/** Below this many sampled classes a ratio is noise — never flip on a handful. */
export const MIN_SAMPLE = 3;

/** The winner must map at least this share of the sample to count as "working" —
 *  kills the both-near-zero case (a non-MC tree, or a from-version skew, maps
 *  little under EITHER namespace and must not trigger a confident flip). */
export const WIN_FLOOR_RATE = 0.25;

/** The default `named` is abandoned only when its OWN hit-rate is essentially
 *  zero; a tree where `named` also maps a real share is yarn, not mojmap. */
export const NAMED_DEAD_RATE = 0.1;

/** The winner must out-map the loser by this factor — "6029 vs 6" is lopsided; a
 *  near-even split means a mixed/ambiguous tree the user should choose for. */
export const DOMINANCE_RATIO = 4;

/**
 * Deterministic, distinct, capped sample of class names to probe. Sorting makes
 * the sample (and therefore the decision) reproducible for the same scan; the cap
 * bounds the probe cost on large trees without changing the verdict (a tree is
 * single-namespace, so any deterministic subset carries the same signal).
 */
export function sampleClassNames(classNames: Iterable<string>, cap: number = PROBE_SAMPLE_CAP): string[] {
  const distinct = [...new Set(classNames)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return distinct.slice(0, cap);
}

/**
 * Count how many sampled names the engine maps under each namespace. `resolved`
 * is the membership signal (confidence !== UNRESOLVED); injecting it keeps this
 * pure and unit-testable with a hand-built resolver.
 */
export function probeNamespaces(
  sampled: string[],
  resolved: (ns: SourceNamespace, className: string) => boolean,
): NamespaceProbe {
  let namedHits = 0;
  let sourceHits = 0;
  for (const name of sampled) {
    if (resolved('named', name)) namedHits++;
    if (resolved('source', name)) sourceHits++;
  }
  return { namedHits, sourceHits, sampled: sampled.length };
}

/**
 * Decide the namespace from the probe counts. Outcomes:
 *   - lopsided `source` win → flip the default and announce it loudly (the bug fix);
 *   - `named` maps a real share → it works, proceed silently (the common Fabric case);
 *   - anything else (both near zero, mixed, too small) → keep the default but name
 *     BOTH flags so a misrouted user can recover.
 * Pure function of its input — same counts always yield the same decision.
 */
export function decideNamespace(probe: NamespaceProbe): NamespaceDecision {
  const { namedHits, sourceHits, sampled } = probe;

  // No Minecraft-shaped references to probe → no namespace signal; stay on the
  // default silently (a namespace hint would be noise on a tree with no MC refs).
  if (sampled === 0) return { namespace: 'named', autodetected: false, notice: null };

  const namedRate = namedHits / sampled;
  const sourceRate = sourceHits / sampled;

  // Lopsided `source` win → autodetect: flip the default and say so on one line.
  if (
    sampled >= MIN_SAMPLE &&
    namedRate < NAMED_DEAD_RATE &&
    sourceRate >= WIN_FLOOR_RATE &&
    sourceHits >= DOMINANCE_RATIO * Math.max(namedHits, 1)
  ) {
    return {
      namespace: 'source',
      autodetected: true,
      notice:
        `modforge: namespace autodetected: source (mojmap names) — ` +
        `${sourceHits}/${sampled} scanned classes matched (pass --namespace named to override)`,
    };
  }

  // The default `named` maps a real share → it works; proceed without noise.
  if (namedRate >= WIN_FLOOR_RATE) {
    return { namespace: 'named', autodetected: false, notice: null };
  }

  // Ambiguous: `named` is weak and `source` did not lopsidedly win — keep the
  // default but name BOTH flags so a misrouted user can recover.
  return {
    namespace: 'named',
    autodetected: false,
    notice:
      `modforge: namespace 'named' (default, yarn/Fabric) matched only ${namedHits}/${sampled} sampled classes — ` +
      `if this mod is written in mojmap/NeoForge names, re-run with --namespace source.`,
  };
}
