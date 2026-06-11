/**
 * Source-namespace autodetect for `bridge` (item P1-4).
 *
 * THE BUG being fixed: a NeoForge / mojmap-source mod scanned with the default
 * `--namespace named` resolves ~0% — every yarn lookup misses a mojmap class — and
 * the user is handed thousands of UNRESOLVED with no hint that `--namespace source`
 * exists. The engine already supports both namespaces; this is pure routing.
 *
 * Unit expectations below are hand-derived from the threshold constants (a tree is
 * single-namespace, so a correctly-routed scan is overwhelmingly lopsided). The lone
 * integration spawn replays the attack end-to-end and is gated on the 1.21.11 → 26.1.2
 * artifacts already being cached, so CI never depends on the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  decideNamespace,
  probeNamespaces,
  sampleClassNames,
  MIN_SAMPLE,
  type SourceNamespace,
} from '../src/cli/bridge-namespace.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// --- decideNamespace: the pure core, hand-built counts -----------------------

test('lopsided source (mojmap tree) → autodetect source, loud overridable line', () => {
  const d = decideNamespace({ namedHits: 0, sourceHits: 185, sampled: 200 });
  assert.equal(d.namespace, 'source');
  assert.equal(d.autodetected, true);
  assert.ok(d.notice, 'an autodetect must announce itself');
  assert.match(d.notice!, /namespace autodetected: source \(mojmap names\)/);
  // exact N/M from the counts (hand-derived: 185 of 200 matched).
  assert.match(d.notice!, /185\/200 scanned classes matched/);
  // always names the override flag.
  assert.match(d.notice!, /pass --namespace named to override/);
});

test('lithium-shaped lopsidedness (a few cross-namespace coincidences) still flips to source', () => {
  // 6 named "hits" are the cross-namespace coincidences observed on the real mod;
  // sourceRate 0.925 >= 0.25 and 185 > 6, so the flip fires.
  const d = decideNamespace({ namedHits: 6, sourceHits: 185, sampled: 200 });
  assert.equal(d.namespace, 'source');
  assert.equal(d.autodetected, true);
  assert.match(d.notice!, /185\/200 scanned classes matched/);
});

test('lopsided named (Fabric tree) → keep default, stay silent', () => {
  const d = decideNamespace({ namedHits: 190, sourceHits: 2, sampled: 200 });
  assert.equal(d.namespace, 'named');
  assert.equal(d.autodetected, false);
  assert.equal(d.notice, null, 'a working default must not nag');
});

test('both namespaces map a lot (contested) → keep named but SAY SO with both counts', () => {
  // named wins on count (150 > 140) so no flip — but 140/200 also matching mojmap
  // is exactly the name-overlap territory where a silent default minted a wrong
  // EXACT certificate. Contested evidence must never be silent.
  const d = decideNamespace({ namedHits: 150, sourceHits: 140, sampled: 200 });
  assert.equal(d.namespace, 'named');
  assert.equal(d.autodetected, false);
  assert.ok(d.notice, 'contested evidence must not be silent');
  assert.match(d.notice!, /150\/200/);
  assert.match(d.notice!, /140\/200/);
  assert.match(d.notice!, /--namespace source/);
});

test('the misroute attack: source strictly out-maps named → flip, never silent-named', () => {
  // The confirmed P0 repro: a real mojmap/NeoForge tree where yarn↔mojmap name
  // overlap gave named 4/10 — the old rule kept named SILENTLY and --apply then
  // rewrote DedicatedServer to ServerInterface. source 10 > named 4 must flip.
  const d = decideNamespace({ namedHits: 4, sourceHits: 10, sampled: 10 });
  assert.equal(d.namespace, 'source');
  assert.equal(d.autodetected, true);
  assert.match(d.notice!, /10\/10 scanned classes matched/);
  assert.match(d.notice!, /4\/10 under named/);
});

test('an exact tie never flips — named kept, both counts shown', () => {
  const d = decideNamespace({ namedHits: 10, sourceHits: 10, sampled: 20 });
  assert.equal(d.namespace, 'named');
  assert.equal(d.autodetected, false);
  assert.ok(d.notice, 'a tie is contested evidence');
  assert.match(d.notice!, /--namespace source/);
});

test('ambiguous / both near zero → keep default, name BOTH flags', () => {
  const d = decideNamespace({ namedHits: 2, sourceHits: 3, sampled: 50 });
  assert.equal(d.namespace, 'named');
  assert.equal(d.autodetected, false);
  assert.ok(d.notice, 'ambiguity must hint, not silently mis-route');
  // names both namespaces / both ecosystems so a misrouted user can recover.
  assert.match(d.notice!, /--namespace source/);
  assert.match(d.notice!, /named/);
});

test('tiny sample, all source → too small to trust, keep default + hint', () => {
  // 2 mojmap classes is below MIN_SAMPLE: never flip the whole run on a handful.
  assert.ok(2 < MIN_SAMPLE);
  const d = decideNamespace({ namedHits: 0, sourceHits: 2, sampled: 2 });
  assert.equal(d.namespace, 'named');
  assert.equal(d.autodetected, false);
  assert.match(d.notice!, /--namespace source/);
});

test('source below the working floor never flips, even when it out-counts named', () => {
  // 2/200 source vs 0/200 named: source "wins" the count but maps nothing real —
  // WIN_FLOOR_RATE blocks a confident flip on a tree with no usable signal.
  const d = decideNamespace({ namedHits: 0, sourceHits: 2, sampled: 200 });
  assert.equal(d.namespace, 'named');
  assert.equal(d.autodetected, false);
  assert.match(d.notice!, /--namespace source/);
});

test('empty sample → quiet default, no namespace noise', () => {
  const d = decideNamespace({ namedHits: 0, sourceHits: 0, sampled: 0 });
  assert.equal(d.namespace, 'named');
  assert.equal(d.autodetected, false);
  assert.equal(d.notice, null);
});

test('deterministic: same counts always yield the same decision', () => {
  const input = { namedHits: 1, sourceHits: 188, sampled: 200 };
  assert.deepEqual(decideNamespace(input), decideNamespace(input));
});

// --- sampleClassNames + probeNamespaces: the deterministic glue ---------------

test('sampleClassNames dedupes, sorts, and caps', () => {
  assert.deepEqual(sampleClassNames(['b/C', 'a/A', 'a/A', 'c/D'], 2), ['a/A', 'b/C']);
  // cap defaults are honored; under cap returns all (sorted, distinct).
  assert.deepEqual(sampleClassNames(['x', 'x', 'x']), ['x']);
});

test('probeNamespaces counts hits per namespace via the injected resolver', () => {
  const names = ['M1', 'M2', 'M3', 'Y1'];
  // M* are "source" classes, Y1 is a "named" class — a perfectly split fake tree.
  const resolved = (ns: SourceNamespace, name: string): boolean =>
    ns === 'source' ? name.startsWith('M') : name.startsWith('Y');
  assert.deepEqual(probeNamespaces(names, resolved), { namedHits: 1, sourceHits: 3, sampled: 4 });
});

test('end-to-end pure pipeline: a mojmap-shaped fake tree autodetects source', () => {
  const names = sampleClassNames(['p/Player', 'p/Level', 'p/Entity', 'p/Item', 'p/Block']);
  const resolved = (ns: SourceNamespace): boolean => ns === 'source';
  const d = decideNamespace(probeNamespaces(names, resolved));
  assert.equal(d.namespace, 'source');
  assert.equal(d.autodetected, true);
  assert.match(d.notice!, /5\/5 scanned classes matched/);
});

// --- integration: replay the attack against the real CLI ---------------------
// Gated on the 1.21.11 → 26.1.2 artifacts being cached so CI never needs network.

function bridgeArtifactsCached(): boolean {
  const c = join(homedir(), '.modforge', 'cache');
  return (
    existsSync(join(c, 'mojmap', '1.21.11', 'client_mappings.txt')) &&
    existsSync(join(c, 'jar', '1.21.11', 'client.jar')) &&
    existsSync(join(c, 'jar', '26.1.2', 'client.jar')) &&
    existsSync(join(c, 'yarn', '1.21.11')) &&
    existsSync(join(c, 'intermediary', '1.21.11'))
  );
}

test('integration: default namespace on a mojmap tree autodetects source and resolves', (t) => {
  if (!bridgeArtifactsCached()) {
    t.skip('1.21.11 → 26.1.2 artifacts not cached — skipping network-dependent integration spawn');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'modforge-ns-'));
  mkdirSync(join(dir, 'src', 'com', 'kid'), { recursive: true });
  // 7 distinct mojmap (NeoForge) class names — comfortably above MIN_SAMPLE.
  writeFileSync(
    join(dir, 'src', 'com', 'kid', 'KidMod.java'),
    [
      'package com.kid;',
      'import net.minecraft.world.entity.player.Player;',
      'import net.minecraft.world.entity.LivingEntity;',
      'import net.minecraft.world.item.ItemStack;',
      'import net.minecraft.network.chat.Component;',
      'public class KidMod { Player p; LivingEntity e; ItemStack s; Component c; }',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'src', 'com', 'kid', 'KidWorld.java'),
    [
      'package com.kid;',
      'import net.minecraft.world.level.Level;',
      'import net.minecraft.core.BlockPos;',
      'import net.minecraft.world.entity.Entity;',
      'public class KidWorld { Level level; BlockPos pos; Entity entity; }',
      '',
    ].join('\n'),
  );

  // No --namespace flag: the documented quickstart command, default 'named'.
  const r = spawnSync(process.execPath, ['src/cli/main.ts', 'bridge', '--from', '1.21.11', '--to', '26.1.2', dir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const err = r.stderr ?? '';
  const out = r.stdout ?? '';
  if (!/engine ready/.test(err)) {
    t.skip(`engine not built (likely a manifest refresh / network issue): ${err.slice(0, 200)}`);
    return;
  }

  // 1. The loud, overridable autodetect line appears on stderr.
  assert.match(err, /namespace autodetected: source \(mojmap names\)/);
  assert.match(err, /pass --namespace named to override/);

  // 2. The report is NOT the ~100% UNRESOLVED wall the bug produced: it resolves a
  //    real majority. Parse the summary line and hand-check EXACT > UNRESOLVED.
  const m = out.match(/summary: EXACT (\d+) . CANDIDATE (\d+) . UNRESOLVED (\d+) . total (\d+)/);
  assert.ok(m, `expected a summary line, got:\n${out.slice(0, 400)}`);
  const [, exactStr, , unresolvedStr, totalStr] = m!;
  const exact = Number(exactStr);
  const unresolved = Number(unresolvedStr);
  const total = Number(totalStr);
  assert.ok(total > 0, 'fixture should produce findings');
  assert.ok(exact > 0, `expected EXACT > 0 after autodetect, summary: ${m![0]}`);
  assert.ok(exact > unresolved, `expected a resolved majority, not the UNRESOLVED wall: ${m![0]}`);
  // 3. The misleading "not in yarn mappings" refusal is gone (we left the yarn ns).
  assert.doesNotMatch(out, /is not in yarn mappings/);

  assert.equal(r.status, 0, 'a successful scan exits 0');
});

test('integration: an explicit --namespace is respected, no autodetect', (t) => {
  if (!bridgeArtifactsCached()) {
    t.skip('1.21.11 → 26.1.2 artifacts not cached — skipping network-dependent integration spawn');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'modforge-ns-explicit-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  // A mojmap tree, but the user explicitly asks for 'named' — we must obey, not
  // second-guess them into 'source'.
  writeFileSync(
    join(dir, 'src', 'A.java'),
    'import net.minecraft.world.entity.player.Player;\nimport net.minecraft.world.level.Level;\npublic class A { Player p; Level l; }\n',
  );
  const r = spawnSync(
    process.execPath,
    ['src/cli/main.ts', 'bridge', '--from', '1.21.11', '--to', '26.1.2', '--namespace', 'named', dir],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const err = r.stderr ?? '';
  if (!/engine ready/.test(err)) {
    t.skip(`engine not built (likely a manifest refresh / network issue): ${err.slice(0, 200)}`);
    return;
  }
  assert.doesNotMatch(err, /namespace autodetected/);
});
