/**
 * Placeholder rewrites (@MODFORGE_..@) must never be auto-applied (finding 19).
 *
 * The loom plugin-version rule and the gradle.properties version rules used to
 * emit literal '@MODFORGE_LOOM_VERSION@' / '@MODFORGE_MINECRAFT_VERSION@' etc.
 * as EXACT edits, so `gradle-migrate --apply` rewrote build files into an
 * unbuildable state while reporting success. A version the engine cannot
 * resolve is NOT a mechanical rewrite: it belongs in the manual-review
 * remainder with an instruction, and applyGradleMigration must never write a
 * placeholder into a file under ANY apply mode (default or include-review).
 *
 * Pure unit test over planGradleMigration / applyGradleMigration (+ the report
 * summary the CLI prints) — no CLI spawn. Expectations are hand-derived from
 * the fixtures below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planGradleMigration, applyGradleMigration } from '../src/scan/gradle.ts';
import { summarizeGradlePlan } from '../src/report/report.ts';

const BUILD_GRADLE = "plugins {\n    id 'fabric-loom' version '1.9-SNAPSHOT'\n}\n";
const GRADLE_PROPS =
  'minecraft_version=1.21.11\nloader_version=0.16.9\nfabric_version=0.110.0+1.21.11\nloom_version=1.9-SNAPSHOT\n';

test('the loom plugin-version is review-tier, never an auto-applicable EXACT edit', () => {
  const plan = planGradleMigration([{ path: 'build.gradle', text: BUILD_GRADLE }]);

  // No planned edit (EXACT or REVIEW) may emit a placeholder token.
  for (const e of plan.edits) {
    assert.ok(!e.after.includes('@MODFORGE_'), `no planned edit may emit a placeholder; got ${JSON.stringify(e)}`);
  }
  // The version surfaces in the manual-review remainder with an instruction.
  const review = plan.manualReview.find((m) => /loom/i.test(m.reason) && /version/i.test(m.reason));
  assert.ok(review, `the loom plugin version must be flagged for manual review; got ${JSON.stringify(plan.manualReview)}`);
  assert.ok(review!.reason.trim().length > 0, 'the manual-review item must carry an instruction');

  // The deterministic, buildable rewrite (plugin-id rename) still applies as EXACT.
  assert.ok(
    plan.edits.some((e) => e.rule === 'plugin-id' && e.confidence === 'EXACT'),
    'the plugin-id rename must stay an EXACT auto-applied rewrite',
  );
});

test('applyGradleMigration never writes a @MODFORGE_ placeholder (default or include-review)', () => {
  const files = [
    { path: 'build.gradle', text: BUILD_GRADLE },
    { path: 'gradle.properties', text: GRADLE_PROPS },
  ];
  const plan = planGradleMigration(files);

  for (const opts of [undefined, { includeReview: true }]) {
    for (const out of applyGradleMigration(plan, opts)) {
      assert.ok(
        !out.text.includes('@MODFORGE_'),
        `apply output for ${out.path} must not contain a placeholder (opts=${JSON.stringify(opts)}):\n${out.text}`,
      );
    }
  }
});

test('every gradle.properties version value is flagged for review, not silently rewritten', () => {
  const plan = planGradleMigration([{ path: 'gradle.properties', text: GRADLE_PROPS }]);

  for (const e of plan.edits) {
    assert.ok(!e.after.includes('@MODFORGE_'), `no planned edit may emit a placeholder; got ${JSON.stringify(e)}`);
  }
  const reasons = plan.manualReview.map((m) => m.reason);
  for (const key of ['minecraft', 'loader', 'fabric', 'loom']) {
    assert.ok(
      reasons.some((r) => new RegExp(key, 'i').test(r)),
      `expected a manual-review item naming '${key}'; got ${JSON.stringify(reasons)}`,
    );
  }
});

test('the plan summary surfaces the version items in its manual-review list, not as edit rules', () => {
  const plan = planGradleMigration([
    { path: 'build.gradle', text: BUILD_GRADLE },
    { path: 'gradle.properties', text: GRADLE_PROPS },
  ]);
  const summary = summarizeGradlePlan(plan);

  // Placeholder rules are no longer counted as applied edits...
  for (const placeholderRule of ['plugin-version', 'props-minecraft-version', 'props-loader-version', 'props-fabric-api-version']) {
    assert.ok(
      !summary.byRule.some((r) => r.rule === placeholderRule),
      `'${placeholderRule}' must not appear as an applied edit rule; got ${JSON.stringify(summary.byRule)}`,
    );
  }
  // ...while the safe plugin-id rename still is.
  assert.ok(summary.byRule.some((r) => r.rule === 'plugin-id'), 'the plugin-id rename must still be a counted EXACT rule');
  // The dry-run/post-apply manual-review list carries the version guidance.
  assert.ok(summary.manualReview.length >= 5, `every version item must be in the manual-review list; got ${JSON.stringify(summary.manualReview)}`);
});
