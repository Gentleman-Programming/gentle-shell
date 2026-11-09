# Deliver the gentle-design canvas work as 3-4 PRs

Consolidate everything on feat/canvas-layout into at most four reviewable PRs against upstream main, without conflicts between them.
Branch feat/canvas-consolidated (from feat/canvas-layout). Upstream: Gentleman-Programming/gentle-shell; fork origin: doblas/gentle-shell (no push to upstream, so PRs come from the fork).

## Specs

- S1: "como podríamos subir todos los cambios de gentle-design en 3 o 4 PRs máximo intentando facilitar la revisión y evitando conflictos entre ramas a la hora de mergear" (L1). At most four PRs, each owning files no other PR touches, merged in a stated order.
- S2: "en cada pr nombra al maintener https://github.com/egdev6 para que revise todo" (L2). Every PR body names @egdev6 as the reviewer.
- S3: Choice "3-4 PRs, without overlay/slider, announced in #2740" (L3). The Compare overlay and slider go away (the maintainer asked to drop them in #2740); side-by-side Compare stays.
- S4: Same choice (L3). The PRs stack on top of #2793 (it stays first), and a comment on #2740 explains the consolidation and links the PRs.
- S5: The PRs carry upstream main's own changes to the shared files (no reverts of upstream work), and each PR's suites and the typecheck pass on its own branch.

## Tasks

- T1 [S5] Merge upstream/main into feat/canvas-consolidated and resolve conflicts; design suites and typecheck. Route: inline. Done: 67aeb6419 (635/635 in the design suites, typecheck clean; upstream #2871 pan tests split into pan on the background and move on an artboard; agent-home.test.ts equals upstream, so no fourth PR).
- T2 [S3] Remove the Compare overlay and slider (canvas, strings, styles, tests, docs). Route: gentle-ai-worker. Done: 016e3ec90 on feat/canvas-consolidated (619/619 design suites without agent-home, typecheck clean; 9 mode-only tests removed, 1 S3 test added).
- T3 [S1, S4, S5] Build the PR branches from upstream/main (server and data; canvas frontend on top of #2793; design artifacts and ODD records) and run each one's suites. Route: inline. Done: feat/design-canvas-server (4 commits, each green: 233, 243, 270, 288 design tests; typecheck clean), feat/design-canvas-frontend (merges #2793 then f7607e82d; 630/630 with agent-home, typecheck clean), docs/design-canvas-directions (design directions, system board and these records). #2793 merged into the integration branch at d23def1fc. Stale text fixed on the way: the comment-resolve note no longer mentions a version, the docs no longer mention the Original request tab, .gitignore no longer lists design/*/.history/.
- T4 [S1, S2, S4] Push the branches to the fork, open the PRs naming @egdev6, comment on #2740. Route: inline. Done: #3044 (server and data), #3045 (canvas, stacked on #2793 and #3044), #3046 (design records); each body names @egdev6 (requesting the review failed: the fork account lacks permission, and adding labels does too); comment on #2740 links all three.

## Log

- L1: "los nuevos cambios y todo lo que tenemos en esta rama de gentle-design(hazme un resumen para asegurar) como podríamos subir todos los cambios de gentle-design en 3 o 4 PRs máximo intentando facilitar la revisión y evitando conflictos entre ramas a la hora de mergear"
- L2: "adelante pues, en cada pr nombra al maintener https://github.com/egdev6 para que revise todo"
- L3: Chose "3-4 PRs, without overlay/slider, announced in #2740 (recommended)".
- L4: Evidence: origin/main is the fork's main, 424 commits behind upstream/main (dd4398166); upstream changed canvas.js, canvas.css, lib/gentle-design.ts, skills/design/SKILL.md, docs/gentle-shell.md, README.md, the canvas and gentle-design tests and agent-home.test.ts since then. #2793 is open, mergeable, CI green, not in this branch. upstream already isolates GENTLE_SHELL_CONFIG_HOME in tests, so the agent-home fix likely needs no PR.
- L5: Delivery layout: PR A feat/design-canvas-server (lib, extension, their tests, design/system.md), PR B feat/design-canvas-frontend (stacked on PR A and #2793: assets/design-canvas, its test, docs, README, skill), PR C docs/design-canvas-directions (design/** except system.md, odd/tasks records, .gitignore), all against upstream main from the fork, merge order #2793, A, B, C. File sets are disjoint.
