/**
 * CANDIDATE decision rollup (finding 47): one unique decision — the same
 * from-symbol resolved to the same candidate set — must render its evidence
 * block ONCE, followed by a compact list of every site, on both the terminal
 * and markdown surfaces. The section heading reports the real decision count
 * ("N findings, K unique decisions") so the reader is not tricked into thinking
 * one judgment call is many. This is a rendering change only: renderJson stays
 * byte-stable and keeps every finding (no dedup leaks into the wire schema), and
 * the EXACT/UNRESOLVED surfaces are untouched.
 *
 * Expectations are hand-derived from the fixtures below; nothing is copied from
 * renderer output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFinding, makeReport, renderTerminal, renderMarkdown, renderJson } from '../src/report/report.ts';
import type { Resolution } from '../src/core/model.ts';

const META = {
  tool: 'modforge',
  version: '0.0.0-test',
  fromVersion: '1.21.11',
  toVersion: '26.1.2',
  namespace: 'named',
} as const;

const occurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

// The AppleSkin headline decision: DrawContext (class) → GuiGraphicsExtractor,
// one ranked candidate, one evidence paragraph, one audit chain.
function drawContextDecision(): Resolution {
  return {
    from: { kind: 'class', owner: 'net/minecraft/client/gui/DrawContext' },
    confidence: 'CANDIDATE',
    candidates: [
      {
        to: { kind: 'class', owner: 'net/minecraft/client/gui/GuiGraphicsExtractor' },
        evidence: 'inner-class containment matched bijectively',
        score: 6,
      },
    ],
    reason: 'class removed at the boundary; one structural rename candidate — your judgment.',
    chain: ['delta: DrawContext removed', 'rename: 1 bijective candidate GuiGraphicsExtractor'],
  };
}

// A second, distinct decision (different from-symbol + different candidate set).
function foodDecision(): Resolution {
  return {
    from: { kind: 'method', owner: 'mod/Food', name: 'eat', desc: '()V' },
    confidence: 'CANDIDATE',
    candidates: [
      { to: { kind: 'method', owner: 'real/Food', name: 'consume', desc: '()V' }, evidence: 'arity + descriptor match', score: 7 },
    ],
    reason: 'renames are unprovable without obfuscation — best evidence offered.',
    chain: ['delta: eat removed', 'delta: consume added with matching descriptor'],
  };
}

test('terminal: one CANDIDATE decision at three sites renders evidence once and lists every site', () => {
  const r = drawContextDecision();
  const findings = [
    makeFinding({ file: 'A.java', line: 10, col: 4, surface: 'java-ref' }, r),
    makeFinding({ file: 'B.java', line: 20, col: 8, surface: 'java-ref' }, r),
    makeFinding({ file: 'C.java', line: 30, col: 2, surface: 'java-ref' }, r),
  ];
  const term = renderTerminal(makeReport(META, findings));

  assert.ok(term.includes('CANDIDATE (3 findings, 1 unique decision)'), 'heading carries the real decision count');
  assert.equal(occurrences(term, 'inner-class containment matched bijectively'), 1, 'evidence paragraph rendered once');
  assert.equal(occurrences(term, '→? net/minecraft/client/gui/GuiGraphicsExtractor'), 1, 'candidate target rendered once');
  assert.equal(occurrences(term, 'reason: class removed at the boundary'), 1, 'reason rendered once');
  assert.ok(
    term.includes('3 sites: A.java:10:4, B.java:20:8, C.java:30:2'),
    'every site listed compactly in finding order',
  );
});

test('markdown: one CANDIDATE decision renders evidence once and lists every site', () => {
  const r = drawContextDecision();
  const findings = [
    makeFinding({ file: 'A.java', line: 10, col: 4, surface: 'java-ref' }, r),
    makeFinding({ file: 'B.java', line: 20, col: 8, surface: 'java-ref' }, r),
    makeFinding({ file: 'C.java', line: 30, col: 2, surface: 'java-ref' }, r),
  ];
  const md = renderMarkdown(makeReport(META, findings));

  assert.ok(md.includes('## CANDIDATE (3 findings, 1 unique decision)'), 'heading carries the real decision count');
  assert.equal(occurrences(md, 'inner-class containment matched bijectively'), 1, 'evidence in exactly one row');
  assert.ok(
    md.includes('3 sites: A.java:10:4, B.java:20:8, C.java:30:2'),
    'every site listed compactly in finding order',
  );
});

test('terminal + markdown: two DISTINCT CANDIDATE decisions render two evidence blocks', () => {
  const findings = [
    makeFinding({ file: 'A.java', line: 1, col: 1, surface: 'java-ref' }, drawContextDecision()),
    makeFinding({ file: 'B.java', line: 2, col: 1, surface: 'java-ref' }, foodDecision()),
  ];

  const term = renderTerminal(makeReport(META, findings));
  assert.ok(term.includes('CANDIDATE (2 findings, 2 unique decisions)'), 'two findings, two unique decisions');
  assert.equal(occurrences(term, 'inner-class containment matched bijectively'), 1);
  assert.equal(occurrences(term, 'arity + descriptor match'), 1);
  assert.ok(term.includes('1 site: A.java:1:1'));
  assert.ok(term.includes('1 site: B.java:2:1'));

  const md = renderMarkdown(makeReport(META, findings));
  assert.ok(md.includes('## CANDIDATE (2 findings, 2 unique decisions)'));
  assert.equal(occurrences(md, 'inner-class containment matched bijectively'), 1);
  assert.equal(occurrences(md, 'arity + descriptor match'), 1);
});

test('renderJson preserves every CANDIDATE site — the rendering rollup never leaks into the wire schema', () => {
  const r = drawContextDecision();
  const findings = [
    makeFinding({ file: 'A.java', line: 10, col: 4, surface: 'java-ref' }, r),
    makeFinding({ file: 'B.java', line: 20, col: 8, surface: 'java-ref' }, r),
    makeFinding({ file: 'C.java', line: 30, col: 2, surface: 'java-ref' }, r),
  ];
  const report = makeReport(META, findings);
  const parsed = JSON.parse(renderJson(report)) as {
    schema: string;
    summary: { candidate: number };
    findings: { id: string; source: { file: string; line: number; col: number }; resolution: Resolution }[];
  };

  assert.equal(parsed.schema, 'modforge-report/1');
  assert.equal(parsed.summary.candidate, 3);
  assert.equal(parsed.findings.length, 3, 'all three sites present in JSON — never collapsed');
  assert.deepEqual(
    parsed.findings.map((f) => [f.source.file, f.source.line, f.source.col]),
    [['A.java', 10, 4], ['B.java', 20, 8], ['C.java', 30, 2]],
  );
  for (const f of parsed.findings) {
    assert.equal(f.resolution.confidence, 'CANDIDATE');
    assert.deepEqual(f.resolution.candidates, [
      {
        to: { kind: 'class', owner: 'net/minecraft/client/gui/GuiGraphicsExtractor' },
        score: 6,
        evidence: 'inner-class containment matched bijectively',
      },
    ]);
  }
  assert.equal(new Set(parsed.findings.map((f) => f.id)).size, 3, 'each site keeps its own content-derived id');
});

test('CANDIDATE rollup is deterministic under input reordering (terminal, markdown, json)', () => {
  const r1 = drawContextDecision();
  const r2 = foodDecision();
  const a = makeFinding({ file: 'A.java', line: 10, col: 4, surface: 'java-ref' }, r1);
  const b = makeFinding({ file: 'B.java', line: 20, col: 8, surface: 'java-ref' }, r1);
  const c = makeFinding({ file: 'C.java', line: 5, col: 1, surface: 'java-ref' }, r2);
  const forward = makeReport(META, [a, b, c]);
  const shuffled = makeReport(META, [c, a, b]);

  assert.equal(renderTerminal(forward), renderTerminal(shuffled), 'terminal stable under reordering');
  assert.equal(renderMarkdown(forward), renderMarkdown(shuffled), 'markdown stable under reordering');
  assert.equal(renderJson(forward), renderJson(shuffled), 'json stable under reordering');
});

test('terminal: the site list caps the inline entries and reports the remainder', () => {
  const r = drawContextDecision();
  // 14 sites of the same decision; the inline list is capped, the rest summarized.
  const findings = Array.from({ length: 14 }, (_, i) =>
    makeFinding({ file: `F${String(i).padStart(2, '0')}.java`, line: i + 1, col: 1, surface: 'java-ref' }, r),
  );
  const term = renderTerminal(makeReport(META, findings));

  assert.ok(term.includes('CANDIDATE (14 findings, 1 unique decision)'));
  assert.equal(occurrences(term, 'inner-class containment matched bijectively'), 1, 'evidence still rendered once');
  assert.ok(term.includes('14 sites:'), 'site count is the true total');
  assert.ok(term.includes('(+4 more)'), 'overflow beyond the inline cap is summarized');
  assert.ok(term.includes('F00.java:1:1'), 'first site is in the inline list');
  assert.ok(!term.includes('F13.java'), 'the 14th site is past the cap, not inline');
});

test('EXACT and UNRESOLVED keep the plain count heading — the decision rollup is CANDIDATE-only', () => {
  const exact: Resolution = {
    from: { kind: 'class', owner: 'mod/X' },
    confidence: 'EXACT',
    to: { kind: 'class', owner: 'real/X' },
    reason: 'deterministic chain, class present in target',
    chain: ['hop'],
  };
  const unresolved: Resolution = {
    from: { kind: 'class', owner: 'mod/Y' },
    confidence: 'UNRESOLVED',
    reason: 'no deterministic mapping and no candidate met the bar',
    chain: ['hop'],
  };
  const findings = [
    makeFinding({ file: 'A.java', line: 1, col: 1 }, exact),
    makeFinding({ file: 'A.java', line: 2, col: 1 }, unresolved),
  ];

  const md = renderMarkdown(makeReport(META, findings));
  assert.ok(md.includes('## EXACT (1)'), 'EXACT heading is a plain count');
  assert.ok(md.includes('## UNRESOLVED (1)'), 'UNRESOLVED heading is a plain count');
  assert.ok(!md.includes('EXACT (1 finding'), 'no decision rollup on EXACT');
  assert.ok(!md.includes('UNRESOLVED (1 finding'), 'no decision rollup on UNRESOLVED');

  const term = renderTerminal(makeReport(META, findings));
  assert.ok(term.includes('EXACT (1)'), 'EXACT terminal heading is a plain count');
  assert.ok(term.includes('UNRESOLVED (1)'), 'UNRESOLVED terminal heading is a plain count');
});
