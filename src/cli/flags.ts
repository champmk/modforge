/**
 * The CLI flag registry — the ONE place that knows which `--flags` each command
 * accepts — plus the unknown-flag check that turns a typo'd flag into an exit-2
 * usage error, instead of silently ignoring it and running with defaults.
 *
 * THE BUG this closes: `bridge --namepsace source ...`, `bridge --form 1.21.11 ...`,
 * `gradle-migrate ... --aply` parsed cleanly into the flag map, were never read by
 * the command, and the run proceeded with defaults — the user believed the flag
 * took effect. Now an unknown flag names itself and (when a real flag is a small
 * edit away) a did-you-mean.
 *
 * Pure decision logic, no I/O: the caller maps a returned message to `fail(msg, 2)`.
 * Mirrors the bridge-era.ts / bridge-namespace.ts pure-module pattern.
 *
 * ADDING A FLAG: add its bare name (no `--`) to that command's array below.
 * Nothing else — this is the single obvious place. (Note for the queued --offline
 * item: append 'offline' to the `bridge` array and you are done.)
 */
import { suggest } from '../core/levenshtein.ts';

/** Flags valid on EVERY command (never command-specific). */
export const GLOBAL_FLAGS: readonly string[] = ['help'];

/**
 * Per-command accepted flags, enumerated from each cmd* reader in main.ts and the
 * USAGE block. A flag is listed under a command only where that command actually
 * reads it — so `--json` / `--no-color` are NOT blanket-global: as no-ops on a
 * command that ignores them they would be exactly the silent-typo bug this
 * registry exists to close.
 */
export const COMMAND_FLAGS: Record<string, readonly string[]> = {
  bridge: ['from', 'to', 'namespace', 'apply', 'json', 'out', 'no-color'],
  delta: ['from', 'to', 'out', 'json'],
  'gradle-migrate': ['apply'],
  'mixin-check': ['target'],
  versions: [],
};

/**
 * The full accepted flag set for a command (command-specific ∪ global), or null
 * when the command has no registry — unknown commands and the help/usage paths,
 * which the dispatcher handles, must NOT be flag-validated.
 */
export function knownFlagsFor(cmd: string): readonly string[] | null {
  const own = COMMAND_FLAGS[cmd];
  if (own === undefined) return null;
  return [...own, ...GLOBAL_FLAGS];
}

/**
 * The first unknown flag for `cmd` as a one-line usage message (the caller does
 * `fail(msg, 2)`), or null when every flag is accepted or the command has no
 * registry. Names the offending flag and adds "did you mean --X" when a known
 * flag is a small edit away; otherwise lists the valid flags.
 */
export function checkUnknownFlags(cmd: string, flagNames: Iterable<string>): string | null {
  const known = knownFlagsFor(cmd);
  if (known === null) return null;
  const knownSet = new Set(known);
  for (const name of flagNames) {
    if (knownSet.has(name)) continue;
    const near = suggest(name, known);
    if (near !== undefined) {
      return `unknown flag --${name} for '${cmd}' — did you mean --${near}?`;
    }
    const valid = known.map((f) => `--${f}`).join(', ');
    return `unknown flag --${name} for '${cmd}'${valid === '' ? '' : ` — valid flags: ${valid}`}`;
  }
  return null;
}
