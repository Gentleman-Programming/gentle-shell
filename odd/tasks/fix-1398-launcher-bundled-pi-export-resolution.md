# Issue #1398: Resolve bundled Pi CLI via import.meta.resolve

## Objective

Fix resolution of the bundled `@earendil-works/pi-coding-agent` runtime in `bin/gentle-shell.mjs` by using `import.meta.resolve` instead of `require.resolve("@earendil-works/pi-coding-agent/package.json")`.

## Problem

When `gentle-pi` is installed without a separate `pi` binary on `PATH` and without `GENTLE_SHELL_PI` set, `bin/gentle-shell.mjs` attempts to resolve the bundled Pi runtime via:
```js
require.resolve("@earendil-works/pi-coding-agent/package.json");
```
Because `@earendil-works/pi-coding-agent` specifies an `exports` map that does not export `./package.json`, Node throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. The `catch` block swallows this error and returns `undefined`, causing the launcher to fail with `No pi runtime could be found`.

## Scope

- In `bin/gentle-shell.mjs`: Update `resolveBundledCli()` to resolve `@earendil-works/pi-coding-agent` via `import.meta.resolve`, deriving `join(dirname(fileURLToPath(entryUrl)), "bundle", "cli.js")`, with a fallback to `require.resolve`.
- In `tests/gentle-shell-bin.test.ts`: Add an integration test asserting that `bin/gentle-shell.mjs` resolves the bundled runtime when `GENTLE_SHELL_PI` is unset and `PATH` is empty.
- Run typecheck and test suites.

## Constraints

- Keep the patch minimal and focused on issue #1398.
- Technical artifacts remain in English.
- Do not commit, push, or merge without explicit user direction.
- Strict TDD discipline: RED test confirmed before implementation fix.

## Tasks

- [x] **T1 — Write failing test for bundled runtime resolution.** Add test in `tests/gentle-shell-bin.test.ts` exercising `bin/gentle-shell.mjs` with unset `GENTLE_SHELL_PI` and empty `PATH`.
- [x] **T2 — Implement import.meta.resolve in resolveBundledCli.** Update `bin/gentle-shell.mjs`.
- [x] **T3 — Full verification and typecheck.**
