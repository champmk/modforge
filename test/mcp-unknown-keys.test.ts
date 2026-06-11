/**
 * MCP argument-key validation (item P1-5, finding 22). Every tool's inputSchema
 * declares additionalProperties:false, but nothing enforced it at runtime — a
 * typo'd key ('descriptor' for 'desc', 'extraManifestUrls', a misspelled symbol
 * key inside a batch) was silently dropped and the call ran with defaults,
 * turning a known symbol into a false UNRESOLVED. The repo's own contract
 * (src/mcp/engine.ts) classifies garbage input as a tool FAILURE, never UNRESOLVED.
 *
 * assertKnownArgKeys is the schema-driven enforcer (the schema is the single
 * source of truth — no duplicated key lists). It throws ToolInputError, which the
 * server maps to the standard isError tool-result via toolFailureText. These are
 * in-process unit tests (no engine, no network), mirroring test/mcp-budget.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertKnownArgKeys, toolFailureText } from '../src/mcp/server.ts';

const RESOLVE_OK = {
  fromVersion: '1.21.11',
  toVersion: '26.1.2',
  namespace: 'named',
  kind: 'method',
  owner: 'net.minecraft.util.math.MathHelper',
  name: 'clamp',
  desc: '(III)I',
};

test('resolve_symbol: every declared key is accepted', () => {
  assert.doesNotThrow(() => assertKnownArgKeys('modforge_resolve_symbol', RESOLVE_OK));
  // minimal required-only shape (optional name/desc omitted) is fine too
  assert.doesNotThrow(() =>
    assertKnownArgKeys('modforge_resolve_symbol', {
      fromVersion: '1.21.11',
      toVersion: '26.1.2',
      namespace: 'source',
      kind: 'class',
      owner: 'a/b/C',
    }),
  );
});

test("resolve_symbol: the finding's exact typo 'descriptor' is rejected, not silently accepted", () => {
  const typo = {
    fromVersion: '1.21.11',
    toVersion: '26.1.2',
    namespace: 'named',
    kind: 'method',
    owner: 'net.minecraft.util.math.MathHelper',
    name: 'clamp',
    descriptor: '(III)I', // <- should be 'desc'
  };
  let thrown: unknown;
  assert.throws(
    () => assertKnownArgKeys('modforge_resolve_symbol', typo),
    (e: unknown) => {
      thrown = e;
      return e instanceof Error && /unknown key 'descriptor'/.test(e.message) && /desc/.test(e.message);
    },
    'a typo\'d key must fail loudly and name the valid key',
  );
  // It maps to the standard tool-failure text (→ isError:true on the wire).
  assert.match(toolFailureText(thrown), /^Invalid arguments: /, 'classified as a tool-input failure');
});

test('resolve_symbol: a close typo gets a did-you-mean', () => {
  const close = { fromVersion: '1.21.11', toVersion: '26.1.2', namespce: 'named', kind: 'class', owner: 'a/b/C' };
  assert.throws(
    () => assertKnownArgKeys('modforge_resolve_symbol', close),
    /unknown key 'namespce'.*did you mean 'namespace'\?/,
    'a 1-edit typo names the intended key',
  );
});

test('api_delta: extra top-level keys are rejected (the extraManifestUrls attack)', () => {
  assert.doesNotThrow(() => assertKnownArgKeys('modforge_api_delta', { fromVersion: '26.1.2', toVersion: '26.2-pre-5' }));
  assert.throws(
    () =>
      assertKnownArgKeys('modforge_api_delta', {
        fromVersion: '26.1.2',
        toVersion: '26.2-pre-5',
        extraManifestUrls: ['https://example/x.json'],
        totallyUnknownArg: 1,
      }),
    /unknown key 'extraManifestUrls'/,
  );
});

test('bridge_report: an unknown key INSIDE a symbols[] item is located and rejected', () => {
  const good = {
    fromVersion: '1.21.11',
    toVersion: '26.1.2',
    namespace: 'named',
    symbols: [{ kind: 'method', owner: 'a/b/C', name: 'clamp', desc: '(III)I' }],
    includeChains: true,
  };
  assert.doesNotThrow(() => assertKnownArgKeys('modforge_bridge_report', good));

  const batchTypo = {
    fromVersion: '1.21.11',
    toVersion: '26.1.2',
    namespace: 'named',
    symbols: [{ kind: 'method', owner: 'a/b/C', name: 'clamp', descriptor: '(III)I' }],
  };
  assert.throws(
    () => assertKnownArgKeys('modforge_bridge_report', batchTypo),
    /symbols\[0\]: unknown key 'descriptor'/,
    'the systematic-batch amplification path is closed and located per-item',
  );
});

test('check_mixin_target + versions: declared keys accepted, unknown rejected', () => {
  assert.doesNotThrow(() =>
    assertKnownArgKeys('modforge_check_mixin_target', {
      targetVersion: '26.1.2',
      mixinTargetClass: 'net.minecraft.client.Minecraft',
      memberInfo: 'tick()V',
    }),
  );
  assert.throws(
    () => assertKnownArgKeys('modforge_check_mixin_target', { targetVersion: '26.1.2', mixinClass: 'x' }),
    /unknown key 'mixinClass'/,
  );
  assert.doesNotThrow(() => assertKnownArgKeys('modforge_versions', {}));
  assert.throws(() => assertKnownArgKeys('modforge_versions', { foo: 1 }), /unknown key 'foo'/);
});

test('an unknown tool name is a no-op here (dispatcher already errors on it)', () => {
  assert.doesNotThrow(() => assertKnownArgKeys('modforge_not_a_tool', { anything: 1 }));
});
