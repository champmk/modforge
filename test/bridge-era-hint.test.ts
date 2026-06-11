/**
 * The era-boundary decision for `bridge` failures (item P1-3).
 *
 * THE BUG being fixed: `bridge --from 26.1.2 --to 26.1.2` (both post-era) failed
 * with a did-you-mean that suggested the SAME command reversed — `bridge --from
 * 26.1.2 --to 26.1.2` — which fails identically. A circular hint instead of the
 * truth (post-era → post-era has no era to bridge; `modforge delta` is the tool).
 *
 * Unit expectations are hand-derived from the era classification rules; the lone
 * integration spawn replays the attack end-to-end and is gated on the version
 * metadata already being cached (no network in CI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { bridgeEraHint } from '../src/cli/bridge-era.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// A stand-in for the real data-layer NO_MOJANG_MAPPINGS reason. The helper must
// surface it verbatim and never mangle it.
const BASE = 'No client_mappings exist for X: unobfuscated era — nothing to map.';

test('both-post-era: names the boundary, points at delta, and emits NO reversed bridge hint', () => {
  // from and to are DIFFERENT post-era versions so the suggested delta direction
  // is observable (must be from → to, not reversed).
  const msg = bridgeEraHint({ from: '26.1', to: '26.1.2', dir: '/tmp/mod', baseMessage: BASE, fromEra: 'post', toEra: 'post' });
  assert.match(msg, /modforge delta --from 26\.1 --to 26\.1\.2/);
  // The circular-hint regression: must never suggest a bridge command...
  assert.doesNotMatch(msg, /Did you mean/);
  assert.doesNotMatch(msg, /bridge --from/);
  // ...and must name the era boundary as the reason.
  assert.match(msg, /post-era/);
  assert.match(msg, /boundary/);
  // One-line error (the reversed hint is the only multi-line message).
  assert.ok(!msg.includes('\n'), 'both-post message must be a single line');
});

test('the both-post repro itself (26.1.2 → 26.1.2) suggests delta, not the same command reversed', () => {
  const msg = bridgeEraHint({ from: '26.1.2', to: '26.1.2', dir: '/tmp/mod', baseMessage: BASE, fromEra: 'post', toEra: 'post' });
  assert.match(msg, /modforge delta --from 26\.1\.2 --to 26\.1\.2/);
  // The exact circular string the old code emitted must be gone.
  assert.ok(!msg.includes('bridge --from 26.1.2 --to 26.1.2'), 'must not echo the failing command back');
});

test('reversed era pair (from post, to pre): keeps the existing reversed-command hint, correctly oriented', () => {
  const msg = bridgeEraHint({ from: '26.1.2', to: '1.21.11', dir: '/tmp/mod', baseMessage: BASE, fromEra: 'post', toEra: 'pre' });
  // Surfaces the base reason...
  assert.ok(msg.startsWith(BASE));
  // ...then the reversed (runnable) suggestion: new FROM is the old-era version.
  assert.match(msg, /Did you mean:  modforge bridge --from 1\.21\.11 --to 26\.1\.2 \/tmp\/mod/);
  // Never points at delta for a genuinely reversed pair.
  assert.doesNotMatch(msg, /modforge delta/);
});

test('legit pre → post pair is NOT hijacked into delta and gets no provably-failing hint', () => {
  // This shape only reaches the helper hypothetically (a pre-era FROM succeeds at
  // the mappings fetch), but the decision must still be safe: do not claim
  // both-post, and do not suggest reversing into a post-era FROM that would fail.
  const msg = bridgeEraHint({ from: '1.21.11', to: '26.1.2', dir: '/tmp/mod', baseMessage: BASE, fromEra: 'pre', toEra: 'post' });
  assert.equal(msg, BASE);
  assert.doesNotMatch(msg, /modforge delta/);
  assert.doesNotMatch(msg, /Did you mean/);
});

test('unclassifiable TO falls back to current behavior (reversed hint, not provably failing)', () => {
  const msg = bridgeEraHint({ from: '26.1.2', to: 'mystery', dir: '/tmp/mod', baseMessage: BASE, fromEra: 'post', toEra: 'unknown' });
  assert.match(msg, /Did you mean:  modforge bridge --from mystery --to 26\.1\.2 \/tmp\/mod/);
});

test('TO post but FROM unclassifiable: suppress the provably-failing reversed hint', () => {
  const msg = bridgeEraHint({ from: 'mystery', to: '26.1.2', dir: '/tmp/mod', baseMessage: BASE, fromEra: 'unknown', toEra: 'post' });
  assert.equal(msg, BASE);
  assert.doesNotMatch(msg, /Did you mean/);
});

// --- integration: replay the attack against the real CLI -------------------
// Gated on the version metadata being cached so CI never depends on network.
test('integration: bridge --from 26.1.2 --to 26.1.2 prints the delta pointer, not a circular hint', (t) => {
  const cached = join(homedir(), '.modforge', 'cache', 'version-json', '26.1.2', '26.1.2.json');
  if (!existsSync(cached)) {
    t.skip('26.1.2 version JSON not cached — skipping network-dependent integration spawn');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'modforge-bridge-era-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'A.java'), 'import net.minecraft.world.entity.player.Player;\npublic class A { Player p; }\n');

  const r = spawnSync(process.execPath, ['src/cli/main.ts', 'bridge', '--from', '26.1.2', '--to', '26.1.2', dir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const err = r.stderr ?? '';
  if (!/unobfuscated/.test(err)) {
    t.skip(`era path not reached (likely a manifest refresh / network issue): ${err.slice(0, 200)}`);
    return;
  }
  assert.equal(r.status, 1, 'era-boundary failure exits 1');
  assert.match(err, /modforge delta --from 26\.1\.2 --to 26\.1\.2/);
  assert.doesNotMatch(err, /Did you mean/);
  assert.ok(!err.includes('bridge --from 26.1.2 --to 26.1.2'), 'must not suggest the same failing command');
});
