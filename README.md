<img src="https://raw.githubusercontent.com/champmk/modforge/main/assets/banner.svg" alt="ModForge" width="100%">

**The deterministic cross-version migration engine for Minecraft mods. It computes every rename from the real mappings and jars — and refuses to guess when the data can't prove one.**

[![CI](https://github.com/champmk/modforge/actions/workflows/ci.yml/badge.svg)](https://github.com/champmk/modforge/actions) [![npm](https://img.shields.io/npm/v/modforge)](https://www.npmjs.com/package/modforge) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![node >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)

<img src="https://raw.githubusercontent.com/champmk/modforge/main/assets/demo.gif" alt="ModForge bridging a real Fabric mod (AppleSkin) from 1.21.11 to 26.1.2 — every line is unedited CLI output" width="100%">

*Real output, unedited: a 453-reference Fabric mod bridged and auto-rewritten, with the refusals stated.*

ModForge is built for **Fabric** mods first: point `bridge` at yarn-named source (the
Fabric default) or at a mojmap-source tree (NeoForge / multiloader) — the bridge
autodetects which namespace your code is written in and announces its pick, and an
explicit `--namespace` always wins. (No relation to Minecraft Forge or CurseForge.)

The proof, up front — a real Fabric mod (AppleSkin), bridged 1.21.11 → 26.1.2:

- 453 Minecraft references → **402 resolved EXACT**, every one verified by name and
  descriptor against the actual 26.1.2 jar, plus 29 evidenced CANDIDATEs and 22 refusals
  that each state their precise reason.
- Checked class-by-class against the same mod's actual human-written port commit, the
  EXACT set contradicted the human port **zero times** — and the check surfaced a hotfix
  rename (`GuiGraphics → GuiGraphicsExtractor` in 26.1.2) that the merged human port had
  missed ([how this is scored](#validated-against-reality)).

ModForge computes mod migrations instead of guessing at them: it chains your yarn-era or
mojmap symbols through the real mapping artifacts, verifies every result against the actual
target-version jar, and labels every finding EXACT, CANDIDATE, or UNRESOLVED -- with the
full audit chain that proves it. The timing is not academic: Minecraft 1.21.11 (Dec 2025)
was the last obfuscated version with yarn/mojmap mappings, 26.1 (Mar 2026) shipped real
source names in the jar, and the game now breaks its API on quarterly drops -- so every mod
written before the boundary needs a port, and every quarter brings another one.

## Why this exists

Porting a mod across the 26.1 boundary means translating thousands of symbols through
multiple mapping layers, catching the renames Mojang made along the way, and fixing mixin
targets that fail silently at runtime. The official advice is to keep two workspaces open
and diff by eye. That does not scale to a mod with 450 Minecraft references, and it
definitely does not scale four times a year.

The tempting shortcut is to ask an LLM. But renames are exactly where language models fail
worst: a model will confidently map `GuiGraphics` to whatever looks plausible from its
training data, and a confidently wrong rename costs more than no answer at all -- it
compiles into a subtle runtime bug or sends you debugging a class that never existed.

The fix is deterministic grounding. ModForge never invents a name. Every EXACT result is a
mechanical join through the real yarn, intermediary, and mojmap files, verified by
name-and-descriptor lookup against the actual target jar. When the data cannot prove an
answer, ModForge says so, with the precise reason. The same engine is exposed over MCP, so
AI assistants can ask it for version-truth instead of hallucinating.

## Quickstart

Requires Node >= 24. (Installing from a git clone or a `github:` spec into a project
works too -- a `prepare` script builds `dist/` on install. For a global CLI use
`npm install -g modforge`; npm itself cannot run build scripts on global git installs.)

```bash
npx modforge versions
npx modforge bridge --from 1.21.11 --to 26.1.2 path/to/your-mod/src/main/java
```

The first run downloads the needed mappings and jars from official sources, sha1-verifies
them, and caches under `~/.modforge/cache`. Once the cache is warm, `--offline` (or the
`MODFORGE_OFFLINE` env var) guarantees zero network -- a cache miss then fails with one
line naming the missing artifact. Then you get a report like this (excerpt from a real
run on AppleSkin):

```text
modforge migration report — 1.21.11 → 26.1.2 (namespace named, modforge v0.1.2)
for: path/to/your-mod/src/main/java

summary: EXACT 402 · CANDIDATE 29 · UNRESOLVED 22 · total 453
by kind: class 276/27/2 · method 93/2/20 · field 33/0/0  (EXACT/CANDIDATE/UNRESOLVED)
note: CANDIDATE items need your judgment; UNRESOLVED items are honest unknowns, not failures.

EXACT (402) — every hop deterministic and verified against the target — safe to auto-apply
  squeek/appleskin/api/event/FoodValuesEvent.java
    L5:8 [4dc4531d5b13] import class net/minecraft/entity/player/PlayerEntity
      → net/minecraft/world/entity/player/Player
      reason: Deterministic chain resolved and class exists in 26.1.2-client.
      · yarn: named net/minecraft/entity/player/PlayerEntity → intermediary net/minecraft/class_1657
      · intermediary: net/minecraft/class_1657 → official ddm
      · mojmap: obf ddm → source net/minecraft/world/entity/player/Player
      · target(26.1.2-client): class present

CANDIDATE (29 findings, 2 unique decisions) — grounded evidence with provenance — needs your judgment, never auto-applied
  class net/minecraft/client/gui/DrawContext
    →? net/minecraft/client/gui/GuiGraphicsExtractor (score 0.9)
       2 inner classes (RenderingTextCollector, ScissorStack) matched bijectively with
       identical inner names — containment evidence for the outer rename. Structural
       evidence only — a rename cannot be proven; verify before applying.
    reason: Chain resolved to net/minecraft/client/gui/GuiGraphics, but that class does
    not exist in 26.1.2-client — it was removed or renamed after the era boundary. The
    rename layer supplies a grounded candidate — CANDIDATE, never auto-applied.
    27 sites: squeek/appleskin/api/event/HUDOverlayEvent.java:4:8, … (+17 more)

UNRESOLVED (22) — honest unknowns with reasons — a successful result, not a failure
  squeek/appleskin/network/SyncHandler.java
    L67:37 [ef64e9286290] member-instance method net/minecraft/server/world/ServerWorld#getPlayers
      reason: yarn has 2 overloads of getPlayers on net/minecraft/server/world/ServerWorld,
      none with 0 parameters (callsite arity) — varargs or mis-counted arity; not guessing.

modforge: summary — EXACT 402 · CANDIDATE 29 (2 unique decisions) · UNRESOLVED 22 · total 453
modforge: 2 decisions need your judgment — the evidence is above
modforge: 22 references need a manual port — each lists its precise reason
modforge: 402 renames are deterministic and jar-verified — modforge bridge ... --apply writes them (originals backed up)
modforge: tip: --out report.md for a shareable report
```

(Excerpt from a real run, trimmed: most findings are cut, the CANDIDATE's audit-chain
lines and most of its 27-site list are elided, and a few long lines are re-wrapped to
fit. In a real report every finding carries its full audit chain.)

Add `--json` for a stable machine-readable schema, or `--out report.md` for markdown.

## Commands

| Command | What it does |
|---|---|
| `modforge bridge --from <v> --to <v> [--namespace named\|source] <src-dir> [--json] [--out report.md] [--apply] [--offline]` | Era migration report: resolves every Minecraft reference in your source tree to its target-version name, with audit chains. When `--namespace` is omitted the bridge autodetects yarn (`named`) vs mojmap (`source`) from your code and says which it picked. `--apply` writes the EXACT rewrites to disk (originals backed up under `.modforge/backup/`); CANDIDATE and UNRESOLVED are never touched. |
| `modforge delta --from <v> --to <v> [--json] [--out delta.md] [--offline]` | Exact API surface diff between any two game versions -- the "what breaks in 26.2" report, computable the minute a version ships (`--out` writes the publishable markdown). |
| `modforge gradle-migrate <dir> [--apply]` | Build-script migration (loom plugin id, mappings block, dependency forms, Java 25); dry-run by default, EXACT-tier rewrites only with `--apply`. Project-specific version values (loom, loader, fabric-api) are never auto-written -- they are flagged for manual review with an instruction naming exactly what to set. |
| `modforge mixin-check --target <v> <src-dir> [--offline]` | Verifies `@Mixin` targets and member references against the target version's jar, at signature level: inherited members are found via a deterministic hierarchy walk, and targets outside `net.minecraft`/`com.mojang` (JDK, libraries, your own classes) report as INFO -- "not verifiable", never a false break verdict. |
| `modforge versions [--offline]` | Shows the latest release/snapshot and the era boundary. |

Every command is CI-friendly: deterministic output, exit 0 on success (UNRESOLVED findings
are a successful result), exit 2 on usage errors, exit 1 on operational failures. An
unknown or typo'd flag exits 2 with a did-you-mean instead of being silently ignored.
ANSI color is emitted only when stdout is a TTY; `NO_COLOR` and `--no-color` are honored,
so piped output and CI logs stay clean.

## The honesty taxonomy

Every finding carries exactly one verdict. This is the core of the product.

| Verdict | Meaning |
|---|---|
| **EXACT** | Every join hop is deterministic and the result is verified against the target jar by name and descriptor. Safe to auto-apply. |
| **CANDIDATE** | Structurally evidenced (bijective rename matching, descriptor fingerprints) and shown with its evidence. Never auto-applied. |
| **UNRESOLVED** | An honest unknown with the precise reason. **A refusal is a successful result, not an error.** |

Renames in an unobfuscated world are structurally unprovable, so ModForge never asserts
one -- it shows you the evidence and the ranking. A confidently wrong answer is treated as a
P0 bug. Every resolution carries its full audit chain: every join hop that produced it.

## MCP server

ModForge ships a dependency-free MCP server (stdio, spec 2025-11-25) so AI coding
assistants can query the engine for grounded version-truth instead of guessing renames.
The honesty taxonomy travels on the wire: UNRESOLVED is a successful result, never an
error response.

Five tools:

- `modforge_resolve_symbol` -- resolve a single class or member across versions
- `modforge_bridge_report` -- full bridge report for a source tree
- `modforge_api_delta` -- API surface diff between two versions
- `modforge_check_mixin_target` -- verify a mixin target against a version
- `modforge_versions` -- version metadata and the era boundary

Install into Claude Code:

```bash
npm install -g modforge
claude mcp add modforge -- modforge-mcp
```

(From a repo clone instead: `claude mcp add modforge -- node <abs-path>/src/mcp/server.ts`.)

Any MCP-capable client works the same way -- Cursor, Copilot, or your own agent: point it
at `src/mcp/server.ts` over stdio. Responses are budgeted for agent context windows:
`modforge_api_delta` caps its lists by default and reports `truncated`/`returned` counts
(raise with `maxItemsPerList`), and `modforge_bridge_report` omits per-finding audit
chains unless you pass `includeChains: true`. The server honors `MODFORGE_OFFLINE`.

For wiring the server into an agent's actual porting loop -- which tool to call when, and
how to stay inside a context budget -- see [docs/AGENT-PLAYBOOK.md](docs/AGENT-PLAYBOOK.md).

## Validated against reality

Correctness is the product, so ModForge is scored against real artifacts and real human
work, not synthetic benchmarks:

- The classfile parser (every constant-pool tag through Java 25, zero dependencies) reads
  all 10,152 classes of the 26.1.2 client jar in ~0.6s with zero errors.
- Bulk-bridging the entire 1.21.11 class surface (9,720 classes) to 26.1.2 resolves 91.5%
  of classes EXACT in under 20ms once the indexes are built.
- A real-mod run on AppleSkin: 453 references -> 402 EXACT, 29 CANDIDATE, 22 UNRESOLVED --
  and every UNRESOLVED states its precise reason: 16 are method-overload ambiguities the
  data cannot disambiguate (where guessing would be wrong), 3 are non-Minecraft classes
  (`com.mojang.datafixers`), and 3 are library-inherited methods (Netty's `ByteBuf`) that
  the mappings never named.
- Before a release I score ModForge's EXACT class renames for AppleSkin against the mod's
  actual human-written port commit. (The corpus and answer key are real mod checkouts and
  can't be redistributed, so this gate runs on my machine, not in the shipped test suite.)
  Current result: of the 43 classes the human port renamed, 41 resolve EXACT and **zero
  contradict the human port** -- 100% EXACT precision, 95.3% recall, at class level. The
  same run surfaced a hotfix rename (`GuiGraphics -> GuiGraphicsExtractor` in 26.1.2) that
  the merged human port had missed.
- What you can reproduce directly: `npm test` (170/170 passing) and `npx tsc --noEmit`
  (strict, clean) on a clone -- and any single EXACT in any report, because each one
  carries its full audit chain and is verified against the real target jar.

Any EXACT that contradicts what human porters actually did is a release blocker.

## How it works

Two engines share one honesty contract. The **Era Bridge** chains yarn-named or
mojmap-source symbols through yarn tiny-v2 -> intermediary tiny -> ProGuard mojmap, then
verifies each result against the parsed target jar (name + descriptor join), walking the
old jar's class hierarchy for inherited members and translating descriptors to disambiguate
overloads. The **API Delta** engine parses two game jars with ModForge's own
dependency-free classfile parser and diffs the API surface directly; renames ship only as
evidence-labeled bijective candidates. All mappings and jars are fetched client-side from
the official sources (Mojang's piston-data, Fabric's maven) at runtime, sha1-verified,
and cached -- never redistributed.
Full details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SPEC.md](docs/SPEC.md).

## Roadmap

- Instruction-level mixin `@At` verification (a signature can match while the targeted
  instruction is gone; the parser's Code-attribute scan that powers this already exists,
  the wiring into `mixin-check` does not -- its output says so)
- Fuller NeoForge flow (`bridge` already takes mojmap-source trees, autodetected;
  `gradle-migrate` is still loom/Fabric-only)
- Expanded validation corpus across more real ports (AppleSkin is scored today; Cloth
  Config and Lithium are cloned and queued)

## Contributing and license

Contributions welcome -- see [CONTRIBUTING.md](CONTRIBUTING.md). Corpus cases where
ModForge got something wrong are especially valuable: a confidently wrong answer is the
one bug class treated as P0.

Licensed under [MIT](LICENSE).

ModForge is built and maintained by [Champ-Pacifique Mukiza](https://github.com/champmk). I build with AI assistance and review, test, and own every line.
