/**
 * gradle-migrate --apply must treat ModForge's own backup dirs as off-limits.
 *
 * Confirmed P0 (findings 05 + 18) + P1-7 (finding 46): backups now live under
 * '<root>/.modforge/backup/' — nested in a dot-dir so `gradlew build` never
 * compiles a backed-up file. The cmdGradleMigrate directory walk must exclude
 * '.modforge' (and still exclude the legacy '.modforge-backup'), so a second
 * --apply never re-descends into the backup, migrates the pristine originals in
 * place, nor reports a nonzero "files rewritten" count when zero PROJECT files
 * changed. The applyToDisk containment guard refuses a backup-dir segment at
 * ANY depth, for both the current and the legacy dir name.
 *
 * Old backups are never migrated: when a legacy '.modforge-backup' is present,
 * --apply prints one informational line and leaves it untouched.
 *
 * Expectations are hand-derived from the synthetic fabric project built below;
 * byte equality is checked on raw Buffers (readFileSync without an encoding).
 * gradle-migrate is fully offline, so the spawned CLI runs are deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyToDisk, type PatchOp } from '../src/patch/patch.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));

// A minimal fabric project. build.gradle is rewritten by the loom plugin-id
// rename ('fabric-loom' → 'net.fabricmc.fabric-loom'); gradle.properties is
// rewritten by the yarn_mappings deletion — both EXACT, auto-applied rules
// that leave the file buildable. (Finding 19: project-specific version values
// like minecraft_version/loader_version are NOT auto-written — they are left in
// place for manual review, so they no longer drive these rewrites.) Each
// first-run rewrite creates a backup — exactly the artifact a re-run must not
// corrupt.
const BUILD_GRADLE = "plugins {\n    id 'fabric-loom' version '1.9-SNAPSHOT'\n}\n";
const GRADLE_PROPS = 'minecraft_version=1.21.11\nyarn_mappings=1.21.11+build.4\nloader_version=0.16.9\n';

interface Project {
  dir: string;
  /** Raw bytes of each pristine source, captured before any CLI run. */
  pristine: Map<string, Buffer>;
}

function makeProject(): Project {
  const dir = mkdtempSync(join(tmpdir(), 'modforge-gm-'));
  writeFileSync(join(dir, 'build.gradle'), BUILD_GRADLE, 'utf8');
  writeFileSync(join(dir, 'gradle.properties'), GRADLE_PROPS, 'utf8');
  const pristine = new Map<string, Buffer>([
    ['build.gradle', readFileSync(join(dir, 'build.gradle'))],
    ['gradle.properties', readFileSync(join(dir, 'gradle.properties'))],
  ]);
  return { dir, pristine };
}

function runApply(dir: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(process.execPath, ['src/cli/main.ts', 'gradle-migrate', dir, '--apply'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** Backup path of a project file under the new nested dot-dir layout. */
function backup(dir: string, name: string): string {
  return join(dir, '.modforge', 'backup', name);
}

test('one --apply leaves .modforge/backup byte-identical to the pristine originals', () => {
  const { dir, pristine } = makeProject();
  try {
    runApply(dir);
    for (const name of ['build.gradle', 'gradle.properties']) {
      const path = backup(dir, name);
      assert.ok(existsSync(path), `backup ${name} should exist under .modforge/backup after one --apply`);
      assert.ok(
        readFileSync(path).equals(pristine.get(name)!),
        `backup ${name} must equal the pristine original after one --apply`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two --apply runs keep .modforge/backup pristine and create no nested backup', () => {
  const { dir, pristine } = makeProject();
  try {
    runApply(dir);
    runApply(dir);
    for (const name of ['build.gradle', 'gradle.properties']) {
      assert.ok(
        readFileSync(backup(dir, name)).equals(pristine.get(name)!),
        `backup ${name} must STILL equal the pristine original after a second --apply`,
      );
    }
    // A re-run must not descend into .modforge and back up the backup.
    assert.ok(
      !existsSync(join(dir, '.modforge', 'backup', '.modforge')),
      'a re-run must not nest a backup of the backup under .modforge/backup',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the second --apply truthfully reports 0 files rewritten', () => {
  const { dir } = makeProject();
  try {
    runApply(dir);
    const second = runApply(dir);
    const m = /modforge: (\d+) files rewritten/.exec(second.stderr);
    assert.ok(m, `second run should report a rewrite count; stderr was:\n${second.stderr}`);
    assert.equal(
      Number(m![1]),
      0,
      `second --apply changed no project files, so it must report 0 rewritten (got ${m![1]})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyToDisk refuses a target inside a NESTED .modforge/backup before touching it', () => {
  const root = mkdtempSync(join(tmpdir(), 'modforge-contain-'));
  try {
    const relDir = join('sub', '.modforge', 'backup');
    mkdirSync(join(root, relDir), { recursive: true });
    const target = join(root, relDir, 'X.java');
    const content = 'class X {}';
    writeFileSync(target, content, 'utf8');
    const before = readFileSync(target);

    // 'X' is the single-char token at offset 6 of "class X {}".
    const op: PatchOp = { file: 'sub/.modforge/backup/X.java', start: 6, end: 7, before: 'X', after: 'Y', findingId: 'unit' };

    assert.throws(
      () => applyToDisk([op], { root }),
      /backup directory/,
      'a path with a .modforge segment anywhere must be refused',
    );
    assert.ok(readFileSync(target).equals(before), 'the file must be untouched (refused before any write)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('applyToDisk still refuses a target inside a NESTED legacy .modforge-backup', () => {
  const root = mkdtempSync(join(tmpdir(), 'modforge-contain-'));
  try {
    const relDir = join('sub', '.modforge-backup');
    mkdirSync(join(root, relDir), { recursive: true });
    const target = join(root, relDir, 'X.java');
    const content = 'class X {}';
    writeFileSync(target, content, 'utf8');
    const before = readFileSync(target);

    const op: PatchOp = { file: 'sub/.modforge-backup/X.java', start: 6, end: 7, before: 'X', after: 'Y', findingId: 'unit' };

    assert.throws(
      () => applyToDisk([op], { root }),
      /backup directory/,
      'a path with a legacy .modforge-backup segment anywhere must be refused',
    );
    assert.ok(readFileSync(target).equals(before), 'the file must be untouched (refused before any write)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gradle-migrate does not descend into a .modforge dir (a pre-existing backup is left untouched)', () => {
  const { dir } = makeProject();
  try {
    // A pretend ModForge backup of build.gradle, already migrate-able on its face.
    const innerDir = join(dir, '.modforge', 'backup');
    mkdirSync(innerDir, { recursive: true });
    const inner = join(innerDir, 'build.gradle');
    writeFileSync(inner, BUILD_GRADLE, 'utf8');
    const innerPristine = readFileSync(inner);

    const r = runApply(dir);
    assert.equal(r.status, 0, `gradle-migrate must exit 0; stderr:\n${r.stderr}`);

    // The real project file migrated (sanity), proving the walk ran...
    assert.ok(
      readFileSync(join(dir, 'build.gradle'), 'utf8').includes('net.fabricmc.fabric-loom'),
      'the top-level build.gradle must still be migrated',
    );
    // ...but the file inside .modforge was never read or rewritten.
    assert.ok(
      readFileSync(inner).equals(innerPristine),
      'a build.gradle inside .modforge must be left byte-for-byte unchanged (walk skipped the dir)',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gradle-migrate prints one informational line when a legacy .modforge-backup is present', () => {
  const { dir } = makeProject();
  try {
    // A leftover pre-0.1.2 backup dir. It must NOT be migrated, just acknowledged.
    mkdirSync(join(dir, '.modforge-backup'), { recursive: true });

    const r = runApply(dir);
    assert.equal(r.status, 0, `gradle-migrate must exit 0; stderr:\n${r.stderr}`);
    assert.match(
      r.stderr,
      /legacy backups/i,
      `--apply must note the legacy backup dir once; stderr was:\n${r.stderr}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a read-only file is refused per-file; the batch survives and counts stay truthful', () => {
  const { dir, pristine } = makeProject();
  const buildPath = join(dir, 'build.gradle');
  try {
    chmodSync(buildPath, 0o444);
    // Probe: if this platform/user does not enforce read-only, skip honestly.
    let enforced = true;
    try {
      writeFileSync(buildPath, readFileSync(buildPath));
      enforced = false;
    } catch {
      /* enforced — the attack is reachable */
    }
    if (!enforced) return; // nothing to test on this platform

    const r = runApply(dir);
    assert.equal(r.status, 0, `a refused write is honest output, not an operational failure; stderr:\n${r.stderr}`);
    assert.match(r.stderr, /refused build\.gradle: file could not be written/, 'the refusal names the file and the cause');
    assert.ok(readFileSync(buildPath).equals(pristine.get('build.gradle')!), 'the read-only file is byte-untouched');
    assert.ok(
      !readFileSync(join(dir, 'gradle.properties')).equals(pristine.get('gradle.properties')!),
      'the writable file in the same batch is still migrated',
    );
    assert.match(r.stderr, /1 files rewritten, 1 refused/, 'the summary counts both truthfully');
  } finally {
    try { chmodSync(buildPath, 0o666); } catch { /* best effort for cleanup */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
