/**
 * MCP engine facade — lazy, cached wiring of the data layer + engine core for
 * long-lived surfaces (the MCP server today; a daemonized CLI tomorrow).
 *
 * Caching invariants:
 * - one parsed JarApi per game version,
 * - one EraBridge (with rename table + old-jar hierarchy) per (from, to) pair,
 * - one ApiDelta per ordered (from, to) pair,
 * all memoized as PROMISES (concurrent callers share a single init) and never
 * memoized on failure — a transient network error must not poison a pair forever.
 * First touch of a version pair downloads official artifacts (sha1-verified by
 * the data layer; ~10–30 s cold); every later call runs at in-process speed.
 *
 * Honesty contract (SPEC §5): every resolution this facade returns carries the
 * taxonomy (EXACT / CANDIDATE / UNRESOLVED + evidence + audit chain). When an
 * input is structurally invalid (e.g. a MemberInfo string outside the grammar),
 * EngineInputError is thrown — callers map that to a tool-input failure, NOT to
 * UNRESOLVED (UNRESOLVED means "the engine ran and the answer is honestly
 * unknown", never "you passed garbage").
 *
 * Determinism: no clock, no randomness; all lists stably ordered.
 */
import type { JarApi, Resolution, SymbolRef } from '../core/model.ts';
import { toBinaryName } from '../core/model.ts';
import { EraBridge } from '../bridge/bridge.ts';
import type { BridgeInputs, OldHierarchyEntry, SourceNamespace } from '../bridge/bridge.ts';
import { buildRenameTable, surfaceFromMojmap } from '../bridge/renames.ts';
import { computeDelta } from '../delta/delta.ts';
import type { ApiDelta } from '../delta/delta.ts';
import { extractJarApi } from '../jar/api.ts';
import { parseProguard } from '../mappings/proguard.ts';
import { parseTinyV2 } from '../mappings/tiny.ts';
import { ArtifactUnavailableError, FetchCache, MOJANG_MANIFEST_URL } from '../mappings/fetch.ts';
import { parseMemberInfo } from '../scan/mixin.ts';
import type { MemberInfoParse } from '../scan/mixin.ts';

/**
 * The caller supplied an argument that is structurally invalid (bad grammar,
 * missing required field). Distinct from UNRESOLVED: this never reaches the
 * engine logic, so it is a tool failure, not a resolution outcome.
 */
export class EngineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineInputError';
  }
}

/** One symbol to resolve through the Era Bridge (names in the mod's old namespace). */
export interface SymbolQuery {
  kind: 'class' | 'method' | 'field';
  /** Owning class — binary (`a/b/C`) or dotted (`a.b.C`); inner classes use `$`. */
  owner: string;
  /** Member name; required for kind 'method' | 'field' (callers validate). */
  name?: string;
  /** JVM descriptor in the same namespace, when known (disambiguates overloads). */
  desc?: string;
}

/** Batched bridge result: every resolution plus taxonomy counts. */
export interface BridgeReport {
  fromVersion: string;
  toVersion: string;
  namespace: SourceNamespace;
  summary: { total: number; exact: number; candidate: number; unresolved: number };
  resolutions: Resolution[];
}

/** Known-versions answer, including the era-boundary facts agents must not guess. */
export interface VersionsInfo {
  latestRelease: string;
  latestSnapshot: string;
  /** Total ids in the (merged) Mojang manifest. */
  knownVersions: number;
  /** Newest versions first (by releaseTime), capped by the caller's request. */
  recent: { id: string; type: string; releaseTime: string }[];
  eraBoundary: {
    lastObfuscated: string;
    firstUnobfuscatedRelease: string;
    explanation: string;
  };
  manifestSource: string;
}

/** Result of grounding one mixin target (class, optionally a member) in a target jar. */
export interface MixinTargetReport {
  targetVersion: string;
  /** Id of the jar the check ran against, e.g. `26.1.2-client`. */
  jarId: string;
  /** Echo of the parsed MemberInfo, when one was supplied. */
  memberInfo?: MemberInfoParse;
  resolution: Resolution;
}

/** Per-(from,to) bridge bundle. `namedUnavailable` set ⇒ yarn provably has no coverage. */
interface BridgeHandle {
  bridge: EraBridge;
  fromVersion: string;
  toVersion: string;
  /**
   * Set when yarn/intermediary deterministically do NOT exist for fromVersion
   * (ArtifactUnavailableError — e.g. 26.x, or pre-yarn versions). 'named'-namespace
   * queries then resolve UNRESOLVED with this exact reason. Network failures are
   * NOT recorded here — they fail the init loudly instead of silently degrading.
   */
  namedUnavailable?: string;
}

const ERA_LAST_OBFUSCATED = '1.21.11';
const ERA_FIRST_UNOBF_RELEASE = '26.1';
const ERA_EXPLANATION =
  `Minecraft removed obfuscation starting with 26.1 (first unobfuscated snapshot 2025-12-16; ` +
  `release 2026-03-24). ${ERA_LAST_OBFUSCATED} (2025-12-09) is the last obfuscated version — the last ` +
  `with yarn mappings and the last with published Mojang (ProGuard) mappings. Consequences: every ` +
  `pre-26.1 mod is binary-incompatible with 26.x; crossing the boundary needs the Era Bridge ` +
  `(modforge_resolve_symbol / modforge_bridge_report with an old fromVersion and a 26.x toVersion). ` +
  `Between two 26.x versions no mappings exist or are needed — the jar's names ARE the real source ` +
  `names; use modforge_api_delta. Namespace 'named' (yarn) and 'source' (mojmap) only exist for ` +
  `old-era versions.`;

/** How many wildcard/overload candidates a mixin check surfaces before capping. */
const MIXIN_CANDIDATE_CAP = 20;

/** total order on strings (avoids locale-dependent localeCompare — determinism). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `a.b.C` → `a/b/C`; names already containing '/' pass through untouched. */
function normalizeBinary(name: string): string {
  const t = name.trim();
  return t.includes('/') ? t : toBinaryName(t);
}

/**
 * Promise memo that never caches failures: a rejected init is evicted so the
 * next call retries (transient network errors must not poison a key forever).
 */
function memo<T>(map: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  const hit = map.get(key);
  if (hit) return hit;
  const p = make();
  map.set(key, p);
  p.catch(() => {
    if (map.get(key) === p) map.delete(key);
  });
  return p;
}

/** One found member of the target jar (used by the mixin grounding walk). */
interface FoundMember {
  owner: string;
  kind: 'method' | 'field';
  name: string;
  desc: string;
}

/** Members DECLARED on `owner` matching name predicate + kinds, stably sorted. */
function collectOnClass(
  api: JarApi,
  owner: string,
  kinds: readonly ('method' | 'field')[],
  match: (name: string) => boolean,
): FoundMember[] {
  const cls = api.classes.get(owner);
  if (!cls) return [];
  const out: FoundMember[] = [];
  for (const kind of kinds) {
    const list = kind === 'method' ? cls.methods : cls.fields;
    for (const m of list) if (match(m.name)) out.push({ owner, kind, name: m.name, desc: m.desc });
  }
  out.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.name, b.name) || cmp(a.desc, b.desc));
  return out;
}

/**
 * Deterministic BFS over a class's supertypes IN THE TARGET JAR (superclass
 * before interfaces per level; the owner itself excluded). Branches leave the
 * walk at classes outside the jar (JDK etc.) — those cannot be verified.
 */
function* walkSupers(api: JarApi, owner: string): Generator<string> {
  const seen = new Set<string>([owner]);
  const queue: string[] = [];
  const start = api.classes.get(owner);
  if (start) {
    if (start.superName) queue.push(start.superName);
    queue.push(...start.interfaces);
  }
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    yield cur;
    const cls = api.classes.get(cur);
    if (cls) {
      if (cls.superName) queue.push(cls.superName);
      queue.push(...cls.interfaces);
    }
  }
}

/** Mixin-style `*` wildcard → anchored RegExp ('*' = any run; all else literal). */
function wildcardMatcher(pattern: string): RegExp {
  const esc = pattern
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${esc}$`);
}

/**
 * The MCP-facing engine. Construct once per process; all methods are safe to
 * call concurrently (shared inits are memoized as promises).
 */
export class ModForgeEngine {
  private readonly cache: FetchCache;
  private readonly jarApis = new Map<string, Promise<JarApi>>();
  private readonly bridges = new Map<string, Promise<BridgeHandle>>();
  private readonly deltas = new Map<string, Promise<ApiDelta>>();

  constructor(opts: { cache?: FetchCache } = {}) {
    // MCP servers have no CLI flags, so MODFORGE_OFFLINE (any non-empty value)
    // is the only way an operator can pin this process to its warm cache.
    const env = process.env.MODFORGE_OFFLINE;
    this.cache = opts.cache ?? new FetchCache(env !== undefined && env !== '' ? { offline: true } : {});
  }

  /** Parsed client-jar API surface of one game version (downloaded + cached once). */
  getJarApi(version: string): Promise<JarApi> {
    return memo(this.jarApis, version, async () => {
      const jar = await this.cache.getClientJar(version);
      // Throwing mode: a desynced classfile parse must fail loudly, never feed
      // silently-wrong surface data into resolutions (ARCHITECTURE §5).
      return extractJarApi(jar.data, `${version}-client`).api;
    });
  }

  /** Latest versions + era-boundary facts. `recentCount` caps the listing. */
  async versions(recentCount = 15): Promise<VersionsInfo> {
    const manifest = await this.cache.resolveVersions();
    const all = [...manifest.byId.values()];
    // releaseTime is ISO-8601 from Mojang — lexicographic desc IS chronological desc.
    all.sort((a, b) => cmp(b.releaseTime, a.releaseTime) || cmp(a.id, b.id));
    return {
      latestRelease: manifest.latestRelease,
      latestSnapshot: manifest.latestSnapshot,
      knownVersions: all.length,
      recent: all.slice(0, recentCount).map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime })),
      eraBoundary: {
        lastObfuscated: ERA_LAST_OBFUSCATED,
        firstUnobfuscatedRelease: ERA_FIRST_UNOBF_RELEASE,
        explanation: ERA_EXPLANATION,
      },
      manifestSource: MOJANG_MANIFEST_URL,
    };
  }

  /** Resolve ONE old-era symbol across the boundary (full audit chain included). */
  async resolveSymbol(
    fromVersion: string,
    toVersion: string,
    namespace: SourceNamespace,
    query: SymbolQuery,
  ): Promise<Resolution> {
    const handle = await this.getBridgeHandle(fromVersion, toVersion);
    return resolveWithHandle(handle, namespace, query);
  }

  /** Batched resolveSymbol over one shared bridge init, with taxonomy counts. */
  async bridgeReport(
    fromVersion: string,
    toVersion: string,
    namespace: SourceNamespace,
    symbols: readonly SymbolQuery[],
  ): Promise<BridgeReport> {
    const handle = await this.getBridgeHandle(fromVersion, toVersion);
    const resolutions = symbols.map((s) => resolveWithHandle(handle, namespace, s));
    let exact = 0;
    let candidate = 0;
    let unresolved = 0;
    for (const r of resolutions) {
      if (r.confidence === 'EXACT') exact++;
      else if (r.confidence === 'CANDIDATE') candidate++;
      else unresolved++;
    }
    return {
      fromVersion,
      toVersion,
      namespace,
      summary: { total: resolutions.length, exact, candidate, unresolved },
      resolutions,
    };
  }

  /** Exact API delta between any two versions (both jars parsed; pair-cached). */
  apiDelta(fromVersion: string, toVersion: string): Promise<ApiDelta> {
    // '\n' cannot occur in version ids (path-unsafe chars are rejected upstream).
    return memo(this.deltas, `${fromVersion}\n${toVersion}`, async () => {
      const [from, to] = await Promise.all([this.getJarApi(fromVersion), this.getJarApi(toVersion)]);
      return computeDelta(from, to);
    });
  }

  /**
   * Ground a mixin target (class + optional MemberInfo string) against the
   * target version's real jar. Signature-level verification: class existence is
   * fully provable; member existence is provable at (name, descriptor) level.
   * @At INVOKE/FIELD targets additionally need instruction-level verification
   * before auto-applying (SPEC §4) — the reason text carries that caveat.
   * Throws EngineInputError when `memberInfo` is outside the MemberInfo grammar.
   */
  async checkMixinTarget(targetVersion: string, mixinTargetClass: string, memberInfo?: string): Promise<MixinTargetReport> {
    // Validate the cheap, pure inputs BEFORE the ~25MB jar download/parse, so
    // malformed arguments fail fast instead of paying for an artifact first.
    const cls = normalizeBinary(mixinTargetClass);
    let parsed: MemberInfoParse | undefined;
    if (memberInfo !== undefined) {
      parsed = parseMemberInfo(memberInfo);
      if (parsed.error !== undefined) {
        throw new EngineInputError(
          `memberInfo '${memberInfo}' does not match Mixin's MemberInfo grammar: ${parsed.error}. ` +
            `Valid forms: 'name', 'name(Largs;)V', 'La/b/C;name(Largs;)V', 'field:LType;', 'La/b/C;field:LType;'.`,
        );
      }
    }
    const api = await this.getJarApi(targetVersion);
    const resolution = groundMixinRef(api, cls, parsed);
    const report: MixinTargetReport = { targetVersion, jarId: api.id, resolution };
    if (parsed !== undefined) report.memberInfo = parsed;
    return report;
  }

  // ---------------------------------------------------------------- internal

  private getBridgeHandle(fromVersion: string, toVersion: string): Promise<BridgeHandle> {
    return memo(this.bridges, `${fromVersion}\n${toVersion}`, async () => {
      // Mojmap first and alone: for a new-era fromVersion this fails fast with the
      // precise NO_MOJANG_MAPPINGS reason BEFORE two ~25MB jar downloads start.
      const mappings = await this.cache.getClientMappings(fromVersion);
      const mojmap = parseProguard(mappings.data.toString('utf8'));

      const [target, oldApi] = await Promise.all([this.getJarApi(toVersion), this.getJarApi(fromVersion)]);

      // Old-jar hierarchy (obf binary names) → deterministic inherited-member walk.
      const oldHierarchy = new Map<string, OldHierarchyEntry>();
      for (const c of oldApi.classes.values()) {
        oldHierarchy.set(c.binaryName, { superName: c.superName, interfaces: c.interfaces });
      }

      const inputs: BridgeInputs = {
        mojmap,
        target,
        oldHierarchy,
        renames: buildRenameTable(surfaceFromMojmap(mojmap), target),
      };

      let namedUnavailable: string | undefined;
      try {
        const [yarn, intermediary] = await Promise.all([
          this.cache.getYarn(fromVersion),
          this.cache.getIntermediary(fromVersion),
        ]);
        inputs.yarn = parseTinyV2(yarn.tiny);
        inputs.intermediary = parseTinyV2(intermediary.tiny);
      } catch (e) {
        // Provable absence (old-era-only artifacts) degrades 'named' honestly;
        // an operational failure must fail the whole init loudly instead.
        if (e instanceof ArtifactUnavailableError) namedUnavailable = e.message;
        else throw e;
      }

      const handle: BridgeHandle = { bridge: new EraBridge(inputs), fromVersion, toVersion };
      if (namedUnavailable !== undefined) handle.namedUnavailable = namedUnavailable;
      return handle;
    });
  }
}

/** Run one query against a built bridge (sync — all indexes are in memory). */
function resolveWithHandle(handle: BridgeHandle, ns: SourceNamespace, q: SymbolQuery): Resolution {
  const owner = normalizeBinary(q.owner);
  if (ns === 'named' && handle.namedUnavailable !== undefined) {
    const from: SymbolRef = { kind: q.kind, owner };
    if (q.name !== undefined) from.name = q.name;
    if (q.desc !== undefined) from.desc = q.desc;
    return {
      from,
      confidence: 'UNRESOLVED',
      reason:
        `Namespace 'named' cannot be used for ${handle.fromVersion}: ${handle.namedUnavailable} ` +
        `If the mod is written against mojmap names, retry with namespace 'source'.`,
      chain: [],
    };
  }
  if (q.kind === 'class') return handle.bridge.resolveClass(ns, owner);
  if (q.name === undefined) {
    // Server-side validation prevents this; reaching here is a programming error.
    throw new Error(`internal: ${q.kind} query without a name reached the engine`);
  }
  return handle.bridge.resolveMember(ns, q.kind, owner, q.name, q.desc ?? null);
}

/** Caveat appended to member-level mixin EXACTs — signature-level scope, stated plainly. */
const AT_CAVEAT =
  ' Signature-level verification: if this is an @At INVOKE/FIELD target, instruction-level ' +
  'verification (the referenced instruction inside the resolved injection-site method) is ' +
  'additionally required before auto-applying — signature checks can pass while the instruction is gone.';

/** Ground a mixin class/member reference in the target jar (see checkMixinTarget). */
function groundMixinRef(api: JarApi, cls: string, parsed: MemberInfoParse | undefined): Resolution {
  const chain: string[] = [];

  // ----- class-only check -----
  if (parsed === undefined) {
    const from: SymbolRef = { kind: 'class', owner: cls };
    if (api.classes.has(cls)) {
      chain.push(`target(${api.id}): class present`);
      return {
        from,
        confidence: 'EXACT',
        to: { kind: 'class', owner: cls },
        reason: `Mixin target class exists in ${api.id}.`,
        chain,
      };
    }
    chain.push(`target(${api.id}): class ${cls} absent`);
    return {
      from,
      confidence: 'UNRESOLVED',
      reason:
        `Mixin target class ${cls} does not exist in ${api.id}. If this name comes from an old-era ` +
        `(≤${ERA_LAST_OBFUSCATED}) mod, bridge it first with modforge_resolve_symbol (kind 'class').`,
      chain,
    };
  }

  // Grammar invariants: no-error parse always has a name; kind 'method'/'field'
  // always carries a desc; kind 'unknown' (bare name) never does.
  const name = parsed.name;
  if (name === undefined) {
    throw new EngineInputError(`memberInfo '${parsed.raw}' parsed without a member name — cannot check.`);
  }
  const owner = parsed.owner ?? cls;
  if (parsed.owner !== undefined && parsed.owner !== cls) {
    chain.push(`memberInfo carries an explicit owner ${parsed.owner} — checked against it (enclosing @Mixin target: ${cls})`);
  }
  const kinds: readonly ('method' | 'field')[] =
    parsed.kind === 'method' ? ['method'] : parsed.kind === 'field' ? ['field'] : ['method', 'field'];
  const from: SymbolRef = { kind: parsed.kind === 'unknown' ? 'method' : parsed.kind, owner, name };
  if (parsed.desc !== undefined) from.desc = parsed.desc;
  if (parsed.kind === 'unknown') {
    chain.push(`bare-name selector: method vs field is undecidable from the string — both searched ('kind' shown as 'method' by convention)`);
  }

  if (!api.classes.has(owner)) {
    chain.push(`target(${api.id}): owner class ${owner} absent`);
    return {
      from,
      confidence: 'UNRESOLVED',
      reason:
        `Owner class ${owner} does not exist in ${api.id}, so the member cannot exist either. ` +
        `Bridge the class name first if it is old-era.`,
      chain,
    };
  }
  chain.push(`target(${api.id}): owner class ${owner} present`);

  // ----- wildcard selector: never a single exact symbol -----
  if (name.includes('*')) {
    const re = wildcardMatcher(name);
    // Wildcards select among members DECLARED on the target class (injector semantics).
    const matches = collectOnClass(api, owner, kinds, (n) => re.test(n));
    if (matches.length === 0) {
      return {
        from,
        confidence: 'UNRESOLVED',
        reason: `Wildcard selector '${name}' matches no ${kinds.join('/')} declared on ${owner} in ${api.id}.`,
        chain,
      };
    }
    const shown = matches.slice(0, MIXIN_CANDIDATE_CAP);
    chain.push(`wildcard '${name}' matched ${matches.length} declared member(s) on ${owner}`);
    return {
      from,
      confidence: 'CANDIDATE',
      candidates: shown.map((m) => ({
        to: { kind: m.kind, owner: m.owner, name: m.name, desc: m.desc },
        evidence: `Declared on ${m.owner} in ${api.id}; matches wildcard '${name}'.`,
        score: 0.5,
      })),
      reason:
        `Wildcard selector — matches ${matches.length} member(s); a wildcard is never a single exact ` +
        `symbol.${matches.length > MIXIN_CANDIDATE_CAP ? ` Candidate list capped at ${MIXIN_CANDIDATE_CAP}.` : ''}`,
      chain,
    };
  }

  // ----- exact (name, descriptor) check -----
  if (parsed.desc !== undefined && parsed.kind !== 'unknown') {
    const desc = parsed.desc;
    const onOwner = collectOnClass(api, owner, kinds, (n) => n === name).filter((m) => m.desc === desc);
    const first = onOwner[0];
    if (first !== undefined) {
      chain.push(`target(${api.id}): ${first.kind} ${name}${desc} declared on ${owner}`);
      return {
        from,
        confidence: 'EXACT',
        to: { kind: first.kind, owner, name, desc: first.desc },
        reason: `Member exists on ${owner} in ${api.id} with the exact name and descriptor.${AT_CAVEAT}`,
        chain,
      };
    }
    for (const sup of walkSupers(api, owner)) {
      const hit = collectOnClass(api, sup, kinds, (n) => n === name).filter((m) => m.desc === desc)[0];
      if (hit !== undefined) {
        chain.push(`target(${api.id}): found on supertype ${sup} (deterministic hierarchy walk)`);
        return {
          from,
          confidence: 'CANDIDATE',
          candidates: [
            {
              to: { kind: hit.kind, owner: sup, name, desc: hit.desc },
              evidence:
                `Not declared on ${owner} itself but on its supertype ${sup} with the identical descriptor. ` +
                `Valid for @Shadow/@Accessor/@Invoker and for @At owner-typed references; injector ` +
                `method= targets must be DECLARED on the mixin target class itself.`,
              score: 0.85,
            },
          ],
          reason: `Member is inherited, not declared on ${owner}.`,
          chain,
        };
      }
    }
    const near = collectOnClass(api, owner, kinds, (n) => n === name);
    const nearNote =
      near.length > 0
        ? ` The name exists on ${owner} with different descriptor(s): ${near.map((m) => m.desc).join(', ')} — the descriptor changed; verify which overload is intended.`
        : '';
    return {
      from,
      confidence: 'UNRESOLVED',
      reason: `No ${kinds.join('/')} ${name}${desc} on ${owner} or its supertypes in ${api.id}.${nearNote}`,
      chain,
    };
  }

  // ----- bare name (no descriptor): unique declaration resolves deterministically -----
  const onOwner = collectOnClass(api, owner, kinds, (n) => n === name);
  const sole = onOwner.length === 1 ? onOwner[0] : undefined;
  if (sole !== undefined) {
    chain.push(`target(${api.id}): single member named ${name} declared on ${owner} — ${sole.kind} ${sole.desc} (descriptor resolved from the jar)`);
    return {
      from: { kind: sole.kind, owner, name },
      confidence: 'EXACT',
      to: { kind: sole.kind, owner, name, desc: sole.desc },
      reason:
        `Exactly one member named ${name} is declared on ${owner} in ${api.id} — a bare-name selector ` +
        `resolves uniquely; descriptor ${sole.desc} resolved from the jar.${AT_CAVEAT}`,
      chain,
    };
  }
  if (onOwner.length > 1) {
    return {
      from,
      confidence: 'CANDIDATE',
      candidates: onOwner.slice(0, MIXIN_CANDIDATE_CAP).map((m) => ({
        to: { kind: m.kind, owner: m.owner, name: m.name, desc: m.desc },
        evidence: `One of ${onOwner.length} members named ${name} declared on ${owner} in ${api.id} — add a descriptor to disambiguate.`,
        score: 0.5,
      })),
      reason: `${onOwner.length} members named ${name} are declared on ${owner} — ambiguous without a descriptor.`,
      chain,
    };
  }
  for (const sup of walkSupers(api, owner)) {
    const hits = collectOnClass(api, sup, kinds, (n) => n === name);
    if (hits.length > 0) {
      chain.push(`target(${api.id}): ${name} not declared on ${owner}; found on supertype ${sup}`);
      const unique = hits.length === 1;
      return {
        from,
        confidence: 'CANDIDATE',
        candidates: hits.slice(0, MIXIN_CANDIDATE_CAP).map((m) => ({
          to: { kind: m.kind, owner: m.owner, name: m.name, desc: m.desc },
          evidence:
            `Declared on supertype ${sup} in ${api.id}${unique ? '' : ` (${hits.length} same-name members there)`}. ` +
            `Valid for @Shadow/@Accessor/@Invoker; injector method= targets must be declared on the target class itself.`,
          score: unique ? 0.7 : 0.4,
        })),
        reason: `Member is inherited from ${sup}, not declared on ${owner}.`,
        chain,
      };
    }
  }
  return {
    from,
    confidence: 'UNRESOLVED',
    reason: `No method or field named ${name} on ${owner} or its supertypes in ${api.id}.`,
    chain,
  };
}
