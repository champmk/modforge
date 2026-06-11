# ModForge - Maintenance

> What it takes to keep ModForge current. Short answer: almost nothing, by design.
> Companion to [SPEC.md](SPEC.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

## When a new Minecraft version ships (quarterly + hotfixes)

**Cost: ~zero.** There is nothing to re-index by hand:

- The version manifest is fetched live (1h TTL); new versions appear in
  `modforge versions` automatically.
- Jars are fetched and parsed on demand per user, sha1-verified against the version JSON,
  and cached in `~/.modforge/cache`.
- The delta engine works on any version pair immediately -
  `modforge delta --from <old> --to <new>` is the whole "update" for a new drop.
- The classfile parser is version-stable (verified: zero format changes Java 17 -> 25;
  unknown constant-pool tags fail loudly rather than desync - if a future Java bumps the
  format, the error message names the tag and the fix is a one-line table addition).

## When Fabric/NeoForge tooling moves

Nothing in the engine pins toolchain versions; everything is resolved live from the meta
APIs. The gradle migrator's rewrite rules are data (`GRADLE_RULES` in
`src/scan/gradle.ts`) - extending them is a table entry plus a test.

## The old era never changes again

1.21.11 and earlier are frozen forever (yarn ended, mojmap published). The Era Bridge's
inputs are immutable historical artifacts - that whole half of the product is done and
cannot rot.

## Version-support policy

- **Era Bridge** (`modforge bridge`): any obfuscated-era version with published yarn and
  mojmap artifacts (through 1.21.11) as the source, any unobfuscated 26.x version as the
  target. Source symbols may be yarn-named (`--namespace named`) or mojmap-source
  (`--namespace source`); when the flag is omitted the bridge probes both lookup tables,
  announces its pick, and names the override.
- **API Delta** (`modforge delta`): any pair of versions whose jars are published in
  Mojang's piston-data, including snapshots and pre-releases.
- **Runtime**: Node >= 24 (native TypeScript execution). No other runtime requirements.
- **Offline**: `--offline` (or the `MODFORGE_OFFLINE` env var, which the MCP server honors
  too) serves only verified cache entries; a warm cache needs zero network.
- **MCP**: the server targets the 2025-11-25 stdio spec revision.

## Quality gates (run before any release)

Reproducible from any clone:

```
npm test                          # the full suite, must be green
npx -p typescript tsc --noEmit    # strict typecheck, must be clean
```

In addition, the corpus validation gate must hold. This gate is run by the maintainer,
not by the shipped test suite: the corpus is pinned-commit checkouts of real mods and
their human-written port commits, which cannot be redistributed, so the scorer and answer
keys stay out of the repo. ModForge's EXACT findings are scored against what the human
port actually did, and EXACT precision must be 100%. Scored today: AppleSkin, at class
level (43 renamed classes in the key; currently 41 EXACT, zero contradictions, 95.3%
recall). Cloth Config and Lithium are cloned and queued. Any EXACT the human port
contradicts is a P0.

## Watchlist (minutes per quarter)

- MCP spec: check for protocol revisions beyond 2025-11-25.
- Node: type-stripping semantics are stable in 24+; revisit only if the `engines` field
  ever needs to move.
