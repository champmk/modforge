/**
 * Color-decision contract: ANSI output is opt-in, never unconditional. The CLI
 * paints the terminal report only on an interactive TTY with NO_COLOR unset or
 * empty; `--no-color` forces it off everywhere. Encodes the NO_COLOR spec
 * (https://no-color.org): ANY non-empty value disables; an empty string does
 * NOT. The decision lives in a pure, unit-testable function so the CLI just
 * passes real process state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorEnabled, makeFinding, makeReport, renderTerminal } from '../src/report/report.ts';
import type { Resolution } from '../src/core/model.ts';

// The ESC byte that opens every ANSI sequence — defined by code point so it is
// unambiguous in source.
const ESC = String.fromCharCode(0x1b);

const META = {
  tool: 'modforge',
  version: '0.0.0-test',
  fromVersion: '1.21.11',
  toVersion: '26.1.2',
  namespace: 'named',
} as const;

test('TTY with no NO_COLOR env → color on', () => {
  assert.equal(colorEnabled(false, {}, true), true);
});

test('TTY with a non-empty NO_COLOR → color off (any non-empty value disables)', () => {
  assert.equal(colorEnabled(false, { NO_COLOR: '1' }, true), false);
  assert.equal(colorEnabled(false, { NO_COLOR: '0' }, true), false);
  assert.equal(colorEnabled(false, { NO_COLOR: 'false' }, true), false);
});

test('not a TTY → color off even with NO_COLOR unset', () => {
  assert.equal(colorEnabled(false, {}, false), false);
});

test('--no-color forces off regardless of TTY/env', () => {
  assert.equal(colorEnabled(true, {}, true), false);
  assert.equal(colorEnabled(true, { NO_COLOR: '' }, true), false);
  assert.equal(colorEnabled(true, { NO_COLOR: '1' }, false), false);
});

test('NO_COLOR="" (empty string) does NOT disable — color stays on with a TTY', () => {
  // https://no-color.org: presence with a non-empty value disables; empty does not.
  assert.equal(colorEnabled(false, { NO_COLOR: '' }, true), true);
});

test('renderTerminal with color:false emits no ESC bytes across every tier', () => {
  const exact: Resolution = {
    from: { kind: 'class', owner: 'mod/Player' },
    confidence: 'EXACT',
    to: { kind: 'class', owner: 'real/Player' },
    reason: 'Deterministic chain resolved and class exists in target.',
    chain: ['yarn: mod/Player → x', 'mojmap: x → real/Player', 'target: class present'],
  };
  const candidate: Resolution = {
    from: { kind: 'method', owner: 'mod/Food', name: 'eat', desc: '()V' },
    confidence: 'CANDIDATE',
    candidates: [
      { to: { kind: 'method', owner: 'real/Food', name: 'consume', desc: '()V' }, evidence: 'arity + descriptor match', score: 7 },
    ],
    reason: 'Renames are unprovable without obfuscation — best evidence offered.',
    chain: ['delta: eat removed', 'delta: consume added with matching descriptor'],
  };
  const unresolved: Resolution = {
    from: { kind: 'field', owner: 'mod/Thing', name: 'gone', desc: 'I' },
    confidence: 'UNRESOLVED',
    reason: 'Symbol not present in the target jar; no candidate met the bar.',
    chain: ['target: field absent'],
  };
  const findings = [
    makeFinding({ file: 'A.java', line: 1, col: 1, surface: 'import' }, exact),
    makeFinding({ file: 'B.java', line: 2, col: 3, surface: 'member-instance' }, candidate),
    makeFinding({ file: 'C.java', line: 4, col: 5, surface: 'java-ref' }, unresolved),
  ];
  const report = makeReport(META, findings);

  const plain = renderTerminal(report, { color: false });
  assert.ok(!plain.includes(ESC), 'plain render must contain no escape codes');

  // Sanity anchor: the colored render DOES contain escapes, so the assertion above is meaningful.
  const colored = renderTerminal(report, { color: true });
  assert.ok(colored.includes(ESC), 'colored render must contain escape codes (guards the test)');
});
