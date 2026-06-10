/**
 * MCP response-budget + polish (P1-15 / P2-4). Each test replays a confirmed
 * critic attack against the agent-facing surface and is hand-derived — never
 * copied from engine output.
 *
 *  - api_delta: a small DEFAULT per-list cap with authoritative truncation
 *    metadata, so an unfiltered quarterly delta can no longer ship a 405KB frame
 *    by default; full output stays reachable via maxItemsPerList.
 *  - bridge_report: audit chains (the bulk of a 200-symbol batch) are dropped by
 *    default; summary counts and per-resolution reasons are kept.
 *  - UTF-8 BOM on the first stdin line (Windows PowerShell pipe) is tolerated.
 *  - UNKNOWN_VERSION tool error names a real self-correction path
 *    (modforge_versions), never the library-only extraManifestUrls option.
 *  - check_mixin_target validates memberInfo grammar BEFORE touching the jar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeDelta,
  compactBridgeReport,
  toolFailureText,
  normalizeLine,
  DELTA_LIST_CAP,
} from '../src/mcp/server.ts';
import { ModForgeEngine, EngineInputError } from '../src/mcp/engine.ts';
import type { BridgeReport } from '../src/mcp/engine.ts';
import type { ApiDelta, MemberChange, RenameCandidate } from '../src/delta/delta.ts';
import type { Resolution } from '../src/core/model.ts';
import { ArtifactUnavailableError, FetchCache } from '../src/mappings/fetch.ts';

// ---------------------------------------------------------------------------
// Synthetic fixtures (hand-built; no real jars / no network)
// ---------------------------------------------------------------------------

const pad = (i: number): string => String(i).padStart(4, '0');

/** An ApiDelta whose every list holds exactly `n` synthetic entries. */
function bigDelta(n: number): ApiDelta {
  const classes = (tag: string): string[] =>
    Array.from({ length: n }, (_, i) => `net/minecraft/pkg/${tag}${pad(i)}`);
  const methods = (tag: string): MemberChange[] =>
    Array.from({ length: n }, (_, i) => ({
      owner: `net/minecraft/pkg/Owner${pad(i)}`,
      kind: 'method',
      name: `${tag}${i}`,
      desc: '()V',
    }));
  const fields = (tag: string): MemberChange[] =>
    Array.from({ length: n }, (_, i) => ({
      owner: `net/minecraft/pkg/Owner${pad(i)}`,
      kind: 'field',
      name: `${tag}${i}`,
      desc: 'I',
    }));
  const cands = (kind: 'class' | 'method', tag: string): RenameCandidate[] =>
    Array.from({ length: n }, (_, i) => ({
      kind,
      from: { owner: `net/minecraft/pkg/${tag}From${pad(i)}` },
      to: { owner: `net/minecraft/pkg/${tag}To${pad(i)}` },
      score: 0.8,
      evidence: 'synthetic structural evidence string padded to look realistic',
    }));
  return {
    fromId: '26.1.2-client',
    toId: '26.2-pre-5-client',
    classesAdded: classes('A'),
    classesRemoved: classes('R'),
    methodsAdded: methods('madd'),
    methodsRemoved: methods('mrem'),
    fieldsAdded: fields('fadd'),
    fieldsRemoved: fields('frem'),
    methodsDescChanged: methods('mdc'),
    fieldsDescChanged: fields('fdc'),
    classRenameCandidates: cands('class', 'c'),
    memberRenameCandidates: cands('method', 'm'),
  };
}

/** A BridgeReport with one resolution of each confidence, every chain non-empty. */
function syntheticReport(): BridgeReport {
  const mk = (confidence: Resolution['confidence']): Resolution => ({
    from: { kind: 'class', owner: 'a/b/C' },
    confidence,
    reason: `reason explaining the ${confidence} outcome`,
    chain: ['hop1', 'hop2', 'hop3', 'hop4'],
  });
  return {
    fromVersion: '1.21.11',
    toVersion: '26.1.2',
    namespace: 'named',
    summary: { total: 3, exact: 1, candidate: 1, unresolved: 1 },
    resolutions: [mk('EXACT'), mk('CANDIDATE'), mk('UNRESOLVED')],
  };
}

// ---------------------------------------------------------------------------
// Task 1 — api_delta default response budget
// ---------------------------------------------------------------------------

test('api_delta: small DEFAULT per-list cap with authoritative truncation metadata', () => {
  // The 405KB-by-default frame is prevented by a small default cap on every list.
  assert.ok(DELTA_LIST_CAP <= 25, `default delta list cap must be small; got ${DELTA_LIST_CAP}`);

  const n = 60;
  const out = shapeDelta(bigDelta(n), undefined, DELTA_LIST_CAP) as Record<string, any>;

  // Top-level truncation flag + a one-line hint that names the existing filters.
  assert.equal(out.truncated, true, 'top-level truncated flag set when any list is capped');
  assert.equal(out.listCap, DELTA_LIST_CAP, 'listCap echoes the cap actually applied');
  assert.match(String(out.note), /filterPrefix/, 'hint names filterPrefix');
  assert.match(String(out.note), /maxItemsPerList/, 'hint names maxItemsPerList');

  for (const key of [
    'classesAdded',
    'classesRemoved',
    'methodsAdded',
    'methodsRemoved',
    'fieldsAdded',
    'fieldsRemoved',
    'methodsDescChanged',
    'fieldsDescChanged',
    'classRenameCandidates',
    'memberRenameCandidates',
  ]) {
    const list = out[key];
    assert.equal(list.total, n, `${key}.total is the authoritative full count`);
    assert.equal(list.returned, DELTA_LIST_CAP, `${key}.returned is the post-cap count`);
    assert.equal(list.items.length, DELTA_LIST_CAP, `${key}.items capped`);
    assert.equal(list.truncated, true, `${key}.truncated`);
  }
});

test('api_delta: maxItemsPerList opt-in returns full lists untruncated', () => {
  const n = 60;
  const out = shapeDelta(bigDelta(n), undefined, 1000) as Record<string, any>;
  assert.equal(out.truncated, false, 'nothing truncated when the cap exceeds every list length');
  const ca = out.classesAdded;
  assert.equal(ca.total, n);
  assert.equal(ca.returned, n);
  assert.equal(ca.items.length, n);
  assert.equal(ca.truncated, false);
});

// ---------------------------------------------------------------------------
// Task 2 — bridge_report compaction (chains opt-in)
// ---------------------------------------------------------------------------

test('bridge_report: compact default drops audit chains, keeps counts and reasons', () => {
  const report = syntheticReport();
  const compact = compactBridgeReport(report);

  assert.equal(compact.resolutions.length, report.resolutions.length, 'same number of resolutions');
  assert.deepEqual(compact.summary, report.summary, 'summary counts preserved verbatim');
  for (const r of compact.resolutions) {
    assert.deepEqual(r.chain, [], 'audit chain dropped in the compact default');
    assert.ok(r.reason.length > 0, 'reason preserved');
  }
  // The opt-in (full) path returns the engine result untouched — chains intact.
  assert.equal(report.resolutions[0]!.chain.length, 4, 'source report not mutated by compaction');
});

// ---------------------------------------------------------------------------
// Task 3 — UTF-8 BOM tolerance on the first stdin line
// ---------------------------------------------------------------------------

test('normalizeLine: strips a leading UTF-8 BOM so a PowerShell-piped first message parses', () => {
  const json = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  assert.equal(normalizeLine('﻿' + json), json, 'leading BOM removed');
  assert.doesNotThrow(() => JSON.parse(normalizeLine('﻿' + json)), 'normalized line is valid JSON');
  assert.equal(normalizeLine(json + '\r'), json, 'trailing CR still handled (CRLF clients)');
  assert.equal(normalizeLine('﻿' + json + '\r'), json, 'BOM + CRLF together');
  assert.equal(normalizeLine(json), json, 'a clean line is untouched');
});

// ---------------------------------------------------------------------------
// Task 5 — UNKNOWN_VERSION error names only parameters that exist on the tool
// ---------------------------------------------------------------------------

test('UNKNOWN_VERSION tool error names modforge_versions, never extraManifestUrls', () => {
  const libraryMessage =
    "Version '1.21.99' is not in the Mojang version manifest (895 known; latest release 26.1.2, " +
    'latest snapshot 26.2-pre-6). Check the id, or supply an extraManifestUrls entry if it is an ' +
    'experimental build.';
  const text = toolFailureText(new ArtifactUnavailableError('UNKNOWN_VERSION', libraryMessage));

  assert.ok(!/extraManifestUrls/.test(text), `must not leak the library-only option: ${text}`);
  assert.match(text, /modforge_versions/, 'points the agent at the tool that lists valid ids');
  assert.match(text, /\[UNKNOWN_VERSION\]/, 'keeps the machine-readable code prefix');
  assert.match(text, /not in the Mojang version manifest/, 'keeps the factual core');
  assert.match(text, /latest release 26\.1\.2/, 'keeps the inline latest-version hints');
});

test('non-UNKNOWN_VERSION artifact errors pass through unchanged', () => {
  const text = toolFailureText(
    new ArtifactUnavailableError('NO_MOJANG_MAPPINGS', 'mojmap was never published for 26.1.2'),
  );
  assert.equal(text, '[NO_MOJANG_MAPPINGS] mojmap was never published for 26.1.2');
});

// ---------------------------------------------------------------------------
// Task 6 — check_mixin_target validates input before downloading the jar
// ---------------------------------------------------------------------------

test('check_mixin_target validates memberInfo grammar before fetching the target jar', async () => {
  const touched: string[] = [];
  const fakeCache = {
    getClientJar(id: string): Promise<never> {
      touched.push(id);
      return Promise.reject(new Error('JAR_DOWNLOAD_SHOULD_NOT_HAPPEN'));
    },
  } as unknown as FetchCache;
  const engine = new ModForgeEngine({ cache: fakeCache });

  await assert.rejects(
    () => engine.checkMixinTarget('26.1.2', 'net.minecraft.client.Minecraft', '((bad'),
    (e: unknown) =>
      e instanceof EngineInputError && /MemberInfo grammar/.test((e as Error).message),
    'malformed memberInfo fails fast with a grammar error',
  );
  assert.deepEqual(touched, [], 'the target jar must NOT be fetched before the grammar check');
});
