# Verifier settle reminder (#2652)

Objective: remind once at settle when a run declared `Risk: item N` and never attempted a `gentle-ai-verify` launch. Branch: `feat/verifier-settle-reminder` (worktree `.worktrees/verifier-settle-reminder`). Delivery: single-pr. Runner: `node --experimental-strip-types --test <file>`; suite `pnpm test`; `pnpm run typecheck`.

## Specs

- S1: At `agent_before_settle` in the primary session (never a child: `GENTLE_PI_AGENTS_CHILD === "1"`), when the run's final assistant message declares `Risk: item N` (the same grammar verifier admission uses, `HIGH_RISK_ITEM_LINE` in `lib/verifier-admission.ts`, reused, not re-implemented) and the run made no `subagent_run` tool call with agent `gentle-ai-verify` (admitted or rejected), append one visible reminder and request exactly one continuation (`continue: true`).
- S2: The reminder names the declared item, says how to launch the verifier (`gentle-ai-verify` with the `Risk: item N` line in its `task`), states that a user's visual or manual approval does not replace technical verification, and says to close with **Needs your decision** naming the missing proof when verification is unavailable.
- S3: At most one reminder per user prompt (no loop). No reminder when the final message says `Risk: none` or names no item, or when a verifier launch was attempted in that run.
- S4: The admission rejection (`VERIFIER_RISK_REJECTION`) says no supported `Risk: item N` declaration was recognized in the launch `task` or `context`, instead of "This change declares none". Keep the instruction to run checks inline and never to add a Risk line only to gain admission.
- S5: The `gentle_review` tool `input` description documents the optional ASSESS `escalate` object: `{"item": N, "reason": "..."}` with item 1-6 and a non-empty reason of at most 500 characters; other shapes are rejected; omission means no escalation.
- S6: Docs describing verifier admission and the Verification rule (`docs/readme-reference.md`, and `assets/orchestrator-verification.md` only if needed, respecting its byte budget test) mention the settle reminder.

## Tasks

- T1 [S1-S6] route: delegated (context backstop reached in the parent) — status: done (worker RED 8/11 then GREEN 20/20; parent spot check 20/20) — commit: see git log
- T2 [S1-S6] independent verification (Risk: item 3, changes a consumed rejection message and mirrored prompt/tool contract text) — status: done (first pass FAIL S1, corrected in cb81e7a8b, recheck PASS)

## Log

- L1 (2026-10-29, user): "si y luego commit pr y merhr" — accepting the proposal: settle-time reminder when `Risk: item N` is declared without a verifier attempt, one continuation, visible; plus the #2478 rejection wording and the #2647 `escalate` description; issue first, then commit, PR and merge.
- L2: Issue #2652 created and approved (status:approved) by Alan-TheGentleman (ADMIN). Refs #1359, #2478, #2647.
- L3: T1 worker returned partial: focused 80/80, typecheck and runtime-modules check pass via node; full suite 7767 pass / 38 fail, believed environmental (Unix socket TMPDIR length, host config home), baseline comparison delegated to T2.
- L4: T2 verifier FAIL on S1: handler gated on incoming `event.context.canContinue`, which Pi computes false for every completed run (last message is the assistant), so the reminder never fired in a real session; the fixture hardcoded `canContinue: true`. Correction: drop the gate (Pi re-validates after handlers), fixture now `canContinue: false`, plus a real `createAgentSession` regression test. RED 2 fail on the old handler; GREEN 81/81 focused, typecheck 0 diagnostics, runtime modules match. Baseline: the 8 reported suite files fail identically at bbb001636 (4 agent-home host-config failures), no regression. S2-S6 PASS.
- L5: Bounded S1 recheck PASS on cb81e7a8b: 12/12 focused; independent real-SDK probe shows one reminder, continuation validated (recomputed canContinue true), second settle appends nothing, no boundary errors.
- L6: PR #2653 merged as ba47fd403. Follow-up from a CodeRabbit outside-diff comment found after merge: an in-process named-agent run never records verifier attempts but still reached the settle check, so it could get a spurious reminder; the suggested depth guard was insufficient because agent_end resets depth before settle when nativeReviewCli exists. Fix: record whether the run started primary in before_agent_start and skip settle otherwise. RED 1 fail, GREEN 82/82 focused, typecheck 0.
- L7: PR #2654 CodeRabbit round: a per-session boolean let a nested named run overwrite the primary classification, and the test could not tell a depth-only guard apart. Replaced with a per-session count of unsettled named/child runs paired with their own settle (primary start resets it); added a nested-run test that fails both the boolean and a depth-only guard. RED 1 fail, GREEN 83/83, typecheck 0.
- L8: CodeRabbit round 2 on #2654: Pi checks settlement again after a continuation without a new before_agent_start (docs/extensions.md lifecycle diagram), so decrementing at agent_before_settle could treat a named run continuation as primary. Moved the pairing to agent_settled. RED 1 fail, GREEN 116/116 (settle, admission, agent_end preflight, notifications), typecheck 0, runtime modules match.
