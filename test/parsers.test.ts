/**
 * Parser correctness tests. Every expected value here is INDEPENDENTLY derived —
 * synthetic fixtures written by hand in the (real-artifact-verified) formats,
 * never produced by running the parsers themselves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTinyV2, indexByNamespace } from '../src/mappings/tiny.ts';
import { parseProguard, sourceTypeToDesc } from '../src/mappings/proguard.ts';
import { parseClassFile } from '../src/jar/classfile.ts';
import { computeDelta } from '../src/delta/delta.ts';
import type { JarApi, ClassApi } from '../src/core/model.ts';

// ---------------------------------------------------------------------------
// tiny v2
// ---------------------------------------------------------------------------

const TINY = [
  'tiny\t2\t0\tintermediary\tnamed',
  'c\tnet/minecraft/class_1\ta/b/Player',
  '\tm\t()Lnet/minecraft/class_2;\tmethod_1\tgetFood',
  '\tm\t(I)V\tmethod_2\tsetLevel',
  '\tf\tI\tfield_1\texperience',
  'c\tnet/minecraft/class_2\ta/b/FoodData',
].join('\n');

test('tiny v2: header namespaces, classes, members, descriptors', () => {
  const set = parseTinyV2(TINY);
  assert.deepEqual(set.namespaces, ['intermediary', 'named']);
  assert.equal(set.classes.length, 2);
  const byNamed = indexByNamespace(set, 'named');
  const player = byNamed.get('a/b/Player')!;
  assert.equal(player.names[0], 'net/minecraft/class_1');
  assert.equal(player.methods.length, 2);
  // member descs are in the FIRST namespace (intermediary) — verified format fact
  assert.equal(player.methods[0]!.desc, '()Lnet/minecraft/class_2;');
  assert.equal(player.methods[0]!.names[1], 'getFood');
  assert.equal(player.fields[0]!.names[0], 'field_1');
});

test('tiny v2: rejects non-tiny and wrong version headers', () => {
  assert.throws(() => parseTinyV2('not a tiny file'));
  assert.throws(() => parseTinyV2('tiny\t1\t0\ta\tb'));
});

// ---------------------------------------------------------------------------
// ProGuard (mojmap) — incl. the dual-descriptor computation
// ---------------------------------------------------------------------------

const PG = [
  '# header comment',
  'a.b.Player -> xy:',
  '    1:2:a.b.FoodData getFood() -> q',
  '    void setLevel(int) -> r',
  '    java.lang.String name -> s',
  'a.b.FoodData -> zz:',
  '    9:9:void <init>() -> <init>',
].join('\n');

test('proguard: classes both directions, members, line numbers optional', () => {
  const pg = parseProguard(PG);
  assert.equal(pg.byObf.get('xy')!.sourceBinary, 'a/b/Player');
  assert.equal(pg.bySource.get('a/b/FoodData')!.obfBinary, 'zz');
  const m = pg.bySource.get('a/b/Player')!.members;
  // getFood: return type a.b.FoodData maps to obf zz in descObf, stays in descSource.
  const getFood = m.find((x) => x.sourceName === 'getFood')!;
  assert.equal(getFood.obfName, 'q');
  assert.equal(getFood.descSource, '()La/b/FoodData;'); // hand-derived
  assert.equal(getFood.descObf, '()Lzz;'); // hand-derived: FoodData→zz
  // setLevel(int): primitives identical in both namespaces.
  const setLevel = m.find((x) => x.sourceName === 'setLevel')!;
  assert.equal(setLevel.descSource, '(I)V');
  assert.equal(setLevel.descObf, '(I)V');
  // field: JDK type passes through unmapped in BOTH namespaces.
  const name = m.find((x) => x.sourceName === 'name')!;
  assert.equal(name.kind, 'field');
  assert.equal(name.descObf, 'Ljava/lang/String;');
});

test('sourceTypeToDesc: primitives, arrays, classes — hand-derived table', () => {
  const id = (s: string) => s;
  assert.equal(sourceTypeToDesc('void', id), 'V');
  assert.equal(sourceTypeToDesc('int', id), 'I');
  assert.equal(sourceTypeToDesc('byte[][]', id), '[[B');
  assert.equal(sourceTypeToDesc('java.lang.String[]', id), '[Ljava/lang/String;');
  assert.equal(sourceTypeToDesc('a.b.C$D', id), 'La/b/C$D;');
});

// ---------------------------------------------------------------------------
// classfile — a minimal classfile built BYTE BY BYTE from JVMS §4.
// public class t/T extends java/lang/Object with one method "go" desc "()V".
// ---------------------------------------------------------------------------

function u2(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}
function u4(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
function utf8(s: string): number[] {
  return [1, ...u2(s.length), ...[...Buffer.from(s, 'utf8')]];
}

test('classfile: hand-assembled minimal class parses exactly', () => {
  const bytes: number[] = [
    ...u4(0xcafebabe),
    ...u2(0), // minor
    ...u2(61), // major = Java 17
    ...u2(8), // cp count = entries+1 → 7 entries
    ...utf8('t/T'), // #1
    [7, ...u2(1)], // #2 Class -> #1
    ...utf8('java/lang/Object'), // #3
    [7, ...u2(3)], // #4 Class -> #3
    ...utf8('go'), // #5
    ...utf8('()V'), // #6
    ...utf8('Code'), // #7 (unused, padding entry)
    ...u2(0x0021), // access: PUBLIC|SUPER
    ...u2(2), // this = #2
    ...u2(4), // super = #4
    ...u2(0), // interfaces
    ...u2(0), // fields
    ...u2(1), // methods
    ...u2(0x0001), // method access PUBLIC
    ...u2(5), // name #5
    ...u2(6), // desc #6
    ...u2(0), // method attributes
    ...u2(0), // class attributes
  ].flat();
  const api = parseClassFile(Buffer.from(bytes));
  assert.equal(api.binaryName, 't/T');
  assert.equal(api.majorVersion, 61);
  assert.equal(api.superName, 'java/lang/Object');
  assert.equal(api.methods.length, 1);
  assert.equal(api.methods[0]!.name, 'go');
  assert.equal(api.methods[0]!.desc, '()V');
});

test('classfile: bad magic fails loudly', () => {
  assert.throws(() => parseClassFile(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])), /magic/);
});

// ---------------------------------------------------------------------------
// delta — synthetic surfaces, hand-derived expectations
// ---------------------------------------------------------------------------

function cls(name: string, methods: [string, string][], fields: [string, string][] = []): ClassApi {
  return {
    binaryName: name,
    access: 0x0001, // public
    majorVersion: 69,
    superName: 'java/lang/Object',
    interfaces: [],
    methods: methods.map(([n, d]) => ({ name: n, desc: d, access: 0x0001 })),
    fields: fields.map(([n, d]) => ({ name: n, desc: d, access: 0x0001 })),
  };
}
function jar(id: string, classes: ClassApi[]): JarApi {
  return { id, classes: new Map(classes.map((c) => [c.binaryName, c])) };
}

test('delta: removal, addition, desc change classified correctly', () => {
  const from = jar('A', [cls('p/Keep', [['m', '(I)V'], ['gone', '()V'], ['sig', '(I)V']])]);
  const to = jar('B', [cls('p/Keep', [['m', '(I)V'], ['sig', '(J)V'], ['fresh', '()V']])]);
  const d = computeDelta(from, to);
  assert.deepEqual(d.methodsRemoved.map((m) => m.name), ['gone']);
  assert.deepEqual(d.methodsAdded.map((m) => m.name), ['fresh']);
  assert.equal(d.methodsDescChanged.length, 1);
  assert.equal(d.methodsDescChanged[0]!.name, 'sig');
  assert.equal(d.methodsDescChanged[0]!.newDesc, '(J)V');
});

test('delta: rename candidates are bijective — the many-to-one trap is refused', () => {
  // Three removed classes share an identical tiny fingerprint with ONE added class.
  // No candidate may be emitted: mutual-best is ambiguous by construction.
  const fp: [string, string][] = [['only', '(Lp/Rare;)Lp/Rare;']];
  const from = jar('A', [cls('p/R1', fp), cls('p/R2', fp), cls('p/R3', fp)]);
  const to = jar('B', [cls('p/Winner', fp)]);
  const d = computeDelta(from, to);
  assert.equal(d.classRenameCandidates.length, 0, 'ambiguous many-to-one must emit nothing');
});

test('delta: a clean 1:1 structural rename IS surfaced as a labeled candidate', () => {
  const fp: [string, string][] = [
    ['alpha', '(Lp/Exotic;DJ)Lp/Exotic;'],
    ['beta', '([[Lp/Exotic;)V'],
  ];
  const from = jar('A', [cls('p/OldName', fp)]);
  const to = jar('B', [cls('p/NewName', fp)]);
  const d = computeDelta(from, to);
  assert.equal(d.classRenameCandidates.length, 1);
  const c = d.classRenameCandidates[0]!;
  assert.equal(c.from.owner, 'p/OldName');
  assert.equal(c.to.owner, 'p/NewName');
  assert.ok(c.score > 0.5);
  assert.match(c.evidence, /verify/i, 'candidate evidence must tell the user to verify');
});
