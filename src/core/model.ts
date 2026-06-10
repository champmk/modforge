/**
 * Canonical data model for ModForge.
 *
 * Naming conventions used throughout:
 * - "binary name": JVM internal form with slashes, e.g. `net/minecraft/world/entity/player/Player`.
 *   Inner classes use `$`: `a/b/Outer$Inner`.
 * - "descriptor": JVM type descriptor, e.g. `()Lnet/minecraft/world/food/FoodData;`, `[I`, `(IJ)V`.
 * - Namespaces (old era): `official` (obfuscated), `intermediary` (Fabric stable ids),
 *   `named` (yarn), `source` (Mojang official mappings / mojmap names).
 *
 * The honesty taxonomy (DECISIONS D4) is enforced at the type level: every resolution
 * the engine reports is one of EXACT | CANDIDATE | UNRESOLVED, with evidence.
 */

// ---------------------------------------------------------------------------
// JVM API surface (parsed from classfiles)
// ---------------------------------------------------------------------------

export interface MemberApi {
  /** Member name (`<init>` / `<clinit>` for constructors / static initializers). */
  name: string;
  /** JVM descriptor (field: type descriptor; method: `(args)ret`). */
  desc: string;
  /** Raw access flags (JVM access_flags). */
  access: number;
  /** Generic signature from the Signature attribute, when present. */
  signature?: string;
}

export interface ClassApi {
  /** Binary name, e.g. `net/minecraft/world/entity/player/Player`. */
  binaryName: string;
  access: number;
  /** Classfile major version (Java 17 = 61 ... Java 25 = 69). */
  majorVersion: number;
  superName: string | null;
  interfaces: string[];
  methods: MemberApi[];
  fields: MemberApi[];
  /** Generic signature of the class itself, when present. */
  signature?: string;
}

/** The full API surface of one game version (or any jar). */
export interface JarApi {
  /** Identifier for provenance, e.g. `26.1.2-client`. */
  id: string;
  classes: Map<string, ClassApi>;
}

// JVM access flag bits we care about for API-surface decisions.
export const ACC = {
  PUBLIC: 0x0001,
  PRIVATE: 0x0002,
  PROTECTED: 0x0004,
  STATIC: 0x0008,
  FINAL: 0x0010,
  SYNTHETIC: 0x1000,
  BRIDGE: 0x0040, // on methods
  ENUM: 0x4000,
  ABSTRACT: 0x0400,
  INTERFACE: 0x0200,
} as const;

// ---------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------

export interface MappedMember {
  /** Descriptor in the FIRST namespace of the owning mapping file. */
  desc: string;
  /** Names per namespace, index-aligned with `MappingSet.namespaces`. */
  names: (string | null)[];
}

export interface MappedClass {
  /** Names per namespace, index-aligned with `MappingSet.namespaces`. */
  names: (string | null)[];
  methods: MappedMember[];
  fields: MappedMember[];
}

export interface MappingSet {
  /** e.g. ["intermediary","named"] for yarn tiny v2; ["official","intermediary"] for intermediary. */
  namespaces: string[];
  classes: MappedClass[];
}

// ---------------------------------------------------------------------------
// Resolutions — the honesty taxonomy
// ---------------------------------------------------------------------------

export type Confidence = 'EXACT' | 'CANDIDATE' | 'UNRESOLVED';

export interface SymbolRef {
  kind: 'class' | 'method' | 'field';
  /** Owning class binary name (= self for kind 'class'). */
  owner: string;
  /** Member name (absent for kind 'class'). */
  name?: string;
  /** Member descriptor when known. */
  desc?: string;
}

export interface Resolution {
  /** What the user's code refers to (in its original namespace). */
  from: SymbolRef;
  confidence: Confidence;
  /** The resolved symbol in the target version/namespace — only for EXACT. */
  to?: SymbolRef;
  /** Ranked candidates with evidence — only for CANDIDATE. */
  candidates?: { to: SymbolRef; evidence: string; score: number }[];
  /** Human-readable, honest explanation of HOW this was resolved or why it could not be. */
  reason: string;
  /** Every join hop that produced this resolution (audit trail). */
  chain: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `a.b.C` → `a/b/C` */
export function toBinaryName(dotted: string): string {
  return dotted.replace(/\./g, '/');
}

/** `a/b/C` → `a.b.C` */
export function toDottedName(binary: string): string {
  return binary.replace(/\//g, '.');
}

export function isMethodDesc(desc: string): boolean {
  return desc.startsWith('(');
}
