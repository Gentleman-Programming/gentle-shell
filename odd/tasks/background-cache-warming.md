# Background Cache Warming

Issue: https://github.com/Gentleman-Programming/gentle-shell/issues/1278
Related umbrella: https://github.com/Gentleman-Programming/gentle-ai/issues/4799

## Objective

Use Pi's native prompt-cache warming in Gentle Shell so expensive parent-session prefixes remain warm while owned background subagents run and during bounded ordinary idle periods, without blocking the parent or adding maintenance messages to model context.

## Problem

Gentle Agents intentionally runs children in the background so the user can continue talking to the parent. The parent may then remain idle longer than a provider's prompt-cache lifetime. A later child completion or user prompt can pay a cold-cache miss even though Pi 0.86.1 already has a cost-aware native cache warmer.

Gentle Shell currently does not integrate with `cache_warming_decision` or clearly expose the native `cacheWarming: "idle"` mode.

## Why

Native warming refreshes a known provider cache shortly before expiry with one output token, records usage outside model context, and automatically reschedules after real provider requests. It is safer and cheaper than model-driven status polling, artificial sleeps, or hidden maintenance turns.

## Scope

- Integrate Gentle Agents with Pi's native `cache_warming_decision` event.
- Preserve Pi's native ordinary idle policy, including its 15% continuation assumption, economic threshold, provider lifetime checks, and 30-minute idle bound.
- While the active parent session owns queued or running background tasks, treat eventual continuation as likely and allow warming only when the native cost evidence still makes it economically worthwhile.
- Ensure real user/provider activity naturally resets scheduling through Pi's native warmer; do not add a parallel timer.
- Surface or document how to enable native idle warming without silently overriding an explicit user opt-out.
- Keep background completion push-driven. Preserve the prohibition on sleeping or periodic status polling for completion/cache maintenance, while allowing `subagent_status` only at a real orchestration decision boundary (user-requested inspection, relevant scope change, input request, or suspected abnormal behavior).
- Add deterministic contract and integration tests.

## Out of Scope

- Gentle AI changes.
- Model-driven polling, `sleep`, long-poll tools, or blocking the parent.
- Automatic semantic supervision or steering of children.
- Provider cache lifetime inference where Pi has no declared `promptCache` metadata.
- Extending native warming beyond Pi's bounded idle/active horizons.

## Constraints

- Technical artifacts in English.
- Preserve background completion delivery and task ownership semantics.
- Respect explicit `cacheWarming: "off"` and unknown provider cache lifetimes.
- No hidden settings mutation.
- Never relaunch equivalent child work merely because an existing task remains queued or running.
- No commit, push, PR, merge, or issue mutation without an explicit user request.
- Keep the implementation under the existing review-workload heuristic; forecast is under 200 authored changed lines.

## TDD

- Mode: strict TDD enabled.
- Source: `openspec/config.yaml` and persisted project testing capabilities.
- Focused runner: `node --experimental-strip-types --test tests/background-cache-warming.test.ts` (deterministic in-memory event tests plus source/prompt contract checks; no provider calls).
- Required cycle: RED -> GREEN -> REFACTOR.
- Final checks: focused tests, `pnpm run typecheck`, and `git diff --check`; run broader tests when the touched runtime surface requires them.

## Tasks

- [x] **T1 — Specify the native-warming contract (delegated).** Add RED tests proving the integration distinguishes owned live background work from ordinary idle, preserves economic gating, and never blocks or injects model-context messages.
- [x] **T2 — Implement the Gentle Shell integration (delegated).** Wire the smallest Pi-native decision hook and user-facing configuration guidance while preserving explicit opt-out and native lifecycle bounds.
- [x] **T3 — Verify behavior and regression boundaries (delegated verification).** Run focused tests, typecheck, diff check, and an independent read-only verification if required by native risk assessment.
- [x] **T4 — Close the lifecycle coverage gap (delegated correction).** Add one extension-level behavioral test that fires the registered warming decision before launch, during owned background work, after session replacement/restoration, and after completion; remove reliance on wiring regex as the only integration proof.
- [x] **T5 — Correct the CI type regression (inline correction + delegated verification).** Preserve awaited shutdown cleanup while adapting the existing `Promise<void>` callback to the result-returning fake event dispatcher.

## Acceptance Criteria

- A live owned background task can strengthen a native warming decision without starting an orchestrator turn.
- Ordinary idle behavior remains Pi-native and bounded; no Gentle-owned recurring timer exists.
- A real user/provider request resets Pi's native warming schedule without Gentle-owned bookkeeping.
- Explicit warming opt-out and unsupported provider lifetimes remain no-op paths.
- No child task is launched, duplicated, periodically polled, inspected, or steered by cache warming.
- `subagent_status` remains available only for concrete orchestration decisions; it is never a cache heartbeat.
- Cache-warming usage remains outside LLM context and existing completion delivery stays unchanged.
- Required tests and checks pass with observed evidence recorded below.

## Route

- T1/T2: delegated direct writer, triggered by multiple non-trivial files and implementation-preparation reads.
- T3: delegated verification, triggered by command-running verification policy.
- T4: delegated direct test-only correction; production code is unchanged.
- T5: inline one-line test-harness correction after CI RED, followed by delegated command verification.

## Delivery Strategy

- Strategy: `ask-on-risk`.
- Forecast: under 200 authored changed lines, no chained PR expected.
- Delivery remains a separate user decision.

## Progress

- Exploration complete: Pi 0.86.1 provides native `cacheWarming: "idle"` and `cache_warming_decision`; Gentle Shell currently has no integration.
- Prompt decision confirmed: keep completion push-driven; prohibit sleep/periodic polling; permit status inspection only at a concrete orchestration decision boundary.
- Isolated worktree created at `/Users/alanbuscaglia/work/gentle-pi-worktrees/background-cache-warming` on `feat/background-cache-warming` from `origin/main` commit `40e91351`.
- Tracking created before source/test writes.
- T1/T2 implemented: native decision-only event handler, current-session ownership/economic tests, explicit idle opt-in documentation, and push-driven/no-polling prompt guidance. No source-mutating formatter or delivery operation ran.
- Pi 0.85.1 remains the package's pinned development API. One documented type boundary admits the 0.86.1 event without dependency changes; older runtimes do not supply native candidates.
- Independent T3 verifier passed every acceptance criterion and all required commands. It found one low-severity coverage gap: the actual extension lifecycle is represented only by wiring regex plus separate helper/ownership tests.
- T4 closed the lifecycle gap with the actual registered extension event, runtime child launch/settlement, active-session switching, and a live-looking unowned record seeded through the real TaskStore restore method. T3 finalized using the prior independent verification plus the passing correction checks. No runtime defect was observed.

## Checks

- RED: `node --experimental-strip-types --test tests/background-cache-warming.test.ts` exited 1: `ERR_MODULE_NOT_FOUND` for the absent `lib/background-cache-warming.ts` integration (1 failed test file). Captured before implementation.
- API confirmed from installed Pi 0.86.1 `docs/extensions.md` and `dist/core/cache-warmer.js`: decision supplies `warmCost`, `missCost`, `continuationProbability`, and `action`; return an action override only. Native eligibility checks precede emission; streaming mode stops at settlement, idle has a 30-minute bound, and real requests replace the schedule.
- Ownership confirmed: Gentle Agents tracks `ownedTaskIds` separately from restored history and filters tasks by `activeSessionId()`. Only owned queued/running background records qualify.
- GREEN: `node --experimental-strip-types --test tests/background-cache-warming.test.ts` passed all 3 tests after implementation and again after type corrections.
- TRIANGULATE: queued/running ownership, missing/foreign session, restored/unowned records, task mode, waiting/terminal states, exact savings threshold, invalid/non-finite costs, and unchanged ordinary idle action covered. The registered callback is synchronous and has no timer, provider, messaging, or child-runner capability. Extension wiring and prompt guidance have source-contract assertions; this is not an end-to-end provider test.
- `pnpm run typecheck`: initial run failed on the pre-0.86.1 API type and a fixture status type; both corrected. Final run passed the existing ratchet with 196 recorded diagnostics and no regressions (not a clean compiler baseline).
- Environment side effect: the first explicitly requested `pnpm run typecheck` auto-installed 195 packages and executed postinstall, generating `node_modules/` and `.gentle-ai/v3.4.0/gentle-ai` outside the edit surfaces. No installer was requested separately; generated state was preserved, not deleted. Subsequent run performed only typechecking. Tracked diff remains within allowed surfaces.
- `git diff --check`: passed.
- Independent verifier: focused 3/3, Gentle Agents 111/111, type ratchet passed (196 baseline diagnostics, no regressions), diff-check clean; pre/post status unchanged. The one low lifecycle-integration coverage gap was subsequently closed by T4.
- No live provider/cache-hit check ran. The verifier's exact BSD-format `stat` metadata command failed under the installed `stat` implementation; no substitution, cleanup, or candidate mutation ran.

### T4 correction evidence

- RED: `node --experimental-strip-types --test tests/gentle-agents.test.ts` exited 1 (111 passed, 1 failed). The new event-level assertion received `undefined` instead of `[undefined]` because `fakePi.fire()` discarded registered callback returns. This was a test-harness observability failure, not a production behavior defect. No production RED is claimed.
- GREEN: the fake event dispatcher now collects callback results; the new lifecycle test passes against unchanged production code. It verifies ordinary behavior before launch, warming for an owned running child (including after `agent_end` but before settlement), no strengthening for a foreign active session or restored/unowned running record, and ordinary behavior after settlement/shutdown.
- Side-effect checks around every decision assert unchanged launch count, scheduler calls, status/result tool calls, child RPC/IPC traffic, completion messages, and persisted context entries, plus zero timeout/interval calls. Settlement still pushes exactly one `gentle-agents.result` with the original task ID and `triggerTurn: true`.
- REFACTOR: removed the extension source-wiring regex. Pure helper and prompt tests remain, with a supplemental no-maintenance-capability source guard; actual extension lifecycle behavior is now the primary integration proof. Queued-state decision coverage remains in the helper test.
- `node --experimental-strip-types --test tests/background-cache-warming.test.ts`: passed 3/3.
- `node --experimental-strip-types --test tests/gentle-agents.test.ts`: passed 112/112, including the new behavioral test. Fixture Git diagnostics (`not a git repository` / missing fixture cwd) appeared on stderr without test failures.
- `git diff --check`: passed.
- Typecheck intentionally not rerun: T4 changes tests and this document only. No install, production edit, or delivery operation was performed for T4.
- Final independent verification after T4: combined focused suites passed 115/115; `git diff --check` passed; tracked and untracked candidate diff was inspected; no defects found. It confirmed `fakePi.fire()` still propagates handler failures and preserves lifecycle bookkeeping, test-scoped mocks/timers do not leak, the registered production callback is exercised, and production code stayed unchanged after the first review. The prior LOW coverage finding is closed.
- Proof boundary: no live provider/cache-hit or full Pi-host lifecycle run was performed. Session replacement is represented by active-session identity changes and restoration by real `TaskStore.restore`; shutdown is covered after settlement.

### T5 CI correction evidence

- CI RED on PR #1279: `verify` → `Type check` ran `pnpm run typecheck` and exited 1 with `TS2322`: the existing shutdown callback promised `void`, while the corrected fake dispatcher now returns `Promise<unknown[]>`.
- Root cause: `shutdown.push(() => h.fire("session_shutdown", ctx))` forwarded the dispatcher result into `Array<() => Promise<void>>`. This was candidate-caused test-harness typing, not a production runtime defect.
- Correction: `shutdown.push(async () => { await h.fire("session_shutdown", ctx); });` preserves awaited cleanup and intentionally discards the event-result array.
- Delegated GREEN: `pnpm run typecheck` passed the ratchet with 196 baseline diagnostics and 3 improved file/code pairs; combined focused/runtime suites passed 115/115; `git diff --check` passed.

## Next Step

Issue #1278 is approved and PR #1279 is open. Implementation work-unit commit: `ea3d167d` (`feat(agents): preserve parent prompt cache during background work`). The first CI run exposed T5 and the correction is verified locally. Next: commit and push T5, renew native review for the changed candidate, wait for all automated checks, and merge.
