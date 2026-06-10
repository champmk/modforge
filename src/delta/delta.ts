/**
 * The API Delta engine — Pillar B.
 *
 * Compares the API surfaces of two (unobfuscated-era) game versions and produces
 * the exact, deterministic difference:
 *
 *  - classes:  added / removed, plus per-class member deltas for surviving classes
 *  - members:  added / removed / descriptor-changed (same name, different desc)
 *  - rename CANDIDATES: a removed symbol whose shape matches an added one.
 *    Renames are *structurally indistinguishable* from remove+add in an
 *    unobfuscated world, so candidates are ALWAYS labeled with their evidence and
 *    never presented as fact (honesty taxonomy, DECISIONS D4).
 *
 * Candidate quality invariants (hardened after real-data false positives on the
 * 26.1.2→26.2-pre-5 delta, where 3 removed classes all mapped to one added class
 * and 4 removed methods all mapped to one added method via a common descriptor):
 *
 *  - Class candidates are MUTUAL-BEST-MATCH (bijective): a pair is emitted only
 *    when each side is the other's single best match. No two candidates can
 *    share the same `to`.
 *  - Member candidates require a 1:1 removed↔added pairing per (owner, desc),
 *    and are penalized (or suppressed) when the shared descriptor is a common
 *    shape across the from-surface — a `()Ljava/util/List;` match means almost
 *    nothing; a 5-arg exotic-type match means a lot.
 *
 * The delta is computed over the full surface but consumers typically filter to
 * non-synthetic, non-private members (mods cannot call private API).
 */
import type { ClassApi, JarApi, MemberApi } from '../core/model.ts';
import { ACC } from '../core/model.ts';

/** One member-level change (addition, removal, or descriptor change) on a class. */
export interface MemberChange {
  owner: string;
  kind: 'method' | 'field';
  name: string;
  desc: string;
  /** for descriptor changes */
  newDesc?: string;
}

/**
 * A labeled structural rename candidate. NEVER a fact: renames are structurally
 * unprovable in an unobfuscated world; `evidence` carries the exact numbers used
 * so a human/agent can judge, and `score` is structural-evidence strength only.
 */
export interface RenameCandidate {
  kind: 'class' | 'method' | 'field';
  /** old symbol */
  from: { owner: string; name?: string; desc?: string };
  /** proposed new symbol */
  to: { owner: string; name?: string; desc?: string };
  /** 0..1 — structural-evidence score, never certainty */
  score: number;
  evidence: string;
}

/** The exact API difference between two versions, plus labeled rename candidates. */
export interface ApiDelta {
  fromId: string;
  toId: string;
  classesAdded: string[];
  classesRemoved: string[];
  /** member-level changes on classes present in both versions */
  methodsAdded: MemberChange[];
  methodsRemoved: MemberChange[];
  fieldsAdded: MemberChange[];
  fieldsRemoved: MemberChange[];
  /** same name, descriptor changed (the classic source-compat breaker) */
  methodsDescChanged: MemberChange[];
  fieldsDescChanged: MemberChange[];
  /** labeled structural rename candidates */
  classRenameCandidates: RenameCandidate[];
  memberRenameCandidates: RenameCandidate[];
}

const isVisible = (m: MemberApi) =>
  (m.access & (ACC.PUBLIC | ACC.PROTECTED)) !== 0 && (m.access & ACC.SYNTHETIC) === 0;

const visibleClass = (c: ClassApi) => (c.access & ACC.PUBLIC) !== 0 && (c.access & ACC.SYNTHETIC) === 0;

/**
 * Member-candidate descriptor-rarity thresholds, measured against the from-surface:
 * a descriptor occurring more than COMMON times is a weak signal (score 0.5);
 * more than NOISE times it carries no information and no candidate is emitted.
 */
const DESC_FREQ_COMMON = 20;
const DESC_FREQ_NOISE = 100;

/** Options for {@link computeDelta}. */
export interface DeltaOptions {
  /** Only diff the publicly reachable surface (default true — what mods can touch). */
  publicOnly?: boolean;
  /** Compute rename candidates (default true). */
  renameCandidates?: boolean;
}

/**
 * Computes the deterministic API delta between two jar surfaces.
 * All output lists are stably sorted; no randomness, no clock — identical
 * inputs always produce the identical delta.
 */
export function computeDelta(from: JarApi, to: JarApi, opts: DeltaOptions = {}): ApiDelta {
  const publicOnly = opts.publicOnly ?? true;
  const withCandidates = opts.renameCandidates ?? true;

  const keep = (c: ClassApi) => !publicOnly || visibleClass(c);
  const keepM = (m: MemberApi) => !publicOnly || isVisible(m);

  const delta: ApiDelta = {
    fromId: from.id,
    toId: to.id,
    classesAdded: [],
    classesRemoved: [],
    methodsAdded: [],
    methodsRemoved: [],
    fieldsAdded: [],
    fieldsRemoved: [],
    methodsDescChanged: [],
    fieldsDescChanged: [],
    classRenameCandidates: [],
    memberRenameCandidates: [],
  };

  // ---- classes ----
  for (const [name, cls] of from.classes) {
    if (!keep(cls)) continue;
    if (!to.classes.has(name)) delta.classesRemoved.push(name);
  }
  for (const [name, cls] of to.classes) {
    if (!keep(cls)) continue;
    if (!from.classes.has(name)) delta.classesAdded.push(name);
  }

  // ---- members on surviving classes ----
  for (const [name, oldCls] of from.classes) {
    const newCls = to.classes.get(name);
    if (!newCls || !keep(oldCls)) continue;

    diffMembers(name, 'method', oldCls.methods.filter(keepM), newCls.methods.filter(keepM), delta);
    diffMembers(name, 'field', oldCls.fields.filter(keepM), newCls.fields.filter(keepM), delta);
  }

  if (withCandidates) {
    computeClassRenameCandidates(from, to, delta);
    computeMemberRenameCandidates(delta, buildDescFrequency(from, keep, keepM));
  }

  // determinism: stable ordering of every output list
  const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  delta.classesAdded.sort(byStr);
  delta.classesRemoved.sort(byStr);
  const byOwner = (a: MemberChange, b: MemberChange) =>
    byStr(a.owner + '#' + a.name + a.desc, b.owner + '#' + b.name + b.desc);
  delta.methodsAdded.sort(byOwner);
  delta.methodsRemoved.sort(byOwner);
  delta.fieldsAdded.sort(byOwner);
  delta.fieldsRemoved.sort(byOwner);
  delta.methodsDescChanged.sort(byOwner);
  delta.fieldsDescChanged.sort(byOwner);
  // candidate from-keys are unique within each list (bijective construction), so this is a total order
  const candKey = (c: RenameCandidate) =>
    c.kind + '|' + c.from.owner + '#' + (c.from.name ?? '') + (c.from.desc ?? '');
  const byCand = (a: RenameCandidate, b: RenameCandidate) => byStr(candKey(a), candKey(b));
  delta.classRenameCandidates.sort(byCand);
  delta.memberRenameCandidates.sort(byCand);

  return delta;
}

function diffMembers(
  owner: string,
  kind: 'method' | 'field',
  oldList: MemberApi[],
  newList: MemberApi[],
  delta: ApiDelta,
): void {
  const key = (m: MemberApi) => m.name + ' ' + m.desc;
  const oldByKey = new Map(oldList.map((m) => [key(m), m]));
  const newByKey = new Map(newList.map((m) => [key(m), m]));
  const oldByName = groupBy(oldList, (m) => m.name);
  const newByName = groupBy(newList, (m) => m.name);

  for (const [k, m] of oldByKey) {
    if (newByKey.has(k)) continue;
    // same name survives with a different descriptor → desc change (not a removal)
    const sameName = newByName.get(m.name) ?? [];
    const oldSameName = oldByName.get(m.name) ?? [];
    // only classify as desc-change when it's unambiguous: exactly one old and one new with that name
    if (sameName.length === 1 && oldSameName.length === 1 && !newByKey.has(key(oldSameName[0]!))) {
      const change: MemberChange = { owner, kind, name: m.name, desc: m.desc, newDesc: sameName[0]!.desc };
      (kind === 'method' ? delta.methodsDescChanged : delta.fieldsDescChanged).push(change);
    } else {
      (kind === 'method' ? delta.methodsRemoved : delta.fieldsRemoved).push({ owner, kind, name: m.name, desc: m.desc });
    }
  }
  for (const [k, m] of newByKey) {
    if (oldByKey.has(k)) continue;
    const oldSameName = oldByName.get(m.name) ?? [];
    const newSameName = newByName.get(m.name) ?? [];
    if (oldSameName.length === 1 && newSameName.length === 1) continue; // already recorded as desc change
    (kind === 'method' ? delta.methodsAdded : delta.fieldsAdded).push({ owner, kind, name: m.name, desc: m.desc });
  }
}

/** Per-side view of a removed/added class used for structural matching. */
interface ClassSide {
  name: string;
  /** Visible member-signature fingerprint (`m:name+desc` / `f:name+desc`). */
  sig: Set<string>;
  /** Package prefix ('' for the default package). */
  pkg: string;
  /** Simple name (after the last '/'), inner-class `$` parts included. */
  simple: string;
}

/** A scored pairing between a removed and an added class. Symmetric in both directions. */
interface ClassMatch {
  other: ClassSide;
  /** Jaccard × package-locality factor; the emitted candidate score. */
  score: number;
  jaccard: number;
  overlap: number;
  samePkg: boolean;
  /**
   * Tiebreak 1: RAW common-suffix length of simple names. Deliberately not
   * normalized by name length — normalizing rewards short unrelated names over
   * long related ones (LocatorBarRenderer would beat ExperienceBarRenderer for
   * ExperienceBar), the exact observed false-positive mode.
   */
  suffixLen: number;
  /** Tiebreak 2: 1 − Levenshtein(simple names) / max simple-name length. */
  editSim: number;
}

/**
 * Class rename candidates: removed class R vs added class A scored on structural
 * fingerprints (Jaccard over visible member signatures × package locality).
 *
 * BIJECTIVE constraint: a pair (R, A) is emitted only when A is R's unique best
 * match AND R is A's unique best match (mutual best). Equal scores are tiebroken
 * by simple-name similarity (raw common-suffix length, then normalized edit
 * distance, then lexicographic name — a total deterministic order). This guarantees no two
 * candidates ever share the same `to` (the observed P0-class false-positive mode:
 * several removed renderers all mapping to one added class with score 1).
 */
function computeClassRenameCandidates(from: JarApi, to: JarApi, delta: ApiDelta): void {
  const mkSide = (name: string, cls: ClassApi): ClassSide => {
    const sig = new Set<string>();
    for (const m of cls.methods) if (isVisible(m)) sig.add('m:' + m.name + m.desc);
    for (const f of cls.fields) if (isVisible(f)) sig.add('f:' + f.name + f.desc);
    const slash = name.lastIndexOf('/');
    return {
      name,
      sig,
      pkg: slash < 0 ? '' : name.slice(0, slash),
      simple: slash < 0 ? name : name.slice(slash + 1),
    };
  };

  // Empty fingerprints carry no structural evidence on either side — excluded up front.
  const removedSides: ClassSide[] = [];
  for (const n of delta.classesRemoved) {
    const cls = from.classes.get(n);
    if (!cls) continue; // unreachable by construction; explicit for strict indexing
    const side = mkSide(n, cls);
    if (side.sig.size > 0) removedSides.push(side);
  }
  const addedSides: ClassSide[] = [];
  for (const n of delta.classesAdded) {
    const cls = to.classes.get(n);
    if (!cls) continue;
    const side = mkSide(n, cls);
    if (side.sig.size > 0) addedSides.push(side);
  }

  // Symmetric pair score — identical regardless of which side is `self`, so
  // mutual-best is well-defined.
  const matchOf = (self: ClassSide, other: ClassSide): ClassMatch | null => {
    let overlap = 0;
    for (const s of self.sig) if (other.sig.has(s)) overlap++;
    if (overlap === 0) return null;
    const jaccard = overlap / (self.sig.size + other.sig.size - overlap);
    const samePkg = self.pkg === other.pkg;
    const score = jaccard * (samePkg ? 1 : 0.85);
    if (score <= 0.5) return null;
    const maxLen = Math.max(self.simple.length, other.simple.length);
    return {
      other,
      score,
      jaccard,
      overlap,
      samePkg,
      suffixLen: commonSuffixLen(self.simple, other.simple),
      editSim: maxLen === 0 ? 0 : 1 - editDistance(self.simple, other.simple) / maxLen,
    };
  };

  // Total order on matches: score, then name-similarity tiebreaks, then
  // lexicographic — never ambiguous, fully deterministic.
  const better = (m: ClassMatch, b: ClassMatch): boolean => {
    if (m.score !== b.score) return m.score > b.score;
    if (m.suffixLen !== b.suffixLen) return m.suffixLen > b.suffixLen;
    if (m.editSim !== b.editSim) return m.editSim > b.editSim;
    return m.other.name < b.other.name;
  };

  // Two matches are evidence-equal when every structural dimension ties — the
  // lexicographic arm of `better` exists only for deterministic SORTING and
  // must never be allowed to fake a decision between them.
  const evidenceEqual = (a: ClassMatch, b: ClassMatch): boolean =>
    a.score === b.score && a.suffixLen === b.suffixLen && a.editSim === b.editSim;

  const bestIn = (self: ClassSide, pool: ClassSide[]): ClassMatch | null => {
    let best: ClassMatch | null = null;
    let second: ClassMatch | null = null;
    for (const other of pool) {
      const m = matchOf(self, other);
      if (!m) continue;
      if (!best || better(m, best)) {
        second = best;
        best = m;
      } else if (!second || better(m, second)) {
        second = m;
      }
    }
    // A tie on the actual evidence = structural ambiguity = no best match.
    if (best && second && evidenceEqual(best, second)) return null;
    return best;
  };

  const bestForAdded = new Map<string, ClassMatch>();
  for (const a of addedSides) {
    const m = bestIn(a, removedSides);
    if (m) bestForAdded.set(a.name, m);
  }

  for (const r of removedSides) {
    const fwd = bestIn(r, addedSides);
    if (!fwd) continue;
    const back = bestForAdded.get(fwd.other.name);
    if (!back || back.other.name !== r.name) continue; // not mutual best — ambiguous, suppressed
    delta.classRenameCandidates.push({
      kind: 'class',
      from: { owner: r.name },
      to: { owner: fwd.other.name },
      score: Math.round(fwd.score * 100) / 100,
      evidence:
        `Mutual best structural match: ${fwd.overlap} identical visible member signatures ` +
        `(removed has ${r.sig.size}, added has ${fwd.other.sig.size}; Jaccard ${fwd.jaccard.toFixed(2)}), ` +
        `${fwd.samePkg ? 'same package' : 'different package (×0.85)'}; ` +
        `name similarity: common suffix ${fwd.suffixLen} chars, edit similarity ${fwd.editSim.toFixed(2)}. ` +
        `Renames cannot be asserted — strong but unprovable; verify against changelogs or source.`,
    });
  }
}

/**
 * Member rename candidates within one class: removed member vs added member with
 * IDENTICAL descriptor — the strongest structural rename signal that exists.
 *
 * BIJECTIVE constraint: emitted only when the removed member is the SOLE removal
 * with that (owner, desc) AND the added member is the SOLE addition with that
 * (owner, desc) — a strict 1:1 pairing (the observed false-positive mode: four
 * removed methods all mapping to one added `()Ljava/util/List;` getter).
 *
 * Descriptor-rarity factor (frequency measured across the whole from-surface,
 * same visibility filter as the delta): > {@link DESC_FREQ_COMMON} occurrences
 * → common shape, score 0.5; > {@link DESC_FREQ_NOISE} → pure noise, no
 * candidate emitted (the removal/addition stays in the exact delta lists).
 */
function computeMemberRenameCandidates(delta: ApiDelta, descFreq: Map<string, number>): void {
  const pair = (removed: MemberChange[], added: MemberChange[]) => {
    const ownerDesc = (m: MemberChange) => m.owner + ' ' + m.desc;
    const removedByOwnerDesc = groupBy(removed, ownerDesc);
    const addedByOwnerDesc = groupBy(added, ownerDesc);
    for (const [k, rems] of removedByOwnerDesc) {
      if (rems.length !== 1) continue; // ambiguous on the removed side — suppressed
      const adds = addedByOwnerDesc.get(k) ?? [];
      if (adds.length !== 1) continue; // ambiguous on the added side — suppressed
      const r = rems[0]!;
      const a = adds[0]!;
      const freq = descFreq.get(r.desc) ?? 1;
      if (freq > DESC_FREQ_NOISE) continue; // descriptor shape carries no information
      const common = freq > DESC_FREQ_COMMON;
      delta.memberRenameCandidates.push({
        kind: r.kind,
        from: { owner: r.owner, name: r.name, desc: r.desc },
        to: { owner: r.owner, name: a.name, desc: r.desc },
        score: common ? 0.5 : 0.8,
        evidence: common
          ? `Sole ${r.kind} removed and sole ${r.kind} added on ${r.owner} with identical descriptor ` +
            `${r.desc}, but that descriptor is a common shape: ${freq} occurrences on the ` +
            `${delta.fromId} surface (>${DESC_FREQ_COMMON}) — weak signal; verify carefully.`
          : `Sole ${r.kind} removed and sole ${r.kind} added on ${r.owner} with identical descriptor ` +
            `${r.desc} (${freq} occurrence${freq === 1 ? '' : 's'} on the ${delta.fromId} surface) — ` +
            `strong but unprovable; verify.`,
      });
    }
  };
  pair(delta.methodsRemoved, delta.methodsAdded);
  pair(delta.fieldsRemoved, delta.fieldsAdded);
}

/**
 * Descriptor frequency over the from-surface, under the same visibility filter
 * as the delta itself. Method and field descriptors cannot collide (method
 * descriptors start with '('), so one combined map is sound.
 */
function buildDescFrequency(
  from: JarApi,
  keep: (c: ClassApi) => boolean,
  keepM: (m: MemberApi) => boolean,
): Map<string, number> {
  const freq = new Map<string, number>();
  const bump = (d: string) => freq.set(d, (freq.get(d) ?? 0) + 1);
  for (const cls of from.classes.values()) {
    if (!keep(cls)) continue;
    for (const m of cls.methods) if (keepM(m)) bump(m.desc);
    for (const f of cls.fields) if (keepM(f)) bump(f.desc);
  }
  return freq;
}

/** Length of the longest common suffix of two strings. */
function commonSuffixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}

/** Levenshtein edit distance (two-row DP). Inputs are short simple names. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const n = b.length;
  if (a.length === 0) return n;
  if (n === 0) return a.length;
  let prev: number[] = [];
  for (let j = 0; j <= n; j++) prev.push(j);
  let curr: number[] = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n]!;
}

function groupBy<T>(list: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of list) {
    const k = key(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
}
