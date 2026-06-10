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
 * Three optional layers sharpen the chain (all deterministic, all audited):
 * - Named-descriptor translation: a caller-supplied descriptor in the `named`
 *   namespace is translated named→intermediary (class types via the yarn map) and
 *   matched EXACTLY against yarn's intermediary descriptors — overloads resolve
 *   exactly instead of falling to arity heuristics or UNRESOLVED.
 * - Old-hierarchy walk (`BridgeInputs.oldHierarchy`): members referenced on a class
 *   but declared on a supertype in the OLD world (e.g. PlayerEntity#getHealth,
 *   declared on LivingEntity) are found by a deterministic BFS over the old
 *   obfuscated jar's hierarchy. A hit can still be EXACT — every hop is a
 *   deterministic join and the result is re-grounded in the target jar.
 * - Rename layer (`BridgeInputs.renames`): when jar grounding misses, boundary
 *   renames (ResourceLocation→Identifier, getDayTime→getOverworldClockTime, …)
 *   are consulted. A hit is ALWAYS a CANDIDATE carrying the table's evidence and
 *   score — never auto-applied, never upgraded to EXACT.
 *
 * Every output carries the honesty taxonomy (EXACT / CANDIDATE / UNRESOLVED) and a
 * full audit chain of the joins that produced it. Nothing here ever guesses:
 * - EXACT requires every hop to resolve uniquely AND the symbol to exist in the
 *   target jar with a matching (translated) descriptor.
 * - A member found on a superclass/interface of its translated owner (when the OLD
 *   world declared it on the owner itself) is a CANDIDATE ("moved to <owner>").
 * - Everything else is UNRESOLVED with a precise reason — that honesty is the product.
 */
import type {
  JarApi,
  MappingSet,
  MappedClass,
  MappedMember,
  Resolution,
  SymbolRef,
} from '../core/model.ts';
import { indexByNamespace } from '../mappings/tiny.ts';
import type { PgMappings, PgClass, PgMember } from '../mappings/proguard.ts';
// renames.ts is the boundary rename layer (ARCHITECTURE §3.2). Type-only import:
// erased at runtime, so this module loads even before renames.ts lands.
import type { RenameTable } from './renames.ts';

/** Superclass/interface record of one class in the OLD obfuscated jar. */
export interface OldHierarchyEntry {
  /** Direct superclass, OBF binary name (null only for java/lang/Object). */
  superName: string | null;
  /** Directly implemented interfaces, OBF binary names, in declared order. */
  interfaces: string[];
}

export interface BridgeInputs {
  /** yarn tiny v2 (`intermediary`,`named`) — required for namespace 'named'. */
  yarn?: MappingSet;
  /** intermediary tiny v2 (`official`,`intermediary`) — required for namespace 'named'. */
  intermediary?: MappingSet;
  /** mojmap for the OLD version (source→obf). Always required. */
  mojmap: PgMappings;
  /** API surface of the TARGET (new era) jar. Always required. */
  target: JarApi;
  /**
   * OPTIONAL: hierarchy of the OLD obfuscated jar, keyed by OBF binary name.
   * Build it by parsing the old client jar with `extractJarApi` and collecting
   * `{ superName, interfaces }` per class (names come out in the obf namespace).
   * Enables deterministic resolution of inherited members; without it those are
   * honest UNRESOLVED with a hint.
   */
  oldHierarchy?: Map<string, OldHierarchyEntry>;
  /**
   * OPTIONAL: the boundary rename layer (derived table + oracle seeds).
   * Consulted only when jar grounding misses; hits are CANDIDATE with the
   * entry's evidence/score — never EXACT, never auto-applied.
   */
  renames?: RenameTable;
}

export type SourceNamespace = 'named' | 'source';

export interface ClassBridge {
  /** old-era name in the mod's namespace (yarn named or mojmap source), binary form */
  from: string;
  resolution: Resolution;
  /** present when every hop resolved: the source-namespace name (= 26.x name candidate) */
  sourceName?: string;
}

/** yarn-member hop result; flags distinguish honest failure modes for the hierarchy walk. */
type MemberHop =
  | { obfName: string; obfDesc: string }
  | {
      unresolved: string;
      /** the named member simply isn't declared on this class (inheritance is possible) */
      notFound?: true;
      /** the name exists but the translated descriptor matches no declaration */
      descMismatch?: true;
    };

/** Result of the old-hierarchy walk for an inherited member. */
type InheritedLookup =
  | { pgMember: PgMember; declaredOn: string; notes: string[]; walked: number }
  | { unresolved: string; walked: number }
  | { walked: number; nearMisses: string[] };

export class EraBridge {
  private readonly yarnByNamed: Map<string, MappedClass> | null;
  private readonly yarnByIntermediary: Map<string, MappedClass> | null;
  private readonly interByIntermediary: Map<string, MappedClass> | null;
  private readonly interByObf: Map<string, MappedClass> | null;
  private readonly mojmap: PgMappings;
  private readonly target: JarApi;
  private readonly oldHierarchy: Map<string, OldHierarchyEntry> | null;
  private readonly renames: RenameTable | null;

  constructor(inputs: BridgeInputs) {
    // Forward AND reverse indexes are built once here — the old-hierarchy walk
    // needs obf→intermediary→named lookups and must never re-scan per call.
    this.yarnByNamed = inputs.yarn ? indexByNamespace(inputs.yarn, 'named') : null;
    this.yarnByIntermediary = inputs.yarn ? indexByNamespace(inputs.yarn, 'intermediary') : null;
    this.interByIntermediary = inputs.intermediary
      ? indexByNamespace(inputs.intermediary, 'intermediary')
      : null;
    this.interByObf = inputs.intermediary ? indexByNamespace(inputs.intermediary, 'official') : null;
    this.mojmap = inputs.mojmap;
    this.target = inputs.target;
    this.oldHierarchy = inputs.oldHierarchy ?? null;
    this.renames = inputs.renames ?? null;
  }

  /**
   * Resolve an old-era CLASS name to the new era.
   * Jar-grounding miss consults the rename layer (when provided) → CANDIDATE;
   * otherwise UNRESOLVED with a reason that states the rename-layer status.
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
    chain.push(`target(${this.target.id}): class ${sourceName} absent`);

    const baseReason =
      `Chain resolved to ${sourceName}, but that class does not exist in ${this.target.id} — ` +
      `it was removed or renamed after the era boundary.`;

    if (!this.renames) {
      return {
        from,
        confidence: 'UNRESOLVED',
        reason: `${baseReason} No rename table was provided (BridgeInputs.renames), so boundary-rename candidates could not be consulted.`,
        chain,
      };
    }
    const ce = this.renames.classRename(sourceName);
    if (!ce) {
      return {
        from,
        confidence: 'UNRESOLVED',
        reason: `${baseReason} The rename layer has no candidate for it either.`,
        chain,
      };
    }
    // RenameEntry.to is a SymbolRef — the proposed class lives in `.owner`.
    const ceTo = ce.to.owner;
    if (!this.target.classes.has(ceTo)) {
      // A rename candidate pointing at a class absent from the target jar is worse
      // than no answer — reject it loudly instead of presenting it.
      chain.push(`rename-layer: entry ${sourceName} → ${ceTo} REJECTED (not present in ${this.target.id})`);
      return {
        from,
        confidence: 'UNRESOLVED',
        reason: `${baseReason} A rename-layer entry ${sourceName} → ${ceTo} exists but ${ceTo} is not in ${this.target.id} (stale table) — rejected.`,
        chain,
      };
    }
    chain.push(`rename-layer: ${sourceName} → ${ceTo} (score ${ce.score})`);
    chain.push(`target(${this.target.id}): class ${ceTo} present`);
    return {
      from,
      confidence: 'CANDIDATE',
      candidates: [
        {
          to: { kind: 'class', owner: ceTo },
          evidence: `${ce.evidence} Grounded: ${ceTo} exists in ${this.target.id}.`,
          score: ce.score,
        },
      ],
      reason: `${baseReason} The rename layer supplies a grounded candidate — CANDIDATE, never auto-applied.`,
      chain,
    };
  }

  /**
   * Resolve an old-era MEMBER (method/field). `oldDesc` is the descriptor in the
   * mod's namespace when known (recommended — it disambiguates overloads; for
   * namespace 'named' it is translated named→intermediary and matched exactly).
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

    // --- locate the member's mojmap entry (on the class, or up the OLD hierarchy) ---
    let pgMember: PgMember;
    let inheritedFrom: string | null = null;

    if (ns === 'named') {
      const yc = pg.yc;
      const ic = pg.ic;
      if (!yc || !ic) {
        return {
          from,
          confidence: 'UNRESOLVED',
          reason: `Internal invariant violated: named-namespace class hop yielded no tiny classes for ${oldOwner}.`,
          chain,
        };
      }
      const hop = this.namedMemberToObf(oldOwner, yc, ic, kind, oldName, oldDesc, chain);
      if ('unresolved' in hop) {
        if (!hop.notFound) return { from, confidence: 'UNRESOLVED', reason: hop.unresolved, chain };
        const inh = this.tryInherited(ns, from, chain, hop.unresolved, pg.cls.obfBinary, kind, oldName, oldDesc);
        if ('resolution' in inh) return inh.resolution;
        pgMember = inh.pgMember;
        inheritedFrom = inh.inheritedFrom;
      } else {
        let found = pg.cls.members.find(
          (m) => m.kind === kind && m.obfName === hop.obfName && (kind === 'field' || m.descObf === hop.obfDesc),
        );
        if (!found) {
          // fields in mojmap join on obf name + obf type desc; try name-only as a labeled fallback
          const nameOnly = pg.cls.members.filter((m) => m.kind === kind && m.obfName === hop.obfName);
          if (nameOnly.length === 1) {
            found = nameOnly[0]!;
            chain.push(`mojmap: joined on obf name only (single match) — descriptor not compared`);
          }
        }
        if (!found) {
          return {
            from,
            confidence: 'UNRESOLVED',
            reason:
              `yarn/intermediary resolved ${oldName} to obf ${hop.obfName}${hop.obfDesc} on ${pg.cls.obfBinary}, ` +
              `but mojmap lists no such member on ${pg.cls.sourceBinary} — possibly synthetic, or a yarn/mojmap ` +
              `disagreement for this version.`,
            chain,
          };
        }
        pgMember = found;
      }
    } else {
      // source namespace: member is already in mojmap's source names
      const matches = pg.cls.members.filter(
        (m) => m.kind === kind && m.sourceName === oldName && (oldDesc === null || m.descSource === oldDesc),
      );
      if (matches.length > 1) {
        return {
          from,
          confidence: 'UNRESOLVED',
          reason: `Ambiguous: ${matches.length} overloads of ${oldName} match (descriptor needed to disambiguate).`,
          chain,
        };
      }
      if (matches.length === 1) {
        pgMember = matches[0]!;
      } else {
        const inh = this.tryInherited(
          ns,
          from,
          chain,
          `Member ${oldName} is not declared on ${pg.cls.sourceBinary} in the old version's mojmap.`,
          pg.cls.obfBinary,
          kind,
          oldName,
          oldDesc,
        );
        if ('resolution' in inh) return inh.resolution;
        pgMember = inh.pgMember;
        inheritedFrom = inh.inheritedFrom;
      }
    }

    chain.push(`mojmap: obf ${pgMember.obfName} → source ${pgMember.sourceName}${pgMember.descSource}`);

    // --- ground against the target jar (descriptor in source namespace = 26.x namespace) ---
    return this.groundMember(from, kind, chain, pg.cls.sourceBinary, pgMember, inheritedFrom);
  }

  // -------------------------------------------------------------------------

  /**
   * old class name (named|source) → mojmap PgClass. For namespace 'named' the
   * yarn and intermediary class records are returned too (the member hop and the
   * descriptor translation need them).
   */
  private classToPg(
    ns: SourceNamespace,
    oldBinary: string,
    chain: string[],
  ): { cls: PgClass; yc?: MappedClass; ic?: MappedClass } | { unresolved: string } {
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
    if (!yc) return { unresolved: `Class ${oldBinary} is not in yarn mappings (not a Minecraft class, or wrong yarn version).` };
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
    return { cls, yc, ic };
  }

  /**
   * named→intermediary class translation for descriptor types.
   * - yarn hit → intermediary name.
   * - miss under `net/minecraft/` → null: every yarn-named MC class lives in the
   *   yarn map, so a miss is a genuine translation failure (wrong yarn version,
   *   or an intermediary fall-through name the user pasted).
   * - any other miss → identity: JDK / library / mod classes are identical across
   *   namespaces and must pass through untouched.
   * Caveat (encoded honestly): a `com/mojang/*` MC class absent from the provided
   * yarn (version skew) passes through untranslated; the result is a descriptor
   * mismatch reported as UNRESOLVED — never a wrong overload pick.
   */
  private readonly mapNamedToIntermediary = (binary: string): string | null => {
    const yc = this.yarnByNamed?.get(binary);
    const iName = yc?.names[0];
    if (iName) return iName;
    return binary.startsWith('net/minecraft/') ? null : binary;
  };

  /**
   * yarn named member → its obf name + obf descriptor (via yarn + intermediary tinies).
   * When `namedDesc` is given and fully translates named→intermediary, the match is
   * EXACT against yarn's intermediary descriptors (kills overload ambiguity). Arity
   * disambiguation only runs when translation legitimately cannot complete.
   */
  private namedMemberToObf(
    displayOwner: string,
    yc: MappedClass,
    ic: MappedClass,
    kind: 'method' | 'field',
    namedName: string,
    namedDesc: string | null,
    chain: string[],
  ): MemberHop {
    const list = kind === 'method' ? yc.methods : yc.fields;
    // yarn member descs are in the INTERMEDIARY namespace (first ns of the yarn file).
    const matches = list.filter((m) => m.names[1] === namedName);
    if (matches.length === 0) {
      return { unresolved: `yarn has no ${kind} named ${namedName} on ${displayOwner}.`, notFound: true };
    }

    let pick: MappedMember | undefined;
    if (namedDesc !== null) {
      const translated = translateDesc(namedDesc, this.mapNamedToIntermediary);
      if (translated !== null) {
        const byDesc = matches.filter((m) => m.desc === translated);
        if (byDesc.length === 1) {
          pick = byDesc[0]!;
          chain.push(
            matches.length > 1
              ? `yarn: overload resolved exactly by named→intermediary descriptor translation (${namedDesc} → ${translated})`
              : `yarn: descriptor verified by named→intermediary translation (${translated})`,
          );
        } else if (byDesc.length === 0) {
          const have = matches.map((m) => m.desc).sort().join(', ');
          return {
            unresolved:
              `Descriptor mismatch on ${displayOwner}#${namedName}: the given named descriptor ${namedDesc} ` +
              `translates to intermediary ${translated}, but yarn declares [${have}]. Not picking a different ` +
              `overload — that could be confidently wrong.`,
            descMismatch: true,
          };
        } else {
          return {
            unresolved: `yarn declares ${byDesc.length} members ${namedName} ${translated} on ${displayOwner} — corrupt or duplicated mappings.`,
          };
        }
      } else if (matches.length > 1) {
        chain.push(
          `yarn: named descriptor ${namedDesc} contains an untranslatable MC class type — falling back to arity disambiguation`,
        );
      }
    }

    if (!pick && matches.length === 1) pick = matches[0]!;
    if (!pick && matches.length > 1 && namedDesc !== null) {
      // Last-resort disambiguation when translation could not complete: arity only.
      const wanted = countDescriptorArgs(namedDesc);
      const byArity = matches.filter((m) => countDescriptorArgs(m.desc) === wanted);
      if (byArity.length === 1) {
        pick = byArity[0]!;
        chain.push(`yarn: overload disambiguated by arity (${wanted} args) — descriptor translation unavailable`);
      }
    }
    if (!pick) {
      return {
        unresolved:
          `yarn has ${matches.length} overloads of ${namedName} on ${displayOwner}; cannot disambiguate ` +
          `deterministically (no descriptor given, or descriptor untranslatable and arity ambiguous).`,
      };
    }
    const iName = pick.names[0];
    if (!iName) return { unresolved: `yarn member ${namedName} lacks an intermediary name.` };
    chain.push(`yarn: ${kind} ${namedName} → intermediary ${iName} (desc ${pick.desc})`);

    const ilist = kind === 'method' ? ic.methods : ic.fields;
    const im = ilist.find((m) => m.names[1] === iName);
    if (!im) return { unresolved: `intermediary mappings lack member ${iName} on ${ic.names[1] ?? ic.names[0]}.` };
    const obfName = im.names[0];
    if (!obfName) return { unresolved: `intermediary member ${iName} lacks an official name.` };
    chain.push(`intermediary: ${iName} → official ${obfName} (obf desc ${im.desc})`);
    return { obfName, obfDesc: im.desc };
  }

  /**
   * Member not declared on the owner itself → walk the OLD jar hierarchy (when
   * provided). Returns the inherited mojmap member, or the final honest Resolution.
   */
  private tryInherited(
    ns: SourceNamespace,
    from: SymbolRef,
    chain: string[],
    baseReason: string,
    obfOwner: string,
    kind: 'method' | 'field',
    oldName: string,
    oldDesc: string | null,
  ): { pgMember: PgMember; inheritedFrom: string } | { resolution: Resolution } {
    if (!this.oldHierarchy) {
      return {
        resolution: {
          from,
          confidence: 'UNRESOLVED',
          reason:
            `${baseReason} The member may be inherited from a supertype — provide BridgeInputs.oldHierarchy ` +
            `(parse the OLD obfuscated client jar with extractJarApi and collect {superName, interfaces} per ` +
            `class, keyed by obf binary name) to enable the deterministic old-hierarchy walk.`,
          chain,
        },
      };
    }
    const inh =
      ns === 'named'
        ? this.findInheritedNamed(obfOwner, kind, oldName, oldDesc)
        : this.findInheritedSource(obfOwner, kind, oldName, oldDesc);
    if ('pgMember' in inh) {
      chain.push(
        `old-hierarchy: ${oldName} not declared on ${from.owner}; inherited from ${inh.declaredOn} ` +
          `(deterministic walk over ${inh.walked} old supertype(s))`,
      );
      chain.push(...inh.notes);
      return { pgMember: inh.pgMember, inheritedFrom: inh.declaredOn };
    }
    if ('unresolved' in inh) {
      return { resolution: { from, confidence: 'UNRESOLVED', reason: `${baseReason} ${inh.unresolved}`, chain } };
    }
    const near =
      inh.nearMisses.length > 0
        ? ` Supertype(s) declaring the name with a DIFFERENT descriptor were seen: ${inh.nearMisses.join(', ')}.`
        : '';
    return {
      resolution: {
        from,
        confidence: 'UNRESOLVED',
        reason: `${baseReason} Old-hierarchy walk over ${inh.walked} supertype(s) found no matching declaration either.${near}`,
        chain,
      },
    };
  }

  /**
   * Deterministic BFS over the OLD obfuscated jar's supertypes (superclass before
   * interfaces at each level, interfaces in declared order; the owner itself is
   * excluded). Branches leave the walk at classes absent from the map (JDK etc.).
   */
  private *walkOldSupers(hierarchy: Map<string, OldHierarchyEntry>, obfOwner: string): Generator<string> {
    const seen = new Set<string>([obfOwner]);
    const queue: string[] = [];
    const start = hierarchy.get(obfOwner);
    if (start) {
      if (start.superName) queue.push(start.superName);
      queue.push(...start.interfaces);
    }
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      yield cur;
      const e = hierarchy.get(cur);
      if (e) {
        if (e.superName) queue.push(e.superName);
        queue.push(...e.interfaces);
      }
    }
  }

  /**
   * Old-hierarchy walk in the `named` namespace: for each obf supertype, map
   * obf→intermediary→yarn (reverse indexes) and retry the member hop there.
   * Descriptor mismatches keep walking (the right overload may sit higher up);
   * ambiguity stops the walk honestly — guessing a declarer could be wrong.
   */
  private findInheritedNamed(
    obfOwner: string,
    kind: 'method' | 'field',
    namedName: string,
    namedDesc: string | null,
  ): InheritedLookup {
    let walked = 0;
    const nearMisses: string[] = [];
    for (const obfSuper of this.walkOldSupers(this.oldHierarchy!, obfOwner)) {
      walked++;
      const ic = this.interByObf?.get(obfSuper);
      const iName = ic?.names[1];
      const yc = iName ? this.yarnByIntermediary?.get(iName) : undefined;
      if (!ic || !iName || !yc) continue; // supertype outside MC mappings (bundled lib) — not a bridgeable declarer
      const declaredOn = yc.names[1] ?? iName;
      const scratch: string[] = []; // merged into the audit chain only on a hit
      const hop = this.namedMemberToObf(declaredOn, yc, ic, kind, namedName, namedDesc, scratch);
      if ('unresolved' in hop) {
        if (hop.notFound) continue;
        if (hop.descMismatch) {
          nearMisses.push(declaredOn);
          continue;
        }
        return { unresolved: `Found ${namedName} on old supertype ${declaredOn}, but: ${hop.unresolved}`, walked };
      }
      const pgSuper = this.mojmap.byObf.get(obfSuper);
      if (!pgSuper) {
        return {
          unresolved: `Old supertype ${declaredOn} (obf ${obfSuper}) declares ${namedName}, but obf class ${obfSuper} is missing from mojmap — cannot bridge it.`,
          walked,
        };
      }
      let pgMember = pgSuper.members.find(
        (m) => m.kind === kind && m.obfName === hop.obfName && (kind === 'field' || m.descObf === hop.obfDesc),
      );
      if (!pgMember) {
        const nameOnly = pgSuper.members.filter((m) => m.kind === kind && m.obfName === hop.obfName);
        if (nameOnly.length === 1) {
          pgMember = nameOnly[0]!;
          scratch.push(`mojmap: joined on obf name only (single match) — descriptor not compared`);
        }
      }
      if (!pgMember) {
        return {
          unresolved: `Old supertype ${declaredOn} declares ${namedName} (obf ${hop.obfName}), but mojmap has no matching member on ${pgSuper.sourceBinary}.`,
          walked,
        };
      }
      return { pgMember, declaredOn, notes: scratch, walked };
    }
    return { walked, nearMisses };
  }

  /**
   * Old-hierarchy walk in the `source` namespace: mojmap members are looked up
   * directly per obf supertype (NeoForge mods are already in source names).
   */
  private findInheritedSource(
    obfOwner: string,
    kind: 'method' | 'field',
    sourceName: string,
    sourceDesc: string | null,
  ): InheritedLookup {
    let walked = 0;
    const nearMisses: string[] = [];
    for (const obfSuper of this.walkOldSupers(this.oldHierarchy!, obfOwner)) {
      walked++;
      const pgSuper = this.mojmap.byObf.get(obfSuper);
      if (!pgSuper) continue; // supertype outside MC mappings — not a bridgeable declarer
      const matches = pgSuper.members.filter(
        (m) => m.kind === kind && m.sourceName === sourceName && (sourceDesc === null || m.descSource === sourceDesc),
      );
      if (matches.length === 1) {
        return { pgMember: matches[0]!, declaredOn: pgSuper.sourceBinary, notes: [], walked };
      }
      if (matches.length > 1) {
        return {
          unresolved: `Ambiguous on old supertype ${pgSuper.sourceBinary}: ${matches.length} overloads of ${sourceName} match (descriptor needed to disambiguate).`,
          walked,
        };
      }
      if (sourceDesc !== null && pgSuper.members.some((m) => m.kind === kind && m.sourceName === sourceName)) {
        nearMisses.push(pgSuper.sourceBinary);
      }
    }
    return { walked, nearMisses };
  }

  /**
   * Final jar grounding. For members the OLD world declared on the owner itself,
   * a supertype hit in the target is CANDIDATE("moved"); for members the OLD world
   * already inherited (`inheritedFrom` set), a hit anywhere on the owner's target
   * hierarchy is EXACT — the call site resolves identically, every hop was a
   * deterministic join, and the situation (inherited) is unchanged.
   */
  private groundMember(
    from: SymbolRef,
    kind: 'method' | 'field',
    chain: string[],
    ownerSource: string,
    pgMember: PgMember,
    inheritedFrom: string | null,
  ): Resolution {
    const found = this.findInHierarchy(ownerSource, kind, pgMember.sourceName, pgMember.descSource);

    if (found && (found.owner === ownerSource || inheritedFrom !== null)) {
      chain.push(`target(${this.target.id}): present on ${found.owner}`);
      return {
        from,
        confidence: 'EXACT',
        to: { kind, owner: found.owner, name: pgMember.sourceName, desc: found.desc },
        reason: inheritedFrom
          ? `Deterministic chain resolved (inherited from ${inheritedFrom} in the old hierarchy); member exists on ${found.owner} in ${this.target.id}, reachable from ${ownerSource}.`
          : `Deterministic chain resolved; member exists on the same class in ${this.target.id}.`,
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
    return this.memberGroundingMiss(from, kind, chain, ownerSource, pgMember.sourceName, pgMember.descSource);
  }

  /**
   * Jar grounding missed → consult the rename layer (when provided):
   *  (a) owner-class rename retry — identical member under the renamed owner;
   *  (b) member rename under the effective (possibly renamed) owner, grounded by
   *      exact descriptor first, by name (descriptor-changed, flagged) second.
   * Ungroundable entries are rejected loudly. No table / no hit → UNRESOLVED with
   * the rename-layer status stated in the reason.
   */
  private memberGroundingMiss(
    from: SymbolRef,
    kind: 'method' | 'field',
    chain: string[],
    ownerSource: string,
    name: string,
    descSource: string,
  ): Resolution {
    const baseReason =
      `Chain resolved to ${ownerSource}#${name}${descSource}, but no such member exists there ` +
      `(or on its supertypes) in ${this.target.id} — removed or changed after the era boundary.`;

    if (!this.renames) {
      return {
        from,
        confidence: 'UNRESOLVED',
        reason: `${baseReason} No rename table was provided (BridgeInputs.renames), so boundary-rename candidates could not be consulted.`,
        chain,
      };
    }

    const candidates: { to: SymbolRef; evidence: string; score: number }[] = [];
    const rejected: string[] = [];

    // (a) the owner class itself was renamed — retry the identical member there.
    let effectiveOwner = ownerSource;
    if (!this.target.classes.has(ownerSource)) {
      const ce = this.renames.classRename(ownerSource);
      if (ce) {
        const ceTo = ce.to.owner; // RenameEntry.to is a SymbolRef
        if (this.target.classes.has(ceTo)) {
          effectiveOwner = ceTo;
          chain.push(`rename-layer: class ${ownerSource} → ${ceTo} (score ${ce.score})`);
          const f = this.findInHierarchy(ceTo, kind, name, descSource);
          if (f) {
            candidates.push({
              to: { kind, owner: f.owner, name, desc: f.desc },
              evidence: `Owner class renamed across the boundary (${ce.evidence}); member found on ${f.owner} with identical name and descriptor in ${this.target.id}.`,
              score: ce.score,
            });
          }
        } else {
          chain.push(`rename-layer: class entry ${ownerSource} → ${ce.to.owner} REJECTED (not present in ${this.target.id})`);
          rejected.push(`class rename ${ownerSource} → ${ce.to.owner} rejected: target class absent (stale table)`);
        }
      }
    }

    // (b) the member itself was renamed.
    const me = this.renames.memberRename(ownerSource, kind, name, descSource);
    if (me) {
      const exact = this.findInHierarchy(effectiveOwner, kind, me.to.name ?? name, descSource);
      if (exact) {
        candidates.push({
          to: { kind, owner: exact.owner, name: me.to.name, desc: exact.desc },
          evidence: `${me.evidence} Grounded in ${this.target.id}: ${exact.owner}#${me.to.name} exists with the identical descriptor.`,
          score: me.score,
        });
      } else {
        const byName = this.findNameInHierarchy(effectiveOwner, kind, me.to.name ?? name);
        if (byName) {
          const to: SymbolRef = { kind, owner: byName.owner, name: me.to.name };
          let evidence: string;
          if (byName.descs.length === 1) {
            to.desc = byName.descs[0]!;
            evidence = `${me.evidence} Grounded by name in ${this.target.id} on ${byName.owner}; the descriptor changed across the boundary (${descSource} → ${byName.descs[0]!}).`;
          } else {
            evidence = `${me.evidence} Grounded by name in ${this.target.id} on ${byName.owner}, but ${byName.descs.length} overloads exist — descriptor unverified.`;
          }
          candidates.push({ to, evidence, score: me.score });
        } else {
          chain.push(`rename-layer: member entry ${name} → ${me.to.name} REJECTED (no such name reachable from ${effectiveOwner} in ${this.target.id})`);
          rejected.push(`member rename ${name} → ${me.to.name} rejected: not grounded in target jar (stale table)`);
        }
      }
    }

    if (candidates.length > 0) {
      // Stable, deterministic presentation order: score desc, then symbol identity.
      dedupeAndSortCandidates(candidates);
      chain.push(`rename-layer: ${candidates.length} grounded candidate(s)`);
      return {
        from,
        confidence: 'CANDIDATE',
        candidates,
        reason: `${baseReason} The rename layer supplies grounded candidate(s) — CANDIDATE, never auto-applied.`,
        chain,
      };
    }
    const rej = rejected.length > 0 ? ` (${rejected.join('; ')}.)` : '';
    return {
      from,
      confidence: 'UNRESOLVED',
      reason: `${baseReason} The rename layer has no grounded candidate for it either.${rej}`,
      chain,
    };
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

  /**
   * Name-only target-jar walk (rename grounding when the descriptor changed):
   * first class in BFS order owning ≥1 member with the name, with ALL its
   * descriptors (sorted) so the caller can flag overload ambiguity honestly.
   */
  private findNameInHierarchy(
    owner: string,
    kind: 'method' | 'field',
    name: string,
  ): { owner: string; descs: string[] } | null {
    const seen = new Set<string>();
    const queue = [owner];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const cls = this.target.classes.get(cur);
      if (!cls) continue;
      const list = kind === 'method' ? cls.methods : cls.fields;
      const descs = list
        .filter((m) => m.name === name)
        .map((m) => m.desc)
        .sort();
      if (descs.length > 0) return { owner: cur, descs };
      if (cls.superName) queue.push(cls.superName);
      queue.push(...cls.interfaces);
    }
    return null;
  }
}

/**
 * Translate every class type in a JVM descriptor (field or method form) through
 * `mapClassName`. Contract:
 * - `mapClassName` returns the translated binary name, or null when it cannot
 *   translate that class — any null makes the WHOLE translation fail (return null).
 *   Pass-through of non-MC classes is the callback's decision, not this walker's.
 * - Returns null (never a partial/guessed result) for malformed descriptors too:
 *   a desynced descriptor must not produce silently-wrong output.
 * Determinism: pure function of its inputs.
 */
export function translateDesc(desc: string, mapClassName: (binary: string) => string | null): string | null {
  let out = '';
  let i = 0;
  while (i < desc.length) {
    const c = desc[i];
    if (c === undefined) return null;
    if (c === '(' || c === ')' || c === '[') {
      out += c;
      i++;
      continue;
    }
    if (c === 'L') {
      const semi = desc.indexOf(';', i);
      if (semi === -1) return null; // malformed: unterminated class type
      const cls = desc.slice(i + 1, semi);
      if (cls.length === 0) return null; // malformed: empty class name
      const mapped = mapClassName(cls);
      if (mapped === null) return null; // honest failure: a class type cannot be translated
      out += `L${mapped};`;
      i = semi + 1;
      continue;
    }
    if ('VZBCSIJFD'.includes(c)) {
      out += c;
      i++;
      continue;
    }
    return null; // malformed: unknown descriptor token
  }
  return out;
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

/** total order on strings (avoids locale-dependent localeCompare — determinism). */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * In-place deterministic sort (score desc, then symbol identity) followed by a
 * dedupe on resolved symbol identity — the highest-ranked duplicate survives.
 * Space is a safe key separator: it cannot occur in binary names or descriptors.
 */
function dedupeAndSortCandidates(candidates: { to: SymbolRef; evidence: string; score: number }[]): void {
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      cmpStr(a.to.owner, b.to.owner) ||
      cmpStr(a.to.name ?? '', b.to.name ?? '') ||
      cmpStr(a.to.desc ?? '', b.to.desc ?? ''),
  );
  const seen = new Set<string>();
  for (let i = 0; i < candidates.length; ) {
    const c = candidates[i]!;
    const key = `${c.to.owner} ${c.to.name ?? ''} ${c.to.desc ?? ''}`;
    if (seen.has(key)) candidates.splice(i, 1);
    else {
      seen.add(key);
      i++;
    }
  }
}
