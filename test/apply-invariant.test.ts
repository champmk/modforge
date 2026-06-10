/**
 * The old-name dangling invariant (CONTRACTS §invariant): an import rewrite
 * whose simple name changes may only be applied if EVERY standalone occurrence
 * of the old simple name in the file's code is covered by a planned op in the
 * same plan. Any uncovered occurrence refuses the ENTIRE file.
 *
 * Attack shapes come from the confirmed P0: static-access receivers
 * (`MathHelper.floor`), casts, and return types produce no scanner finding, so
 * rewriting the import alone left non-compiling files while printing success.
 * Expectations hand-derived from the sources below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanJavaSource } from '../src/scan/java.ts';
import { adaptForPatching, type PatchInput } from '../src/patch/wire.ts';
import { planJavaPatches, applyPatches } from '../src/patch/patch.ts';
import type { Resolution } from '../src/core/model.ts';

function classExact(fromOwner: string, toOwner: string): Resolution {
  return {
    from: { kind: 'class', owner: fromOwner },
    confidence: 'EXACT',
    to: { kind: 'class', owner: toOwner },
    reason: 'test: deterministic chain, class present in target',
    chain: ['test-hop'],
  };
}

/** Pair every class finding for `fromOwner` with an EXACT rename resolution. */
function classInputs(text: string, file: string, fromOwner: string, toOwner: string): PatchInput[] {
  const out: PatchInput[] = [];
  let i = 0;
  for (const f of scanJavaSource(text, file).findings) {
    if (f.className !== fromOwner || f.memberName !== undefined) continue;
    out.push({ finding: f, resolution: classExact(fromOwner, toOwner), id: `c${i++}` });
  }
  return out;
}

function plan(text: string, file: string, inputs: PatchInput[]) {
  return planJavaPatches(text, file, adaptForPatching(text, file, inputs));
}

test('static-access receiver with no covering op refuses the whole file', () => {
  // Line 7 uses MathHelper as a static receiver; the scanner emits only a
  // member finding for `floor`, never one covering the receiver token, so the
  // import rewrite would leave line 7 referencing a vanished name.
  const src = [
    'package demo;',
    '',
    'import net.minecraft.util.math.MathHelper;',
    '',
    'public class Demo {',
    '\tint f(float x) {',
    '\t\treturn MathHelper.floor(x);',
    '\t}',
    '}',
    '',
  ].join('\n');
  const p = plan(src, 'Demo.java', classInputs(src, 'Demo.java', 'net/minecraft/util/math/MathHelper', 'net/minecraft/util/Mth'));
  assert.equal(p.ops.length, 0, JSON.stringify(p.ops, null, 2));
  const importSkip = p.skipped.find((s) => s.kind === 'import');
  assert.ok(importSkip, 'the refused import rewrite must appear in skipped');
  assert.match(importSkip!.reason, /MathHelper/);
  assert.match(importSkip!.reason, /line.* 7/);
});

test('cast and return-type occurrences (no finding at all) refuse the whole file', () => {
  // Line 6 return type and line 7 cast produce no scanner finding — both would
  // dangle after the import rewrite.
  const src = [
    'package demo;',
    '',
    'import net.minecraft.server.network.ServerPlayerEntity;',
    '',
    'public class Demo {',
    '\tServerPlayerEntity cast(Object o) {',
    '\t\treturn (ServerPlayerEntity) o;',
    '\t}',
    '}',
    '',
  ].join('\n');
  const p = plan(src, 'Demo.java', classInputs(src, 'Demo.java', 'net/minecraft/server/network/ServerPlayerEntity', 'net/minecraft/server/level/ServerPlayer'));
  assert.equal(p.ops.length, 0, JSON.stringify(p.ops, null, 2));
  const importSkip = p.skipped.find((s) => s.kind === 'import');
  assert.ok(importSkip);
  assert.match(importSkip!.reason, /ServerPlayerEntity/);
  assert.match(importSkip!.reason, /6.*7|6, 7/);
});

test('fully-covered file still applies (the invariant must not over-refuse)', () => {
  const src = [
    'package demo;',
    '',
    'import net.minecraft.entity.player.PlayerEntity;',
    '',
    'public class Demo {',
    '\tprivate PlayerEntity cached;',
    '\tvoid tick() {',
    '\t\tPlayerEntity p = this.cached;',
    '\t}',
    '}',
    '',
  ].join('\n');
  const p = plan(src, 'Demo.java', classInputs(src, 'Demo.java', 'net/minecraft/entity/player/PlayerEntity', 'net/minecraft/world/entity/player/Player'));
  assert.ok(p.ops.length >= 3, `expected import + 2 type usages, got ${JSON.stringify(p.ops, null, 2)}`);
  const out = applyPatches(src, p.ops);
  assert.equal(out.refused.length, 0);
  assert.ok(!out.text.includes('PlayerEntity'), 'no old simple name remains');
});

test('comment and string occurrences never block an otherwise-covered file', () => {
  const src = [
    'package demo;',
    '',
    'import net.minecraft.entity.player.PlayerEntity;',
    '',
    'public class Demo {',
    '\t// PlayerEntity is mentioned in this comment',
    '\tprivate PlayerEntity cached;',
    '\tString s = "PlayerEntity";',
    '}',
    '',
  ].join('\n');
  const p = plan(src, 'Demo.java', classInputs(src, 'Demo.java', 'net/minecraft/entity/player/PlayerEntity', 'net/minecraft/world/entity/player/Player'));
  assert.ok(p.ops.length >= 2, JSON.stringify(p.skipped, null, 2));
  const out = applyPatches(src, p.ops);
  assert.equal(out.refused.length, 0);
  assert.ok(out.text.includes('// PlayerEntity is mentioned'), 'comment untouched');
  assert.ok(out.text.includes('"PlayerEntity"'), 'string untouched');
  assert.ok(out.text.includes('private Player cached;'), 'code occurrence rewritten');
});

test('package-only rename (simple name unchanged) is exempt from the invariant', () => {
  const src = [
    'package demo;',
    '',
    'import a.b.Same;',
    '',
    'public class Demo {',
    '\tSame x;',
    '}',
    '',
  ].join('\n');
  const p = plan(src, 'Demo.java', classInputs(src, 'Demo.java', 'a/b/Same', 'c/d/Same'));
  assert.equal(p.ops.length, 1, JSON.stringify({ ops: p.ops, skipped: p.skipped }, null, 2));
  const out = applyPatches(src, p.ops);
  assert.ok(out.text.includes('import c.d.Same;'), 'import rewritten');
  assert.ok(out.text.includes('Same x;'), 'usage re-binds via the import, untouched');
});

test('one dangling import refuses the whole file, including covered rewrites', () => {
  const src = [
    'package demo;',
    '',
    'import net.minecraft.entity.player.PlayerEntity;',
    'import net.minecraft.util.math.MathHelper;',
    '',
    'public class Demo {',
    '\tprivate PlayerEntity cached;',
    '\tint f(float x) {',
    '\t\treturn MathHelper.floor(x);',
    '\t}',
    '}',
    '',
  ].join('\n');
  const inputs = [
    ...classInputs(src, 'Demo.java', 'net/minecraft/entity/player/PlayerEntity', 'net/minecraft/world/entity/player/Player'),
    ...classInputs(src, 'Demo.java', 'net/minecraft/util/math/MathHelper', 'net/minecraft/util/Mth'),
  ];
  const p = plan(src, 'Demo.java', inputs);
  assert.equal(p.ops.length, 0, 'refusal is all-or-nothing per file');
  // Both import findings are reported skipped, each naming the dangling name.
  const importSkips = p.skipped.filter((s) => s.kind === 'import');
  assert.equal(importSkips.length, 2);
  for (const s of importSkips) assert.match(s.reason, /MathHelper/);
});
