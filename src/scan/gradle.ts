/**
 * Gradle build-script scanner + mechanical migrator — the pure-EXACT tier.
 *
 * Implements the verified 1.21.x→26.x build migration rules from Fabric's
 * official porting docs (https://docs.fabricmc.net/develop/porting/):
 *
 *   - plugin id `fabric-loom` → `net.fabricmc.fabric-loom`; plugin version →
 *     live-resolution placeholder (the CLI fills it from meta APIs — SPEC §7,
 *     never hardcode toolchain versions)
 *   - DELETE the `mappings` dependency statement/block (no mappings in 26.x)
 *   - dependency configs: modImplementation→implementation, modApi→api,
 *     modCompileOnly→compileOnly, modRuntimeOnly→runtimeOnly,
 *     modLocalRuntime→localRuntime (flagged REVIEW — verify), `include` stays
 *   - task references remapJar→jar
 *   - Java toolchain/source/target 21 → 25
 *   - gradle.properties: minecraft_version / loader_version / fabric_version →
 *     placeholders; yarn_mappings DELETED
 *   - accessWidener / classTweaker header namespace `named` → `official`
 *   - mixin config JSON: compatibilityLevel → JAVA_25, refmap key DELETED
 *
 * This is NOT a Groovy/Kotlin parser. It is a lexer-grade scanner: strings and
 * comments are masked correctly (incl. `${}` interpolation, triple quotes,
 * nested kts block comments), and only the known construct shapes above are
 * matched. Anything that looks relevant but does not match a known shape is
 * reported in the manual-review remainder, never guessed at (honesty taxonomy).
 *
 * Known lexer limitation (documented, fail-loud mitigated): Groovy slashy
 * strings (`/regex/`) are not modeled. A desync they could cause is converted
 * into a loud GradleParseError by the single-line-string newline guard, which
 * sends the whole file to manual review instead of producing silent wrongness.
 *
 * Determinism: scanners are sequential, all plan output is stably sorted, and
 * nothing here consults the clock or randomness.
 */

// ---------------------------------------------------------------------------
// Rule table (exported data for the report layer)
// ---------------------------------------------------------------------------

const PORTING_DOCS = 'https://docs.fabricmc.net/develop/porting/';

/** Stable rule identifiers — referenced by every planned edit. */
export type GradleRuleId =
  | 'plugin-id'
  | 'plugin-version'
  | 'mappings-delete'
  | 'dep-config-rename'
  | 'dep-config-local-runtime'
  | 'remapjar-to-jar'
  | 'java-25'
  | 'props-minecraft-version'
  | 'props-yarn-mappings-delete'
  | 'props-loader-version'
  | 'props-fabric-api-version'
  | 'aw-ct-header-official'
  | 'mixin-compat-level'
  | 'mixin-refmap-delete';

/** One verified migration rule (data for the report layer). */
export interface GradleRule {
  id: GradleRuleId;
  description: string;
  docsUrl: string;
}

/** The verified rule table, in stable presentation order. */
export const GRADLE_RULES: readonly GradleRule[] = [
  { id: 'plugin-id', description: "Loom plugin id 'fabric-loom' → 'net.fabricmc.fabric-loom' (settings/build scripts).", docsUrl: PORTING_DOCS },
  { id: 'plugin-version', description: 'Loom plugin version → placeholder resolved live by the CLI (toolchain versions are never hardcoded).', docsUrl: PORTING_DOCS },
  { id: 'mappings-delete', description: 'Delete the mappings dependency statement/block — 26.x has no mappings.', docsUrl: PORTING_DOCS },
  { id: 'dep-config-rename', description: 'modImplementation→implementation, modApi→api, modCompileOnly→compileOnly, modRuntimeOnly→runtimeOnly; include stays.', docsUrl: PORTING_DOCS },
  { id: 'dep-config-local-runtime', description: 'modLocalRuntime→localRuntime — flagged for verification (REVIEW).', docsUrl: PORTING_DOCS },
  { id: 'remapjar-to-jar', description: 'Task references remapJar → jar (no remapping step in 26.x).', docsUrl: PORTING_DOCS },
  { id: 'java-25', description: 'Java toolchain / sourceCompatibility / targetCompatibility / release 21 → 25.', docsUrl: PORTING_DOCS },
  { id: 'props-minecraft-version', description: 'gradle.properties minecraft_version → live-resolution placeholder.', docsUrl: PORTING_DOCS },
  { id: 'props-yarn-mappings-delete', description: 'gradle.properties yarn_mappings line deleted (yarn ended at 1.21.11).', docsUrl: PORTING_DOCS },
  { id: 'props-loader-version', description: 'gradle.properties loader_version → live-resolution placeholder.', docsUrl: PORTING_DOCS },
  { id: 'props-fabric-api-version', description: 'gradle.properties fabric_version (fabric-api) → live-resolution placeholder.', docsUrl: PORTING_DOCS },
  { id: 'aw-ct-header-official', description: "accessWidener/classTweaker header namespace 'named' → 'official' (verified for accessWidener v2).", docsUrl: PORTING_DOCS },
  { id: 'mixin-compat-level', description: 'Mixin config compatibilityLevel → JAVA_25.', docsUrl: PORTING_DOCS },
  { id: 'mixin-refmap-delete', description: 'Mixin config refmap key deleted (refmaps are a remapping-era artifact).', docsUrl: PORTING_DOCS },
];

/**
 * Placeholder tokens emitted into migrated files. The CLI resolves these live
 * from meta APIs (SPEC §7) before writing; they are greppable and cannot be
 * confused with real Gradle syntax.
 */
export const PLACEHOLDERS = {
  loomVersion: '@MODFORGE_LOOM_VERSION@',
  minecraftVersion: '@MODFORGE_MINECRAFT_VERSION@',
  loaderVersion: '@MODFORGE_LOADER_VERSION@',
  fabricApiVersion: '@MODFORGE_FABRIC_API_VERSION@',
} as const;

// ---------------------------------------------------------------------------
// Text-span model
// ---------------------------------------------------------------------------

/** Source kinds parseGradleModel understands. */
export type GradleFileKind = 'groovy' | 'kts' | 'properties';

/** Absolute character span with 1-based line/col of its start. */
export interface TextSpan {
  start: number;
  end: number;
  line: number;
  col: number;
}

/** Construct kinds the scanner recognizes (everything else → suspects). */
export type GradleConstructKind =
  | 'plugin-id'
  | 'plugin-version'
  | 'mappings-statement'
  | 'dependency-config'
  | 'remapjar-ref'
  | 'java-version'
  | 'property';

/** A recognized construct. `span` is exactly the region a rewrite would touch. */
export interface GradleConstruct {
  kind: GradleConstructKind;
  span: TextSpan;
  /** Raw text of the span. */
  text: string;
  /** Construct-specific payload (e.g. {config:'modApi'} or {key,value}). */
  detail: Record<string, string>;
  /** For 'property': span of the value text (span itself is the whole line). */
  valueSpan?: TextSpan;
}

/** Something that looked relevant but did not match a known shape — never touched. */
export interface SuspectConstruct {
  span: TextSpan;
  text: string;
  reason: string;
}

/** Lexer-grade model of one build file. */
export interface GradleModel {
  kind: GradleFileKind;
  constructs: GradleConstruct[];
  suspects: SuspectConstruct[];
}

/** Loud, offset-precise scan failure (never desync silently). */
export class GradleParseError extends Error {
  offset: number;
  constructor(offset: number, reason: string) {
    super(`gradle scan: ${reason} at offset ${offset}`);
    this.name = 'GradleParseError';
    this.offset = offset;
  }
}

// ---------------------------------------------------------------------------
// Migration plan model
// ---------------------------------------------------------------------------

/** Plan-tier confidence: EXACT = verified mechanical rule; REVIEW = inferred, never auto-applied. */
export type GradleMigrationConfidence = 'EXACT' | 'REVIEW';

/** Input/output file unit (pure data — the CLI owns all I/O). */
export interface GradleSourceFile {
  path: string;
  text: string;
}

/** One planned text rewrite. `before` must still match the file when applied. */
export interface PlannedEdit {
  file: string;
  span: { start: number; end: number; line: number };
  before: string;
  after: string;
  rule: GradleRuleId;
  confidence: GradleMigrationConfidence;
  /** Present on REVIEW edits: why this is inferred rather than verified. */
  note?: string;
}

/** A construct the scanner saw but did not understand — the manual-review remainder. */
export interface UnhandledConstruct {
  file: string;
  span: { start: number; end: number; line: number };
  text: string;
  reason: string;
}

/** Ordered migration plan over a set of files. */
export interface GradleMigrationPlan {
  /** Stably sorted by (file, span.start). */
  edits: PlannedEdit[];
  /** Honesty remainder: everything seen but not understood, stably sorted. */
  manualReview: UnhandledConstruct[];
  /** Original inputs (sorted by path) — required by applyGradleMigration. */
  sources: GradleSourceFile[];
}

// ---------------------------------------------------------------------------
// Lexer (groovy / kts): strings, comments, interpolation
// ---------------------------------------------------------------------------

interface Tok {
  t: 'id' | 'str' | 'num' | 'p';
  start: number;
  end: number;
  /** id/num/p: raw text; str: inner content without quotes. */
  v: string;
  /** str only: quote run length (1 or 3). */
  q: number;
}

function skipBlockComment(text: string, start: number, nests: boolean): number {
  let depth = 1;
  let i = start + 2;
  while (i < text.length) {
    if (text[i] === '*' && text[i + 1] === '/') {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else if (nests && text[i] === '/' && text[i + 1] === '*') {
      depth++;
      i += 2;
    } else {
      i++;
    }
  }
  throw new GradleParseError(start, 'unterminated block comment');
}

function scanString(text: string, start: number, kind: 'groovy' | 'kts'): number {
  const qc = text[start]!;
  const triple = text.startsWith(qc.repeat(3), start);
  const qlen = triple ? 3 : 1;
  const close = qc.repeat(qlen);
  // Kotlin raw strings (""") process no escapes; everything else does.
  const rawKts = kind === 'kts' && triple;
  // $ interpolation exists in groovy GStrings and all kotlin strings; groovy ''' has none.
  const interp = qc === '"';
  let i = start + qlen;
  while (i < text.length) {
    const c = text[i]!;
    if (!rawKts && c === '\\') {
      i += 2;
      continue;
    }
    if (interp && c === '$' && text[i + 1] === '{') {
      i = scanInterpolation(text, i + 1, kind);
      continue;
    }
    if (c === qc && text.startsWith(close, i)) return i + qlen;
    if (!triple && c === '\n') {
      // Single-line strings cannot span newlines in either language. Hitting one
      // means the lexer desynced (e.g. a slashy string) — fail loudly.
      throw new GradleParseError(start, 'single-line string literal spans a newline (lexer desync guard)');
    }
    i++;
  }
  throw new GradleParseError(start, 'unterminated string literal');
}

function scanInterpolation(text: string, braceStart: number, kind: 'groovy' | 'kts'): number {
  let depth = 0;
  let i = braceStart;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      depth--;
      i++;
      if (depth === 0) return i;
    } else if (c === '"' || c === "'") {
      i = scanString(text, i, kind);
    } else if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
    } else if (c === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i, kind === 'kts');
    } else {
      i++;
    }
  }
  throw new GradleParseError(braceStart, 'unterminated string interpolation');
}

function tokenize(text: string, kind: 'groovy' | 'kts'): Tok[] {
  const toks: Tok[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i, kind === 'kts');
      continue;
    }
    if (c === '"' || c === "'") {
      const q = text.startsWith(c.repeat(3), i) ? 3 : 1;
      const end = scanString(text, i, kind);
      toks.push({ t: 'str', start: i, end, v: text.slice(i + q, end - q), q });
      i = end;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i + 1;
      while (j < n && /[0-9._]/.test(text[j]!)) j++;
      toks.push({ t: 'num', start: i, end: j, v: text.slice(i, j), q: 0 });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j]!)) j++;
      toks.push({ t: 'id', start: i, end: j, v: text.slice(i, j), q: 0 });
      i = j;
      continue;
    }
    toks.push({ t: 'p', start: i, end: i + 1, v: c, q: 0 });
    i++;
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Line/col helpers
// ---------------------------------------------------------------------------

function makeLineLookup(text: string): (off: number) => { line: number; col: number } {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= off) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: off - starts[lo]! + 1 };
  };
}

function lineStartOf(text: string, off: number): number {
  return text.lastIndexOf('\n', off - 1) + 1;
}

// ---------------------------------------------------------------------------
// Script scanner (groovy / kts)
// ---------------------------------------------------------------------------

const MOD_CONFIG_RENAMES: Record<string, string> = {
  modImplementation: 'implementation',
  modApi: 'api',
  modCompileOnly: 'compileOnly',
  modRuntimeOnly: 'runtimeOnly',
  modLocalRuntime: 'localRuntime',
};

function scanScript(text: string, kind: 'groovy' | 'kts'): GradleModel {
  const toks = tokenize(text, kind);
  const lookup = makeLineLookup(text);
  const constructs: GradleConstruct[] = [];
  const suspects: SuspectConstruct[] = [];

  const span = (start: number, end: number): TextSpan => {
    const lc = lookup(start);
    return { start, end, line: lc.line, col: lc.col };
  };
  const push = (k: GradleConstructKind, start: number, end: number, detail: Record<string, string>): void => {
    constructs.push({ kind: k, span: span(start, end), text: text.slice(start, end), detail });
  };
  const suspect = (start: number, end: number, reason: string): void => {
    suspects.push({ span: span(start, end), text: text.slice(start, end), reason });
  };

  const nlBetween = (a: Tok, b: Tok): boolean => text.slice(a.end, b.start).includes('\n');
  const stmtStart = (k: number): boolean => {
    const p = toks[k - 1];
    const t = toks[k]!;
    if (!p) return true;
    if (p.t === 'p' && (p.v === '{' || p.v === '}' || p.v === ';')) return true;
    return nlBetween(p, t);
  };

  // Block-label stack: `dependencies { ... }` pushes 'dependencies'. Lexer-grade —
  // the label is the first identifier of the statement that owns the '{'.
  const stack: string[] = [];
  let stmtHead: string | null = null;

  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (stmtStart(k)) stmtHead = t.t === 'id' ? t.v : null;
    if (t.t === 'p' && t.v === '{') {
      stack.push(stmtHead ?? '<block>');
      stmtHead = null;
      continue;
    }
    if (t.t === 'p' && t.v === '}') {
      stack.pop();
      continue;
    }

    // -- plugin id (+ adjacent version literal) --------------------------------
    if (t.t === 'str' && t.v === 'fabric-loom') {
      push('plugin-id', t.start + t.q, t.end - t.q, { id: t.v });
      let j = k + 1;
      if (toks[j]?.t === 'p' && toks[j]!.v === ')') j++;
      if (toks[j]?.t === 'id' && toks[j]!.v === 'version') {
        j++;
        if (toks[j]?.t === 'p' && toks[j]!.v === '(') j++;
        const vs = toks[j];
        if (vs && vs.t === 'str') {
          push('plugin-version', vs.start + vs.q, vs.end - vs.q, { plugin: 'fabric-loom', version: vs.v });
        }
      }
      continue;
    }

    // -- legacy buildscript classpath coordinate (cannot rewrite mechanically) --
    if (t.t === 'str' && t.v.includes(':fabric-loom:')) {
      suspect(t.start, t.end, 'legacy buildscript-classpath loom coordinate — migrate to the plugins DSL manually (id + version), then rerun.');
      continue;
    }

    // -- version-catalog plugin alias (toml not visible to this scanner) --------
    if (t.t === 'id' && t.v === 'alias' && toks[k + 1]?.v === '(' && toks[k + 2]?.t === 'id' && toks[k + 2]!.v === 'libs') {
      let depth = 0;
      let end = t.end;
      for (let j = k + 1; j < toks.length; j++) {
        const u = toks[j]!;
        if (u.t === 'p' && u.v === '(') depth++;
        else if (u.t === 'p' && u.v === ')') {
          depth--;
          if (depth === 0) {
            end = u.end;
            break;
          }
        }
      }
      if (text.slice(t.start, end).includes('loom')) {
        suspect(t.start, end, 'loom applied via version catalog alias — ModForge cannot see libs.versions.toml; update the plugin id/version there manually.');
      }
      continue;
    }

    // -- mappings statement (delete entirely) -----------------------------------
    if (t.t === 'id' && t.v === 'mappings' && stmtStart(k)) {
      if (stack.includes('dependencies')) {
        // Statement extent: consume tokens until a newline boundary at bracket depth 0.
        let depth = 0;
        let endTok: Tok = t;
        for (let j = k + 1; j < toks.length; j++) {
          const u = toks[j]!;
          if (depth === 0 && nlBetween(toks[j - 1]!, u)) break;
          if (u.t === 'p' && (u.v === '(' || u.v === '{' || u.v === '[')) depth++;
          else if (u.t === 'p' && (u.v === ')' || u.v === '}' || u.v === ']')) depth--;
          endTok = u;
        }
        const ls = lineStartOf(text, t.start);
        const nl = text.indexOf('\n', endTok.end);
        const le = nl === -1 ? text.length : nl + 1;
        push('mappings-statement', ls, le, {});
      } else {
        suspect(t.start, t.end, 'a `mappings` statement outside a dependencies block — shape not understood; left untouched.');
      }
      continue;
    }

    // -- dependency configuration renames ---------------------------------------
    if (t.t === 'id' && MOD_CONFIG_RENAMES[t.v] !== undefined) {
      if (stmtStart(k) && stack.includes('dependencies')) {
        push('dependency-config', t.start, t.end, { config: t.v });
      } else {
        suspect(t.start, t.end, `\`${t.v}\` referenced outside a dependencies-block statement — left untouched; rename manually if it is the loom configuration.`);
      }
      continue;
    }
    // Unknown mod*-prefixed configs are loom-era smells but not in the verified table.
    if (t.t === 'id' && /^mod[A-Z]/.test(t.v) && stmtStart(k) && stack.includes('dependencies')) {
      suspect(t.start, t.end, `unknown \`${t.v}\` dependency configuration — not in the verified rename table; review manually.`);
      continue;
    }

    // -- remapJar references ------------------------------------------------------
    if (t.t === 'id' && t.v === 'remapJar') {
      push('remapjar-ref', t.start, t.end, { form: 'identifier' });
      continue;
    }
    if (t.t === 'str' && t.v === 'remapJar') {
      push('remapjar-ref', t.start + t.q, t.end - t.q, { form: 'string' });
      continue;
    }

    // -- Java version shapes -------------------------------------------------------
    if (t.t === 'id' && t.v === 'JavaVersion' && toks[k + 1]?.v === '.' && toks[k + 2]?.t === 'id' && /^VERSION_[0-9_]+$/.test(toks[k + 2]!.v)) {
      const u = toks[k + 2]!;
      push('java-version', u.start, u.end, { shape: 'enum', value: u.v.slice('VERSION_'.length) });
      k += 2;
      continue;
    }
    if (t.t === 'id' && t.v === 'JavaLanguageVersion' && toks[k + 1]?.v === '.' && toks[k + 2]?.v === 'of' && toks[k + 3]?.v === '(' && toks[k + 4]?.t === 'num') {
      const u = toks[k + 4]!;
      push('java-version', u.start, u.end, { shape: 'toolchain', value: u.v });
      k += 4;
      continue;
    }
    if (t.t === 'id' && t.v === 'jvmToolchain' && toks[k + 1]?.v === '(' && toks[k + 2]?.t === 'num') {
      const u = toks[k + 2]!;
      push('java-version', u.start, u.end, { shape: 'toolchain', value: u.v });
      k += 2;
      continue;
    }
    if (t.t === 'id' && t.v === 'release') {
      const a = toks[k + 1];
      const b = toks[k + 2];
      if (a?.v === '=' && b?.t === 'num') {
        push('java-version', b.start, b.end, { shape: 'release', value: b.v });
        k += 2;
      } else if (a?.v === '.' && b?.t === 'id' && b.v === 'set' && toks[k + 3]?.v === '(' && toks[k + 4]?.t === 'num') {
        const u = toks[k + 4]!;
        push('java-version', u.start, u.end, { shape: 'release', value: u.v });
        k += 4;
      }
      continue;
    }
    if (t.t === 'id' && (t.v === 'sourceCompatibility' || t.v === 'targetCompatibility')) {
      const a = toks[k + 1];
      const b = toks[k + 2];
      if (a?.v === '=' && b) {
        if (b.t === 'num') {
          push('java-version', b.start, b.end, { shape: 'compat', value: b.v });
          k += 2;
        } else if (b.t === 'str') {
          push('java-version', b.start + b.q, b.end - b.q, { shape: 'compat', value: b.v });
          k += 2;
        }
        // `= JavaVersion.VERSION_x` is handled by the enum shape when the loop reaches it.
      }
      continue;
    }
  }

  return { kind, constructs, suspects };
}

// ---------------------------------------------------------------------------
// gradle.properties scanner
// ---------------------------------------------------------------------------

function scanProperties(text: string): GradleModel {
  const lookup = makeLineLookup(text);
  const constructs: GradleConstruct[] = [];
  const suspects: SuspectConstruct[] = [];
  const span = (start: number, end: number): TextSpan => {
    const lc = lookup(start);
    return { start, end, line: lc.line, col: lc.col };
  };

  let lineStart = 0;
  while (lineStart < text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const lineEndIncl = nl === -1 ? text.length : nl + 1;
    let raw = text.slice(lineStart, lineEnd);
    if (raw.endsWith('\r')) raw = raw.slice(0, -1);
    const trimmed = raw.trim();

    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) {
      lineStart = lineEndIncl;
      continue;
    }
    if (trimmed.endsWith('\\')) {
      // java.util.Properties line continuations — out of scope for the known keys.
      suspects.push({ span: span(lineStart, lineEnd), text: raw, reason: 'properties line continuation (trailing backslash) not supported — left untouched.' });
      lineStart = lineEndIncl;
      continue;
    }
    const m = /^([ \t]*)([A-Za-z0-9_.\-]+)([ \t]*[=:][ \t]*)(.*)$/.exec(raw);
    if (!m) {
      suspects.push({ span: span(lineStart, lineEnd), text: raw, reason: 'unparsed gradle.properties line — left untouched.' });
      lineStart = lineEndIncl;
      continue;
    }
    const valueStart = lineStart + m[1]!.length + m[2]!.length + m[3]!.length;
    const valueEnd = valueStart + m[4]!.length;
    const construct: GradleConstruct = {
      kind: 'property',
      span: span(lineStart, lineEndIncl),
      text: text.slice(lineStart, lineEndIncl),
      detail: { key: m[2]!, value: m[4]! },
      valueSpan: span(valueStart, valueEnd),
    };
    constructs.push(construct);
    lineStart = lineEndIncl;
  }
  return { kind: 'properties', constructs, suspects };
}

// ---------------------------------------------------------------------------
// Public model API
// ---------------------------------------------------------------------------

/**
 * Lexer-grade scan of one build file into a text-span model. Strings/comments
 * are masked correctly; only known construct shapes are recognized; anything
 * relevant-looking outside those shapes lands in `suspects` (manual review).
 * Throws GradleParseError (offset + reason) on lexical desync — never guesses.
 */
export function parseGradleModel(text: string, kind: GradleFileKind): GradleModel {
  if (kind === 'properties') return scanProperties(text);
  return scanScript(text, kind);
}

// ---------------------------------------------------------------------------
// AW / ClassTweaker header
// ---------------------------------------------------------------------------

/**
 * Plan the accessWidener/classTweaker header namespace rewrite (`named`→`official`).
 * EXACT for accessWidener v2 and classTweaker (the verified rule); accessWidener v1
 * is emitted as REVIEW. Pure function — no I/O.
 */
export function planAwCtHeaderEdits(path: string, text: string): { edits: PlannedEdit[]; manualReview: UnhandledConstruct[] } {
  const edits: PlannedEdit[] = [];
  const manualReview: UnhandledConstruct[] = [];
  const nl = text.indexOf('\n');
  let firstLine = nl === -1 ? text : text.slice(0, nl);
  if (firstLine.endsWith('\r')) firstLine = firstLine.slice(0, -1);

  const m = /^(accessWidener|classTweaker)([ \t]+)(v\d+)([ \t]+)([A-Za-z0-9_]+)[ \t]*$/.exec(firstLine);
  if (!m) {
    manualReview.push({
      file: path,
      span: { start: 0, end: firstLine.length, line: 1 },
      text: firstLine,
      reason: 'unrecognized accessWidener/classTweaker header — left untouched.',
    });
    return { edits, manualReview };
  }
  const format = m[1]!;
  const version = m[3]!;
  const ns = m[5]!;
  if (ns === 'official') return { edits, manualReview }; // already migrated
  if (ns !== 'named') {
    manualReview.push({
      file: path,
      span: { start: 0, end: firstLine.length, line: 1 },
      text: firstLine,
      reason: `unknown namespace '${ns}' in ${format} header — the verified rule covers 'named' → 'official' only.`,
    });
    return { edits, manualReview };
  }
  const nsStart = m[1]!.length + m[2]!.length + m[3]!.length + m[4]!.length;
  const review = format === 'accessWidener' && version !== 'v2';
  const edit: PlannedEdit = {
    file: path,
    span: { start: nsStart, end: nsStart + ns.length, line: 1 },
    before: ns,
    after: 'official',
    rule: 'aw-ct-header-official',
    confidence: review ? 'REVIEW' : 'EXACT',
  };
  if (review) edit.note = `header is ${version}: the verified porting rule covers accessWidener v2 — verify loader support for ${version} with the official namespace.`;
  edits.push(edit);
  return { edits, manualReview };
}

// ---------------------------------------------------------------------------
// Mixin config JSON (span-precise, JSON-aware)
// ---------------------------------------------------------------------------

function scanJsonString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    if (c === '\n') throw new GradleParseError(start, 'newline inside JSON string');
    i++;
  }
  throw new GradleParseError(start, 'unterminated JSON string');
}

interface JsonMember {
  key: string;
  memberStart: number;
  valueStart: number;
  valueEnd: number;
  /** Offset of the comma after/before this member at depth 1, or -1. */
  commaAfter: number;
  commaBefore: number;
}

function scanTopLevelMembers(text: string): JsonMember[] {
  const ws = (i: number): number => {
    while (i < text.length && /[ \t\r\n]/.test(text[i]!)) i++;
    return i;
  };
  let i = ws(0);
  if (text[i] !== '{') throw new GradleParseError(i, 'expected top-level JSON object');
  i = ws(i + 1);
  const members: JsonMember[] = [];
  let lastComma = -1;
  if (text[i] === '}') return members;
  for (;;) {
    if (text[i] !== '"') throw new GradleParseError(i, 'expected JSON object key');
    const keyStart = i;
    const keyEnd = scanJsonString(text, i);
    const key = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = ws(keyEnd);
    if (text[i] !== ':') throw new GradleParseError(i, "expected ':' after JSON key");
    i = ws(i + 1);
    const valueStart = i;
    // Walk the value: bracket depth + strings; ends at ',' or '}' at depth 0.
    let depth = 0;
    let lastNonWs = i;
    let term = -1;
    let termChar = '';
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        i = scanJsonString(text, i);
        lastNonWs = i - 1;
        continue;
      }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        if (depth === 0 && c === '}') {
          term = i;
          termChar = '}';
          break;
        }
        depth--;
      } else if (c === ',' && depth === 0) {
        term = i;
        termChar = ',';
        break;
      }
      if (!/[ \t\r\n]/.test(c)) lastNonWs = i;
      i++;
    }
    if (term === -1) throw new GradleParseError(valueStart, 'unterminated JSON value');
    members.push({ key, memberStart: keyStart, valueStart, valueEnd: lastNonWs + 1, commaAfter: termChar === ',' ? term : -1, commaBefore: lastComma });
    if (termChar === '}') break;
    lastComma = term;
    i = ws(term + 1);
    if (text[i] === '}') break; // tolerated trailing comma (JSON.parse will have rejected it earlier anyway)
  }
  return members;
}

/**
 * Plan the mixin-config JSON edits: compatibilityLevel → "JAVA_25" and the
 * refmap member deleted (span-precise on the original text; whitespace-clean
 * where the member owns its line). The planned result is re-validated with
 * JSON.parse — if it would not parse, the edits are withheld and reported as
 * manual review instead (never emit a corrupting edit).
 */
export function planMixinConfigEdits(path: string, text: string): { edits: PlannedEdit[]; manualReview: UnhandledConstruct[] } {
  const edits: PlannedEdit[] = [];
  const manualReview: UnhandledConstruct[] = [];
  const lookup = makeLineLookup(text);

  let members: JsonMember[];
  try {
    JSON.parse(text);
    members = scanTopLevelMembers(text);
  } catch (e) {
    const offset = e instanceof GradleParseError ? e.offset : 0;
    manualReview.push({
      file: path,
      span: { start: offset, end: offset, line: lookup(offset).line },
      text: '',
      reason: `mixin config is not valid JSON (${e instanceof Error ? e.message : String(e)}) — left untouched.`,
    });
    return { edits, manualReview };
  }

  for (const mem of members) {
    if (mem.key === 'compatibilityLevel') {
      const v = text.slice(mem.valueStart, mem.valueEnd);
      if (!v.startsWith('"')) {
        manualReview.push({
          file: path,
          span: { start: mem.valueStart, end: mem.valueEnd, line: lookup(mem.valueStart).line },
          text: v,
          reason: 'compatibilityLevel is not a JSON string — left untouched.',
        });
      } else if (v !== '"JAVA_25"') {
        edits.push({
          file: path,
          span: { start: mem.valueStart, end: mem.valueEnd, line: lookup(mem.valueStart).line },
          before: v,
          after: '"JAVA_25"',
          rule: 'mixin-compat-level',
          confidence: 'EXACT',
        });
      }
    } else if (mem.key === 'refmap') {
      let s = mem.memberStart;
      let e = mem.commaAfter !== -1 ? mem.commaAfter + 1 : mem.valueEnd;
      if (mem.commaAfter === -1 && mem.commaBefore !== -1) s = mem.commaBefore;
      // Cosmetic: when the member owns its whole line(s), delete the line(s).
      const ls = lineStartOf(text, s);
      if (text.slice(ls, s).trim() === '') {
        const nl = text.indexOf('\n', e);
        const rest = nl === -1 ? text.slice(e) : text.slice(e, nl);
        if (rest.trim() === '') {
          s = ls;
          e = nl === -1 ? text.length : nl + 1;
        }
      }
      edits.push({
        file: path,
        span: { start: s, end: e, line: lookup(s).line },
        before: text.slice(s, e),
        after: '',
        rule: 'mixin-refmap-delete',
        confidence: 'EXACT',
      });
    }
  }

  // Defensive re-validation: the post-edit text must still be valid JSON.
  if (edits.length > 0) {
    const applied = spliceEdits(text, edits);
    try {
      JSON.parse(applied);
    } catch {
      manualReview.push({
        file: path,
        span: { start: 0, end: 0, line: 1 },
        text: '',
        reason: 'internal guard: planned mixin-config edits would produce invalid JSON — edits withheld; review the file manually.',
      });
      return { edits: [], manualReview };
    }
  }
  return { edits, manualReview };
}

// ---------------------------------------------------------------------------
// Plan + apply
// ---------------------------------------------------------------------------

type FileClass = 'groovy' | 'kts' | 'properties' | 'aw-ct' | 'mixin-json' | 'json' | 'unsupported';

function classifyPath(path: string): FileClass {
  const base = path.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  if (base.endsWith('.gradle.kts') || base.endsWith('.kts')) return 'kts';
  if (base.endsWith('.gradle')) return 'groovy';
  if (base === 'gradle.properties') return 'properties';
  if (base.endsWith('.accesswidener') || base.endsWith('.classtweaker')) return 'aw-ct';
  if (base.endsWith('.mixins.json')) return 'mixin-json';
  if (base.endsWith('.json')) return 'json';
  return 'unsupported';
}

function spliceEdits(text: string, edits: PlannedEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.span.start - a.span.start);
  let out = text;
  for (const e of sorted) {
    const actual = out.slice(e.span.start, e.span.end);
    if (actual !== e.before) {
      throw new Error(`gradle apply: plan is stale for ${e.file} at offset ${e.span.start}: expected ${JSON.stringify(e.before)}, found ${JSON.stringify(actual)}`);
    }
    out = out.slice(0, e.span.start) + e.after + out.slice(e.span.end);
  }
  return out;
}

function editsForScriptModel(file: string, text: string, model: GradleModel, edits: PlannedEdit[], manual: UnhandledConstruct[]): void {
  const planSpan = (s: TextSpan) => ({ start: s.start, end: s.end, line: s.line });
  const add = (s: TextSpan, after: string, rule: GradleRuleId, confidence: GradleMigrationConfidence, note?: string): void => {
    const before = text.slice(s.start, s.end);
    if (before === after) return; // already migrated — idempotency
    const edit: PlannedEdit = { file, span: planSpan(s), before, after, rule, confidence };
    if (note !== undefined) edit.note = note;
    edits.push(edit);
  };

  for (const c of model.constructs) {
    switch (c.kind) {
      case 'plugin-id':
        add(c.span, 'net.fabricmc.fabric-loom', 'plugin-id', 'EXACT');
        break;
      case 'plugin-version':
        add(c.span, PLACEHOLDERS.loomVersion, 'plugin-version', 'EXACT');
        break;
      case 'mappings-statement':
        add(c.span, '', 'mappings-delete', 'EXACT');
        break;
      case 'dependency-config': {
        const from = c.detail['config'] ?? '';
        const to = MOD_CONFIG_RENAMES[from];
        if (to === undefined) break; // cannot happen by construction
        if (from === 'modLocalRuntime') {
          add(c.span, to, 'dep-config-local-runtime', 'REVIEW', 'modLocalRuntime → localRuntime is flagged for verification by the porting docs rule set.');
        } else {
          add(c.span, to, 'dep-config-rename', 'EXACT');
        }
        break;
      }
      case 'remapjar-ref':
        add(c.span, 'jar', 'remapjar-to-jar', 'EXACT');
        break;
      case 'java-version': {
        const value = c.detail['value'] ?? '';
        const shape = c.detail['shape'] ?? '';
        const after = shape === 'enum' ? 'VERSION_25' : '25';
        if (value === '25') break;
        if (value === '21') {
          add(c.span, after, 'java-25', 'EXACT');
        } else {
          add(c.span, after, 'java-25', 'REVIEW', `found Java version ${value.replace(/_/g, '.')}; 26.x requires Java 25 — proposed rewrite, but the verified rule covers 21 → 25 only.`);
        }
        break;
      }
      case 'property':
        break; // properties handled by editsForPropertiesModel
    }
  }
  for (const s of model.suspects) {
    manual.push({ file, span: { start: s.span.start, end: s.span.end, line: s.span.line }, text: s.text, reason: s.reason });
  }
}

function editsForPropertiesModel(file: string, text: string, model: GradleModel, edits: PlannedEdit[], manual: UnhandledConstruct[]): void {
  const addValue = (c: GradleConstruct, after: string, rule: GradleRuleId): void => {
    const vs = c.valueSpan;
    if (!vs) return;
    const before = text.slice(vs.start, vs.end);
    if (before === after) return;
    edits.push({ file, span: { start: vs.start, end: vs.end, line: vs.line }, before, after, rule, confidence: 'EXACT' });
  };
  for (const c of model.constructs) {
    if (c.kind !== 'property') continue;
    const key = c.detail['key'] ?? '';
    switch (key) {
      case 'yarn_mappings':
        edits.push({
          file,
          span: { start: c.span.start, end: c.span.end, line: c.span.line },
          before: c.text,
          after: '',
          rule: 'props-yarn-mappings-delete',
          confidence: 'EXACT',
        });
        break;
      case 'minecraft_version':
        addValue(c, PLACEHOLDERS.minecraftVersion, 'props-minecraft-version');
        break;
      case 'loader_version':
        addValue(c, PLACEHOLDERS.loaderVersion, 'props-loader-version');
        break;
      case 'fabric_version':
      case 'fabric_api_version':
        addValue(c, PLACEHOLDERS.fabricApiVersion, 'props-fabric-api-version');
        break;
      case 'loom_version':
        addValue(c, PLACEHOLDERS.loomVersion, 'plugin-version');
        break;
      default:
        break; // unrelated property — untouched, not noise-reported
    }
  }
  for (const s of model.suspects) {
    manual.push({ file, span: { start: s.span.start, end: s.span.end, line: s.span.line }, text: s.text, reason: s.reason });
  }
}

const byFileStart = (a: { file: string; span: { start: number; end: number } }, b: { file: string; span: { start: number; end: number } }): number =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.span.start - b.span.start || a.span.end - b.span.end;

/**
 * Build the migration plan for a set of project files (build scripts,
 * gradle.properties, accessWidener/classTweaker files, mixin config JSONs).
 *
 * Every edit from the verified porting-docs rule set is EXACT; inferred edits
 * (modLocalRuntime, non-21 Java versions, accessWidener v1) are REVIEW and are
 * not applied by default. Files that fail to lex are reported whole in
 * `manualReview` and receive zero edits. Output ordering is stable.
 */
export function planGradleMigration(files: GradleSourceFile[]): GradleMigrationPlan {
  const sources = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const edits: PlannedEdit[] = [];
  const manualReview: UnhandledConstruct[] = [];

  for (const f of sources) {
    const fileEdits: PlannedEdit[] = [];
    const fileManual: UnhandledConstruct[] = [];
    const cls = classifyPath(f.path);
    try {
      switch (cls) {
        case 'groovy':
        case 'kts': {
          editsForScriptModel(f.path, f.text, scanScript(f.text, cls), fileEdits, fileManual);
          break;
        }
        case 'properties': {
          editsForPropertiesModel(f.path, f.text, scanProperties(f.text), fileEdits, fileManual);
          break;
        }
        case 'aw-ct': {
          const r = planAwCtHeaderEdits(f.path, f.text);
          fileEdits.push(...r.edits);
          fileManual.push(...r.manualReview);
          break;
        }
        case 'mixin-json': {
          const r = planMixinConfigEdits(f.path, f.text);
          fileEdits.push(...r.edits);
          fileManual.push(...r.manualReview);
          break;
        }
        case 'json': {
          // Only treat as mixin config when the shape proves it (a "package" key).
          let isMixin = false;
          try {
            const obj = JSON.parse(f.text) as unknown;
            isMixin = typeof obj === 'object' && obj !== null && typeof (obj as Record<string, unknown>)['package'] === 'string';
          } catch {
            isMixin = false;
          }
          if (isMixin) {
            const r = planMixinConfigEdits(f.path, f.text);
            fileEdits.push(...r.edits);
            fileManual.push(...r.manualReview);
          } else {
            fileManual.push({ file: f.path, span: { start: 0, end: 0, line: 1 }, text: '', reason: 'JSON file is not a recognized mixin config (no "package" key) — left untouched.' });
          }
          break;
        }
        case 'unsupported':
          fileManual.push({ file: f.path, span: { start: 0, end: 0, line: 1 }, text: '', reason: 'unsupported file type for gradle migration — left untouched.' });
          break;
      }
    } catch (e) {
      if (e instanceof GradleParseError) {
        // Whole-file honesty: a lex failure voids all edits for this file.
        fileEdits.length = 0;
        const line = makeLineLookup(f.text)(Math.min(e.offset, f.text.length)).line;
        fileManual.push({ file: f.path, span: { start: e.offset, end: e.offset, line }, text: '', reason: `file could not be scanned (${e.message}) — left untouched.` });
      } else {
        throw e;
      }
    }

    // Drop edits fully contained inside a deletion of the same file (deletion wins).
    const deletions = fileEdits.filter((e) => e.after === '');
    const kept = fileEdits.filter(
      (e) => !deletions.some((d) => d !== e && d.span.start <= e.span.start && e.span.end <= d.span.end),
    );
    kept.sort(byFileStart);
    for (let i = 1; i < kept.length; i++) {
      const a = kept[i - 1]!;
      const b = kept[i]!;
      if (b.span.start < a.span.end) {
        // Overlapping rewrites are an engine bug — refuse to emit a corrupting plan.
        throw new Error(`gradle plan: internal overlap in ${f.path} between [${a.span.start},${a.span.end}) and [${b.span.start},${b.span.end})`);
      }
    }
    edits.push(...kept);
    manualReview.push(...fileManual);
  }

  edits.sort(byFileStart);
  manualReview.sort(byFileStart);
  return { edits, manualReview, sources };
}

/** applyGradleMigration options. */
export interface ApplyOptions {
  /**
   * Also apply REVIEW edits. Default false — REVIEW is the CANDIDATE tier of
   * this module and is never auto-applied (honesty taxonomy).
   */
  includeReview?: boolean;
}

/**
 * Pure application of a plan: returns new file texts (the CLI writes them).
 * Applies EXACT edits only unless `includeReview` is set. Throws if any edit's
 * `before` no longer matches the source (stale plan) — never patches blindly.
 */
export function applyGradleMigration(plan: GradleMigrationPlan, opts: ApplyOptions = {}): GradleSourceFile[] {
  const includeReview = opts.includeReview ?? false;
  return plan.sources.map((src) => {
    const fileEdits = plan.edits.filter((e) => e.file === src.path && (e.confidence === 'EXACT' || includeReview));
    return { path: src.path, text: fileEdits.length === 0 ? src.text : spliceEdits(src.text, fileEdits) };
  });
}
