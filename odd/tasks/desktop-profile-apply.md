# Desktop RPC profile apply

Adds a `gentle-shell.desktop-rpc/v1` method that applies a saved profile through the exact
`/gentle:profiles` apply path, and switches Gentle Desktop's "Make default" to it.

## Specs

- S1: "Agregar después al canal Desktop un método de aplicación que reuse el mismo apply de Shell, y que Desktop lo use en vez de escribir archivos para \"Make default\"."
- S2: "Implemento el método RPC para aplicar perfiles (Shell + Desktop), con PRs y merge tras CI verde."
- S3 (from the explored apply path, behavior to preserve): Make default asks the human before writing global routing whenever the screen would ask (`Apply profile "<name>"?`, `Apply empty profile?`, `Apply orchestrator-only profile?`); declining writes nothing; pinned repositories and no-op applies do not ask. Over RPC the confirmation is the same title and message, shown by Desktop, and an apply only proceeds with a confirmation token bound to that exact text.
- S4: "Use in this session" binds the saved profile to the RPC session through the same path, writing nothing shared.
- S5: the `/gentle:profiles` screen behavior is unchanged.

## Tasks

- T1 [S1,S3,S4,S5] Shell: owner seam in `extensions/gentle-ai.ts` running `runProfilesPanelAction` with a recording UI adapter; Desktop bridge + `apply_profile` method, `profile_applied` event, docs, tests. Route: inline (parent), independent verify (Risk items 1, 3). Commit: pending.
- T2 [S2] Shell PR, CI green, CodeRabbit valid findings resolved, merge. Commit: pending.
- T3 [S1,S2] Desktop (decode2/gentle-shell-gpui): Make default and Use in this session call `apply_profile` with the confirmation dialog; tests; PR and merge. Commit: pending.

## Log

- L1: "ok dale" in answer to: "¿Querés que prepare la pieza 2, o que deje un comentario en #2606 explicando cómo encaja con lo que ya está mergeado?" Then selected "Ambas": "Comento en #2606 cómo encaja con lo mergeado y después implemento el método RPC para aplicar perfiles (Shell + Desktop), con PRs y merge tras CI verde."
- L2: #2606 comment posted (issuecomment-6867268353).
- L3: Decision: no refactor of apply-global. The bridge runs the screen's own `runProfilesPanelAction` with a UI adapter whose `confirm` returns true only for a token matching the exact title+message it is asked; otherwise it returns false (screen semantics: no writes) and the request answers `confirmation_required` with that text.
