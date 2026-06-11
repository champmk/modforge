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

/** `named` proceeds SILENTLY only when it out-maps `source` by this factor.
 *  Modern yarn aligned many class names with mojmap, so a mojmap tree can show
 *  a substantial named hit-rate from the overlap alone — silence therefore
 *  requires decisive dominance, never a bare rate floor. Anything closer gets
 *  a notice naming both counts and both flags. */
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
 *   - `source` maps a real share AND strictly out-maps `named` → flip the default
 *     and announce it loudly with both counts (a wrong pick here mints wrong EXACT
 *     certificates for the overlap classes whose two namespaces resolve to
 *     DIFFERENT targets — silence is never acceptable on contested evidence);
 *   - `named` maps a real share and decisively dominates → proceed silently (the
 *     common Fabric case);
 *   - `named` maps a real share but `source` is materially close → keep the
 *     default, but say so with both counts (yarn↔mojmap name overlap makes this
 *     reachable from a real mojmap tree — the user must be able to catch it);
 *   - anything else (both near zero, too small) → keep the default and name both
 *     flags so a misrouted user can recover.
 * Pure function of its input — same counts always yield the same decision.
 */
export function decideNamespace(probe: NamespaceProbe): NamespaceDecision {
  const { namedHits, sourceHits, sampled } = probe;

  // No Minecraft-shaped references to probe → no namespace signal; stay on the
  // default silently (a namespace hint would be noise on a tree with no MC refs).
  if (sampled === 0) return { namespace: 'named', autodetected: false, notice: null };

  const namedRate = namedHits / sampled;
  const sourceRate = sourceHits / sampled;

  // `source` maps a real share and strictly out-maps `named` → autodetect.
  if (sampled >= MIN_SAMPLE && sourceRate >= WIN_FLOOR_RATE && sourceHits > namedHits) {
    return {
      namespace: 'source',
      autodetected: true,
      notice:
        `modforge: namespace autodetected: source (mojmap names) — ` +
        `${sourceHits}/${sampled} scanned classes matched vs ${namedHits}/${sampled} under named ` +
        `(pass --namespace named to override)`,
    };
  }

  // `named` works AND decisively dominates → the confident Fabric case; silent.
  if (namedRate >= WIN_FLOOR_RATE && namedHits >= DOMINANCE_RATIO * Math.max(sourceHits, 1)) {
    return { namespace: 'named', autodetected: false, notice: null };
  }

  // `named` works but `source` is materially close (name-overlap territory) —
  // proceed on the default, but show both counts and the recovery flag.
  if (namedRate >= WIN_FLOOR_RATE) {
    return {
      namespace: 'named',
      autodetected: false,
      notice:
        `modforge: using namespace 'named' (yarn/Fabric, default) — ${namedHits}/${sampled} scanned classes ` +
        `matched, but ${sourceHits}/${sampled} also match mojmap names; if this is a NeoForge/mojmap mod, ` +
        `re-run with --namespace source.`,
    };
  }

  // Both weak / sample too small — keep the default but name BOTH flags.
  return {
    namespace: 'named',
    autodetected: false,
    notice:
      `modforge: namespace 'named' (default, yarn/Fabric) matched only ${namedHits}/${sampled} sampled classes — ` +
      `if this mod is written in mojmap/NeoForge names, re-run with --namespace source.`,
  };
}
