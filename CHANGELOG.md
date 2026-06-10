# Changelog

All notable changes to ModForge are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/champmk/modforge/releases/tag/v0.1.0
