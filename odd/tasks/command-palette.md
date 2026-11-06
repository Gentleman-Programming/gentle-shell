# Command palette (OpenCode-style) for Gentle Pi

## Objective
Open a curated, grouped command menu — OpenCode-style — from one shortcut, pick an entry by its human label, and run the underlying Gentle command.

## Problem
Commands are discoverable only by typing `/` and remembering names. OpenCode offers a curated, grouped command palette; Gentle Pi had none, and the first flat "every extension command" version read as a raw command listing rather than a designed menu.

## Why
User request (2026-09-16): "un menu como OpenCode, Ctrl+p que te dé todas las opciones como /gentle:models /gentle:changes etc".

## Decision: default key
`ctrl+p` is Pi's `app.model.cycleForward`, which is in Pi's reserved list for extension conflicts, so an extension shortcut on it is skipped with a diagnostic on stock keybindings. The user first chose `ctrl+k` as default. Superseded on 2026-09-16: `ctrl+k` turned out to be Pi's `tui.editor.deleteToLineEnd`, also in Pi's reserved list, so it was skipped with a diagnostic and never opened. The user chose `alt+k` instead (verified free in both the pi-tui editor map and the pi-coding-agent app map, matching Gentle's existing `alt+g`/`alt+a`/`alt+s` family). Configurable with `GENTLE_PI_COMMANDS_KEY` (`off` disables), same shape as `GENTLE_PI_SHELL_CHANGES_KEY`. Docs explain how to get `ctrl+p` by rebinding `app.model.cycleForward` in `~/.pi/agent/keybindings.json`. Inside the palette, `ctrl+k`/`ctrl+j` still move the selection; only the outer shortcut that opens the palette changed.

## Scope
- `lib/command-palette.ts`: pure `CommandPalette` overlay component operating on `CommandPaletteGroup[]` (grouped, curated entries, not a flat "every extension command" list), `rankPaletteGroups`, keyboard handling, and the `commandsKey(env)` helper. No Pi API calls inside.
- `lib/command-palette-catalog.ts` (new): pure data — `COMMAND_PALETTE_CATALOG` (the curated Configuration/Session/Diagnostics/SDD/Skills groups) and `buildCommandPaletteGroups(registered, shortcuts)`, which keeps only catalog entries whose command is actually registered, attaches the live description and an optional shortcut hint, and drops empty groups.
- `extensions/gentle-shell.ts`: `/gentle:commands` command, `alt+k` shortcut, `showCommandPalette(pi, ctx, env)` using `ctx.ui.custom` (overlay, centered, width 70%, minWidth 60, maxHeight 85%), building groups from `buildCommandPaletteGroups(pi.getCommands(), { "gentle:changes": changesShortcut(env), "gentle:agents": agentsViewKey(env) })`. Skips entirely when `ctx.hasUI` is false. Notifies "No Gentle commands are registered." when no group survives. Selecting runs `pi.sendUserMessage("/<command>", { expandPromptTemplates: true })` after the overlay closes.
- Tests: `tests/command-palette.test.ts` (component + catalog), `tests/gentle-shell.test.ts` (wiring).
- Docs: `docs/gentle-shell.md` ("Command palette" subsection), `docs/readme-reference.md` (command table row) — both describe the curated grouped menu, not "every extension command".

## Behavior
- Data model: `CommandPaletteItem = { command, label, description?, shortcut? }`, `CommandPaletteGroup = { title, items }`. `CommandPaletteResult` stays `{ type: "run"; name: string } | { type: "close" }`, where `name` is the item's `command`.
- Typing printable characters appends to the query; backspace removes; `ctrl+u` clears. Filtering is case-insensitive and ranks per item: 0 label starts with query, 1 label contains, 2 label matches as a subsequence, 3 command name contains, 4 description contains. Ties keep input order within a group; groups are never reordered relative to each other; a group with no matching item is dropped entirely. Empty or whitespace-only query returns every group unchanged.
- Navigation moves only across items — group titles are never selectable. Selection is an index into the flattened, currently-visible items; it resets to 0 whenever the query changes. `up`/`down`, `ctrl+k`/`ctrl+j` move (clamped); `enter` runs the highlighted item; `escape` or `ctrl+c` closes without running.
- Render: row 1 is `Commands` (title tone, left) and `esc` (muted, right-aligned to the inner width); row 2 is `› <query>` or a muted `› Search` hint when empty; a blank row; then, per visible group, the group title in accent tone followed by its items (`  <label>` padded, shortcut right-aligned in muted tone, omitted when undefined), with a blank row between groups; a blank row; footer `type to search • ↑/↓ move • enter run • esc close`. The selected item's row is drawn as a full-width highlighted bar via `theme.bg("selectedBg", ...)` when the theme exposes `bg`; otherwise it falls back to a `▸` marker in accent tone (same as the previous flat design). No match: one muted row `No commands match "<query>"`.
- Height is dynamic, not a fixed 20-row cap (that cap is specific to the models panel): the component takes a `rows: () => number` callback (terminal rows) and caps the whole rendered card at `max(12, floor(rows() * 0.85))` total lines. When the grouped, flattened row list (titles and blank separators included) does not fit, a scroll window keeps the selected item's row visible, with `↑ N more` / `↓ N more` muted indicators counting rows, not items.
- All user-visible text (labels, shortcuts, the query, the header) passes through the same escaping `sanitizeTerminalText` (control characters escaped, not deleted) and is padded/measured with `visibleWidth`, matching the earlier width-alignment fix.

## Constraints
- Strict TDD (source: user CLAUDE.md). Runner: `node --experimental-strip-types --test tests/command-palette.test.ts tests/gentle-shell.test.ts` with `TMPDIR=/private/tmp`. Observe RED before implementing.
- Artifacts in English. No AI attribution trailers.
- Built-in Pi commands (`/model`, `/settings`, …) are not listed, and neither is any registered extension command that is not in the curated catalog: only catalog entries whose command is actually registered are shown.

## Tasks
- [x] T1 `lib/command-palette.ts` with tests (RED then GREEN): filtering/ranking, input handling, rendering, sanitization.
- [x] T2 `extensions/gentle-shell.ts` wiring with tests: key helper (default, override, off), command registration, shortcut registration, overlay lists extension commands minus itself, enter sends the slash message with `expandPromptTemplates: true`, escape sends nothing.
- [x] T3 Docs.
- [x] T4 Checks: focused tests, `pnpm run typecheck`, `node --experimental-strip-types tests/runtime-harness.mjs`, full unit suite (parent).

## Acceptance criteria
- `alt+k` (or `/gentle:commands`) opens a curated, grouped menu (Configuration, Session, Diagnostics, SDD, Skills) of registered Gentle commands, each shown by its human label, with its shortcut hint when it has one.
- Typing narrows the list; enter runs the highlighted command (by its underlying command name) exactly as if typed as a slash command; escape closes without side effects.
- A registered extension command outside the curated catalog is never shown; a catalog entry whose command is not registered is never shown.
- `GENTLE_PI_COMMANDS_KEY=off` registers no shortcut; the command still works.
- The palette never opens in a headless context (`ctx.hasUI === false`).
- The card's height adapts to the terminal (`rows()`), not a fixed row cap; a grouped list too tall for the terminal scrolls while keeping the selection visible.

## Progress
- Done. All four tasks complete and verified.
- T1: `lib/command-palette.ts` — `rankCommandMatches`, `CommandPalette`, `commandsKey`. RED observed (`tests/command-palette.test.ts` failed with `ERR_MODULE_NOT_FOUND` before the file existed), then 24/24 GREEN on first implementation pass.
- T2: `extensions/gentle-shell.ts` — `COMMANDS_COMMAND_NAME`, `showCommandPalette`, `/gentle:commands` command, `ctrl+k` shortcut via `commandsKey(env)`. RED observed (6 new `tests/gentle-shell.test.ts` cases failed: shortcut not registered, `commands.get("gentle:commands")` undefined). Extended `fakePi` with `getCommands`/`sendUserMessage` and generalized `fakeContext.ui.custom` to resolve with the value passed to `done` (it previously hardcoded `resolve(null)`, which cannot express a typed `CommandPaletteResult`). Also updated one pre-existing test (`gentleShell binds the changes shortcut to the same handler as the command`) whose `shortcuts.size === 0` assertion was invalidated by the new default `ctrl+k` shortcut always registering; narrowed it to check `alt+g` specifically. Final: 59/59 GREEN in the two focused files.
- T3: Docs — `docs/gentle-shell.md` "Command palette" subsection, `docs/readme-reference.md` command table row.
- T4: `pnpm run typecheck` — no regressions (2 improved). `tests/runtime-harness.mjs` — exit 0. Full unit suite (`tests/*.test.ts`) — 2599 pass, 38 skipped (pre-existing), 0 fail.

## Native review (RDD on)
- User granted; four lenses admitted; approved; acknowledgement burned (lineage review-c78eda3f7809025a, workspace candidate with the three new files selected as intended untracked).
- Advisory, non-blocking follow-ups worth applying before delivery: guard `result?.type` after the overlay resolves (R4-001/R3-001); pad rows by display width instead of `.length` so wide characters do not break the card border (R2-002/R3-003); import `stripAnsi`/`sanitizeTerminalText` from `lib/terminal-theme.ts` instead of a third copy (R2-001); pass an explicit locale to `localeCompare` (R3-004); skip the overlay when `ctx.hasUI` is false (R3-006); invoke the shortcut handler in a test (R3-005). Cosmetic: `TONE` dead value (R2-003), `isPrintable` naming/paste behavior (R2-004/R3-002), `width - 4` constant (R2-005).

## Follow-ups applied (2026-09-16)
- R4-001/R3-001: guarded `if (result?.type === "run")` in `showCommandPalette` after the overlay resolves. Test: `resolving the overlay through closeOverlay sends nothing and does not throw` (RED: `TypeError: Cannot read properties of null (reading 'type')` before the guard).
- R2-002/R3-003: `fitStyledLine` and the name-column width in `renderMatches` now measure and pad with `visibleWidth` (`@earendil-works/pi-tui`) instead of `.length`/`padEnd`; overflow now truncates the styled row (`truncateToWidth(content, ...)`), keeping ANSI styling instead of returning stripped text. Test: `render keeps the right border aligned when a description has wide characters` (RED: two rendered widths, 60 and 70, for a CJK vs. an ASCII description of equal `.length`).
- R2-001: `stripAnsi` now imports from `./terminal-theme.ts` (identical intent, no behavior change). **Deviation, flagged for confirmation**: `lib/terminal-theme.ts`'s `sanitizeTerminalText` *deletes* control characters (`.replace(CONTROL_CHAR_PATTERN, "")`), while this palette's local `sanitizeTerminalText` *escapes* them into `\xNN` (matching the original spec's explicit requirement — "control characters escaped" — and the existing passing test asserting `\\x07` for a `\x07` byte). These are different functions sharing a name; importing the shared one would silently regress that acceptance criterion and break that test. Kept the local escaping `sanitizeTerminalText`, documented why, and did not import it from `terminal-theme.ts`. Only `stripAnsi` was switched to the shared import.
- R3-004: `localeCompare(right.name, "en")` in `showCommandPalette`'s sort.
- R3-006: `showCommandPalette` returns immediately when `ctx.hasUI` is false — no overlay, no `getCommands()` call. Test: `/gentle:commands does nothing in a headless context` (RED: without the guard the call hung indefinitely, since the fake overlay never resolves on its own — the hang itself is the failure evidence; the test run was killed at the 120s tool timeout).
- R3-005: `the alt+k shortcut opens the same command palette as the command` — invokes `shortcuts.get("alt+k")!.handler(ctx)` directly (mirrors the existing `alt+g` changes-shortcut test) and asserts the rendered palette lists `gentle:models`.
- R2-003: dropped the `TONE` value object; `Tone` is now a plain union type `"border" | "muted" | "text" | "title" | "accent"`.
- R2-004/R3-002: `isPrintable` renamed to `isSingleBmpPrintable`, documented that multi-character paste input and astral characters are ignored on purpose; no behavior change.
- R2-005: named `CARD_PADDING = 4` (two border glyphs plus two padding spaces) and `render()` now computes `innerWidth` once and passes it into `renderCard`, which no longer recomputes it from the raw width.
- Addendum (2026-09-16): default shortcut changed from `ctrl+k` to `alt+k` (see "Decision: default key"). `commandsKey()` default and doc comment updated; every `ctrl+k`-as-default assertion in both test files updated to `alt+k` (the `ctrl+p` override test and the `off` test are unchanged); `docs/gentle-shell.md` and `docs/readme-reference.md` updated, with one sentence added explaining `ctrl+k` is reserved by Pi's editor delete-to-line-end action. RED observed: `commandsKey defaults to alt+k` failed (`'ctrl+k' !== 'alt+k'`) before the `commandsKey` change; `gentle:commands registers ctrl+k by default` (now renamed) failed analogously in `tests/gentle-shell.test.ts` before the shortcut registration picked up the new default.
- Final checks: `tests/command-palette.test.ts` + `tests/gentle-shell.test.ts` — 63/63 pass. `pnpm run typecheck` — no regressions (2 improved). `tests/runtime-harness.mjs` — exit 0.

## Redesign: curated grouped menu (2026-09-16)

### Tasks
- [x] R1 `lib/command-palette-catalog.ts` (new) — `COMMAND_PALETTE_CATALOG`, `buildCommandPaletteGroups`, with tests (RED then GREEN).
- [x] R2 `lib/command-palette.ts` rewrite — grouped data model, `rankPaletteGroups`, flattened navigation, grouped/height-aware rendering, `bg`-highlighted selection with `▸` fallback.
- [x] R3 `extensions/gentle-shell.ts` wiring — `showCommandPalette(pi, ctx, env)` builds groups from the catalog and live registrations/shortcuts, passes `rows`/theme into the component.
- [x] R4 `tests/gentle-shell.test.ts` — updated fixtures and assertions for the grouped, labeled, curated menu.
- [x] R5 Docs — `docs/gentle-shell.md`, `docs/readme-reference.md` describe the curated grouped menu.
- [x] R6 Checks — focused tests, `pnpm run typecheck`, `node --experimental-strip-types tests/runtime-harness.mjs`.

### Progress
- Done.
- R1: `lib/command-palette-catalog.ts` — `COMMAND_PALETTE_CATALOG` (Configuration/Session/Diagnostics/SDD/Skills, exact entries from the request) and `buildCommandPaletteGroups`. RED observed together with R2 below (both files are new/rewritten; the whole test file failed with `ERR_MODULE_NOT_FOUND` for `lib/command-palette-catalog.ts` before either file existed). GREEN: all 3 catalog-specific tests plus the rest of the suite passed on the first implementation attempt.
- R2: `lib/command-palette.ts` fully rewritten — `CommandPaletteItem`/`CommandPaletteGroup`, `rankPaletteGroups` (5 ranks: label-prefix, label-contains, label-subsequence, command-contains, description-contains), a `PaletteRow` model (title/blank/item) flattened for navigation and height-aware windowing, `justifyToWidth` for the header and item rows, `theme.bg("selectedBg", ...)` highlight with a `▸`-marker fallback, dynamic height (`max(12, floor(rows() * 0.85))` total lines, no fixed 20-row cap). Kept `visibleWidth`-based padding, the escaping `sanitizeTerminalText`, and the wide-character border-alignment test (adapted to grouped items). 32/32 tests green in `tests/command-palette.test.ts`.
- R3: `extensions/gentle-shell.ts` — `showCommandPalette` now takes `env`, builds groups via `buildCommandPaletteGroups(pi.getCommands(), { "gentle:changes": changesShortcut(env), "gentle:agents": agentsViewKey(env) })` (imported from `./gentle-agents.ts`; this and `gentle-agents.ts` already importing `openInExternalEditor` from `./gentle-shell.ts` makes the two extensions mutually import each other — safe here since both usages are deferred to call time, not module-evaluation time, and the full suite confirms no load-order issue), notifies "No Gentle commands are registered." when no group survives, and passes `rows: () => Math.max(0, tui.terminal.rows)` plus the real theme into the component. The old `source === "extension"` / self-exclusion filter is gone: only catalog-listed, registered commands are ever candidates, so `gentle:commands` (not in the catalog) and any non-curated command are excluded by construction.
- R4: `tests/gentle-shell.test.ts` — `DEFAULT_COMMANDS` now includes catalog names (`gentle:models`, `gentle:changes`, `gentle:status`, `skill-registry:refresh`) plus a non-catalog extension command and a skill command. RED observed by temporarily reverting `extensions/gentle-shell.ts` to its last committed state (`git stash`/`git stash pop`, no commits made) and running the suite: 8 failures (`shortcuts.has("ctrl+p")` false, six `commands.get("gentle:commands")` / `shortcuts.get("alt+k")` undefined `TypeError`s or assertion failures) — expected, since that reverted state predates the whole feature. Restored the implementation; GREEN: 38/38 in this file, 70/70 combined with `tests/command-palette.test.ts`.
- R5: `docs/gentle-shell.md` "Command palette" subsection and `docs/readme-reference.md` row rewritten for the curated grouped menu.
- R6: `pnpm run typecheck` — no regressions (2 improved, same baseline as before this stage). `tests/runtime-harness.mjs` — exit 0.
- Decision gap resolved (2026-09-16): the empty-catalog notice and the `registerCommand` description wording were confirmed as fine; the escaping `sanitizeTerminalText` stays as is (no switch to `lib/terminal-theme.ts`'s delete-on-sanitize behavior).

## Structural fix: broke the gentle-shell/gentle-agents circular import (2026-09-16)
- R3 above introduced a real circular import (`extensions/gentle-shell.ts` importing `agentsViewKey` from `./gentle-agents.ts`, which already imports `openInExternalEditor` from `./gentle-shell.ts`). Fixed by extracting the three pure shortcut helpers into a new `lib/agents-keys.ts`.
- `lib/agents-keys.ts` (new) — `agentsViewKey`, `agentsCollapseKey`, `agentsStopKey` and their default constants (`VIEW_KEY_DEFAULT`, `COLLAPSE_KEY_DEFAULT`, `STOP_KEY_DEFAULT`), moved verbatim from `extensions/gentle-agents.ts`.
- `extensions/gentle-agents.ts` — imports the three functions from `../lib/agents-keys.ts` (for its own internal use building the agents-view shortcuts) and re-exports them (`export { agentsViewKey, agentsCollapseKey, agentsStopKey };`) so `tests/gentle-agents.test.ts` and any other existing importer keep working unchanged.
- `extensions/gentle-shell.ts` — imports `agentsViewKey` from `../lib/agents-keys.ts` instead of `./gentle-agents.ts`. `grep -n "gentle-agents" extensions/gentle-shell.ts` now returns nothing (confirmed).
- No behavior change; no new tests required (pure move + re-export). Verified with the full existing suite: `tests/gentle-agents.test.ts` (98/98), `tests/command-palette.test.ts` + `tests/gentle-shell.test.ts` (70/70), `pnpm run typecheck` (no regressions), `tests/runtime-harness.mjs` (exit 0).

## Next step
None — redesign, wording confirmation, and the circular-import fix are all implemented and verified.
