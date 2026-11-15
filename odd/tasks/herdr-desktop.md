# Gentle Shell Desktop — Gentle Shell on Herdr app
A modern native replica of Gentle Shell built on Herdr app's GPUI engine, shipped as a package people can run, the way Gentle Shell ships pi.
Branch `feat/herdr-gentle-shell` from `origin/main` 3dc902975. References (read-only, untrusted): `~/work/herdr-refs/` (herdr-app, herdr-layout-examples, gentle-herdr, herdr-zoo, herdr-chat).

## Specs
- S1 "para crear la vista de herdr app, pero... que sea una replica moderna aprovechando las ventajas del motor grafico que dispone herdr app.... de gentle-shell"
- S2 "tiene que tener toda la misma informacion y demas" — every piece of information the Gentle Shell TUI shows (header, sidebar sections, footer/status bar, usage/cost, todo, subagents, jobs, changes, review/RDD, permission/YOLO modes, persona, models/profiles, Engram, questions) is available in the desktop view.
- S3 "Literal lo que quiero es poder crear como un paquete que la gente pueda ejecutar basado en herdr app, como lo que hicimos con gentle shell y pi"
- S4 Package form (user choice): "Herdr app + mods Gentle" — the Gentle Shell installer pins and installs a Herdr app version and adds our layout and mods; opened with `gentle-shell desktop`. No fork of Herdr.
- S5 Centre of the window (user choice): "Chat nativo + switch a Terminal" — each pi session is shown as a modern chat (markdown, tool calls, diffs, subagent cards, clickable questions), with a switch to the real TUI.
- S7 Chosen direction (user): "me gusta mas el A" — `design/herdr-desktop/01-inspector.html`: native Herdr layout, two-row session header, right inspector with tabs (Changes, Todo, Agents, Jobs, Review, Session), plan usage in the sidebar footer, status bar with ODD phase / TPS / jobs.
- S8 Fidelity (user): "fijate porfa que quede 1 a 1 con el diseño eh" — the built window must match `design/herdr-desktop/01-inspector.html` one to one (layout, regions, sizes, spacing, colours, typography, states). Each view task closes only after a side-by-side check: `herdr-app shot` of the live window vs a headless render of the artboard at the same size, with every difference fixed or listed as a Herdr limitation.
- S9 Feature parity (user): "Una vez que termines todo fíjate que tengamos todas las mismas funcionadisded que gentle Shell y funcionen" — after T7-T9, a parity audit checks every Gentle Shell feature (commands, panels, modes, prompts, shortcuts, integrations) against the desktop and proves each one works, live where possible.
- S6 Code references: "ejemplos que podes tomar de referencia para codigo https://herdr.dev/gallery/"

## Constraints (from the Herdr spikes, `.worktrees/herdr-gentle-ui` `odd/tasks/herdr-tower-spikes.md`)
- Mods are GPUI views in JS: no HTML/CSS/canvas/webview/Node/setTimeout; data via `herdr` module, `exec`, `readTextFile`, `cx.timer`.
- Animate little (15 animated sprites cost 14–20 % CPU). PNGs pre-scaled. `TextView.markdown` uses theme colours.
- Herdr app is 0.1.x and regenerates its `.d.ts` per version: pin and check the version like pi.

## Tasks
- T1 Spike the feed: read a live pi session into a mod (session file / snapshot) and send prompt + answers back (hc / pane input); prove in running Herdr — S1, S5 — inline — done (`herdr/mods/gentle-chat`, `herdr/layouts/gentle-shell.json`)
- T2 Parity inventory: table of every TUI element (S2) → data source → desktop place — S2 — inline — done (`odd/tasks/herdr-desktop-parity.md`)
- T3 Design the layout artboards (gentle-design), user approves — S1, S2, S5 — inline — done (direction A, `design/herdr-desktop/01-inspector.html`)
- T4 Publisher extension: per-session desktop snapshot (todo, changes, jobs, agents, usage, review, permission, persona, model/profile, question) — S2 — done (`extensions/gentle-desktop-feed.ts`, `lib/desktop-feed*.ts`, `docs/desktop-feed.md`)
- T5 Chat mod with Chat/Terminal switch — S5 — pending
- T6 Sidebar/status mods (sessions, todo, agents, jobs, usage, changes, review, modes) — S2 — pending
- T7 Actions: prompt, answer questions, cancel subagent/job, permission mode, review switch (same authority as the CLI) — S2 — pending
- T8 Package: layout + mods shipped in gentle-pi; `gentle-shell desktop` installs pinned Herdr app (checksum), installs layout/mods, `herdr-app check`, switches layout, launches — S3, S4 — pending
- T10 Parity audit: every Gentle Shell feature present and working in the desktop (S9), with gaps closed or listed — S9 — pending
- T9 Docs (command help, README, RECIPE.md) — S3 — pending

## Risks
- Item 5 (delivery/environment): installing a third-party desktop app and writing into `~/.config/herdr-app/`.
- Item 2 (security): desktop actions must not exceed CLI authority.

## Log
- L1 (user): "bien quiero que te hagas otra worktree, basado en main, para crear la vista de herdr app, pero... que sea una replica moderna aprovechando las ventajas del motor grafico que dispone herdr app.... de gentle-shell, tiene que tener toda la misma informacion y demas. Literal lo que quiero es poder crear como un paquete que la gente pueda ejecutar basado en herdr app, como lo que hicimos con gentle shell y pi"
- L2 (user): "ejemplos que podes tomar de referencia para codigo https://herdr.dev/gallery/"
- L3 (user choices): package "Herdr app + mods Gentle (recomendado)"; centre "Chat nativo + switch a Terminal (recomendado)".
- L4: Herdr app source is Apache-2.0 (`herdrdev/herdr-app/LICENSE`). Community `Mayloparra24/gentle-herdr` already reskins Herdr in Gentle Shell colours (theme sync, files, editor) but does not replicate Gentle Shell information. `mysteriousHerb/herdr-zoo` `mods/claude-chat` is the closest reference for S5.
- L5: Parity inventory written; out-of-process gaps today: live session state, git, todo, review, stats, pending questions + answering, ODD phase. The publisher (T4) closes them.
- L6 (T1 evidence, herdr-core 0.1.21 without the window): `hc run --bg --json --cwd <tmp> --label gentle-spike=1 -- gentle-shell` → `t2`, `status.app = "gentle-shell"`, state idle. `hc send t2 "Responde solo: hola desde herdr"` + `hc wait t2` → `done`, turn 1; the prompt and the reply landed in `~/.gentle-shell/agent/sessions/--private-tmp-gs-spike.GAB6--/<ts>_<uuid>.jsonl` (entries: `session`, `model_change`, `thinking_level_change`, `custom`, `custom_message`, `session_info`, `message` with roles user/assistant/toolResult/system and content `text`/`thinking`/`toolCall`; assistant `usage.cost.total`). Note the session dir uses the realpath (`/private/tmp`). Pane → session mapping by cwd is ambiguous with several sessions in one folder: the publisher must report the exact session file. Remaining T1: read path inside a mod (readTextFile/watchFolder incremental) and Chat/Terminal switch.
- L7 (T1 live evidence, herdr-app 0.1.15): mod + layout installed into `~/.config/herdr-app`, `layout.switch gentle-shell`, status errors `[]`. The chat shows t2's session (user bubble, markdown reply, model, per-message cost, header total $0.246). A second `hc send` appeared live through watchFolder (total $0.264, message $0.017). Stack `"header": "tabs"` is documented but rejected by 0.1.15 (`expected struct Header`); removed. `layout.select {stack: views, child: terminal}` from the CLI did not visibly switch: open item for T5 (the in-mod switch and t2 not belonging to a window space are suspects).
- L8: T3 design directions in design/herdr-desktop/ — 01-inspector.html (A), 02-rail.html (B), 03-chat-first.html (C); pending user choice.
- L9 (user): "me gusta mas el A". Canvas note: the gentle_design tool is bound to the session cwd; from a gentle-ai session it cannot see this clone, so the canvas was opened from a Gentle Shell session in this worktree (hc t3).
- L10 (user): "fijate porfa que quede 1 a 1 con el diseño eh"
- L11 (T4 evidence): `tests/desktop-feed.test.ts` 12/12 pass (mutation run: 6 fail when debounce, bounds, question clear, shutdown and dedupe are broken); `scripts/check-types.mjs` 0 diagnostics; `npm test` failures identical to base (environmental: worktree without own node_modules, plus known base failures). Live: `gentle-shell -e extensions/gentle-desktop-feed.ts` in hc t4 wrote `~/.gentle-shell/agent/desktop/sessions/<id>.json` with exact sessionFile, ppid 8447 = Herdr terminal pid (match works), paneId `wMJ:p1`, super-yolo permission, model/profile. Always null for now: persona (private in gentle-ai.ts), statuses and integrations (footer data owned by gentle-shell), agents[].role — need small owner hooks later.
- L12 (user): "trata de resumir una conversacion existente y listo asi lo ves bien, esta por ejemplo" — a copy of the long real session is resumed in tab t6 for the fidelity pass.
- L13 (user): "No me muestres nada hasta terminar todo y dejarlo listo fíjate que todo funcione" — finish T5-T9 end to end and verify everything works before reporting.
- L14 (user): "Una vez que termines todo fíjate que tengamos todas las mismas funcionadisded que gentle Shell y funcionen"
- L15 (T7 verify, c277ab243): FAIL with 2 blockers. B1: any same-user process (including the agent's own write/bash tools) can drop an inbox file that sets super-yolo without the dialog — the desktop inbox path is not in SENSITIVE_PATH_PATTERNS and the session enforces no confirmation. B2: relayed provider consent / maintenance authorization arriving through ask_user_choice can be answered from the desktop, contradicting docs. Advisories: RDD switch is global but the dialog says --cwd; a directory named x.json is re-processed forever; idle >24h sweep drops a live session inbox; answer race with a question closing; stale nonce after a cancelled dialog. Fix queued after T10 finishes (same files).
