/**
 * Terminal closing block (finding 33): a real bridge run scrolls hundreds of
 * findings off the top of the terminal and ENDS on the last UNRESOLVED entry —
 * the summary and every next-step are gone to scrollback and nothing tells a
 * mid-port modder what to type next. renderTerminal must therefore END with a
 * tight closing block: a repeat of the one-line summary, a plain-language
 * next-step per non-empty bucket (CANDIDATE → UNRESOLVED → EXACT), and tool
 * tips (a shareable --out report; the --apply tip only while nothing's applied).
 *
 * Rendering-only: renderJson/renderMarkdown are untouched. Expectations are
 * hand-derived from the fixtures, never copied from renderer output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFinding, makeReport, renderTerminal } from '../src/report/report.ts';
import type { Resolution } from '../src/core/model.ts';

const META = {
  tool: 'modforge',
  version: '0.0.0-test',
  fromVersion: '1.21.11',
  toVersion: '26.1.2',
  namespace: 'named',
} as const;

const OUT_TIP = 'modforge: tip: --out report.md for a shareable report';

function exactRes(owner: string, toOwner: string): Resolution {
  return {
    from: { kind: 'class', owner },
    confidence: 'EXACT',
    to: { kind: 'class', owner: toOwner },
    reason: 'deterministic chain, class present in target',
    chain: ['hop'],
  };
}

function unresolvedRes(owner: string): Resolution {
  return {
    from: { kind: 'class', owner },
    confidence: 'UNRESOLVED',
    reason: 'no deterministic mapping and no candidate met the bar',
    chain: ['hop'],
  };
}

// One CANDIDATE *decision*; identical content at every call site collapses to a
// single unique decision in the rollup.
function candidateRes(): Resolution {
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
    chain: ['delta: DrawContext removed', 'rename: 1 bijective candidate'],
  };
}

/** The content lines of the closing block (drops the trailing '' from the final '\n'). */
function lastLines(out: string, n: number): string[] {
  const ls = out.split('\n');
  assert.equal(ls[ls.length - 1], '', 'terminal output ends with a trailing newline');
  return ls.slice(-(n + 1), -1);
}

test('terminal: a mixed report ENDS with the full closing block (last lines, not mere inclusion)', () => {
  // EXACT 2, CANDIDATE 2 findings but ONE unique decision, UNRESOLVED 3, total 7.
  const cand = candidateRes();
  const findings = [
    makeFinding({ file: 'A.java', line: 1, col: 1 }, exactRes('mod/Player', 'real/Player')),
    makeFinding({ file: 'A.java', line: 2, col: 1 }, exactRes('mod/Food', 'real/Food')),
    makeFinding({ file: 'B.java', line: 10, col: 4, surface: 'java-ref' }, cand),
    makeFinding({ file: 'C.java', line: 20, col: 8, surface: 'java-ref' }, cand),
    makeFinding({ file: 'D.java', line: 1, col: 1 }, unresolvedRes('mod/Y1')),
    makeFinding({ file: 'D.java', line: 2, col: 1 }, unresolvedRes('mod/Y2')),
    makeFinding({ file: 'D.java', line: 3, col: 1 }, unresolvedRes('mod/Y3')),
  ];
  const out = renderTerminal(makeReport(META, findings));

  assert.deepEqual(lastLines(out, 5), [
    'modforge: summary — EXACT 2 · CANDIDATE 2 (1 unique decision) · UNRESOLVED 3 · total 7',
    'modforge: 1 decision needs your judgment — the evidence is above',
    'modforge: 3 references need a manual port — each lists its precise reason',
    'modforge: 2 renames are deterministic and jar-verified — modforge bridge ... --apply writes them (originals backed up)',
    OUT_TIP,
  ]);
});

test('terminal: empty buckets drop their next-step line (zero CANDIDATE → no judgment line, no decision count)', () => {
  const findings = [
    makeFinding({ file: 'A.java', line: 1, col: 1 }, exactRes('mod/Player', 'real/Player')),
    makeFinding({ file: 'D.java', line: 1, col: 1 }, unresolvedRes('mod/Y1')),
  ];
  const out = renderTerminal(makeReport(META, findings));

  // 'the evidence is above' is unique to the CANDIDATE next-step line; the
  // bucket is empty, so that line must be absent.
  assert.ok(!out.includes('the evidence is above'), 'no CANDIDATE bucket → no judgment next-step line');
  // The unique-decision parenthetical rides only in the closing summary repeat;
  // assert on that line, not globally (the CANDIDATE group heading legitimately
  // carries its own "0 unique decisions" label).
  const summaryRepeat = out.split('\n').find((l) => l.startsWith('modforge: summary —'));
  assert.ok(summaryRepeat !== undefined, 'the closing summary repeat is present');
  assert.ok(!summaryRepeat.includes('unique decision'), 'no CANDIDATE bucket → no decision count in the repeat');
  assert.deepEqual(lastLines(out, 4), [
    'modforge: summary — EXACT 1 · CANDIDATE 0 · UNRESOLVED 1 · total 2',
    'modforge: 1 reference needs a manual port — each lists its precise reason',
    'modforge: 1 rename is deterministic and jar-verified — modforge bridge ... --apply writes them (originals backed up)',
    OUT_TIP,
  ]);
});

test('terminal: an applied-fix report omits the --apply tip (fixes are already written)', () => {
  const findings = [
    makeFinding(
      { file: 'A.java', line: 1, col: 1 },
      exactRes('mod/Player', 'real/Player'),
      { file: 'A.java', before: 'mod/Player', after: 'real/Player' },
    ),
    makeFinding({ file: 'D.java', line: 1, col: 1 }, unresolvedRes('mod/Y1')),
  ];
  const out = renderTerminal(makeReport(META, findings));

  assert.ok(out.includes('fix applied:'), 'a fix was actually applied in this report');
  assert.ok(!out.includes('--apply'), 'no --apply tip once a fix is applied');
  assert.ok(!out.includes('jar-verified'), 'the EXACT next-step line is suppressed after apply');
  assert.deepEqual(lastLines(out, 3), [
    'modforge: summary — EXACT 1 · CANDIDATE 0 · UNRESOLVED 1 · total 2',
    'modforge: 1 reference needs a manual port — each lists its precise reason',
    OUT_TIP,
  ]);
});

test('terminal: the closing block is deterministic under input reordering', () => {
  const cand = candidateRes();
  const a = makeFinding({ file: 'A.java', line: 1, col: 1 }, exactRes('mod/Player', 'real/Player'));
  const b = makeFinding({ file: 'B.java', line: 10, col: 4, surface: 'java-ref' }, cand);
  const c = makeFinding({ file: 'D.java', line: 1, col: 1 }, unresolvedRes('mod/Y1'));
  const forward = renderTerminal(makeReport(META, [a, b, c]));
  const shuffled = renderTerminal(makeReport(META, [c, a, b]));

  assert.equal(forward, shuffled, 'identical inputs render byte-identical output');
  assert.ok(forward.includes(OUT_TIP), 'the closing block is present');
});
