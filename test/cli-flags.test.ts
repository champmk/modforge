/**
 * CLI flag registry (item P1-5). A typo'd flag must NOT be silently ignored —
 * `bridge --namepsace source ...`, `gradle-migrate ... --aply`, `bridge --form ...`
 * used to run with defaults while the user believed the flag took effect. The
 * fix: a per-command known-flag registry whose unknown-flag check returns an
 * exit-2 usage message that names the offending flag and adds a did-you-mean when
 * a real flag is a small edit away.
 *
 * Unit expectations are hand-derived from the flag rules; the lone spawn replays
 * the attack end-to-end on the OFFLINE gradle-migrate path (no network), asserting
 * exit code 2 instead of the old silent dry-run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { levenshtein, suggest } from '../src/core/levenshtein.ts';
import { COMMAND_FLAGS, GLOBAL_FLAGS, knownFlagsFor, checkUnknownFlags } from '../src/cli/flags.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// levenshtein + nearest-suggestion (zero-dep, hand-derived distances)
// ---------------------------------------------------------------------------

test('levenshtein: hand-derived edit distances', () => {
  assert.equal(levenshtein('from', 'from'), 0, 'identical strings');
  assert.equal(levenshtein('', 'abc'), 3, 'empty vs 3 chars');
  assert.equal(levenshtein('abc', ''), 3, 'symmetric');
  assert.equal(levenshtein('aply', 'apply'), 1, 'one insertion');
  assert.equal(levenshtein('form', 'from'), 2, 'two transposed letters cost 2 in plain Levenshtein');
  assert.equal(levenshtein('namepsace', 'namespace'), 2, 'transposed p/s costs 2');
});

test('suggest: returns the nearest flag within a small edit distance, else undefined', () => {
  const flags = COMMAND_FLAGS['bridge']!;
  assert.equal(suggest('form', flags), 'from', 'distance-2 typo of from');
  assert.equal(suggest('namepsace', flags), 'namespace', 'distance-2 typo of namespace');
  assert.equal(suggest('aply', COMMAND_FLAGS['gradle-migrate']!), 'apply', 'distance-1 typo of apply');
  // A 2-char target must NOT match a 2-char flag at distance 2 (that is no signal).
  assert.equal(suggest('xy', ['to', 'from']), undefined, 'distance equals candidate length → not a suggestion');
  assert.equal(suggest('zzzzzzzz', flags), undefined, 'nothing close → no suggestion');
});

// ---------------------------------------------------------------------------
// the registry is truthful + complete
// ---------------------------------------------------------------------------

test('registry: the documented commands and their flags', () => {
  assert.deepEqual(COMMAND_FLAGS['bridge'], ['from', 'to', 'namespace', 'apply', 'json', 'out', 'no-color', 'offline']);
  assert.deepEqual(COMMAND_FLAGS['delta'], ['from', 'to', 'out', 'json', 'offline']);
  assert.deepEqual(COMMAND_FLAGS['gradle-migrate'], ['apply']);
  assert.deepEqual(COMMAND_FLAGS['mixin-check'], ['target', 'offline']);
  assert.deepEqual(COMMAND_FLAGS['versions'], ['offline']);
  // --offline (P1-10) is accepted exactly on the commands that build a FetchCache...
  for (const cmd of ['bridge', 'delta', 'mixin-check', 'versions']) {
    assert.ok(COMMAND_FLAGS[cmd]!.includes('offline'), `--offline must be a flag on ${cmd}`);
  }
  // ...and nowhere else: gradle-migrate never touches the network.
  assert.ok(!COMMAND_FLAGS['gradle-migrate']!.includes('offline'), 'gradle-migrate fetches nothing — no --offline');
});

test('every documented flag (and the global flags) is accepted on its command', () => {
  for (const [cmd, flags] of Object.entries(COMMAND_FLAGS)) {
    for (const f of [...flags, ...GLOBAL_FLAGS]) {
      assert.equal(checkUnknownFlags(cmd, [f]), null, `--${f} must be accepted on ${cmd}`);
    }
    // all at once, too
    assert.equal(checkUnknownFlags(cmd, [...flags, ...GLOBAL_FLAGS]), null, `${cmd}: full documented set accepted`);
  }
});

test('knownFlagsFor: command set ∪ globals, or null for an unregistered command', () => {
  assert.deepEqual(knownFlagsFor('gradle-migrate'), ['apply', ...GLOBAL_FLAGS]);
  assert.equal(knownFlagsFor('not-a-command'), null, 'unknown command has no registry (dispatcher handles it)');
});

// ---------------------------------------------------------------------------
// unknown flags → an exit-2 usage message that names the flag (+ did-you-mean)
// ---------------------------------------------------------------------------

test('a typo\'d flag is rejected with a did-you-mean', () => {
  const m1 = checkUnknownFlags('bridge', ['form']);
  assert.match(String(m1), /unknown flag --form/, 'names the offending flag');
  assert.match(String(m1), /did you mean --from\?/, 'suggests the nearest real flag');

  assert.match(String(checkUnknownFlags('bridge', ['namepsace'])), /did you mean --namespace\?/);
  assert.match(String(checkUnknownFlags('gradle-migrate', ['aply'])), /unknown flag --aply for 'gradle-migrate' — did you mean --apply\?/);
  // one line only
  assert.ok(!String(checkUnknownFlags('bridge', ['form'])).includes('\n'), 'usage message is a single line');
});

test('an unknown flag with no close match lists the valid flags instead', () => {
  const m = checkUnknownFlags('mixin-check', ['frobnicate']);
  assert.match(String(m), /unknown flag --frobnicate for 'mixin-check'/);
  assert.match(String(m), /valid flags: --target, --offline, --help/, 'names every accepted flag when no suggestion fits');
  assert.doesNotMatch(String(m), /did you mean/, 'no spurious suggestion for a far-off flag');
});

test('json/no-color are NOT blanket-global — only valid where the command reads them', () => {
  // delta renders without color; --no-color there is a silent no-op today (the bug).
  assert.match(String(checkUnknownFlags('delta', ['no-color'])), /unknown flag --no-color for 'delta'/);
  // versions reads no flags; --json there is a silent no-op today (the bug).
  assert.match(String(checkUnknownFlags('versions', ['json'])), /unknown flag --json for 'versions'/);
  // but they ARE accepted where real
  assert.equal(checkUnknownFlags('bridge', ['no-color']), null);
  assert.equal(checkUnknownFlags('bridge', ['json']), null);
  assert.equal(checkUnknownFlags('delta', ['json']), null);
});

test('unregistered/help/undefined paths are not flag-validated', () => {
  assert.equal(checkUnknownFlags('not-a-command', ['anything']), null, 'unknown command → dispatcher errors, not us');
  assert.equal(checkUnknownFlags('help', ['whatever']), null, 'help screen takes any flags');
  assert.equal(checkUnknownFlags('bridge', ['help']), null, '--help is a global flag');
});

// ---------------------------------------------------------------------------
// end-to-end: a typo'd flag exits 2 (the offline gradle-migrate path)
// ---------------------------------------------------------------------------

test('integration: gradle-migrate ... --aply exits 2 instead of a silent dry-run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modforge-flags-'));
  writeFileSync(join(dir, 'build.gradle'), "dependencies { minecraft 'com.mojang:minecraft:1.21.11' }\n");

  const r = spawnSync(process.execPath, ['src/cli/main.ts', 'gradle-migrate', dir, '--aply'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(r.status, 2, `a typo'd flag is a usage error (exit 2); stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr ?? '', /unknown flag --aply/, 'stderr names the flag');
  assert.match(r.stderr ?? '', /did you mean --apply\?/, 'stderr suggests --apply');
  assert.doesNotMatch(r.stdout ?? '', /dry run/, 'must NOT silently fall through to a dry run');
});
