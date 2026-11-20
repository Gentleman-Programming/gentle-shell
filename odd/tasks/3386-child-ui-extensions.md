# 3386 child UI-only extensions

Subagent (child) sessions stop running UI-only entrypoints, and unknown agent frontmatter keys are warned about (gentle-shell#3386, Phase 2 only).
Branch `feat/3386-child-ui-extensions` from origin/main 21c73c134.

## Specs

- S1. In a child session, the UI-only entrypoints do nothing: `startup-banner`, `gentle-music`, `gentle-star-prompt`, `gentle-tps` (issue Phase 2 table: "UI-only: GS-owned child profile (phase 2)" — "startup-banner, gentle-music, gentle-star-prompt, gentle-tps"). Default-on (user decision: "Solo la Fase 2 mínima (recomendado)": "Los subagentes dejan de cargar por defecto las extensiones que son solo UI (banner, música, star prompt, TPS). Son ~40-80 líneas, sin config nueva."). No new config file, flag, or state.
- S2. Implementation choice: prefer the existing child-detection guard pattern already used by `startup-banner` (returns in a child) or by `gentle-voice`, applied at registration in each of the four entrypoints, over passing per-file extension paths (issue §(e): per-file loading drops the package's themes/prompts/skills manifest resources). Must-run child behavior stays untouched (issue: "the `tool_call` guardrails, the review relay handshake and review tools, session-change capture, `subagent_parent_message`, Gentle Shell's own codegraph tools, the nan provider, and child-context and child-safety").
- S3. `gentle-star-prompt` no longer counts or persists inputs from a child session (issue: "`gentle-star-prompt`'s `input` hook counts and persists `rpc` inputs ... so a child may currently alter that counter").
- S4. Parent (non-child) sessions behave exactly as before for all four entrypoints (one test each proving the previous behavior still holds).
- S5. Unknown keys in a subagent definition's frontmatter produce a warning naming the key and the file (issue: "rejecting (or at least warning about) unknown frontmatter keys is cheap and removes the whole class of silent misconfiguration"; example key `extensions:`). Warning only, the agent still loads. Use the existing notice/warning channel of the agents config loader (`lib/agents-config.ts`).
- S6. Docs that describe child sessions / agent frontmatter are updated (grep docs/ for frontmatter keys and #1690 child fidelity).

## Tasks

- T1 (S1-S6) — worker — commit: pending (changes ready in the worktree, uncommitted: the worker may not stage or commit; parent commits with "Fixes #3386")

## Log

- L1 (user): "agrega a la lista: https://github.com/Gentleman-Programming/gentle-shell/issues/3361, https://github.com/Gentleman-Programming/gentle-shell/issues/3386, https://github.com/Gentleman-Programming/gentle-shell/issues/2909, https://github.com/Gentleman-Programming/gentle-shell/issues/3401"
- L2 (user decision): Phase 2 minimal, default-on, plus unknown-frontmatter warning; no Phase 1 allow/deny file.
- L3: explorer: `childArguments` in `lib/agents-runner.ts:377` only gets host `extensionPaths`/`noExtensions`; frontmatter parsing in `lib/agents-config.ts:~128` drops unknown keys silently. No open PR.
- L4 (worker T1): RED observed (6 fails: S1x4, S3, S5; S4 tests passed as PRESERVE), then GREEN. Guard `isChildSession()` in new `lib/child-session.ts` (same `GENTLE_PI_AGENTS_CHILD==="1"` check as startup-banner/gentle-voice), applied at registration in the 4 entrypoints. S5: `unknownFrontmatterKeys` + notice in `discoverAgents`. S6: docs/gentle-shell.md. Focused + 102 related test files, run without inherited child env: 3205 tests; remaining fails (session-profile A3 x2) also fail at baseline (git archive HEAD); child-jobs P-C and skill-registry watcher failed only under load, pass in isolation. `tests/startup-banner.test.ts` child test now calls `start?.` since a child registers no hooks.
