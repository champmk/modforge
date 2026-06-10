/**
 * --apply wiring tests: real scanner output → wire adapter → patch planner →
 * pure apply. Expectations hand-derived from the sample source below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanJavaSource } from '../src/scan/java.ts';
import { adaptForPatching, type PatchInput } from '../src/patch/wire.ts';
import { planJavaPatches, applyPatches } from '../src/patch/patch.ts';
import type { Resolution } from '../src/core/model.ts';

const OLD_CLASS = 'net/minecraft/entity/player/PlayerEntity';
const NEW_CLASS = 'net/minecraft/world/entity/player/Player';

const SRC = [
  'package demo;',
  '',
  'import net.minecraft.entity.player.PlayerEntity;',
  '',
  'public class Demo {',
  '\tprivate PlayerEntity cached;',
  '\tvoid tick() {',
  '\t\tPlayerEntity p = this.cached;',
  '\t\tfloat h = p.getHealth();',
  '\t}',
  '}',
  '',
].join('\n');

const CLASS_EXACT: Resolution = {
  from: { kind: 'class', owner: OLD_CLASS },
  confidence: 'EXACT',
  to: { kind: 'class', owner: NEW_CLASS },
  reason: 'test: deterministic chain, class present in target',
  chain: ['test-hop'],
};

const MEMBER_EXACT_RENAMED: Resolution = {
  from: { kind: 'method', owner: OLD_CLASS, name: 'getHealth' },
  confidence: 'EXACT',
  to: { kind: 'method', owner: NEW_CLASS, name: 'getLife', desc: '()F' },
  reason: 'test: member renamed at the boundary, verified in target',
  chain: ['test-hop'],
};

/** Pair scanner findings with test resolutions the way the CLI does. */
function inputs(text: string, classRes: Resolution, memberRes: Resolution | null): PatchInput[] {
  const scan = scanJavaSource(text, 'Demo.java');
  const out: PatchInput[] = [];
  let i = 0;
  for (const f of scan.findings) {
    if (f.className !== OLD_CLASS) continue;
    if (f.memberName !== undefined) {
      if (memberRes) out.push({ finding: f, resolution: memberRes, id: `m${i++}` });
    } else {
      out.push({ finding: f, resolution: classRes, id: `c${i++}` });
    }
  }
  return out;
}

test('apply pipeline rewrites import, type usages, and a renamed member', () => {
  const adapted = adaptForPatching(SRC, 'Demo.java', inputs(SRC, CLASS_EXACT, MEMBER_EXACT_RENAMED));
  const plan = planJavaPatches(SRC, 'Demo.java', adapted);
  const result = applyPatches(SRC, plan.ops);
  assert.equal(result.refused.length, 0, JSON.stringify(result.refused, null, 2));
  assert.ok(result.text.includes('import net.minecraft.world.entity.player.Player;'), 'import rewritten');
  assert.ok(!result.text.includes('PlayerEntity'), 'no old simple name remains');
  assert.ok(result.text.includes('private Player cached;'), 'field type rewritten');
  assert.ok(result.text.includes('Player p = this.cached;'), 'local type rewritten');
  assert.ok(result.text.includes('p.getLife();'), 'member callsite renamed');
  assert.ok(!result.text.includes('getHealth'), 'old member name gone');
});

test('CANDIDATE resolutions are never patched', () => {
  const candidate: Resolution = {
    ...CLASS_EXACT,
    confidence: 'CANDIDATE',
    candidates: [{ to: { kind: 'class', owner: NEW_CLASS }, score: 0.9, evidence: 'test evidence' }],
  };
  delete (candidate as { to?: unknown }).to;
  const adapted = adaptForPatching(SRC, 'Demo.java', inputs(SRC, candidate, null));
  const plan = planJavaPatches(SRC, 'Demo.java', adapted);
  assert.equal(plan.ops.length, 0);
  assert.ok(plan.skipped.length > 0);
  assert.match(plan.skipped[0]!.reason, /CANDIDATE/);
});

test('apply is idempotent: re-planning the patched text yields zero ops', () => {
  const adapted = adaptForPatching(SRC, 'Demo.java', inputs(SRC, CLASS_EXACT, MEMBER_EXACT_RENAMED));
  const once = applyPatches(SRC, planJavaPatches(SRC, 'Demo.java', adapted).ops).text;
  // Same (stale) findings against the already-patched text: every span now
  // mismatches, so the planner must refuse everything rather than re-edit.
  const again = planJavaPatches(once, 'Demo.java', adaptForPatching(once, 'Demo.java', inputs(SRC, CLASS_EXACT, MEMBER_EXACT_RENAMED)));
  assert.equal(again.ops.length, 0);
});
