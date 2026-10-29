# Gentle Design: provider-free design canvas for Gentle Shell

Objective: a Gentle Shell equivalent of Claude Code `/design` (HTML artboards, canvas, comments, design system, handoff to code) that runs with any Pi provider.
Branch: `feat/gentle-design` (worktree `.worktrees/gentle-design`, base `origin/main` 9f29f16f1). Delivery: `ask-on-risk` → `feature-branch-chain` (chosen directly under the session's Super Yolo delivery permission), one PR slice per phase. Test runner: `node --experimental-strip-types --test tests/<file>.test.ts`; suite `pnpm test`.

## Specs

Requirements S2-S8 come from the plan the user accepted (L2, L3). Wording outside quotes is the plan's, not the user's.

- **S1 Provider independence.** User: "planifiquemos como podriamos dar eso sin tener que pasr por claude, desde gentle shell directo por nosotros sin necesidad de usar dicho proveedor". Acceptance: no code path calls a provider-specific API; the feature works with whatever model the Pi session uses; the only network traffic is the loopback canvas server; artboards are self-contained (no CDN, no remote fonts or scripts).
- **S2 Design skill.** A bundled skill (`skills/design/SKILL.md`, name `gentle-design`) makes the model:
  - take the brief: goal, layout, content and audience, with at most one clarifying question;
  - generate several clearly different directions (3 by default, or the number the user asks for), each labeled with the tradeoff it makes;
  - write them to `design/<slug>/`: one self-contained HTML file per artboard (`NN-<name>.html`, inline CSS/JS/SVG, system font stacks) plus a `design.json` manifest (`title`, `brief`, `artboards[]` with `file`, `title`, `tradeoff`, `width`, `height`);
  - use realistic content and accessible markup: semantic elements, WCAG AA contrast, visible focus, `prefers-reduced-motion`;
  - reuse `design/system.md` tokens when present;
  - when iterating, edit only the targeted artboard; "save and try a different approach" adds a new artboard and keeps the previous ones;
  - when the user wants to tune something, add sliders or controls with a "Copy as prompt" button.
- **S3 Command.** `/gentle:design <brief>` starts a design run with the skill. `/gentle:design` with no arguments opens the most recent design in the session cwd, or prints usage when there is none. The subcommands are `open [slug]`, `stop`, `sync` and `implement <slug>/<artboard>`. The help text, the README feature table and `docs/gentle-shell.md` describe all of them.
- **S4 Local canvas.** `/gentle:design open [slug]` starts a local server and opens the default browser on a canvas:
  - every artboard shows side by side, at its manifest size, with its title and tradeoff;
  - zoom (buttons, and Ctrl/Cmd + wheel), pan and fit;
  - live reload when an artboard file or the manifest changes.
- **S5 Comments back to the session.** In comment mode, clicking an element in an artboard and typing a comment sends the session one message with: the design slug, the artboard file, a CSS selector for the element, a short text excerpt of the element, and the comment. While the agent is busy, the message is queued as a follow-up. The agent edits that artboard, and the canvas reloads.
- **S6 Local server safety.** The server:
  - binds `127.0.0.1` only, on a random port;
  - requires a per-server random token on every route;
  - rejects a `Host` header that is not its own loopback address;
  - accepts POST only with `Origin` equal to its own origin and a JSON content type;
  - serves only files under `design/` in the session cwd (no traversal, no symlink escape);
  - bounds comment length;
  - renders artboards in iframes sandboxed without `allow-same-origin`;
  - stops on `/gentle:design stop` and on session shutdown.
- **S7 Design system sync.** `/gentle:design sync` has the agent read the project's design sources: CSS custom properties, the Tailwind theme, the component library and existing tokens. It writes `design/system.md` (tokens and component rules) and `design/system.html` (tokens rendered as an artboard). Later designs use these files. The canvas shows the system board first when it exists. Before finishing an artboard, the skill checks its colors and fonts against the system tokens and fixes any deviation.
- **S8 Handoff to code.** An "Implement this" action per artboard on the canvas, and `/gentle:design implement <slug>/<artboard>`, send a message to implement that artboard in the project's real stack under ODD. The message uses the artboard as the visual spec, `design/system.md` as the token source, and lists the artboard's open comments from `comments.json` (S9). The handoff never commits on its own.
- **S9 Persistent comments.** From the proposal the user accepted in L8 (option 1):
  - Every comment sent from the canvas is also saved in `design/<slug>/comments.json`, with artboard, selector, excerpt, text, date and status (`open` or `resolved`), so any agent or session can read it.
  - The canvas shows a pin on each commented element, plus a list of open and resolved comments.
  - The agent marks a comment `resolved` when it has applied it.
  - The canvas has two send modes: "Send now" (the S5 behavior) and "Collect", where comments are saved without being sent and a "Send all" button sends them as one batch.
  - The S8 handoff includes the open comments.
- **S10 Link to the ODD feature.** User: "esto del design estaria bueno que quedara ligado al documento de ODD de su feature, si es algo que es chico que quede suelto pero si es algo que surge desde un ODD hacer el link". Acceptance (assumptions marked):
  - A design that comes from a tracked ODD feature records it in `design.json` as an optional `feature` field: the repository-relative path of the feature document, `odd/tasks/<feature>.md`. A design from small, untracked work has no `feature` field and stays standalone.
  - Assumption: the link goes both ways. The skill appends a Log entry to that feature document naming `design/<slug>/` and its artboards, and the canvas shows the linked feature document.
  - Assumption: when an artboard with a `feature` link is handed off (S8), the message says to track the implementation in that feature document instead of sizing it from scratch.
  - The server validates `feature` (a relative `.md` path under `odd/tasks/`); an invalid value is ignored and reported, never served.
- **S11 Natural language by default.** User (L18): "los /gentle:design deberian de poder usarse con lenguaje naturla ahora me obliga tener que ejeuctaros a mano, y cuando se pide un diseño deberia ser por defecto". Acceptance (assumptions marked):
  - Every `/gentle:design` action is reachable by asking in natural language, without typing the command. A `gentle_design` tool gives the model the actions:
    - `list` (the designs);
    - `open` (optional slug; returns the canvas URL);
    - `stop`;
    - `implement` (`<slug>/<artboard>`; returns the same handoff text as the command, which the model then follows).
    - Brief and `sync` are covered by the skill itself.
  - Any request for a UI design, mockup, screen or directions uses the gentle-design flow by default, without naming the skill or the command. This holds for every provider: a short system-prompt hint plus the skill trigger.
  - Assumption: after writing or changing a design, the model opens the canvas on it with the tool by default, or reuses the open one. This does not apply when the user says not to.
- **S12 Canvas focus mode.** User (L18): "dentro del canvas, estaria bueno tener que hacer click en un elemento para que este caputre el mouse, sino el scroll anda raro porque a veces lo hace dentro y otra veces fuera, la forma correcta seria: capturar el mouse, poner en zoom 100% ese canvas como qeu estas utlizando ese diseño realmente para tener el look and feel más próximo a prod, y tener que hacer click en un lugar espcial o combinacion de teclas para salir y volver al modo navegacion". Acceptance (assumptions marked):
  - Navigation mode is the default. In it, the wheel, trackpad and drag ALWAYS pan or zoom the canvas, wherever the pointer is, including over an artboard. No artboard receives the scroll or clicks.
  - Clicking an artboard (outside comment mode) enters focus mode on it:
    - the canvas zooms to exactly 100% and centers that artboard;
    - the artboard captures the mouse and keyboard and behaves like the real page: its own scroll, hovers, clicks, inputs;
    - the rest of the canvas is dimmed and does not pan.
  - Exit back to navigation mode through a visible special control (a "Back to canvas" button) or a key combination. Assumption: `Shift+Esc`, which also works while focus is inside the artboard. Plain `Esc` stays with the design. On exit, the previous zoom and position return.
  - Comment mode keeps working: in comment mode a click picks an element instead of entering focus mode.
- **S15 Implement feedback, live handoff state, and Compare.** From the proposal the user accepted in L28 ("todos me encantaron": all three points). Acceptance (parent design; assumptions marked):
  - Immediate feedback: after "Implement this" is sent, that artboard's header shows a visible badge: **Queued** when the agent was busy (follow-up), **Implementing…** when it was idle. A clear on-screen confirmation is shown, not just the status line.
  - Persisted live state: the handoff state of each artboard (`sent`, `in_progress`, `implemented`, with timestamps, the linked feature document when present, and an optional note) is stored in the design, in `design/<slug>/handoffs.json`, through a single owner module with serialized writes, like comments.json.
    - The agent updates it with the `gentle_design` tool (new `handoff` action: `in_progress` when it starts, `implemented` when it finishes).
    - The handoff message tells the agent to do so.
    - The canvas reflects the state live over SSE, and the badge shows the feature document when the design is linked.
  - Chosen direction (L29): the artboard that was handed off to implement is marked as **the chosen one over the rest**. It gets a visible "Chosen" badge and an accent frame, and the other artboards of that design are labeled as alternatives.
    - Assumption: one chosen artboard per design; handing off another artboard moves the mark.
    - It is persisted with the handoff state.
    - The `gentle_design` `list` action reports it.
    - When the design is linked to an ODD feature, the skill's Log entry names the chosen artboard.
  - Compare: when the agent marks an artboard implemented, it may register the URL of the running app (`previewUrl`). The canvas then offers **Compare**, which shows the artboard and the real implementation side by side at the same size.
    - Assumption: `previewUrl` must be a loopback `http(s)` URL (`localhost`, `127.0.0.1`, `[::1]`, any port), validated by the tool and the server.
    - Assumption: an app that refuses to be framed shows an "Open in new tab" fallback.
    - Assumption: Compare exits with "Back to canvas" / `Shift+Esc`, like focus mode.
- **S14 Refresh the open canvas instead of opening a new tab.** User (L27): "que si se hace un cambio no se abra ded nuevo otra url, sino que refresque la que ya esta". Acceptance (assumptions marked):
  - Assumption: when a canvas page is connected to the running server (its live-reload stream is open), `open` from the command or the tool spawns no browser. The server tells the connected page(s) to show the requested design and refresh. The result says the canvas was refreshed and gives the URL.
  - The browser opens only when no canvas page is connected (none was opened yet, or it was closed), or when the server had to start.
  - File changes keep live-reloading the open page, as today.
- **S13 Automatic first sync and stale warning.** From the proposal the user accepted in L23 (option 1):
  - Case 1: a design is requested, `design/system.md` does not exist, and the project has design sources. The agent runs the design-system sync first, then designs with those tokens.
  - Case 2: the project has no design sources. The agent designs freely, as today.
  - Case 3: `design/system.md` exists, but a source it is based on changed after it. The agent tells the user and offers to sync again, instead of silently using stale tokens.
  - Implementation choice (parent): detection is deterministic. The `gentle_design` `list` action reports the detected design sources and, when `design/system.md` exists, the sources modified after it. The skill and the system-prompt hint tell the agent to check it before designing.

## Tasks

| ID | Specs | Route | Status | Commit / evidence |
|----|-------|-------|--------|-------------------|
| T1 | S1, S2, S3 (`<brief>` and no-args usage) | delegated: context backstop (L4) | done (risk medium: writer self-verification + parent spot check) | `32550812b`; RED 9/9 → GREEN 9/9; parent re-run of focused suites 102/102, `node scripts/check-types.mjs` 0 diagnostics |
| T2 | S1, S3 (`open`, `stop`, no-args open), S4, S5, S6 | delegated: context backstop; Risk item 2 (local HTTP server, security) → own commit and independent verifier | done (risk high: independent verifier, no blockers) | part A + B by one writer (parallel to T1 for part A); RED→GREEN 57/57; two security mutations (realpath containment, POST Origin) caught by tests; parent re-run 94/94, types 0 diagnostics; real-browser proof (ego-browser) 2a-2d, 2f PASS, 2e partial (ego-lite skips `<select>` on Tab, reproduced without app code); defect D1 fixed in `0e6862116` (RED→GREEN 20/20) |
| T3 | S7, S3 (`sync`) | delegated: context backstop | done (risk medium: writer self-verification + parent spot check; new server route goes to the feature-end verifier) | commit `feat(design): sync the project design system into a system board`; RED 9 new → GREEN; parent re-run 113/113, types 0; real-browser proof all PASS |
| T5 | S9 (and the S5 message carries the comment id) | delegated: context backstop; same writer as T2b; Risk item 4 (server and agent write the same comments.json) | done (risk high: independent verifier, no blockers); commit `e8cd68c2b` | RED→GREEN store 9/9, server 28/28, extension 19/19; mutations (store queue, POST Origin) caught; real-browser proof all PASS, plus a toolbar overflow fix at ~950px; parent re-run 116/116, types 0 diagnostics |
| T6 | S11 | delegated: Writer trigger (a) parallel with T7, disjoint surfaces; docs paragraph reported to the parent | done (risk medium: writer self-verification + parent spot check) | commit `feat(design): drive the design flow from natural language`; RED 11/12 → GREEN 46/46; mutation on the child guard caught; focused 149/149, types 0 |
| T7 | S12 | delegated: Writer trigger (a) parallel with T6, disjoint surfaces; docs paragraph reported to the parent | done (risk medium: writer self-verification + real-browser proof + parent spot check) | commit `feat(design): add canvas navigation and focus modes`; RED 0/7 → GREEN 9/9; real-browser a-h PASS, plus the panel auto-hide rows; seam check 204/204, types 0 |
| T9 | S14 | delegated: context backstop (single writer) | done (risk medium: writer self-verification + real-browser proof + parent spot check; independent verifier with T10) | commit `feat(design): refresh the open canvas tab instead of opening a new one`; RED 7 → GREEN 109/109; 2 mutations caught; real-browser a-d PASS; parent seam check 225/225, types 0 |
| T10 | S15 | delegated: context backstop (single writer, after T9: shared canvas/server/lib files); Risk items 2 (canvas CSP frame-src for loopback previews, URL validation) and 4 (handoffs.json writers) → independent verifier over T9+T10 | done (risk high: independent verifier PASS, no blockers) | commit `feat(design): show implement progress, the chosen direction and Compare`; RED → GREEN (store 13, server 57, gentle-design 66, canvas 18); 3 mutations caught; real-browser a-g PASS; parent seam check 266/266, types 0 |
| T8 | S13 | delegated: context backstop (single writer) | done (risk medium: writer self-verification + parent spot check) | commit `feat(design): sync the design system automatically before the first design`; RED 10 failing → GREEN 61/61; parent seam check 217/217, types 0 |
| T4 | S8, S10, S3 (`implement`), and `open` with only the system board (L14) | delegated: context backstop | done (risk high: feature-end independent verifier PASS after one correction) | commit `feat(design): hand artboards off to code and link designs to ODD features`; RED 11 new → GREEN; parent re-run 123/123, types 0; real-browser proof all PASS |

Planned slices (`feature-branch-chain`; push and PR stay with the user): PR1 = T1, PR2 = T2, PR3 = T3 + T4. Forecast: about 1,700 authored changed lines.
Slice boundaries: PR4 = `ba48a22d0` (T6) + the T7 commit; PR1 = `32550812b` (413 lines); PR3 = `49d898da0` (T3) + `81f227e27` (T4) + `8c4ac796b` (verifier correction); PR2 = T2 `23bc81271` + D1 `0e6862116` + T5 `e8cd68c2b` + advisory fix `643c70795`. PR2 exceeds the ~400-line heuristic, because the canvas UI and the security tests are one coherent behavior.

## Log

- **L1** (2026-10-26) User: "ok quiero que lo revises bien, y planifiquemos como podriamos dar eso sin tener que pasr por claude, desde gentle shell directo por nosotros sin necesidad de usar dicho proveedor"
- **L2** (2026-10-26) Research (support.claude.com/en/articles/14604416, claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html, andrew.ooo/answers/claude-code-design-command-artboards-august-2026). `/design` has four parts: design guidance, an artboard canvas on Anthropic's Artifacts runtime, `/design-sync`, and handoff to code. Only the canvas hosting is provider-bound. Plan proposed: Phase 1 skill and command, Phase 2 local canvas with comments, Phase 3 design system, Phase 4 handoff. Canvas options: (1) build it ourselves, (2) use OpenPencil.
- **L3** (2026-10-26) User: "1" (build the canvas ourselves).
- **L4** (2026-10-26) The runtime context backstop fired before the first write, so every task runs in a bounded writer with a short handoff. Pi API facts: `pi.sendUserMessage(content, { deliverAs: "steer" | "followUp" })`; skills are invocable as `/skill:<name>`; extensions register with `pi.registerCommand`; package files are listed in `scripts/verify-package-files.mjs`.
- **L5** (2026-10-26) T1 landed in `32550812b`. `sendUserMessage` expands `/skill:<name>` only with `expandPromptTemplates: true` and only when the skill is loaded (`pi.getCommands()` lists `skill:gentle-design`); otherwise the command points the model at the bundled SKILL.md path. The palette entry goes in Session. The parent made the test scratch dirs clean themselves.
- **L6** (2026-10-26) T2 is in `23bc81271`. Native assess says `reviewDue: true` (high: process boundary in `lib/design-open-browser.ts`). The real-browser proof found D1: Chromium sends `Origin: null` for subresources of sandboxed artboards, so the server's 403 meant `inspector.js` never ran. Fixed in `0e6862116`: GET accepts `Origin: null` only for `files/` and `assets/inspector.js`, and every POST still needs the exact own Origin. The native review START waits for the user's answer about comment persistence (S9 proposal).
- **L7** (2026-10-26) User: "pero como se usan los comentarios ? quien los lee ? son para dar input al agente par que este haga las mejoras luego de los mismos ? se puede exportar en un archivo que luego lo puede usar otro agente ? etc"
- **L8** (2026-10-26) User: "lo agregamos dale, el 1". This accepts the S9 proposal: comments.json with states, pins, a Collect mode with "Send all", and open comments in the handoff. S8 was rewritten to add the open comments. T5 was added before the T2 native review, so one review covers T2 + D1 + T5 (base `32550812b`).
- **L9** (2026-10-26) T5 is done. Under the session's delivery permission the parent decided: the send mode stays in localStorage (it lasts while that server runs, as documented), and the agent resolves comments through the `gentle_design_comments` tool. Hand edits of comments.json are last-rename-wins, but they never corrupt the file.
- **L10** (2026-10-26) T5 landed in `e8cd68c2b`. Native review START of PR2 (`32550812b..HEAD`, 3845 lines, lenses risk/resilience/reliability) refused at preflight with `lens_context_budget_exceeded`. No authority was created, so there was nothing to abandon. Splitting it would have meant rewriting branch history, so the parent followed the documented RDD-off path for a refused START: native tier high → an independent `gentle-ai-verify` over `32550812b..HEAD` (items 2 and 4). T3 waits until the verifier finishes, so its test runs see a stable tree.
- **L11** (2026-10-26) The independent verifier found no blockers. S1, S3 (open/stop/no-args), S4, S5, S6 and S9 PASS. It re-ran 116/116 and types 0. Probes: security 107/108, lifecycle 22/23 (that FAIL was a probe bug, re-verified PASS), opener 18/18. Advisories, and what we do with each:
  - (1) send-now racing send-all can deliver twice → fix.
  - (2) excerpt truncation is by code points in the server but by UTF-16 length in the store → fix.
  - (3) async `sendUserMessage` failures are invisible, because Pi returns void → accept and document.
  - (4) a canvas opened via `localhost` gets 403 on every POST → fix: accept its own localhost origin as well.
  - (5) the README row does not name `stop` → fold into T3/T4 docs.
  - (6) `xdg-open` resolves through PATH → accept (`shell:false`).
  - (7) an artboard script can forge `gd:pick` → accept: the user still writes and sends the comment.
  - (8) the symlinked-design listing differs between the server and the command → fix: one shared listing.
  The parent removed the verifier scratch.
- **L12** (2026-10-26) Advisories 1, 2, 4 and 8 fixed test-first in `fix(design): close PR2 verifier advisories`, with RED→GREEN for each; advisory 3 is documented. Parent re-run 104/104, types 0. The fix touches the POST Origin set (item 2), so the feature-end independent verifier covers it together with T3 and T4.
- **L13** (2026-10-26) User: "una cosa mas, chiquita, esto del design estaria bueno que quedara ligado al documento de ODD de su feature, si es algo que es chico que quede suelto pero si es algo que surge desde un ODD hacer el link". Added as S10 and assigned to T4.
- **L14** (2026-10-26) T3 done. Parent decisions: the system board keeps a fixed 1200 px height and scrolls inside its iframe. `open` must also work when only `design/system.html` exists (folded into T4).
- **L15** (2026-10-26) T4 done. The command and the canvas Implement route share `planDesignImplement`, so both send identical text. Feature-end verification launched over `e8cd68c2b..HEAD` (advisory fix, T3, T4), together with the full suite.
- **L16** (2026-10-26) Full suite results:
  - `node scripts/run-test-suite.mjs` at HEAD `81f227e27`: unit-tests 7515 tests, 151 unique failing names, none design-related.
  - The same suite at the base `origin/main` `9f29f16f1`, in a scratch worktree with the same symlinked node_modules: the identical 151 failing names (`comm` shows 0 only-in-feature, 0 only-in-base). These failures are environmental or pre-existing, not regressions.
  - The provider-contract and runtime-harness stages failed in both runs before they ran, because pnpm's deps check aborted (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, symlinked node_modules). Run directly, `node scripts/check-provider-contract.mjs` exits 0 (contract 1.4.0) and `node --experimental-strip-types tests/runtime-harness.mjs` exits 0.
- **L17** (2026-10-26) Feature-end independent verifier over `e8cd68c2b..HEAD`. It re-ran 139/139 and types 0. S7, S8, S10, S3 sync/implement, L14, advisories 1/2/4/8 and the S6 recheck all PASS. Probes: security 246/246, concurrency 23/23, handoff byte-identity 34/34, and baseline sensitivity 0/3 at base vs 3/3 at HEAD. Blocker B1: in T4, `open <slug>` with no designs changed its message nobody asked to change (`lib/gentle-design.ts:230`). One correction batch by the parent:
  - B1 restored the baseline text and pinned it.
  - A1: `sync` with extra words now warns and sends nothing (instead of ignoring them).
  - A2: `implement` reports an invalid `feature` link as a warning.
  - A3 (a nonexistent feature document is not checked) is accepted.
  - RED 3 → GREEN; focused suites 143/143; types 0.
  The recheck is limited to B1: the new test asserts `open foo` and `open` give identical notices.
- **L18** (2026-10-26) User: "varias cosas: 1- los /gentle:design deberian de poder usarse con lenguaje naturla ahora me obliga tener que ejeuctaros a mano, y cuando se pide un diseño deberia ser por defecto 2- dentro del canvas, estaria bueno tener que hacer click en un elemento para que este caputre el mouse, sino el scroll anda raro porque a veces lo hace dentro y otra veces fuera, la forma correcta seria: capturar el mouse, poner en zoom 100% ese canvas como qeu estas utlizando ese diseño realmente para tener el look and feel más próximo a prod, y tener que hacer click en un lugar espcial o combinacion de teclas para salir y volver al modo navegacion". Added S11 → T6 and S12 → T7, launched in parallel with disjoint edit surfaces; the parent owns docs/gentle-shell.md and README.md.
- **L19** (2026-10-26) T6 done. The hint is injected with `appendSystemPromptOnce` in `before_agent_start` (the gentle-todo pattern) and skipped when `GENTLE_PI_AGENTS_CHILD=1`. The parent decided:
  - not to also skip in-process named agents: `isNamedAgentStartEvent` is private to extensions/gentle-ai.ts, and the delegated children are already excluded by the env marker;
  - not to re-add `/gentle:design` to the skill description.
  The writer briefly copied extensions/gentle-design.ts to /tmp for a mutation check, restored it, and removed the copy (reported).
- **L20** (2026-10-26) T7 is implemented. Navigation shields, focus at 100%, Shift+Esc / "Back to canvas", and comment mode in both modes. RED 0/7 → GREEN 8/8 in tests/design-canvas-assets.test.ts; a mutation on the exit-focus source check was caught; real-browser a-h PASS. Parent decisions:
  - an artboard wider than the viewport keeps its designed width at 100%, and focus auto-hides the comments panel, restoring it on exit (follow-up running);
  - pins re-rendering under a continuously mutating artboard DOM predates T7 and is recorded as a follow-up, out of scope.
  The writer put scratch under ~/work/gentle-pi-scratch (outside the project); the parent removed it and told the writer to use only `mktemp -d` under the system temp dir.
- **L21** (2026-10-26) T7 follow-up done:
  - Focus hides the comments panel and restores it on exit.
  - centerFocus measures with layout offsets, which fixes a 1 px re-center drift seen in the browser.
  - A failed `mktemp` in the writer's shell left `~/server.out` and `~/server.pid`, from a server that never started. The parent inspected and removed both, plus the writer's scratch.
  - Seam check over every design test file: 204/204, types 0, syntax ok.
  - Follow-up recorded, not done: pins re-render on every MutationObserver report, which detaches them under a continuously mutating artboard DOM. This was already the case before T7.
- **L22** (2026-10-26) User: "pr y merge". The PR was being prepared (no remote action taken yet) when the user asked L23.
- **L23** (2026-10-26) User: "como seria el design con sync ? cuando decide el agente de que lo use?". The parent explained that today the agent never runs sync on its own, and proposed an automatic first sync plus a stale warning. User: "1" (add it before the PR). Added S13 → T8; PR and merge (L22) continue after T8.
- **L24** (2026-10-26) T8 done. Only the root `design/` is skipped by the source walk, because nested `design/` dirs may hold real sources (accepted).
  Delivery for L22 ("pr y merge", singular): ONE PR with the whole branch, not the feature-branch chain. Facts that support it:
  - the target is Gentleman-Programming/gentle-shell, default branch main, 0 commits behind;
  - `main` is unprotected and the viewer is ADMIN;
  - no CI size gate exists, and recent merged PRs carry no size label.
  The PR body lists the per-slice commits as a review guide. Merge only on green required CI.
- **L25** (2026-10-26) RDD assess of `e5a06f923..1d337314c` (T6-T8): medium, `reviewDue: false` (under budget), so the writers' self-verification stands. A privacy scan of the branch diff found no personal paths. Issue #2561 created and labeled `status:approved`. Branch pushed. PR #2562 opened (`type:feature`, `Closes #2561`). Waiting on CI.
- **L26** (2026-10-26) The CI on `b4e479d47` was all green. CodeRabbit posted 4 actionable comments; the parent acted on 3 of them, test-first (RED 2 → GREEN; focused 219/219; types 0):
  - Fixed: `TOKEN_FILE` matched auth and tokenizer files, which would have triggered the automatic sync. It now requires `tokens` as a whole word and excludes test files.
  - Fixed: `truncateUtf16` left a lone high surrogate when the canvas had already cut at 300 units; it now strips a trailing high surrogate at any length.
  - Done: the 256 KiB read buffer is now reused.
  - Deferred as a follow-up: consolidating the duplicated path validators of the server and the store. It is a refactor of security code, and the current differences are deliberate (the server maps EACCES to 404).
- **L27** (2026-10-26) User: "una cosa!!! que si se hace un cambio no se abra ded nuevo otra url, sino que refresque la que ya esta". The merge is on hold. Added S14 → T9, into the same PR #2562.
- **L28** (2026-10-26) User: "una cosa mas, que tendria que pasar al hacer \"implement this\" ? lo manda y que ? no se ve nada en el canvas". The parent explained that today only a status line appears, and proposed (1) immediate feedback, (2) persisted live handoff state, and (3) Compare. User: "todos me encantaron". Added S15 → T10 (after T9), in the same PR #2562.
- **L29** (2026-10-26) User: "tambien hay que señalar cual es el que se eligio sobre el resto". Folded into S15 (the chosen direction) and T10.
- **L30** (2026-10-26) T10 done. The writer decided, and the parent accepted, that the command and the tool `implement` also record the handoff, so Chosen moves on every path.
  Browser facts:
  - Chromium ignores `[::1]` in a CSP `frame-src`, because CSP has no IPv6 literal form. The parent keeps `[::1]` accepted: the canvas says it cannot frame it and offers "Open in new tab", and the docs recommend localhost.
  - Chrome fires `load` even on a frame blocked by X-Frame-Options, so the "Open in new tab" fallback is always visible.
  User (L31 below) asked for PR and merge once everything is fine.
- **L31** (2026-10-26) User: "pr y merge cuando puedas y quede todo bien ;)".
- **L32** (2026-10-26) Independent verifier over `c21d8ddf2..4d6f6dece` (T9+T10): no blockers. It re-ran 212/212 and types 0. S14, S15 (immediate, persisted, handoff, previewUrl, CSP and Compare escape, message sources, concurrency, invalid/symlink file), Chosen, the S6 recheck and the S9 recheck (identical to baseline) all PASS. Probes 260/262: the 2 FAILs are 404 instead of 422 for a symlinked/dir handoffs.json, which is safe. Advisories, all accepted:
  - (1) a symlinked handoffs.json answers 404 `not-found`, the same as comments.json at the baseline;
  - (2) a same-millisecond identical-entry collision in `revertSent`, reproducible only with a fixed clock;
  - (3) canvas `previewTarget` normalizes whitespace (the server validates);
  - (4) two Pi processes: last rename wins (L9);
  - (5) any token holder counts as connected for S14;
  - (6) Chromium ignores `[::1]` in frame-src (L30).
  The parent removed the verifier scratch. Next: push, CI, merge (L31).
- **L33** (2026-10-26) CI on `02817ee71` was all green (verify, installer ×3, review-repository-windows, session-transport-macos, test ×2, CodeRabbit), and the PR was MERGEABLE CLEAN. CodeRabbit raised 1 new Minor: `/implement` dropped the refusal reason when `onImplement` throws, so the canvas showed only `delivery-failed`. Fixed test-first (RED 1 → GREEN; focused 266/266; types 0). The reason now reaches the response, and the identity check that routes store errors through `handoffFailure` is kept.
