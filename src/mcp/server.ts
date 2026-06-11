#!/usr/bin/env node
/**
 * ModForge MCP server — the agent-facing surface (stdio).
 *
 * Start:          node src/mcp/server.ts          (Node >= 24 — native type-stripping)
 * Help:           node src/mcp/server.ts --help
 * Claude Code:    claude mcp add modforge -- node <abs-path>/src/mcp/server.ts
 * Cursor/VSCode:  { "command": "node", "args": ["<abs-path>/src/mcp/server.ts"] }
 * Installed via npm, this file ships compiled (dist/mcp/server.js) behind the
 * `modforge-mcp` bin: `claude mcp add modforge -- modforge-mcp`.
 *
 * Protocol: MCP over stdio — newline-delimited JSON-RPC 2.0: one UTF-8 JSON
 * object per line, no embedded newlines, NO Content-Length framing (verified
 * against the current spec, modelcontextprotocol.io 2025-11-25: stdio messages
 * "are delimited by newlines, and MUST NOT contain embedded newlines").
 * Implemented dependency-free by decision: the subset this server needs
 * (initialize/initialized, ping, tools/list, tools/call) is small and stable
 * across protocol revisions, and zero runtime dependencies is a core ModForge
 * constraint (SPEC §7). stdout carries protocol frames ONLY; logs go to stderr.
 *
 * Five tools, every output carrying the honesty taxonomy
 * (EXACT / CANDIDATE / UNRESOLVED) in `structuredContent`:
 *   modforge_resolve_symbol     one old-era symbol → target version (full audit chain)
 *   modforge_bridge_report      batched resolutions + summary counts
 *   modforge_api_delta          exact surface diff between any two versions (capped lists)
 *   modforge_check_mixin_target mixin class/member grounded in the target jar
 *   modforge_versions           known versions + the era-boundary facts
 *
 * UNRESOLVED is a SUCCESSFUL result, never `isError`. `isError: true` is
 * reserved for genuine tool failures: invalid arguments, artifacts that provably
 * do not exist for the requested version, network/integrity failures.
 */
import { argv, exit, stdin, stdout, stderr } from 'node:process';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EngineInputError, ModForgeEngine } from './engine.ts';
import type { BridgeReport, SymbolQuery } from './engine.ts';
import type { SourceNamespace } from '../bridge/bridge.ts';
import type { ApiDelta, MemberChange, RenameCandidate } from '../delta/delta.ts';
import { ArtifactUnavailableError, FetchError } from '../mappings/fetch.ts';
import { toBinaryName } from '../core/model.ts';
import { suggest } from '../core/levenshtein.ts';

const SERVER_NAME = 'modforge-mcp';
const SERVER_VERSION = '0.1.1';

/** Protocol revisions this server speaks (the tools subset is identical in all). */
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

/**
 * Default per-list entry cap on delta output (token discipline; totals are
 * always complete). Small by default so an unfiltered quarterly delta cannot
 * flood the agent's context — callers opt into more via maxItemsPerList.
 */
export const DELTA_LIST_CAP = 25;
/** Max symbols per modforge_bridge_report call (chunk larger batches). */
const MAX_BATCH = 200;

const TAXONOMY_NOTE =
  'EXACT = every hop deterministic AND verified against the real target jar (safe to apply). ' +
  'CANDIDATE = grounded evidence with score/provenance — confirm before applying, never auto-apply. ' +
  'UNRESOLVED = honestly unknown; a successful answer, not an error — do NOT invent a name.';

const INSTRUCTIONS =
  `ModForge is a deterministic Minecraft-mod migration engine: it answers "what is this ` +
  `class/method/field called in version X" from real mappings and real jars instead of guesses. ` +
  `${TAXONOMY_NOTE} Old era = versions up to 1.21.11 (obfuscated; yarn 'named' and mojmap 'source' ` +
  `namespaces exist); new era = 26.1+ (unobfuscated; jar names ARE the source names). Crossing the ` +
  `boundary: modforge_resolve_symbol / modforge_bridge_report. Between two 26.x versions: ` +
  `modforge_api_delta. The first call touching a version (pair) downloads official artifacts ` +
  `(sha1-verified, ~10-30 s); everything after is served from cache.`;

const HELP = `${SERVER_NAME} ${SERVER_VERSION} — ModForge MCP server (stdio)

ModForge: deterministic cross-version migration engine for Minecraft mods.
This process speaks MCP (newline-delimited JSON-RPC 2.0) on stdin/stdout and is
meant to be launched by an MCP client, not used interactively.

Usage:
  node src/mcp/server.ts          start the server (stdio transport)
  node src/mcp/server.ts --help   this text

Register with an agent:
  Claude Code:  claude mcp add modforge -- node <abs-path>/src/mcp/server.ts
  Cursor (mcp.json) / VS Code:  { "command": "node", "args": ["<abs-path>/src/mcp/server.ts"] }

Tools (every output carries EXACT / CANDIDATE / UNRESOLVED + evidence):
  modforge_resolve_symbol      resolve one old-era symbol to a target version
  modforge_bridge_report       batched symbol resolutions + summary counts
  modforge_api_delta           exact API diff between any two game versions
  modforge_check_mixin_target  verify a mixin target against a target version's jar
  modforge_versions            known versions + era-boundary facts (1.21.11 / 26.1)

Artifacts (mappings, jars) are fetched from official sources on first use,
sha1-verified, and cached in ~/.modforge/cache. Nothing is redistributed.
`;

// ---------------------------------------------------------------------------
// Argument validation (precise messages — agents must be able to self-correct)
// ---------------------------------------------------------------------------

/** Invalid tool arguments — mapped to a tools/call result with isError: true. */
class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

type Args = Record<string, unknown>;

function reqStr(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ToolInputError(`'${key}' is required and must be a non-empty string`);
  }
  return v.trim();
}

function optStr(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new ToolInputError(`'${key}' must be a string when present`);
  return v;
}

function optBool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ToolInputError(`'${key}' must be a boolean when present`);
  return v;
}

function optPosInt(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new ToolInputError(`'${key}' must be a positive integer when present`);
  }
  return v;
}

function reqEnum<T extends string>(args: Args, key: string, allowed: readonly T[]): T {
  const v = args[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new ToolInputError(`'${key}' must be one of: ${allowed.join(', ')}`);
  }
  return v as T;
}

/** Validate one symbol object ({kind, owner, name?, desc?}) with located errors. */
function parseSymbolQuery(v: unknown, where: string): SymbolQuery {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ToolInputError(`${where}: expected an object {kind, owner, name?, desc?}`);
  }
  const o = v as Args;
  const kindRaw = o['kind'];
  if (kindRaw !== 'class' && kindRaw !== 'method' && kindRaw !== 'field') {
    throw new ToolInputError(`${where}: 'kind' must be one of: class, method, field`);
  }
  const owner = o['owner'];
  if (typeof owner !== 'string' || owner.trim() === '') {
    throw new ToolInputError(`${where}: 'owner' is required (class binary name 'a/b/C' or dotted 'a.b.C'; inner classes use '$')`);
  }
  const name = o['name'];
  const desc = o['desc'];
  if (name !== undefined && typeof name !== 'string') throw new ToolInputError(`${where}: 'name' must be a string`);
  if (desc !== undefined && typeof desc !== 'string') throw new ToolInputError(`${where}: 'desc' must be a string`);
  if (kindRaw === 'class') {
    if (name !== undefined || desc !== undefined) {
      throw new ToolInputError(`${where}: kind 'class' takes no 'name'/'desc' — put the class in 'owner'`);
    }
    return { kind: 'class', owner: owner.trim() };
  }
  if (name === undefined || name === '') {
    throw new ToolInputError(`${where}: 'name' is required for kind '${kindRaw}'`);
  }
  const q: SymbolQuery = { kind: kindRaw, owner: owner.trim(), name };
  if (desc !== undefined) q.desc = desc;
  return q;
}

// ---------------------------------------------------------------------------
// Delta shaping: caps with authoritative totals (token discipline)
// ---------------------------------------------------------------------------

interface CappedList<T> {
  /** Complete count BEFORE capping — always authoritative. */
  total: number;
  /** Count actually included in `items` after the cap. */
  returned: number;
  truncated: boolean;
  items: T[];
}

function capList<T>(list: readonly T[], cap: number): CappedList<T> {
  const items = list.slice(0, cap);
  return { total: list.length, returned: items.length, truncated: list.length > cap, items };
}

export function shapeDelta(d: ApiDelta, filterPrefix: string | undefined, cap: number): Record<string, unknown> {
  const p = filterPrefix;
  const kc = (n: string): boolean => p === undefined || n.startsWith(p);
  const km = (m: MemberChange): boolean => kc(m.owner);
  const kr = (c: RenameCandidate): boolean => kc(c.from.owner);
  const lists = {
    classesAdded: capList(d.classesAdded.filter(kc), cap),
    classesRemoved: capList(d.classesRemoved.filter(kc), cap),
    methodsAdded: capList(d.methodsAdded.filter(km), cap),
    methodsRemoved: capList(d.methodsRemoved.filter(km), cap),
    methodsDescChanged: capList(d.methodsDescChanged.filter(km), cap),
    fieldsAdded: capList(d.fieldsAdded.filter(km), cap),
    fieldsRemoved: capList(d.fieldsRemoved.filter(km), cap),
    fieldsDescChanged: capList(d.fieldsDescChanged.filter(km), cap),
    classRenameCandidates: capList(d.classRenameCandidates.filter(kr), cap),
    memberRenameCandidates: capList(d.memberRenameCandidates.filter(kr), cap),
  };
  const truncated = Object.values(lists).some((l) => l.truncated);
  return {
    fromVersion: d.fromId,
    toVersion: d.toId,
    filterPrefix: p ?? null,
    listCap: cap,
    truncated,
    note:
      `Each list is capped at ${cap} items by default (per-list 'total'/'returned'/'truncated' are ` +
      `authoritative). To see more of a truncated list, narrow with filterPrefix (e.g. ` +
      `'net/minecraft/world') and/or raise maxItemsPerList. added/removed/descChanged lists are EXACT ` +
      `surface facts; renameCandidates are CANDIDATE-grade structural evidence only — never auto-apply.`,
    ...lists,
  };
}

/**
 * Default bridge_report shaping: audit chains are the bulk of a large batch and
 * are rarely needed for an EXACT-heavy apply run, so every `chain` is dropped
 * unless the caller opts in (includeChains). Summary counts and per-resolution
 * reasons/candidate evidence — the actionable parts — are always kept. Returns a
 * new object; never mutates the engine's result.
 */
export function compactBridgeReport(report: BridgeReport): BridgeReport {
  return {
    ...report,
    resolutions: report.resolutions.map((r) => (r.chain.length === 0 ? r : { ...r, chain: [] })),
  };
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

const engine = new ModForgeEngine();

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Args) => Promise<unknown>;
}

const VERSION_PROPS = {
  fromVersion: {
    type: 'string',
    description: "Game version the symbol's names come from — must be old-era (<= 1.21.11), e.g. '1.21.11'",
  },
  toVersion: { type: 'string', description: "Target game version, e.g. '26.1.2'" },
  namespace: {
    type: 'string',
    enum: ['named', 'source'],
    description: "'named' = yarn names (Fabric mods); 'source' = mojmap names (NeoForge mods)",
  },
} as const;

const SYMBOL_PROPS = {
  kind: { type: 'string', enum: ['class', 'method', 'field'] },
  owner: {
    type: 'string',
    description: "Owning class — binary 'net/minecraft/world/entity/player/PlayerEntity' or dotted; inner classes use '$'. For kind 'class' this is the class itself.",
  },
  name: { type: 'string', description: "Member name (required for kind 'method'/'field'; omit for 'class')" },
  desc: {
    type: 'string',
    description: "JVM descriptor in the SAME namespace, e.g. '(Lnet/minecraft/util/Identifier;)V' — strongly recommended to disambiguate overloads",
  },
} as const;

const TOOLS: ToolDef[] = [
  {
    name: 'modforge_resolve_symbol',
    title: 'Resolve one Minecraft symbol across versions',
    description:
      'Deterministically resolve ONE old-era Minecraft symbol (class/method/field) to its name in a ' +
      'target game version, with the full audit chain of every mapping hop. Use this instead of ' +
      `guessing what a symbol is called after a version change. ${TAXONOMY_NOTE} ` +
      'fromVersion must be old-era (<= 1.21.11 — the bridge consumes its published mappings); for ' +
      '26.x -> 26.x questions use modforge_api_delta instead. Resolving MANY symbols (porting a whole ' +
      'file or mod)? Use modforge_bridge_report — it batch-resolves up to 200 symbols per call. ' +
      'First call per version pair downloads and parses official mappings/jars (~10-30 s); cached afterwards.',
    inputSchema: {
      type: 'object',
      properties: { ...VERSION_PROPS, ...SYMBOL_PROPS },
      required: ['fromVersion', 'toVersion', 'namespace', 'kind', 'owner'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const fromVersion = reqStr(args, 'fromVersion');
      const toVersion = reqStr(args, 'toVersion');
      const namespace = reqEnum<SourceNamespace>(args, 'namespace', ['named', 'source']);
      const query = parseSymbolQuery(args, 'arguments');
      const resolution = await engine.resolveSymbol(fromVersion, toVersion, namespace, query);
      return { fromVersion, toVersion, namespace, taxonomy: TAXONOMY_NOTE, resolution };
    },
  },
  {
    name: 'modforge_bridge_report',
    title: 'Batch-resolve Minecraft symbols across versions',
    description:
      `Batch form of modforge_resolve_symbol: resolve up to ${MAX_BATCH} old-era symbols against one ` +
      'target version in a single call (one shared bridge init), returning per-symbol resolutions ' +
      '(taxonomy + reasons) plus summary counts {exact, candidate, unresolved}. Prefer this over many ' +
      'single calls when porting a whole file or mod; for context-limited agents, ~50 symbols per call ' +
      'keeps responses small. Audit chains are omitted by default to stay within tool-output budgets — ' +
      'pass includeChains:true for the full per-hop audit trail. First call per version pair downloads ' +
      `and parses official mappings/jars (~10-30 s); cached afterwards. ${TAXONOMY_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...VERSION_PROPS,
        symbols: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BATCH,
          description: 'Symbols to resolve (all in the same namespace)',
          items: {
            type: 'object',
            properties: { ...SYMBOL_PROPS },
            required: ['kind', 'owner'],
            additionalProperties: false,
          },
        },
        includeChains: {
          type: 'boolean',
          description:
            'Include the full per-hop audit chain on every resolution (default false — chains are omitted to stay within tool-output budgets; summary counts, reasons, and candidate evidence are always present).',
        },
      },
      required: ['fromVersion', 'toVersion', 'namespace', 'symbols'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const fromVersion = reqStr(args, 'fromVersion');
      const toVersion = reqStr(args, 'toVersion');
      const namespace = reqEnum<SourceNamespace>(args, 'namespace', ['named', 'source']);
      const includeChains = optBool(args, 'includeChains') ?? false;
      const raw = args['symbols'];
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new ToolInputError(`'symbols' must be a non-empty array of {kind, owner, name?, desc?}`);
      }
      if (raw.length > MAX_BATCH) {
        throw new ToolInputError(`'symbols' has ${raw.length} entries — max ${MAX_BATCH} per call; split into chunks`);
      }
      const symbols = raw.map((v, i) => parseSymbolQuery(v, `symbols[${i}]`));
      const report = await engine.bridgeReport(fromVersion, toVersion, namespace, symbols);
      return includeChains ? report : compactBridgeReport(report);
    },
  },
  {
    name: 'modforge_api_delta',
    title: 'Exact API delta between two Minecraft versions',
    description:
      'Exact, deterministic API difference between two game versions — both jars parsed directly, so ' +
      'it works for ANY pair including 26.x -> 26.x where no mappings exist: classes/methods/fields ' +
      'added/removed/descriptor-changed (EXACT surface facts) plus labeled structural rename ' +
      'CANDIDATES (bijective matching with evidence + score; renames are structurally unprovable and ' +
      `are NEVER asserted as fact). Each list is capped at ${DELTA_LIST_CAP} entries by default with ` +
      "authoritative totals — narrow with filterPrefix (e.g. 'net/minecraft/world') when a list " +
      'truncates, and/or raise maxItemsPerList for a larger sample. First call per version downloads ' +
      'its client jar (~10-30 s); cached afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        fromVersion: { type: 'string', description: "Older version, e.g. '26.1.2'" },
        toVersion: { type: 'string', description: "Newer version, e.g. '26.2-pre-5'" },
        filterPrefix: {
          type: 'string',
          description: "Only report classes/owners under this binary-name prefix, e.g. 'net/minecraft' (dotted accepted)",
        },
        maxItemsPerList: {
          type: 'integer',
          minimum: 1,
          description: `Max entries returned per list (default ${DELTA_LIST_CAP}); raise to opt into a larger response. Each list's 'total' is always the authoritative full count.`,
        },
      },
      required: ['fromVersion', 'toVersion'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const fromVersion = reqStr(args, 'fromVersion');
      const toVersion = reqStr(args, 'toVersion');
      const rawPrefix = optStr(args, 'filterPrefix');
      const prefix = rawPrefix === undefined || rawPrefix === '' ? undefined : toBinaryName(rawPrefix.trim());
      const cap = optPosInt(args, 'maxItemsPerList') ?? DELTA_LIST_CAP;
      const delta = await engine.apiDelta(fromVersion, toVersion);
      return shapeDelta(delta, prefix, cap);
    },
  },
  {
    name: 'modforge_check_mixin_target',
    title: 'Verify a mixin target against a Minecraft version',
    description:
      "Ground a mixin target in a target game version's REAL jar: does the @Mixin target class exist, " +
      'and (optionally) does a member referenced by a Mixin MemberInfo string exist on it? memberInfo ' +
      "accepts Mixin's MemberInfo grammar: 'getDayTime()J', 'La/b/C;name(Largs;)V', 'field:LType;', " +
      "bare names ('tick'), and wildcards ('render*'). Returns a taxonomy resolution with descriptors " +
      'resolved from the jar and inherited-member/overload ambiguity surfaced honestly. NOTE: this is ' +
      'signature-level verification — an @At INVOKE/FIELD target additionally needs instruction-level ' +
      'verification before auto-applying. First call for a target version downloads and parses its ' +
      `client jar (~10-30 s); cached afterwards. ${TAXONOMY_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        targetVersion: { type: 'string', description: "Game version to verify against, e.g. '26.1.2'" },
        mixinTargetClass: {
          type: 'string',
          description: "The @Mixin target class in the TARGET version's namespace — binary or dotted; inner classes use '$'. Bridge old-era names with modforge_resolve_symbol first.",
        },
        memberInfo: {
          type: 'string',
          description: "Optional Mixin MemberInfo string for a member to verify (from method=, @At(target=...), or a @Shadow/@Accessor implied name)",
        },
      },
      required: ['targetVersion', 'mixinTargetClass'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const targetVersion = reqStr(args, 'targetVersion');
      const mixinTargetClass = reqStr(args, 'mixinTargetClass');
      const memberInfo = optStr(args, 'memberInfo');
      return engine.checkMixinTarget(targetVersion, mixinTargetClass, memberInfo);
    },
  },
  {
    name: 'modforge_versions',
    title: 'Known Minecraft versions + era boundary',
    description:
      'Known Minecraft versions from the official Mojang manifest (latest release, latest snapshot, ' +
      'recent list) plus the era-boundary facts ModForge is built around: 1.21.11 = last obfuscated ' +
      'version (last yarn mappings, last published mojmap); 26.1+ = unobfuscated era (jar names ARE ' +
      'the real source names; no mappings exist or are needed). Call this to pick valid ' +
      'fromVersion/toVersion values for the other tools.',
    inputSchema: { type: 'object', additionalProperties: false },
    handler: async () => engine.versions(),
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Wire shape for tools/list (handler stripped). */
function toolDescriptor(t: ToolDef): Record<string, unknown> {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema };
}

// ---------------------------------------------------------------------------
// Argument-key validation (enforce the schema's additionalProperties:false)
// ---------------------------------------------------------------------------
//
// Every tool's inputSchema declares additionalProperties:false, but most MCP
// hosts pass model-generated arguments through unvalidated — so the server is the
// only enforcement point. Without this, a typo'd key ('descriptor' for 'desc',
// 'extraManifestUrls', a misspelled key inside a batched symbols[] item) was
// silently dropped and the call ran with defaults, turning a known symbol into a
// false UNRESOLVED. The repo's own contract (engine.ts) classifies garbage input
// as a tool FAILURE, never UNRESOLVED. The schema is the single source of truth
// here — allowed keys are read straight off it, never duplicated.

/** Throw on the first key not in `allowed`, naming it (+ a did-you-mean / the valid keys). */
function rejectUnknownKeys(keys: Iterable<string>, allowed: readonly string[], where: string): void {
  const allowedSet = new Set(allowed);
  for (const k of keys) {
    if (allowedSet.has(k)) continue;
    const near = suggest(k, allowed);
    const hint = near !== undefined ? ` — did you mean '${near}'?` : '';
    throw new ToolInputError(`${where}: unknown key '${k}'${hint} (allowed: ${allowed.join(', ')})`);
  }
}

/**
 * Recursively enforce additionalProperties:false against a JSON-schema node:
 * reject undeclared keys on the object, then descend into declared object
 * properties and array-of-object items (so a nested item schema — e.g. each
 * bridge_report symbols[] entry — is enforced and located too).
 */
function assertKeysAgainstSchema(value: unknown, schema: Record<string, unknown>, where: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
  const props = (schema['properties'] as Record<string, unknown> | undefined) ?? {};
  if (schema['additionalProperties'] === false) {
    rejectUnknownKeys(Object.keys(value as Args), Object.keys(props), where);
  }
  for (const [key, sub] of Object.entries(props)) {
    if (typeof sub !== 'object' || sub === null) continue;
    const subSchema = sub as Record<string, unknown>;
    const child = (value as Args)[key];
    if (subSchema['type'] === 'object') {
      assertKeysAgainstSchema(child, subSchema, key);
    } else if (subSchema['type'] === 'array' && Array.isArray(child)) {
      const items = subSchema['items'];
      if (typeof items === 'object' && items !== null) {
        child.forEach((el, i) => assertKeysAgainstSchema(el, items as Record<string, unknown>, `${key}[${i}]`));
      }
    }
  }
}

/**
 * Reject any argument key not declared in the named tool's inputSchema (a
 * ToolInputError → the standard isError tool-result). A no-op for an unknown tool
 * name — the dispatcher already errors on that. Exported for direct unit testing.
 */
export function assertKnownArgKeys(toolName: string, args: Args): void {
  const tool = TOOL_BY_NAME.get(toolName);
  if (!tool) return;
  assertKeysAgainstSchema(args, tool.inputSchema, 'arguments');
}

/**
 * Map a tool failure to honest, actionable text. Only genuine failures land here
 * — UNRESOLVED resolutions are success payloads and never reach this path.
 */
export function toolFailureText(e: unknown): string {
  if (e instanceof ToolInputError || e instanceof EngineInputError) return `Invalid arguments: ${e.message}`;
  if (e instanceof ArtifactUnavailableError) {
    if (e.code === 'UNKNOWN_VERSION') {
      // The library message coaches toward extraManifestUrls — a FetchCache
      // constructor option with no equivalent on the MCP surface. Drop that
      // clause and name the tool that actually lists valid ids.
      const factual = e.message.replace(/\s*[^.]*extraManifestUrls[^.]*\.\s*/g, ' ').trim();
      return `[${e.code}] ${factual} Call modforge_versions to list valid version ids.`;
    }
    return `[${e.code}] ${e.message}`;
  }
  if (e instanceof FetchError) {
    return (
      `Fetch failed: ${e.message} — network or artifact-integrity failure (the message carries the ` +
      `exact URL/status). Nothing was guessed; safe to retry. First use of a version downloads ` +
      `official artifacts (sha1-verified) into ~/.modforge/cache.`
    );
  }
  return `Internal engine error (a ModForge bug, not an answer): ${e instanceof Error ? e.message : String(e)}`;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over newline-delimited stdio
// ---------------------------------------------------------------------------

type RequestId = string | number;

/** Write one frame. JSON.stringify never emits raw newlines (spec requirement). */
function send(msg: Record<string, unknown>): void {
  try {
    stdout.write(JSON.stringify(msg) + '\n');
  } catch {
    exit(0); // stdout gone (client died) — stdio shutdown semantics
  }
}

function replyResult(id: RequestId, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: RequestId | null, code: number, message: string, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error['data'] = data;
  send({ jsonrpc: '2.0', id, error });
}

function initializeResult(params: unknown): Record<string, unknown> {
  let requested: unknown;
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    requested = (params as Args)['protocolVersion'];
  }
  const protocolVersion =
    typeof requested === 'string' && (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)
      ? requested
      : LATEST_PROTOCOL; // spec: respond with the latest version we support
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: {
      name: SERVER_NAME,
      title: 'ModForge — deterministic Minecraft mod migration',
      version: SERVER_VERSION,
    },
    instructions: INSTRUCTIONS,
  };
}

async function handleToolCall(id: RequestId, params: unknown): Promise<void> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    replyError(id, -32602, 'tools/call requires params { name, arguments? }');
    return;
  }
  const p = params as Args;
  const name = p['name'];
  if (typeof name !== 'string') {
    replyError(id, -32602, "tools/call params must include a string 'name'");
    return;
  }
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    replyError(id, -32602, `Unknown tool: ${name}`);
    return;
  }
  const rawArgs = p['arguments'] ?? {};
  if (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs)) {
    replyError(id, -32602, "'arguments' must be an object");
    return;
  }
  try {
    assertKnownArgKeys(name, rawArgs as Args);
    const structured = await tool.handler(rawArgs as Args);
    replyResult(id, {
      // Spec: structured results SHOULD also carry the serialized JSON as text.
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured,
    });
  } catch (e) {
    // Tool-execution failure: actionable text the model can act on. UNRESOLVED
    // never lands here — it is a successful resolution payload.
    replyResult(id, { content: [{ type: 'text', text: toolFailureText(e) }], isError: true });
  }
}

let pending = 0;
let stdinEnded = false;

function maybeExit(): void {
  if (stdinEnded && pending === 0) exit(0);
}

async function handleRequest(id: RequestId, method: string, params: unknown): Promise<void> {
  pending++;
  try {
    switch (method) {
      case 'initialize':
        replyResult(id, initializeResult(params));
        break;
      case 'ping':
        replyResult(id, {});
        break;
      case 'tools/list':
        // 5 fixed tools — single page, no nextCursor (cursor params accepted, ignored).
        replyResult(id, { tools: TOOLS.map(toolDescriptor) });
        break;
      case 'tools/call':
        await handleToolCall(id, params);
        break;
      default:
        replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    replyError(id, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    pending--;
    maybeExit();
  }
}

/**
 * Normalize one raw stdin line before JSON parsing: strip a leading UTF-8 BOM
 * (U+FEFF) and a trailing CR. Windows PowerShell prepends a BOM to piped stdin,
 * which would otherwise fail JSON.parse on the very first message; CRLF clients
 * leave a trailing CR. Spawning MCP clients send neither — this is for the
 * hand-testing path. A legitimate JSON-RPC line never starts with U+FEFF.
 */
export function normalizeLine(line: string): string {
  let s = line;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  if (s.endsWith('\r')) s = s.slice(0, -1);
  return s;
}

function handleLine(line: string): void {
  const trimmed = normalizeLine(line);
  if (trimmed.trim() === '') return;
  let msg: unknown;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    replyError(null, -32700, 'Parse error: line is not valid JSON');
    return;
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    replyError(null, -32600, 'Invalid request: expected a JSON-RPC 2.0 object');
    return;
  }
  const m = msg as Args;
  const id = m['id'];
  const method = m['method'];
  if (typeof method !== 'string') {
    // No method: a response to a server-initiated request. This server sends
    // none, so nothing matches — ignore per JSON-RPC client-role rules.
    return;
  }
  if (id === undefined) {
    // Notification. initialized/cancelled need no action here: tools are stateless
    // and in-flight work cannot be aborted mid-download (results are discarded
    // client-side). Unknown notifications are ignored by spec.
    return;
  }
  if (typeof id !== 'string' && typeof id !== 'number') {
    replyError(null, -32600, 'Invalid request: id must be a string or number');
    return;
  }
  void handleRequest(id, method, m['params']);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** True only when this module is the process entry point (node src/mcp/server.ts
 *  or the modforge-mcp bin) — never when imported by a test or another module. */
function runningAsEntryPoint(): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function startServer(): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    stdout.write(HELP);
    exit(0);
  }

  stdin.setEncoding('utf8');
  let buffer = '';
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
  });
  // Graceful shutdown (spec): client closes stdin → finish in-flight work, exit 0.
  stdin.on('end', () => {
    stdinEnded = true;
    maybeExit();
  });
  stdin.on('close', () => {
    stdinEnded = true;
    maybeExit();
  });
  process.on('SIGINT', () => exit(0));
  process.on('SIGTERM', () => exit(0));

  stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready (stdio, newline-delimited JSON-RPC; protocol ${LATEST_PROTOCOL})\n`);
}

if (runningAsEntryPoint()) startServer();
