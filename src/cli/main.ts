#!/usr/bin/env node
/**
 * modforge — the CLI.
 *
 *   modforge bridge --from 1.21.11 --to 26.1.2 [--namespace named|source] <src-dir>
 *                   [--json] [--out report.md] [--apply]
 *   modforge delta  --from 26.1.2 --to 26.2-pre-5 [--json] [--out delta.md]
 *   modforge gradle-migrate <project-dir> [--apply]
 *   modforge mixin-check --target 26.1.2 <src-dir>
 *   modforge versions
 *
 * Every command is CI-friendly: deterministic output, exit 0 on success
 * (UNRESOLVED findings are a successful result — see the honesty taxonomy),
 * exit 2 on usage errors, exit 1 on operational failures (network, bad paths).
 *
 * All artifacts (manifests, jars, mappings) are fetched from official sources,
 * sha1-verified, and cached under ~/.modforge/cache — nothing is redistributed.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { FetchCache, ArtifactUnavailableError, FetchError } from '../mappings/fetch.ts';
import { parseTinyV2 } from '../mappings/tiny.ts';
import { parseProguard } from '../mappings/proguard.ts';
import { extractJarApi } from '../jar/api.ts';
import { EraBridge, type OldHierarchyEntry, type SourceNamespace } from '../bridge/bridge.ts';
import { buildRenameTable, surfaceFromMojmap } from '../bridge/renames.ts';
import { computeDelta } from '../delta/delta.ts';
import { renderDeltaMarkdown } from '../report/delta-md.ts';
import { scanTree, type JavaFinding } from '../scan/java.ts';
import { planJavaPatches, applyToDisk, BACKUP_DIR, BACKUP_SUBDIR, LEGACY_BACKUP_DIR, type PatchOp } from '../patch/patch.ts';
import { adaptForPatching, type PatchInput } from '../patch/wire.ts';
import type { AppliedFix } from '../report/report.ts';
import {
  annotateApply,
  colorEnabled,
  makeFinding,
  makeReport,
  renderJson,
  renderMarkdown,
  renderTerminal,
  summarizeApply,
  summarizeDelta,
  summarizeGradlePlan,
  type Finding,
} from '../report/report.ts';
import { planGradleMigration, applyGradleMigration } from '../scan/gradle.ts';
import { findMixinConfigs, scanMixinSource, collectTargetChecks, checkTargetsAgainstJar, type MixinClassScan } from '../scan/mixin.ts';
import { bridgeEraHint, type BridgeEra } from './bridge-era.ts';
import { decideNamespace, probeNamespaces, sampleClassNames } from './bridge-namespace.ts';
import { checkUnknownFlags } from './flags.ts';

const USAGE = `modforge — deterministic cross-version migration engine for Minecraft mods

USAGE
  modforge bridge --from <ver> --to <ver> [--namespace named|source] <src-dir> [--json] [--out <file>] [--apply]
  modforge delta --from <ver> --to <ver> [--json] [--out <file>]
  modforge gradle-migrate <project-dir> [--apply]
  modforge mixin-check --target <ver> <src-dir>
  modforge versions

The honesty taxonomy: every finding is EXACT (deterministically proven against
the target jar — safe to act on), CANDIDATE (evidenced suggestion — verify), or
UNRESOLVED (honest unknown with the precise reason). UNRESOLVED is a successful
result, not an error.`;

interface Args {
  cmd: string | undefined;
  flags: Map<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let cmd: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        // boolean-style flags that never take values
        if (name === 'json' || name === 'apply' || name === 'no-color') {
          flags.set(name, true);
        } else {
          flags.set(name, next);
          i++;
        }
      } else {
        flags.set(name, true);
      }
    } else if (cmd === undefined) {
      cmd = a;
    } else {
      positional.push(a);
    }
  }
  return { cmd, flags, positional };
}

function fail(msg: string, code: number): never {
  console.error(`modforge: ${msg}`);
  process.exit(code);
}

function str(flags: Map<string, string | boolean>, name: string): string | null {
  const v = flags.get(name);
  return typeof v === 'string' ? v : null;
}

/** Build the full bridge engine for a (from,to) pair via the verified cache. */
async function buildBridge(cache: FetchCache, from: string, to: string): Promise<EraBridge> {
  console.error(`modforge: preparing ${from} → ${to} (first run downloads + caches artifacts)...`);
  const mojmapRes = await cache.getClientMappings(from);
  const mojmap = parseProguard(mojmapRes.data.toString('utf8'));
  const yarnRes = await cache.getYarn(from);
  const yarn = parseTinyV2(yarnRes.tiny);
  const interRes = await cache.getIntermediary(from);
  const intermediary = parseTinyV2(interRes.tiny);
  const targetJar = await cache.getClientJar(to);
  const { api: target } = extractJarApi(targetJar.data, `${to}-client`);
  const oldJarRes = await cache.getClientJar(from);
  const { api: oldJar } = extractJarApi(oldJarRes.data, `${from}-client`, { collectErrors: true });
  const oldHierarchy = new Map<string, OldHierarchyEntry>();
  for (const [name, cls] of oldJar.classes) {
    oldHierarchy.set(name, { superName: cls.superName, interfaces: cls.interfaces });
  }
  const renames = buildRenameTable(surfaceFromMojmap(mojmap), target);
  console.error(`modforge: engine ready (${target.classes.size} target classes, rename table: ${renames.classEntries.length} class / ${renames.memberEntries.length} member entries)`);
  return new EraBridge({ yarn, intermediary, mojmap, target, oldHierarchy, renames });
}

/**
 * Era of a version from ground truth (its Mojang version JSON): a published
 * client_mappings download means the obfuscated era (a valid bridge source);
 * no mappings + Java 25+ is the unobfuscated 26.1+ era. Any fetch/shape failure
 * degrades to 'unknown' so a network hiccup never turns into a wrong hint.
 */
async function classifyEra(cache: FetchCache, version: string): Promise<BridgeEra> {
  try {
    const { json } = await cache.getVersionJson(version);
    if (json.downloads.client_mappings) return 'pre';
    if ((json.javaVersion?.majorVersion ?? 0) >= 25) return 'post';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function cmdBridge(args: Args): Promise<void> {
  const from = str(args.flags, 'from') ?? fail('--from <version> is required', 2);
  const to = str(args.flags, 'to') ?? fail('--to <version> is required', 2);
  // null = the user did not pass --namespace, so we autodetect below; a value is
  // honored verbatim (explicit always wins over autodetect).
  const requestedNs = str(args.flags, 'namespace');
  if (requestedNs !== null && requestedNs !== 'named' && requestedNs !== 'source') {
    fail(`--namespace must be named or source, got ${requestedNs}`, 2);
  }
  const dir = args.positional[0] ?? fail('a source directory is required', 2);
  try {
    statSync(dir);
  } catch {
    fail(`source directory not found: ${dir}`, 1);
  }

  const cache = new FetchCache();
  let bridge: EraBridge;
  try {
    bridge = await buildBridge(cache, from, to);
  } catch (e) {
    // A missing FROM mojmap is era-shaped: either the args are reversed (a
    // post-era FROM that belongs in the TO slot) or BOTH versions are post-era
    // (no obfuscation boundary to bridge at all — the bug a circular reversed
    // hint used to paper over). Classify the pair from ground truth and let the
    // pure decider pick the honest message; never suggest a command that would
    // fail identically.
    if (e instanceof ArtifactUnavailableError && e.code === 'NO_MOJANG_MAPPINGS') {
      const [fromEra, toEra] = await Promise.all([classifyEra(cache, from), classifyEra(cache, to)]);
      fail(bridgeEraHint({ from, to, dir, baseMessage: e.message, fromEra, toEra }), 1);
    }
    throw e;
  }

  // Namespace routing. A mod's classes are written in exactly ONE old-era namespace
  // (yarn `named` for Fabric, mojmap `source` for NeoForge/multiloader); the engine
  // supports both, so picking the wrong one resolves ~nothing. Respect an explicit
  // --namespace; otherwise autodetect from a deterministic probe of the scanned
  // class names against BOTH source tables (membership = the engine maps it under
  // that namespace). Loud and always overridable — see ./bridge-namespace.ts.
  let ns: SourceNamespace;
  if (requestedNs !== null) {
    ns = requestedNs as SourceNamespace;
  } else {
    const sample = sampleClassNames(
      scanTree(dir)
        .findings.map((f) => f.className)
        .filter((c): c is string => !!c && (c.startsWith('net/minecraft') || c.startsWith('com/mojang'))),
    );
    const decision = decideNamespace(
      probeNamespaces(sample, (probeNs, cls) => bridge.resolveClass(probeNs, cls).confidence !== 'UNRESOLVED'),
    );
    ns = decision.namespace;
    if (decision.notice) console.error(decision.notice);
  }

  /** One scan+resolve pass over the tree (re-run between apply passes — the engine stays cached). */
  const runPass = (quiet: boolean) => {
    const scan = scanTree(dir);
    if (!quiet) {
      console.error(`modforge: scanned ${scan.files.length} files, ${scan.findings.length} references (${scan.errors.length} file errors)`);
      for (const e of scan.errors) console.error(`modforge:   scan error: ${e.file}: ${e.error}`);
    }
    const passFindings: Finding[] = [];
    // Per-file inputs for --apply: relative path → { absolute path, patch items }.
    const patchByFile = new Map<string, { absFile: string; items: PatchInput[] }>();
    for (const f of scan.findings) {
      if (!f.className || !(f.className.startsWith('net/minecraft') || f.className.startsWith('com/mojang'))) continue;
      const resolution = resolveFinding(bridge, ns, f);
      if (!resolution) continue;
      // Paths relative to the scanned dir: keeps usernames/machine paths out of
      // shareable reports and makes finding ids stable across machines (CI baselines).
      const relFile = relative(dir, f.file) || f.file;
      const finding = makeFinding({ file: relFile, line: f.line, col: f.col, surface: f.kind }, resolution);
      passFindings.push(finding);
      const entry = patchByFile.get(finding.source.file!) ?? { absFile: f.file, items: [] };
      entry.items.push({ finding: f, resolution, id: finding.id });
      patchByFile.set(finding.source.file!, entry);
    }
    return { passFindings, patchByFile };
  };

  // The report reflects the tree as FOUND (pass 1); apply passes annotate it.
  const first = runPass(false);
  const findings = first.passFindings;

  if (args.flags.get('apply')) {
    // Iterate to the fixpoint: a pass may hold back an edit whose new simple
    // name would collide with a binding that the SAME pass renames away
    // (conservative per-pass hazard checks). Each pass re-scans the tree and
    // re-verifies against the current text, so later passes are independently
    // proven. Idempotence bounds this — a pass that applies nothing ends it.
    const MAX_PASSES = 5;
    let totalApplied = 0;
    const writtenFiles = new Set<string>();
    const fixById = new Map<string, AppliedFix>();
    // Reasons an op was NOT applied, keyed by report-finding id: a planning skip
    // (e.g. a pass-6 whole-file old-name-dangling refusal, a simple-name collision)
    // or an apply-time refusal (drift, an unwritable file). Last pass wins, so the
    // map reflects the FINAL state of each finding across the fixpoint.
    const skipById = new Map<string, string>();
    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      const { patchByFile } = pass === 1 ? first : runPass(true);
      const allOps: PatchOp[] = [];
      for (const [relFile, { absFile, items }] of patchByFile) {
        const text = readFileSync(absFile, 'utf8');
        const plan = planJavaPatches(text, relFile, adaptForPatching(text, relFile, items));
        allOps.push(...plan.ops);
        for (const s of plan.skipped) skipById.set(s.findingId, s.reason);
      }
      const outcomes = applyToDisk(allOps, { root: dir });
      let applied = 0;
      for (const o of outcomes) {
        if (o.written) writtenFiles.add(o.file);
        for (const op of o.applied) {
          applied++;
          // Finding ids are content-derived from (symbol, file, line, col),
          // so a held-back edit re-applied in a later pass annotates the same
          // pass-1 report finding.
          fixById.set(op.findingId, { file: o.file, before: op.before, after: op.after });
        }
        for (const r of o.refused) skipById.set(r.op.findingId, r.reason);
      }
      totalApplied += applied;
      if (applied === 0) break;
    }
    // Annotate the pass-1 report findings with what ACTUALLY happened: applied
    // fixes win; an EXACT finding that was withheld/refused carries its verbatim
    // reason. Phantom skip ids (re-detections of already-patched names in a later
    // pass) own no report finding and are dropped — they never inflate the count.
    annotateApply(findings, fixById, skipById);
    const review = summarizeApply(findings);
    // Surface withheld/refused EXACT findings — grouped per file, one line each,
    // reason verbatim — so an EXACT-but-not-applied finding is self-explaining.
    for (const g of review.reviewByFile) {
      console.error(`modforge: ${g.file === '' ? '(no source location)' : g.file}`);
      for (const it of g.items) console.error(`modforge:   ${it.line !== undefined ? `L${it.line}: ` : ''}${it.reason}`);
    }
    console.error(
      `modforge: applied ${totalApplied} EXACT rewrite(s) across ${writtenFiles.size} file(s); ` +
        `${review.leftForReview} finding(s) left for review (CANDIDATE/UNRESOLVED or EXACT not provably patchable here).` +
        (writtenFiles.size > 0 ? ` Originals backed up under ${join(dir, BACKUP_DIR, BACKUP_SUBDIR)}.` : ''),
    );
  }

  const report = makeReport(
    // Provenance relative to the working dir when possible — shareable reports
    // should not carry the machine's user paths.
    { tool: 'modforge', version: '0.1.1', fromVersion: from, toVersion: to, namespace: ns, generatedFor: relative(process.cwd(), dir) || dir },
    findings,
  );

  const out = str(args.flags, 'out');
  if (args.flags.get('json')) {
    const text = renderJson(report);
    if (out) writeFileSync(out, text);
    else console.log(text);
  } else if (out) {
    writeFileSync(out, renderMarkdown(report));
    console.error(`modforge: report written to ${out}`);
  } else {
    // Color is opt-in: only an interactive stdout with NO_COLOR unset/empty;
    // --no-color forces it off (so piped/redirected output and CI logs stay clean).
    const color = colorEnabled(args.flags.get('no-color') === true, process.env, process.stdout.isTTY === true);
    console.log(renderTerminal(report, { color }));
  }
}

function resolveFinding(bridge: EraBridge, ns: SourceNamespace, f: JavaFinding) {
  if (f.memberName && (f.kind === 'member-static' || f.kind === 'member-instance' || f.kind === 'import-static')) {
    return bridge.resolveMember(
      ns,
      f.memberKind ?? 'method',
      f.className!,
      f.memberName,
      null,
      f.argCount !== undefined ? { argCount: f.argCount } : {},
    );
  }
  if (!f.memberName) return bridge.resolveClass(ns, f.className!);
  return null;
}

async function cmdDelta(args: Args): Promise<void> {
  const from = str(args.flags, 'from') ?? fail('--from <version> is required', 2);
  const to = str(args.flags, 'to') ?? fail('--to <version> is required', 2);
  const out = str(args.flags, 'out');
  const cache = new FetchCache();
  console.error(`modforge: fetching ${from} + ${to} client jars...`);
  const a = await cache.getClientJar(from);
  const b = await cache.getClientJar(to);
  const { api: fromApi } = extractJarApi(a.data, `${from}-client`);
  const { api: toApi } = extractJarApi(b.data, `${to}-client`);
  const delta = computeDelta(fromApi, toApi);
  if (out !== null) {
    writeFileSync(out, renderDeltaMarkdown(delta, from, to));
    console.error(`modforge: report written to ${out}`);
    return;
  }
  if (args.flags.get('json')) {
    console.log(JSON.stringify(delta, null, 1));
    return;
  }
  const s = summarizeDelta(delta);
  console.log(`API delta ${from} → ${to}`);
  console.log(`  classes: +${s.classesAdded} −${s.classesRemoved} (rename candidates ${s.classRenameCandidates})`);
  console.log(`  methods: +${s.methodsAdded} −${s.methodsRemoved} ~${s.methodsDescChanged} signature-changed`);
  console.log(`  fields:  +${s.fieldsAdded} −${s.fieldsRemoved} ~${s.fieldsDescChanged} type-changed`);
  console.log(`  member rename candidates (methods + fields): ${s.memberRenameCandidates} — all CANDIDATE-grade`);
  console.log('');
  console.log(`publishable markdown report:  modforge delta --from ${from} --to ${to} --out delta.md`);
  console.log(`full machine-readable delta:  modforge delta --from ${from} --to ${to} --json`);
}

async function cmdGradleMigrate(args: Args): Promise<void> {
  const dir = args.positional[0] ?? fail('a project directory is required', 2);
  const files: { path: string; text: string }[] = [];
  const wanted = new Set(['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties']);
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!['build', '.gradle', '.git', 'node_modules', 'run', BACKUP_DIR, LEGACY_BACKUP_DIR].includes(e.name)) walk(p);
      } else if (wanted.has(e.name) || e.name.endsWith('.mixins.json') || e.name.endsWith('.accesswidener')) {
        const norm = p.replace(/\\/g, '/');
        const buf = readFileSync(p);
        // Exclude non-UTF-8 files WHOLE: a lossy decode would rewrite the
        // backup and the live file with U+FFFD where the original bytes were.
        if (!Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)) {
          console.error(`modforge: ${norm} is not valid UTF-8 — convert it to UTF-8 and re-run; it was excluded from this migration.`);
          continue;
        }
        files.push({ path: norm, text: buf.toString('utf8') });
      }
    }
  };
  walk(dir);
  if (files.length === 0) fail(`no gradle/mixin/accesswidener files found under ${dir}`, 1);

  const plan = planGradleMigration(files);
  console.log(JSON.stringify(summarizeGradlePlan(plan), null, 2));
  if (args.flags.get('apply')) {
    // Old backups are never migrated: if a pre-0.1.2 .modforge-backup is still
    // here, say so once and leave it untouched — new backups go to .modforge/backup.
    if (existsSync(join(dir, LEGACY_BACKUP_DIR))) {
      console.error(
        `modforge: note: legacy backups remain under ${join(dir, LEGACY_BACKUP_DIR)}; ` +
          `new backups go to ${join(dir, BACKUP_DIR, BACKUP_SUBDIR)} (the old ones are left untouched).`,
      );
    }
    const originals = new Map(files.map((f) => [f.path, f.text]));
    let written = 0;
    for (const f of applyGradleMigration(plan)) {
      if (originals.get(f.path) !== f.text) {
        // Same safety contract as bridge --apply: original backed up under
        // .modforge/backup/ before writing (first-run copy preserved).
        const rel = relative(dir, f.path) || f.path;
        const backupPath = join(dir, BACKUP_DIR, BACKUP_SUBDIR, rel);
        // Raw byte copy of the ORIGINAL file, taken before the rewrite below —
        // never a writeFileSync of the decoded string (that would mojibake any
        // multibyte content). First-run copy preserved across re-runs.
        if (!existsSync(backupPath)) {
          mkdirSync(dirname(backupPath), { recursive: true });
          copyFileSync(f.path, backupPath);
        }
        writeFileSync(f.path, f.text);
        written++;
      }
    }
    console.error(
      `modforge: ${written} files rewritten (EXACT-tier rules only; originals backed up under ${join(dir, BACKUP_DIR, BACKUP_SUBDIR)}). ` +
        'Review the manual-review list above.',
    );
  } else {
    console.error('modforge: dry run — pass --apply to write the EXACT-tier rewrites.');
  }
}

async function cmdMixinCheck(args: Args): Promise<void> {
  const targetVersion = str(args.flags, 'target') ?? fail('--target <version> is required', 2);
  const dir = args.positional[0] ?? fail('a source directory is required', 2);
  const cache = new FetchCache();
  const jar = await cache.getClientJar(targetVersion);
  const { api: target } = extractJarApi(jar.data, `${targetVersion}-client`);

  const { configs, errors } = findMixinConfigs(dir);
  console.error(`modforge: ${configs.length} mixin config(s) found`);
  for (const err of errors) console.error(`modforge:   config error: ${err.file}: ${err.error}`);
  const scans = collectMixinClassScans(dir);
  const checks = collectTargetChecks(scans);
  const verdicts = checkTargetsAgainstJar(checks, target);
  let present = 0;
  let absent = 0;
  let info = 0;
  let unparseable = 0;
  for (const v of verdicts) {
    const c = v.check;
    const label = (c.ref.owner ?? '') + (c.ref.name ? `#${c.ref.name}${c.ref.desc ?? ''}` : '');
    switch (v.status) {
      case 'present':
        present++;
        break;
      case 'info':
        info++;
        console.log(`INFO         ${label} — ${v.note} (${c.surface} in ${c.mixinClass}, ${c.file}:${c.line})`);
        break;
      case 'unparseable':
        unparseable++;
        console.log(`UNPARSEABLE  ${c.surface} in ${c.mixinClass} (${c.file}:${c.line}) — ${v.note ?? 'no owner derivable'}`);
        break;
      case 'absent':
        absent++;
        if (c.ref.name) {
          console.log(`ABSENT       ${c.ref.owner}#${c.ref.name}${c.ref.desc ?? ''} — member not found in ${targetVersion} (${c.surface}, ${c.file}:${c.line})`);
        } else {
          console.log(`ABSENT       ${c.ref.owner} — target class not in ${targetVersion} (${c.surface} in ${c.mixinClass}, ${c.file}:${c.line})`);
        }
        break;
    }
  }
  console.log(`\nmixin-check vs ${targetVersion}: ${present} present, ${absent} ABSENT (break on this version), ${info} not verifiable (outside Minecraft), ${unparseable} unparseable`);
  console.log(`note: this is signature-level verification; instruction-level @At verification ships next (a signature can match while the targeted instruction is gone).`);
}

/** Walk a tree scanning every .java file for mixin class surfaces. */
function collectMixinClassScans(dir: string): MixinClassScan[] {
  const scans: MixinClassScan[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!['build', '.gradle', '.git', 'node_modules', 'run', 'out', BACKUP_DIR, LEGACY_BACKUP_DIR].includes(e.name)) walk(p);
      } else if (e.name.endsWith('.java')) {
        scans.push(...scanMixinSource(readFileSync(p, 'utf8'), p.replaceAll('\\', '/')));
      }
    }
  };
  walk(dir);
  return scans;
}

async function cmdVersions(): Promise<void> {
  const cache = new FetchCache();
  const v = await cache.resolveVersions();
  console.log(`latest release:  ${v.latestRelease}`);
  console.log(`latest snapshot: ${v.latestSnapshot}`);
  console.log(`era boundary: 1.21.11 (2025-12-09) is the last obfuscated/yarn version; 26.1+ is unobfuscated (real names in the jar).`);
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
// Reject a typo'd/unknown flag BEFORE dispatch (a usage error, exit 2) so it can
// never be silently ignored and run with defaults. Unknown commands and the
// help/usage paths carry no registry and fall through to the switch below.
if (args.cmd !== undefined) {
  const flagError = checkUnknownFlags(args.cmd, args.flags.keys());
  if (flagError) fail(flagError, 2);
}
try {
  switch (args.cmd) {
    case 'bridge':
      await cmdBridge(args);
      break;
    case 'delta':
      await cmdDelta(args);
      break;
    case 'gradle-migrate':
      await cmdGradleMigrate(args);
      break;
    case 'mixin-check':
      await cmdMixinCheck(args);
      break;
    case 'versions':
      await cmdVersions();
      break;
    case undefined:
    case 'help':
    case '--help':
      console.log(USAGE);
      break;
    default:
      fail(`unknown command: ${args.cmd}\n\n${USAGE}`, 2);
  }
} catch (e) {
  if (e instanceof ArtifactUnavailableError || e instanceof FetchError) {
    fail(e.message, 1);
  }
  throw e;
}
