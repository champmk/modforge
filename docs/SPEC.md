# ModForge - Product Specification

> Status: v1.0 (2026-06-09). Companion documents: [ARCHITECTURE.md](ARCHITECTURE.md),
> [DECISIONS.md](DECISIONS.md), [MAINTENANCE.md](MAINTENANCE.md). Project overview:
> [README](../README.md).

---

## 1. One sentence

**ModForge is a deterministic, CI-runnable migration engine for Minecraft mods -
it bridges yarn-era code through mojmap to the verified 26.x jar API surface, computes
exact API deltas between any two game versions, and labels every single finding
`EXACT`, `CANDIDATE`, or `UNRESOLVED` instead of guessing.**

## 2. The moment (why now)

- Mojang **removed obfuscation** (announced 2025-10-29; first unobf-only build 26.1 Snapshot 1,
  2025-12-16; release 26.1 on 2026-03-24). `1.21.11` (2025-12-09) is the last obfuscated version,
  the last with yarn mappings, and the last with published mojmap files.
- Consequence: **every mod in existence is binary-incompatible with 26.x** ("No existing mods for
  1.21.11 or before will work on 26.1, even as a compile-only dependency" - Fabric's own docs).
  Roughly half the ecosystem ported in the first 11 weeks; the other half hasn't.
- The existing tooling: Loom `migrateMappings` (semi-automated, no Kotlin, no mixins),
  the Ravel IntelliJ plugin (interactive), NeoForge's advice ("no automated migration
  scripts provided" - diff two workspaces by eye). Fabric's docs literally say
  *"Neither option is perfect... especially if migrating Mixins."*
- Ongoing: Minecraft now ships **quarterly game drops** (26.2 lands ~2026-06-16, 26.3 in Q3).
  Every drop breaks APIs (26.1.2 -> 26.2-pre-5 already shows +439/-248 classes, a whole package
  move, a renderer overhaul). Migration pain is now a *recurring* problem, four times a year.

## 3. Users and jobs

| User | Job ModForge does |
|---|---|
| Fabric mod author on 1.21.x | "Port my mod to 26.x: tell me exactly what every symbol becomes, what's gone, and what to verify." |
| NeoForge mod author on 1.21.x | Same job minus the yarn hops (already on mojmap names - the API delta plus the rename layer). |
| Any mod author at a game drop (26.x -> 26.y) | "What does 26.2 break in my mod, the day it ships?" |
| Agentic coding assistants (Claude Code, Cursor, Copilot) | Grounded version-truth via MCP: the agent asks ModForge for the deterministic answer instead of hallucinating renames. |
| Modpack/library maintainers | Exact API-surface diffs between any two versions. |

## 4. Product pillars

### Pillar A - The Era Bridge (1.21.x -> 26.x)

Deterministic symbol translation grounded in four artifacts:

```
yarn named <-> [yarn tiny v2] <-> intermediary <-> [intermediary tiny] <-> official(obf)
           <-> [mojmap ProGuard, inverted] <-> mojmap-named
           -> [RENAME LAYER]
           -> verified against the actual 26.x jar API (name + descriptor join)
```

- Join key for members: `(kind, obfOwner, obfName, obfJvmDescriptor)` - obf names collide
  within a class (verified), so descriptors are mandatory.
- Inherited members are handled via a deterministic hierarchy walk over the old jar;
  overloads are disambiguated via descriptor translation and callsite arity.
- **The final hop is NOT identity.** Mojang refactors across the boundary are real:
  `ResourceLocation -> Identifier`, `EndDragonFight -> EnderDragonFight`,
  `getDayTime() -> getOverworldClockTime()`, ChunkPos ctors -> static factories, etc.
  Measured: 91.5% of 1.21.11 classes carry over by identical name; the **rename layer**
  recovers the rest:
  - **Derived rename table** (authoritative): diff the mojmap-named 1.21.11 surface against
    the parsed 26.1.2 jar with structural matching - bijective constraint, descriptor-shape
    fingerprints, package-locality scoring.
  - **Oracle seeds** (CANDIDATE provenance only, never auto-EXACT): the NeoForge 26.1 primer
    (CC-BY-4.0) and the Fabric API migration-map XML. Oracles are *provably incomplete*
    (they miss `ResourceLocation -> Identifier`) - a finding only becomes EXACT through
    jar verification.
- Zero-skew calibration: the `1.21.11_unobfuscated` dual build (same game, both namespaces)
  validates the entire obf -> official stage with no version noise.

### Pillar B - The API Delta engine (any version -> any version)

Parse both game jars' classfile metadata directly (own dependency-free parser, classfile
majors 45-69 verified one-path-stable, all constant-pool tags through Java 25) -> exact
surface diff: classes/methods/fields added/removed/desc-changed, plus **labeled** rename
candidates (bijective matching only; renames are structurally unprovable in an
unobfuscated world and are never asserted).

### The Mixin Verifier (both pillars' sharpest edge)

Mixins break at six rename-sensitive surfaces (config class lists, `@Mixin` targets,
injector method strings, `@At` member-info strings, `@Shadow`/`@Accessor`/`@Invoker`
implied members, descriptor strings). ModForge parses all six from mod source/config and
verifies each target against the bridged/delta'd surface. **EXACT for `@At` INVOKE/FIELD
targets requires instruction-level verification** (the referenced instruction must exist in
the resolved target method's bytecode - signature-level checks pass while the instruction
is gone; verified real case: `Level.random` field -> `getRandom()` method). MixinExtras
is first-class.

### The Build-Script Migrator (pure EXACT tier)

The gradle migration is 100% mechanical (verified against Fabric's porting docs):
plugin id `fabric-loom` -> `net.fabricmc.fabric-loom`, delete the `mappings` block,
`modImplementation` -> `implementation` (etc.), `remapJar` -> `jar`, AW/CT header
`named` -> `official`, Java 21 -> 25, drop refmap keys, mixin `compatibilityLevel` JAVA_25.

### The Grounded Explainer (optional layer, BYO-key)

Plain-English explanation of findings plus migration of *semantic* breaks (villager trades
-> datapacks, registries -> MapCodec) that symbol joins cannot express. The LLM receives
the deterministic findings as ground truth and is **never** the source of a rename. Off by
default; the deterministic report is complete without it.

## 5. The honesty taxonomy (the product's core promise)

Every finding carries exactly one of:

| Verdict | Meaning | Wire/exit-code semantics |
|---|---|---|
| `EXACT` | Every hop deterministic AND verified against the target jar (for mixin instruction targets: verified at instruction level). Safe to auto-apply. | success |
| `CANDIDATE` | Grounded structural/oracle evidence, ranked, with provenance. Presented for human/agent confirmation; never auto-applied. | success |
| `UNRESOLVED` | Stated plainly with a reason code. **A successful result, not an error.** | success |

A confidently-wrong answer is a P0 bug. Ambiguity is reported as ambiguity.
Every resolution carries its full audit chain (every join hop that produced it).

## 6. Product surfaces

1. **CLI** (`modforge`) - first surface; CI-runnable.
   - `modforge bridge --from 1.21.11 --to 26.1.2 [--namespace named|source] <src-dir> [--json] [--out report.md]` - era migration report
   - `modforge delta --from <v> --to <v> [--json]` - exact API delta between any two versions
   - `modforge mixin-check --target <v> <src-dir>` - mixin target verification
   - `modforge gradle-migrate <dir> [--apply]` - build-script migration
   - `modforge versions` - list known game versions
   - Output: human report (terminal/markdown) plus `--json` (stable schema with the taxonomy enum).
2. **MCP server** - stdio transport, MCP spec revision 2025-11-25, dependency-free. Tools:
   `modforge_resolve_symbol`, `modforge_bridge_report`, `modforge_api_delta`,
   `modforge_check_mixin_target`, `modforge_versions` - all returning structured content
   with the taxonomy enum on the wire. UNRESOLVED is a successful result, never an error.
   Install into Claude Code:
   `claude mcp add modforge -- node <abs-path>/src/mcp/server.ts`
3. **VS Code extension** - staged later; thin client over the same engine.

## 7. Sustainability and legal (locked constraints)

- **Zero runtime dependencies** in the core engine; TypeScript run natively by Node >= 24.
- **Local-first**: all artifacts (mappings, jars) are fetched client-side from official sources
  (piston-meta/piston-data, maven.fabricmc.net), sha1-pinned via the version JSONs, and cached
  in `~/.modforge/cache`. **ModForge never redistributes Mojang mappings** (the mappings
  license forbids it). Derived rename tables are computed locally on the user's machine for
  the same reason - no precomputed bridge database ships with the tool.
- Test-corpus code is never vendored beyond Unlicense/MIT/Apache licenses; everything else
  is fetched at test time; PolyForm/CC-NC code is never redistributed.
- All version pins are resolved live from the meta APIs at run time (the toolchain churned
  4+ times in 6 months; hardcoded versions rot in weeks).
- No hosted components, no telemetry, no accounts.

## 8. Validation (correctness is the product)

1. **Unit**: independently-derived test vectors for every parser and join (synthetic fixtures
   in the real formats; never Mojang-copyrighted content in the repo). 30/30 tests green;
   strict `tsc` clean.
2. **Calibration**: the `1.21.11_unobfuscated` zero-skew diff (obf jar + mojmap applied vs
   the unobf twin - any mismatch is an engine bug by construction).
3. **Real-corpus** (pinned commits, license-tiered): scored against real human-written port
   commits (AppleSkin, Cloth Config, Lithium, fabric-carpet). The standing rule: ModForge's
   EXACT set must be a subset of what the human port actually did - 100% EXACT precision,
   with recall reported honestly.
4. **Differential**: parsers cross-checked against FabricMC mapping-io outputs on pinned
   artifacts, fetched at test time.

### Measured results (real, reproducible)

- Full 26.1.2 jar: 10,152 classes parsed in ~500ms, 0 errors.
- Bulk bridge 1.21.11 -> 26.1.2: 91.5% of classes EXACT in 16ms.
- Real-mod run (AppleSkin): 453 references -> 402 EXACT / 29 CANDIDATE / 22 UNRESOLVED
  (every UNRESOLVED a genuine same-arity overload).
- Validation gate: scored against AppleSkin's real human-written port commit,
  100% EXACT precision - and it surfaced a hotfix rename
  (`GuiGraphics -> GuiGraphicsExtractor` in 26.1.2) that the human port missed.

## 9. Non-goals (v1)

- No decompilation or AI-generated *semantic* rewrites of method bodies (the explainer
  explains; it does not invent code).
- No SRG-era (legacy Forge) bridge - designed (`mcp_config joined.tsrg` joined with mojmap)
  but deferred.
- No hosted service, no telemetry, no accounts.
- No Kotlin source scanning in v1 (noted as a fast-follow; the bridge itself is
  language-agnostic at the symbol level).
