<img src="https://raw.githubusercontent.com/champmk/modforge/main/assets/banner.svg" alt="ModForge" width="100%">

**The deterministic cross-version migration engine for Minecraft mods.**

[![CI](https://github.com/champmk/modforge/actions/workflows/ci.yml/badge.svg)](https://github.com/champmk/modforge/actions) [![npm](https://img.shields.io/npm/v/modforge)](https://www.npmjs.com/package/modforge) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![node >= 24](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](https://nodejs.org)

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

Requires Node >= 24 (TypeScript runs natively -- no build step).

```bash
npx modforge versions
npx modforge bridge --from 1.21.11 --to 26.1.2 path/to/your-mod/src/main/java
```

The first run downloads the needed mappings and jars from official sources, sha1-verifies
them, and caches under `~/.modforge/cache`. Then you get a report like this (excerpt from a
real run on AppleSkin):

```text
EXACT
  L5:8 import class net/minecraft/entity/player/PlayerEntity
    → net/minecraft/world/entity/player/Player
    reason: Deterministic chain resolved and class exists in 26.1.2-client.
    · yarn: named net/minecraft/entity/player/PlayerEntity → intermediary net/minecraft/class_1657
    · intermediary: net/minecraft/class_1657 → official ddm
    · mojmap: obf ddm → source net/minecraft/world/entity/player/Player
    · target(26.1.2-client): class present

CANDIDATE
  L4:8 import class net/minecraft/client/gui/DrawContext
    →? net/minecraft/client/gui/GuiGraphicsExtractor (score 0.9)
    2 inner classes (RenderingTextCollector, ScissorStack) matched bijectively
    with identical inner names — containment evidence for the outer rename.
    Structural evidence only — a rename cannot be proven; verify before applying.
    reason: Chain resolved to net/minecraft/client/gui/GuiGraphics, but that class
    does not exist in 26.1.2-client — it was removed or renamed after the era
    boundary. The rename layer supplies a grounded candidate — never auto-applied.

UNRESOLVED
  L67:37 member-instance method net/minecraft/server/world/ServerWorld#getPlayers
    reason: yarn has 2 overloads of getPlayers on net/minecraft/server/world/ServerWorld,
    none with 0 parameters (callsite arity) — varargs or mis-counted arity; not guessing.

453 references — EXACT 402 · CANDIDATE 29 · UNRESOLVED 22
note: CANDIDATE items need your judgment; UNRESOLVED items are honest unknowns, not failures.
```

(Excerpt trimmed from a real run; audit-chain lines appear on every finding.)

Add `--json` for a stable machine-readable schema, or `--out report.md` for markdown.

## Commands

| Command | What it does |
|---|---|
| `modforge bridge --from <v> --to <v> [--namespace named\|source] <src-dir> [--json] [--out report.md]` | Era migration report: resolves every Minecraft reference in your source tree to its target-version name, with audit chains. |
| `modforge delta --from <v> --to <v> [--json]` | Exact API surface diff between any two game versions -- the "what breaks in 26.2" report, computable the minute a version ships. |
| `modforge gradle-migrate <dir> [--apply]` | Mechanical build-script migration (loom plugin id, mappings block, dependency forms, Java 25); dry-run by default, EXACT-tier rewrites only with `--apply`. |
| `modforge mixin-check --target <v> <src-dir>` | Verifies `@Mixin` targets and member references against the target version's jar. |
| `modforge versions` | Shows the latest release/snapshot and the era boundary. |

Every command is CI-friendly: deterministic output, exit 0 on success (UNRESOLVED findings
are a successful result), exit 2 on usage errors, exit 1 on operational failures.

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
at `src/mcp/server.ts` over stdio.

## Validated against reality

Correctness is the product, so ModForge is scored against real artifacts and real human
work, not synthetic benchmarks:

- The classfile parser (every constant-pool tag through Java 25, zero dependencies) reads
  all 10,152 classes of the 26.1.2 client jar in ~500ms with zero errors.
- Bulk-bridging the entire 1.21.11 class surface to 26.1.2 resolves 91.5% of classes EXACT
  in 16ms.
- A real-mod run on AppleSkin: 453 references -> 402 EXACT, 29 CANDIDATE, 22 UNRESOLVED --
  and every UNRESOLVED is a genuine same-arity overload where guessing would be wrong.
- The standing validation gate scores ModForge's EXACT set against AppleSkin's actual
  human-written port commit: **100% EXACT precision** -- and the engine surfaced a hotfix
  rename (`GuiGraphics -> GuiGraphicsExtractor` in 26.1.2) that the merged human port had
  missed.
- 30/30 tests passing, strict TypeScript (`tsc`) clean across the repo.

Any EXACT that contradicts what human porters actually did is a release blocker.

## How it works

Two engines share one honesty contract. The **Era Bridge** chains yarn-named or
mojmap-source symbols through yarn tiny-v2 -> intermediary tiny -> ProGuard mojmap, then
verifies each result against the parsed target jar (name + descriptor join), walking the
old jar's class hierarchy for inherited members and translating descriptors to disambiguate
overloads. The **API Delta** engine parses two game jars with ModForge's own
dependency-free classfile parser and diffs the API surface directly; renames ship only as
evidence-labeled bijective candidates. All mappings and jars are fetched client-side from
Mojang's official endpoints at runtime, sha1-verified, and cached -- never redistributed.
Full details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/SPEC.md](docs/SPEC.md).

## Roadmap

- Instruction-level mixin `@At` verification (a signature can match while the targeted
  instruction is gone)
- `--apply` auto-patching for EXACT bridge findings
- NeoForge convenience flow (mojmap-input mods skip the yarn hops)
- Expanded validation corpus across more real ports

## Contributing and license

Contributions welcome -- see [CONTRIBUTING.md](CONTRIBUTING.md). Corpus cases where
ModForge got something wrong are especially valuable: a confidently wrong answer is the
one bug class treated as P0.

Licensed under [MIT](LICENSE).

ModForge is built and maintained by [Champ-Pacifique Mukiza](https://github.com/champmk). I build with AI assistance and review, test, and own every line.
