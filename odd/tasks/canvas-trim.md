# Trim the design canvas

Remove surfaces of the gentle-design canvas the user does not want. First batch of several changes ("para empezar").
Branch feat/canvas-trim (from feat/canvas-implement-part).

## Specs

- S1: "la opcion de lista que abre el menu lateral a la izquierda eliminarlo por completo" (L1). The rail's direction-list button, the left direction list (`gd-nav`), its `[` shortcut, strings, styles, tests and docs go away.
- S2: "Las bolitas del header de comparar revisar elegir e implementar fuera tambien" (L1). The step breadcrumb in the top bar (`gd-steps`) goes away, with its strings, styles, tests and docs.
- S3: "La parte de historial ... fuera tambien" (L1), "Por completo" (L2). History goes away entirely: the panel view and its More entry, version compare and restore in the canvas, the server routes and events, `lib/design-history.ts`, its tests and docs.
- S4: "La parte de ... mezcla ... fuera tambien" (L1), "Por completo" (L2). Mix goes away entirely: the Mix tab, the popover's Add to the mix / Show mix, the server `mix` route, the session message for it, its tests and docs.
- S5: "La parte de ... peticion original fuera tambien" (L1). The Original request view of the review panel and its More entry go away.
- S6: Everything else keeps working as it does today (comments, checks, Implement, Implement only this, Try another direction, compare, export, language).

## Tasks

- T1 [S1, S2, S6] Remove the direction list and the step breadcrumb. Route: gentle-ai-worker (evidence budget). Done: 583d9bec4 (549/549 design suites, typecheck clean).
- T2 [S3, S5, S6] Remove History and Original request (canvas, server, lib, tests, docs). Route: gentle-ai-worker. Done: e6a2294e9 (523/523 in 5 suites, typecheck clean; lib/design-history.ts and its test deleted).
- T3 [S4, S6] Remove Mix (canvas, server, tool message, tests, docs). Route: gentle-ai-worker. Done: 6bbbc7583 (508/508 in 6 suites, typecheck clean).
- T4 [S6] Docs, README, skill; browser check; gentle-design suites and typecheck. Route: inline. Done: docs in T1-T3 commits; 524/524 in 8 design suites, typecheck clean; Chrome 1440 (es): no removed ids, tabs Comentarios and Calidad, Implement only this present, 7 artboards, only console error a 404.

## Log

- L1 (user, 2026-11-05): "vale, pues quiero hacer bastantes cambios. para empezar la opcion de lista que abre el menu lateral a la izquierda eliminarlo por completo. Las bolitas del header de comparar revisar elegir e implementar fuera tambien. La parte de historial mezcla y peticion original fuera tambien."
- L3 (T1): the help card kept its own four-step list (`guide.step.*`); help targets building/done now point at the top-bar status or Compare with app. Slice boundary: this feature's commits are counted from 583d9bec4's parent; the branch total includes the unmerged canvas stack.
- L2 (user, 2026-11-05, scope question for History and Mix): "Por completo (Recomendado)": remove the UI, the popover buttons, the server routes, design-history.ts, its tests and the docs.
