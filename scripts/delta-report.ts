/**
 * Generate the publishable "What breaks in <version>" API-delta report —
 * computable the day a game drop ships, before any hand-written primer exists.
 *
 * Usage: node scripts/delta-report.ts <fromVersion> <toVersion> [--out file.md]
 * Artifacts are fetched + sha1-verified + cached via the data layer; nothing is
 * redistributed.
 */
import { writeFileSync } from 'node:fs';
import { extractJarApi } from '../src/jar/api.ts';
import { computeDelta, type ApiDelta } from '../src/delta/delta.ts';
import { FetchCache } from '../src/mappings/fetch.ts';

const args = process.argv.slice(2);
const from = args[0];
const to = args[1];
const outIdx = args.indexOf('--out');
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
if (!from || !to) {
  console.error('usage: node scripts/delta-report.ts <fromVersion> <toVersion> [--out file.md]');
  process.exit(2);
}

const cache = new FetchCache();
console.error(`fetching ${from} + ${to} client jars (cached after first run)...`);
const fromJar = await cache.getClientJar(from);
const toJar = await cache.getClientJar(to);
const { api: fromApi } = extractJarApi(fromJar.data ?? fromJar, `${from}-client`);
const { api: toApi } = extractJarApi(toJar.data ?? toJar, `${to}-client`);
const delta = computeDelta(fromApi, toApi);

const md = renderDeltaMarkdown(delta, from!, to!);
if (outFile) {
  writeFileSync(outFile, md);
  console.error(`written: ${outFile}`);
} else {
  console.log(md);
}

function renderDeltaMarkdown(d: ApiDelta, fromV: string, toV: string): string {
  const mc = (n: string) => n.startsWith('net/minecraft') || n.startsWith('com/mojang');
  const dot = (n: string) => n.replace(/\//g, '.');
  const lines: string[] = [];
  const L = (s = '') => lines.push(s);

  L(`# Minecraft ${fromV} → ${toV}: the complete API delta for mod developers`);
  L();
  L(`> Generated deterministically by [ModForge](https://github.com/champmk/modforge) from the actual game jars —`);
  L(`> every entry below is a fact extracted from classfile metadata, not a curated summary.`);
  L(`> Rename *candidates* are structural inferences and are labeled with their evidence; verify before relying on them.`);
  L();
  L(`## Summary`);
  L();
  L(`| | added | removed | descriptor changed |`);
  L(`|---|---|---|---|`);
  L(`| **classes** | ${d.classesAdded.filter(mc).length} | ${d.classesRemoved.filter(mc).length} | — |`);
  L(`| **methods** | ${d.methodsAdded.filter((m) => mc(m.owner)).length} | ${d.methodsRemoved.filter((m) => mc(m.owner)).length} | ${d.methodsDescChanged.filter((m) => mc(m.owner)).length} |`);
  L(`| **fields** | ${d.fieldsAdded.filter((m) => mc(m.owner)).length} | ${d.fieldsRemoved.filter((m) => mc(m.owner)).length} | ${d.fieldsDescChanged.filter((m) => mc(m.owner)).length} |`);
  L();

  const pkgOf = (n: string) => n.slice(0, Math.max(0, n.lastIndexOf('/')));
  const removedByPkg = new Map<string, number>();
  for (const c of d.classesRemoved.filter(mc)) removedByPkg.set(pkgOf(c), (removedByPkg.get(pkgOf(c)) ?? 0) + 1);
  const hotPkgs = [...removedByPkg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (hotPkgs.length) {
    L(`## Where the churn is (removed classes by package)`);
    L();
    for (const [pkg, n] of hotPkgs) L(`- \`${dot(pkg)}\` — ${n} classes removed/moved`);
    L();
  }

  if (d.classRenameCandidates.length) {
    L(`## Likely class renames (structural candidates — verify)`);
    L();
    L(`| old | new | score |`);
    L(`|---|---|---|`);
    for (const c of d.classRenameCandidates.slice(0, 60)) {
      L(`| \`${dot(c.from.owner)}\` | \`${dot(c.to.owner ?? '')}\` | ${c.score} |`);
    }
    if (d.classRenameCandidates.length > 60) L(`| … ${d.classRenameCandidates.length - 60} more | | |`);
    L();
  }

  const sigChanges = d.methodsDescChanged.filter((m) => mc(m.owner)).slice(0, 80);
  if (sigChanges.length) {
    L(`## Method signature changes (same name, new shape — your call sites break)`);
    L();
    for (const m of sigChanges) {
      L(`- \`${dot(m.owner)}#${m.name}\``);
      L(`  - was \`${m.desc}\``);
      L(`  - now \`${m.newDesc}\``);
    }
    if (d.methodsDescChanged.filter((m) => mc(m.owner)).length > 80) {
      L(`- … and ${d.methodsDescChanged.filter((m) => mc(m.owner)).length - 80} more`);
    }
    L();
  }

  const removedM = d.methodsRemoved.filter((m) => mc(m.owner));
  if (removedM.length) {
    L(`## Removed methods (top ${Math.min(80, removedM.length)} of ${removedM.length})`);
    L();
    for (const m of removedM.slice(0, 80)) L(`- \`${dot(m.owner)}#${m.name}${m.desc}\``);
    L();
  }

  L(`---`);
  L(`*Full machine-readable delta available via \`modforge delta --from ${fromV} --to ${toV} --json\` or the ModForge MCP server.*`);
  return lines.join('\n');
}
