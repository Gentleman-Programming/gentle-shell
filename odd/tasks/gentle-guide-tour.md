# Gentle guide tour

Objective: `/gentle:guide` runs a driver.js-style tour of Gentle Shell driven by the agent, plus a reminder under the startup banner.
Branch: `feat/keymaps-and-guide` (after user keymaps). Delivery: ask-on-risk. Runner: `node --experimental-strip-types --test tests/<file>.test.ts`, suite `npm test`.

## Specs

- S1 Tour through the agent: "con /gentle:guide, hacerle un tour a traves del agente para mostrarle todo lo que peude hacer, estilo: https://driverjs.com/". Each step shows a popover (title, description, step counter, how to try it, including its current keymap) placed next to the UI region it describes; the agent drives the steps through a tool and narrates them in the chat, and the user can ask questions mid-tour.
- S2 Covers what Gentle Shell can do: steps only for features whose command is registered in the session (palette and keymaps, subagents, jobs, todos, changes, models/profiles, design, voice, music, customize, permissions/review, memory, usage/stats, diagnostics).
- S3 Works without an agent: when no model is available, `/gentle:guide` runs the same steps locally with Next/Prev/Esc keys.
- S4 Startup reminder: "pongamos un mini recduerdo al iniciar de que puede usar /gentle:guide para ver como se usa." + "o dejemos el mensaje siempre si no es muy molesto" + "bajo el bannerl". A short one-line hint is shown under the startup banner on every start (same skip rules as the banner: no UI, child agents, Pi subcommands).
- S5 The tour can be stopped at any point (`/gentle:guide stop`, Esc in local mode, or the agent ending it) and leaves no popover behind.

## Tasks

- T1 [S1,S2,S3,S5] Tour steps + popover component + local mode (`lib/gentle-guide.ts`) + tests. Route: inline. Status: pending.
- T2 [S1,S5] `/gentle:guide` command and `gentle_guide` agent tool + system prompt hint (extension) + tests. Route: inline. Status: pending.
- T3 [S4] Reminder under the startup banner + tests. Route: inline. Status: pending.

Route evidence: no Writer trigger reason; parent works inline.

## Log

- L1 (2026-11-04) User: "te tengo una tarea increible! que podriamos hacer para que la persona si es la primera vez que entra a gentle-shell o tambien con /gentle:guide, hacerle un tour a traves del agente para mostrarle todo lo que peude hacer, estilo: https://driverjs.com/"
- L2 User: "en cuanto al gentle:guide si es la primera vez pongamos un mini recduerdo al iniciar de que puede usar /gentle:guide para ver como se usa." Then: "o dejemos el mensaje siempre si no es muy molesto" and "bajo el bannerl". Decision: no automatic tour on first run; a reminder under the banner on every start.
- L3 Evidence: overlay options in `pi-tui/dist/tui.d.ts:123-199` (9 anchors, offsetX/Y, row/col, nonCapturing); no UI region exposes its screen rectangle (sidebar hits are private in `lib/shell-sidebar-layout.ts:334`), so popovers anchor to the region's side instead of an exact spotlight; agent-tool model in `extensions/gentle-design.ts`; banner hook `extensions/startup-banner.ts:654`.
