/**
 * Era Bridge correctness tests on a synthetic 4-artifact mini-world.
 * Every chain expectation is derived BY HAND from the fixture data below —
 * the test author traces the joins on paper, the engine must agree.
 *
 * Mini-world (hand-built):
 *   yarn:          class_10 → mod/Player        method_1()→getFood ()Lclass_11;
 *                                               method_2(I)V→setLevel  method_3(J)V→setLevel (overloads!)
 *                  class_11 → mod/FoodData
 *                  class_12 → mod/Living        method_9()F→getHealth
 *   intermediary:  aa → class_10, bb → class_11, cc → class_12
 *   mojmap:        real/Player→aa  { real/Food getFood()→q, void setLevel(int)→r, void setLevel(long)→r2 }
 *                  real/Food→bb, real/Living→cc { float getHealth()→h }
 *   old hierarchy: aa extends cc (Player extends Living)
 *   target jar:    real/Player { getFood ()Lreal/Food;, setLevel (I)V, setLevel (J)V }
 *                  real/Food, real/Living { getHealth ()F }
 *                  real/Brand-New (added — rename-layer target for mod/Gone)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTinyV2 } from '../src/mappings/tiny.ts';
import { parseProguard } from '../src/mappings/proguard.ts';
import { EraBridge, type OldHierarchyEntry } from '../src/bridge/bridge.ts';
import { buildRenameTable } from '../src/bridge/renames.ts';
import type { JarApi, ClassApi } from '../src/core/model.ts';

const YARN = [
  'tiny\t2\t0\tintermediary\tnamed',
  'c\tclass_10\tmod/Player',
  '\tm\t()Lclass_11;\tmethod_1\tgetFood',
  '\tm\t(I)V\tmethod_2\tsetLevel',
  '\tm\t(J)V\tmethod_3\tsetLevel',
  'c\tclass_11\tmod/FoodData',
  'c\tclass_12\tmod/Living',
  '\tm\t()F\tmethod_9\tgetHealth',
].join('\n');

const INTERMEDIARY = [
  'tiny\t2\t0\tofficial\tintermediary',
  'c\taa\tclass_10',
  '\tm\t()Lbb;\ta\tmethod_1',
  '\tm\t(I)V\tb\tmethod_2',
  '\tm\t(J)V\tc\tmethod_3',
  'c\tbb\tclass_11',
  'c\tcc\tclass_12',
  '\tm\t()F\th\tmethod_9',
].join('\n');

const MOJMAP = [
  'real.Player -> aa:',
  '    real.Food getFood() -> a',
  '    void setLevel(int) -> b',
  '    void setLevel(long) -> c',
  'real.Food -> bb:',
  'real.Living -> cc:',
  '    float getHealth() -> h',
].join('\n');

function cls(name: string, superName: string | null, methods: [string, string][]): ClassApi {
  return {
    binaryName: name,
    access: 0x0001,
    majorVersion: 69,
    superName,
    interfaces: [],
    methods: methods.map(([n, d]) => ({ name: n, desc: d, access: 0x0001 })),
    fields: [],
  };
}
const TARGET: JarApi = {
  id: 'target-test',
  classes: new Map(
    [
      cls('real/Player', 'real/Living', [
        ['getFood', '()Lreal/Food;'],
        ['setLevel', '(I)V'],
        ['setLevel', '(J)V'],
      ]),
      cls('real/Food', 'java/lang/Object', []),
      cls('real/Living', 'java/lang/Object', [['getHealth', '()F']]),
    ].map((c) => [c.binaryName, c] as const),
  ),
};

const OLD_HIERARCHY = new Map<string, OldHierarchyEntry>([
  ['aa', { superName: 'cc', interfaces: [] }],
  ['bb', { superName: 'java/lang/Object', interfaces: [] }],
  ['cc', { superName: 'java/lang/Object', interfaces: [] }],
]);

function makeBridge() {
  return new EraBridge({
    yarn: parseTinyV2(YARN),
    intermediary: parseTinyV2(INTERMEDIARY),
    mojmap: parseProguard(MOJMAP),
    target: TARGET,
    oldHierarchy: OLD_HIERARCHY,
  });
}

test('class chain: mod/Player → real/Player EXACT with full audit chain', () => {
  const r = makeBridge().resolveClass('named', 'mod/Player');
  assert.equal(r.confidence, 'EXACT');
  assert.equal(r.to!.owner, 'real/Player');
  // audit chain must record every hop, in order
  assert.ok(r.chain.some((c) => c.includes('class_10')), 'yarn hop recorded');
  assert.ok(r.chain.some((c) => c.includes('aa')), 'intermediary hop recorded');
  assert.ok(r.chain.some((c) => c.includes('real/Player')), 'mojmap hop recorded');
});

test('member chain with descriptor join: getFood → getFood ()Lreal/Food;', () => {
  const r = makeBridge().resolveMember('named', 'method', 'mod/Player', 'getFood', null);
  assert.equal(r.confidence, 'EXACT');
  assert.equal(r.to!.name, 'getFood');
  assert.equal(r.to!.desc, '()Lreal/Food;'); // descriptor translated through the chain by hand: class_11→bb→real/Food
});

test('overloads without descriptor or arity stay honestly UNRESOLVED', () => {
  const r = makeBridge().resolveMember('named', 'method', 'mod/Player', 'setLevel', null);
  assert.equal(r.confidence, 'UNRESOLVED');
  assert.match(r.reason, /overload/i);
});

test('overloads resolve EXACT via callsite arity when unique... but NOT here (both have 1 arg)', () => {
  // setLevel(I) and setLevel(J) both take ONE argument — arity CANNOT disambiguate.
  // The honest answer is still UNRESOLVED. (A wrong pick would be a P0.)
  const r = makeBridge().resolveMember('named', 'method', 'mod/Player', 'setLevel', null, { argCount: 1 });
  assert.equal(r.confidence, 'UNRESOLVED');
});

test('inherited member resolves via the old-hierarchy walk: Player#getHealth → Living#getHealth', () => {
  const r = makeBridge().resolveMember('named', 'method', 'mod/Player', 'getHealth', null);
  // declared on mod/Living (cc) in the old world; deterministic walk finds it.
  assert.equal(r.confidence, 'EXACT');
  assert.equal(r.to!.owner, 'real/Living');
  assert.equal(r.to!.name, 'getHealth');
});

test('unknown symbols are UNRESOLVED with a precise reason, never a guess', () => {
  const r = makeBridge().resolveClass('named', 'mod/DoesNotExist');
  assert.equal(r.confidence, 'UNRESOLVED');
  assert.ok(r.reason.length > 20);
  const r2 = makeBridge().resolveMember('named', 'method', 'mod/Player', 'noSuchMethod', null);
  assert.equal(r2.confidence, 'UNRESOLVED');
});

test('rename layer feeds CANDIDATE (never EXACT) when jar grounding misses', () => {
  // mod/Gone resolves through mojmap to real/Gone, absent from target; the rename
  // table (built from a synthetic surface) proposes real/BrandNew.
  const yarn2 = YARN + '\nc\tclass_13\tmod/Gone';
  const inter2 = INTERMEDIARY + '\nc\tdd\tclass_13';
  const mojmap2 = MOJMAP + '\nreal.Gone -> dd:\n    real.Food unique(real.Food,real.Food) -> u\n';
  const fp: [string, string][] = [['unique', '(Lreal/Food;Lreal/Food;)Lreal/Food;']];
  const target2: JarApi = {
    id: 'target-test-2',
    classes: new Map([...TARGET.classes, ...new Map([['real/BrandNew', cls('real/BrandNew', 'java/lang/Object', fp)] as const])]),
  };
  // old surface: real/Gone with the same exotic fingerprint → bijective match to BrandNew
  const oldSurface = new Map([
    ['real/Gone', { methods: [{ name: 'unique', desc: '(Lreal/Food;Lreal/Food;)Lreal/Food;' }], fields: [] }],
    // anchors so the table has context
    ['real/Player', { methods: [{ name: 'getFood', desc: '()Lreal/Food;' }], fields: [] }],
    ['real/Food', { methods: [], fields: [] }],
    ['real/Living', { methods: [{ name: 'getHealth', desc: '()F' }], fields: [] }],
  ]);
  const renames = buildRenameTable(oldSurface, target2);
  const bridge = new EraBridge({
    yarn: parseTinyV2(yarn2),
    intermediary: parseTinyV2(inter2),
    mojmap: parseProguard(mojmap2),
    target: target2,
    oldHierarchy: OLD_HIERARCHY,
    renames,
  });
  const r = bridge.resolveClass('named', 'mod/Gone');
  assert.equal(r.confidence, 'CANDIDATE', 'rename-layer hits are CANDIDATE');
  assert.equal(r.candidates![0]!.to.owner, 'real/BrandNew');
  assert.ok(r.candidates![0]!.evidence.length > 10);
  // The taxonomy invariant: a rename-layer hit must NEVER surface as EXACT.
  assert.notEqual(r.confidence, 'EXACT');
});

test('source-namespace path (NeoForge mods) skips the tiny hops', () => {
  const r = makeBridge().resolveMember('source', 'method', 'real/Player', 'getFood', null);
  assert.equal(r.confidence, 'EXACT');
  assert.equal(r.to!.owner, 'real/Player');
});
