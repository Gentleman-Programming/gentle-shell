# Gentle Tower — web view of Gentle Shell
The chosen tower design (`design/herdr-gentle-shell/11-tower-painted.html`) built as a real web view inside gentle-pi, fed by real Gentle Shell sessions.
Branch `feat/gentle-tower-web` (from `design/herdr-gentle-ui`). The Herdr spikes (`odd/tasks/herdr-tower-spikes.md`) are paused; Herdr gets a separate, more serious view later.

## Specs
- S1 "implementemos el disenno como una vista web te va? no como para herdr"
- S2 Data: "Reales desde el inicio" — connects to the open Gentle Shell sessions; what is not exposed yet (tasks, questions, artifacts) is added in gentle-pi.
- S3 Location: "Dentro de gentle-pi" — a Gentle Shell extension starts a local server and opens the browser with a command (e.g. `/gentle:tower`).
- S4 Stack: "Vite + TypeScript + PixiJS" — PixiJS draws the tower; panels (intercom, tasks, viewer) are plain HTML/TS.
- S5 Behaviour and look follow the chosen artboard ("me encanta vamos con esto"): project = building, session = floor, rooms = harness functions, named subagents moving between rooms, lobby = global state, intercom, in-world artifacts + viewer, per-floor TODO ("quiero ver facil el TODO de cada piso, para saber todo el trabjo que se tiene y por donde van"), Engram library, bar tab.
- S6 Later, not now: for Herdr "una vista mas... seniorial, mas seria, como una replica de gentle-shell".

## Architecture (decided defaults)
- **Publisher** (in every Gentle Shell session, extension `gentle-tower`): writes a bounded snapshot of its own session (name, cwd/project, model, cost/tokens/context, todo list, subagents with role/name/state, jobs, pending question, permission mode, review mode) to a per-user hub directory on change, debounced.
- **Hub + web server** (started by `/gentle:tower` in the session that runs it): reads the snapshots, serves the built web bundle and a Server-Sent Events stream. Binds `127.0.0.1` only, random port, a fresh random token required on every request (passed in the opened URL), `Origin` checked, no CORS.
- **Actions** go back through what Gentle Shell already has (peer messaging for intercom/answers, subagent cancel, permission mode, review switch) with the same authority rules; the web view never gets more power than the CLI.
- **Web app** `web/tower/`: Vite + TypeScript + PixiJS, built into a static bundle shipped with the package.

## Tasks
- T1 Snapshot contract (types + publisher) for the current session, with tests — inline — done
- T2 Hub + `/gentle:tower` server (127.0.0.1, token, origin, SSE) with tests — inline — done
- T3 Web app scaffold: Vite + TS + PixiJS, tower scene ported from the artboard, fed by SSE — inline — done (4880ad4f4, d2f94f6a9)
- T4 Multi-session: projects/floors from every published session — inline — done (hub reads every session; projects grouped by folder)
- T5 Actions: answer questions, intercom / @helper steer, stop helper, permission door, review switch — inline — done (7c6cd5158, 034a7aaea + permission confirm): intercom message, stop helper, permissions (lowering immediate; raising asks for confirmation in that session terminal), review switch. Not possible yet: answering an ask_user question from the web and @helper steering (no API in Gentle Shell; shown as "waiting in the terminal").
- T6 Artifacts + viewer, Engram library, bar tab — inline — done (7ff87f0f1, 034a7aaea). Plan usage meter left out: the usage service read shape was not confirmed.
- T7 Docs (command help, README section) and package wiring — inline — done (a7bc098ab)

## Delivery (chained PRs, ~400 authored lines each where possible; push/PR are the user's call)
- PR1 `design/herdr-gentle-ui`: artboards, SPEC.md, Herdr spikes (design-only, large static HTML — reviewed visually, not line by line).
- PR2 tower publisher + local server: commits 5ce2778f7, 7a788f63e (T1–T2, security-sensitive server in its own commit).
- PR3 web app scaffold and scene (T3–T4).
- PR4 actions (T5) — the security-sensitive control surface, alone.
- PR5 artifacts, Engram library, bar tab, docs (T6–T7).

## Risks
- Item 2 (security): a local control surface over sessions → localhost-only, token, origin checks, no new authority.
- Item 5 (dependencies): adds vite, typescript tooling for the web app and pixi.js.

## Log
- L1 (user): "y una cosa sino, hagamos algo, implementemos el disenno como una vista web te va? no como para herdr, y para este ultimo despues haciemos una vista mas... seniorial, mas seria, como una replica de gentle-shell"
- L2 (user choices): data "Reales desde el inicio (recomendado)"; location "Dentro de gentle-pi (recomendado)"; stack "Vite + TypeScript + PixiJS (recomendado)".
- L3: The existing desktop RPC is per-session over the pi RPC channel (`ctx.ui.setWidget`), not a server; multi-session needs the publisher/hub above.
- L4: T1+T2 verified: 18/18 focused tests (snapshot, hub, publisher, server, command), `pnpm typecheck` clean. Full `pnpm test`: 10606 pass, 2 fail — `#2997 … committed-range assessment` (tests/review-delivery-preflight.test.ts) and `capture forwards no selection when the lens has no configured model` (tests/review-relay-transport-agent.test.ts); both also fail on base 3dc902975 without these changes (13/1, 30/1), so pre-existing/environment-dependent (the second sees the local `claude-bridge/claude-opus-5-5` config).
- L5: web/tower is a standalone pnpm project (own node_modules, same supply-chain policy; allows esbuild's install script). Installed pixi.js 8.23.0, vite 7.3.8, typescript 5.9.3; the repo's node_modules untouched.
- L6: Slice boundary recorded: 4611 authored lines since origin/main at 7a788f63e (mostly design artboards); delivery split above.
- L7: End-to-end with the real server + built app in headless Chrome, 4 snapshots in 2 projects: tower renders at ×2 with the project switcher (`engram 1`, `gentle-ai 3 ?`), the waiting project opens first, floors with todo bars (`2/4 · blocked: …`, `1/2 · now: …`, `1/1 · all done`), orchestrators waving/thinking/sipping, `worker-change` + `worker-tests` named, `verify` in the lab, corkboard notes = tasks; console clean.
- L8: Two defects found by that e2e and fixed: (1) the query token did not reach assets/lazy chunks → token moved into the path (security commit 4880ad4f4, tests updated first); (2) Pixi needs eval for shaders → `pixi.js/unsafe-eval` keeps the strict CSP. Also `[hidden]` was overridden by CSS, scale fell to ×1 by 8 px, and a transient SSE error showed a false offline banner — all fixed.
- L9: Not yet verified inside a live Gentle Shell (the installed Gentle Shell loads the published package, not this worktree). Pending: T5 actions, T6 artifacts/Engram/tab, T7 docs + packaging of web/tower/dist.
- L10 (user): "termima todo y luego pruebo".
- L11: T5–T7 verified: 33/33 focused tests (actions parse/inbox/server, session execution incl. lower-only permissions and review switch, artifacts served only if listed and inside the project, Engram read-only proxy, latest words); `pnpm typecheck` clean; web build clean; DevTools-driven e2e in headless Chrome (select floor, intercom send → the message landed in that session's inbox, Mermaid diagram, Markdown doc, Engram library with the real local memories, the tab), console clean; package check refuses a pack without web/tower/dist/index.html.
- L12: Gentle AI's path guard blocked a shell command containing the CSS class `.key` (false positive for a private-key path); renamed the class to `.fkey` instead of working around the guard.
- L13: Delivery update: PR3 = 4880ad4f4, d2f94f6a9 (web app); PR4 = 7c6cd5158 (actions, security); PR5 = 7ff87f0f1, 034a7aaea, a7bc098ab (artifacts, Engram, tab, packaging, docs).
- L14: Full `pnpm test` on f16aadb5d: 10628 pass, 2 fail — the same two pre-existing failures as on base 3dc902975 (L4); every tower test passes.
- L15 (community feedback on 8ca6bd6a5): stationary hover flickered and carried LOUNGE's label; a Talk message reached the session but was absent above its response; `--link` needed `--package-root` to use the branch, and a basic floor lingered after an abrupt exit. Reproduced the hover with Pixi's event boundary: the static stage let the hover outline intercept its own target. A single per-frame owner now follows Pixi's click target. A separate deterministic Talk trace showed a delivered/acknowledged question leaving the 12-turn snapshot after enough assistant tool turns; the latest question now stays with the newest replies. The report did not include its session history, so that trace is a possible cause, not proof of the original session's exact sequence. A dead snapshot is ignored but its independently heartbeating presence has a two-minute TTL; suppressing it by old PID would also hide a genuinely resumed presence-only session. Branch testing now documents `--package-root`. Parent runtime generation/check, full Tower suite, typecheck and web build passed. Independent verification exercised the built application in ego-browser: eight stationary hover targets held for two seconds without transitions, one ownership transition as a person walked away, and HTTP → publisher → SSE → DOM retention of one question plus the final answer after 15 assistant turns. Rejected oversized sends remained 'not sent'. Original live-session history and an isolated baseline comparison were unavailable; the original Talk incident's exact cause is unproven. Presence remains at 120000 ms and expires at 120001 ms, unchanged. Risk: item 4 (animation-frame ownership and asynchronous snapshot/outbox retention); independent scoped verification passed.
