/**
 * Markdown renderer contract tests: the report is the product's public face,
 * so its presentation rules are load-bearing and tested like engine code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFinding, makeReport, renderMarkdown } from '../src/report/report.ts';
import type { Resolution } from '../src/core/model.ts';

const META = { tool: 'modforge', version: '0.0.0-test', fromVersion: '1.21.11', toVersion: '26.1.2', namespace: 'named' } as const;

function exactResolution(owner: string, toOwner: string): Resolution {
  return {
    from: { kind: 'class', owner },
    confidence: 'EXACT',
    to: { kind: 'class', owner: toOwner },
    reason: 'Deterministic chain resolved and class exists in target.',
    chain: [`yarn: ${owner} → x`, `mojmap: x → ${toOwner}`, 'target: class present'],
  };
}

test('identical chains collapse to one entry with a multiplier', () => {
  const r = exactResolution('mod/Player', 'real/Player');
  const findings = [
    makeFinding({ file: 'A.java', line: 1, col: 1, surface: 'import' }, r),
    makeFinding({ file: 'A.java', line: 9, col: 5, surface: 'type-use' }, r),
    makeFinding({ file: 'A.java', line: 12, col: 5, surface: 'type-use' }, r),
  ];
  const md = renderMarkdown(makeReport(META, findings));
  const chainBullets = md.split('\n').filter((l) => l.startsWith('- `'));
  assert.equal(chainBullets.length, 1, 'one unique resolution renders one chain');
  assert.match(chainBullets[0]!, /×3/);
  assert.match(md, /1 unique symbol across 3 findings/);
  // every occurrence still has its own table row
  assert.equal(md.split('\n').filter((l) => l.startsWith('| 1:1') || l.startsWith('| 9:5') || l.startsWith('| 12:5')).length, 3);
});

test('distinct chains stay distinct', () => {
  const findings = [
    makeFinding({ file: 'A.java', line: 1, col: 1, surface: 'import' }, exactResolution('mod/Player', 'real/Player')),
    makeFinding({ file: 'A.java', line: 2, col: 1, surface: 'import' }, exactResolution('mod/Food', 'real/Food')),
  ];
  const md = renderMarkdown(makeReport(META, findings));
  assert.equal(md.split('\n').filter((l) => l.startsWith('- `')).length, 2);
  assert.match(md, /Audit chains \(2 findings\)/);
});

test('the applied-fix column appears only when a fix was applied', () => {
  const r = exactResolution('mod/Player', 'real/Player');
  const without = renderMarkdown(makeReport(META, [makeFinding({ file: 'A.java', line: 1, col: 1 }, r)]));
  assert.ok(!without.includes('applied fix'), 'no fixes → no column');
  const withFix = renderMarkdown(
    makeReport(META, [makeFinding({ file: 'A.java', line: 1, col: 1 }, r, { file: 'A.java', before: 'old', after: 'new' })]),
  );
  assert.ok(withFix.includes('applied fix'), 'a fix → column present');
});

test('rendering is deterministic regardless of input order', () => {
  const a = makeFinding({ file: 'A.java', line: 1, col: 1 }, exactResolution('mod/Player', 'real/Player'));
  const b = makeFinding({ file: 'A.java', line: 2, col: 1 }, exactResolution('mod/Food', 'real/Food'));
  assert.equal(renderMarkdown(makeReport(META, [a, b])), renderMarkdown(makeReport(META, [b, a])));
});
