/**
 * Write-robustness atom (red-before-green) for finding 07: an unwritable
 * (read-only) target must NOT abort bridge --apply mid-batch. applyToDisk has
 * to convert the write failure into a per-file refused outcome — the file left
 * untouched, no orphan backup — while every other file in the batch is still
 * written. Exit/throw behavior: applyToDisk returns normally (a refused file is
 * honest output, not an operational failure).
 *
 * Spans are hand-derived against the decoded text via indexOf. The read-only
 * attribute is restored in `finally`. Some platforms (root on POSIX) ignore a
 * 0o444 file, so a probe first confirms the OS actually enforces it; if not,
 * the test self-skips rather than producing a false pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyToDisk, BACKUP_DIR, type PatchOp } from '../src/patch/patch.ts';

/** One text-replacement op; span hand-derived against the decoded text. */
function tokenOp(file: string, decoded: string, token: string, after: string): PatchOp {
  const start = decoded.indexOf(token);
  assert.notEqual(start, -1, `decoded text must contain ${JSON.stringify(token)}`);
  return { file, start, end: start + token.length, before: token, after, findingId: `op-${file}` };
}

/** Does this OS actually refuse a write to a 0o444 file? (root ignores it.) */
function readOnlyEnforced(root: string): boolean {
  const probe = join(root, '.probe');
  writeFileSync(probe, 'x', 'utf8');
  chmodSync(probe, 0o444);
  let enforced = false;
  try {
    writeFileSync(probe, 'y', 'utf8');
  } catch {
    enforced = true;
  }
  chmodSync(probe, 0o644);
  rmSync(probe, { force: true });
  return enforced;
}

test('applyToDisk: a read-only target is refused per-file; the rest of the batch still writes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'modforge-wr-'));
  const lockedAbs = join(root, 'MMM.java');
  try {
    if (!readOnlyEnforced(root)) {
      t.skip('platform does not enforce read-only files (running as root?)');
      return;
    }

    // Three files processed in sorted order (AAA, MMM, ZZZ); MMM is read-only.
    // Pre-fix, MMM's writeFileSync throws EPERM/EACCES uncaught — AAA was already
    // written and ZZZ is never reached. The fix must let ZZZ through.
    const CONTENT = 'class OldName {}\n';
    const files = ['AAA.java', 'MMM.java', 'ZZZ.java'];
    for (const f of files) writeFileSync(join(root, f), CONTENT, 'utf8');
    const lockedBefore = readFileSync(lockedAbs); // raw pristine bytes
    chmodSync(lockedAbs, 0o444);

    const ops = files.map((f) => tokenOp(f, CONTENT, 'OldName', 'NewName'));
    const outcomes = applyToDisk(ops, { root }); // must NOT throw
    const byFile = new Map(outcomes.map((o) => [o.file, o]));

    // MMM: refused, untouched, no orphan backup.
    const mmm = byFile.get('MMM.java')!;
    assert.equal(mmm.written, false, 'a read-only file must be refused, not written');
    assert.ok(mmm.refused.length > 0, 'the op on a read-only file must be refused');
    const reason = mmm.refused.map((r) => r.reason).join('\n');
    assert.match(reason, /could not be written/i, 'refusal reason must say the file could not be written');
    assert.match(reason, /EPERM|EACCES|EROFS|EBUSY/, `refusal reason must include the OS error; got: ${reason}`);
    assert.ok(readFileSync(lockedAbs).equals(lockedBefore), 'a refused read-only file must be byte-unchanged');
    assert.ok(!existsSync(join(root, BACKUP_DIR, 'MMM.java')), 'a never-modified file must not be left with a backup');

    // AAA and ZZZ: still written (the batch continued past the failure).
    for (const f of ['AAA.java', 'ZZZ.java']) {
      const o = byFile.get(f)!;
      assert.equal(o.written, true, `${f} must still be written after the read-only file failed`);
      assert.equal(o.refused.length, 0, `${f} must not be refused`);
      assert.ok(readFileSync(join(root, f), 'utf8').includes('class NewName {}'), `${f} rewritten on disk`);
      assert.ok(existsSync(join(root, BACKUP_DIR, f)), `${f} written → backup exists`);
    }
  } finally {
    try {
      chmodSync(lockedAbs, 0o644);
    } catch {
      /* file may not exist on an early failure */
    }
    rmSync(root, { recursive: true, force: true });
  }
});
