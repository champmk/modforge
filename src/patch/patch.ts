/**
 * EXACT-only source patcher — the single ModForge module that EDITS USER SOURCE.
 *
 * Trust contract (SPEC §5 — the honesty taxonomy is law here):
 * - Only EXACT resolutions ever produce a patch op. CANDIDATE / UNRESOLVED
 *   findings are NEVER patched — enforced twice: a confidence gate at planning
 *   time, and a final invariant assertion that throws before a violating plan
 *   can leave this module.
 * - Every op carries the EXACT `before` text and is re-verified against the
 *   live file at apply time. Application is all-or-nothing PER FILE: one
 *   mismatching span refuses the whole file (a half-patched file is worse than
 *   an unpatched one).
 * - Planning is self-verifying: every transform is checked against the actual
 *   span text, token boundaries, and comment/string masking, so a wrong
 *   assumption degrades to a skipped finding (reported, never patched) —
 *   never to a corrupting edit.
 * - Idempotent by construction: on an already-patched file the old symbols no
 *   longer occupy the spans, every `before` verification misses, and the plan
 *   is empty.
 * - Dry-run is the default everywhere: planning and applyPatches are pure;
 *   only `applyToDisk` touches the filesystem, and it backs originals up to
 *   `.modforge-backup/<relpath>` first.
 *
 * Scope: Java source findings (imports, FQN occurrences, import-bound simple
 * names, lexically-certain member callsites). Build/config files are handled
 * by `applyGradleMigration` in src/scan/gradle.ts — NOT duplicated here.
 *
 * Determinism: ops and skip reports are stably sorted; nothing here consults
 * the clock, randomness, or state outside its arguments (applyToDisk's file
 * I/O excepted, and that proceeds in sorted-path order).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Resolution } from '../core/model.ts';

// ---------------------------------------------------------------------------
// Patch-op model + applyPatches (pure)
// ---------------------------------------------------------------------------

/**
 * One surgical text replacement, addressed by character offsets (UTF-16 code
 * units of the decoded file text — the units `String.prototype.slice` uses).
 *
 * Invariants:
 * - `before` is the EXACT current text of `[start, end)`; it is re-verified at
 *   apply time and any drift refuses the whole file.
 * - Ops within one file never overlap (planJavaPatches guarantees it;
 *   applyPatches independently re-checks and refuses).
 */
export interface PatchOp {
  /** Path of the file this op targets, exactly as planning received it. */
  file: string;
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
  /** EXACT expected text of `[start, end)` at apply time. */
  before: string;
  /** Replacement text. */
  after: string;
  /** Id of the report finding this op implements (audit link). */
  findingId: string;
}

/** An op that was not applied, with the precise reason. */
export interface RefusedOp {
  op: PatchOp;
  reason: string;
}

/**
 * Result of applying one file's ops. All-or-nothing: `refused` non-empty ⇒
 * `text` is the input untouched and `applied` is empty.
 */
export interface PatchApplyResult {
  text: string;
  /** Applied ops, ascending by start offset. */
  applied: PatchOp[];
  /** On ANY verification failure, EVERY op of the file lands here. */
  refused: RefusedOp[];
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byOpOrder = (a: PatchOp, b: PatchOp): number =>
  a.start - b.start || a.end - b.end || cmpStr(a.findingId, b.findingId) || cmpStr(a.after, b.after);

const WITHHELD = 'withheld: another op in this file failed verification (patching is all-or-nothing per file)';

/**
 * Verify and apply a set of ops against one file's text. PURE — no I/O.
 *
 * Every op's `before` must match `fileText.slice(start, end)` EXACTLY, all ops
 * must target the same `file`, spans must be in bounds and non-overlapping.
 * If ANY check fails, the whole file is refused: the returned `text` is the
 * input unchanged, `applied` is empty, and every op appears in `refused` —
 * the failing ones with their precise reasons, the rest marked withheld.
 * A partial or guessed application never happens.
 *
 * Apply order is reverse-offset, so earlier spans are untouched by later
 * splices; `applied` is returned in ascending span order.
 */
export function applyPatches(fileText: string, ops: PatchOp[]): PatchApplyResult {
  if (ops.length === 0) return { text: fileText, applied: [], refused: [] };

  const sorted = [...ops].sort(byOpOrder);
  const reasons = new Map<PatchOp, string>();

  const file = sorted[0]!.file;
  for (const op of sorted) {
    if (op.file !== file) {
      reasons.set(op, `op targets '${op.file}' but this batch patches '${file}' — applyPatches handles exactly one file`);
      continue;
    }
    if (!Number.isInteger(op.start) || !Number.isInteger(op.end) || op.start < 0 || op.end < op.start || op.end > fileText.length) {
      reasons.set(op, `span [${op.start},${op.end}) is out of bounds for a ${fileText.length}-char file`);
      continue;
    }
    const actual = fileText.slice(op.start, op.end);
    if (actual !== op.before) {
      reasons.set(
        op,
        `span [${op.start},${op.end}) reads ${JSON.stringify(actual)} but the op expects ${JSON.stringify(op.before)} — file drifted since planning (or is already patched)`,
      );
    }
  }

  // Overlap check (independent of per-op failures — all-or-nothing regardless).
  let maxEndOp: PatchOp | null = null;
  for (const op of sorted) {
    if (maxEndOp && op.start < maxEndOp.end) {
      const r = (x: PatchOp, y: PatchOp): string =>
        `span [${x.start},${x.end}) overlaps op for finding '${y.findingId}' at [${y.start},${y.end}) — overlapping edits are refused`;
      if (!reasons.has(maxEndOp)) reasons.set(maxEndOp, r(maxEndOp, op));
      if (!reasons.has(op)) reasons.set(op, r(op, maxEndOp));
    }
    if (!maxEndOp || op.end > maxEndOp.end) maxEndOp = op;
  }

  if (reasons.size > 0) {
    return {
      text: fileText,
      applied: [],
      refused: sorted.map((op) => ({ op, reason: reasons.get(op) ?? WITHHELD })),
    };
  }

  let out = fileText;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const op = sorted[i]!;
    out = out.slice(0, op.start) + op.after + out.slice(op.end);
  }
  return { text: out, applied: sorted, refused: [] };
}

// ---------------------------------------------------------------------------
// Java lexical helpers (internal): masking + import scan
// ---------------------------------------------------------------------------

/**
 * Replace the contents of comments, string/char literals, and text blocks
 * with spaces, preserving every offset and all newlines (`\r`/`\n` kept).
 * TOTAL function: unterminated constructs mask to end-of-file (or end-of-line
 * for single-line literals) — conservative, because masked regions are never
 * patched and never yield import bindings.
 */
function maskJavaSource(text: string): string {
  const n = text.length;
  const chars: string[] = new Array<string>(n);
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      const c = text[k]!;
      chars[k] = c === '\n' || c === '\r' ? c : ' ';
    }
  };
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '/') {
      let j = text.indexOf('\n', i);
      if (j === -1) j = n;
      blank(i, j);
      i = j;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const j = close === -1 ? n : close + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' && text.startsWith('"""', i)) {
      // Text block. Escapes (e.g. \") are processed inside text blocks.
      let j = i + 3;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text.startsWith('"""', j)) {
          j += 3;
          break;
        }
        j++;
      }
      const end = Math.min(j, n);
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        const d = text[j]!;
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === c) {
          j++;
          break;
        }
        if (d === '\n') break; // unterminated single-line literal — resync at newline
        j++;
      }
      const end = Math.min(j, n);
      blank(i, end);
      i = end;
    } else {
      chars[i] = c;
      i++;
    }
  }
  return chars.join('');
}

/** One import declaration found in the masked source. */
interface JavaImportDecl {
  isStatic: boolean;
  /** Whitespace-stripped dotted chain (for static imports it includes the member segment). */
  fqn: string;
  wildcard: boolean;
  /** Offsets of the dotted-chain text in the file. */
  fqnStart: number;
  fqnEnd: number;
}

/** Scan import declarations from MASKED text (comments/strings cannot fake one). */
function scanImports(masked: string): JavaImportDecl[] {
  const re = /\bimport(\s+static)?\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)(\s*\.\s*\*)?\s*;/dg;
  const out: JavaImportDecl[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    const idx = m.indices?.[2];
    if (!idx) continue; // cannot happen: group 2 always participates
    out.push({
      isStatic: m[1] !== undefined,
      fqn: m[2]!.replace(/\s+/g, ''),
      wildcard: m[3] !== undefined,
      fqnStart: idx[0],
      fqnEnd: idx[1],
    });
  }
  return out;
}

const isIdentChar = (ch: string | undefined): boolean => ch !== undefined && /[\w$]/.test(ch);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Name forms
// ---------------------------------------------------------------------------

/**
 * Binary name → Java source form: `a/b/Outer$Inner` → `a.b.Outer.Inner`.
 *
 * CAVEAT: `$` is also a legal source-identifier character, so this conversion
 * is heuristic for names containing a literal `$`. Safe in this module because
 * every planned edit is verified against the actual span text — a wrong
 * conversion degrades to a skipped finding, never a wrong patch.
 */
export function sourceDottedName(binaryName: string): string {
  return binaryName.replace(/[/$]/g, '.');
}

/** Last identifier segment of a binary name: `a/b/Outer$Inner` → `Inner`. */
export function simpleNameOf(binaryName: string): string {
  const parts = binaryName.split(/[/$]/);
  return parts[parts.length - 1] ?? binaryName;
}

/** Separator-insensitive class-name key (`.`/`$`/`/` all become `/`) for cross-checks. */
function classKey(name: string): string {
  return name.replace(/[.$]/g, '/');
}

function simpleOfDotted(fqn: string): string {
  const parts = fqn.split('.');
  return parts[parts.length - 1] ?? fqn;
}

const normPath = (p: string): string => p.replace(/\\/g, '/');

// ---------------------------------------------------------------------------
// Java finding contract (consumed from src/scan/java.ts + the bridge)
// ---------------------------------------------------------------------------

/**
 * Source-reference kinds the Java scanner reports:
 * - `import`          — a class referenced by an import declaration
 * - `fqn`             — a fully-qualified class occurrence in code
 * - `type-usage`      — a simple-name type usage bound via the file's imports
 * - `member-static`   — member callsite with a static class qualifier
 * - `member-instance` — member callsite on an instance receiver
 */
export type JavaFindingKind = 'import' | 'fqn' | 'type-usage' | 'member-static' | 'member-instance';

/** Character span (UTF-16 code-unit offsets, end-exclusive). */
export interface SourceSpan {
  start: number;
  end: number;
}

/**
 * A Java scan finding joined with its bridge/delta Resolution — the planning
 * input. The scanner emits the positional fields; the report layer attaches
 * `resolution`.
 *
 * Span contract (what must be recorded for a finding to be patchable):
 * - `import` / `fqn`  → span covers EXACTLY the old class's source-form dotted
 *   name. For `import static a.b.C.m;` the class finding spans `a.b.C` only —
 *   the `static` keyword and the member segment lie outside the span, so the
 *   rewrite preserves static/wildcard import forms structurally.
 * - `type-usage`      → span covers exactly the simple-name token.
 * - `member-*`        → span covers exactly the member-name token at the
 *   callsite (also valid for the member segment of a static import).
 * Findings without a span are never patchable (they stay report findings).
 */
export interface ResolvedJavaFinding {
  /** Path of the scanned file (must match planJavaPatches' fileName). */
  file: string;
  /** 1-based line of the reference. */
  line: number;
  /** 1-based column of the reference. */
  col: number;
  kind: JavaFindingKind;
  /** Old-era class reference (`.`/`$`/`/` separators all accepted). */
  className?: string;
  /** Old-era member name (member-* kinds). */
  memberName?: string;
  /** Exact char span of the patchable token(s) — absent means report-only. */
  span?: SourceSpan;
  /** Stable finding id; synthesized as `file:line:col:kind` when absent. */
  id?: string;
  /**
   * Scanner's receiver-certainty mark for member findings. `member-static`
   * is lexically certain by construction (the qualifier IS the class) and
   * defaults to true; `member-instance` REQUIRES an explicit `true`
   * (declared-type-tracked receiver). Anything else is never patched.
   */
  receiverCertain?: boolean;
  /** The resolution for this reference (honesty taxonomy). */
  resolution: Resolution;
}

/** A finding that produced no op, with the precise honest reason. */
export interface SkippedFinding {
  findingId: string;
  kind: JavaFindingKind;
  line: number;
  col: number;
  reason: string;
}

/** Dry-run output of planJavaPatches. Applying it is a separate, explicit step. */
export interface JavaPatchPlan {
  /** Non-overlapping ops, ascending by span. EXACT-backed only (asserted). */
  ops: PatchOp[];
  /** The honesty remainder: every finding that produced no op. */
  skipped: SkippedFinding[];
}

const KIND_ORDER: readonly JavaFindingKind[] = ['import', 'fqn', 'type-usage', 'member-static', 'member-instance'];

function findingIdOf(f: ResolvedJavaFinding): string {
  return f.id ?? `${f.file}:${f.line}:${f.col}:${f.kind}`;
}

const byFindingOrder = (a: ResolvedJavaFinding, b: ResolvedJavaFinding): number =>
  a.line - b.line || a.col - b.col || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || cmpStr(findingIdOf(a), findingIdOf(b));

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Plan EXACT-only patch ops for one Java source file. PURE dry-run — no I/O.
 *
 * What gets an op (each rule self-verified against the file text):
 * - import-line rewrites: old class dotted name → new, span-verified to be the
 *   class reference of an actual import declaration (static/wildcard forms are
 *   preserved because the span excludes them).
 * - FQN occurrences in code.
 * - simple-name type usages, ONLY when (a) the file single-type-imports the
 *   old class (the binding is provable), (b) this plan also rewrites that
 *   import, and (c) the simple name itself changed — when only the package
 *   changed, the import rewrite alone re-binds every usage and usages get no op.
 * - member callsites, ONLY for findings the scanner marked lexically certain
 *   (`member-static`, or `member-instance` with `receiverCertain === true`)
 *   AND whose resolution is EXACT with an unchanged member kind.
 *
 * Everything else — CANDIDATE/UNRESOLVED resolutions, spanless findings, spans
 * whose text no longer matches (already patched / stale scan), spans inside
 * comments or strings, ambiguous bindings, simple-name collisions, overlapping
 * edits — is returned in `skipped` with a precise reason and stays a report
 * finding. The no-CANDIDATE/UNRESOLVED invariant is re-asserted over the final
 * ops; a violation throws rather than returning a plan.
 *
 * Idempotence: on an already-patched file the old names no longer match any
 * span, so re-planning yields zero ops.
 */
export function planJavaPatches(fileText: string, fileName: string, findings: ResolvedJavaFinding[]): JavaPatchPlan {
  const skipped: SkippedFinding[] = [];
  const ops: PatchOp[] = [];
  const opResolution = new Map<string, Resolution>();
  const opFinding = new Map<string, ResolvedJavaFinding>();

  const masked = maskJavaSource(fileText);
  let importsCache: JavaImportDecl[] | null = null;
  const imports = (): JavaImportDecl[] => (importsCache ??= scanImports(masked));

  const skip = (f: ResolvedJavaFinding, reason: string): void => {
    skipped.push({ findingId: findingIdOf(f), kind: f.kind, line: f.line, col: f.col, reason });
  };

  // --- confidence gate: the taxonomy is enforced before anything else -------
  const eligible: ResolvedJavaFinding[] = [];
  for (const f of [...findings].sort(byFindingOrder)) {
    if (normPath(f.file) !== normPath(fileName)) {
      skip(f, `finding is for '${f.file}', not '${fileName}' — wrong file`);
      continue;
    }
    if (f.resolution.confidence !== 'EXACT') {
      skip(f, `confidence ${f.resolution.confidence}: only EXACT resolutions are ever patched (honesty taxonomy) — left as a report finding`);
      continue;
    }
    eligible.push(f);
  }

  // --- shared verifications ---------------------------------------------------
  const verifiedSpan = (f: ResolvedJavaFinding, expectedBefore: string, forbidDotBefore: boolean): SourceSpan | null => {
    const span = f.span;
    if (!span) {
      skip(f, 'finding has no source span — report-only, nothing to patch');
      return null;
    }
    if (!Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end < span.start || span.end > fileText.length) {
      skip(f, `span [${span.start},${span.end}) is out of bounds for a ${fileText.length}-char file`);
      return null;
    }
    const actual = fileText.slice(span.start, span.end);
    if (actual !== expectedBefore) {
      skip(f, `span reads ${JSON.stringify(actual)}, expected ${JSON.stringify(expectedBefore)} — already patched or stale scan; no op emitted`);
      return null;
    }
    if (masked.slice(span.start, span.end) !== actual) {
      skip(f, 'span lies inside a comment or string literal — never patched');
      return null;
    }
    const before = fileText[span.start - 1];
    const after = fileText[span.end];
    if (isIdentChar(before) || (forbidDotBefore && before === '.')) {
      skip(f, 'span is not a standalone token (preceded by an identifier character) — not provably the referenced symbol');
      return null;
    }
    if (isIdentChar(after)) {
      skip(f, 'span is not a standalone token (followed by an identifier character) — not provably the referenced symbol');
      return null;
    }
    return span;
  };

  const classEnds = (f: ResolvedJavaFinding): { fromBin: string; toBin: string } | null => {
    const res = f.resolution;
    if (res.from.kind !== 'class' || res.from.owner === '') {
      skip(f, `resolution.from is not a class symbol (kind '${res.from.kind}') — cannot back a class-reference patch`);
      return null;
    }
    const to = res.to;
    if (!to || to.kind !== 'class' || to.owner === '') {
      skip(f, "EXACT class resolution lacks a usable 'to' class — engine inconsistency; not patched");
      return null;
    }
    if (f.className !== undefined && classKey(f.className) !== classKey(res.from.owner)) {
      skip(f, `finding names class '${f.className}' but the resolution is for '${res.from.owner}' — mismatched pairing; not patched`);
      return null;
    }
    return { fromBin: res.from.owner, toBin: to.owner };
  };

  const emit = (f: ResolvedJavaFinding, span: SourceSpan, before: string, after: string): void => {
    const id = findingIdOf(f);
    ops.push({ file: fileName, start: span.start, end: span.end, before, after, findingId: id });
    opResolution.set(id, f.resolution);
    opFinding.set(id, f);
  };

  /**
   * Hazard check before an import rewrite introduces a NEW simple-name binding:
   * an existing import, an in-file type declaration, or any pre-existing
   * unqualified occurrence of the new simple name makes rebinding unprovable.
   */
  const bindingHazard = (newSimple: string, newFqn: string): string | null => {
    for (const d of imports()) {
      if (d.isStatic || d.wildcard) continue;
      if (simpleOfDotted(d.fqn) === newSimple && d.fqn !== newFqn) {
        return `rewriting the import would make '${newSimple}' ambiguous with existing import '${d.fqn}' — left for manual review`;
      }
    }
    const esc = escapeRe(newSimple);
    if (new RegExp(`\\b(?:class|interface|enum|record)\\s+${esc}(?![\\w$])`).test(masked)) {
      return `this file declares a type named '${newSimple}' — rebinding that simple name is not provably safe`;
    }
    const re = new RegExp(`(?<![\\w$])${esc}(?![\\w$])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      let k = m.index - 1; // qualified occurrences (`pkg.New`) do not rebind — skip them
      while (k >= 0 && /[ \t\r\n]/.test(masked[k]!)) k--;
      if (k >= 0 && masked[k] === '.') continue;
      return `'${newSimple}' already occurs unqualified in this file (offset ${m.index}) — introducing a new binding for it is not provably safe`;
    }
    return null;
  };

  // --- pass 1: import rewrites -------------------------------------------------
  /** classKey of every old class whose import line this plan rewrites. */
  const importRewrites = new Set<string>();
  for (const f of eligible) {
    if (f.kind !== 'import') continue;
    const cls = classEnds(f);
    if (!cls) continue;
    const before = sourceDottedName(cls.fromBin);
    const after = sourceDottedName(cls.toBin);
    if (before === after) {
      skip(f, 'class name unchanged in the target — nothing to patch');
      continue;
    }
    const oldSimple = simpleNameOf(cls.fromBin);
    const newSimple = simpleNameOf(cls.toBin);
    if (newSimple !== oldSimple) {
      const hazard = bindingHazard(newSimple, after);
      if (hazard) {
        skip(f, hazard);
        continue;
      }
    }
    const span = verifiedSpan(f, before, true);
    if (!span) continue;
    // The span must be the class-reference chain of a real import declaration —
    // a misclassified code occurrence must not count as an import rewrite.
    const decl = imports().find((d) => d.fqnStart === span.start && d.fqnEnd >= span.end);
    if (!decl) {
      skip(f, 'span is not the class reference of an import declaration — not patched as an import');
      continue;
    }
    emit(f, span, before, after);
    importRewrites.add(classKey(cls.fromBin));
  }

  // --- pass 2: fully-qualified occurrences -------------------------------------
  for (const f of eligible) {
    if (f.kind !== 'fqn') continue;
    const cls = classEnds(f);
    if (!cls) continue;
    const before = sourceDottedName(cls.fromBin);
    const after = sourceDottedName(cls.toBin);
    if (before === after) {
      skip(f, 'class name unchanged in the target — nothing to patch');
      continue;
    }
    const span = verifiedSpan(f, before, true);
    if (!span) continue;
    emit(f, span, before, after);
  }

  // --- pass 3: simple-name type usages ------------------------------------------
  for (const f of eligible) {
    if (f.kind !== 'type-usage') continue;
    const cls = classEnds(f);
    if (!cls) continue;
    const oldSimple = simpleNameOf(cls.fromBin);
    const newSimple = simpleNameOf(cls.toBin);
    if (sourceDottedName(cls.fromBin) === sourceDottedName(cls.toBin)) {
      skip(f, 'class name unchanged in the target — nothing to patch');
      continue;
    }
    if (oldSimple === newSimple) {
      skip(f, `simple name '${oldSimple}' unchanged — the import rewrite alone re-binds this usage; no op needed`);
      continue;
    }
    const oldFqn = sourceDottedName(cls.fromBin);
    const bound = imports().filter((d) => !d.isStatic && !d.wildcard && simpleOfDotted(d.fqn) === oldSimple);
    if (bound.length !== 1 || bound[0]!.fqn !== oldFqn) {
      skip(f, `file imports do not bind '${oldSimple}' to '${oldFqn}' via a unique single-type import — usage is not provably this class`);
      continue;
    }
    if (!importRewrites.has(classKey(cls.fromBin))) {
      skip(f, 'no accompanying import rewrite in this plan — renaming usages without the import would break the file');
      continue;
    }
    const span = verifiedSpan(f, oldSimple, true);
    if (!span) continue;
    emit(f, span, oldSimple, newSimple);
  }

  // --- pass 4: member callsites ---------------------------------------------------
  for (const f of eligible) {
    if (f.kind !== 'member-static' && f.kind !== 'member-instance') continue;
    const res = f.resolution;
    if ((res.from.kind !== 'method' && res.from.kind !== 'field') || res.from.name === undefined || res.from.name === '') {
      skip(f, `resolution.from is not a named member (kind '${res.from.kind}') — cannot back a member patch`);
      continue;
    }
    const to = res.to;
    if (!to || to.name === undefined || to.name === '') {
      skip(f, "EXACT member resolution lacks a usable 'to' member — engine inconsistency; not patched");
      continue;
    }
    if (to.kind !== res.from.kind) {
      skip(f, `resolution changes member kind (${res.from.kind} → ${to.kind}) — a name patch cannot express that; left for manual port`);
      continue;
    }
    if (f.memberName !== undefined && f.memberName !== res.from.name) {
      skip(f, `finding names member '${f.memberName}' but the resolution is for '${res.from.name}' — mismatched pairing; not patched`);
      continue;
    }
    if (f.className !== undefined && classKey(f.className) !== classKey(res.from.owner)) {
      skip(f, `finding names class '${f.className}' but the resolution is for '${res.from.owner}' — mismatched pairing; not patched`);
      continue;
    }
    const certain = f.kind === 'member-static' ? f.receiverCertain !== false : f.receiverCertain === true;
    if (!certain) {
      skip(
        f,
        f.kind === 'member-static'
          ? 'scanner explicitly disclaimed receiver certainty — not patched'
          : 'receiver not lexically certain (no declared-type-tracking mark from the scanner) — member callsites are only patched with a provable receiver',
      );
      continue;
    }
    if (res.from.name === to.name) {
      skip(f, 'member name unchanged in the target — nothing to patch');
      continue;
    }
    const span = verifiedSpan(f, res.from.name, false); // '.' before the name is the receiver — expected
    if (!span) continue;
    emit(f, span, res.from.name, to.name);
  }

  // --- pass 5: dedupe + overlap resolution (never emit a corrupting plan) -------
  ops.sort(byOpOrder);
  const unique: PatchOp[] = [];
  for (const op of ops) {
    const last = unique[unique.length - 1];
    if (last && last.start === op.start && last.end === op.end && last.before === op.before && last.after === op.after) {
      const f = opFinding.get(op.findingId)!;
      skip(f, `duplicate of the op from finding '${last.findingId}' — one op suffices`);
      continue;
    }
    unique.push(op);
  }
  const dropped = new Set<number>();
  let maxEndIdx = -1;
  for (let i = 0; i < unique.length; i++) {
    const op = unique[i]!;
    if (maxEndIdx >= 0 && op.start < unique[maxEndIdx]!.end) {
      dropped.add(i);
      dropped.add(maxEndIdx);
    }
    if (maxEndIdx === -1 || op.end > unique[maxEndIdx]!.end) maxEndIdx = i;
  }
  const finalOps: PatchOp[] = [];
  for (let i = 0; i < unique.length; i++) {
    const op = unique[i]!;
    if (dropped.has(i)) {
      const f = opFinding.get(op.findingId)!;
      skip(f, `planned op at [${op.start},${op.end}) overlaps another planned op — all overlapping ops withheld (never emit a corrupting plan)`);
    } else {
      finalOps.push(op);
    }
  }

  // --- pass 6: the old-name dangling invariant ---------------------------------
  // An import rewrite whose SIMPLE NAME changes may only be applied if every
  // standalone occurrence of the old simple name in the masked source is
  // covered by an op in this plan. The scanner has known blind spots (static
  // receivers, casts, return types, ...); rewriting the import while any
  // occurrence stays behind would ship a non-compiling file under a success
  // message — so any uncovered occurrence refuses the ENTIRE file.
  const dangling = new Map<string, number[]>();
  for (const op of finalOps) {
    const f = opFinding.get(op.findingId)!;
    if (f.kind !== 'import') continue;
    const res = opResolution.get(op.findingId)!;
    if (res.from.kind !== 'class' || res.to?.kind !== 'class') continue; // classEnds already verified these
    const oldSimple = simpleNameOf(res.from.owner);
    if (simpleNameOf(res.to.owner) === oldSimple || dangling.has(oldSimple)) continue;
    const re = new RegExp(`(?<![\\w$])${escapeRe(oldSimple)}(?![\\w$])`, 'g');
    const uncovered: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(masked)) !== null) {
      const s = m.index;
      const e = s + oldSimple.length;
      if (!finalOps.some((o) => o.start <= s && o.end >= e)) uncovered.push(s);
    }
    if (uncovered.length > 0) dangling.set(oldSimple, uncovered);
  }
  if (dangling.size > 0) {
    const lineOf = (off: number): number => {
      let line = 1;
      for (let k = 0; k < off; k++) if (fileText[k] === '\n') line++;
      return line;
    };
    const detail = [...dangling.entries()]
      .map(([name, offs]) => `'${name}' at line(s) ${[...new Set(offs.map(lineOf))].join(', ')}`)
      .join('; ');
    for (const op of finalOps) {
      skip(
        opFinding.get(op.findingId)!,
        `import rewrite would leave ${detail} still referencing the old name (no rewrite is planned there) — whole file left for manual review (refusal over partial migration)`,
      );
    }
    finalOps.length = 0;
  }

  // --- THE LAW (SPEC §5): no op may exist without an EXACT resolution behind it.
  for (const op of finalOps) {
    const res = opResolution.get(op.findingId);
    if (!res || res.confidence !== 'EXACT') {
      throw new Error(
        `patch invariant violated: op for finding '${op.findingId}' is backed by ${res ? `confidence ${res.confidence}` : 'no resolution'} — only EXACT is ever patched`,
      );
    }
  }

  skipped.sort((a, b) => a.line - b.line || a.col - b.col || cmpStr(a.findingId, b.findingId) || cmpStr(a.reason, b.reason));
  return { ops: finalOps, skipped };
}

// ---------------------------------------------------------------------------
// Disk application (the ONLY effectful entry point)
// ---------------------------------------------------------------------------

/** Backup directory name, created under `root`. */
export const BACKUP_DIR = '.modforge-backup';

export interface ApplyToDiskOptions {
  /** Create `.modforge-backup/<relpath>` copies before writing. Default TRUE. */
  backup?: boolean;
  /**
   * Project root: relative op paths resolve against it and backups mirror the
   * tree under `<root>/.modforge-backup/`. Default `process.cwd()`.
   */
  root?: string;
}

/** Per-file outcome of applyToDisk. */
export interface FileApplyOutcome {
  /** Path exactly as the ops carried it. */
  file: string;
  /** Resolved absolute path that was read/written. */
  absPath: string;
  /** Applied ops (ascending) — empty when the file was refused. */
  applied: PatchOp[];
  /** All-or-nothing refusals for this file (file untouched when non-empty). */
  refused: RefusedOp[];
  /** True iff new content was written to disk. */
  written: boolean;
  /** Present iff a backup exists for this file (first-run copy is preserved). */
  backupPath?: string;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Apply planned ops to the filesystem. This is the ONLY function in the module
 * that writes; everything upstream is a dry run.
 *
 * Safety properties:
 * - Every target must resolve INSIDE `root` (and outside the backup dir) —
 *   violations throw before ANY file is touched.
 * - Per file: ops are re-verified against the live on-disk text via
 *   `applyPatches`; any mismatch refuses the whole file (reported in the
 *   outcome, file untouched).
 * - Backups (default on): the original is copied to
 *   `<root>/.modforge-backup/<relpath>` BEFORE writing. An existing backup is
 *   never overwritten — it stays the pre-ModForge original across re-runs.
 * - Files are processed in sorted-path order; outcomes are deterministic given
 *   identical disk state.
 *
 * Encoding: each file is read as a raw Buffer and refused WHOLE if it is not
 * valid UTF-8 — i.e. its bytes do not survive a UTF-8 decode/re-encode
 * round-trip. The refusal names the offset of the first non-roundtripping byte
 * and the file is neither written nor backed up, so non-UTF-8 source (e.g. a
 * stray CP-1252 byte) is never silently corrupted to U+FFFD. Valid files —
 * including a UTF-8 BOM and CRLF line endings, both of which round-trip — are
 * decoded as UTF-8 and patched as usual; offsets were produced against the
 * identically-decoded text, so any remaining skew fails the `before`
 * verification and refuses the file rather than corrupting it.
 */
export function applyToDisk(ops: PatchOp[], opts: ApplyToDiskOptions = {}): FileApplyOutcome[] {
  const backup = opts.backup ?? true;
  const root = resolve(opts.root ?? process.cwd());

  const byFile = new Map<string, PatchOp[]>();
  for (const op of ops) {
    const list = byFile.get(op.file);
    if (list) list.push(op);
    else byFile.set(op.file, [op]);
  }
  const files = [...byFile.keys()].sort(cmpStr);

  // Pre-flight path containment — fail loud before touching anything.
  const resolved = new Map<string, { abs: string; rel: string }>();
  for (const file of files) {
    const abs = isAbsolute(file) ? resolve(file) : resolve(root, file);
    const rel = relative(root, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`applyToDisk: '${file}' resolves to '${abs}', outside root '${root}' — refusing to patch anything (set opts.root to a directory containing every target)`);
    }
    if (normPath(rel).split('/').includes(BACKUP_DIR)) {
      throw new Error(`applyToDisk: '${file}' lies inside the backup directory — refusing to patch anything`);
    }
    resolved.set(file, { abs, rel });
  }

  const outcomes: FileApplyOutcome[] = [];
  for (const file of files) {
    const { abs, rel } = resolved.get(file)!;
    const fileOps = byFile.get(file)!;

    let buf: Buffer;
    try {
      buf = readFileSync(abs);
    } catch (e) {
      outcomes.push({
        file,
        absPath: abs,
        applied: [],
        refused: [...fileOps].sort(byOpOrder).map((op) => ({ op, reason: `file could not be read: ${errMsg(e)}` })),
        written: false,
      });
      continue;
    }

    // Refuse non-UTF-8 files WHOLE: if the bytes do not survive a UTF-8
    // decode/re-encode round-trip, a lossy decode would silently rewrite bytes
    // no op targeted (U+FFFD). The file is left untouched and unbacked-up.
    const roundtrip = Buffer.from(buf.toString('utf8'), 'utf8');
    if (!roundtrip.equals(buf)) {
      let off = 0;
      const lim = Math.min(buf.length, roundtrip.length);
      while (off < lim && buf[off] === roundtrip[off]) off++;
      outcomes.push({
        file,
        absPath: abs,
        applied: [],
        refused: [...fileOps].sort(byOpOrder).map((op) => ({
          op,
          reason: `file is not valid UTF-8 (first invalid byte at offset ${off}) — convert it to UTF-8, then re-run; the file was left untouched`,
        })),
        written: false,
      });
      continue;
    }
    const text = buf.toString('utf8');

    const result = applyPatches(text, fileOps);
    if (result.refused.length > 0 || result.text === text) {
      outcomes.push({ file, absPath: abs, applied: result.applied, refused: result.refused, written: false });
      continue;
    }

    const outcome: FileApplyOutcome = { file, absPath: abs, applied: result.applied, refused: [], written: true };
    if (backup) {
      const backupPath = join(root, BACKUP_DIR, rel);
      mkdirSync(dirname(backupPath), { recursive: true });
      // Keep the FIRST backup: it is the pre-ModForge original; re-runs must not clobber it.
      if (!existsSync(backupPath)) copyFileSync(abs, backupPath);
      outcome.backupPath = backupPath;
    }
    writeFileSync(abs, result.text, 'utf8');
    outcomes.push(outcome);
  }
  return outcomes;
}
