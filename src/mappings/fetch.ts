/**
 * Data layer: version resolution, artifact download, sha1 verification, local cache.
 *
 * Sources (all official, fetched client-side at runtime — DECISIONS D7: Mojang
 * mappings are cached locally, never redistributed):
 *   - https://piston-meta.mojang.com/mc/game/version_manifest_v2.json (root of trust)
 *   - per-version JSON → downloads.{client,server,client_mappings,server_mappings},
 *     each pinned with sha1+size
 *   - https://meta.fabricmc.net/v2/versions/{yarn,intermediary}/<game>
 *   - https://maven.fabricmc.net (-v2 mapping jars, verified via maven .sha1 sidecars)
 *
 * Honesty contract of this layer:
 *   - Every artifact is hash-verified before use AND on every cache hit (a corrupted
 *     cache entry is treated as a miss, never served). Mismatch after download throws.
 *   - Era-boundary facts are detected from ground truth, not version-string heuristics:
 *     a version JSON without `client_mappings` IS mappingless; a game version with zero
 *     yarn builds in Fabric meta has no yarn; intermediary `0.0.0` IS the new-era stub
 *     (all three verified live 2026-06-09). Each raises ArtifactUnavailableError with a
 *     precise reason — the data-layer analog of UNRESOLVED. Never a guess.
 *   - Offline mode never touches the network; a miss offline is an explicit error.
 *     On network failure with a stale cached copy present, we fail and SAY a stale
 *     copy exists rather than silently serving it.
 *
 * Determinism: the only clock use is cache-TTL freshness (injectable via `now` —
 * never used in resolution logic); all listings and version picks are stably ordered.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { ZipReader } from '../jar/zip.ts';

/** Mojang's version manifest — the root of trust for everything piston-hosted. */
export const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FABRIC_MAVEN = 'https://maven.fabricmc.net';
const DEFAULT_TTL_MS = 60 * 60 * 1000; // manifest/meta freshness window (~1h)
const DEFAULT_TIMEOUT_MS = 30_000;
const DOWNLOAD_KEYS = ['client', 'server', 'client_mappings', 'server_mappings'] as const;

/** Network or integrity failure: the artifact exists but could not be obtained intact. */
export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FetchError';
  }
}

/** Reason codes for artifacts that deterministically do not exist / cannot be served. */
export type UnavailableCode =
  | 'UNKNOWN_VERSION' // version id not in the (merged) Mojang manifest
  | 'NO_SUCH_DOWNLOAD' // version JSON lacks the requested downloads key
  | 'NO_MOJANG_MAPPINGS' // unobfuscated era (26.1+) or pre-1.14.4 — mojmap was never published
  | 'OLD_ERA_ONLY' // yarn/intermediary requested for a version they do not cover
  | 'OFFLINE_NOT_CACHED'; // offline mode and the artifact is not (validly) cached

/**
 * The artifact provably does not exist or cannot be used — the data-layer analog of
 * an UNRESOLVED resolution: a precise machine-readable code plus a human reason.
 * This is an expected outcome, distinct from FetchError (an operational failure).
 */
export class ArtifactUnavailableError extends Error {
  readonly code: UnavailableCode;
  constructor(code: UnavailableCode, reason: string) {
    super(reason);
    this.name = 'ArtifactUnavailableError';
    this.code = code;
  }
}

/** One entry of the Mojang version manifest. */
export interface ManifestVersion {
  id: string;
  /** 'release' | 'snapshot' | 'old_beta' | 'old_alpha' (kept open: Mojang adds types). */
  type: string;
  /** URL of the per-version JSON; its content sha1 is pinned by `sha1`. */
  url: string;
  sha1: string;
  releaseTime: string;
}

/** Resolved version manifest with lookup by id. */
export interface VersionManifest {
  latestRelease: string;
  latestSnapshot: string;
  /** All versions (main manifest first; extra manifests never override an existing id). */
  byId: Map<string, ManifestVersion>;
  /** True when the manifest was served from a fresh cache without a network hit. */
  wasCache: boolean;
}

/** A sha1+size-pinned download from a version JSON. */
export interface DownloadInfo {
  sha1: string;
  size: number;
  url: string;
}

/** The subset of a Mojang per-version JSON this engine needs. */
export interface VersionJson {
  id: string;
  downloads: {
    client?: DownloadInfo;
    server?: DownloadInfo;
    /** Absent for 26.x (unobfuscated era) and for versions before 1.14.4. */
    client_mappings?: DownloadInfo;
    server_mappings?: DownloadInfo;
  };
  /** majorVersion >= 25 is a reliable unobfuscated-era marker (26.x ships Java 25). */
  javaVersion?: { component: string; majorVersion: number };
}

/** A parsed version JSON plus cache provenance. */
export interface VersionJsonResult {
  json: VersionJson;
  /** Absolute path of the cached JSON file. */
  path: string;
  wasCache: boolean;
}

/** A fetched artifact: bytes plus its cache location and provenance. */
export interface FetchResult {
  /** Absolute path of the cached file. */
  path: string;
  data: Buffer;
  /** True when served from a verified cache entry without any network I/O. */
  wasCache: boolean;
}

/** One yarn build from Fabric meta (`/v2/versions/yarn/<game>`). */
export interface FabricYarnEntry {
  gameVersion: string;
  build: number;
  /** Full maven version, e.g. `1.21.11+build.6`. */
  version: string;
  maven: string;
  stable: boolean;
}

/** One intermediary entry from Fabric meta (`/v2/versions/intermediary/<game>`). */
export interface FabricIntermediaryEntry {
  /** `0.0.0` is the new-era stub: loader does no remapping in 26.x (verified live). */
  version: string;
  maven: string;
  stable: boolean;
}

/** A tiny-v2 mapping artifact extracted from its maven jar. */
export interface TinyResult {
  /** UTF-8 contents of `mappings/mappings.tiny` (feed to parseTinyV2). */
  tiny: string;
  /** Exact maven version fetched, e.g. `1.21.11+build.6`. */
  version: string;
  /** Absolute path of the cached jar. */
  jarPath: string;
  wasCache: boolean;
}

/** One file in the local cache (layout: `<cacheDir>/<kind>/<version>/<filename>`). */
export interface CachedArtifact {
  kind: string;
  version: string;
  filename: string;
  path: string;
  size: number;
}

/** Configuration for FetchCache. All fields optional; defaults are production values. */
export interface FetchCacheOptions {
  /** Cache root. Default: `~/.modforge/cache`. */
  cacheDir?: string;
  /** Never touch the network; serve verified cache entries only. Default false. */
  offline?: boolean;
  /** Per-request timeout in milliseconds. Default 30s. */
  timeoutMs?: number;
  /** Freshness window for manifest/meta JSON. Default 1h. Pinned artifacts never expire. */
  ttlMs?: number;
  /**
   * Additional version-manifest URLs merged into resolveVersions() — e.g. the
   * experimental manifest carrying the `1.21.11_unobfuscated` calibration build.
   * The main manifest is authoritative on id conflicts.
   */
  extraManifestUrls?: string[];
  /** Clock injection (tests). The only time source in this module; TTL checks only. */
  now?: () => number;
}

/** sha1+size pin; size is unknown for version JSONs (the manifest pins only sha1). */
interface Pin {
  url: string;
  sha1: string;
  size?: number;
}

/**
 * Sha1-verified, offline-capable artifact cache over Mojang piston and Fabric maven/meta.
 * All getters return cached bytes when a verified copy exists, otherwise download,
 * verify, cache, and return — with `wasCache` provenance on every result.
 */
export class FetchCache {
  readonly cacheDir: string;
  private readonly offline: boolean;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly extraManifestUrls: readonly string[];
  private readonly now: () => number;
  /** Per-instance memo: one manifest resolve per process run (CLI-lifetime freshness). */
  private manifestMemo: VersionManifest | null = null;

  constructor(opts: FetchCacheOptions = {}) {
    this.cacheDir = opts.cacheDir ?? join(homedir(), '.modforge', 'cache');
    this.offline = opts.offline ?? false;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.extraManifestUrls = opts.extraManifestUrls ?? [];
    this.now = opts.now ?? Date.now;
  }

  // ------------------------------------------------------------------ Mojang

  /**
   * Fetch+cache the version manifest (TTL ~1h; stale cache served only offline).
   * Exposes latest release/snapshot and lookup by id, with extra manifests merged.
   */
  async resolveVersions(): Promise<VersionManifest> {
    if (this.manifestMemo) return this.manifestMemo;
    const main = await this.getMetaJson('manifest', 'mojang', 'version_manifest_v2.json', MOJANG_MANIFEST_URL);
    const parsed = parseManifest(main.data.toString('utf8'), MOJANG_MANIFEST_URL);
    if (parsed.latestRelease === undefined || parsed.latestSnapshot === undefined) {
      throw new FetchError(`manifest ${MOJANG_MANIFEST_URL}: missing 'latest.release'/'latest.snapshot'`);
    }
    const byId = new Map<string, ManifestVersion>();
    for (const v of parsed.versions) if (!byId.has(v.id)) byId.set(v.id, v);
    for (const url of this.extraManifestUrls) {
      const extra = await this.getMetaJson('manifest', 'extra', `${sha1hex(Buffer.from(url, 'utf8'))}.json`, url);
      for (const v of parseManifest(extra.data.toString('utf8'), url).versions) {
        if (!byId.has(v.id)) byId.set(v.id, v);
      }
    }
    this.manifestMemo = {
      latestRelease: parsed.latestRelease,
      latestSnapshot: parsed.latestSnapshot,
      byId,
      wasCache: main.wasCache,
    };
    return this.manifestMemo;
  }

  /** Fetch+cache the per-version JSON, sha1-verified against the manifest entry. */
  async getVersionJson(id: string): Promise<VersionJsonResult> {
    const manifest = await this.resolveVersions();
    const entry = manifest.byId.get(id);
    if (!entry) {
      throw new ArtifactUnavailableError(
        'UNKNOWN_VERSION',
        `Version '${id}' is not in the Mojang version manifest (${manifest.byId.size} known; ` +
          `latest release ${manifest.latestRelease}, latest snapshot ${manifest.latestSnapshot}). ` +
          `Check the id, or supply an extraManifestUrls entry if it is an experimental build.`,
      );
    }
    const r = await this.getPinned('version-json', id, `${id}.json`, { url: entry.url, sha1: entry.sha1 }, `version JSON for ${id}`);
    return { json: parseVersionJson(r.data.toString('utf8'), id), path: r.path, wasCache: r.wasCache };
  }

  /** Download (or serve cached) the client jar, sha1+size verified. */
  async getClientJar(id: string): Promise<FetchResult> {
    return this.getJarDownload(id, 'client');
  }

  /** Download (or serve cached) the server jar, sha1+size verified. */
  async getServerJar(id: string): Promise<FetchResult> {
    return this.getJarDownload(id, 'server');
  }

  /**
   * Download (or serve cached) the ProGuard client mappings (mojmap).
   * For versions without published mappings this raises NO_MOJANG_MAPPINGS with the
   * era-specific reason: 26.x is unobfuscated (jar names ARE source names — nothing
   * to map; bridge using the OLD version's mappings instead), while pre-1.14.4
   * versions are obfuscated but Mojang never published mappings for them.
   */
  async getClientMappings(id: string): Promise<FetchResult> {
    const { json } = await this.getVersionJson(id);
    const info = json.downloads.client_mappings;
    if (!info) {
      const jv = json.javaVersion?.majorVersion;
      const reason =
        jv !== undefined && jv >= 25
          ? `No client_mappings exist for ${id}: its official version JSON has no mappings ` +
            `download and it targets Java ${jv} — this is the unobfuscated era (26.1+, March 2026). ` +
            `The jar's class/member names ARE the real source names; there is nothing to map. ` +
            `Mojmap was last published for 1.21.11: fetch mappings for the OLD version and ` +
            `ground old-era symbols against this version's jar API (the Era Bridge chain).`
          : `No client_mappings exist for ${id}: Mojang published ProGuard mappings only from ` +
            `1.14.4 through 1.21.11, and this version's JSON has no mappings download.`;
      throw new ArtifactUnavailableError('NO_MOJANG_MAPPINGS', reason);
    }
    return this.getPinned('mojmap', id, 'client_mappings.txt', info, `client_mappings for ${id}`);
  }

  // ------------------------------------------------------------------ Fabric

  /**
   * List yarn builds for a game version, newest build first (stable order: build
   * desc, then version asc). Empty for 26.x — yarn ended at 1.21.11.
   */
  async getYarnVersions(game: string): Promise<FabricYarnEntry[]> {
    const r = await this.getMetaJson('fabric-meta', game, 'yarn.json', `${FABRIC_META}/versions/yarn/${encodeURIComponent(game)}`);
    const entries = parseYarnEntries(r.data.toString('utf8'), game);
    return entries.slice().sort((a, b) => b.build - a.build || cmp(a.version, b.version));
  }

  /**
   * Fetch the newest yarn build's `-v2.jar` for a game version and extract
   * `mappings/mappings.tiny` (header `tiny 2 0 intermediary named`).
   * 26.x raises OLD_ERA_ONLY: Fabric meta lists zero yarn builds there (verified).
   */
  async getYarn(gameVersion: string): Promise<TinyResult> {
    const versions = await this.getYarnVersions(gameVersion);
    const newest = versions[0];
    if (!newest) {
      throw new ArtifactUnavailableError(
        'OLD_ERA_ONLY',
        `No yarn mappings exist for '${gameVersion}': Fabric meta lists zero yarn builds. ` +
          `Yarn covers the old (obfuscated) era only and ended at 1.21.11 (Dec 2025); 26.x is ` +
          `unobfuscated and has no yarn. If '${gameVersion}' predates 26.x, check the id spelling.`,
      );
    }
    const v = encodeURIComponent(newest.version); // '+' must travel as %2B in maven paths
    return this.getMavenTiny('yarn', gameVersion, newest.version, `${FABRIC_MAVEN}/net/fabricmc/yarn/${v}/yarn-${v}-v2.jar`, `yarn-${newest.version}-v2.jar`);
  }

  /**
   * Fetch intermediary's `-v2.jar` for a game version and extract
   * `mappings/mappings.tiny` (header `tiny 2 0 official intermediary`).
   * 26.x raises OLD_ERA_ONLY: Fabric meta returns the `0.0.0` stub there — the
   * loader does no remapping in the unobfuscated era (verified live 2026-06-09).
   */
  async getIntermediary(gameVersion: string): Promise<TinyResult> {
    const r = await this.getMetaJson('fabric-meta', gameVersion, 'intermediary.json', `${FABRIC_META}/versions/intermediary/${encodeURIComponent(gameVersion)}`);
    const entries = parseIntermediaryEntries(r.data.toString('utf8'), gameVersion);
    const first = entries[0]; // meta returns exactly one entry per game version (verified)
    if (!first) {
      throw new ArtifactUnavailableError(
        'OLD_ERA_ONLY',
        `No intermediary mappings exist for '${gameVersion}': Fabric meta lists zero entries. ` +
          `Intermediary covers the old (obfuscated) era only, ending at 1.21.11.`,
      );
    }
    if (first.version === '0.0.0') {
      throw new ArtifactUnavailableError(
        'OLD_ERA_ONLY',
        `Intermediary for '${gameVersion}' is the 0.0.0 stub: ${gameVersion} is in the ` +
          `unobfuscated era (26.1+), where Fabric loader performs no remapping. Real ` +
          `intermediary ends at 1.21.11 — old-era symbols must be bridged, not remapped.`,
      );
    }
    const v = encodeURIComponent(first.version);
    return this.getMavenTiny('intermediary', gameVersion, first.version, `${FABRIC_MAVEN}/net/fabricmc/intermediary/${v}/intermediary-${v}-v2.jar`, `intermediary-${first.version}-v2.jar`);
  }

  // ------------------------------------------------------------------- cache

  /** Index of everything cached, stably sorted by (kind, version, filename). */
  listCached(): CachedArtifact[] {
    const out: CachedArtifact[] = [];
    for (const kind of listDirs(this.cacheDir)) {
      for (const version of listDirs(join(this.cacheDir, kind))) {
        const dir = join(this.cacheDir, kind, version);
        for (const filename of listFiles(dir)) {
          if (filename.endsWith('.tmp')) continue; // interrupted writes are not artifacts
          const path = join(dir, filename);
          out.push({ kind, version, filename, path, size: statSync(path).size });
        }
      }
    }
    out.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.version, b.version) || cmp(a.filename, b.filename));
    return out;
  }

  // ---------------------------------------------------------------- internal

  private async getJarDownload(id: string, key: 'client' | 'server'): Promise<FetchResult> {
    const { json } = await this.getVersionJson(id);
    const info = json.downloads[key];
    if (!info) {
      throw new ArtifactUnavailableError('NO_SUCH_DOWNLOAD', `Version JSON for ${id} has no '${key}' download entry.`);
    }
    return this.getPinned('jar', id, `${key}.jar`, info, `${key}.jar for ${id}`);
  }

  /**
   * Cached fetch of a sha1(+size)-pinned artifact. Cache hits are re-verified
   * against the pin on every read (~100ms for a 38MB jar — honesty over speed);
   * a failing entry is treated as a miss and re-downloaded.
   */
  private async getPinned(kind: string, version: string, filename: string, pin: Pin, what: string): Promise<FetchResult> {
    const path = this.cachePath(kind, version, filename);
    const cached = readIfExists(path);
    if (cached !== null && matchesPin(cached, pin)) {
      return { path, data: cached, wasCache: true };
    }
    if (this.offline) {
      throw new ArtifactUnavailableError(
        'OFFLINE_NOT_CACHED',
        cached === null
          ? `Offline mode (--offline/MODFORGE_OFFLINE): ${what} is not in the cache (expected at ${path}), so the download was blocked — re-run online once to populate the cache.`
          : `Offline mode (--offline/MODFORGE_OFFLINE): cached ${what} fails sha1/size verification (${path}); offline mode blocked re-downloading it — delete it and re-run online.`,
      );
    }
    const data = await this.httpGet(pin.url);
    verifyPin(data, pin, what);
    this.writeCached(path, data);
    return { path, data, wasCache: false };
  }

  /**
   * Cached fetch of unpinned meta JSON (manifest, fabric meta) with TTL freshness.
   * Offline serves any cached copy regardless of age; online, a stale copy is
   * refreshed, and a network failure with a stale copy present fails LOUDLY
   * (pointing at offline mode) instead of silently serving stale data.
   */
  private async getMetaJson(kind: string, version: string, filename: string, url: string): Promise<FetchResult> {
    const path = this.cachePath(kind, version, filename);
    const cached = readIfExists(path);
    if (cached !== null && (this.offline || this.isFresh(path))) {
      return { path, data: cached, wasCache: true };
    }
    if (this.offline) {
      throw new ArtifactUnavailableError(
        'OFFLINE_NOT_CACHED',
        `Offline mode (--offline/MODFORGE_OFFLINE): ${url} is not in the cache (expected at ${path}), so the download was blocked — re-run online once to populate the cache.`,
      );
    }
    let data: Buffer;
    try {
      data = await this.httpGet(url);
    } catch (e) {
      if (cached !== null) {
        throw new FetchError(
          `${e instanceof Error ? e.message : String(e)} — a stale cached copy exists at ${path}; ` +
            `re-run with --offline (or set MODFORGE_OFFLINE) to use the cached copy without the network.`,
        );
      }
      throw e;
    }
    this.writeCached(path, data);
    return { path, data, wasCache: false };
  }

  /** Fetch the maven jar (verified via its .sha1 sidecar) and extract the tiny file. */
  private async getMavenTiny(kind: string, game: string, mavenVersion: string, url: string, filename: string): Promise<TinyResult> {
    const path = this.cachePath(kind, game, filename);
    const sidecar = readIfExists(`${path}.sha1`)?.toString('utf8').trim().toLowerCase();
    const cached = readIfExists(path);
    if (cached !== null && sidecar !== undefined && sha1hex(cached) === sidecar) {
      return { tiny: extractTiny(cached, filename), version: mavenVersion, jarPath: path, wasCache: true };
    }
    if (this.offline) {
      throw new ArtifactUnavailableError(
        'OFFLINE_NOT_CACHED',
        `Offline mode (--offline/MODFORGE_OFFLINE): ${filename} is not in the cache with a valid .sha1 sidecar (expected at ${path}), so the download was blocked — re-run online once to populate the cache.`,
      );
    }
    // Maven publishes a .sha1 sidecar per artifact; both must fetch and agree.
    const shaRaw = (await this.httpGet(`${url}.sha1`)).toString('utf8').trim();
    const expected = (shaRaw.split(/\s+/)[0] ?? '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(expected)) {
      throw new FetchError(`Bad .sha1 sidecar at ${url}.sha1: '${shaRaw.slice(0, 60)}'`);
    }
    const data = await this.httpGet(url);
    const actual = sha1hex(data);
    if (actual !== expected) {
      throw new FetchError(`sha1 mismatch for ${filename}: maven sidecar says ${expected}, got ${actual} — refusing to use or cache a corrupted artifact.`);
    }
    const tiny = extractTiny(data, filename); // validate the jar BEFORE caching it
    this.writeCached(path, data);
    this.writeCached(`${path}.sha1`, Buffer.from(expected, 'utf8'));
    return { tiny, version: mavenVersion, jarPath: path, wasCache: false };
  }

  /** One retry max, and only for network errors / HTTP 5xx — 4xx is deterministic. */
  private async httpGet(url: string): Promise<Buffer> {
    if (this.offline) {
      throw new ArtifactUnavailableError(
        'OFFLINE_NOT_CACHED',
        `Offline mode (--offline/MODFORGE_OFFLINE): refusing to fetch ${url} — re-run online to populate the cache.`,
      );
    }
    let lastFailure = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        lastFailure = `HTTP ${res.status} ${res.statusText}`;
        if (res.status < 500) break;
      } catch (e) {
        lastFailure = e instanceof Error ? e.message : String(e);
      }
    }
    throw new FetchError(`GET ${url} failed: ${lastFailure}`);
  }

  private cachePath(kind: string, version: string, filename: string): string {
    return join(this.cacheDir, safeSegment(kind), safeSegment(version), safeSegment(filename));
  }

  /** Write via tmp+rename so readers never observe a partially-written artifact. */
  private writeCached(path: string, data: Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }

  private isFresh(path: string): boolean {
    try {
      return statSync(path).mtimeMs + this.ttlMs > this.now();
    } catch {
      return false;
    }
  }
}

// ----------------------------------------------------------------- utilities

/** Lowercase hex sha1 of a buffer (node:crypto). */
export function sha1hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function matchesPin(data: Buffer, pin: Pin): boolean {
  if (pin.size !== undefined && data.length !== pin.size) return false;
  return sha1hex(data) === pin.sha1.toLowerCase();
}

function verifyPin(data: Buffer, pin: Pin, what: string): void {
  if (pin.size !== undefined && data.length !== pin.size) {
    throw new FetchError(`Size mismatch for ${what}: expected ${pin.size} bytes, got ${data.length} — refusing to use or cache.`);
  }
  const actual = sha1hex(data);
  if (actual !== pin.sha1.toLowerCase()) {
    throw new FetchError(`sha1 mismatch for ${what}: expected ${pin.sha1}, got ${actual} — refusing to use or cache a corrupted artifact.`);
  }
}

function extractTiny(jar: Buffer, what: string): string {
  const zip = new ZipReader(jar);
  const entry = 'mappings/mappings.tiny';
  if (!zip.has(entry)) {
    throw new FetchError(`${what}: no ${entry} entry in jar (${zip.entries.size} entries) — not a mapping jar?`);
  }
  return zip.read(entry).toString('utf8');
}

function readIfExists(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** Path-safe segment: version ids are clean in practice; this blocks traversal. */
function safeSegment(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._+\- ]/g, '_');
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? `_${cleaned}_` : cleaned;
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort(cmp);
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort(cmp);
  } catch {
    return [];
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ------------------------------------------------------- JSON shape checking
// Meta JSON is parsed defensively: a shape drift in an upstream API must produce a
// loud, located error — never a silently-undefined field flowing into resolutions.

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new FetchError(`${what}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function asObj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new FetchError(`${what}: expected an object`);
  return v as Record<string, unknown>;
}

function asArr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new FetchError(`${what}: expected an array`);
  return v;
}

function asStr(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new FetchError(`${what}: expected a string, got ${typeof v}`);
  return v;
}

function asNum(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new FetchError(`${what}: expected a finite number`);
  return v;
}

function asBool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new FetchError(`${what}: expected a boolean`);
  return v;
}

function parseManifest(text: string, origin: string): { latestRelease?: string; latestSnapshot?: string; versions: ManifestVersion[] } {
  const what = `manifest ${origin}`;
  const o = asObj(parseJson(text, what), what);
  const versions = asArr(o['versions'], `${what}: versions`).map((v, i): ManifestVersion => {
    const e = asObj(v, `${what}: versions[${i}]`);
    return {
      id: asStr(e['id'], `${what}: versions[${i}].id`),
      type: asStr(e['type'], `${what}: versions[${i}].type`),
      url: asStr(e['url'], `${what}: versions[${i}].url`),
      sha1: asStr(e['sha1'], `${what}: versions[${i}].sha1`),
      releaseTime: asStr(e['releaseTime'], `${what}: versions[${i}].releaseTime`),
    };
  });
  const out: { latestRelease?: string; latestSnapshot?: string; versions: ManifestVersion[] } = { versions };
  if (o['latest'] !== undefined) {
    const l = asObj(o['latest'], `${what}: latest`);
    out.latestRelease = asStr(l['release'], `${what}: latest.release`);
    out.latestSnapshot = asStr(l['snapshot'], `${what}: latest.snapshot`);
  }
  return out;
}

function parseDownload(v: unknown, what: string): DownloadInfo {
  const o = asObj(v, what);
  return {
    sha1: asStr(o['sha1'], `${what}.sha1`),
    size: asNum(o['size'], `${what}.size`),
    url: asStr(o['url'], `${what}.url`),
  };
}

function parseVersionJson(text: string, id: string): VersionJson {
  const what = `version JSON for ${id}`;
  const o = asObj(parseJson(text, what), what);
  const idStr = asStr(o['id'], `${what}: id`);
  if (idStr !== id) {
    throw new FetchError(`${what}: id mismatch — requested '${id}' but file says '${idStr}'`);
  }
  const downloads: VersionJson['downloads'] = {};
  if (o['downloads'] !== undefined) {
    const d = asObj(o['downloads'], `${what}: downloads`);
    for (const key of DOWNLOAD_KEYS) {
      const v = d[key];
      if (v !== undefined) downloads[key] = parseDownload(v, `${what}: downloads.${key}`);
    }
  }
  const result: VersionJson = { id: idStr, downloads };
  if (o['javaVersion'] !== undefined) {
    const jv = asObj(o['javaVersion'], `${what}: javaVersion`);
    result.javaVersion = {
      component: asStr(jv['component'], `${what}: javaVersion.component`),
      majorVersion: asNum(jv['majorVersion'], `${what}: javaVersion.majorVersion`),
    };
  }
  return result;
}

function parseYarnEntries(text: string, game: string): FabricYarnEntry[] {
  const what = `fabric yarn meta for ${game}`;
  return asArr(parseJson(text, what), what).map((v, i): FabricYarnEntry => {
    const e = asObj(v, `${what}[${i}]`);
    return {
      gameVersion: asStr(e['gameVersion'], `${what}[${i}].gameVersion`),
      build: asNum(e['build'], `${what}[${i}].build`),
      version: asStr(e['version'], `${what}[${i}].version`),
      maven: asStr(e['maven'], `${what}[${i}].maven`),
      stable: asBool(e['stable'], `${what}[${i}].stable`),
    };
  });
}

function parseIntermediaryEntries(text: string, game: string): FabricIntermediaryEntry[] {
  const what = `fabric intermediary meta for ${game}`;
  return asArr(parseJson(text, what), what).map((v, i): FabricIntermediaryEntry => {
    const e = asObj(v, `${what}[${i}]`);
    return {
      version: asStr(e['version'], `${what}[${i}].version`),
      maven: asStr(e['maven'], `${what}[${i}].maven`),
      stable: asBool(e['stable'], `${what}[${i}].stable`),
    };
  });
}
