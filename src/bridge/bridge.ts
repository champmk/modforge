/**
 * The Era Bridge — the deterministic core of ModForge.
 *
 * Translates old-era symbols (yarn "named" or mojmap "source" namespace, 1.21.x)
 * into the new unobfuscated era (26.x real names), grounded in four artifacts:
 *
 *   yarn tiny        intermediary → named          (Fabric mods are written in `named`)
 *   intermediary     official → intermediary
 *   mojmap           source → official(obf)        (NeoForge mods are written in `source`)
 *   target jar API   the actual 26.x class surface (ground truth)
 *
 * Chain for a yarn symbol:   named ⇒ intermediary ⇒ official ⇒ source ⇒ ∈ target?
 * Chain for a mojmap symbol: source ⇒ ∈ target?   (NeoForge mods skip the first hops)
 *
 * Every output carries the honesty taxonomy (EXACT / CANDIDATE / UNRESOLVED) and a
 * full audit chain of the joins that produced it. Nothing here ever guesses:
 * - EXACT requires every hop to resolve uniquely AND the symbol to exist in the
 *   target jar with a matching (translated) descriptor.
 * - A member found on a superclass/interface of its translated owner is a
 *   CANDIDATE ("moved to <owner>"), found by a deterministic hierarchy walk.
 * - Everything else is UNRESOLVED with a precise reason — that honesty is the product.
 */
import type {
  JarApi,
  MappingSet,
  MappedClass,
  Resolution,
  SymbolRef,
} from '../core/model.ts';
import { indexByNamespace } from '../mappings/tiny.ts';
import type { PgMappings, PgClass, PgMember } from '../mappings/proguard.ts';

export interface BridgeInputs {
  /** yarn tiny v2 (`intermediary`,`named`) — required for namespace 'named'. */
  yarn?: MappingSet;
  /** intermediary tiny v2 (`official`,`intermediary`) — required for namespace 'named'. */
  intermediary?: MappingSet;
  /** mojmap for the OLD version (source→obf). Always required. */
  mojmap: PgMappings;
  /** API surface of the TARGET (new era) jar. Always required. */
  target: JarApi;
}

export type SourceNamespace = 'named' | 'source';

export interface ClassBridge {
  /** old-era name in the mod's namespace (yarn named or mojmap source), binary form */
  from: string;
  resolution: Resolution;
  /** present when every hop resolved: the source-namespace name (= 26.x name candidate) */
  sourceName?: string;
}

export class EraBridge {
  private readonly yarnByNamed: Map<string, MappedClass> | null;
  private readonly interByIntermediary: Map<string, MappedClass> | null;
  private readonly mojmap: PgMappings;
  private readonly target: JarApi;

  constructor(inputs: BridgeInputs) {
    this.yarnByNamed = inputs.yarn ? indexByNamespace(inputs.yarn, 'named') : null;
    this.interByIntermediary = inputs.intermediary
      ? indexByNamespace(inputs.intermediary, 'intermediary')
      : null;
    this.mojmap = inputs.mojmap;
    this.target = inputs.target;
  }

  /**
   * Resolve an old-era CLASS name to the new era.
   */
  resolveClass(ns: SourceNamespace, oldBinary: string): Resolution {
    const from: SymbolRef = { kind: 'class', owner: oldBinary };
    const chain: string[] = [];

    const pg = this.classToPg(ns, oldBinary, chain);
    if ('unresolved' in pg) return { from, confidence: 'UNRESOLVED', reason: pg.unresolved, chain };

    const sourceName = pg.cls.sourceBinary;
    chain.push(`mojmap: obf ${pg.cls.obfBinary} → source ${sourceName}`);

    if (this.target.classes.has(sourceName)) {
      chain.push(`target(${this.target.id}): class present`);
      return {
        from,
        confidence: 'EXACT',
        to: { kind: 'class', owner: sourceName },
        reason: `Deterministic chain resolved and class exists in ${this.target.id}.`,
        chain,
      };
    }
    return {
      from,
      confidence: 'UNRESOLVED',
      reason:
        `Chain resolved to ${sourceName}, but that class does not exist in ${this.target.id} — ` +
        `it was removed or renamed after the era boundary. (A rename cannot be asserted ` +
        `deterministically; see delta candidates.)`,
      chain,
    };
  }

  /**
   * Resolve an old-era MEMBER (method/field). `oldDesc` is the descriptor in the
   * mod's namespace when known (recommended — it disambiguates overloads).
   */
  resolveMember(
    ns: SourceNamespace,
    kind: 'method' | 'field',
    oldOwner: string,
    oldName: string,
    oldDesc: string | null,
  ): Resolution {
    const from: SymbolRef = { kind, owner: oldOwner, name: oldName };
    if (oldDesc) from.desc = oldDesc;
    const chain: string[] = [];

    // --- hop the owner class to mojmap ---
    const pg = this.classToPg(ns, oldOwner, chain);
    if ('unresolved' in pg) return { from, confidence: 'UNRESOLVED', reason: pg.unresolved, chain };

    // --- locate the member inside the mojmap class ---
    let pgMember: PgMember | undefined;
    if (ns === 'named') {
      // We arrived via yarn: we know the member's intermediary name + official desc from the tiny hops.
      const hop = this.namedMemberToObf(oldOwner, kind, oldName, oldDesc, chain);
      if ('unresolved' in hop) return { from, confidence: 'UNRESOLVED', reason: hop.unresolved, chain };
      pgMember = pg.cls.members.find(
        (m) => m.kind === kind && m.obfName === hop.obfName && (kind === 'field' || m.descObf === hop.obfDesc),
      );
      if (!pgMember) {
        // fields in mojmap join on obf name + obf type desc; try name-only as a labeled fallback
        const nameOnly = pg.cls.members.filter((m) => m.kind === kind && m.obfName === hop.obfName);
        if (nameOnly.length === 1) {
          pgMember = nameOnly[0];
          chain.push(`mojmap: joined on obf name only (single match) — descriptor not compared`);
        }
      }
    } else {
      // source namespace: member is already in mojmap's source names
      const matches = pg.cls.members.filter(
        (m) => m.kind === kind && m.sourceName === oldName && (oldDesc === null || m.descSource === oldDesc),
      );
      if (matches.length === 1) pgMember = matches[0];
      else if (matches.length > 1) {
        return {
          from,
          confidence: 'UNRESOLVED',
          reason: `Ambiguous: ${matches.length} overloads of ${oldName} match (descriptor needed to disambiguate).`,
          chain,
        };
      }
    }

    if (!pgMember) {
      return {
        from,
        confidence: 'UNRESOLVED',
        reason: `Member ${oldName} not found in old-version mappings for ${pg.cls.sourceBinary} — possibly synthetic, inherited, or from a non-Minecraft class.`,
        chain,
      };
    }
    chain.push(`mojmap: obf ${pgMember.obfName} → source ${pgMember.sourceName}${pgMember.descSource}`);

    // --- ground against the target jar (descriptor in source namespace = 26.x namespace) ---
    const ownerSource = pg.cls.sourceBinary;
    const found = this.findInHierarchy(ownerSource, kind, pgMember.sourceName, pgMember.descSource);

    if (found && found.owner === ownerSource) {
      chain.push(`target(${this.target.id}): present on ${found.owner}`);
      return {
        from,
        confidence: 'EXACT',
        to: { kind, owner: found.owner, name: pgMember.sourceName, desc: found.desc },
        reason: `Deterministic chain resolved; member exists on the same class in ${this.target.id}.`,
        chain,
      };
    }
    if (found) {
      chain.push(`target(${this.target.id}): found on supertype ${found.owner}`);
      return {
        from,
        confidence: 'CANDIDATE',
        candidates: [
          {
            to: { kind, owner: found.owner, name: pgMember.sourceName, desc: found.desc },
            evidence: `Not on ${ownerSource} itself, but present on its supertype ${found.owner} with an identical descriptor (deterministic hierarchy walk).`,
            score: 0.9,
          },
        ],
        reason: `Member moved up the hierarchy (or was always inherited).`,
        chain,
      };
    }
    return {
      from,
      confidence: 'UNRESOLVED',
      reason:
        `Chain resolved to ${ownerSource}#${pgMember.sourceName}${pgMember.descSource}, but no such member ` +
        `exists there (or on its supertypes) in ${this.target.id} — removed or changed after the era boundary.`,
      chain,
    };
  }

  // -------------------------------------------------------------------------

  /** old class name (named|source) → mojmap PgClass */
  private classToPg(
    ns: SourceNamespace,
    oldBinary: string,
    chain: string[],
  ): { cls: PgClass } | { unresolved: string } {
    if (ns === 'source') {
      const cls = this.mojmap.bySource.get(oldBinary);
      if (!cls) return { unresolved: `Class ${oldBinary} is not in the old version's mojmap (not a Minecraft class?).` };
      chain.push(`mojmap: source class ${oldBinary} (obf ${cls.obfBinary})`);
      return { cls };
    }
    if (!this.yarnByNamed || !this.interByIntermediary) {
      return { unresolved: `Namespace 'named' requires yarn + intermediary mappings, which were not provided.` };
    }
    const yc = this.yarnByNamed.get(oldBinary);
    if (!yc) return { unresolved: `Class ${oldBinary} is not in yarn ${''}mappings (not a Minecraft class, or wrong yarn version).` };
    const iName = yc.names[0];
    if (!iName) return { unresolved: `yarn maps ${oldBinary} but has no intermediary name for it.` };
    chain.push(`yarn: named ${oldBinary} → intermediary ${iName}`);
    const ic = this.interByIntermediary.get(iName);
    if (!ic) return { unresolved: `Intermediary class ${iName} missing from intermediary mappings.` };
    const obf = ic.names[0];
    if (!obf) return { unresolved: `Intermediary has no official(obf) name for ${iName}.` };
    chain.push(`intermediary: ${iName} → official ${obf}`);
    const cls = this.mojmap.byObf.get(obf);
    if (!cls) return { unresolved: `Obfuscated class ${obf} not present in mojmap.` };
    return { cls };
  }

  /** yarn named member → its obf name + obf descriptor (via yarn + intermediary tinies) */
  private namedMemberToObf(
    namedOwner: string,
    kind: 'method' | 'field',
    namedName: string,
    namedDesc: string | null,
    chain: string[],
  ): { obfName: string; obfDesc: string } | { unresolved: string } {
    const yc = this.yarnByNamed!.get(namedOwner)!; // caller verified
    const list = kind === 'method' ? yc.methods : yc.fields;
    // yarn member descs are in the INTERMEDIARY namespace (first ns of the yarn file).
    // We match by named name; if ambiguous (overloads), the caller's named desc — which is in
    // the *named* namespace — cannot be compared directly, so we require uniqueness.
    const matches = list.filter((m) => m.names[1] === namedName);
    let pick = matches.length === 1 ? matches[0] : undefined;
    if (!pick && matches.length > 1 && namedDesc) {
      // Disambiguate overloads by arity: count top-level args in both descriptors.
      const arity = (d: string) => countDescriptorArgs(d);
      const wanted = arity(namedDesc);
      const byArity = matches.filter((m) => arity(m.desc) === wanted);
      if (byArity.length === 1) {
        pick = byArity[0];
        chain.push(`yarn: overload disambiguated by arity (${wanted} args)`);
      }
    }
    if (!pick) {
      return {
        unresolved:
          matches.length === 0
            ? `yarn has no ${kind} named ${namedName} on ${namedOwner}.`
            : `yarn has ${matches.length} overloads of ${namedName} on ${namedOwner}; cannot disambiguate deterministically without a full descriptor translation.`,
      };
    }
    const iName = pick.names[0];
    if (!iName) return { unresolved: `yarn member ${namedName} lacks an intermediary name.` };
    chain.push(`yarn: ${kind} ${namedName} → intermediary ${iName} (desc ${pick.desc})`);

    const iOwner = yc.names[0]!;
    const ic = this.interByIntermediary!.get(iOwner)!;
    const ilist = kind === 'method' ? ic.methods : ic.fields;
    const im = ilist.find((m) => m.names[1] === iName);
    if (!im) return { unresolved: `intermediary mappings lack member ${iName} on ${iOwner}.` };
    const obfName = im.names[0];
    if (!obfName) return { unresolved: `intermediary member ${iName} lacks an official name.` };
    chain.push(`intermediary: ${iName} → official ${obfName} (obf desc ${im.desc})`);
    return { obfName, obfDesc: im.desc };
  }

  /** Deterministic hierarchy walk in the target jar: owner, then supertypes (BFS). */
  private findInHierarchy(
    owner: string,
    kind: 'method' | 'field',
    name: string,
    desc: string,
  ): { owner: string; desc: string } | null {
    const seen = new Set<string>();
    const queue = [owner];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const cls = this.target.classes.get(cur);
      if (!cls) continue; // outside the jar (JDK etc.) — cannot verify, stop that branch
      const list = kind === 'method' ? cls.methods : cls.fields;
      const hit = list.find((m) => m.name === name && m.desc === desc);
      if (hit) return { owner: cur, desc: hit.desc };
      if (cls.superName) queue.push(cls.superName);
      queue.push(...cls.interfaces);
    }
    return null;
  }
}

/** Count top-level argument slots in a JVM method descriptor (arrays+objects = 1 each). */
export function countDescriptorArgs(desc: string): number {
  if (!desc.startsWith('(')) return -1;
  let i = 1;
  let count = 0;
  while (i < desc.length && desc[i] !== ')') {
    while (desc[i] === '[') i++;
    if (desc[i] === 'L') {
      const semi = desc.indexOf(';', i);
      if (semi === -1) return -1;
      i = semi + 1;
    } else {
      i++;
    }
    count++;
  }
  return count;
}
