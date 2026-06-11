/**
 * Tests for the EXACT-only source patcher (src/patch/patch.ts).
 *
 * Spans in the Java fixtures are computed with indexOf against unique anchors,
 * never hardcoded — the tests stay valid if the fixture text is reformatted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPatches,
  applyToDisk,
  planJavaPatches,
  sourceDottedName,
  simpleNameOf,
  BACKUP_DIR,
  type PatchOp,
  type ResolvedJavaFinding,
  type SourceSpan,
} from '../src/patch/patch.ts';
import type { Resolution } from '../src/core/model.ts';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const exactClass = (from: string, to: string): Resolution => ({
  from: { kind: 'class', owner: from },
  confidence: 'EXACT',
  to: { kind: 'class', owner: to },
  reason: 'test',
  chain: [],
});

const exactMethod = (owner: string, from: string, to: string): Resolution => ({
  from: { kind: 'method', owner, name: from },
  confidence: 'EXACT',
  to: { kind: 'method', owner, name: to },
  reason: 'test',
  chain: [],
});

const candidateClass = (from: string): Resolution => ({
  from: { kind: 'class', owner: from },
  confidence: 'CANDIDATE',
  candidates: [{ to: { kind: 'class', owner: 'x/y/Maybe' }, evidence: 'test', score: 0.5 }],
  reason: 'test candidate',
  chain: [],
});

/** Span of the n-th occurrence of `needle` in `text` (0-based), asserting it exists. */
function spanOf(text: string, needle: string, occurrence = 0): SourceSpan {
  let idx = -1;
  for (let i = 0; i <= occurrence; i++) {
    idx = text.indexOf(needle, idx + 1);
    assert.notEqual(idx, -1, `fixture must contain occurrence ${occurrence} of ${JSON.stringify(needle)}`);
  }
  return { start: idx, end: idx + needle.length };
}

/** Span of `token` located via a longer unique `anchor` that starts with it. */
function tokenAt(text: string, anchor: string, token: string): SourceSpan {
  assert.ok(anchor.startsWith(token), 'anchor must start with token');
  const a = spanOf(text, anchor);
  return { start: a.start, end: a.start + token.length };
}

const op = (file: string, span: SourceSpan, before: string, after: string, findingId: string): PatchOp => ({
  file,
  start: span.start,
  end: span.end,
  before,
  after,
  findingId,
});

// ---------------------------------------------------------------------------
// applyPatches
// ---------------------------------------------------------------------------

test('applyPatches applies non-overlapping ops in reverse-offset order', () => {
  const text = 'aaa bbb ccc';
  const r = applyPatches(text, [
    op('f', spanOf(text, 'aaa'), 'aaa', 'AAAA', '1'),
    op('f', spanOf(text, 'ccc'), 'ccc', 'C', '2'),
  ]);
  assert.equal(r.text, 'AAAA bbb C');
  assert.equal(r.applied.length, 2);
  assert.equal(r.refused.length, 0);
  assert.equal(r.applied[0]!.findingId, '1'); // ascending span order
});

test('applyPatches refuses the WHOLE file on a single before-mismatch', () => {
  const text = 'aaa bbb ccc';
  const r = applyPatches(text, [
    op('f', spanOf(text, 'aaa'), 'aaa', 'AAAA', 'good'),
    op('f', spanOf(text, 'bbb'), 'NOT-THERE', 'x', 'bad'),
  ]);
  assert.equal(r.text, text); // untouched
  assert.equal(r.applied.length, 0);
  assert.equal(r.refused.length, 2);
  const bad = r.refused.find((x) => x.op.findingId === 'bad')!;
  assert.match(bad.reason, /expects "NOT-THERE"/);
  const good = r.refused.find((x) => x.op.findingId === 'good')!;
  assert.match(good.reason, /all-or-nothing/);
});

test('applyPatches refuses overlapping ops and out-of-bounds spans', () => {
  const text = 'abcdef';
  const overlap = applyPatches(text, [
    op('f', { start: 0, end: 3 }, 'abc', 'x', '1'),
    op('f', { start: 2, end: 5 }, 'cde', 'y', '2'),
  ]);
  assert.equal(overlap.applied.length, 0);
  assert.equal(overlap.refused.length, 2);
  assert.match(overlap.refused[0]!.reason, /overlaps/);

  const oob = applyPatches(text, [op('f', { start: 4, end: 99 }, 'ef', 'x', '1')]);
  assert.equal(oob.applied.length, 0);
  assert.match(oob.refused[0]!.reason, /out of bounds/);
});

test('applyPatches refuses mixed-file batches', () => {
  const text = 'abc';
  const r = applyPatches(text, [
    op('f1', { start: 0, end: 1 }, 'a', 'x', '1'),
    op('f2', { start: 2, end: 3 }, 'c', 'y', '2'),
  ]);
  assert.equal(r.applied.length, 0);
  assert.equal(r.refused.length, 2);
  assert.match(r.refused.map((x) => x.reason).join('\n'), /exactly one file/);
});

// ---------------------------------------------------------------------------
// planJavaPatches — fixture
// ---------------------------------------------------------------------------

const FILE = 'src/main/java/demo/Demo.java';
const SRC = [
  'package demo;',
  '',
  'import net.minecraft.resources.ResourceLocation;',
  'import net.minecraft.util.Unchanged;',
  '',
  'public final class Demo {',
  '  // ResourceLocation in a comment must never be touched',
  '  private final ResourceLocation id;',
  '  private final Unchanged u = null;',
  '  private final String s = "ResourceLocation";',
  '  Demo(ResourceLocation id2) { this.id = id2; }',
  '  long time() { return net.minecraft.world.level.Level.getDayTime(); }',
  '}',
  '',
].join('\n');

const RL_OLD = 'net/minecraft/resources/ResourceLocation';
const RL_NEW = 'net/minecraft/util/Identifier';
const LEVEL_OLD = 'net/minecraft/world/level/Level';
const LEVEL_NEW = 'net/minecraft/world/level/World';

function fixtureFindings(): ResolvedJavaFinding[] {
  const fqnLevel = spanOf(SRC, 'net.minecraft.world.level.Level');
  return [
    // import rewrite (simple name changes: ResourceLocation → Identifier)
    {
      file: FILE,
      line: 3,
      col: 8,
      kind: 'import',
      className: RL_OLD,
      span: spanOf(SRC, 'net.minecraft.resources.ResourceLocation'),
      id: 'imp-rl',
      resolution: exactClass(RL_OLD, RL_NEW),
    },
    // import whose class is unchanged → zero ops
    {
      file: FILE,
      line: 4,
      col: 8,
      kind: 'import',
      className: 'net/minecraft/util/Unchanged',
      span: spanOf(SRC, 'net.minecraft.util.Unchanged'),
      id: 'imp-unchanged',
      resolution: exactClass('net/minecraft/util/Unchanged', 'net/minecraft/util/Unchanged'),
    },
    // simple-name usages bound by the rewritten import
    {
      file: FILE,
      line: 8,
      col: 17,
      kind: 'type-usage',
      className: RL_OLD,
      span: tokenAt(SRC, 'ResourceLocation id;', 'ResourceLocation'),
      id: 'use-field',
      resolution: exactClass(RL_OLD, RL_NEW),
    },
    {
      file: FILE,
      line: 11,
      col: 8,
      kind: 'type-usage',
      className: RL_OLD,
      span: tokenAt(SRC, 'ResourceLocation id2', 'ResourceLocation'),
      id: 'use-ctor',
      resolution: exactClass(RL_OLD, RL_NEW),
    },
    // a span pointing into a comment — must be refused by masking
    {
      file: FILE,
      line: 7,
      col: 6,
      kind: 'type-usage',
      className: RL_OLD,
      span: tokenAt(SRC, 'ResourceLocation in a comment', 'ResourceLocation'),
      id: 'use-comment',
      resolution: exactClass(RL_OLD, RL_NEW),
    },
    // FQN occurrence in code
    {
      file: FILE,
      line: 12,
      col: 24,
      kind: 'fqn',
      className: LEVEL_OLD,
      span: fqnLevel,
      id: 'fqn-level',
      resolution: exactClass(LEVEL_OLD, LEVEL_NEW),
    },
    // static-qualified member rename (lexically certain by kind)
    {
      file: FILE,
      line: 12,
      col: 56,
      kind: 'member-static',
      className: LEVEL_OLD,
      memberName: 'getDayTime',
      span: spanOf(SRC, 'getDayTime'),
      id: 'mem-daytime',
      resolution: exactMethod(LEVEL_OLD, 'getDayTime', 'getOverworldClockTime'),
    },
    // CANDIDATE — must never be patched
    {
      file: FILE,
      line: 8,
      col: 17,
      kind: 'type-usage',
      className: RL_OLD,
      span: tokenAt(SRC, 'ResourceLocation id;', 'ResourceLocation'),
      id: 'cand-rl',
      resolution: candidateClass(RL_OLD),
    },
    // member-instance WITHOUT the receiver-certainty mark — must be skipped
    {
      file: FILE,
      line: 12,
      col: 56,
      kind: 'member-instance',
      className: LEVEL_OLD,
      memberName: 'getDayTime',
      span: spanOf(SRC, 'getDayTime'),
      id: 'mem-uncertain',
      resolution: exactMethod(LEVEL_OLD, 'getDayTime', 'getOverworldClockTime'),
    },
  ];
}

test('planJavaPatches: EXACT-only plan with import/fqn/type-usage/member rules', () => {
  const plan = planJavaPatches(SRC, FILE, fixtureFindings());

  const byId = new Map(plan.ops.map((o) => [o.findingId, o]));
  assert.deepEqual(
    [...byId.keys()].sort(),
    ['fqn-level', 'imp-rl', 'mem-daytime', 'use-ctor', 'use-field'],
  );

  // taxonomy gate
  const cand = plan.skipped.find((s) => s.findingId === 'cand-rl')!;
  assert.match(cand.reason, /only EXACT/);
  // masking gate
  const comment = plan.skipped.find((s) => s.findingId === 'use-comment')!;
  assert.match(comment.reason, /comment or string/);
  // receiver-certainty gate
  const uncertain = plan.skipped.find((s) => s.findingId === 'mem-uncertain')!;
  assert.match(uncertain.reason, /not lexically certain/);
  // unchanged class → no op
  const unchanged = plan.skipped.find((s) => s.findingId === 'imp-unchanged')!;
  assert.match(unchanged.reason, /unchanged/);

  const r = applyPatches(SRC, plan.ops);
  assert.equal(r.refused.length, 0);
  assert.ok(r.text.includes('import net.minecraft.util.Identifier;'));
  assert.ok(r.text.includes('private final Identifier id;'));
  assert.ok(r.text.includes('Demo(Identifier id2)'));
  assert.ok(r.text.includes('net.minecraft.world.level.World.getOverworldClockTime()'));
  // comment and string literal untouched
  assert.ok(r.text.includes('// ResourceLocation in a comment'));
  assert.ok(r.text.includes('"ResourceLocation"'));
});

test('planJavaPatches is idempotent: re-planning a patched file yields zero ops', () => {
  const findings = fixtureFindings();
  const plan = planJavaPatches(SRC, FILE, findings);
  const patched = applyPatches(SRC, plan.ops).text;
  const replan = planJavaPatches(patched, FILE, findings);
  assert.equal(replan.ops.length, 0);
});

test('planJavaPatches: type-usage without an accompanying import rewrite is skipped', () => {
  const findings = fixtureFindings().filter((f) => f.id !== 'imp-rl');
  const plan = planJavaPatches(SRC, FILE, findings);
  assert.equal(plan.ops.some((o) => o.findingId === 'use-field'), false);
  const s = plan.skipped.find((x) => x.findingId === 'use-field')!;
  assert.match(s.reason, /no accompanying import rewrite/);
});

test('planJavaPatches: import rewrite refused when the new simple name is already in play', () => {
  const src = [
    'import net.minecraft.resources.ResourceLocation;',
    'import other.lib.Identifier;',
    'class A { ResourceLocation x; Identifier y; }',
    '',
  ].join('\n');
  const findings: ResolvedJavaFinding[] = [
    {
      file: FILE,
      line: 1,
      col: 8,
      kind: 'import',
      span: spanOf(src, 'net.minecraft.resources.ResourceLocation'),
      id: 'imp',
      resolution: exactClass(RL_OLD, RL_NEW),
    },
  ];
  const plan = planJavaPatches(src, FILE, findings);
  assert.equal(plan.ops.length, 0);
  assert.match(plan.skipped[0]!.reason, /ambiguous with existing import 'other.lib.Identifier'/);
});

test('planJavaPatches: package-only move patches the import and leaves usages alone', () => {
  const src = ['import net.minecraft.resources.Thing;', 'class A { Thing t; }', ''].join('\n');
  const OLD = 'net/minecraft/resources/Thing';
  const NEW = 'net/minecraft/util/Thing';
  const findings: ResolvedJavaFinding[] = [
    { file: FILE, line: 1, col: 8, kind: 'import', span: spanOf(src, 'net.minecraft.resources.Thing'), id: 'imp', resolution: exactClass(OLD, NEW) },
    { file: FILE, line: 2, col: 11, kind: 'type-usage', span: tokenAt(src, 'Thing t', 'Thing'), id: 'use', resolution: exactClass(OLD, NEW) },
  ];
  const plan = planJavaPatches(src, FILE, findings);
  assert.deepEqual(plan.ops.map((o) => o.findingId), ['imp']);
  assert.match(plan.skipped.find((s) => s.findingId === 'use')!.reason, /import rewrite alone/);
  assert.ok(applyPatches(src, plan.ops).text.includes('import net.minecraft.util.Thing;'));
});

test('planJavaPatches: static import forms are preserved (class span only)', () => {
  const src = ['import static net.minecraft.world.level.Level.getDayTime;', 'class A {}', ''].join('\n');
  const findings: ResolvedJavaFinding[] = [
    {
      file: FILE,
      line: 1,
      col: 15,
      kind: 'import',
      span: spanOf(src, 'net.minecraft.world.level.Level'),
      id: 'imp-static',
      resolution: exactClass(LEVEL_OLD, LEVEL_NEW),
    },
    {
      file: FILE,
      line: 1,
      col: 47,
      kind: 'member-static',
      memberName: 'getDayTime',
      span: spanOf(src, 'getDayTime'),
      id: 'mem-static-imp',
      resolution: exactMethod(LEVEL_OLD, 'getDayTime', 'getOverworldClockTime'),
    },
  ];
  const plan = planJavaPatches(src, FILE, findings);
  assert.equal(plan.ops.length, 2);
  const out = applyPatches(src, plan.ops).text;
  assert.ok(out.includes('import static net.minecraft.world.level.World.getOverworldClockTime;'));
});

// ---------------------------------------------------------------------------
// applyToDisk
// ---------------------------------------------------------------------------

test('applyToDisk writes patches, backs up originals once, and is re-run safe', () => {
  const root = mkdtempSync(join(tmpdir(), 'modforge-patch-'));
  try {
    const rel = join('src', 'Demo.java');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, rel), SRC, 'utf8');

    const plan = planJavaPatches(SRC, rel, fixtureFindings().map((f) => ({ ...f, file: rel })));
    assert.ok(plan.ops.length > 0);

    const outcomes = applyToDisk(plan.ops, { root });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.written, true);
    assert.equal(outcomes[0]!.refused.length, 0);

    const patched = readFileSync(join(root, rel), 'utf8');
    assert.ok(patched.includes('import net.minecraft.util.Identifier;'));
    const backupPath = outcomes[0]!.backupPath!;
    assert.ok(
      backupPath.includes(join(BACKUP_DIR, 'backup')),
      `backup must live under ${join(BACKUP_DIR, 'backup')}/ (nested in a dot-dir so gradle never compiles it); got ${backupPath}`,
    );
    assert.equal(readFileSync(backupPath, 'utf8'), SRC); // original preserved

    // Re-run with the same (now stale) ops: whole file refused, nothing changes.
    const rerun = applyToDisk(plan.ops, { root });
    assert.equal(rerun[0]!.written, false);
    assert.ok(rerun[0]!.refused.length > 0);
    assert.equal(readFileSync(join(root, rel), 'utf8'), patched);
    assert.equal(readFileSync(backupPath, 'utf8'), SRC); // backup not clobbered
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyToDisk refuses targets outside root before touching anything', () => {
  const root = mkdtempSync(join(tmpdir(), 'modforge-patch-'));
  try {
    assert.throws(
      () => applyToDisk([op('../evil.java', { start: 0, end: 1 }, 'a', 'b', 'x')], { root }),
      /outside root/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// name-form helpers
// ---------------------------------------------------------------------------

test('sourceDottedName and simpleNameOf handle inner classes', () => {
  assert.equal(sourceDottedName('a/b/Outer$Inner'), 'a.b.Outer.Inner');
  assert.equal(simpleNameOf('a/b/Outer$Inner'), 'Inner');
  assert.equal(simpleNameOf('a/b/C'), 'C');
});
