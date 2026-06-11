/**
 * Migration report model + renderers — what users actually SEE. This module
 * carries the product's honesty taxonomy (SPEC §5) onto every surface.
 *
 * One report shape serves BOTH pillar flows:
 *  - Pillar A bridge reports (1.21.x → 26.x): findings from bridge resolutions
 *    and mixin target checks, plus an optional build-script migration summary.
 *  - Pillar B delta-against-source reports (26.x → 26.y): findings from a mod's
 *    actual usage intersected with the delta, plus the whole-surface delta summary.
 *
 * Invariants (load-bearing):
 *  - DETERMINISM: identical inputs render byte-identical output on every
 *    surface. All ordering is explicit (sortFindings, sorted group keys); no
 *    clock, no randomness, no locale-dependent formatting. Renderers re-sort
 *    findings defensively — input order never leaks into output.
 *  - HONESTY: findings render grouped EXACT → CANDIDATE → UNRESOLVED, every
 *    surface carries the one-line honesty note, and UNRESOLVED is presented as
 *    a successful result with a reason — never as an error.
 *  - STABLE WIRE SCHEMA: renderJson emits schema 'modforge-report/1' with a
 *    fixed, documented key order (see renderJson). Changes within /1 are
 *    additive-only; any removal/rename/reorder bumps the schema id.
 *  - Finding ids are content-derived (sha-256 over from-symbol + source
 *    location + surface, 12 hex chars) — stable across runs on identical
 *    inputs, suitable for CI baselines and suppression lists.
 */
import { createHash } from 'node:crypto';
import type { Confidence, Resolution, SymbolRef } from '../core/model.ts';
import type { ApiDelta } from '../delta/delta.ts';
import type { GradleMigrationPlan, GradleRuleId } from '../scan/gradle.ts';
import { GRADLE_RULES } from '../scan/gradle.ts';

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

/** Report provenance header. `namespace` is the INPUT namespace of the user's code (e.g. 'named' = yarn, 'source' = mojmap). */
export interface ReportMeta {
  tool: 'modforge';
  /** ModForge version that produced the report. */
  version: string;
  /** Game version the user's code targets today, e.g. '1.21.11'. */
  fromVersion: string;
  /** Game version being migrated to, e.g. '26.1.2'. */
  toVersion: string;
  /** Symbol namespace of the input code: 'named' (yarn) | 'source' (mojmap) | ... */
  namespace: string;
  /** What was analyzed (a source dir, a symbol, a mod id) — free-form provenance. */
  generatedFor?: string;
}

/**
 * Where a finding came from in the USER's project. All fields optional: a
 * symbol queried directly (CLI `modforge bridge <symbol>`) has no location.
 * `surface` is a free-form origin tag — for mixin findings it is the
 * MixinSurface value ('mixin-target', 'at-invoke', ...); java scans use their
 * own tags. Absent fields sort first (see sortFindings).
 */
export interface FindingSource {
  /** Project-relative path, forward slashes (normalized by makeFinding). */
  file?: string;
  /** 1-based line. */
  line?: number;
  /** 1-based column. */
  col?: number;
  /** Origin surface tag, e.g. a MixinSurface value or 'java-ref'. */
  surface?: string;
}

/** A patch the EXACT-only patcher actually applied for this finding. */
export interface AppliedFix {
  file: string;
  before: string;
  after: string;
}

/**
 * One report line: a resolution anchored to its source location.
 * Invariant: `appliedFix` may only ever be present on EXACT findings — the
 * patcher never touches CANDIDATE/UNRESOLVED (SPEC §5). `skipReason` is the
 * mirror: a verbatim reason an EXACT finding was NOT auto-applied (withheld at
 * planning or refused at apply). The two are mutually exclusive — a finding is
 * either applied or carries the reason it was not.
 */
export interface Finding {
  /** Content-derived stable id — see {@link findingId}. */
  id: string;
  source: FindingSource;
  resolution: Resolution;
  appliedFix?: AppliedFix;
  /**
   * Verbatim reason an EXACT finding was not auto-applied — set only on EXACT
   * findings that produced no fix (a planning skip or an apply-time refusal).
   * CANDIDATE/UNRESOLVED are self-explaining via their group + reason, so they
   * never carry one.
   */
  skipReason?: string;
}

/** Confidence tallies. `total = exact + candidate + unresolved`. */
export interface SummaryCounts {
  exact: number;
  candidate: number;
  unresolved: number;
  total: number;
}

/** Whole-report tallies plus a per-symbol-kind breakdown (all kinds always present). */
export interface ReportSummary extends SummaryCounts {
  byKind: Record<SymbolRef['kind'], SummaryCounts>;
}

/** Summary of a {@link GradleMigrationPlan} (the pure-EXACT tier + its honest remainder). */
export interface GradleSummary {
  /** Planned EXACT edits (verified mechanical rules — auto-appliable). */
  exactEdits: number;
  /** Planned REVIEW edits (inferred — never auto-applied). */
  reviewEdits: number;
  /** Distinct files touched by edits or flagged for review, sorted. */
  files: string[];
  /** Edit counts per rule id, sorted by rule id; zero-count rules omitted. */
  byRule: { rule: GradleRuleId; count: number }[];
  /** The honesty remainder: constructs seen but deliberately not touched. */
  manualReview: { file: string; line: number; reason: string }[];
}

/** Count summary of an {@link ApiDelta} (the full lists live in the delta itself). */
export interface DeltaSummary {
  fromId: string;
  toId: string;
  classesAdded: number;
  classesRemoved: number;
  methodsAdded: number;
  methodsRemoved: number;
  fieldsAdded: number;
  fieldsRemoved: number;
  methodsDescChanged: number;
  fieldsDescChanged: number;
  classRenameCandidates: number;
  memberRenameCandidates: number;
}

/** The unified migration report — the single model all surfaces render from. */
export interface MigrationReport {
  meta: ReportMeta;
  summary: ReportSummary;
  /** Sorted by {@link sortFindings} when built via makeReport/mergeReports. */
  findings: Finding[];
  gradle?: GradleSummary;
  delta?: DeltaSummary;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wire schema id emitted by {@link renderJson}. Bumped only on breaking change. */
export const REPORT_SCHEMA = 'modforge-report/1';

/** The one-line honesty note every rendering carries (SPEC §5). */
export const HONESTY_NOTE =
  'CANDIDATE items need your judgment; UNRESOLVED items are honest unknowns, not failures.';

/** Presentation order of the taxonomy — EXACT first, honest unknowns last. */
const CONFIDENCE_ORDER: readonly Confidence[] = ['EXACT', 'CANDIDATE', 'UNRESOLVED'];

const KIND_ORDER: readonly SymbolRef['kind'][] = ['class', 'method', 'field'];

/** Per-group subtitle, restating the wire semantics of each verdict. */
const GROUP_NOTE: Record<Confidence, string> = {
  EXACT: 'every hop deterministic and verified against the target — safe to auto-apply',
  CANDIDATE: 'grounded evidence with provenance — needs your judgment, never auto-applied',
  UNRESOLVED: 'honest unknowns with reasons — a successful result, not a failure',
};

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Finding construction
// ---------------------------------------------------------------------------

/**
 * Content-derived stable finding id: 12 hex chars of sha-256 over the
 * from-symbol plus the source location and surface tag (NUL-separated, with a
 * version salt so the derivation itself is versioned). Including the location
 * keeps two references to the same symbol at different sites distinct while
 * remaining bit-stable across runs on identical inputs.
 */
export function findingId(from: SymbolRef, source: FindingSource = {}): string {
  const parts = [
    'modforge-finding/1',
    from.kind,
    from.owner,
    from.name ?? '',
    from.desc ?? '',
    source.file ?? '',
    source.line === undefined ? '' : String(source.line),
    source.col === undefined ? '' : String(source.col),
    source.surface ?? '',
  ];
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex').slice(0, 12);
}

/** Copy only defined source fields (exactOptionalPropertyTypes) and normalize the path. */
function normalizeSource(source: FindingSource): FindingSource {
  const s: FindingSource = {};
  if (source.file !== undefined) s.file = source.file.replace(/\\/g, '/');
  if (source.line !== undefined) s.line = source.line;
  if (source.col !== undefined) s.col = source.col;
  if (source.surface !== undefined) s.surface = source.surface;
  return s;
}

/**
 * Build a Finding with its content-derived id. The id is computed from the
 * NORMALIZED source (forward-slash paths) so Windows and POSIX scans of the
 * same project produce identical ids.
 */
export function makeFinding(source: FindingSource, resolution: Resolution, appliedFix?: AppliedFix): Finding {
  const normalized = normalizeSource(source);
  const f: Finding = { id: findingId(resolution.from, normalized), source: normalized, resolution };
  if (appliedFix !== undefined) f.appliedFix = appliedFix;
  return f;
}

// ---------------------------------------------------------------------------
// Summary + sorting + assembly
// ---------------------------------------------------------------------------

const zeroCounts = (): SummaryCounts => ({ exact: 0, candidate: 0, unresolved: 0, total: 0 });

function bump(c: SummaryCounts, confidence: Confidence): void {
  if (confidence === 'EXACT') c.exact++;
  else if (confidence === 'CANDIDATE') c.candidate++;
  else c.unresolved++;
  c.total++;
}

/** Tally findings by confidence, overall and per symbol kind (all kinds always present). */
export function buildSummary(findings: readonly Finding[]): ReportSummary {
  const byKind: Record<SymbolRef['kind'], SummaryCounts> = {
    class: zeroCounts(),
    method: zeroCounts(),
    field: zeroCounts(),
  };
  const top = zeroCounts();
  for (const f of findings) {
    bump(top, f.resolution.confidence);
    bump(byKind[f.resolution.from.kind], f.resolution.confidence);
  }
  return { ...top, byKind };
}

const symbolKey = (s: SymbolRef): string =>
  s.owner + '\u0000' + (s.name ?? '') + '\u0000' + (s.desc ?? '') + '\u0000' + s.kind;

const confidenceRank = (c: Confidence): number => CONFIDENCE_ORDER.indexOf(c);

/**
 * Canonical finding order: file (absent = '', sorts first), line, col
 * (absent = 0, sort before any real location), from-symbol
 * (owner, name, desc, kind), surface, confidence, then id — a deterministic
 * TOTAL order (the id tiebreak guarantees it even beyond sort stability).
 */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    cmpStr(a.source.file ?? '', b.source.file ?? '') ||
    (a.source.line ?? 0) - (b.source.line ?? 0) ||
    (a.source.col ?? 0) - (b.source.col ?? 0) ||
    cmpStr(symbolKey(a.resolution.from), symbolKey(b.resolution.from)) ||
    cmpStr(a.source.surface ?? '', b.source.surface ?? '') ||
    confidenceRank(a.resolution.confidence) - confidenceRank(b.resolution.confidence) ||
    cmpStr(a.id, b.id)
  );
}

/** Return a NEW array in canonical order ({@link compareFindings}); input untouched. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(compareFindings);
}

/**
 * Assemble a report: findings are sorted canonically and the summary is built
 * from them (never trusted from the caller). Optional sections attach only
 * when provided.
 */
export function makeReport(
  meta: ReportMeta,
  findings: readonly Finding[],
  sections: { gradle?: GradleSummary; delta?: DeltaSummary } = {},
): MigrationReport {
  const sorted = sortFindings(findings);
  const m: ReportMeta = {
    tool: 'modforge',
    version: meta.version,
    fromVersion: meta.fromVersion,
    toVersion: meta.toVersion,
    namespace: meta.namespace,
  };
  if (meta.generatedFor !== undefined) m.generatedFor = meta.generatedFor;
  const report: MigrationReport = { meta: m, summary: buildSummary(sorted), findings: sorted };
  if (sections.gradle !== undefined) report.gradle = sections.gradle;
  if (sections.delta !== undefined) report.delta = sections.delta;
  return report;
}

/** Reduce a {@link GradleMigrationPlan} to its report summary (counts + honest remainder). */
export function summarizeGradlePlan(plan: GradleMigrationPlan): GradleSummary {
  let exactEdits = 0;
  let reviewEdits = 0;
  const ruleCounts = new Map<GradleRuleId, number>();
  const files = new Set<string>();
  for (const e of plan.edits) {
    if (e.confidence === 'EXACT') exactEdits++;
    else reviewEdits++;
    ruleCounts.set(e.rule, (ruleCounts.get(e.rule) ?? 0) + 1);
    files.add(e.file.replace(/\\/g, '/'));
  }
  const manualReview = plan.manualReview.map((m) => ({
    file: m.file.replace(/\\/g, '/'),
    line: m.span.line,
    reason: m.reason,
  }));
  for (const m of manualReview) files.add(m.file);
  manualReview.sort((a, b) => cmpStr(a.file, b.file) || a.line - b.line || cmpStr(a.reason, b.reason));
  const byRule = [...ruleCounts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => cmpStr(a.rule, b.rule));
  return { exactEdits, reviewEdits, files: [...files].sort(), byRule, manualReview };
}

/** Reduce an {@link ApiDelta} to its count summary (the full lists stay in the delta). */
export function summarizeDelta(delta: ApiDelta): DeltaSummary {
  return {
    fromId: delta.fromId,
    toId: delta.toId,
    classesAdded: delta.classesAdded.length,
    classesRemoved: delta.classesRemoved.length,
    methodsAdded: delta.methodsAdded.length,
    methodsRemoved: delta.methodsRemoved.length,
    fieldsAdded: delta.fieldsAdded.length,
    fieldsRemoved: delta.fieldsRemoved.length,
    methodsDescChanged: delta.methodsDescChanged.length,
    fieldsDescChanged: delta.fieldsDescChanged.length,
    classRenameCandidates: delta.classRenameCandidates.length,
    memberRenameCandidates: delta.memberRenameCandidates.length,
  };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

function mergeGradleSummaries(into: GradleSummary, add: GradleSummary): GradleSummary {
  const ruleCounts = new Map<GradleRuleId, number>();
  for (const r of [...into.byRule, ...add.byRule]) ruleCounts.set(r.rule, (ruleCounts.get(r.rule) ?? 0) + r.count);
  const seen = new Set<string>();
  const manualReview: GradleSummary['manualReview'] = [];
  for (const m of [...into.manualReview, ...add.manualReview]) {
    const k = m.file + '\u0000' + m.line + '\u0000' + m.reason;
    if (seen.has(k)) continue;
    seen.add(k);
    manualReview.push(m);
  }
  manualReview.sort((a, b) => cmpStr(a.file, b.file) || a.line - b.line || cmpStr(a.reason, b.reason));
  return {
    exactEdits: into.exactEdits + add.exactEdits,
    reviewEdits: into.reviewEdits + add.reviewEdits,
    files: [...new Set([...into.files, ...add.files])].sort(),
    byRule: [...ruleCounts.entries()].map(([rule, count]) => ({ rule, count })).sort((a, b) => cmpStr(a.rule, b.rule)),
    manualReview,
  };
}

/** Two delta summaries for the same version pair must be identical — anything else is conflicting data. */
function assertSameDelta(a: DeltaSummary, b: DeltaSummary): void {
  for (const key of Object.keys(a) as (keyof DeltaSummary)[]) {
    if (a[key] !== b[key]) {
      throw new Error(
        `mergeReports: conflicting delta summaries — '${key}' differs (${String(a[key])} vs ${String(b[key])}); ` +
          'identical version pairs must produce identical deltas, so this indicates mixed inputs.',
      );
    }
  }
}

/**
 * Merge reports from parallel scans of ONE migration (same fromVersion,
 * toVersion, namespace — anything else throws; merging across version pairs
 * would misattribute findings, a confidently-wrong answer).
 *
 * - findings: concatenated in input order, deduplicated by id (first wins —
 *   identical ids denote the same symbol at the same location), re-sorted, and
 *   the summary rebuilt.
 * - meta: version taken from the first report; distinct `generatedFor` values
 *   are joined with ' + ' (sorted) so provenance is kept, never guessed away.
 * - gradle: summaries are summed (rule counts, edit counts) with manual-review
 *   items deduplicated.
 * - delta: must agree exactly across reports (same version pair ⇒ same delta);
 *   conflicts throw.
 */
export function mergeReports(reports: readonly MigrationReport[]): MigrationReport {
  const first = reports[0];
  if (first === undefined) throw new Error('mergeReports: at least one report is required');
  for (const r of reports) {
    if (
      r.meta.fromVersion !== first.meta.fromVersion ||
      r.meta.toVersion !== first.meta.toVersion ||
      r.meta.namespace !== first.meta.namespace
    ) {
      throw new Error(
        `mergeReports: refusing to merge mismatched metas — ` +
          `${r.meta.fromVersion}→${r.meta.toVersion} (${r.meta.namespace}) vs ` +
          `${first.meta.fromVersion}→${first.meta.toVersion} (${first.meta.namespace}).`,
      );
    }
  }

  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const r of reports) {
    for (const f of r.findings) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      findings.push(f);
    }
  }

  const meta: ReportMeta = {
    tool: 'modforge',
    version: first.meta.version,
    fromVersion: first.meta.fromVersion,
    toVersion: first.meta.toVersion,
    namespace: first.meta.namespace,
  };
  const gens = [...new Set(reports.map((r) => r.meta.generatedFor).filter((g): g is string => g !== undefined))].sort();
  if (gens.length > 0) meta.generatedFor = gens.join(' + ');

  let gradle: GradleSummary | undefined;
  for (const r of reports) {
    if (r.gradle === undefined) continue;
    gradle = gradle === undefined
      ? mergeGradleSummaries({ exactEdits: 0, reviewEdits: 0, files: [], byRule: [], manualReview: [] }, r.gradle)
      : mergeGradleSummaries(gradle, r.gradle);
  }
  let delta: DeltaSummary | undefined;
  for (const r of reports) {
    if (r.delta === undefined) continue;
    if (delta === undefined) delta = { ...r.delta };
    else assertSameDelta(delta, r.delta);
  }

  const sections: { gradle?: GradleSummary; delta?: DeltaSummary } = {};
  if (gradle !== undefined) sections.gradle = gradle;
  if (delta !== undefined) sections.delta = delta;
  return makeReport(meta, findings, sections);
}

// ---------------------------------------------------------------------------
// Apply-phase annotation + truthful summary
// ---------------------------------------------------------------------------

/** One file's withheld/refused EXACT findings, reasons verbatim — for human output. */
export interface ApplyReviewGroup {
  /** Source file (normalized forward slashes; '' = no source location). */
  file: string;
  /** One entry per withheld/refused EXACT finding in this file, sorted. */
  items: { line?: number; reason: string }[];
}

/**
 * Truthful post-apply summary derived ENTIRELY from the annotated findings —
 * never from a final-pass re-scan of the already-patched tree (that double-counts
 * the very fixes the run applied). `applied + leftForReview === total`.
 */
export interface ApplyReview {
  /** Findings that received an applied fix. */
  applied: number;
  /**
   * Findings with no applied fix == CANDIDATE + UNRESOLVED + withheld/refused
   * EXACT. This is the honest review remainder.
   */
  leftForReview: number;
  /** Withheld/refused EXACT findings grouped per file (sorted), reasons verbatim. */
  reviewByFile: ApplyReviewGroup[];
}

/**
 * Annotate report findings IN PLACE with what the apply phase actually did:
 * an applied fix wins; otherwise an EXACT finding that was withheld at planning
 * or refused at apply carries the verbatim reason as `skipReason`. The maps are
 * keyed by report-finding id. Reasons keyed by an id no finding owns (e.g. a
 * phantom re-detection of an already-patched name in a later pass) are ignored —
 * exactly the count that used to leak into "left for review".
 */
export function annotateApply(
  findings: readonly Finding[],
  fixes: ReadonlyMap<string, AppliedFix>,
  skipReasons: ReadonlyMap<string, string>,
): void {
  for (const f of findings) {
    const fix = fixes.get(f.id);
    if (fix !== undefined) {
      f.appliedFix = fix;
      continue;
    }
    const reason = skipReasons.get(f.id);
    if (reason !== undefined && f.resolution.confidence === 'EXACT') f.skipReason = reason;
  }
}

/** Summarize the apply phase from the annotated findings (call after {@link annotateApply}). */
export function summarizeApply(findings: readonly Finding[]): ApplyReview {
  let applied = 0;
  for (const f of findings) if (f.appliedFix !== undefined) applied++;

  const byFile = new Map<string, { line?: number; reason: string }[]>();
  for (const f of findings) {
    if (f.skipReason === undefined) continue;
    const key = f.source.file ?? '';
    const arr = byFile.get(key) ?? [];
    const item: { line?: number; reason: string } = { reason: f.skipReason };
    if (f.source.line !== undefined) item.line = f.source.line;
    arr.push(item);
    byFile.set(key, arr);
  }
  const reviewByFile = [...byFile.entries()]
    .sort((a, b) => cmpStr(a[0], b[0]))
    .map(([file, items]) => ({
      file,
      items: items.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || cmpStr(a.reason, b.reason)),
    }));

  return { applied, leftForReview: findings.length - applied, reviewByFile };
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

/**
 * Canonical one-line symbol form: classes as the binary name; methods as
 * `owner#name(args)ret`; fields as `owner#name:Ldesc;` (the mixin member-info
 * convention, so report text round-trips with mixin target strings).
 */
export function formatSymbol(ref: SymbolRef): string {
  if (ref.kind === 'class') return ref.owner;
  const name = ref.name ?? '<unknown>';
  if (ref.desc === undefined) return `${ref.owner}#${name}`;
  return ref.kind === 'method' ? `${ref.owner}#${name}${ref.desc}` : `${ref.owner}#${name}:${ref.desc}`;
}

const locText = (s: FindingSource): string =>
  s.line === undefined ? '' : s.col === undefined ? `L${s.line}` : `L${s.line}:${s.col}`;

const NO_FILE = '(no source location)';

/** Group canonically-sorted findings by file, file keys sorted ('' = location-less, first). */
function groupByFile(findings: readonly Finding[]): [string, Finding[]][] {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const k = f.source.file ?? '';
    const arr = map.get(k);
    if (arr) arr.push(f);
    else map.set(k, [f]);
  }
  return [...map.entries()].sort((a, b) => cmpStr(a[0], b[0]));
}

const ruleDescriptions: ReadonlyMap<string, string> = new Map(GRADLE_RULES.map((r) => [r.id, r.description]));

// ---------------------------------------------------------------------------
// Terminal renderer
// ---------------------------------------------------------------------------

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  cyan: '\u001b[36m',
} as const;

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  EXACT: ANSI.green,
  CANDIDATE: ANSI.yellow,
  // deliberately NOT red: UNRESOLVED is a successful result, not an error
  UNRESOLVED: ANSI.cyan,
};

/** Options for {@link renderTerminal}. */
export interface TerminalRenderOptions {
  /** Emit ANSI color codes (default false — plain text; the CLI opts in on a TTY). */
  color?: boolean;
}

/**
 * Decide whether the terminal renderer should emit ANSI color. Pure so the CLI
 * can pass real process state and tests can hand-derive every case.
 *
 * Default color = (stdout is a TTY) AND (NO_COLOR is unset or empty). The
 * `--no-color` flag forces it off regardless. Honors the NO_COLOR convention
 * (https://no-color.org): ANY non-empty value disables color; an empty string
 * does NOT (presence alone is not enough — the value must be non-empty).
 */
export function colorEnabled(
  noColorFlag: boolean,
  env: { NO_COLOR?: string | undefined },
  isTTY: boolean,
): boolean {
  if (noColorFlag) return false;
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  return isTTY;
}

/**
 * Render the report for a terminal: summary header with the honesty note, then
 * findings grouped by confidence (EXACT → CANDIDATE → UNRESOLVED) with per-file
 * sections, each finding carrying its evidence/reason and full audit chain,
 * then the gradle and delta sections when present. Deterministic; with
 * `color: false` (the default) the output contains no escape codes at all.
 */
export function renderTerminal(report: MigrationReport, opts: TerminalRenderOptions = {}): string {
  const color = opts.color ?? false;
  const paint = (code: string, s: string): string => (color ? code + s + ANSI.reset : s);
  const lines: string[] = [];
  const m = report.meta;
  const s = report.summary;

  lines.push(
    `${paint(ANSI.bold, `${m.tool} migration report`)} — ${m.fromVersion} → ${m.toVersion} ` +
      `(namespace ${m.namespace}, ${m.tool} v${m.version})`,
  );
  if (m.generatedFor !== undefined) lines.push(`for: ${m.generatedFor}`);
  lines.push('');
  lines.push(
    `summary: ${paint(CONFIDENCE_COLOR.EXACT, `EXACT ${s.exact}`)} · ` +
      `${paint(CONFIDENCE_COLOR.CANDIDATE, `CANDIDATE ${s.candidate}`)} · ` +
      `${paint(CONFIDENCE_COLOR.UNRESOLVED, `UNRESOLVED ${s.unresolved}`)} · total ${s.total}`,
  );
  lines.push(
    `by kind: ` +
      KIND_ORDER.map((k) => {
        const c = s.byKind[k];
        return `${k} ${c.exact}/${c.candidate}/${c.unresolved}`;
      }).join(' · ') +
      '  (EXACT/CANDIDATE/UNRESOLVED)',
  );
  lines.push(`note: ${HONESTY_NOTE}`);

  const sorted = sortFindings(report.findings);
  for (const conf of CONFIDENCE_ORDER) {
    const group = sorted.filter((f) => f.resolution.confidence === conf);
    lines.push('');
    lines.push(paint(ANSI.bold + CONFIDENCE_COLOR[conf], `${conf} (${group.length})`) + ` — ${GROUP_NOTE[conf]}`);
    if (group.length === 0) {
      lines.push('  none');
      continue;
    }
    for (const [file, items] of groupByFile(group)) {
      lines.push(`  ${file === '' ? NO_FILE : file}`);
      for (const f of items) {
        const r = f.resolution;
        const loc = locText(f.source);
        const head = [loc, `[${f.id}]`, f.source.surface, `${r.from.kind} ${formatSymbol(r.from)}`]
          .filter((p): p is string => p !== undefined && p !== '')
          .join(' ');
        lines.push(`    ${head}`);
        if (conf === 'EXACT') {
          lines.push(
            `      → ${r.to !== undefined ? formatSymbol(r.to) : '<missing to — malformed EXACT resolution>'}`,
          );
        } else if (conf === 'CANDIDATE') {
          for (const cand of r.candidates ?? []) {
            lines.push(`      →? ${formatSymbol(cand.to)} ${paint(ANSI.bold, `(score ${cand.score})`)}`);
            lines.push(`         ${cand.evidence}`);
          }
          if ((r.candidates ?? []).length === 0) lines.push('      (no candidates listed)');
        }
        lines.push(`      reason: ${r.reason}`);
        if (f.appliedFix !== undefined) {
          lines.push(
            `      fix applied: ${f.appliedFix.file}: ${JSON.stringify(f.appliedFix.before)} → ${JSON.stringify(f.appliedFix.after)}`,
          );
        } else if (f.skipReason !== undefined) {
          lines.push(`      not applied: ${f.skipReason}`);
        }
        for (const step of r.chain) lines.push(paint(ANSI.dim, `      · ${step}`));
      }
    }
  }

  if (report.gradle !== undefined) {
    const g = report.gradle;
    lines.push('');
    lines.push(paint(ANSI.bold, 'build-script migration'));
    lines.push(
      `  ${g.exactEdits} EXACT edit(s), ${g.reviewEdits} REVIEW edit(s) across ${g.files.length} file(s)` +
        ' — REVIEW edits are never auto-applied',
    );
    for (const r of g.byRule) {
      lines.push(`    ${r.rule} ×${r.count} — ${ruleDescriptions.get(r.rule) ?? '(rule not in the verified table)'}`);
    }
    if (g.manualReview.length > 0) {
      lines.push(`  manual review (${g.manualReview.length}) — seen but deliberately not touched:`);
      for (const mr of g.manualReview) lines.push(`    ${mr.file}:${mr.line} — ${mr.reason}`);
    }
  }

  if (report.delta !== undefined) {
    const d = report.delta;
    lines.push('');
    lines.push(paint(ANSI.bold, `api delta ${d.fromId} → ${d.toId}`));
    lines.push(`  classes: +${d.classesAdded} −${d.classesRemoved} (rename candidates ${d.classRenameCandidates})`);
    lines.push(`  methods: +${d.methodsAdded} −${d.methodsRemoved} ~${d.methodsDescChanged}`);
    lines.push(`  fields:  +${d.fieldsAdded} −${d.fieldsRemoved} ~${d.fieldsDescChanged}`);
    lines.push(`  member rename candidates (methods + fields): ${d.memberRenameCandidates} — all CANDIDATE-grade`);
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/** Escape table-breaking characters; newlines become `<br>` so cells stay single-row. */
const mdText = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>');

/** Code-span a value for a table cell (backticks inside content degraded to quotes). */
const mdCode = (s: string): string => (s === '' ? '' : '`' + mdText(s.replace(/`/g, "'")) + '`');

function mdFindingRow(f: Finding, conf: Confidence, withFixColumn: boolean): string {
  const r = f.resolution;
  const loc = mdText(locText(f.source).replace(/^L/, ''));
  const surface = mdCode(f.source.surface ?? '');
  const from = mdCode(`${r.from.kind} ${formatSymbol(r.from)}`);
  if (conf === 'EXACT') {
    const to = r.to !== undefined ? mdCode(formatSymbol(r.to)) : '*missing — malformed EXACT resolution*';
    if (!withFixColumn) return `| ${loc} | ${surface} | ${from} | ${to} |`;
    const status =
      f.appliedFix !== undefined
        ? `${mdCode(f.appliedFix.file)}: ${mdCode(f.appliedFix.before)} → ${mdCode(f.appliedFix.after)}`
        : f.skipReason !== undefined
          ? `*withheld* — ${mdText(f.skipReason)}`
          : '';
    return `| ${loc} | ${surface} | ${from} | ${to} | ${status} |`;
  }
  if (conf === 'CANDIDATE') {
    const cands = (r.candidates ?? [])
      .map((c) => `${mdCode(formatSymbol(c.to))} (score ${c.score}) — ${mdText(c.evidence)}`)
      .join('<br><br>');
    return `| ${loc} | ${surface} | ${from} | ${cands === '' ? '*(no candidates listed)*' : cands} |`;
  }
  return `| ${loc} | ${surface} | ${from} | ${mdText(r.reason)} |`;
}

/** EXACT gets the status column only when at least one fix was applied or withheld. */
function mdTableHead(conf: Confidence, withFixColumn: boolean): string[] {
  if (conf === 'EXACT') {
    return withFixColumn
      ? ['| line | surface | from | to | applied fix / withheld |', '|---|---|---|---|---|']
      : ['| line | surface | from | to |', '|---|---|---|---|'];
  }
  if (conf === 'CANDIDATE') {
    return ['| line | surface | from | candidates (ranked, with evidence) |', '|---|---|---|---|'];
  }
  return ['| line | surface | from | reason |', '|---|---|---|---|'];
}

/**
 * Render the report as GitHub-flavored Markdown: meta header, honesty note,
 * summary table, per-confidence sections with per-file findings tables, audit
 * chains tucked into `<details>` blocks per file, then the gradle and delta
 * sections when present. Deterministic.
 */
export function renderMarkdown(report: MigrationReport): string {
  const lines: string[] = [];
  const m = report.meta;
  const s = report.summary;

  lines.push('# ModForge migration report');
  lines.push('');
  lines.push(
    `**${m.tool} v${mdText(m.version)}** · \`${m.fromVersion}\` → \`${m.toVersion}\` · namespace \`${m.namespace}\`` +
      (m.generatedFor !== undefined ? ` · for ${mdCode(m.generatedFor)}` : ''),
  );
  lines.push('');
  lines.push(`> ${HONESTY_NOTE}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| confidence | class | method | field | total |');
  lines.push('|---|---:|---:|---:|---:|');
  lines.push(`| EXACT | ${s.byKind.class.exact} | ${s.byKind.method.exact} | ${s.byKind.field.exact} | ${s.exact} |`);
  lines.push(
    `| CANDIDATE | ${s.byKind.class.candidate} | ${s.byKind.method.candidate} | ${s.byKind.field.candidate} | ${s.candidate} |`,
  );
  lines.push(
    `| UNRESOLVED | ${s.byKind.class.unresolved} | ${s.byKind.method.unresolved} | ${s.byKind.field.unresolved} | ${s.unresolved} |`,
  );
  lines.push(
    `| **total** | ${s.byKind.class.total} | ${s.byKind.method.total} | ${s.byKind.field.total} | ${s.total} |`,
  );

  const sorted = sortFindings(report.findings);
  // The status column appears when any EXACT finding was applied OR withheld.
  const hasFixes = sorted.some((f) => f.appliedFix !== undefined || f.skipReason !== undefined);
  for (const conf of CONFIDENCE_ORDER) {
    const group = sorted.filter((f) => f.resolution.confidence === conf);
    lines.push('');
    lines.push(`## ${conf} (${group.length})`);
    lines.push('');
    lines.push(`*${GROUP_NOTE[conf]}*`);
    if (group.length === 0) {
      lines.push('');
      lines.push('none');
      continue;
    }
    for (const [file, items] of groupByFile(group)) {
      lines.push('');
      lines.push(`### ${file === '' ? NO_FILE : mdCode(file)}`);
      lines.push('');
      for (const head of mdTableHead(conf, hasFixes)) lines.push(head);
      for (const f of items) lines.push(mdFindingRow(f, conf, hasFixes));
      lines.push('');
      lines.push('<details>');
      // One chain per unique resolution — the same symbol resolved identically
      // at N sites proves itself once. Insertion order follows the canonical
      // finding order, so output stays deterministic.
      const unique = new Map<string, { f: Finding; count: number }>();
      for (const f of items) {
        const k =
          symbolKey(f.resolution.from) + ' ' + f.resolution.reason + ' ' + f.resolution.chain.join(' ');
        const seen = unique.get(k);
        if (seen) seen.count++;
        else unique.set(k, { f, count: 1 });
      }
      const label =
        unique.size === items.length
          ? `Audit chains (${items.length} finding${items.length === 1 ? '' : 's'})`
          : `Audit chains (${unique.size} unique symbol${unique.size === 1 ? '' : 's'} across ${items.length} findings)`;
      lines.push(`<summary>${label}</summary>`);
      lines.push('');
      for (const { f, count } of unique.values()) {
        const times = count === 1 ? '' : ` *(×${count})*`;
        lines.push(`- ${mdCode(formatSymbol(f.resolution.from))}${times} — ${mdText(f.resolution.reason)}`);
        if (f.resolution.chain.length === 0) lines.push('  - (no chain recorded)');
        else for (let i = 0; i < f.resolution.chain.length; i++) lines.push(`  ${i + 1}. ${mdText(f.resolution.chain[i]!)}`);
      }
      lines.push('');
      lines.push('</details>');
    }
  }

  if (report.gradle !== undefined) {
    const g = report.gradle;
    lines.push('');
    lines.push('## Build-script migration');
    lines.push('');
    lines.push(
      `**${g.exactEdits} EXACT** edit(s) and **${g.reviewEdits} REVIEW** edit(s) across ` +
        `**${g.files.length}** file(s). REVIEW edits are never auto-applied.`,
    );
    if (g.byRule.length > 0) {
      lines.push('');
      lines.push('| rule | edits | description |');
      lines.push('|---|---:|---|');
      for (const r of g.byRule) {
        lines.push(
          `| ${mdCode(r.rule)} | ${r.count} | ${mdText(ruleDescriptions.get(r.rule) ?? '(rule not in the verified table)')} |`,
        );
      }
    }
    lines.push('');
    lines.push(`### Manual review (${g.manualReview.length})`);
    lines.push('');
    if (g.manualReview.length === 0) {
      lines.push('No manual-review items — every recognized construct matched a verified rule.');
    } else {
      lines.push('| file | line | reason |');
      lines.push('|---|---:|---|');
      for (const mr of g.manualReview) lines.push(`| ${mdCode(mr.file)} | ${mr.line} | ${mdText(mr.reason)} |`);
    }
  }

  if (report.delta !== undefined) {
    const d = report.delta;
    lines.push('');
    lines.push(`## API delta: \`${d.fromId}\` → \`${d.toId}\``);
    lines.push('');
    lines.push('| surface | added | removed | desc-changed | rename candidates |');
    lines.push('|---|---:|---:|---:|---:|');
    lines.push(`| classes | ${d.classesAdded} | ${d.classesRemoved} | — | ${d.classRenameCandidates} |`);
    lines.push(`| methods | ${d.methodsAdded} | ${d.methodsRemoved} | ${d.methodsDescChanged} | — |`);
    lines.push(`| fields | ${d.fieldsAdded} | ${d.fieldsRemoved} | ${d.fieldsDescChanged} | — |`);
    lines.push('');
    lines.push(
      `Member rename candidates (methods + fields combined): **${d.memberRenameCandidates}** — ` +
        'all CANDIDATE-grade; renames are structurally unprovable in an unobfuscated world.',
    );
  }

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// JSON renderer — the stable wire schema
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function jSymbol(s: SymbolRef): Json {
  const o: Json = { kind: s.kind, owner: s.owner };
  if (s.name !== undefined) o['name'] = s.name;
  if (s.desc !== undefined) o['desc'] = s.desc;
  return o;
}

function jCounts(c: SummaryCounts): Json {
  return { exact: c.exact, candidate: c.candidate, unresolved: c.unresolved, total: c.total };
}

function jFinding(f: Finding): Json {
  const src: Json = {};
  if (f.source.file !== undefined) src['file'] = f.source.file;
  if (f.source.line !== undefined) src['line'] = f.source.line;
  if (f.source.col !== undefined) src['col'] = f.source.col;
  if (f.source.surface !== undefined) src['surface'] = f.source.surface;

  const r = f.resolution;
  const res: Json = { from: jSymbol(r.from), confidence: r.confidence };
  if (r.to !== undefined) res['to'] = jSymbol(r.to);
  if (r.candidates !== undefined) {
    res['candidates'] = r.candidates.map((c) => ({ to: jSymbol(c.to), score: c.score, evidence: c.evidence }));
  }
  res['reason'] = r.reason;
  res['chain'] = [...r.chain];

  const o: Json = { id: f.id, source: src, resolution: res };
  if (f.appliedFix !== undefined) {
    o['appliedFix'] = { file: f.appliedFix.file, before: f.appliedFix.before, after: f.appliedFix.after };
  }
  if (f.skipReason !== undefined) o['skipReason'] = f.skipReason;
  return o;
}

/**
 * Render the report as stable JSON for CI consumption (2-space indent,
 * trailing newline).
 *
 * Schema `modforge-report/1`. Key order is FIXED exactly as listed below
 * (objects are constructed explicitly in this order — JSON.stringify preserves
 * string-key insertion order per the JS spec). Optional keys are OMITTED when
 * absent, never null. All arrays are sorted as noted.
 *
 * ```
 * {
 *   schema: 'modforge-report/1',
 *   meta: { tool: 'modforge', version, fromVersion, toVersion, namespace, generatedFor? },
 *   summary: {
 *     exact, candidate, unresolved, total,           // numbers; total = sum
 *     byKind: { class: C, method: C, field: C }      // C = { exact, candidate, unresolved, total }
 *   },
 *   findings: [                                      // sorted: file, line, col, from-symbol, surface, confidence, id
 *     {
 *       id,                                          // 12 hex chars, content-derived (findingId)
 *       source: { file?, line?, col?, surface? },
 *       resolution: {
 *         from: { kind, owner, name?, desc? },       // kind: 'class' | 'method' | 'field'
 *         confidence,                                // 'EXACT' | 'CANDIDATE' | 'UNRESOLVED' — the taxonomy enum
 *         to?: { kind, owner, name?, desc? },        // EXACT only
 *         candidates?: [{ to, score, evidence }],    // CANDIDATE only, ranked best-first
 *         reason,                                    // honest explanation, always present
 *         chain: [string, ...]                       // full audit trail in hop order
 *       },
 *       appliedFix?: { file, before, after },        // EXACT-only patcher output
 *       skipReason?: string                          // EXACT-only: why it was NOT auto-applied
 *     }
 *   ],
 *   gradle?: {                                       // build-script migration summary
 *     exactEdits, reviewEdits,
 *     files: [path, ...],                            // sorted distinct
 *     byRule: [{ rule, count }, ...],                // sorted by rule id
 *     manualReview: [{ file, line, reason }, ...]    // sorted by (file, line, reason)
 *   },
 *   delta?: {                                        // API delta summary
 *     fromId, toId,
 *     classesAdded, classesRemoved,
 *     methodsAdded, methodsRemoved,
 *     fieldsAdded, fieldsRemoved,
 *     methodsDescChanged, fieldsDescChanged,
 *     classRenameCandidates, memberRenameCandidates
 *   }
 * }
 * ```
 *
 * Stability policy: within `/1`, changes are ADDITIVE-ONLY (new optional keys
 * appended to their object). Any removal, rename, type change, or reordering
 * bumps the schema id. UNRESOLVED findings appear here as ordinary successful
 * results — consumers must not treat them as errors (SPEC §5).
 */
export function renderJson(report: MigrationReport): string {
  const m = report.meta;
  const meta: Json = {
    tool: m.tool,
    version: m.version,
    fromVersion: m.fromVersion,
    toVersion: m.toVersion,
    namespace: m.namespace,
  };
  if (m.generatedFor !== undefined) meta['generatedFor'] = m.generatedFor;

  const s = report.summary;
  const summary: Json = {
    exact: s.exact,
    candidate: s.candidate,
    unresolved: s.unresolved,
    total: s.total,
    byKind: { class: jCounts(s.byKind.class), method: jCounts(s.byKind.method), field: jCounts(s.byKind.field) },
  };

  const model: Json = { schema: REPORT_SCHEMA, meta, summary, findings: sortFindings(report.findings).map(jFinding) };

  if (report.gradle !== undefined) {
    const g = report.gradle;
    model['gradle'] = {
      exactEdits: g.exactEdits,
      reviewEdits: g.reviewEdits,
      files: [...g.files],
      byRule: g.byRule.map((r) => ({ rule: r.rule, count: r.count })),
      manualReview: g.manualReview.map((mr) => ({ file: mr.file, line: mr.line, reason: mr.reason })),
    };
  }
  if (report.delta !== undefined) {
    const d = report.delta;
    model['delta'] = {
      fromId: d.fromId,
      toId: d.toId,
      classesAdded: d.classesAdded,
      classesRemoved: d.classesRemoved,
      methodsAdded: d.methodsAdded,
      methodsRemoved: d.methodsRemoved,
      fieldsAdded: d.fieldsAdded,
      fieldsRemoved: d.fieldsRemoved,
      methodsDescChanged: d.methodsDescChanged,
      fieldsDescChanged: d.fieldsDescChanged,
      classRenameCandidates: d.classRenameCandidates,
      memberRenameCandidates: d.memberRenameCandidates,
    };
  }
  return JSON.stringify(model, null, 2) + '\n';
}
