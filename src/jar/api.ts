/**
 * Extract the full API surface of a jar: every classfile parsed into ClassApi.
 *
 * Used for: game jars (the 26.x unobfuscated era — the API ground truth) and,
 * later, compiled mod jars.
 */
import { ZipReader } from './zip.ts';
import { parseClassFile } from './classfile.ts';
import type { ClassApi, JarApi } from '../core/model.ts';

export interface JarApiOptions {
  /** Only include classes whose binary name passes this filter (e.g. skip libraries bundled in the jar). */
  classFilter?: (binaryName: string) => boolean;
  /** Collect parse errors instead of throwing (default: throw on first error — honesty first). */
  collectErrors?: boolean;
  /**
   * Walk method bodies and populate `MemberApi.codeRefs` (instruction-level
   * mixin verification). Slower than the metadata fast path; off by default.
   */
  scanCode?: boolean;
}

export interface JarApiResult {
  api: JarApi;
  /** Entries that failed to parse, when collectErrors is set. */
  errors: { entry: string; error: string }[];
}

export function extractJarApi(buf: Buffer, id: string, opts: JarApiOptions = {}): JarApiResult {
  const zip = new ZipReader(buf);
  const classes = new Map<string, ClassApi>();
  const errors: { entry: string; error: string }[] = [];

  for (const name of zip.names()) {
    if (!name.endsWith('.class')) continue;
    // module-info / package-info / META-INF versions are not API classes
    if (name === 'module-info.class' || name.endsWith('/module-info.class')) continue;
    if (name.endsWith('package-info.class')) continue;
    if (name.startsWith('META-INF/')) continue;

    const binaryName = name.slice(0, -'.class'.length);
    if (opts.classFilter && !opts.classFilter(binaryName)) continue;

    try {
      const api = parseClassFile(zip.read(name), { scanCode: opts.scanCode === true });
      // Sanity: entry path should match the class's own name (jar hygiene).
      if (api.binaryName !== binaryName) {
        throw new Error(`entry path ${binaryName} != this_class ${api.binaryName}`);
      }
      classes.set(api.binaryName, api);
    } catch (e) {
      if (opts.collectErrors) {
        errors.push({ entry: name, error: e instanceof Error ? e.message : String(e) });
      } else {
        throw new Error(`jar-api: failed parsing ${name}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return { api: { id, classes }, errors };
}
