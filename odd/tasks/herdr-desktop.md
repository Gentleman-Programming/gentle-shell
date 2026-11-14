# Gentle Shell Desktop — Gentle Shell on Herdr app
A modern native replica of Gentle Shell built on Herdr app's GPUI engine, shipped as a package people can run, the way Gentle Shell ships pi.
Branch `feat/herdr-gentle-shell` from `origin/main` 3dc902975. References (read-only, untrusted): `~/work/herdr-refs/` (herdr-app, herdr-layout-examples, gentle-herdr, herdr-zoo, herdr-chat).

## Specs
- S1 "para crear la vista de herdr app, pero... que sea una replica moderna aprovechando las ventajas del motor grafico que dispone herdr app.... de gentle-shell"
- S2 "tiene que tener toda la misma informacion y demas" — every piece of information the Gentle Shell TUI shows (header, sidebar sections, footer/status bar, usage/cost, todo, subagents, jobs, changes, review/RDD, permission/YOLO modes, persona, models/profiles, Engram, questions) is available in the desktop view.
- S3 "Literal lo que quiero es poder crear como un paquete que la gente pueda ejecutar basado en herdr app, como lo que hicimos con gentle shell y pi"
- S4 Package form (user choice): "Herdr app + mods Gentle" — the Gentle Shell installer pins and installs a Herdr app version and adds our layout and mods; opened with `gentle-shell desktop`. No fork of Herdr.
- S5 Centre of the window (user choice): "Chat nativo + switch a Terminal" — each pi session is shown as a modern chat (markdown, tool calls, diffs, subagent cards, clickable questions), with a switch to the real TUI.
- S6 Code references: "ejemplos que podes tomar de referencia para codigo https://herdr.dev/gallery/"

## Constraints (from the Herdr spikes, `.worktrees/herdr-gentle-ui` `odd/tasks/herdr-tower-spikes.md`)
- Mods are GPUI views in JS: no HTML/CSS/canvas/webview/Node/setTimeout; data via `herdr` module, `exec`, `readTextFile`, `cx.timer`.
- Animate little (15 animated sprites cost 14–20 % CPU). PNGs pre-scaled. `TextView.markdown` uses theme colours.
- Herdr app is 0.1.x and regenerates its `.d.ts` per version: pin and check the version like pi.

## Tasks
- T1 Spike the feed: read a live pi session into a mod (session file / snapshot) and send prompt + answers back (hc / pane input); prove in running Herdr — S1, S5 — inline — pending
- T2 Parity inventory: table of every TUI element (S2) → data source → desktop place — S2 — inline — pending
- T3 Design the layout artboards (gentle-design), user approves — S1, S2, S5 — inline — pending
- T4 Publisher extension: per-session desktop snapshot (todo, changes, jobs, agents, usage, review, permission, persona, model/profile, question) — S2 — pending
- T5 Chat mod with Chat/Terminal switch — S5 — pending
- T6 Sidebar/status mods (sessions, todo, agents, jobs, usage, changes, review, modes) — S2 — pending
- T7 Actions: prompt, answer questions, cancel subagent/job, permission mode, review switch (same authority as the CLI) — S2 — pending
- T8 Package: layout + mods shipped in gentle-pi; `gentle-shell desktop` installs pinned Herdr app (checksum), installs layout/mods, `herdr-app check`, switches layout, launches — S3, S4 — pending
- T9 Docs (command help, README, RECIPE.md) — S3 — pending

## Risks
- Item 5 (delivery/environment): installing a third-party desktop app and writing into `~/.config/herdr-app/`.
- Item 2 (security): desktop actions must not exceed CLI authority.

## Log
- L1 (user): "bien quiero que te hagas otra worktree, basado en main, para crear la vista de herdr app, pero... que sea una replica moderna aprovechando las ventajas del motor grafico que dispone herdr app.... de gentle-shell, tiene que tener toda la misma informacion y demas. Literal lo que quiero es poder crear como un paquete que la gente pueda ejecutar basado en herdr app, como lo que hicimos con gentle shell y pi"
- L2 (user): "ejemplos que podes tomar de referencia para codigo https://herdr.dev/gallery/"
- L3 (user choices): package "Herdr app + mods Gentle (recomendado)"; centre "Chat nativo + switch a Terminal (recomendado)".
- L4: Herdr app source is Apache-2.0 (`herdrdev/herdr-app/LICENSE`). Community `Mayloparra24/gentle-herdr` already reskins Herdr in Gentle Shell colours (theme sync, files, editor) but does not replicate Gentle Shell information. `mysteriousHerb/herdr-zoo` `mods/claude-chat` is the closest reference for S5.
