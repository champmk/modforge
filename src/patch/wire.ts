/**
 * Wires Java scanner findings + bridge resolutions into the patcher's planning
 * contract (ResolvedJavaFinding). The scanner reports 1-based line/col but no
 * char spans, so this module recomputes each patchable token's span from the
 * file text.
 *
 * Safety: a wrong span can never produce a wrong patch. planJavaPatches
 * re-verifies every span against the expected token text, token boundaries,
 * and the comment/string mask — a drifted offset degrades to an
 * honestly-skipped finding, never a wrong edit.
 */
import type { Resolution } from '../core/model.ts';
import type { JavaFinding } from '../scan/java.ts';
import { sourceDottedName, simpleNameOf, type JavaFindingKind, type ResolvedJavaFinding } from './patch.ts';

/**
 * Scanner kind → patcher kind. Absent = structurally unpatchable (wildcard /
 * static imports, unresolved receivers, unknown simple names) — those stay
 * report findings by design.
 */
const KIND_MAP: Partial<Record<JavaFinding['kind'], JavaFindingKind>> = {
  import: 'import',
  'fqn-reference': 'fqn',
  extends: 'type-usage',
  implements: 'type-usage',
  'type-use': 'type-usage',
  'annotation-use': 'type-usage',
  new: 'type-usage',
  'class-literal': 'type-usage',
  'member-static': 'member-static',
  'member-instance': 'member-instance',
};

/** 0-based char offset of each line start (1-based line N starts at starts[N-1]). */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

const isIdentChar = (ch: string | undefined): boolean => ch !== undefined && /[\w$]/.test(ch);

/**
 * Find `token` as a standalone identifier in `text` at or after `fromIdx`,
 * within `maxAhead` chars (locality bound: the scanner's col is at worst a few
 * tokens left of the patchable one, e.g. `new X(` reports at `new`). Returns
 * the index or null.
 */
function findTokenNear(text: string, fromIdx: number, token: string, maxAhead: number): number | null {
  const limit = Math.min(text.length, fromIdx + maxAhead);
  let i = fromIdx;
  while (i <= limit) {
    const at = text.indexOf(token, i);
    if (at === -1 || at > limit) return null;
    if (!isIdentChar(text[at - 1]) && text[at - 1] !== '.' && !isIdentChar(text[at + token.length])) return at;
    i = at + 1;
  }
  return null;
}

/**
 * Find the member-name token of a callsite: the first standalone occurrence of
 * `member` at/after `fromIdx` that is preceded (ignoring whitespace) by `.` or
 * `::` — i.e. provably the member position, not the receiver text.
 */
function findMemberToken(text: string, fromIdx: number, member: string): number | null {
  let i = fromIdx;
  while (i < text.length) {
    const at = text.indexOf(member, i);
    if (at === -1) return null;
    const okRight = !isIdentChar(text[at + member.length]);
    const okLeft = !isIdentChar(text[at - 1]);
    if (okLeft && okRight) {
      let j = at - 1;
      while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
      if (text[j] === '.' || (text[j] === ':' && text[j - 1] === ':')) return at;
    }
    i = at + 1;
  }
  return null;
}

/** One scanner finding paired with its resolution and report-finding id. */
export interface PatchInput {
  finding: JavaFinding;
  resolution: Resolution;
  /** Report finding id — carried onto ops for the audit link. */
  id: string;
}

/**
 * Adapt scanner findings for one file into the patcher's planning input.
 * `fileName` is the path the plan (and ops) should carry — typically the
 * project-relative path; `fileText` is that file's current content.
 */
export function adaptForPatching(fileText: string, fileName: string, items: readonly PatchInput[]): ResolvedJavaFinding[] {
  const starts = lineStarts(fileText);
  const out: ResolvedJavaFinding[] = [];
  for (const { finding: f, resolution, id } of items) {
    const kind = KIND_MAP[f.kind];
    if (kind === undefined) continue;
    const r: ResolvedJavaFinding = { file: fileName, line: f.line, col: f.col, kind, id, resolution };
    if (f.className !== undefined) r.className = f.className;
    if (f.memberName !== undefined) r.memberName = f.memberName;
    // The scanner's 'member-instance' kind itself encodes a tracked declared
    // type (uncertain receivers get their own non-patchable kind).
    if (kind === 'member-instance') r.receiverCertain = true;

    const lineStart = starts[f.line - 1];
    if (lineStart !== undefined) {
      const pos = lineStart + f.col - 1;
      const lineEnd = starts[f.line] ?? fileText.length;
      let at: number | null = null;
      let token: string | null = null;
      if (kind === 'member-static' || kind === 'member-instance') {
        token = f.memberName ?? null;
        if (token !== null) at = findMemberToken(fileText.slice(0, lineEnd), pos, token);
      } else if (resolution.from.kind === 'class' && resolution.from.owner !== '') {
        token = kind === 'import' || kind === 'fqn' ? sourceDottedName(resolution.from.owner) : simpleNameOf(resolution.from.owner);
        at = fileText.startsWith(token, pos) ? pos : findTokenNear(fileText.slice(0, lineEnd), pos, token, 32);
      }
      if (at !== null && token !== null) r.span = { start: at, end: at + token.length };
    }
    out.push(r);
  }
  return out;
}
