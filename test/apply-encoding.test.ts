/**
 * Encoding-safety atom (red-before-green): non-UTF-8 bytes must never be
 * silently corrupted on apply.
 *
 * Frozen contract under test (lead-specified):
 *  - applyToDisk reads each target as a raw Buffer; if it is not valid UTF-8
 *    (Buffer.from(buf.toString('utf8'),'utf8') is not byte-equal to buf) the
 *    WHOLE file is refused — not written, not backed up — with a reason naming
 *    UTF-8 and the byte offset of the first non-roundtripping byte.
 *  - A BOM (EF BB BF) is valid UTF-8 and must still be patched normally.
 *  - gradle-migrate excludes non-roundtripping files entirely (one stderr line
 *    per file) while valid files migrate; backups are raw byte copies.
 *
 * Every expectation is hand-derived from the bytes written below. Raw non-UTF-8
 * bytes are produced with Buffers only (never shell echo). Byte equality is
 * checked on raw Buffers (readFileSync with no encoding). gradle-migrate is
 * fully offline, so the spawned CLI runs are deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyToDisk, BACKUP_DIR, type PatchOp } from '../src/patch/patch.ts';

const REPO = 'C:/Users/paci0/Desktop/modforge';

/** One text-replacement op; its span is hand-derived against the DECODED text. */
function tokenOp(file: string, decoded: string, token: string, after: string): PatchOp {
  const start = decoded.indexOf(token);
  assert.notEqual(start, -1, `decoded text must contain ${JSON.stringify(token)}`);
  return { file, start, end: start + token.length, before: token, after, findingId: 'enc-unit' };
}

// ---------------------------------------------------------------------------
// applyToDisk
// ---------------------------------------------------------------------------

test('applyToDisk refuses a non-UTF-8 file whole: no write, no backup, offset named', () => {
  const root = mkdtempSync(join(tmpdir(), 'modforge-enc-'));
  try {
    // ascii ... lone 0xE9 (inside a comment) ... + a genuinely patchable token after it
    const bytes = Buffer.concat([
      Buffer.from('package demo;\n// caf', 'utf8'),
      Buffer.from([0xe9]),
      Buffer.from(' latte\nclass OldName {}\n', 'utf8'),
    ]);
    const abs = join(root, 'Demo.java');
    writeFileSync(abs, bytes);
    const before = readFileSync(abs); // raw pristine bytes

    const e9Offset = bytes.indexOf(0xe9); // first (and only) non-UTF-8 byte
    // span computed by hand against the DECODED text (0xE9 -> one U+FFFD)
    const op = tokenOp('Demo.java', bytes.toString('utf8'), 'OldName', 'NewName');

    const [outcome] = applyToDisk([op], { root });

    assert.equal(outcome!.written, false, 'a non-UTF-8 file must not be written');
    assert.ok(outcome!.refused.length > 0, 'the op must be refused');
    const reason = outcome!.refused.map((r) => r.reason).join('\n');
    assert.match(reason, /UTF-8/i, 'refusal reason must name UTF-8');
    assert.ok(reason.includes(String(e9Offset)), `refusal reason must name byte offset ${e9Offset}; got: ${reason}`);

    assert.ok(readFileSync(abs).equals(before), 'on-disk bytes must be unchanged after a refusal');
    assert.ok(!existsSync(join(root, BACKUP_DIR, 'Demo.java')), 'a refused file must not be backed up');
    assert.equal(outcome!.backupPath, undefined, 'no backup path on a refused file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyToDisk still patches a valid UTF-8 file and keeps a byte-exact backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'modforge-enc-'));
  try {
    // identical content to the refusal case, MINUS the 0xE9 byte
    const bytes = Buffer.from('package demo;\n// caf latte\nclass OldName {}\n', 'utf8');
    const abs = join(root, 'Demo.java');
    writeFileSync(abs, bytes);
    const pristine = readFileSync(abs);

    const op = tokenOp('Demo.java', bytes.toString('utf8'), 'OldName', 'NewName');
    const [outcome] = applyToDisk([op], { root });

    assert.equal(outcome!.written, true, 'a valid file must still be patched');
    assert.equal(outcome!.refused.length, 0);
    assert.ok(readFileSync(abs, 'utf8').includes('class NewName {}'), 'token rewritten on disk');
    const backupPath = outcome!.backupPath!;
    assert.ok(existsSync(backupPath), 'a written file gets a backup');
    assert.ok(readFileSync(backupPath).equals(pristine), 'backup bytes must equal the pristine original');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyToDisk patches a UTF-8 file WITH a BOM and preserves the BOM', () => {
  const root = mkdtempSync(join(tmpdir(), 'modforge-enc-'));
  try {
    const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
    const bytes = Buffer.concat([BOM, Buffer.from('class OldName {}\n', 'utf8')]);
    const abs = join(root, 'Bom.java');
    writeFileSync(abs, bytes);

    // the decoded text keeps the BOM as U+FEFF, so the token offset accounts for it
    const op = tokenOp('Bom.java', bytes.toString('utf8'), 'OldName', 'NewName');
    const [outcome] = applyToDisk([op], { root });

    assert.equal(outcome!.written, true, 'a BOM file is valid UTF-8 and must be patched');
    const after = readFileSync(abs);
    assert.ok(after.subarray(0, 3).equals(BOM), 'the written file must still start with EF BB BF');
    assert.ok(after.toString('utf8').includes('class NewName {}'), 'token rewritten');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// gradle-migrate (spawned CLI — fully offline, deterministic)
// ---------------------------------------------------------------------------

function runApply(dir: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, ['src/cli/main.ts', 'gradle-migrate', dir, '--apply'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const BUILD_GRADLE = "plugins {\n    id 'fabric-loom' version '1.9-SNAPSHOT'\n}\n";
const PROP_TAIL = 'taire\nminecraft_version=1.21.11\nyarn_mappings=1.21.11+build.4\nloader_version=0.16.9\n';

test('gradle-migrate excludes a non-UTF-8 gradle.properties but migrates valid files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modforge-gm-enc-'));
  try {
    // first line carries a raw 0xE9 byte; the rest are the usual version props
    const gpBytes = Buffer.concat([Buffer.from('# propri', 'utf8'), Buffer.from([0xe9]), Buffer.from(PROP_TAIL, 'utf8')]);
    const buildBytes = Buffer.from(BUILD_GRADLE, 'utf8');
    writeFileSync(join(dir, 'gradle.properties'), gpBytes);
    writeFileSync(join(dir, 'build.gradle'), buildBytes);
    const gpPristine = readFileSync(join(dir, 'gradle.properties'));
    const buildPristine = readFileSync(join(dir, 'build.gradle'));

    const r = runApply(dir);
    assert.equal(r.status, 0, `gradle-migrate must exit 0 (a skipped file is not a failure); stderr:\n${r.stderr}`);

    // the non-UTF-8 file is excluded — its bytes are untouched (today: mojibake'd to EF BF BD)
    assert.ok(
      readFileSync(join(dir, 'gradle.properties')).equals(gpPristine),
      `a non-UTF-8 gradle.properties must be left byte-for-byte unchanged; stderr:\n${r.stderr}`,
    );
    // one stderr line names the file and says it is not valid UTF-8
    const line = r.stderr.split('\n').find((l) => l.includes('gradle.properties') && /UTF-8/i.test(l));
    assert.ok(line, `expected a per-file not-valid-UTF-8 line naming gradle.properties; stderr:\n${r.stderr}`);

    // the valid file still migrates, with a byte-identical backup of the pristine original
    const migrated = readFileSync(join(dir, 'build.gradle'), 'utf8');
    assert.ok(migrated.includes('net.fabricmc.fabric-loom'), 'build.gradle (valid ASCII) must be migrated');
    const backup = join(dir, BACKUP_DIR, 'build.gradle');
    assert.ok(existsSync(backup), 'build.gradle backup must exist');
    assert.ok(readFileSync(backup).equals(buildPristine), 'build.gradle backup must equal the pristine original bytes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gradle-migrate backs up a valid multibyte gradle.properties with raw-byte fidelity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'modforge-gm-enc-'));
  try {
    // valid UTF-8: é is C3 A9 — must round-trip and migrate normally
    const gpBytes = Buffer.concat([Buffer.from('# propri', 'utf8'), Buffer.from([0xc3, 0xa9]), Buffer.from(PROP_TAIL, 'utf8')]);
    writeFileSync(join(dir, 'gradle.properties'), gpBytes);
    writeFileSync(join(dir, 'build.gradle'), Buffer.from(BUILD_GRADLE, 'utf8'));
    const gpPristine = readFileSync(join(dir, 'gradle.properties'));

    const r = runApply(dir);
    assert.equal(r.status, 0, `gradle-migrate must exit 0; stderr:\n${r.stderr}`);

    const backup = join(dir, BACKUP_DIR, 'gradle.properties');
    assert.ok(existsSync(backup), `a migrated gradle.properties must be backed up; stderr:\n${r.stderr}`);
    assert.ok(
      readFileSync(backup).equals(gpPristine),
      'the backup must be a raw byte copy of the pristine original (no decode / re-encode)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
