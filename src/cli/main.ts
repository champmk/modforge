#!/usr/bin/env node
/**
 * modforge — the CLI.
 *
 *   modforge bridge --from 1.21.11 --to 26.1.2 [--namespace named|source] <src-dir>
 *                   [--json] [--out report.md]
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
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FetchCache, ArtifactUnavailableError, FetchError } from '../mappings/fetch.ts';
import { parseTinyV2 } from '../mappings/tiny.ts';
import { parseProguard } from '../mappings/proguard.ts';
import { extractJarApi } from '../jar/api.ts';
import { EraBridge, type OldHierarchyEntry, type SourceNamespace } from '../bridge/bridge.ts';
import { buildRenameTable, surfaceFromMojmap } from '../bridge/renames.ts';
import { computeDelta } from '../delta/delta.ts';
import { renderDeltaMarkdown } from '../report/delta-md.ts';
import { scanTree, type JavaFinding } from '../scan/java.ts';
import {
  makeFinding,
  makeReport,
  renderJson,
  renderMarkdown,
  renderTerminal,
  summarizeDelta,
  summarizeGradlePlan,
  type Finding,
} from '../report/report.ts';
import { planGradleMigration, applyGradleMigration } from '../scan/gradle.ts';
import { findMixinConfigs, scanMixinSource, collectTargetChecks, type MixinClassScan } from '../scan/mixin.ts';

const USAGE = `modforge — deterministic cross-version migration engine for Minecraft mods

USAGE
  modforge bridge --from <ver> --to <ver> [--namespace named|source] <src-dir> [--json] [--out <file>]
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

async function cmdBridge(args: Args): Promise<void> {
  const from = str(args.flags, 'from') ?? fail('--from <version> is required', 2);
  const to = str(args.flags, 'to') ?? fail('--to <version> is required', 2);
  const ns = (str(args.flags, 'namespace') ?? 'named') as SourceNamespace;
  if (ns !== 'named' && ns !== 'source') fail(`--namespace must be named or source, got ${ns}`, 2);
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
    // The most common usage mistake: --from/--to reversed (new era as the
    // source). Detectable because the bridge needs the FROM version's
    // mappings, which only exist for the old era.
    if (e instanceof ArtifactUnavailableError && e.code === 'NO_MOJANG_MAPPINGS') {
      fail(`${e.message}\n\nDid you mean:  modforge bridge --from ${to} --to ${from} ${dir}`, 1);
    }
    throw e;
  }

  const scan = scanTree(dir);
  console.error(`modforge: scanned ${scan.files.length} files, ${scan.findings.length} references (${scan.errors.length} file errors)`);
  for (const e of scan.errors) console.error(`modforge:   scan error: ${e.file}: ${e.error}`);

  const findings: Finding[] = [];
  for (const f of scan.findings) {
    if (!f.className || !(f.className.startsWith('net/minecraft') || f.className.startsWith('com/mojang'))) continue;
    const resolution = resolveFinding(bridge, ns, f);
    if (!resolution) continue;
    // Paths relative to the scanned dir: keeps usernames/machine paths out of
    // shareable reports and makes finding ids stable across machines (CI baselines).
    const relFile = relative(dir, f.file) || f.file;
    findings.push(makeFinding({ file: relFile, line: f.line, col: f.col, surface: f.kind }, resolution));
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
    console.log(renderTerminal(report, { color: !args.flags.get('no-color') }));
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
        if (!['build', '.gradle', '.git', 'node_modules', 'run'].includes(e.name)) walk(p);
      } else if (wanted.has(e.name) || e.name.endsWith('.mixins.json') || e.name.endsWith('.accesswidener')) {
        files.push({ path: p.replace(/\\/g, '/'), text: readFileSync(p, 'utf8') });
      }
    }
  };
  walk(dir);
  if (files.length === 0) fail(`no gradle/mixin/accesswidener files found under ${dir}`, 1);

  const plan = planGradleMigration(files);
  console.log(JSON.stringify(summarizeGradlePlan(plan), null, 2));
  if (args.flags.get('apply')) {
    const originals = new Map(files.map((f) => [f.path, f.text]));
    let written = 0;
    for (const f of applyGradleMigration(plan)) {
      if (originals.get(f.path) !== f.text) {
        writeFileSync(f.path, f.text);
        written++;
      }
    }
    console.error(`modforge: ${written} files rewritten (EXACT-tier rules only). Review the manual-review list above.`);
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
  let present = 0;
  let absent = 0;
  let unparseable = 0;
  for (const c of checks) {
    if (!c.ref.owner) {
      unparseable++;
      console.log(`UNPARSEABLE  ${c.surface} in ${c.mixinClass} (${c.file}:${c.line}) — ${c.note ?? 'no owner derivable'}`);
      continue;
    }
    const cls = target.classes.get(c.ref.owner);
    if (!cls) {
      absent++;
      console.log(`ABSENT       ${c.ref.owner} — target class not in ${targetVersion} (${c.surface} in ${c.mixinClass}, ${c.file}:${c.line})`);
      continue;
    }
    if (c.ref.name) {
      const list = [...cls.methods, ...cls.fields];
      const hit = list.some((m) => m.name === c.ref.name && (!c.ref.desc || m.desc === c.ref.desc));
      if (hit) present++;
      else {
        absent++;
        console.log(`ABSENT       ${c.ref.owner}#${c.ref.name}${c.ref.desc ?? ''} — member not found in ${targetVersion} (${c.surface}, ${c.file}:${c.line})`);
      }
    } else {
      present++;
    }
  }
  console.log(`\nmixin-check vs ${targetVersion}: ${present} present, ${absent} ABSENT (break on this version), ${unparseable} unparseable`);
  console.log(`note: this is signature-level verification; instruction-level @At verification ships next (a signature can match while the targeted instruction is gone).`);
}

/** Walk a tree scanning every .java file for mixin class surfaces. */
function collectMixinClassScans(dir: string): MixinClassScan[] {
  const scans: MixinClassScan[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!['build', '.gradle', '.git', 'node_modules', 'run', 'out'].includes(e.name)) walk(p);
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
