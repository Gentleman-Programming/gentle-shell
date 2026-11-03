# Gentle Shell IDE rework

Objective: redraw the Gentle Shell chrome as "an IDE inside a terminal" per the chosen design `design/shell-rework/02-proposal.html` (plus `05-mobile`, `06-many-agents`, `07-many-agents-mobile`), keeping every current capability.
Branch: `feat/shell-ide-rework` (separate worktree, base `origin/main` 813ec1106). Delivery: ask-on-risk → `feature-branch-chain` (user, L11): tracker branch `feat/shell-ide-rework`, one slice branch per work unit (`feat/shell-ide-rework-NN-<unit>`), child #1 targets the tracker, later children target their parent. Push and PRs only on the user's word. Test runner: `node --experimental-strip-types --test`, `pnpm run typecheck`. Route: inline only (user: "no delegues hazlo todo tu desede ahora").

## Specs

- **S1 Eyes.** "hay forma de darte \"ojos\" para que veas como se ve en la terminal y que tu mismo te auto corrijas?" and "cuando levantes una sesion para verla, fijate de hacerlo con --resume con una que ya tenga de todo". `scripts/shell-snapshot.mjs` launches the real shell on a fork of a rich session (`--fork --session-dir` into `/tmp`, never writing the source) and saves PNGs; every visual task is checked with it.
- **S2 Rail as one panel.** "esta espaciado en vez de una buena status bar" and "que no parezca un a tui sino un ide dentro de una terminal, con todas las ventaqjas que ya tenemos". Per `02-proposal`: one tinted surface, sections with one-row headers `▾ NAME count` (TODOS, JOBS, AGENTS, CHANGES, REVIEW, INTEGRATIONS), no cards, no padding rows; each fact once per screen (no Project group repeating the header); done todos collapse to `✓ N done`; a todo points to its job (`└ job-1`); empty sections take one muted row with their command; key hints in the rail's last row.
- **S3 Many agents.** "agrega que pasaria si tengo multiples agentes corriendo". Per `06-many-agents`: one row per agent, task first, agent kind, tokens and elapsed right-aligned; order waiting, running, queued, failed, then finished collapsed (`✓ N done`); header `3 running · 1 waiting`; failed rows stay in the error tone; overflow keeps waiting and running rows and adds `… N more`.
- **S4 Title row.** Project name and path once, the profile on the right, the session name when the session has one.
- **S5 Status bar.** One full-width row: branch (and dirty count), permission mode once, model and effort, context gauge, cost, weekly usage gauge and `alt+u`.
- **S6 Editor panel.** A titled rule carries the agent state (`waiting for input`, `working…`, ODD phase, `queued`) and the vim mode; alerts (agent question, RDD consent) take one row above it in the warning tone. Priority 1 confirmed by the user: input and its state, vim mode, location, model, context, "needs you" alerts.
- **S7 Mobile.** "lo que si te pido es que agreguemos vistas mobile". Per `05-mobile` and `07-many-agents-mobile`: below 140 columns the rail folds into one work row above the editor (current todo, or agent counts while agents run); tapping it or `/gentle:panel` opens the same panel as a full-width sheet, `esc` goes back, the editor stays visible; the status bar keeps priority 1 only and the model moves to the title row.
- **S8 Customize and presets.** "si esta bien pero sino en /gentle:customize se podrian apagar y hasta ofrecre versiones light neutral and power user". Every element stays switchable in `/gentle:customize`; presets Light (priority 1 only, rail hidden), Neutral (default, priority 1-2), Power user (everything); older saved settings keep loading.
- **S9 Performance.** No I/O or recomputation in render paths; caches keyed on everything that changes output (style, width, theme); render-count regression tests stay green; no slower settled frames than the base.
- **S10 Card styles.** Neon and float keep applying to transcript cards.

## Tasks

| ID | Specs | Route | Status | Commit / evidence |
|---|---|---|---|---|
| T0 | S1 | inline | done | `feat/shell-ide-rework-01-eyes` 33c7be637 (902 lines, 560 of them passive design HTML; slice PR 1) |
| T1 | S2 | inline | done | `feat/shell-ide-rework-02-rail-panel` 170268731 (525 lines; slice PR 2, child of PR 1) |
| T2 | S3 | inline | done | `feat/shell-ide-rework-03-agents` (slice PR 3, child of PR 2) |
| T3 | S2, S10 | inline | in progress | `feat/shell-ide-rework-04-status-panel`: Status split, section order, rail footer hints |
| T4 | S4, S5 | inline | pending | title row and bottom status bar |
| T5 | S6 | inline | pending | editor rule and alert row |
| T6 | S7 | inline | pending | narrow work row and panel sheet, `/gentle:panel` |
| T7 | S8 | inline | pending | presets and customize toggles, settings compatibility |
| T8 | S9, S1 | inline | pending | visual checks 180x50, 140, 56x34; render benchmark; full suite |

Risk notes: T7 changes the persisted visual settings format (Risk item 1 and 3: older files must keep loading, older binaries must not reset newer files). T1-T3 change shared rail rendering (item 3 for existing sections). These get their own commits.

## Log

- L1 (2026-11-03, user): "qe te parece si atacamos algo... quiero que veas esto: [screenshot] esta espaciado en vez de una buena status bar, te parece si hacemos un rediseño de gentle-shell? a ver que podemos hacer? hay forma de darte \"ojos\" para que veas como se ve en la terminal y que tu mismo te auto corrijas?"
- L2 (user): "quiero que la interfaz sea pensada para devs pero que sea moderna, que no parezca un a tui sino un ide dentro de una terminal, con todas las ventaqjas que ya tenemos"
- L3 (user): "cuando levantes una sesion para verla, fijate de hacerlo con --resume con una que ya tenga de todo"
- L4 (user): "no delegues hazlo todo tu desede ahora"
- L5 (user): "si esta bien pero sino en /gentle:customize se podrian apagar y hasta ofrecre versiones light neutral and power user"
- L6 (user): "me gusta mas el nuestro no el hibrido, pero lo que si te pido es que agreguemos vistas mobile"
- L7 (user): "agrega que pasaria si tengo multiples agentes corriendo"
- L8 (user): "vamos con esto me encanto!!!"
- L9 (decision): design `design/shell-rework/`, chosen artboard `02-proposal.html` with `05-mobile`, `06-many-agents`, `07-many-agents-mobile`; `03-hybrid-main` and `04-hybrid-git` are rejected alternatives. Inventory: `design/shell-ide/inventory.md`.
- L10 (decision): the designs named `/gentle:status` for the mobile sheet, but that command already shows the Gentle AI package status (`extensions/gentle-ai.ts:11886`); the sheet uses a new `/gentle:panel` instead, so no existing command changes.
- L11 (user, delivery choice): "Cadena sobre una rama de feature" (`feature-branch-chain`).
- L12 (T0 evidence): `scripts/shell-snapshot.mjs` no longer hardcodes a personal sessions path; `--latest-rich --from <project-dir>` derives Pi's session directory from the project path. `node --check` passed; `node scripts/shell-snapshot.mjs --latest-rich --from <main checkout>` exited 0 with PNGs at 180x50 (pty 50x180). Design artifacts copied to `design/shell-rework/` with home paths scrubbed; `01-today.html` (embedded private screenshot) stays out of the repo. Risk: none (dev-only script, passive design files).
- L13 (T1 decisions): `lib/shell-panel.ts` holds the panel header/row/surface helpers; the rail paints sections whose rail declares `surface: "panel"` on `customMessageBg` (the design's rail tint in all three themes), padding and the gap between two panels included, reusing the float background re-arm (`surfaceOpener`, `paintSurfaceRow` exported from `lib/shell-card.ts`). The task in progress or blocked wraps its title and note so the current work stays readable in full (keeps the existing "all details reachable by scrolling" behavior); other tasks clip to one row. `renderJobsCard` lost its only production caller, so it is removed and its tests now cover `renderJobsSection`; the collapse key hint (`ctrl+shift+j expand`) leaves the header and returns in the rail footer (T3). The bottom Todos widget keeps its card until T6.
- L14 (T1 evidence): RED `tests/shell-panel.test.ts` (module missing) and the layout surface test (row unpainted) observed before the code; GREEN: shell-panel 9/9, jobs-widget, gentle-todo 29/29, shell-sidebar-layout, gentle-shell 285/285; focused area suite 489 tests, the one failure was the intended `Jobs` → `▾ JOBS` header change, updated; typecheck 0 diagnostics. Visual: harness 180x50 shows `▾ TODOS` with `✓ 1 done`, the wrapped task in progress and its `└` note, the stale count in the warning role. Risk: item 3 (shared rail rendering and the removed internal `renderJobsCard`; no external consumers).
- L15 (T2 evidence): RED `renderAgentsSection` missing (agents-widget tests failed to import); GREEN agents-widget 27/27; the rail Agents test now asserts `surface: "panel"`, the `▾ AGENTS 2 running` header on row 0, task-first rows and header click collapse; area suite 979/979; typecheck 0. Visual: harness 180x50 shows `▾ AGENTS idle` / `none running · /gentle:agents` joined to the Todos panel. Decision: an idle Agents section stays as one muted row (S2 empty-section rule); the above-editor Agents card is unchanged. Follow-ups for T3: section order (live work first: Todos, Jobs, Agents, then Changes, Review, Integrations) and right-edge alignment once Status is a panel. Risk: item 3 (shared rail rendering).
