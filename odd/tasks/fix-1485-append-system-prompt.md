# Fix #1485: deliver the harness through systemPromptOptions

## Objective

Make the Gentle Pi harness (ODD workflow, identity, persona, review contract, RDD status, research block) and the Gentle Todo open-tasks block reach the model on every provider, including `pi-claude-bridge`.

## Problem

`extensions/gentle-ai.ts` and `extensions/gentle-todo.ts` inject text by returning `{ systemPrompt: event.systemPrompt + ... }` from `before_agent_start`. `pi-claude-bridge` 0.8.0 forwards only the structured `systemPromptOptions` parts (context files, skills, `customPrompt`, `appendSystemPrompt`) after the Claude Code preset, so the returned prompt is silently dropped. Observed: the visible TODO is never updated, ODD phase labels never appear, and RDD consent is relayed as chat text (gentle-shell #1485).

## Why

Pi documents this route (`docs/extensions.md:101`: "Prefer changing prompt sections ... Returning `systemPrompt` ... replaces the whole prompt"). After `before_agent_start`, Pi rebuilds the prompt from the mutated `result.systemPromptOptions` (`agent-session.js` `_preparePromptAndToolLoadout`). A probe in #1485 shows text appended to `systemPromptOptions.appendSystemPrompt` reaches Claude Code through the bridge.

## Scope

- Move the gentle-ai injection from the returned `systemPrompt` to `event.systemPromptOptions.appendSystemPrompt`, idempotently.
- Same for the gentle-todo open-tasks block.
- Tests and docs.

## Constraints

- Behavior for non-bridge providers must stay equivalent: same text, same primary-session scoping, no duplication across turns or handlers.
- Do not break other `before_agent_start` handlers or existing prompt tests.
- Technical artifacts in English.
- Out of scope: the superseded `feat/bridge-instructions` branch (kept, unpublished); the stale `gentle-ai` skill (#1085); the dangling `APPEND_SYSTEM.md` symlink left by a gentle-ai test.

## Tasks

- [x] T1 gentle-ai harness through `appendSystemPrompt`, with tests. Route: delegated (writer; 4+ files to understand). Shared idempotent helper `lib/append-system-prompt.ts`. `tests/telemetry-trigger.test.ts` and `tests/runtime-harness.mjs` asserted the removed return shape and were updated to the new contract (scope extended by the parent; required consequence, not new behavior). Commit `13d6a3d24`.
- [x] T2 gentle-todo block through `appendSystemPrompt`, with tests, plus a cross-extension ordering test. Route: delegated (same writer). Commit `c1589327c`.
- [x] T3 Docs (`docs/gentle-shell.md`; `docs/review-integration.md` is a byte-pinned contract artifact and was restored after CI `verify` caught the drift). Route: delegated (same writer). Commit: the docs commit that carries this document update.
- [x] T4 Live verification under `claude-bridge`. Route: inline (parent). See evidence.

## Acceptance criteria

- The harness and the todo block appear in `systemPromptOptions.appendSystemPrompt` for primary sessions and reach a `claude-bridge` model.
- Non-bridge providers still receive the same harness exactly once per turn.
- No handler returns a whole replacement `systemPrompt` for this purpose any more.

## Checks

- Focused tests, unit stage of `node scripts/run-test-suite.mjs`, `node scripts/check-provider-contract.mjs`, `node --experimental-strip-types tests/runtime-harness.mjs`, `node scripts/check-types.mjs`.

## Delivery

- Strategy: `ask-on-risk`. Forecast: about 200–400 authored changed lines.
- RDD: on (global).
- PR: `Closes #1485`, `type:bug`.

## Progress

- Worktree: `../gentle-pi-worktrees/1485-append-system-prompt`, branch `fix/1485-bridge-append-system-prompt` from `origin/main` (cedc69e08).

## Runner semantics (confirmed by the writer)

- `dist/core/extensions/runner.js` `emitBeforeAgentStart` builds one normalized `systemPromptOptions` per emission and passes the same object to every handler in registration order, so later handlers see earlier appends.
- `dist/core/agent-session.js` emits from the stable `_baseSystemPromptOptions`, so appends never accumulate across turns.
- `dist/core/system-prompt.js` renders `appendSystemPrompt` as the final `addendum` section.
- No other package handler returns a replacement `systemPrompt`.

## Verification evidence

- `node --experimental-strip-types --test tests/*.test.ts`: 3876 pass, 0 fail, 43 skipped (pre-existing Windows-native skips).
- `node --experimental-strip-types tests/runtime-harness.mjs`: exit 0 (writer and parent).
- Focused files (helper, route, review contract prompt, todo, telemetry): 42 pass, 0 fail (parent re-run).
- `node scripts/check-provider-contract.mjs`: pass. `node scripts/check-types.mjs`: no regressions.
- Live, `gentle-shell -p --no-session --model claude-bridge/claude-opus-5-5`, asked whether the instructions contain "Default workflow: Organic Driven Development": this branch answered yes; the installed package answered no. With `openai-codex/gpt-5.5` on this branch, the phrase is present exactly once.

## Review

- `cedc69e08..c85dc1362`: medium, 483 lines; lineage `review-c6da780bb242bf6e`, one lens (reliability), approved and acknowledged. Advisory findings: non-bridge acceptance not proven live (addressed afterwards by the Codex probe), tautological ordering assertion and overclaiming route test, silent no-op when `systemPromptOptions` is missing, substring dedupe, weak todo idempotency assertion.

## Follow-ups

- Done in this PR (commit `1a5cbc094`, user-approved scope addition): the `gentle_odd_phase` reporting instruction lived only in `assets/orchestrator-delegation.md`; one "Phase reporting" line now follows step 7 in the harness, covered by `tests/odd-routing-contract.test.ts` (RED then GREEN). Live under `claude-bridge`, the model now states when to call `gentle_odd_phase`.
- Superseded `feat/bridge-instructions` branch: deleted (never published).

## Next step

Pull request with `Closes #1485`; merge is the user's decision.
