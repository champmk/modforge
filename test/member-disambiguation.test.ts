/**
 * Source-namespace member disambiguation + countCallArgs arity honesty.
 *
 * Replays two confirmed P1 attacks against the SOURCE ('source'/mojmap, NeoForge)
 * resolution path and the lexical arity counter:
 *
 *  - finding 02: source-namespace member resolution matches by NAME only — callsite
 *    arity (which the scanner records) is consulted only on the 'named' path, and a
 *    0-arg instance call (`blockPos.getX()`) is certified EXACT as the 1-arg STATIC
 *    `getX(J)I`. The frozen contract: the 'source' path (incl. findInheritedSource)
 *    must apply the SAME disambiguation rigor as the named path — filter by descriptor
 *    when given, else by callsite arity when given; remainder ≠ 1 ⇒ honest UNRESOLVED,
 *    never a guessed EXACT.
 *  - finding 30: `f(a < b, c > d)` is parsed as ONE generic-typed arg (argCount 1);
 *    that wrong arity then drives wrong overload picks. The frozen contract: when
 *    `<...>` is AMBIGUOUS between generics and comparisons, countCallArgs returns
 *    null (no arity) — never a wrong count — WITHOUT regressing legitimate generic
 *    callsites.
 *
 * Every expectation below is hand-derived from the synthetic mini-world / source
 * snippets — never copied from engine output.
 *
 * Mini-world (mojmap 'source' namespace; NeoForge mods are already in source names):
 *   real/Mover    -> mv  { void move(int) -> a   [move (I)V , 1 arg]
 *                          void move(int,int) -> b [move (II)V, 2 args]   }  (overloads)
 *   real/BlockPos -> bp  { int getX(long) -> a   [getX (J)I , 1 arg, STATIC in target] }
 *   real/Child    -> ch  { }                      (declares no process — inherits it)
 *   real/Parent   -> pa  { void process(int) -> a   [process (I)V , 1 arg]
 *                          void process(int,int) -> b [process (II)V, 2 args] } (overloads)
 *   old hierarchy: ch extends pa   (Child extends Parent in the OLD jar)
 *   target jar:    real/Mover { move (I)V, move (II)V }
 *                  real/BlockPos { getX (J)I  — ACC_STATIC }
 *                  real/Parent { process (I)V, process (II)V }
 *                  real/Child extends real/Parent (no own members)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProguard } from '../src/mappings/proguard.ts';
import { EraBridge, type OldHierarchyEntry } from '../src/bridge/bridge.ts';
import { ACC, type JarApi, type ClassApi } from '../src/core/model.ts';
import { scanJavaSource } from '../src/scan/java.ts';

const MOJMAP = [
  'real.Mover -> mv:',
  '    void move(int) -> a',
  '    void move(int,int) -> b',
  'real.BlockPos -> bp:',
  '    int getX(long) -> a',
  'real.Child -> ch:',
  'real.Parent -> pa:',
  '    void process(int) -> a',
  '    void process(int,int) -> b',
].join('\n');

/** Build a target ClassApi; per-method access flags default to public-instance. */
function cls(name: string, superName: string | null, methods: [string, string, number?][]): ClassApi {
  return {
    binaryName: name,
    access: ACC.PUBLIC,
    majorVersion: 69,
    superName,
    interfaces: [],
    methods: methods.map(([n, d, a]) => ({ name: n, desc: d, access: a ?? ACC.PUBLIC })),
    fields: [],
  };
}

const TARGET: JarApi = {
  id: 'tgt',
  classes: new Map(
    [
      cls('real/Mover', 'java/lang/Object', [['move', '(I)V'], ['move', '(II)V']]),
      // getX is a 1-arg STATIC method — an instance `blockPos.getX()` must NOT bind to it.
      cls('real/BlockPos', 'java/lang/Object', [['getX', '(J)I', ACC.PUBLIC | ACC.STATIC]]),
      cls('real/Parent', 'java/lang/Object', [['process', '(I)V'], ['process', '(II)V']]),
      cls('real/Child', 'real/Parent', []),
    ].map((c) => [c.binaryName, c] as const),
  ),
};

const OLD_HIERARCHY = new Map<string, OldHierarchyEntry>([
  ['mv', { superName: 'java/lang/Object', interfaces: [] }],
  ['bp', { superName: 'java/lang/Object', interfaces: [] }],
  ['ch', { superName: 'pa', interfaces: [] }],
  ['pa', { superName: 'java/lang/Object', interfaces: [] }],
]);

function makeBridge(): EraBridge {
  return new EraBridge({ mojmap: parseProguard(MOJMAP), target: TARGET, oldHierarchy: OLD_HIERARCHY });
}

// ---------------------------------------------------------------------------
// Source-namespace member disambiguation (finding 02)
// ---------------------------------------------------------------------------

test('source overload pair + callsite arity → resolves the matching overload EXACT; the other is not certified', () => {
  // move(int) / move(int,int); callsite has 2 args. Hand-derived: the 2-arg
  // overload move (II)V is the only arity match → EXACT; move (I)V must not surface.
  const r = makeBridge().resolveMember('source', 'method', 'real/Mover', 'move', null, { argCount: 2 });
  assert.equal(r.confidence, 'EXACT');
  assert.equal(r.to!.owner, 'real/Mover');
  assert.equal(r.to!.name, 'move');
  assert.equal(r.to!.desc, '(II)V');
  // The OTHER overload's descriptor must never be the certified target.
  assert.notEqual(r.to!.desc, '(I)V');
});

test('source overload pair + NO arity/descriptor → UNRESOLVED with an overload reason (never a pick)', () => {
  const r = makeBridge().resolveMember('source', 'method', 'real/Mover', 'move', null);
  assert.equal(r.confidence, 'UNRESOLVED');
  assert.equal(r.to, undefined);
  assert.match(r.reason, /overload/i);
});

test('source overload pair + arity matching NEITHER overload → UNRESOLVED (varargs honesty), never a guess', () => {
  // 3 args; neither move(I)V nor move(II)V takes 3 → no unique pick exists.
  const r = makeBridge().resolveMember('source', 'method', 'real/Mover', 'move', null, { argCount: 3 });
  assert.equal(r.confidence, 'UNRESOLVED');
  assert.equal(r.to, undefined);
  // Honest reason must explain the arity miss (the count, or arity/parameter/varargs),
  // NOT the pre-fix generic "descriptor needed to disambiguate".
  assert.match(r.reason, /arit|paramet|vararg|\b3\b/i);
});

test('source: 0-arg instance call must NOT be certified EXACT as the 1-arg static getX(J)I', () => {
  // The finding-02 attack: blockPos.getX() is a 0-arg instance call; the only
  // mojmap name-match is the 1-arg STATIC getX(long). Name-only resolution
  // certifies EXACT getX (J)I — a descriptor that contradicts the callsite.
  // Contract: arity 0 matches no member here → not EXACT.
  const r = makeBridge().resolveMember('source', 'method', 'real/BlockPos', 'getX', null, { argCount: 0 });
  assert.notEqual(r.confidence, 'EXACT');
  // And it must certainly not emit the bogus 1-arg static descriptor as the answer.
  assert.notEqual(r.to?.desc, '(J)I');
});

test('findInheritedSource: overloads on a supertype get the SAME arity filtering through the walk', () => {
  // process is declared only on Parent (Child inherits). Two overloads; callsite
  // has 2 args. Hand-derived: the walk must filter to the unique 2-arg overload
  // and certify EXACT process (II)V on real/Parent (inherited EXACT is allowed).
  const r = makeBridge().resolveMember('source', 'method', 'real/Child', 'process', null, { argCount: 2 });
  assert.equal(r.confidence, 'EXACT');
  assert.equal(r.to!.owner, 'real/Parent');
  assert.equal(r.to!.name, 'process');
  assert.equal(r.to!.desc, '(II)V');
  assert.notEqual(r.to!.desc, '(I)V');
});

test('determinism: identical source-overload inputs produce identical resolutions', () => {
  const a = makeBridge().resolveMember('source', 'method', 'real/Mover', 'move', null, { argCount: 2 });
  const b = makeBridge().resolveMember('source', 'method', 'real/Mover', 'move', null, { argCount: 2 });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// countCallArgs arity honesty (finding 30), exercised through scanJavaSource.
// A statically-imported bare call `f(...)` surfaces a `member-static` finding
// whose `argCount` is exactly countCallArgs over the callsite (undefined when the
// counter returns null — the honest no-arity path).
// ---------------------------------------------------------------------------

/** Lexically-counted callsite arity for the named member, or undefined when uncountable. */
function argCountOf(body: string, member: string): number | undefined {
  const src = `import static p.Q.${member};\nclass T { java.lang.Object m() { return ${body}; } }\n`;
  const r = scanJavaSource(src, 'T.java');
  const finding = r.findings.find((f) => f.kind === 'member-static' && f.memberName === member);
  assert.ok(finding, `expected a member-static finding for ${member} in: ${body}`);
  return finding!.argCount;
}

test('countCallArgs: f(a, b) → 2', () => {
  assert.equal(argCountOf('f(a, b)', 'f'), 2);
});

test('countCallArgs: f(a < b, c > d) → null (ambiguous generics-vs-comparison; NOT 1, NOT 2)', () => {
  // The comparison-comma-comparison shape is genuinely ambiguous; the honest
  // answer is "uncountable" → no argCount recorded (undefined), never 1.
  const n = argCountOf('f(a < b, c > d)', 'f');
  assert.equal(n, undefined);
  assert.notEqual(n, 1);
  assert.notEqual(n, 2);
});

test('countCallArgs: f(new HashMap<String, List<Integer>>()) → 1 (legit nested generics not regressed)', () => {
  assert.equal(argCountOf('f(new HashMap<String, List<Integer>>())', 'f'), 1);
});

test('countCallArgs: legit type-witness generic argument f(Collections.<String>emptyList()) → 1', () => {
  const src =
    'import static p.Q.f;\nimport java.util.Collections;\n' +
    'class T { void m() { f(Collections.<String>emptyList()); } }\n';
  const r = scanJavaSource(src, 'T.java');
  const finding = r.findings.find((f) => f.kind === 'member-static' && f.memberName === 'f');
  assert.ok(finding, 'expected a member-static finding for f');
  assert.equal(finding!.argCount, 1);
});

test('countCallArgs: explicit type-witness call obj-style <T>call(x) keeps arity right (1)', () => {
  // A generic type witness before the method name must not corrupt the arg count.
  const src = 'import static p.Q.call;\nclass T { void m() { Foo.<T>call(x); } }\n';
  const r = scanJavaSource(src, 'T.java');
  const finding = r.findings.find((f) => f.kind === 'member-static' && f.memberName === 'call');
  assert.ok(finding, 'expected a member-static finding for call');
  assert.equal(finding!.argCount, 1);
});

test('countCallArgs: f() → 0', () => {
  assert.equal(argCountOf('f()', 'f'), 0);
});

test('countCallArgs: f((a < b) ? x : y) → 1 (parenthesized comparison is unambiguous)', () => {
  assert.equal(argCountOf('f((a < b) ? x : y)', 'f'), 1);
});
