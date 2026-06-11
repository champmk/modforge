/**
 * Truthful apply-summary atom (red-before-green) for findings 08 + 09.
 *
 * (b) A plan with a known pass-6 whole-file old-name-dangling refusal: the
 *     report finding must carry the verbatim reason as `skipReason`, that reason
 *     must surface in the rendered report, and summarizeApply must group it
 *     per file for the human output. (finding 09: EXACT withheld at planning is
 *     never surfaced anywhere.)
 * (c) Summary arithmetic on a small fixture: applied + (withheld/refused EXACT)
 *     + (CANDIDATE + UNRESOLVED) === total, and leftForReview === total − applied.
 *     (finding 08: "N findings left for review" was a phantom re-detection count.)
 *
 * Expectations are hand-derived from the fixture below; the pass-6 reason text
 * is produced by the real planner, never copied from engine output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planJavaPatches, type ResolvedJavaFinding } from '../src/patch/patch.ts';
import {
  annotateApply,
  makeFinding,
  makeReport,
  renderJson,
  renderTerminal,
  summarizeApply,
  type Finding,
} from '../src/report/report.ts';
import type { Resolution } from '../src/core/model.ts';

const META = {
  tool: 'modforge',
  version: '0.0.0-test',
  fromVersion: '1.21.11',
  toVersion: '26.1.2',
  namespace: 'named',
} as const;

const OLD = 'net/minecraft/entity/player/HungerManager';
const NEW = 'net/minecraft/world/food/FoodData';

const classExact = (from: string, to: string): Resolution => ({
  from: { kind: 'class', owner: from },
  confidence: 'EXACT',
  to: { kind: 'class', owner: to },
  reason: 'test: deterministic chain, class present in target',
  chain: ['test-hop'],
});

const candidate = (from: string): Resolution => ({
  from: { kind: 'class', owner: from },
  confidence: 'CANDIDATE',
  candidates: [{ to: { kind: 'class', owner: 'x/y/Maybe' }, score: 0.5, evidence: 'test' }],
  reason: 'test candidate',
  chain: [],
});

const unresolved = (from: string): Resolution => ({
  from: { kind: 'class', owner: from },
  confidence: 'UNRESOLVED',
  reason: 'test: no deterministic mapping',
  chain: [],
});

// ---------------------------------------------------------------------------
// (b) pass-6 whole-file refusal → skipReason on the report finding
// ---------------------------------------------------------------------------

// Imports HungerManager (simple name CHANGES to FoodData) and uses the simple
// name in the body. Only the IMPORT finding is supplied (a scanner blind spot
// on the body usage) — so pass 6 finds the body `HungerManager` uncovered and
// refuses the whole file: refusal over partial migration.
const SRC = [
  'package demo;',
  '',
  'import net.minecraft.entity.player.HungerManager;',
  '',
  'public class Demo {',
  '\tvoid tick() {',
  '\t\tHungerManager hm = lookup();',
  '\t}',
  '}',
  '',
].join('\n');

test('pass-6 whole-file refusal surfaces as a verbatim skipReason on the report finding', () => {
  // The report finding the CLI builds for the import reference.
  const reportFinding = makeFinding({ file: 'Demo.java', line: 3, col: 8, surface: 'import' }, classExact(OLD, NEW));

  // The planner input for that same finding, carrying the report id (as the CLI
  // wires it). The span covers the dotted name in the import declaration.
  const dotted = 'net.minecraft.entity.player.HungerManager';
  const start = SRC.indexOf(dotted);
  assert.notEqual(start, -1);
  const planInput: ResolvedJavaFinding = {
    file: 'Demo.java',
    line: 3,
    col: 8,
    kind: 'import',
    className: OLD,
    span: { start, end: start + dotted.length },
    id: reportFinding.id,
    resolution: classExact(OLD, NEW),
  };

  const plan = planJavaPatches(SRC, 'Demo.java', [planInput]);
  // The whole file is refused: no op emitted, the import finding is skipped.
  assert.equal(plan.ops.length, 0, 'pass 6 must refuse the whole file (no ops)');
  assert.equal(plan.skipped.length, 1);
  const skip = plan.skipped[0]!;
  assert.equal(skip.findingId, reportFinding.id, 'skip is keyed by the report finding id');
  assert.match(skip.reason, /refusal over partial migration/);
  assert.match(skip.reason, /HungerManager/);

  // Wire the planner skip onto the report finding the way the CLI does.
  annotateApply([reportFinding], new Map(), new Map([[skip.findingId, skip.reason]]));
  assert.equal(reportFinding.appliedFix, undefined, 'a refused finding has no applied fix');
  assert.equal(reportFinding.skipReason, skip.reason, 'the verbatim reason is attached as skipReason');

  // It renders on both the JSON wire surface and the terminal surface.
  const json = renderJson(makeReport(META, [reportFinding]));
  assert.match(json, /"skipReason":/, 'skipReason appears in the JSON wire schema');
  assert.match(json, /refusal over partial migration/, 'the reason text is rendered in JSON');
  const term = renderTerminal(makeReport(META, [reportFinding]));
  assert.match(term, /not applied: .*refusal over partial migration/, 'the reason renders on the terminal');

  // It is grouped for the human output, one line, reason verbatim.
  const review = summarizeApply([reportFinding]);
  assert.equal(review.applied, 0);
  assert.equal(review.leftForReview, 1);
  assert.equal(review.reviewByFile.length, 1);
  assert.equal(review.reviewByFile[0]!.file, 'Demo.java');
  assert.deepEqual(review.reviewByFile[0]!.items, [{ line: 3, reason: skip.reason }]);
});

// ---------------------------------------------------------------------------
// (c) summary arithmetic adds up
// ---------------------------------------------------------------------------

test('summarizeApply arithmetic: applied + withheld-EXACT + candidate + unresolved === total', () => {
  // 2 applied EXACT, 1 withheld EXACT, 1 CANDIDATE, 1 UNRESOLVED → total 5.
  const findings: Finding[] = [
    makeFinding({ file: 'A.java', line: 1, col: 1, surface: 'import' }, classExact('mod/One', 'real/One'), {
      file: 'A.java',
      before: 'One',
      after: 'Uno',
    }),
    makeFinding({ file: 'A.java', line: 2, col: 1, surface: 'import' }, classExact('mod/Two', 'real/Two'), {
      file: 'A.java',
      before: 'Two',
      after: 'Dos',
    }),
    makeFinding({ file: 'B.java', line: 5, col: 3, surface: 'import' }, classExact('mod/Three', 'real/Three')),
    makeFinding({ file: 'B.java', line: 9, col: 3, surface: 'type-use' }, candidate('mod/Four')),
    makeFinding({ file: 'C.java', line: 4, col: 2, surface: 'type-use' }, unresolved('mod/Five')),
  ];
  // The withheld EXACT (index 2) carries a skipReason; CANDIDATE/UNRESOLVED do not.
  findings[2]!.skipReason = "this file declares a type named 'Three' — rebinding that simple name is not provably safe";

  const review = summarizeApply(findings);

  assert.equal(review.applied, 2, 'two findings received an applied fix');
  assert.equal(review.leftForReview, 3, 'left-for-review is the real remainder (total − applied)');
  assert.equal(review.applied + review.leftForReview, findings.length, 'applied + leftForReview === total');

  // leftForReview decomposes exactly: withheld-EXACT + candidate + unresolved.
  const withheldExact = findings.filter((f) => f.resolution.confidence === 'EXACT' && f.appliedFix === undefined).length;
  const cand = findings.filter((f) => f.resolution.confidence === 'CANDIDATE').length;
  const unres = findings.filter((f) => f.resolution.confidence === 'UNRESOLVED').length;
  assert.equal(withheldExact + cand + unres, review.leftForReview, 'the remainder decomposes by confidence');
  assert.equal(review.applied + withheldExact + cand + unres, findings.length, 'every finding is accounted for once');

  // Only the withheld EXACT is surfaced for human review (1 file, 1 line).
  assert.equal(review.reviewByFile.length, 1);
  assert.equal(review.reviewByFile[0]!.file, 'B.java');
  assert.equal(review.reviewByFile[0]!.items.length, 1);
  assert.equal(review.reviewByFile[0]!.items[0]!.line, 5);
});
