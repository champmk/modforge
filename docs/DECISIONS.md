# ModForge - Decision Log

> ADR-style log of the technical decisions that shape ModForge, with the reasoning
> behind each. Append-only. See [SPEC.md](SPEC.md) and [ARCHITECTURE.md](ARCHITECTURE.md)
> for the full picture.

---

## D1: Target the era boundary (1.21.x -> 26.x) plus quarterly 26.x deltas

**Context.** Minecraft went unobfuscated at 26.1 (March 2026): yarn ended at 1.21.11,
intermediary is stubbed, and 26.x ships no client_mappings. Every existing mod is
binary-incompatible with 26.x, and quarterly game drops now break APIs on a schedule.
The older "yarn version bump" problem is closed-ended; this one is the ecosystem's
actual, recurring pain.

**Decision.** Center the product on crossing the obfuscation boundary (Pillar A) and on
exact API deltas between any two versions (Pillar B), rather than legacy mapping bumps.

**Consequences.** The bridge's old-era inputs are frozen historical artifacts and can never
rot; the delta engine handles every future drop with no per-version work.

## D2: The honesty taxonomy - EXACT / CANDIDATE / UNRESOLVED

**Context.** In an unobfuscated world, a rename is structurally indistinguishable from a
remove-plus-add. Pretending certainty about renames would be lying, and a migration tool
that lies once is worthless.

**Decision.** Every finding carries exactly one verdict: `EXACT` (deterministic and
jar-verified; safe to auto-apply), `CANDIDATE` (structurally evidenced, shown with evidence
and provenance, never auto-applied), or `UNRESOLVED` (a precise reason given - a refusal is
a successful result, not an error). Every resolution carries its full audit chain.
A confidently-wrong answer is a P0 bug.

**Consequences.** This is the product's core promise and constrains everything else: no
heuristic ever upgrades itself to EXACT, and the JSON schema, exit codes, and MCP wire
format all encode the taxonomy explicitly.

## D3: The bridge chain - four artifacts, three joins, jar-verified

**Context.** Old-era symbols exist in yarn-named or mojmap-named form; the target truth is
the actual 26.x jar. Every link in between is a real, downloadable artifact: yarn tiny v2
(intermediary -> named), intermediary tiny (official -> intermediary), mojmap ProGuard
(source -> obf), and the target-version jar API.

**Decision.** Resolve symbols by chaining those four artifacts with descriptor-qualified
joins (`(kind, obfOwner, obfName, obfJvmDescriptor)` - obf names collide within a class,
so descriptors are mandatory), then verify the result against the parsed target jar by
name + descriptor. The final hop is never assumed to be identity: a rename layer
(derived structural table plus oracle seeds) covers Mojang's cross-boundary refactors,
and a finding only becomes EXACT through jar verification. Proven end-to-end on
`PlayerEntity#getHungerManager` -> `Player#getFoodData` in 26.1.2.

**Consequences.** Fully deterministic name resolution with no LLM in the loop; inherited
members need an old-jar hierarchy walk and overloads need descriptor translation, both of
which the chain supports.

## D4: Own dependency-free classfile parser in TypeScript

**Context.** Extracting an API surface from a game jar normally means requiring a JDK and
shelling out to javap, or pulling in a bytecode library. The classfile metadata format is
stable and documented.

**Decision.** Parse classfile metadata (constant pool, class/method/field tables,
descriptors, signatures, plus an opt-in Code-attribute scan as groundwork for the planned
instruction-level mixin checks) directly in TypeScript - majors 45 through 69, all
constant-pool tags through Java 25. Unknown tags fail loudly rather than desync.

**Consequences.** Zero toolchain dependency for users, works on any classfile version, and
the parser is version-stable (zero format changes Java 17 -> 25); a future format bump is a
one-line table addition guided by the error message.

## D5: TypeScript run natively by Node >= 24, zero runtime dependencies

**Context.** Node 24+ runs TypeScript natively via type stripping, and every parser
ModForge needs (tiny v2, ProGuard, zip, classfile) is feasible in pure TS. The MCP server
and a future VS Code extension are TS-native anyway.

**Decision.** Ship TypeScript source executed directly by Node >= 24 (ESM, `.ts` extensions
in imports), with `tsc --noEmit` for typechecking only and `node:test` for tests. Zero
runtime dependencies in the core engine.

**Consequences.** No build step for development or tests, a clean contributor story, and
nothing in `node_modules` to audit or break.

## D6: Never redistribute Mojang mappings

**Context.** The Mojang mappings license states you may not redistribute the mappings
complete and unmodified - verified in the 1.21.11 file itself.

**Decision.** ModForge never bundles or redistributes mappings. All artifacts are fetched
client-side at runtime from official sources (piston-data, maven.fabricmc.net),
sha1-verified against the version JSONs, and cached in `~/.modforge/cache`. Derived rename
tables are likewise computed locally per version pair rather than shipped precomputed.

**Consequences.** Local-first by construction (which is also the right architecture: no
hosted components, no telemetry), and legally clean at any scale.

## D7: Rename candidates are bijective and evidence-labeled, never guessed

**Context.** Without obfuscation mappings, a rename across versions cannot be proven from
structure alone; any matcher will produce plausible-looking false positives.

**Decision.** Rename detection uses structural fingerprints (descriptor-shape member sets
canonicalized through the candidate mapping), Jaccard scoring, package locality, a
common-shape penalty, and a mutual-best-match (bijective) constraint in both directions.
Results ship as CANDIDATE with score, evidence, and provenance - never as EXACT, and never
auto-applied.

**Consequences.** The 100% EXACT-precision corpus gate (maintainer-run; see
[MAINTENANCE.md](MAINTENANCE.md)) stays intact, and oracle sources (the NeoForge primer,
the Fabric API migration map) can seed candidates through the engine's oracle-seed API
without ever being trusted as ground truth - though no oracle data ships yet.

## D8: Live version resolution, no hardcoded pins

**Context.** The Minecraft toolchain churned four-plus times in six months; hardcoded
version lists rot in weeks.

**Decision.** Resolve all version information live from the meta APIs (piston-meta,
meta.fabricmc.net) at run time, with a short-TTL cache.

**Consequences.** New game versions appear in ModForge automatically the day they ship -
see [MAINTENANCE.md](MAINTENANCE.md).
