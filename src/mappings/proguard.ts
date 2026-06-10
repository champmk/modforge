/**
 * ProGuard mapping parser (Mojang official mappings / "mojmap"), dependency-free.
 *
 * Format (verified hands-on against 1.21.11 client_mappings, 11.2MB):
 *
 *   com.mojang.blaze3d.Blaze3D -> fvz:                       ← class: source -> obf
 *       9:10:void youJustLostTheGame() -> a                  ← method (line numbers optional)
 *       java.util.List INTEL_GEN11_CORE -> a                 ← field (no parens)
 *       16:17:void <init>() -> <init>                        ← constructor
 *
 * Direction: mojmap maps SOURCE names → OBFUSCATED names (note: opposite of tiny).
 * Types in member lines are SOURCE-form erased types (`java.lang.String`, `byte[]`,
 * `net.minecraft.X$Inner`) — NOT JVM descriptors.
 *
 * This parser computes, for every member, JVM descriptors in BOTH namespaces:
 *  - `descSource`: class types as source binary names  → joins against 26.x jar API
 *  - `descObf`:    class types mapped source→obf       → joins against intermediary tiny
 * That dual-descriptor join is what makes the Era Bridge deterministic for overloads.
 *
 * Licensing (DECISIONS D7): these files are downloaded from Mojang at runtime and
 * cached locally; they are never redistributed with ModForge.
 */
import { toBinaryName } from '../core/model.ts';

export interface PgMember {
  kind: 'method' | 'field';
  sourceName: string;
  obfName: string;
  /** JVM descriptor with class types in SOURCE binary names. */
  descSource: string;
  /** JVM descriptor with class types in OBF binary names (where mapped). */
  descObf: string;
}

export interface PgClass {
  /** Source binary name, e.g. `net/minecraft/world/entity/player/Player`. */
  sourceBinary: string;
  /** Obfuscated binary name, e.g. `ddm`. */
  obfBinary: string;
  members: PgMember[];
}

export interface PgMappings {
  /** keyed by obf binary name */
  byObf: Map<string, PgClass>;
  /** keyed by source binary name */
  bySource: Map<string, PgClass>;
}

const PRIMITIVES: Record<string, string> = {
  void: 'V',
  boolean: 'Z',
  byte: 'B',
  char: 'C',
  short: 'S',
  int: 'I',
  long: 'J',
  float: 'F',
  double: 'D',
};

/**
 * Convert one SOURCE-form type (`java.lang.String`, `int`, `byte[][]`) to a JVM
 * descriptor. `mapClass` translates a source binary class name to the target
 * namespace (identity for descSource; source→obf lookup for descObf — classes not
 * in the map, e.g. JDK types, keep their own name).
 */
export function sourceTypeToDesc(type: string, mapClass: (srcBinary: string) => string): string {
  let dims = 0;
  let base = type;
  while (base.endsWith('[]')) {
    dims++;
    base = base.slice(0, -2);
  }
  const prim = PRIMITIVES[base];
  const core = prim ?? `L${mapClass(toBinaryName(base))};`;
  return '['.repeat(dims) + core;
}

// class line:   com.a.B -> xy:
const CLASS_RE = /^(\S+) -> (\S+):$/;
// method line:  [num:num:]retType name(args) -> obfName
const METHOD_RE = /^(?:\d+:\d+:)?(\S+) (\S+)\(([^)]*)\) -> (\S+)$/;
// field line:   type name -> obfName
const FIELD_RE = /^(\S+) (\S+) -> (\S+)$/;

export function parseProguard(text: string): PgMappings {
  const byObf = new Map<string, PgClass>();
  const bySource = new Map<string, PgClass>();
  const sourceToObfClass = new Map<string, string>(); // source binary -> obf binary

  // Pass 1: class lines only (needed before member descriptors can be obf-mapped).
  const lines = text.split('\n');
  for (const raw of lines) {
    if (raw.startsWith('#') || raw.startsWith(' ') || raw.startsWith('\t')) continue;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = CLASS_RE.exec(line);
    if (m) {
      const sourceBinary = toBinaryName(m[1]!);
      const obfBinary = toBinaryName(m[2]!);
      sourceToObfClass.set(sourceBinary, obfBinary);
      const cls: PgClass = { sourceBinary, obfBinary, members: [] };
      byObf.set(obfBinary, cls);
      bySource.set(sourceBinary, cls);
    }
  }

  const mapToObf = (srcBinary: string): string => sourceToObfClass.get(srcBinary) ?? srcBinary;
  const identity = (srcBinary: string): string => srcBinary;

  // Pass 2: members.
  let cur: PgClass | null = null;
  for (const raw of lines) {
    if (raw.startsWith('#')) continue;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line) continue;

    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      const m = CLASS_RE.exec(line);
      cur = m ? (bySource.get(toBinaryName(m[1]!)) ?? null) : null;
      continue;
    }
    if (!cur) continue;
    const body = line.trim();

    const mm = METHOD_RE.exec(body);
    if (mm) {
      const [, ret, name, args, obfName] = mm;
      const argTypes = args!.length === 0 ? [] : args!.split(',');
      const descSource =
        '(' + argTypes.map((t) => sourceTypeToDesc(t.trim(), identity)).join('') + ')' +
        sourceTypeToDesc(ret!, identity);
      const descObf =
        '(' + argTypes.map((t) => sourceTypeToDesc(t.trim(), mapToObf)).join('') + ')' +
        sourceTypeToDesc(ret!, mapToObf);
      cur.members.push({ kind: 'method', sourceName: name!, obfName: obfName!, descSource, descObf });
      continue;
    }
    const fm = FIELD_RE.exec(body);
    if (fm) {
      const [, type, name, obfName] = fm;
      cur.members.push({
        kind: 'field',
        sourceName: name!,
        obfName: obfName!,
        descSource: sourceTypeToDesc(type!, identity),
        descObf: sourceTypeToDesc(type!, mapToObf),
      });
    }
  }

  return { byObf, bySource };
}
