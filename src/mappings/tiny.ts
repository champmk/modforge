/**
 * Tiny v2 mapping parser (dependency-free).
 *
 * Format (verified hands-on against yarn 1.21.11+build.6 and intermediary 1.21.11):
 *
 *   tiny\t2\t0\t<nsA>\t<nsB>[\t<nsC>...]          ← header
 *   c\t<nameA>\t<nameB>[...]                       ← class (names per namespace)
 *   \tm\t<descA>\t<nameA>\t<nameB>[...]            ← method (descriptor in FIRST namespace)
 *   \tf\t<descA>\t<nameA>\t<nameB>[...]            ← field
 *   \t\tp\t<lvIndex>\t...                          ← method parameter (ignored for our purposes)
 *   \t\t...                                        ← comments/javadoc lines (ignored)
 *
 * Escaping: if the header has the `escaped-names` property, names may contain
 * \\n \\t \\r \\0 \\\\ escapes — handled below.
 *
 * Yarn ships `intermediary → named`; intermediary ships `official → intermediary`.
 */
import type { MappingSet, MappedClass } from '../core/model.ts';

function unescapeTiny(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i];
      out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === '0' ? '\0' : n === '\\' ? '\\' : n;
    } else {
      out += c;
    }
  }
  return out;
}

export function parseTinyV2(text: string): MappingSet {
  const lines = text.split('\n');
  const headerLine = lines[0];
  if (headerLine === undefined) throw new Error('tiny: empty file');
  const header = headerLine.replace(/\r$/, '').split('\t');
  if (header[0] !== 'tiny' || header[1] !== '2') {
    throw new Error(`tiny: unsupported header: ${headerLine.slice(0, 60)}`);
  }
  const namespaces = header.slice(3);
  if (namespaces.length < 2) throw new Error('tiny: fewer than 2 namespaces');

  let escaped = false;
  const classes: MappedClass[] = [];
  let cur: MappedClass | null = null;

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined || raw === '' || raw === '\r') continue;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const parts = line.split('\t');

    if (parts[0] === 'c') {
      // class line: c <name per namespace>
      const names = parts.slice(1).map((n) => (n === '' ? null : escaped ? unescapeTiny(n) : n));
      cur = { names, methods: [], fields: [] };
      classes.push(cur);
    } else if (parts[0] === '' && (parts[1] === 'm' || parts[1] === 'f') && cur) {
      const desc = parts[2];
      if (desc === undefined) continue;
      const names = parts.slice(3).map((n) => (n === '' || n === undefined ? null : escaped ? unescapeTiny(n) : n));
      const member = { desc, names };
      if (parts[1] === 'm') cur.methods.push(member);
      else cur.fields.push(member);
    } else if (parts[0] === '' && parts[1] === '' ) {
      // parameter / comment / javadoc lines — not needed for symbol resolution
      continue;
    } else if (line.startsWith('\t\t')) {
      continue;
    } else if (parts[0] === 'escaped-names' || (parts[0] === '' && parts[1] === 'escaped-names')) {
      escaped = true;
    }
    // property lines in the header section (indented key/values right after header) are rare;
    // 'escaped-names' is the only one that affects parsing.
  }
  return { namespaces, classes };
}

/**
 * Build fast lookup maps from a 2-namespace MappingSet.
 * Returns maps keyed by the chosen namespace's class name.
 */
export function indexByNamespace(set: MappingSet, ns: string): Map<string, MappedClass> {
  const idx = set.namespaces.indexOf(ns);
  if (idx === -1) throw new Error(`tiny: namespace ${ns} not in [${set.namespaces.join(', ')}]`);
  const map = new Map<string, MappedClass>();
  for (const c of set.classes) {
    const name = c.names[idx];
    if (name) map.set(name, c);
  }
  return map;
}
