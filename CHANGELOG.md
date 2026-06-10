# Changelog

All notable changes to ModForge are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `modforge bridge --apply`: writes EXACT rewrites to disk — span-verified,
  all-or-nothing per file, originals backed up under `.modforge-backup/`,
  iterates to a fixpoint (a rewrite held back by a name collision applies once
  the colliding name is renamed away), and is idempotent. CANDIDATE and
  UNRESOLVED findings are never touched.
- `modforge delta --out <file>`: generates the publishable "what breaks in
  <version>" markdown report directly from the CLI (previously repo-only).
- Reversed `--from`/`--to` on `bridge` now suggests the corrected command.

### Fixed

- `bridge --apply` refuses a file whole when rewriting an import would leave
  any occurrence of the old class name behind (static-access receivers, casts,
  and return types are known scanner blind spots) — the refusal names the
  dangling lines. Previously such files were written non-compiling while the
  run reported success.
- Member accesses through lambda parameters and `var` locals are never
  attributed to an identically-named typed declaration elsewhere in the file;
  they now report an unresolved receiver and are never auto-rewritten.
- `mixin-check` no longer issues false "break on this version" verdicts:
  owners outside `net.minecraft`/`com.mojang` (JDK, libraries, the mod's own
  classes) report as "not verifiable" INFO instead of ABSENT, and members
  inherited from supertypes are found via a deterministic hierarchy walk over
  the target jar. On a real 632-file corpus this turned 72 ABSENT verdicts
  (majority provably false) into 4, all plausibly genuine.
- Re-running `gradle-migrate --apply` no longer walks into `.modforge-backup/`
  (backups stay pristine originals; re-run counts are truthful), and the
  patcher refuses to write to any path inside a backup directory at any depth.
- Files that are not valid UTF-8 are refused per-file with the offset of the
  first invalid byte instead of being silently rewritten with U+FFFD
  replacement characters; `gradle-migrate` backups are raw byte copies.
- `gradle-migrate --apply` now backs originals up under `.modforge-backup/`
  before writing — the same safety contract as `bridge --apply` (previously it
  wrote build files with no backup).

### Changed

- Reports use paths relative to the scanned directory (no machine paths in
  shareable reports; finding ids stable across machines), deduplicate audit
  chains per unique symbol, and omit the applied-fix column when nothing was
  applied.
- `modforge delta` prints a readable summary by default (`--json` unchanged).
- MCP: `modforge_resolve_symbol` now points agents at `modforge_bridge_report`
  for batch resolution (up to 200 symbols per call).

## [0.1.1] - 2026-06-10

### Fixed

- The npm package now ships compiled JavaScript (`dist/`). Node refuses to
  type-strip `.ts` files under `node_modules`, so 0.1.0's published bin could
  not run at all when installed from the registry. Running from a repo clone
  was unaffected.

### Added

- `modforge-mcp` bin: installed users can register the MCP server with
  `claude mcp add modforge -- modforge-mcp` instead of pointing at a source path.

## [0.1.0] - 2026-06-10

Initial release.

### Added

- **Era Bridge** (`modforge bridge`): deterministic symbol resolution across
  the obfuscation boundary -- chains yarn tiny-v2 -> intermediary ->
  ProGuard mojmap and verifies every result against the actual
  target-version jar by name + descriptor. Handles inherited members via
  old-jar hierarchy walk and overloads via descriptor translation and
  callsite arity. Supports `--namespace named|source` for yarn-named or
  mojmap-source projects.
- **API Delta** (`modforge delta`): diffs the API surface of two game jars.
  Renames are structurally unprovable, so they ship as evidence-labeled
  bijective candidates, never guesses.
- **Classfile parser**: dependency-free JVM classfile parser covering all
  constant-pool tags through Java 25. Parses the full 26.1.2 jar
  (10,152 classes) in about 500 ms with 0 errors.
- **Honesty taxonomy**: every resolution is EXACT (deterministic,
  jar-verified, safe to auto-apply), CANDIDATE (structurally evidenced,
  shown with evidence, never auto-applied), or UNRESOLVED (precise reason
  given). Every resolution carries a full audit chain.
- **Source scanners**: Java/mixin reference scanners that feed the bridge,
  plus `modforge mixin-check` for validating mixin targets against a
  target version.
- **CLI**: `bridge`, `delta`, `gradle-migrate`, `mixin-check`, and
  `versions` commands with `--json` and Markdown report output (`--out`).
- **MCP server** (stdio, spec 2025-11-25, dependency-free): tools
  `modforge_resolve_symbol`, `modforge_bridge_report`,
  `modforge_api_delta`, `modforge_check_mixin_target`,
  `modforge_versions`.
- **Report renderers**: human-readable Markdown and machine-readable JSON
  reports with per-finding audit chains.
- **Patcher** (`modforge gradle-migrate`, `--apply` flags): applies only
  EXACT findings; CANDIDATE and UNRESOLVED are surfaced for human review.
- **Mapping fetcher**: mappings are fetched client-side at runtime from
  Mojang piston-data, sha1-verified, and cached in `~/.modforge/cache`;
  never redistributed.

[0.1.1]: https://github.com/champmk/modforge/releases/tag/v0.1.1
[0.1.0]: https://github.com/champmk/modforge/releases/tag/v0.1.0
