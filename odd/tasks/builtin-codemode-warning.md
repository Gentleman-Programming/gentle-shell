# Builtin codemode startup warning

Locator: `odd/tasks/builtin-codemode-warning.md` · Engram mirror: `odd/builtin-codemode-warning/tasks`
Branch: `fix/builtin-codemode-warning` (from `origin/main`)

## Objective

Remove the Pi 0.99 startup warning `Extension package "builtin:codemode": ... quiet-tools.ts registers tool codemode, so built-in extension codemode was not loaded` while keeping gentle-pi's compact codemode renderer, and fix the startup banner MCP server count.

## Problem / why

- Pi 0.99.1 ships replaceable builtins `codemode`, `tool-search`, `mcp` (plus non-replaceable `llama.cpp`). `omitReplacedExtensions` (`dist/core/resource-loader.js:71-101`) always warns when a replaceable builtin loses to another extension.
- gentle-pi intentionally replaces `codemode` (`extensions/quiet-tools.ts:805` -> `registerCompactCodemode`, `lib/codemode-renderer.ts:177`) to decorate its renderer. Pi exposes no API to decorate another extension's tool renderer (`ToolInfo` lacks renderCall/renderResult).
- The only per-builtin exclusion is `-builtin:<name>` in the settings `extensions` array (`dist/core/package-manager.js:737-743`). No CLI flag or env var exists.
- `extensions/startup-banner.ts:688` counts MCP servers from `~/.pi/agent/mcp.json` instead of the active agent dir, so the banner count is wrong under Gentle Shell (`~/.gentle-shell/agent`).

## Decision (user, 2026-09-30)

Option A: the launcher idempotently ensures `-builtin:codemode` in the `extensions` array of the isolated Gentle Shell home `settings.json` (same precedent as default theme enforcement). Never edit settings in `--link` mode (user-owned pi home) nor on `--dry-run`. Preserve all other keys and existing `extensions` entries; never duplicate; respect an explicit user `+builtin:codemode`/`!builtin:codemode` entry.

## Scope / constraints

- In scope: launcher settings enforcement + tests; banner MCP path + test if feasible.
- Out of scope: takeover path dropping builtins `mcp`/`tool-search`/`llama.cpp` via `--no-extensions` (`lib/gentle-shell-launcher.ts:915-916`) — reported as follow-up, not authorized yet.
- Test-first where a deterministic test exists (`node --experimental-strip-types --test tests/gentle-shell-bin.test.ts`).

## Tasks

- [x] T1 — Launcher ensures `-builtin:codemode` in isolated home settings `extensions` on launch (not `--link`, not `--dry-run`), idempotent, with tests. Route: delegated (writer trigger: launcher + tests, 2+ non-trivial files). Risk: high (edits user-visible settings file, installer/launcher).
- [x] T2 — Startup banner reads `mcp.json` from the active Pi agent dir (`getAgentDir()`) instead of `~/.pi/agent`. Route: delegated with T1 writer (same session, separate commit). Risk: medium.
- [x] T3 — Startup banner uses the active agent dir (`getAgentDir()`) for every count still reading the hardcoded `PI_AGENT_DIR` (`~/.pi/agent`): settings.json packages/extensions (~line 707), npm node_modules (`PI_NPM_DIR`), agents dir (~line 518). Authorized by user 2026-10-01. Route: delegated. Risk: medium.
- [x] T4 — Launcher atomic settings/config writes preserve symlinks (RDD advisory R3-001, bin/gentle-shell.mjs:746-749; same pattern at ~318, 576, 639, 683): one shared helper resolves the real target before temp-write + rename. Authorized by user 2026-10-01. Route: delegated. Risk: high (user config files, launcher).

## Acceptance criteria

- Launching Gentle Shell in isolated-home mode no longer prints the builtin codemode warning; builtin `mcp`, `tool-search`, `llama.cpp` still load.
- Settings file keeps all other keys byte-stable where possible; second launch produces no change.
- `--link` home settings are never modified.
- Banner MCP count reflects `<agentDir>/mcp.json`.

## Delivery

Forecast: ~150 authored changed lines (T1-T2). Running count after T3+T4 (git diff --stat 1403d0397~1..662d3b487, excluding odd/): 494 lines (472 additions + 22 deletions), over the ~400 budget; `ask-on-risk` requires a chain-strategy decision from the user before the PR. Strategy: `ask-on-risk`. Push/PR are user decisions.

## Progress / evidence

- 2026-09-30: exploration done (subagent muomyim4-1-7dwb). Branch created.
- 2026-09-30 T1 (delegated writer, risk high): logic lives in `bin/gentle-shell.mjs` (`withBuiltinExtensionExcluded` pure helper + `ensureBuiltinCodemodeExcluded` atomic write, called in `main` after auto-provision, wrapped in `safely`). Not in `lib/gentle-shell-launcher.ts` because bin imports the generated, tracked `runtime/gentle-shell-launcher.mjs`, which is outside the authorized edit surface.
  - Gate: normal launch only (`isolated`/`path`, no pi subcommand; `setup`/`--dry-run` return earlier), and only homes gentle-shell owns by the auto-provision rule (`homeIsForeign`): never `--link`, a foreign `--home`, or pi's default agent home.
  - Any explicit user entry (`+`/`-`/`!`/bare `builtin:codemode`), malformed JSON, non-object settings, or non-array `extensions` leaves the file untouched. A missing settings.json stays missing (only the new-home bootstrap seeds it). Indentation and trailing newline are preserved; one stderr notice on write.
  - RED: 4 positive bin tests failed with `extensions` `undefined` (5 guard tests already passed pre-change). GREEN: 9/9 new tests pass. Triangulation: mutating the ownership gate made the foreign/default-home test fail; reverted.
  - `node --experimental-strip-types --test tests/gentle-shell-bin.test.ts`: 123/123 pass.
  - `node scripts/check-types.mjs`: 187 recorded diagnostics, no regressions.
  - Commit: `1403d0397` fix(shell): exclude builtin codemode in the isolated home settings.
- 2026-10-01 T2 (delegated writer, risk medium): the planned `PI_AGENT_DIR` reuse was a wrong premise — `extensions/startup-banner.ts` defines it as the constant `~/.pi/agent`, so it would not follow Gentle Shell. The MCP read now uses Pi's own `getAgentDir()` (honors `PI_CODING_AGENT_DIR`), matching Pi's loader `join(agentDir, "mcp.json")` and `extensions/resume-hint.ts`.
  - RED: new `tests/startup-banner.test.ts` case rendered `MCP: 5 server(s)` (the non-active mcp.json). GREEN: renders `MCP: 2 server(s)` from `<PI_CODING_AGENT_DIR>/mcp.json`; file 10/10 pass.
  - Commit: `39c8d870d` fix(banner): count MCP servers from the active agent dir.
  - Follow-up (not authorized, not changed): the banner's `PI_AGENT_DIR` constant still drives `settings.json` (plugins/extensions counts), `agents/` and `npm/node_modules`, so those counts also read `~/.pi/agent` under Gentle Shell.
- 2026-10-01 verification after T1+T2:
  - `node --experimental-strip-types --test tests/gentle-shell-bin.test.ts`: 123/123 pass.
  - `node --experimental-strip-types --test tests/gentle-shell-launcher.test.ts`: 206/206 pass.
  - `node --experimental-strip-types --test tests/startup-banner.test.ts`: 10/10 pass.
  - `node scripts/check-types.mjs`: exit 0, no regressions.
  - `npm test`: FAIL in the delegated-worker environment, 4424 pass / 5 fail / 34 skipped; all 5 in `tests/gentle-ai.test.ts` (Herdr/permission lifecycle), caused by the inherited `GENTLE_PI_AGENTS_CHILD` env var (that file passes 90/90 with it unset). `env -u GENTLE_PI_AGENTS_CHILD npm test`: all stages PASS, 4429 pass / 0 fail / 34 skipped.

- 2026-10-01 T3 (delegated writer, risk medium): removed the `PI_AGENT_DIR`/`PI_NPM_DIR` constants from `extensions/startup-banner.ts`; `settings.json` (packages/extensions), `npm/node_modules/<pkg>/package.json` and `agents/` now resolve from `getAgentDir()` at call time.
  - RED: new `tests/startup-banner.test.ts` case rendered `PLUGINS: 4 package(s)`, `AGENTS: 7 agents`, `EXTENSIONS: 20 active` (the non-active dir). GREEN: `1 package(s)`, `2 active`, `3 agents` from `<PI_CODING_AGENT_DIR>`; file 11/11 pass.
  - Commit: `1393db7ca` fix(banner): read every startup count from the active agent dir.
- 2026-10-01 T4 (delegated writer, risk high): one `writeFileAtomically(path, data, { mode })` helper in `bin/gentle-shell.mjs` now backs all five atomic writes (`writeRawConfig`, `restoreFile`, `restoreManagedAssetDigestField`, `enforceDefaultThemeField`, `ensureBuiltinCodemodeExcluded`). It `realpathSync`s the path, writes the temp file next to the real target, `chmod`s it to the explicit `mode` (restoreFile's snapshot mode) or the real target's own bits (umask-proof), renames onto the real target, and removes the temp file before rethrowing on failure.
  - Decision: a missing path or dangling symlink (`realpathSync` ENOENT) is written at `path` itself, as before, instead of creating a file wherever the dangling link points (never follows a link to create an arbitrary file); other realpath errors propagate to the existing `safely(...)` wrappers.
  - Semantics note: `writeRawConfig` passed no mode, so a rewrite used the default creation mode; it now keeps an existing config.json's bits. Temp names unified to `.<name>.gentle-shell-<pid>.tmp`.
  - RED: 3 new `tests/gentle-shell-bin.test.ts` cases (codemode exclusion, setup theme restore, `home link` config persistence) failed with `... is still a symlink`. GREEN: all pass, targets keep 0o640/0o600 and no `.tmp` remains; a triangulation case pins the dangling-link fallback. Symlink tests skip where file symlinks are unavailable (Windows without privileges).
  - Commit: `662d3b487` fix(shell): keep symlinked settings intact on atomic writes.
- 2026-10-01 verification after T3+T4 (all with `GENTLE_PI_AGENTS_CHILD` unset):
  - `node --experimental-strip-types --test tests/gentle-shell-bin.test.ts tests/startup-banner.test.ts`: 138/138 pass.
  - `node --experimental-strip-types --test tests/gentle-shell-launcher.test.ts`: 206/206 pass.
  - `node scripts/check-types.mjs`: exit 0, 187 recorded diagnostics, no regressions.
  - `npm test`: exit 0, stages unit-tests / provider-contract / runtime-harness PASS; 4434 pass / 0 fail / 34 skipped.

## Next step

Parent review of the T3/T4 commits; push/PR remain user decisions.
