# Context backstop as a model-agnostic runtime signal

Objective: the parent-context backstop that tells the orchestrator to delegate becomes a measured, model-agnostic
runtime signal instead of a fixed "~150k tokens" estimate in prompt text. Branch `feat/harness-r1-runtime-checks`
(harness roadmap R1, same single PR). Runner: `pnpm test`.

## Specs

- S1 (user, verbatim): "vamos a implementar también los cambios, si te parece bien, que me propusiste para mejorar cómo
  está escrita. Tenemos que pensar en soluciones más genéricas, soluciones que sean para cualquier modelo, no algo que
  es solamente para Sol o solamente para OpenAI."
- S2 Generic threshold: the backstop is `min(absolute cap, fraction x model context window)`, with the window taken
  from Pi's `ctx.getContextUsage()` (`contextWindow`), defaults absolute cap 150,000 tokens and fraction 0.5, both
  overridable by environment (names documented); no provider names, prices, or pricing tiers in the code. Rationale to
  document: carried context is paid on every remaining turn by any provider (absolute cap); quality and headroom depend
  on how full the window is (fraction). Unknown tokens (null, e.g. right after compaction) never count as reached.
- S3 Runtime signal: in the primary session only, when the measured parent context first reaches the backstop, the
  runtime appends one notice to the next tool result: measured tokens, percent of the window, the threshold, and the
  instruction to delegate the next bounded unit that needs several steps (its reads, edits, and checks) with a short
  handoff, while single small edits and state checks stay inline. Once per crossing; re-armed when the context drops
  below the threshold (for example after compaction). Children never get it. Tool output and structured content are
  kept.
- S4 Same rule everywhere: the writer admission check (`lib/bounded-writer-admission.ts`,
  `WRITER_CONTEXT_BACKSTOP_TOKENS`) uses the same threshold function and the measured window, not a separate constant.
- S5 Prompt text: `assets/orchestrator.md` (Context backstop), `assets/orchestrator-delegation.md` (item 7), and
  `assets/orchestrator-delegation-reference.md` (item 4) stop stating "~150k tokens"; they say the runtime signals the
  context backstop and that only a unit needing several steps is worth delegating. Module byte budgets still hold.
  Help/docs (`docs/readme-reference.md`) describe the signal, the formula, and the environment overrides.

## Tasks

| ID | Specs | Work | Route | Status |
|---|---|---|---|---|
| T1 | S1-S5 | threshold function, runtime notice, admission, prompt text, docs, tests | delegated (context backstop: parent session is past it) | done (commit `feat(context): signal the parent context backstop from measured usage`) |

## Log

- L1 (user, 2026-10-15): "OK, haz todo eso que te falta, pero vamos a implementar también los cambios, si te parece
  bien, que me propusiste para mejorar cómo está escrita. Tenemos que pensar en soluciones más genéricas, soluciones
  que sean para cualquier modelo, no algo que es solamente para Sol o solamente para OpenAI." Proposal it refers to:
  (1) runtime-measured signal instead of a prompt estimate; (2) threshold that depends on the model; (3) delegate only
  units heavy enough to repay a subagent start. Parent decision for genericity: no prices or provider tiers, only the
  model's context window from Pi plus an absolute cap.
- L2 (writer, 2026-10-15, T1): `lib/context-backstop.ts` holds the threshold `min(cap, fraction x window)` (defaults
  150,000 and 0.5; `GENTLE_PI_CONTEXT_BACKSTOP_TOKENS`, `GENTLE_PI_CONTEXT_BACKSTOP_FRACTION`; invalid values keep the
  defaults; unknown window leaves the cap; null tokens never reach it) and the once-per-crossing signal keyed by
  session. The primary `tool_result` handler appends the notice after the commit slice line (content first, structured
  content kept, `isError` untouched); children and in-process named-agent turns never get it. The writer admission
  takes `contextUsage` (tokens and window) plus the session env and calls the same threshold;
  `WRITER_CONTEXT_BACKSTOP_TOKENS` is gone. Prompt modules defer to "when the runtime signals it" and "several steps";
  core and delegation card stay within their byte budgets (9100 B rendered, 7300 B card). The canon fixture keeps
  "~150k"; only the Pi-side anchor of the "long-session backstop" ratchet entry changed. Evidence: RED observed (6
  behavior failures in `tests/context-backstop.test.ts` and `tests/writer-feature-document-admission.test.ts`), then
  GREEN; `pnpm test` all three stages passed (6867 tests, 0 failed); `pnpm -s typecheck` clean. Differential admission,
  HEAD vs after, writer without a feature document: 100k/400k blocked/blocked; 200k/1M admitted/admitted; 64k/128k
  blocked/admitted (intended by S2/S4: a small window reaches the backstop at half its size). Follow-up outside this
  task's surfaces: `skills/gentle-ai/SKILL.md:50` still states "~150k tokens".
