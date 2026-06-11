/**
 * Pure decision logic for `bridge` failures that are about the era boundary.
 *
 * The Era Bridge only crosses the obfuscation boundary: the pre-26.x yarn/mojmap
 * world → the post-26.1 unobfuscated (mojmap-less) world. A bridge fails at the
 * data layer with NO_MOJANG_MAPPINGS whenever its FROM version has no Mojang
 * mappings — true for every post-era version. This module classifies the (from,
 * to) pair from ground-truth era facts and decides what to TELL the user, with
 * one hard rule: never suggest a command that would provably fail the same way.
 *
 * No I/O, no deps — the era of each endpoint is computed by the caller and passed
 * in, so this decision is unit-testable in isolation.
 */

/**
 * Era of a version, from its Mojang version JSON:
 *   - 'pre'  : obfuscated era with published mojmap (1.14.4 … 1.21.11) — a valid
 *              bridge SOURCE.
 *   - 'post' : unobfuscated era (26.1+) — mojmap-less; never a bridge source.
 *   - 'unknown' : could not be classified (unfetchable, or pre-1.14.4 with no
 *                 mojmap) — we make no provable claim about it.
 */
export type BridgeEra = 'pre' | 'post' | 'unknown';

export interface BridgeEraHintInput {
  /** The --from version string, verbatim. */
  from: string;
  /** The --to version string, verbatim. */
  to: string;
  /** The scanned source directory, for echoing back in a command suggestion. */
  dir: string;
  /** The data-layer reason (the NO_MOJANG_MAPPINGS message) to surface as-is. */
  baseMessage: string;
  fromEra: BridgeEra;
  toEra: BridgeEra;
}

/**
 * Decide the message for a bridge that failed because FROM has no Mojang
 * mappings. Three outcomes:
 *   - both endpoints post-era → name the boundary and point at `modforge delta`
 *     (no reversed hint — reversing would fail identically);
 *   - TO is a pre-era source → keep the existing did-you-mean reversed hint
 *     (reversing yields a runnable pre→post bridge);
 *   - otherwise → the plain reason, plus the reversed hint UNLESS the reversed
 *     command would provably fail the same way (its new FROM, the current TO, is
 *     itself a mappingless post-era version).
 */
export function bridgeEraHint(input: BridgeEraHintInput): string {
  const { from, to, dir, baseMessage, fromEra, toEra } = input;

  if (fromEra === 'post' && toEra === 'post') {
    return (
      `${from} and ${to} are both post-era (26.1+, unobfuscated) — the Era Bridge crosses the ` +
      `pre-26.x → 26.x obfuscation boundary, so a post-era → post-era pair has no era to bridge; ` +
      `use:  modforge delta --from ${from} --to ${to}`
    );
  }

  // A reversed-command hint is honest only when the reversed command could
  // actually run. Reversing makes the current TO the new FROM, which the data
  // layer immediately feeds to getClientMappings — so it fails identically when
  // TO is post-era. Suppress the hint in exactly that provable case.
  if (toEra === 'post') {
    return baseMessage;
  }

  return `${baseMessage}\n\nDid you mean:  modforge bridge --from ${to} --to ${from} ${dir}`;
}
