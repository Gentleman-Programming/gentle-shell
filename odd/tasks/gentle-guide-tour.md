# Gentle guide tour

Objective: `/gentle:guide` runs a driver.js-style tour of Gentle Shell driven by the agent, plus a reminder under the startup banner.
Branch: `feat/keymaps-and-guide` (after user keymaps). Delivery: same single PR as user keymaps, with a size exception (user: "un solo pr con size exception"). Runner: `node --experimental-strip-types --test tests/<file>.test.ts`, suite `npm test`.

## Specs

- S1 Tour through the agent: "con /gentle:guide, hacerle un tour a traves del agente para mostrarle todo lo que peude hacer, estilo: https://driverjs.com/". Each step shows a popover (title, description, step counter, how to try it, including its current keymap) placed next to the UI region it describes; the agent drives the steps through a tool and narrates them in the chat, and the user can ask questions mid-tour.
- S2 Covers what Gentle Shell can do: steps only for features whose command is registered in the session (palette and keymaps, subagents, jobs, todos, changes, models/profiles, design, voice, music, customize, permissions/review, memory, usage/stats, diagnostics).
- S3 Works without an agent: when no model is available, `/gentle:guide` runs the same steps locally with Next/Prev/Esc keys.
- S4 Startup reminder: "pongamos un mini recduerdo al iniciar de que puede usar /gentle:guide para ver como se usa." + "o dejemos el mensaje siempre si no es muy molesto" + "bajo el bannerl". A short one-line hint is shown under the startup banner on every start (same skip rules as the banner: no UI, child agents, Pi subcommands).
- S5 The tour can be stopped at any point (`/gentle:guide stop`, Esc in local mode, or the agent ending it) and leaves no popover behind.

## Tasks

- T1 [S1,S2,S3,S5] Tour steps + popover component + local mode (`lib/gentle-guide.ts`) + tests. Route: inline. Status: done (RED: missing module → GREEN tests/gentle-guide.test.ts 11).
- T2 [S1,S5] `/gentle:guide` command and `gentle_guide` agent tool + system prompt hint (`extensions/gentle-guide.ts`), palette entry, docs + tests. Route: inline. Status: done (same test file; command-palette 38 with the catalog pin updated).
- T3 [S4] Reminder under the startup banner + tests. Route: inline. Status: done (RED: last line was `VER:` → GREEN startup-banner 17).

Route evidence: no Writer trigger reason; parent works inline.

## Log

- L1 (2026-11-04) User: "te tengo una tarea increible! que podriamos hacer para que la persona si es la primera vez que entra a gentle-shell o tambien con /gentle:guide, hacerle un tour a traves del agente para mostrarle todo lo que peude hacer, estilo: https://driverjs.com/"
- L2 User: "en cuanto al gentle:guide si es la primera vez pongamos un mini recduerdo al iniciar de que puede usar /gentle:guide para ver como se usa." Then: "o dejemos el mensaje siempre si no es muy molesto" and "bajo el bannerl". Decision: no automatic tour on first run; a reminder under the banner on every start.
- L5 Verification T1-T3: typecheck 0 diagnostics; provider-contract and runtime-harness pass (node directly); unit with GENTLE_* unset 8170 pass, 0 fail (8258 tests). Risk: none (new command, tool, palette entry and banner line, all requested; no shared helper changed).
- L4 Evidence: Pi resolves `overlayOptions` once, when the overlay opens (`interactive-mode.js` `resolveOptions()` passed to `showOverlay`), so a step for another region closes the popover with result "moved" and reopens it there; `nonCapturing` overlays never take focus (`pi-tui/dist/tui.js:406,444,577`), so in agent mode the user keeps typing. Sidebar placement reads `SidebarState.railColumns`. Agent pacing: one step per turn, the user replies to continue or asks questions.
- L3 Evidence: overlay options in `pi-tui/dist/tui.d.ts:123-199` (9 anchors, offsetX/Y, row/col, nonCapturing); no UI region exposes its screen rectangle (sidebar hits are private in `lib/shell-sidebar-layout.ts:334`), so popovers anchor to the region's side instead of an exact spotlight; agent-tool model in `extensions/gentle-design.ts`; banner hook `extensions/startup-banner.ts:654`.
