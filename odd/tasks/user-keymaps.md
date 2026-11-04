# User keymaps

Objective: let the user assign a keybinding to every Gentle action and palette command, edited in `/gentle:customize` and shown in the `alt+k` palette, applied on reload.
Branch: `feat/keymaps-and-guide` (worktree `../gentle-pi-keymaps-guide`). Delivery: ask-on-risk. Runner: `node --experimental-strip-types --test tests/<file>.test.ts`, suite `npm test`.

## Specs

- S1 Assign a keymap to each thing: "quiero agregar la posibilidad de keymaps, al hacer alt+k o /gentle:commands que se pueda asignar a cada cosa un keymap". Every built-in Gentle shortcut action (commands palette, changes, preset, usage, agents view/stop/collapse, jobs collapse, todo collapse) and every palette command can get a key; a palette command bound to a key runs `/<command>`.
- S2 Keymaps view in customize: "o por ahi una vista de keymaps en /gentle:customize". A `Keymaps` category in `/gentle:customize` lists every action with its current key; selecting a row captures the next key press and saves it; a row can also be cleared (disabled) and reset to default.
- S3 Palette integration: the `alt+k` / `/gentle:commands` palette shows the effective key of every listed command, and lets the user assign a key to the selected command, writing to the same registry as S2 (single source of truth).
- S4 Apply on reload, and tell the user: "ah entonces con reload si es mas trabajo no pasa nada, siempre que se lo digamos al user". After any keymap change the user is told it applies after `/reload`.
- S5 Conflicts: a key reserved by Pi (the editor-global keybindings Pi refuses to let extensions override, such as `ctrl+k`) is rejected with a clear message; a key already used by another Gentle keymap asks for confirmation and, if confirmed, moves the key (the other action is left unbound).
- S6 Compatibility (assumption, preserves existing contract): the existing environment variables (`GENTLE_PI_COMMANDS_KEY`, `GENTLE_PI_SHELL_CHANGES_KEY`, `GENTLE_PI_SHELL_PRESET_KEY`, `GENTLE_PI_SHELL_USAGE_KEY`, `GENTLE_PI_AGENTS_VIEW_KEY`, `GENTLE_PI_AGENTS_STOP_KEY`, `GENTLE_PI_AGENTS_KEY`, jobs and todo keys) keep their meaning and win over the saved file; an env-controlled row is shown as locked. With no file and no env, every default key is unchanged.
- S7 Persistence: `keymaps.json` under `gentlePiConfigHome()`, schema-versioned, atomic write; an unreadable or malformed file is reported and never overwritten silently.

## Tasks

- T1 [S1,S6,S7] Keymap registry `lib/keymaps.ts` (actions, resolution, read/write, validation) + tests. Route: inline. Status: pending.
- T2 [S1,S6] Shortcut registration reads the registry (gentle-shell, gentle-agents, jobs, todo; command bindings run `/<command>`) + tests. Route: inline. Status: pending.
- T3 [S2,S4,S5] `Keymaps` category in `/gentle:customize` with key capture, conflicts, clear/reset, reload notice + tests. Route: inline. Status: pending.
- T4 [S3,S4,S5] Palette shows every effective key and can assign a key to the selected command + tests; docs/help. Route: inline. Status: pending.

Route evidence: no Writer trigger reason (units depend on T1, same files); parent works inline.

## Log

- L1 (2026-11-04) User: "y una cosa mas, quiero agregar la posibilidad de keymaps, al hacer alt+k o /gentle:commands que se pueda asignar a cada cosa un keymap"
- L2 User: "o por ahi una vista de keymaps en /gentle:customize"
- L3 User first chose "al instante", then: "ah entonces con reload si es mas trabajo no pasa nada, siempre que se lo digamos al user". Decision: reload-to-apply, reuse Pi's shortcut registration.
- L4 Evidence: Pi reads `pi.registerShortcut` only at startup/reload (`interactive-mode.js` `setupExtensionShortcuts`); reserved ids in `core/extensions/runner.js:9-28` (not exported, mirrored in lib/keymaps.ts); `parseKey` from pi-tui converts raw input to a key id; `alt+k` palette in `lib/command-palette.ts:346-357`; customize rows support raw key capture (`lib/visual-customize-view.ts:71`).
- L5 Work happens in a separate worktree because another session has uncommitted sidebar changes in the main checkout.
