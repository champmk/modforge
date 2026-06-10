# ModForge - Architecture

> v1.0 (2026-06-09). Companion to [SPEC.md](SPEC.md).

## 1. System overview

```
                    +---------------------------------------------+
                    |                 SURFACES                    |
                    |   CLI (modforge)      MCP server (stdio)    |
                    +---------------+-----------------------------+
                                    | stable JSON report model
                    +---------------+-----------------------------+
                    |               ENGINE CORE                   |
                    |                                             |
 src/scan --------> |  usage index (java refs, mixin surfaces,    |
 (mod source/config)|  gradle build model)                        |
                    |        |                                    |
                    |        v                                    |
                    |  +----------+   +----------+  +----------+  |
                    |  | Pillar A |   | Rename   |  | Pillar B |  |
                    |  | EraBridge|-->| Layer    |<-| ApiDelta |  |
                    |  +----------+   +----------+  +----------+  |
                    |        |              |            |        |
                    |        +--------------+------------+        |
                    |                       v                     |
                    |        Resolutions (EXACT/CANDIDATE/        |
                    |        UNRESOLVED + audit chains)           |
                    +---------------+-----------------------------+
                                    |
                    +---------------+-----------------------------+
                    |              DATA LAYER                     |
                    |  fetch.ts: piston-meta / piston-data /      |
                    |  maven.fabricmc.net / meta.fabricmc.net     |
                    |  -> sha1-verified -> ~/.modforge/cache      |
                    |  parsers: zip / classfile / tiny / proguard |
                    +---------------------------------------------+
```

## 2. Module map

| Module | Responsibility |
|---|---|
| `src/core/model.ts` | Canonical types: JarApi/ClassApi/MemberApi, MappingSet, Resolution + the honesty taxonomy |
| `src/jar/zip.ts` | Dependency-free ZIP reader (explicit ZIP64/unknown-method errors) |
| `src/jar/classfile.ts` | Classfile metadata parser, majors 45-69, all constant-pool tags through Java 25; Code-attribute INVOKE/FIELD scan for mixin instruction verification |
| `src/jar/api.ts` | Jar -> JarApi extraction (10,152 classes / ~500ms / 0 errors on 26.1.2) |
| `src/mappings/tiny.ts` | Tiny v2 parser (verified against yarn + intermediary 1.21.11) |
| `src/mappings/proguard.ts` | Mojmap parser with dual-namespace descriptor computation (member types are written in NAMED form in ProGuard - handled via the class bimap) |
| `src/mappings/fetch.ts` | Version manifests, mappings/jar download, sha1 verification, `~/.modforge/cache`; experimental-versions manifest for the `_unobfuscated` builds; live toolchain-version resolution |
| `src/bridge/bridge.ts` | Era Bridge with audit chains, old-jar hierarchy walk for inherited members, named-descriptor translation for overloads |
| `src/bridge/renames.ts` | The boundary rename layer: derived table (surface diff with bijective structural matching) plus oracle seeds (NeoForge primer, Fabric API migration map), each with provenance |
| `src/delta/delta.ts` | API delta engine with bijective, evidence-labeled rename candidates |
| `src/scan/java.ts` | Java source scanner: imports, FQNs, extends/implements, annotation class refs, member refs with declared-type context (no type inference in v1 - confidence-labeled) |
| `src/scan/mixin.ts` | The six mixin surfaces from source plus mixin config JSON; MixinExtras annotations |
| `src/scan/gradle.ts` | Gradle build model: loom plugin id, mappings block, dep configs, AW/CT headers; rewrite rules are data (`GRADLE_RULES`) |
| `src/report/report.ts` | Report model and renderers (terminal, markdown, stable JSON schema) |
| `src/cli/main.ts` | `bridge` / `delta` / `mixin-check` / `gradle-migrate` / `versions` commands |
| `src/mcp/server.ts` | MCP stdio server (spec 2025-11-25), dependency-free; structured content with the taxonomy enum |

## 3. Key algorithms

### 3.1 Era Bridge resolution (per symbol)

1. Hop yarn-named -> intermediary -> official(obf) via the tiny files (member identity:
   `(kind, obfOwner, obfName, obfDesc)`).
2. Hop obf -> mojmap-named via the inverted ProGuard map; compute `descSource` and `descObf`
   (member types are written in NAMED form in ProGuard - converted via the class bimap; verified).
3. Ground against the target jar: exact `(name, translatedDesc)` on the translated owner
   -> **EXACT**; found on a supertype via a deterministic hierarchy walk -> **CANDIDATE(moved)**;
   else consult the **rename layer**:
   - derived-table hit (bijective structural match) -> **CANDIDATE(renamed, score, evidence)**
   - oracle hit (primer / fabric-api map) -> **CANDIDATE(oracle, provenance)**
   - nothing -> **UNRESOLVED(reason)**.
4. Every hop is appended to the audit chain.

### 3.2 Derived rename table (boundary)

1. Take the 1.21.11 surface, expressed in the mojmap-named namespace (mappings applied -
   no jar remapping needed: the surface is just names+descs from the mojmap join).
2. Take the 26.1.2 JarApi surface.
3. Classes present in both by identity -> anchor set. For the removed/added residue:
   structural fingerprints (member-signature sets with all class-types canonicalized
   through the candidate mapping - fixpoint iteration), Jaccard scoring, package locality,
   a **mutual-best-match (bijective) constraint**, and a common-shape penalty.
4. Members within surviving/matched classes: the same algorithm at member level
   (descriptor-shape fingerprints; never name-only).
5. Output: a versioned rename table with per-entry evidence, score, and provenance -
   stored in the cache and recomputed locally per version pair, never shipped precomputed
   (see SPEC.md, section 7).

### 3.3 Mixin verification

1. Parse the mixin config JSONs (package + class lists, `compatibilityLevel`, refmap key).
2. For each mixin class: extract the six rename-sensitive surfaces (from source via
   `scan/java.ts` plus regex-free annotation parsing on the AST-lite model).
3. Resolve the target class through bridge/delta; resolve `method=` / `@At target=`
   member-info strings (parse name+desc forms incl. `FIELD owner:LType;`).
4. For INVOKE/FIELD `@At` targets: disassemble the resolved target method's Code attribute
   in the target jar and verify the referenced instruction exists -> only then EXACT.
5. Descriptor strings are rewritten recursively over type tokens via the bridge's class map.

### 3.4 Delta rename candidates

Bijective constraint in both directions, plus a descriptor-frequency penalty (a `()V` match
means nothing; a 5-arg exotic-type match means a lot), plus a name-similarity tiebreak -
all labeled CANDIDATE with evidence, never asserted as EXACT.

## 4. Performance envelope (measured)

- Full 26.1.2 jar parse: **~500ms** (10,152 classes, 0 errors). Delta 26.1.2 -> 26.2-pre-5: **273ms**.
- Bulk class bridge (9,720 classes): **16ms** after index build (~3s parse of all mappings).
- Conclusion: whole-project migration reports run interactively (<10s cold, <1s warm cache);
  no precomputation or serving infrastructure is needed.

## 5. Error philosophy

Binary parsers fail loudly and precisely (offset + reason) - a desynced parse must never
produce silently-wrong data. Network fetches are sha1-verified against the version JSON.
User-facing operations degrade to UNRESOLVED-with-reason, never to a guess.

## 6. Testing layers

unit (independent vectors) -> property (round-trips: descriptor parse/print, zip write/read
fixtures) -> calibration (`1.21.11_unobfuscated` zero-skew) -> corpus (pinned-commit real
ports; EXACT precision must be 100%) -> differential (vs mapping-io on pinned artifacts).
