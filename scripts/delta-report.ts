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
import { computeDelta } from '../src/delta/delta.ts';
import { FetchCache } from '../src/mappings/fetch.ts';
import { renderDeltaMarkdown } from '../src/report/delta-md.ts';

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
