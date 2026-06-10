#!/usr/bin/env node
/**
 * ModForge MCP server — the agent-facing surface (stdio).
 *
 * Start:          node src/mcp/server.ts          (Node >= 24 — native type-stripping)
 * Help:           node src/mcp/server.ts --help
 * Claude Code:    claude mcp add modforge -- node <abs-path>/src/mcp/server.ts
 * Cursor/VSCode:  { "command": "node", "args": ["<abs-path>/src/mcp/server.ts"] }
 * (Bin note: wire `"modforge-mcp": "./src/mcp/server.ts"` into package.json `bin`
 * when the package is published — the file is already shebanged and self-contained.)
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
import { EngineInputError, ModForgeEngine } from './engine.ts';
import type { SymbolQuery } from './engine.ts';
import type { SourceNamespace } from '../bridge/bridge.ts';
import type { ApiDelta, MemberChange, RenameCandidate } from '../delta/delta.ts';
import { ArtifactUnavailableError, FetchError } from '../mappings/fetch.ts';
import { toBinaryName } from '../core/model.ts';

const SERVER_NAME = 'modforge-mcp';
const SERVER_VERSION = '0.1.0';

/** Protocol revisions this server speaks (the tools subset is identical in all). */
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0];

/** Per-list entry cap on delta output (token discipline; totals are always complete). */
const DELTA_LIST_CAP = 100;
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
  truncated: boolean;
  items: T[];
}

function capList<T>(list: readonly T[]): CappedList<T> {
  return { total: list.length, truncated: list.length > DELTA_LIST_CAP, items: list.slice(0, DELTA_LIST_CAP) };
}

function shapeDelta(d: ApiDelta, filterPrefix: string | undefined): Record<string, unknown> {
  const p = filterPrefix;
  const kc = (n: string): boolean => p === undefined || n.startsWith(p);
  const km = (m: MemberChange): boolean => kc(m.owner);
  const kr = (c: RenameCandidate): boolean => kc(c.from.owner);
  return {
    fromVersion: d.fromId,
    toVersion: d.toId,
    filterPrefix: p ?? null,
    note:
      `Each list is capped at ${DELTA_LIST_CAP} items ('total'/'truncated' are authoritative; ` +
      `narrow with filterPrefix to see more). added/removed/descChanged lists are EXACT surface ` +
      `facts; renameCandidates are CANDIDATE-grade structural evidence only — never auto-apply.`,
    classesAdded: capList(d.classesAdded.filter(kc)),
    classesRemoved: capList(d.classesRemoved.filter(kc)),
    methodsAdded: capList(d.methodsAdded.filter(km)),
    methodsRemoved: capList(d.methodsRemoved.filter(km)),
    methodsDescChanged: capList(d.methodsDescChanged.filter(km)),
    fieldsAdded: capList(d.fieldsAdded.filter(km)),
    fieldsRemoved: capList(d.fieldsRemoved.filter(km)),
    fieldsDescChanged: capList(d.fieldsDescChanged.filter(km)),
    classRenameCandidates: capList(d.classRenameCandidates.filter(kr)),
    memberRenameCandidates: capList(d.memberRenameCandidates.filter(kr)),
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
      '26.x -> 26.x questions use modforge_api_delta instead. First call per version pair downloads ' +
      'and parses official mappings/jars (~10-30 s); cached afterwards.',
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
      '(taxonomy + audit chains) plus summary counts {exact, candidate, unresolved}. Prefer this over ' +
      `many single calls when porting a whole file or mod. ${TAXONOMY_NOTE}`,
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
      },
      required: ['fromVersion', 'toVersion', 'namespace', 'symbols'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const fromVersion = reqStr(args, 'fromVersion');
      const toVersion = reqStr(args, 'toVersion');
      const namespace = reqEnum<SourceNamespace>(args, 'namespace', ['named', 'source']);
      const raw = args['symbols'];
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new ToolInputError(`'symbols' must be a non-empty array of {kind, owner, name?, desc?}`);
      }
      if (raw.length > MAX_BATCH) {
        throw new ToolInputError(`'symbols' has ${raw.length} entries — max ${MAX_BATCH} per call; split into chunks`);
      }
      const symbols = raw.map((v, i) => parseSymbolQuery(v, `symbols[${i}]`));
      return engine.bridgeReport(fromVersion, toVersion, namespace, symbols);
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
      `are NEVER asserted as fact). Lists are capped at ${DELTA_LIST_CAP} entries each with authoritative ` +
      "totals — narrow with filterPrefix (e.g. 'net/minecraft/world') when a list truncates. " +
      'First call per version downloads its client jar (~10-30 s); cached afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        fromVersion: { type: 'string', description: "Older version, e.g. '26.1.2'" },
        toVersion: { type: 'string', description: "Newer version, e.g. '26.2-pre-5'" },
        filterPrefix: {
          type: 'string',
          description: "Only report classes/owners under this binary-name prefix, e.g. 'net/minecraft' (dotted accepted)",
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
      const delta = await engine.apiDelta(fromVersion, toVersion);
      return shapeDelta(delta, prefix);
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
      `verification before auto-applying. ${TAXONOMY_NOTE}`,
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

/**
 * Map a tool failure to honest, actionable text. Only genuine failures land here
 * — UNRESOLVED resolutions are success payloads and never reach this path.
 */
function toolFailureText(e: unknown): string {
  if (e instanceof ToolInputError || e instanceof EngineInputError) return `Invalid arguments: ${e.message}`;
  if (e instanceof ArtifactUnavailableError) return `[${e.code}] ${e.message}`;
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

function handleLine(line: string): void {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
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
