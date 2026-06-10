/**
 * Mixin surface scanner — extracts the SIX rename-sensitive mixin surfaces
 * (SPEC §4 "The Mixin Verifier") from mod source files and mixin config JSONs:
 *
 *   1. config class lists        → `MixinConfig.allClasses` (the mod's OWN mixin classes)
 *   2. `@Mixin` targets          → `MixinClassScan.targets` (class literals + `targets=` strings)
 *   3. injector `method=` strings→ `InjectorScan.methodSpecs`
 *   4. `@At` member-info strings → `InjectorScan.atTargets` (INVOKE/FIELD targets)
 *   5. @Shadow/@Accessor/@Invoker→ `MixinClassScan.shadowMembers` (implied target members)
 *   6. descriptor strings        → carried inside surfaces 3–4 as parsed JVM descriptors
 *
 * Extraction is LEXICAL (comment-stripped, string-aware token scanning — no full Java
 * parse). The honesty contract for that limitation:
 *  - anything structurally ambiguous (computed strings, constant references, `@Desc`
 *    selectors, unbalanced syntax) is surfaced as `unparseable` WITH its raw text and a
 *    precise reason — never dropped silently and never guessed at;
 *  - class-literal resolution via imports cannot always place inner-class `$` separators
 *    (Java's `a.b.Outer.Inner` is lexically identical to a package chain) — such refs are
 *    resolved with an explicit "verify" note;
 *  - member descriptors are only known when written literally in the annotation string;
 *    source-level Java types are NOT compiled to descriptors here (that join happens in
 *    the report layer against ground truth).
 *
 * The verification CONTRACT is `MixinTargetCheck`: this module produces checks; the
 * report layer resolves each `ref` through bridge/delta and (for at-invoke/at-field)
 * instruction-level bytecode verification before anything is called EXACT.
 *
 * Determinism: all outputs are stably ordered (configs by path, checks by
 * file/line/surface/ref); no clock or randomness anywhere.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JarApi } from '../core/model.ts';

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

/** The rename-sensitive mixin surfaces, plus the honest bucket for ambiguity. */
export type MixinSurface =
  | 'mixin-target'
  | 'method-spec'
  | 'at-invoke'
  | 'at-field'
  | 'shadow'
  | 'accessor'
  | 'invoker'
  | 'unparseable';

/**
 * One verification work item: "this mixin construct references this symbol".
 * Produced here; verified in the report layer (bridge/delta + instruction-level
 * check for at-invoke/at-field). `ref.owner` absent means the owner is implied
 * by the enclosing `@Mixin` target class(es).
 */
export interface MixinTargetCheck {
  surface: MixinSurface;
  /** Dotted fully-qualified name of the mixin class the check originates from. */
  mixinClass: string;
  /** Normalized (forward-slash) source/config file path as given to the scanner. */
  file: string;
  /** 1-based line in the source file. */
  line: number;
  /** The referenced symbol. Binary owner name; JVM descriptor when literally present. */
  ref: { owner?: string; name?: string; desc?: string };
  /** Honest qualifications: implied owners, wildcard selectors, inference notes. */
  note?: string;
  /** Original source text — always present for `unparseable` (never dropped). */
  raw?: string;
}

/**
 * Structured parse of Mixin's MemberInfo grammar:
 *   `La/b/C;name(Largs;)V` · `name(Largs;)V` · `name` · `La/b/C;field:LType;` · `field:LType;`
 * `kind: 'unknown'` with no `error` is the legal bare-name form (method OR field —
 * the annotation context decides); with `error` set the string was unparseable and
 * `raw` preserves it verbatim.
 */
export interface MemberInfoParse {
  raw: string;
  kind: 'method' | 'field' | 'unknown';
  /** Owner binary name (slashes), when the `L...;` prefix was present. */
  owner?: string;
  name?: string;
  /** Method descriptor `(args)ret` or field type descriptor, validated token-by-token. */
  desc?: string;
  /** Precise parse failure reason — set iff the string did not match the grammar. */
  error?: string;
}

/** One parsed `method=` target selector of an injector annotation. */
export interface MixinMethodSpec {
  raw: string;
  parsed: MemberInfoParse;
  /** True when the name contains `*` — matches multiple methods, never a single exact ref. */
  wildcard: boolean;
  /** Mixin quantifier suffix (`{N}` / `{N,M}`) when present, stripped before parsing. */
  quantifier?: string;
}

/** One `@At(...)` occurrence (including those nested in `slice=@Slice(from/to=...)`). */
export interface AtRef {
  line: number;
  /** Injection point id (INVOKE / FIELD / HEAD / ...) when given as a literal. */
  value?: string;
  /** Parsed `target=` MemberInfo when present (may carry `error` — never dropped). */
  target?: MemberInfoParse;
  raw: string;
  note?: string;
}

/** One injector annotation site (@Inject family, @Overwrite, MixinExtras). */
export interface InjectorScan {
  annotation: string;
  line: number;
  /** Parsed `method=` selectors (synthesized from the handler name for @Overwrite). */
  methodSpecs: MixinMethodSpec[];
  /** Every `@At` found anywhere in the annotation arguments (incl. slices). */
  atTargets: AtRef[];
  /** Name of the annotated handler method, when lexically determinable. */
  handler?: string;
  notes: string[];
}

/** One @Shadow/@Accessor/@Invoker member: implies a member of the TARGET class. */
export interface ShadowMemberScan {
  annotation: 'Shadow' | 'Accessor' | 'Invoker';
  line: number;
  /** Declared member name in the mixin source, when determinable. */
  member?: string;
  /** True when the declared member is a method, when determinable. */
  isMethod?: boolean;
  /**
   * Implied member name on the target class: explicit annotation value, prefix-stripped
   * shadow name, or bean-style inference (get/is/set → field, call/invoke → method —
   * the documented Mixin inference rule, applied deterministically).
   */
  impliedName?: string;
  note?: string;
}

/** One `@Mixin` target-class reference. */
export interface MixinTargetRef {
  line: number;
  how: 'class-literal' | 'targets-string';
  raw: string;
  /** Target class binary name — absent when resolution failed (see `note`). */
  binaryName?: string;
  note?: string;
}

/** A construct we refused to interpret — raw text + precise reason, never dropped. */
export interface UnparseableSurface {
  line: number;
  /** Where it occurred, e.g. `@Inject.method` or `@Mixin.targets`. */
  context: string;
  raw: string;
  reason: string;
}

/** Everything extracted from one `@Mixin`-annotated class. */
export interface MixinClassScan {
  file: string;
  /** Dotted fully-qualified name of the mixin class itself. */
  mixinClass: string;
  line: number;
  targets: MixinTargetRef[];
  injectors: InjectorScan[];
  shadowMembers: ShadowMemberScan[];
  unparseable: UnparseableSurface[];
}

/** Parsed mixin config JSON (surface #1: the config class lists). */
export interface MixinConfig {
  file: string;
  /** Dotted base package for all list entries. */
  package: string;
  mixins: string[];
  client: string[];
  server: string[];
  compatibilityLevel?: string;
  refmap?: string;
  minVersion?: string;
  plugin?: string;
  /** Fully-qualified (dotted) mixin class names from all three lists, stably sorted. */
  allClasses: { name: string; side: 'common' | 'client' | 'server' }[];
}

export interface MixinConfigError {
  file: string;
  error: string;
}

export interface MixinConfigScan {
  configs: MixinConfig[];
  errors: MixinConfigError[];
}

// ---------------------------------------------------------------------------
// MemberInfo grammar
// ---------------------------------------------------------------------------

/** One JVM type token starting at `i`; returns the index after it or an error. */
function scanType(s: string, i: number): { next: number } | { error: string } {
  const c = s[i];
  if (c === undefined) return { error: `unexpected end of descriptor at offset ${i}` };
  if ('BCDFIJSZ'.includes(c)) return { next: i + 1 };
  if (c === '[') return scanType(s, i + 1);
  if (c === 'L') {
    const semi = s.indexOf(';', i);
    if (semi === -1) return { error: `unterminated class type (missing ';') at offset ${i}` };
    const body = s.slice(i + 1, semi);
    if (!/^[\w$/]+$/.test(body)) return { error: `invalid class name '${body}' at offset ${i}` };
    return { next: semi + 1 };
  }
  return { error: `invalid type char '${c}' at offset ${i}` };
}

function validateMethodDesc(desc: string): string | null {
  if (!desc.startsWith('(')) return "must start with '('";
  let i = 1;
  while (i < desc.length && desc[i] !== ')') {
    const r = scanType(desc, i);
    if ('error' in r) return r.error;
    i = r.next;
  }
  if (desc[i] !== ')') return "missing ')'";
  i++;
  if (i >= desc.length) return 'missing return type';
  if (desc[i] === 'V') return i + 1 === desc.length ? null : `trailing characters after return type at offset ${i + 1}`;
  const r = scanType(desc, i);
  if ('error' in r) return r.error;
  return r.next === desc.length ? null : `trailing characters at offset ${r.next}`;
}

function validateFieldDesc(desc: string): string | null {
  if (desc === 'V') return "'V' is not a valid field type";
  const r = scanType(desc, 0);
  if ('error' in r) return r.error;
  return r.next === desc.length ? null : `trailing characters at offset ${r.next}`;
}

const MEMBER_NAME_RE = /^(<init>|<clinit>|\*|[A-Za-z_$][\w$]*\*?)$/;

/**
 * Parse a Mixin MemberInfo string (used by `@At(target=...)` and `method=` selectors).
 * Whitespace is ignored (matching Mixin's own parser). Unparseable input returns
 * `{raw, kind:'unknown', error}` — the raw text is always preserved.
 */
export function parseMemberInfo(raw: string): MemberInfoParse {
  const s = raw.replace(/\s+/g, '');
  const fail = (error: string): MemberInfoParse => ({ raw, kind: 'unknown', error });
  if (s === '') return fail('empty member-info string');

  let owner: string | undefined;
  let rest = s;
  // Owner prefix `L<binary name>;` — member names cannot contain ';', so any
  // leading L<ident-chars>; is unambiguously an owner.
  if (s.startsWith('L')) {
    const semi = s.indexOf(';');
    if (semi > 1) {
      const body = s.slice(1, semi);
      if (/^[\w$/.]+$/.test(body)) {
        owner = body.replace(/\./g, '/');
        rest = s.slice(semi + 1);
      }
    }
  }
  if (rest === '') return fail('owner prefix without a member name');

  const done = (p: MemberInfoParse): MemberInfoParse => {
    if (owner !== undefined) p.owner = owner;
    return p;
  };

  const paren = rest.indexOf('(');
  if (paren !== -1) {
    const name = rest.slice(0, paren);
    const desc = rest.slice(paren);
    if (!MEMBER_NAME_RE.test(name)) return fail(`invalid method name '${name}'`);
    const err = validateMethodDesc(desc);
    if (err !== null) return fail(`bad method descriptor '${desc}': ${err}`);
    return done({ raw, kind: 'method', name, desc });
  }
  const colon = rest.indexOf(':');
  if (colon !== -1) {
    const name = rest.slice(0, colon);
    const desc = rest.slice(colon + 1);
    if (!MEMBER_NAME_RE.test(name)) return fail(`invalid field name '${name}'`);
    const err = validateFieldDesc(desc);
    if (err !== null) return fail(`bad field type '${desc}': ${err}`);
    return done({ raw, kind: 'field', name, desc });
  }
  if (!MEMBER_NAME_RE.test(rest)) return fail(`invalid member name '${rest}'`);
  // Bare name: legal form; method vs field is undecidable from the string alone.
  return done({ raw, kind: 'unknown', name: rest });
}

/**
 * Parse one injector `method=` selector. Handles Mixin quantifier suffixes
 * (`{N}`/`{N,M}`) and flags `*` wildcards (which can never be a single exact ref).
 */
export function parseMethodSpec(raw: string): MixinMethodSpec {
  let s = raw.replace(/\s+/g, '');
  let quantifier: string | undefined;
  const qm = /\{\d*(?:,\d*)?\}$/.exec(s);
  if (qm !== null) {
    quantifier = qm[0];
    s = s.slice(0, -qm[0].length);
  }
  const parsed = parseMemberInfo(s);
  parsed.raw = raw; // keep the ORIGINAL text (incl. quantifier) for honesty
  const spec: MixinMethodSpec = {
    raw,
    parsed,
    wildcard: parsed.name !== undefined && parsed.name.includes('*'),
  };
  if (quantifier !== undefined) spec.quantifier = quantifier;
  return spec;
}

// ---------------------------------------------------------------------------
// Lexical source preprocessing (length-preserving so offsets/lines stay valid)
// ---------------------------------------------------------------------------

/** Blank comments to spaces (newlines kept). Strings and text blocks survive. */
function stripComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
    } else if (c === '/' && src[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
    } else if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      i += 3; // text block — left intact here, fully blanked by maskStrings
      while (i < n && !(src[i] === '"' && src[i + 1] === '"' && src[i + 2] === '"')) i++;
      i = Math.min(n, i + 3);
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

/**
 * Blank string CONTENTS to spaces (delimiters kept; newlines kept). Text blocks are
 * blanked entirely — an annotation value written as a text block thus degrades to an
 * `expr` and is reported unparseable rather than misread.
 */
function maskStrings(stripped: string): string {
  const out = stripped.split('');
  let i = 0;
  const n = stripped.length;
  while (i < n) {
    const c = stripped[i];
    if (c === '"' && stripped[i + 1] === '"' && stripped[i + 2] === '"') {
      out[i] = ' ';
      out[i + 1] = ' ';
      out[i + 2] = ' ';
      i += 3;
      while (i < n && !(stripped[i] === '"' && stripped[i + 1] === '"' && stripped[i + 2] === '"')) {
        if (stripped[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        out[i + 2] = ' ';
        i += 3;
      }
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && stripped[i] !== c) {
        if (stripped[i] !== '\n') out[i] = ' ';
        if (stripped[i] === '\\' && i + 1 < n) {
          i++;
          if (stripped[i] !== '\n') out[i] = ' ';
        }
        i++;
      }
      i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], off: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Match `(` at `open` to its `)` in MASKED text (string contents already blanked). */
function matchParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Annotation-argument micro-parser (offset-carrying so lines stay precise)
// ---------------------------------------------------------------------------

interface AStr { t: 'str'; off: number; v: string }
interface AClass { t: 'class'; off: number; v: string }
interface AArr { t: 'arr'; off: number; items: AVal[] }
interface AAnn { t: 'ann'; off: number; name: string; args: APair[] }
interface AExpr { t: 'expr'; off: number; raw: string }
type AVal = AStr | AClass | AArr | AAnn | AExpr;
interface APair { key: string; val: AVal }

function trimRange(masked: string, s: number, e: number): { s: number; e: number } {
  while (s < e && /\s/.test(masked[s] as string)) s++;
  while (e > s && /\s/.test(masked[e - 1] as string)) e--;
  return { s, e };
}

function splitTopLevel(masked: string, start: number, end: number): { s: number; e: number }[] {
  const parts: { s: number; e: number }[] = [];
  let depth = 0;
  let s = start;
  for (let i = start; i < end; i++) {
    const c = masked[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push({ s, e: i });
      s = i + 1;
    }
  }
  parts.push({ s, e: end });
  return parts;
}

function unescapeJavaString(s: string): string {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i];
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === 'b') out += '\b';
      else if (n === 'f') out += '\f';
      else if (n === '0') out += '\0';
      else if (n === 'u') {
        const hex = s.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else out += 'u';
      } else out += n ?? '';
    } else out += c;
  }
  return out;
}

const lastSegment = (dotted: string): string => {
  const i = dotted.lastIndexOf('.');
  return i === -1 ? dotted : dotted.slice(i + 1);
};

function parseAVal(masked: string, stripped: string, s0: number, e0: number): AVal {
  const { s, e } = trimRange(masked, s0, e0);
  const off = s;
  if (s >= e) return { t: 'expr', off, raw: '' };
  const m = masked.slice(s, e);
  const rawStripped = stripped.slice(s, e);

  // A single string literal: in masked text the content is blanked, so exactly two quotes.
  if (/^"[^"]*"$/.test(m)) return { t: 'str', off, v: unescapeJavaString(stripped.slice(s + 1, e - 1)) };

  if (m.startsWith('{')) {
    if (!m.endsWith('}')) return { t: 'expr', off, raw: rawStripped };
    const items = splitTopLevel(masked, s + 1, e - 1)
      .map((p) => parseAVal(masked, stripped, p.s, p.e))
      .filter((v) => !(v.t === 'expr' && v.raw === ''));
    return { t: 'arr', off, items };
  }

  if (m.startsWith('@')) {
    const am = /^@\s*([\w$.]+)\s*/.exec(m);
    if (am !== null && am[1] !== undefined) {
      const name = lastSegment(am[1]);
      const afterName = s + am[0].length;
      if (afterName >= e) return { t: 'ann', off, name, args: [] };
      if (masked[afterName] === '(') {
        const close = matchParen(masked, afterName);
        if (close === e - 1) return { t: 'ann', off, name, args: parseAPairs(masked, stripped, afterName + 1, close) };
      }
    }
    return { t: 'expr', off, raw: rawStripped };
  }

  if (m.endsWith('.class')) {
    const body = m.slice(0, -'.class'.length).replace(/\s+/g, '');
    if (/^[\w$.]+$/.test(body)) return { t: 'class', off, v: body };
  }

  // Constants, concatenations, method calls, text blocks — honestly opaque.
  return { t: 'expr', off, raw: rawStripped };
}

function parseAPairs(masked: string, stripped: string, start: number, end: number): APair[] {
  const pairs: APair[] = [];
  for (const seg of splitTopLevel(masked, start, end)) {
    const t = trimRange(masked, seg.s, seg.e);
    if (t.s >= t.e) continue;
    const segText = masked.slice(t.s, t.e);
    const km = /^([A-Za-z_$][\w$]*)\s*=(?![=>])\s*/.exec(segText);
    if (km !== null && km[1] !== undefined) {
      pairs.push({ key: km[1], val: parseAVal(masked, stripped, t.s + km[0].length, t.e) });
    } else {
      pairs.push({ key: 'value', val: parseAVal(masked, stripped, t.s, t.e) });
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

const INJECTOR_ANNOTATIONS = new Set([
  'Inject', 'Redirect', 'ModifyArg', 'ModifyArgs', 'ModifyVariable', 'ModifyConstant', 'Overwrite',
  // MixinExtras
  'WrapOperation', 'WrapWithCondition', 'WrapMethod', 'ModifyExpressionValue', 'ModifyReturnValue',
]);
/** MixinExtras LVT/state capture — recorded for completeness, no target-class member ref. */
const CAPTURE_ANNOTATIONS = new Set(['Local', 'Share']);
const SHADOW_ANNOTATIONS = new Set(['Shadow', 'Accessor', 'Invoker']);

interface AnnoSite {
  name: string;
  atOff: number;
  argStart: number; // -1 when no args
  argEnd: number;
  end: number;
  unbalanced: boolean;
}

/**
 * Find the name of the member declaration following an annotation site. Skips
 * stacked annotations and generic type parameters; returns null when the shape
 * is not a plain member declaration (caller reports unparseable — never guesses).
 */
function declNameAfter(masked: string, from: number, limit: number): { name: string; isMethod: boolean } | null {
  let i = from;
  for (;;) {
    while (i < limit && /\s/.test(masked[i] as string)) i++;
    if (masked[i] === '@') {
      i++;
      while (i < limit && /[\w$.]/.test(masked[i] as string)) i++;
      while (i < limit && /\s/.test(masked[i] as string)) i++;
      if (masked[i] === '(') {
        const close = matchParen(masked, i);
        if (close === -1) return null;
        i = close + 1;
      }
      continue;
    }
    break;
  }
  let lastIdent: string | null = null;
  while (i < limit) {
    const c = masked[i];
    if (c === undefined) break;
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < limit && /[\w$]/.test(masked[j] as string)) j++;
      lastIdent = masked.slice(i, j);
      i = j;
    } else if (c === '<') {
      let depth = 0;
      while (i < limit) {
        const g = masked[i];
        if (g === '<') depth++;
        else if (g === '>') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
    } else if (c === '(') {
      return lastIdent !== null ? { name: lastIdent, isMethod: true } : null;
    } else if (c === '=' || c === ';') {
      return lastIdent !== null ? { name: lastIdent, isMethod: false } : null;
    } else if (c === '{') {
      return null;
    } else {
      i++;
    }
  }
  return null;
}

function resolveClassLiteral(
  lit: string,
  pkg: string,
  imports: Map<string, string>,
  wildcards: string[],
): { binaryName?: string; note?: string } {
  const innerNote = (fqn: string): string | undefined =>
    fqn.split('.').slice(0, -1).some((seg) => /^[A-Z]/.test(seg))
      ? "dotted name may reference a nested class — '$' placement is not lexically decidable; verify"
      : undefined;

  if (lit.includes('.')) {
    const first = lit.slice(0, lit.indexOf('.'));
    const outer = imports.get(first);
    if (outer !== undefined) {
      // `Outer.Inner` with `Outer` explicitly imported → nesting IS decidable.
      const res: { binaryName?: string; note?: string } = {
        binaryName: outer.replace(/\./g, '/') + '$' + lit.split('.').slice(1).join('$'),
      };
      const n = innerNote(outer);
      if (n !== undefined) res.note = n;
      return res;
    }
    const res: { binaryName?: string; note?: string } = { binaryName: lit.replace(/\./g, '/') };
    const n = innerNote(lit);
    if (n !== undefined) res.note = n;
    return res;
  }
  const fqn = imports.get(lit);
  if (fqn !== undefined) {
    const res: { binaryName?: string; note?: string } = { binaryName: fqn.replace(/\./g, '/') };
    const n = innerNote(fqn);
    if (n !== undefined) res.note = n;
    return res;
  }
  if (wildcards.length > 0) {
    return {
      note:
        `simple name '${lit}' has no explicit import and wildcard imports exist ` +
        `(${wildcards.map((w) => w + '.*').join(', ')}) — resolution ambiguous`,
    };
  }
  const res: { binaryName?: string; note?: string } = {
    binaryName: (pkg !== '' ? pkg.replace(/\./g, '/') + '/' : '') + lit,
  };
  res.note = 'resolved via same-package rule (no explicit import)';
  return res;
}

/**
 * Scan one Java source file for mixin classes and the six rename-sensitive surfaces.
 * Returns one entry per `@Mixin`-annotated class (plus a pseudo-entry collecting any
 * injector/shadow annotations found OUTSIDE a `@Mixin` scope — honesty: never dropped).
 * Purely lexical; see module doc for the encoded limitations.
 */
export function scanMixinSource(text: string, fileName: string): MixinClassScan[] {
  const file = fileName.replace(/\\/g, '/');
  const stripped = stripComments(text);
  const masked = maskStrings(stripped);
  const lineStarts = buildLineStarts(text);
  const ln = (off: number): number => lineOf(lineStarts, off);

  // package + imports
  const pkgM = /(?<![\w$.])package\s+([\w$.]+)\s*;/.exec(masked);
  const pkg = pkgM?.[1] ?? '';
  const imports = new Map<string, string>();
  const wildcards: string[] = [];
  const impRe = /(?<![\w$.])import\s+(static\s+)?([\w$.]+(?:\.\*)?)\s*;/g;
  let im: RegExpExecArray | null;
  while ((im = impRe.exec(masked)) !== null) {
    if (im[1] !== undefined) continue; // static imports import members, not classes
    const fqn = im[2];
    if (fqn === undefined) continue;
    if (fqn.endsWith('.*')) wildcards.push(fqn.slice(0, -2));
    else imports.set(lastSegment(fqn), fqn);
  }
  wildcards.sort();

  // annotation sites of interest, in file order
  const KNOWN = new Set<string>(['Mixin', ...INJECTOR_ANNOTATIONS, ...CAPTURE_ANNOTATIONS, ...SHADOW_ANNOTATIONS]);
  const sites: AnnoSite[] = [];
  const siteRe = /@\s*([A-Za-z_$][\w$.]*)/g;
  let sm: RegExpExecArray | null;
  while ((sm = siteRe.exec(masked)) !== null) {
    const full = sm[1];
    if (full === undefined) continue;
    const name = lastSegment(full);
    if (!KNOWN.has(name)) continue;
    let i = sm.index + sm[0].length;
    while (i < masked.length && /\s/.test(masked[i] as string)) i++;
    if (masked[i] === '(') {
      const close = matchParen(masked, i);
      if (close === -1) sites.push({ name, atOff: sm.index, argStart: -1, argEnd: -1, end: i + 1, unbalanced: true });
      else sites.push({ name, atOff: sm.index, argStart: i + 1, argEnd: close, end: close + 1, unbalanced: false });
    } else {
      sites.push({ name, atOff: sm.index, argStart: -1, argEnd: -1, end: sm.index + sm[0].length, unbalanced: false });
    }
  }

  const mixinSites = sites.filter((s) => s.name === 'Mixin');
  const scans: MixinClassScan[] = [];
  const classDeclRe = /(?<![.\w$])(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/;

  // honesty: injector/shadow annotations outside any @Mixin scope are reported, not dropped
  const firstMixinOff = mixinSites.length > 0 ? (mixinSites[0] as AnnoSite).atOff : Number.POSITIVE_INFINITY;
  const orphans = sites.filter((s) => s.name !== 'Mixin' && s.atOff < firstMixinOff);
  if (orphans.length > 0) {
    const cd = classDeclRe.exec(masked);
    const cls = (pkg !== '' ? pkg + '.' : '') + (cd?.[1] ?? '<unknown>');
    scans.push({
      file,
      mixinClass: cls,
      line: 1,
      targets: [],
      injectors: [],
      shadowMembers: [],
      unparseable: orphans.map((s) => ({
        line: ln(s.atOff),
        context: `@${s.name}`,
        raw: stripped.slice(s.atOff, s.end),
        reason: 'mixin annotation outside any @Mixin class scope',
      })),
    });
  }

  for (let k = 0; k < mixinSites.length; k++) {
    const site = mixinSites[k] as AnnoSite;
    const scopeEnd = k + 1 < mixinSites.length ? (mixinSites[k + 1] as AnnoSite).atOff : masked.length;

    const declM = classDeclRe.exec(masked.slice(site.end, scopeEnd));
    const simpleName = declM?.[1];
    const scan: MixinClassScan = {
      file,
      mixinClass: (pkg !== '' ? pkg + '.' : '') + (simpleName ?? '<unknown>'),
      line: ln(site.atOff),
      targets: [],
      injectors: [],
      shadowMembers: [],
      unparseable: [],
    };
    if (simpleName === undefined) {
      scan.unparseable.push({
        line: ln(site.atOff),
        context: '@Mixin',
        raw: stripped.slice(site.atOff, site.end),
        reason: 'no class declaration found after @Mixin',
      });
    }

    // --- surface #2: @Mixin targets ---
    if (site.argStart === -1) {
      scan.unparseable.push({
        line: ln(site.atOff),
        context: '@Mixin',
        raw: stripped.slice(site.atOff, site.end),
        reason: site.unbalanced ? 'unbalanced parentheses in @Mixin arguments' : 'missing @Mixin arguments',
      });
    } else {
      const pairs = parseAPairs(masked, stripped, site.argStart, site.argEnd);
      const handleOne = (v: AVal, mode: 'class' | 'string'): void => {
        const line = ln(v.off);
        if (mode === 'class' && v.t === 'class') {
          const r = resolveClassLiteral(v.v, pkg, imports, wildcards);
          const ref: MixinTargetRef = { line, how: 'class-literal', raw: v.v + '.class' };
          if (r.binaryName !== undefined) ref.binaryName = r.binaryName;
          if (r.note !== undefined) ref.note = r.note;
          scan.targets.push(ref);
        } else if (mode === 'string' && v.t === 'str') {
          if (/^[\w$./]+$/.test(v.v)) {
            scan.targets.push({ line, how: 'targets-string', raw: v.v, binaryName: v.v.replace(/\./g, '/') });
          } else {
            scan.unparseable.push({
              line,
              context: '@Mixin.targets',
              raw: v.v,
              reason: 'targets string contains characters outside the class-name grammar',
            });
          }
        } else {
          scan.unparseable.push({
            line,
            context: mode === 'class' ? '@Mixin.value' : '@Mixin.targets',
            raw: v.t === 'expr' ? v.raw : v.t === 'str' ? v.v : v.t === 'class' ? v.v + '.class' : '<non-literal>',
            reason:
              mode === 'class'
                ? 'expected a class literal — computed/constant values cannot be resolved lexically'
                : 'expected a string literal — computed/constant values cannot be resolved lexically',
          });
        }
      };
      for (const pair of pairs) {
        const mode: 'class' | 'string' | null =
          pair.key === 'value' ? 'class' : pair.key === 'targets' ? 'string' : null;
        if (mode === null) continue; // priority/remap etc. — not rename-sensitive
        if (pair.val.t === 'arr') for (const it of pair.val.items) handleOne(it, mode);
        else handleOne(pair.val, mode);
      }
    }

    // --- member sites in this scope ---
    for (const ms of sites) {
      if (ms.atOff <= site.atOff || ms.atOff >= scopeEnd || ms.name === 'Mixin') continue;
      const line = ln(ms.atOff);
      const pairs = ms.argStart === -1 ? [] : parseAPairs(masked, stripped, ms.argStart, ms.argEnd);
      if (ms.unbalanced) {
        scan.unparseable.push({
          line,
          context: `@${ms.name}`,
          raw: stripped.slice(ms.atOff, Math.min(ms.end + 80, stripped.length)),
          reason: 'unbalanced parentheses in annotation arguments',
        });
        continue;
      }

      if (SHADOW_ANNOTATIONS.has(ms.name)) {
        parseShadowSite(ms, pairs, masked, stripped, scopeEnd, line, scan);
      } else if (INJECTOR_ANNOTATIONS.has(ms.name) || CAPTURE_ANNOTATIONS.has(ms.name)) {
        parseInjectorSite(ms, pairs, masked, stripped, scopeEnd, line, ln, scan);
      }
    }
    scans.push(scan);
  }
  return scans;
}

function parseShadowSite(
  site: AnnoSite,
  pairs: APair[],
  masked: string,
  stripped: string,
  scopeEnd: number,
  line: number,
  scan: MixinClassScan,
): void {
  const annotation = site.name as 'Shadow' | 'Accessor' | 'Invoker';
  const decl = declNameAfter(masked, site.end, scopeEnd);
  const out: ShadowMemberScan = { annotation, line };
  const notes: string[] = [];

  if (decl !== null) {
    out.member = decl.name;
    out.isMethod = decl.isMethod;
  }

  if (annotation === 'Shadow') {
    let prefix = 'shadow$';
    for (const p of pairs) {
      if (p.key === 'prefix' && p.val.t === 'str') prefix = p.val.v;
      else if (p.key === 'aliases') notes.push('aliases present — alternate target names declared; verify each');
    }
    if (decl !== null) {
      out.impliedName = decl.name.startsWith(prefix) ? decl.name.slice(prefix.length) : decl.name;
    } else {
      notes.push('cannot lexically determine the annotated member declaration');
    }
  } else {
    // @Accessor / @Invoker: explicit value, else the documented bean-name inference.
    let explicit: string | undefined;
    for (const p of pairs) {
      if (p.key === 'value') {
        if (p.val.t === 'str') explicit = p.val.v;
        else notes.push('non-literal annotation value — cannot resolve lexically');
      }
    }
    if (explicit !== undefined) {
      out.impliedName = explicit;
    } else if (decl !== null) {
      const re = annotation === 'Accessor' ? /^(?:get|is|set)([A-Z])([\w$]*)$/ : /^(?:call|invoke)([A-Z])([\w$]*)$/;
      const m = re.exec(decl.name);
      if (m !== null && m[1] !== undefined) {
        out.impliedName = m[1].toLowerCase() + (m[2] ?? '');
        notes.push(`target name inferred from bean-style member name '${decl.name}' (documented Mixin rule)`);
      } else {
        notes.push(`cannot infer target member name from '${decl.name}' — explicit @${annotation} value required`);
      }
    } else {
      notes.push('cannot lexically determine the annotated member declaration');
    }
  }
  if (notes.length > 0) out.note = notes.join('; ');
  scan.shadowMembers.push(out);

  if (out.impliedName === undefined) {
    scan.unparseable.push({
      line,
      context: `@${annotation}`,
      raw: stripped.slice(site.atOff, Math.min(site.end + 80, stripped.length)).trim(),
      reason: out.note ?? 'implied target member undeterminable',
    });
  }
}

function parseInjectorSite(
  site: AnnoSite,
  pairs: APair[],
  masked: string,
  stripped: string,
  scopeEnd: number,
  line: number,
  ln: (off: number) => number,
  scan: MixinClassScan,
): void {
  const inj: InjectorScan = { annotation: site.name, line, methodSpecs: [], atTargets: [], notes: [] };

  if (CAPTURE_ANNOTATIONS.has(site.name)) {
    inj.notes.push('local-variable/shared-state capture (MixinExtras) — no target-class member reference; LVT-sensitive, not checked in v1');
    scan.injectors.push(inj);
    return;
  }

  const decl = declNameAfter(masked, site.end, scopeEnd);
  if (decl !== null && decl.isMethod) inj.handler = decl.name;

  if (site.name === 'Overwrite') {
    // @Overwrite: the handler's own name+signature IS the target; only the name is lexical.
    if (inj.handler !== undefined) {
      inj.methodSpecs.push({
        raw: inj.handler,
        parsed: { raw: inj.handler, kind: 'method', name: inj.handler },
        wildcard: false,
      });
      inj.notes.push('@Overwrite: target method name = handler name; descriptor not derivable lexically');
    } else {
      scan.unparseable.push({
        line,
        context: '@Overwrite',
        raw: stripped.slice(site.atOff, Math.min(site.end + 80, stripped.length)).trim(),
        reason: 'cannot determine the @Overwrite handler method name',
      });
    }
    scan.injectors.push(inj);
    return;
  }

  for (const pair of pairs) {
    if (pair.key === 'method') {
      const add = (v: AVal): void => {
        if (v.t === 'str') inj.methodSpecs.push(parseMethodSpec(v.v));
        else
          scan.unparseable.push({
            line: ln(v.off),
            context: `@${site.name}.method`,
            raw: v.t === 'expr' ? v.raw : '<non-string>',
            reason: 'non-literal method selector (constant/concatenation) — cannot resolve lexically',
          });
      };
      if (pair.val.t === 'arr') for (const it of pair.val.items) add(it);
      else add(pair.val);
    } else if (pair.key === 'target' && (pair.val.t === 'ann' || pair.val.t === 'arr')) {
      scan.unparseable.push({
        line: ln(pair.val.off),
        context: `@${site.name}.target`,
        raw: '@Desc(...)',
        reason: '@Desc target selectors are not modeled in v1 — verify manually',
      });
    }
  }
  walkForAts(pairs, `@${site.name}`, inj, scan, ln);
  scan.injectors.push(inj);
}

function walkForAts(
  pairs: APair[],
  ctx: string,
  inj: InjectorScan,
  scan: MixinClassScan,
  ln: (off: number) => number,
): void {
  for (const pair of pairs) walkValForAts(pair.val, `${ctx}.${pair.key}`, inj, scan, ln);
}

function walkValForAts(
  v: AVal,
  ctx: string,
  inj: InjectorScan,
  scan: MixinClassScan,
  ln: (off: number) => number,
): void {
  if (v.t === 'arr') {
    for (const it of v.items) walkValForAts(it, ctx, inj, scan, ln);
    return;
  }
  if (v.t !== 'ann') return;
  if (v.name !== 'At') {
    // e.g. @Slice(from=@At..., to=@At...) — recurse into nested annotation args
    walkForAts(v.args, `${ctx}.@${v.name}`, inj, scan, ln);
    return;
  }
  const line = ln(v.off);
  let value: string | undefined;
  let target: MemberInfoParse | undefined;
  let raw = '@At';
  const notes: string[] = [];
  for (const pair of v.args) {
    if (pair.key === 'value') {
      if (pair.val.t === 'str') value = pair.val.v;
      else notes.push('non-literal @At value');
    } else if (pair.key === 'target') {
      if (pair.val.t === 'str') {
        raw = pair.val.v;
        target = parseMemberInfo(pair.val.v);
      } else {
        scan.unparseable.push({
          line: ln(pair.val.off),
          context: `${ctx}.@At.target`,
          raw: pair.val.t === 'expr' ? pair.val.raw : '<non-string>',
          reason: 'non-literal @At target (constant/concatenation) — cannot resolve lexically',
        });
      }
    } else if (pair.key === 'desc') {
      scan.unparseable.push({
        line: ln(pair.val.off),
        context: `${ctx}.@At.desc`,
        raw: '@Desc(...)',
        reason: '@Desc selectors are not modeled in v1 — verify manually',
      });
    }
  }
  if (value !== undefined && raw === '@At') raw = `@At(${value})`;
  const at: AtRef = { line, raw };
  if (value !== undefined) at.value = value;
  if (target !== undefined) at.target = target;
  if (notes.length > 0) at.note = notes.join('; ');
  inj.atTargets.push(at);
}

// ---------------------------------------------------------------------------
// The verification contract: flatten scans into checks for the report layer
// ---------------------------------------------------------------------------

/** INVOKE-family injection points whose `target` is a method reference. */
const AT_INVOKE_VALUES = new Set(['INVOKE', 'INVOKE_ASSIGN', 'INVOKE_STRING', 'NEW']);

function classifyAt(value: string | undefined, kind: MemberInfoParse['kind']): MixinSurface | null {
  if (value !== undefined && AT_INVOKE_VALUES.has(value)) return 'at-invoke';
  if (value === 'FIELD') return 'at-field';
  if (kind === 'method') return 'at-invoke';
  if (kind === 'field') return 'at-field';
  return null; // custom injection point + bare name: genuinely unclassifiable
}

function makeRef(owner?: string, name?: string, desc?: string): MixinTargetCheck['ref'] {
  const r: MixinTargetCheck['ref'] = {};
  if (owner !== undefined) r.owner = owner;
  if (name !== undefined) r.name = name;
  if (desc !== undefined) r.desc = desc;
  return r;
}

function makeCheck(
  surface: MixinSurface,
  scan: MixinClassScan,
  line: number,
  ref: MixinTargetCheck['ref'],
  note?: string,
  raw?: string,
): MixinTargetCheck {
  const c: MixinTargetCheck = { surface, mixinClass: scan.mixinClass, file: scan.file, line, ref };
  if (note !== undefined && note !== '') c.note = note;
  if (raw !== undefined) c.raw = raw;
  return c;
}

/**
 * Flatten source scans into the stable, sorted list of verification checks.
 * Every ambiguous construct appears with surface `unparseable` and its raw text;
 * nothing the scanner saw is dropped. The report layer is responsible for
 * resolving each ref (bridge/delta) and for instruction-level verification of
 * at-invoke / at-field before claiming EXACT (SPEC §4).
 */
export function collectTargetChecks(scans: MixinClassScan[]): MixinTargetCheck[] {
  const out: MixinTargetCheck[] = [];
  for (const scan of scans) {
    for (const t of scan.targets) {
      if (t.binaryName !== undefined) out.push(makeCheck('mixin-target', scan, t.line, makeRef(t.binaryName), t.note, t.raw));
      else out.push(makeCheck('unparseable', scan, t.line, {}, t.note ?? 'target class unresolved', t.raw));
    }
    for (const inj of scan.injectors) {
      for (const spec of inj.methodSpecs) {
        const p = spec.parsed;
        if (p.error !== undefined) {
          out.push(makeCheck('unparseable', scan, inj.line, {}, `@${inj.annotation}.method: ${p.error}`, p.raw));
          continue;
        }
        const notes: string[] = [];
        if (p.owner === undefined) notes.push('owner implied by @Mixin target(s)');
        if (spec.wildcard) notes.push('wildcard selector — may match multiple methods');
        else if (p.kind === 'unknown') notes.push('bare name — descriptor unspecified');
        if (inj.annotation === 'Overwrite') notes.push('@Overwrite target — descriptor must come from compiled/handler signature');
        out.push(makeCheck('method-spec', scan, inj.line, makeRef(p.owner, p.name, p.desc), notes.join('; '), p.raw));
      }
      for (const at of inj.atTargets) {
        const p = at.target;
        if (p === undefined) continue; // HEAD/TAIL/RETURN etc. — no member reference
        if (p.error !== undefined) {
          out.push(makeCheck('unparseable', scan, at.line, {}, `@At.target: ${p.error}`, p.raw));
          continue;
        }
        const surface = classifyAt(at.value, p.kind);
        if (surface === null) {
          out.push(makeCheck('unparseable', scan, at.line, makeRef(p.owner, p.name, p.desc),
            `cannot classify @At target kind (value=${at.value ?? '<absent>'}, bare member name)`, p.raw));
          continue;
        }
        out.push(makeCheck(surface, scan, at.line, makeRef(p.owner, p.name, p.desc), at.note, p.raw));
      }
    }
    for (const sm of scan.shadowMembers) {
      // impliedName-less shadows already emitted an unparseable entry at scan time
      if (sm.impliedName === undefined) continue;
      const surface: MixinSurface = sm.annotation === 'Shadow' ? 'shadow' : sm.annotation === 'Accessor' ? 'accessor' : 'invoker';
      const notes: string[] = ['owner implied by @Mixin target(s)'];
      if (sm.isMethod !== undefined) notes.push(`declared as ${sm.isMethod ? 'method' : 'field'} in mixin source`);
      if (sm.note !== undefined) notes.push(sm.note);
      out.push(makeCheck(surface, scan, sm.line, makeRef(undefined, sm.impliedName), notes.join('; '), sm.member));
    }
    for (const u of scan.unparseable) {
      out.push(makeCheck('unparseable', scan, u.line, {}, `${u.context}: ${u.reason}`, u.raw));
    }
  }
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  out.sort(
    (a, b) =>
      cmp(a.file, b.file) ||
      a.line - b.line ||
      cmp(a.surface, b.surface) ||
      cmp(a.ref.owner ?? '', b.ref.owner ?? '') ||
      cmp(a.ref.name ?? '', b.ref.name ?? '') ||
      cmp(a.ref.desc ?? '', b.ref.desc ?? '') ||
      cmp(a.note ?? '', b.note ?? ''),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Verdicts: check each MixinTargetCheck against a concrete target jar
// ---------------------------------------------------------------------------

/**
 * One verdict for one `MixinTargetCheck` against a concrete target jar.
 *
 * Both `status` and `note` are version-FREE — the CLI adds the target-version
 * string when it renders. `info` is the honest "outside Minecraft / inherited
 * from outside the jar" bucket: it is NOT a break and is NEVER reported `absent`.
 * A JDK/library/mod owner or an inherited member flagged ABSENT would be a
 * confidently-wrong break verdict — the exact failure class this tool must
 * never produce.
 */
export interface MixinVerdict {
  check: MixinTargetCheck;
  status: 'present' | 'absent' | 'info' | 'unparseable';
  /** Version-free explanation: inheritance source / why unverifiable / near-miss descriptor(s). */
  note?: string;
}

/** java.lang.Object methods every class inherits from outside any application jar. */
const OBJECT_METHODS = new Set([
  'toString', 'hashCode', 'equals', 'getClass', 'clone', 'finalize', 'notify', 'notifyAll', 'wait',
]);

/** True only for owners the target jar can actually be expected to contain. */
function isMinecraftOwner(owner: string): boolean {
  return owner.startsWith('net/minecraft/') || owner.startsWith('com/mojang/');
}

/**
 * Deterministic walk over an owner's hierarchy IN THE TARGET JAR: the owner
 * itself first, then a BFS over supertypes (superclass before interfaces at each
 * level, interfaces in declared order; the owner excluded from the BFS). Branches
 * leave the walk at classes absent from the jar (JDK etc.) — mirror of the
 * documented walks at src/mcp/engine.ts:176-196 and src/bridge/bridge.ts:535-560.
 */
function* walkOwnerHierarchy(target: JarApi, owner: string): Generator<string> {
  yield owner;
  const seen = new Set<string>([owner]);
  const queue: string[] = [];
  const start = target.classes.get(owner);
  if (start) {
    if (start.superName) queue.push(start.superName);
    queue.push(...start.interfaces);
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    yield cur;
    const cls = target.classes.get(cur);
    if (cls) {
      if (cls.superName) queue.push(cls.superName);
      queue.push(...cls.interfaces);
    }
  }
}

interface MemberWalkResult {
  /** Binary name of the class declaring an exact match; absent when none was found. */
  declarer?: string;
  /** Descriptors seen for the name when a descriptor was given and every one differed. */
  nearMisses: string[];
}

/**
 * Search the owner's declared members, then its target-jar hierarchy, for a
 * member named `name`. When `desc` is given the match must agree on it; names
 * found only with a differing descriptor are collected as near-misses.
 */
function walkForMember(target: JarApi, owner: string, name: string, desc: string | undefined): MemberWalkResult {
  const nearMisses = new Set<string>();
  for (const cn of walkOwnerHierarchy(target, owner)) {
    const cls = target.classes.get(cn);
    if (cls === undefined) continue; // outside the jar — nothing declared to inspect
    for (const m of [...cls.methods, ...cls.fields]) {
      if (m.name !== name) continue;
      if (desc === undefined || m.desc === desc) return { declarer: cn, nearMisses: [] };
      nearMisses.add(m.desc);
    }
  }
  return { nearMisses: [...nearMisses].sort() };
}

function verdictForCheck(check: MixinTargetCheck, target: JarApi): MixinVerdict {
  const owner = check.ref.owner;
  // 1 — no owner: unparseable, carrying the check's own note (else a default).
  if (owner === undefined) {
    return { check, status: 'unparseable', note: check.note ?? 'no owner derivable' };
  }
  // 2 — owner outside Minecraft: not verifiable against the jar, never a break.
  if (!isMinecraftOwner(owner)) {
    return {
      check,
      status: 'info',
      note: 'outside Minecraft (JDK / library / mod class) — not verifiable against the target jar; NOT a break verdict',
    };
  }
  // 3 — Minecraft owner missing from the jar: a real (renamed) break.
  if (!target.classes.has(owner)) {
    return {
      check,
      status: 'absent',
      note: 'target class not found under this name — it may have been renamed; modforge bridge resolves renames',
    };
  }
  // 4 — class-only check on a present class.
  const name = check.ref.name;
  if (name === undefined) {
    return { check, status: 'present' };
  }
  // 5 — member check: owner's declared members, then the target-jar hierarchy.
  const found = walkForMember(target, owner, name, check.ref.desc);
  if (found.declarer !== undefined) {
    return found.declarer === owner
      ? { check, status: 'present' }
      : { check, status: 'present', note: `inherited from ${found.declarer}` };
  }
  // 6 — an Object method inherited from outside the jar: not verifiable, never a break.
  if (OBJECT_METHODS.has(name)) {
    return {
      check,
      status: 'info',
      note: 'java.lang.Object method inherited from outside the jar — not verifiable against the target jar; NOT a break verdict',
    };
  }
  // 7 — name seen but every descriptor differs: a near-miss break, naming what was seen.
  if (found.nearMisses.length > 0) {
    return {
      check,
      status: 'absent',
      note: `member name found with a different descriptor (${found.nearMisses.join(', ')}) — the targeted descriptor was not declared in the target class or its supertypes`,
    };
  }
  // member name nowhere in the walked hierarchy: a plain break.
  return {
    check,
    status: 'absent',
    note: 'member not found in the target class or its supertypes — it may have been renamed; modforge bridge resolves renames',
  };
}

/**
 * Verdict each check against a concrete target jar. Pure and deterministic:
 * output order equals input order, each verdict carries the very check object it
 * came from, and no clock or randomness is consulted. The owner-namespace and
 * inherited-member rules live here so the CLI and report layers share one
 * source of truth instead of re-deriving "break" verdicts ad hoc.
 */
export function checkTargetsAgainstJar(
  checks: readonly MixinTargetCheck[],
  target: JarApi,
): MixinVerdict[] {
  const verdicts: MixinVerdict[] = [];
  for (const check of checks) verdicts.push(verdictForCheck(check, target));
  return verdicts;
}

// ---------------------------------------------------------------------------
// Mixin config JSONs (surface #1)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['.git', '.gradle', '.idea', 'node_modules', 'build', 'out', 'bin', 'run']);

function walkJsonFiles(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — nothing to scan there
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walkJsonFiles(join(dir, e.name), out);
    } else if (e.isFile() && e.name.endsWith('.json')) {
      out.push(join(dir, e.name));
    }
  }
}

/** `modid.mixins.json`, `mixins.modid.json`, `modid.mixins.client.json`, ... */
function isMixinConfigName(fileName: string): boolean {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  const parts = base.split('.');
  return parts[parts.length - 1] === 'json' && parts.slice(0, -1).includes('mixins');
}

/**
 * Diagnose a strict-JSON parse failure with an actionable message: trailing commas
 * and comments (the two classic mixin-config sins) are pointed at precisely.
 */
function diagnoseJson(text: string, err: unknown): string {
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
    } else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const line = lineOf(buildLineStarts(text), i);
      return `comments are not valid in strict JSON (line ${line}, offset ${i}) — mixin configs must be strict JSON`;
    } else if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      const n = text[j];
      if (n === '}' || n === ']') {
        const line = lineOf(buildLineStarts(text), i);
        return `trailing comma before '${n}' (line ${line}, offset ${i}) — mixin configs must be strict JSON (no trailing commas)`;
      }
    }
  }
  return `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
}

function asStringArray(v: unknown, key: string, file: string, errors: MixinConfigError[]): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    errors.push({ file, error: `'${key}' must be an array of strings` });
    return null;
  }
  return v as string[];
}

function looksLikeMixinConfig(j: unknown): boolean {
  if (typeof j !== 'object' || j === null) return false;
  const o = j as Record<string, unknown>;
  return (
    typeof o['package'] === 'string' &&
    (Array.isArray(o['mixins']) || Array.isArray(o['client']) || Array.isArray(o['server']))
  );
}

/**
 * Find and parse all mixin config JSONs under `dir` (recursive; VCS/build dirs skipped).
 * Files are matched by the `*.mixins*.json` naming convention; additionally, any
 * `.json` that parses strictly AND has the mixin-config shape (`package` + a class
 * list) is included, so unconventionally named configs are not missed.
 * Strict JSON only: trailing commas and comments produce a clear per-file error
 * (in `errors`) instead of a lenient parse — name-matched files never fail silently.
 */
export function findMixinConfigs(dir: string): MixinConfigScan {
  const files: string[] = [];
  walkJsonFiles(dir, files);
  files.sort();

  const configs: MixinConfig[] = [];
  const errors: MixinConfigError[] = [];

  for (const path of files) {
    const file = path.replace(/\\/g, '/');
    const nameMatched = isMixinConfigName(file);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      if (nameMatched) errors.push({ file, error: `cannot read file: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      if (nameMatched) errors.push({ file, error: diagnoseJson(text, e) });
      continue; // non-name-matched invalid JSON is not our concern
    }
    if (!nameMatched && !looksLikeMixinConfig(json)) continue;
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      errors.push({ file, error: 'mixin config must be a JSON object' });
      continue;
    }
    const o = json as Record<string, unknown>;
    const pkg = o['package'];
    if (typeof pkg !== 'string' || pkg === '') {
      errors.push({ file, error: "missing required 'package' (non-empty string)" });
      continue;
    }
    const mixins = asStringArray(o['mixins'], 'mixins', file, errors);
    const client = asStringArray(o['client'], 'client', file, errors);
    const server = asStringArray(o['server'], 'server', file, errors);
    if (mixins === null || client === null || server === null) continue;

    const allClasses: MixinConfig['allClasses'] = [
      ...mixins.map((n) => ({ name: `${pkg}.${n}`, side: 'common' as const })),
      ...client.map((n) => ({ name: `${pkg}.${n}`, side: 'client' as const })),
      ...server.map((n) => ({ name: `${pkg}.${n}`, side: 'server' as const })),
    ];
    allClasses.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.side < b.side ? -1 : a.side > b.side ? 1 : 0));

    const cfg: MixinConfig = { file, package: pkg, mixins, client, server, allClasses };
    if (typeof o['compatibilityLevel'] === 'string') cfg.compatibilityLevel = o['compatibilityLevel'];
    if (typeof o['refmap'] === 'string') cfg.refmap = o['refmap'];
    if (typeof o['minVersion'] === 'string') cfg.minVersion = o['minVersion'];
    if (typeof o['plugin'] === 'string') cfg.plugin = o['plugin'];
    configs.push(cfg);
  }

  configs.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { configs, errors };
}
