# Contributing to ModForge

Thanks for your interest. ModForge is small on purpose, and contributions
that keep it small and correct are very welcome.

## Dev setup

You need Node >= 24. That is the whole setup:

```
git clone https://github.com/champmk/modforge.git
cd modforge
npm test
```

There is no install step for development. ModForge has zero runtime
dependencies; Node 24 runs the TypeScript sources natively via type stripping.
If `npm test` passes, you are ready to work. (The two devDependencies —
`typescript` and `@types/node` — exist only so installs can build `dist/`;
they never ship in the package.)

## Code style

- Strict TypeScript. Typechecking needs the compiler and Node's types
  (`npm install`, then `npx tsc --noEmit` must be clean). Build tooling only;
  it never ships.
- ESM only, with explicit `.ts` extensions in imports
  (`import { x } from "./y.ts"`).
- **No runtime dependencies. This is a hard rule, not a preference.**
  PRs that add a dependency will be declined regardless of how useful the
  package is. If we need a capability, we write it (the classfile parser
  and the MCP server are both dependency-free for this reason).

## Adding a test

Tests live in `test/` and use the built-in `node:test` runner -- no
framework. Add a file matching `*.test.ts` (or extend an existing one),
then run `npm test`. Bug fixes should come with a test that fails before
the fix and passes after.

## The correctness bar

ModForge's entire value is its honesty taxonomy: EXACT means deterministic
and jar-verified, CANDIDATE means evidenced but not proven, UNRESOLVED
means we tell you exactly why we could not resolve it.

**A confidently-wrong EXACT is the worst possible bug in this codebase.**
A refusal (UNRESOLVED with a precise reason) is a successful result; a
wrong EXACT silently corrupts someone's port. PRs that loosen the taxonomy
-- promoting CANDIDATEs to EXACT without jar verification, guessing at
renames, auto-applying anything that is not proven -- will be declined.
If you want ModForge to resolve more, the path is more evidence, not lower
standards.

## Pull requests

- Tests added or updated for the change.
- `npm test` green and `tsc --noEmit` clean. CI runs both on
  ubuntu-latest and windows-latest; your PR needs to pass on both.
- Keep diffs focused. Small, reviewable PRs merge fast.
