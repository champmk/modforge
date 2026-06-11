/**
 * Offline mode (item P1-10). Finding 13: with a fully warm cache, a network-down
 * run still dead-ends once the manifest's 1h TTL lapses, and the FetchError told
 * users to "pass { offline: true }" — an API field no CLI/MCP consumer can reach.
 * FetchCacheOptions.offline already serves verified cache entries only and never
 * touches the network; this wires it to a `--offline` flag and a MODFORGE_OFFLINE
 * env var, so a warm-cache user can opt out of every network hit.
 *
 * Coverage:
 *   - resolveOffline (pure): flag OR non-empty env enables it; neither overrides.
 *   - warm cache + --offline (env unset): the bridge runs identically, no network.
 *   - cold cache + --offline: a clean one-line exit-1 naming the missing artifact
 *     and saying offline mode blocked the fetch — never a hang or stack trace.
 *   - cold cache + MODFORGE_OFFLINE (no flag): the env var alone reaches offline.
 *
 * Expectations are hand-derived from the rule "flag OR non-empty env → offline".
 * The cold-cache cases are hermetic and portable: HOME/USERPROFILE is redirected
 * to an empty temp dir, so offline mode hits an empty cache with no network at all.
 * The warm-cache case is skipped when this machine's ~/.modforge/cache lacks the
 * 1.21.11 → 26.1.2 artifacts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolveOffline } from '../src/cli/flags.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

function run(args: string[], opts: SpawnSyncOptions = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['src/cli/main.ts', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    ...opts,
  });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

// ---------------------------------------------------------------------------
// resolveOffline — the pure flag/env decision (hand-derived from the OR rule)
// ---------------------------------------------------------------------------

test('resolveOffline: the --offline flag alone enables offline', () => {
  assert.equal(resolveOffline(true, undefined), true, 'flag set, env unset');
  assert.equal(resolveOffline(true, ''), true, 'flag set wins over an empty env');
});

test('resolveOffline: a non-empty MODFORGE_OFFLINE alone enables offline', () => {
  assert.equal(resolveOffline(undefined, '1'), true, 'env set, flag absent');
  assert.equal(resolveOffline(false, 'anything'), true, 'any non-empty value');
  assert.equal(resolveOffline(undefined, '0'), true, "even '0' is non-empty → offline (documented rule)");
});

test('resolveOffline: neither the flag nor a non-empty env → online', () => {
  assert.equal(resolveOffline(undefined, undefined), false, 'nothing set');
  assert.equal(resolveOffline(false, undefined), false, 'flag explicitly false');
  assert.equal(resolveOffline(undefined, ''), false, 'an empty env var is NOT offline');
});

test('resolveOffline: flag and env together still just enable it (neither overrides)', () => {
  assert.equal(resolveOffline(true, '1'), true);
  assert.equal(resolveOffline(true, ''), true);
});

// ---------------------------------------------------------------------------
// warm cache + --offline → the command runs identically, with no network
// ---------------------------------------------------------------------------

/** Files the 1.21.11 → 26.1.2 bridge needs served from cache, relative to the cache root. */
const WARM_ARTIFACTS = [
  ['version-json', '1.21.11', '1.21.11.json'],
  ['version-json', '26.1.2', '26.1.2.json'],
  ['jar', '1.21.11', 'client.jar'],
  ['jar', '26.1.2', 'client.jar'],
  ['mojmap', '1.21.11', 'client_mappings.txt'],
  ['yarn', '1.21.11', 'yarn-1.21.11+build.6-v2.jar'],
  ['intermediary', '1.21.11', 'intermediary-1.21.11-v2.jar'],
  ['manifest', 'mojang', 'version_manifest_v2.json'],
];

function cacheWarm(): boolean {
  const base = join(homedir(), '.modforge', 'cache');
  return WARM_ARTIFACTS.every((seg) => existsSync(join(base, ...seg)));
}

test(
  'integration: bridge --offline on a fully warm cache succeeds and touches no network',
  { skip: cacheWarm() ? false : 'home cache is not warm for 1.21.11 → 26.1.2' },
  () => {
    const src = mkdtempSync(join(tmpdir(), 'modforge-offline-src-'));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.MODFORGE_OFFLINE; // prove the FLAG alone enables offline (env not set)
      const r = run(['bridge', '--from', '1.21.11', '--to', '26.1.2', src, '--offline'], { env });

      assert.equal(r.status, 0, `warm-cache offline bridge must exit 0; stderr:\n${r.stderr}`);
      assert.match(r.stdout, /migration report — 1\.21\.11 → 26\.1\.2/, 'it produced the normal report');
      // Offline must never surface a network failure or a "stale cached copy" notice.
      assert.doesNotMatch(
        r.stderr + r.stdout,
        /failed:|ENOTFOUND|getaddrinfo|stale cached/i,
        'no network error or stale-cache notice when serving a warm cache offline',
      );
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// cold cache + offline → clean one-line exit 1 (portable: empty redirected home)
// ---------------------------------------------------------------------------

test('integration: --offline with a cold cache fails exit 1, naming the missing artifact and offline mode', () => {
  const home = mkdtempSync(join(tmpdir(), 'modforge-offline-home-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.MODFORGE_OFFLINE;
    const r = run(['versions', '--offline'], { env });

    assert.equal(r.status, 1, `offline + empty cache must exit 1; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /offline mode/i, 'the failure says offline mode blocked the fetch');
    assert.match(r.stderr, /version_manifest_v2\.json/, 'it names the missing artifact');
    assert.match(r.stderr, /not in the cache/i, 'it says the artifact is missing from the cache');
    // A clean one-liner for an expected failure — never a Node stack trace.
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack trace for an expected offline miss');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('integration: MODFORGE_OFFLINE (env var, no flag) also reaches offline mode', () => {
  const home = mkdtempSync(join(tmpdir(), 'modforge-offline-home-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, MODFORGE_OFFLINE: '1' };
    const r = run(['versions'], { env }); // NOTE: no --offline flag — the env var must carry it

    assert.equal(r.status, 1, `MODFORGE_OFFLINE=1 must enable offline (exit 1 on cold cache); stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /offline mode/i, 'the env var alone reached offline mode');
    assert.match(r.stderr, /not in the cache/i, 'same honest missing-artifact failure as the flag');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
