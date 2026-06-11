# MCP agent playbook

How to wire ModForge's MCP server into Claude Code (or any MCP client) and drive it
through a port. ModForge answers "what is this class/method/field called in version X"
from real mappings and real jars, and labels every answer EXACT, CANDIDATE, or
UNRESOLVED. Your job as the agent is to let those labels decide what you do next.

## Setup

```bash
npm install -g modforge
claude mcp add modforge -- modforge-mcp
```

From a repo clone instead: `claude mcp add modforge -- node <abs-path>/src/mcp/server.ts`.
Any MCP-capable client works the same over stdio. The server is dependency-free and
exposes five tools, each carrying the taxonomy in `structuredContent`.

## The porting loop

1. **`modforge_versions`** (no args) — pick valid `fromVersion`/`toVersion` and confirm
   the era boundary. Old era is `<= 1.21.11` (obfuscated; yarn/mojmap exist); new era is
   `26.1+` (jar names are the real names).
2. **`modforge_bridge_report`** — the workhorse. Resolve the file's symbols in batches.
   `fromVersion` (old-era), `toVersion`, `namespace`, and `symbols` (array of
   `{kind, owner, name?, desc?}`, **max 200 per call**). One shared bridge init per call.
   Returns per-symbol `resolutions` (taxonomy + `reason` + candidate evidence) and
   `summary` `{total, exact, candidate, unresolved}`.
3. **`modforge_resolve_symbol`** — for the handful that need the full audit trail. Same
   inputs as one batch entry plus `fromVersion`/`toVersion`/`namespace`; returns one
   `resolution` with the complete per-hop `chain`. Use it to justify a CANDIDATE to a
   human or to debug an UNRESOLVED — not for bulk work.
4. **`modforge_check_mixin_target`** — ground each `@Mixin` before you trust it.
   `targetVersion`, `mixinTargetClass` (in the target namespace — bridge old names first),
   optional `memberInfo` (Mixin MemberInfo grammar: `getDayTime()J`, `tick`, `render*`).
   Signature-level only; an `@At` INVOKE/FIELD target still needs instruction-level review.
5. **`modforge_api_delta`** — for `26.x -> 26.x` questions where no mappings exist (the
   bridge can't cross there). `fromVersion`, `toVersion`, optional `filterPrefix`
   (e.g. `net/minecraft/world`) and `maxItemsPerList`. Added/removed/descChanged lists are
   EXACT surface facts; `classRenameCandidates`/`memberRenameCandidates` are CANDIDATE only.

`namespace`: `named` = yarn names (Fabric mods); `source` = mojmap names (NeoForge mods).

## Context budget

The server caps output by default so a single call can't flood your context. Totals are
always authoritative even when lists are capped.

- **`modforge_bridge_report`** drops every audit `chain` by default — `summary`, `reason`,
  and candidate evidence stay. Pass `includeChains: true` only when you actually need the
  hops (default `false`). Batches can be 200 but ~50 symbols per call keeps responses small;
  chunk a large file.
- **`modforge_api_delta`** caps each list at **25** entries (`listCap`); each list reports
  `total`/`returned`/`truncated`. When a list truncates, narrow with `filterPrefix` first,
  then raise `maxItemsPerList` only if you still need a bigger sample.
- **`modforge_resolve_symbol`** always returns the full chain for one symbol — keep it to
  the symbols that warrant it.

## Cold start

The first call touching a version (or version pair) downloads official Mojang artifacts —
mappings and jars — sha1-verifies them, and caches under `~/.modforge/cache`. Expect
**~10-30 s** on that first call; every call after is served from cache. Nothing is
redistributed. A `Fetch failed:` result means a network or integrity failure with the exact
URL/status — nothing was guessed, safe to retry. `[UNKNOWN_VERSION]` means call
`modforge_versions` for valid ids. `Invalid arguments:` (with `isError: true`) means fix the
call and retry; the message names the field.

## The decision rule

The taxonomy is not advisory — it is the rule for what you may do with an answer.

- **EXACT** — every hop deterministic and verified against the real target jar. Act on it.
- **CANDIDATE** — grounded evidence with a score and provenance, but a rename can't be
  proven. Never auto-apply. Surface it to the human with its evidence and let them confirm.
- **UNRESOLVED** — honestly unknown. This is a **successful result, not an error**. Report
  it as-is. Do not invent a name; a confidently wrong rename costs more than no answer.

ModForge never guesses, and neither should you on top of it. If the engine refused, the
refusal is the answer.
