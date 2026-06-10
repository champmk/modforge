/**
 * The publishable "What breaks in <version>" markdown — the recurring report a
 * mod developer can generate the day a game drop ships, before any hand-written
 * primer exists. Shared by `modforge delta --out` and scripts/delta-report.ts.
 *
 * Honesty invariant: everything here is extracted classfile fact except the
 * rename-candidate section, which is explicitly labeled as structural
 * inference with scores (SPEC §5).
 */
import type { ApiDelta } from '../delta/delta.ts';

export function renderDeltaMarkdown(d: ApiDelta, fromV: string, toV: string): string {
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
  return lines.join('\n') + '\n';
}
