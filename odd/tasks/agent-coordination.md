# Agent coordination: activation-safe discovery

Approved issues: #1701 and #1702. Delivery strategy: stacked PRs.
This first unit **Refs #1701**; neither issue is closed by metadata discovery.
Baseline supplied by parent: `ac671593`; branch: `feat/1701-coordination-discovery`.
Commits, push, PR creation, and memory mirror remain parent-owned; no merge approval exists.

## Unit 1: recognizable advertised peers (complete)

- Preserve exact schema-1 headers. Optional private, bounded derived sidecars bind metadata to session/incarnation/generation and transport activation; they are not an identity/authority registry.
- Preserve routing IDs, unknown reachability, heartbeat freshness, and unknown context on ambiguous/missing/stale metadata.
- Publish recorded labels/workspaces and eight unfinished runtime-owned child labels/statuses/launch workspaces; omit restored running history, prompts, threads, and output.
- No new public tool, model call, or message. Paths never establish isolation or locks.
- Unit 1 committed as `8cbb3dfe93c4c116e835296c422da4dbb552497d`; native `review-c80d90707ee9dbab` approved and acknowledged. Its review boundary is closed; the following advisory is later work.

## Blocker dispositions and observed verification

- P1 RED: `node --experimental-strip-types --test tests/orchestrator-discovery.test.ts` failed because the exact `ac671593` validator rejected a new metadata-bearing header (`false !== true`). GREEN: same validator accepts unchanged headers with sidecars; malformed/missing/wrong-incarnation/wrong-generation sidecars leave valid headers visible and metadata unknown.
- Restoration P2 RED: `node --experimental-strip-types --test --test-name-pattern='restored task history' tests/gentle-agents.test.ts` captured `history-running` in publication during the synchronous restore summary callback. GREEN: same command passed after runtime-owned gating. Admission refresh publishes real admitted tasks without requiring a later child event; alternate extension harness passed.
- Duplicate-activation P2: the real POSIX registry selects one canonical newest advertised activation (existing token tie-break). New real-registry test confirms selection equals `resolve`, metadata for the other activation stays unknown, and exact selected metadata joins with reachability unknown. No candidate-caused failure was reproduced for canonical selection; mock duplicate arrays are not claimed to detect real registry ambiguity. Transport/message targeting is unchanged.
- Final: `node --experimental-strip-types --test tests/orchestrator-presence.test.ts tests/gentle-agents.test.ts tests/orchestrator-discovery.test.ts tests/agents-session-transport.test.ts`: 237 passed, 0 failed. Fixture Git probes emitted non-repository warnings.
- Runtime boundary: registered `orchestrator_list` extension harness joined a known peer label/workspace/child task and observed zero child launches and zero messages. Harness evidence, not an interactive live-model session.
- `node scripts/check-types.mjs`: 186 recorded diagnostics, no regressions (12 file/code pairs improved).
- `node scripts/build-runtime-modules.mjs --check`: 8 generated modules match; one-shot metrics sources validated.
- Discovery fixture teardown removes only each test-owned root; publishers/listeners clean their own resources.
- Environment incident correction: the previous package-command invocation emitted installation/postinstall output, but its provenance is unknown. Inspection confirms `check-types.mjs` contains no install code. Parent reports replacing the owned dependency symlink with local dependencies installed using frozen lockfile/ignore-scripts. This correction pass used direct Node commands only.

## Follow-up: portable legacy-contract regression (complete, `5e282cbfad69c309a240aa6ea760133dcb0d5c50`)

R3-history-dependent-test replaces the Git-history import with an independent frozen schema-1 field whitelist and scalar/count constraints, not a copy of the historical module. It rejects an added `discovery` field and wrong schema; bad-sidecar coverage remains intact. Earlier exact-validator evidence above describes Unit 1 only, not the current test.

- Portability RED/GREEN: copied only the test and its three library modules into an owned OS-temp package root with no `.git`, using `GIT_CEILING_DIRECTORIES` at the OS-temp parent. `node --experimental-strip-types --test tests/orchestrator-discovery.test.ts` initially failed `git show` (4 passed, 1 failed; exit 1); after replacement the same isolated command passed all 5 (exit 0). Each copy root was removed in runner teardown.
- Local focused command above: 5 passed. `node scripts/check-types.mjs`: 186 diagnostics, no regressions. `node scripts/build-runtime-modules.mjs --check`: 8 modules match; metrics sources validated.
- No source behavior changes, native re-review, live runtime claim, or full feature closure. Unit 1's 237-test evidence and remaining limitations remain historical evidence; parent owns this follow-up commit and mirror.

## Unit 2: subject/rename (complete, `b88a5dcb3b014cbcd2307364dbfb8591f05f2dc1`)

Previous PR: #1714; current branch: `feat/1701-session-subject-scope`, based on `6bf09b38`.
One coherent split delivers subject declaration and rename refresh. Authoritative
repository/worktree scope is deferred with its own resolver/cache, compatibility,
and association tests rather than compressing two work units into the review budget.

- Existing `orchestrator_session_id` accepts an optional short subject, names only an
  unnamed canonical Pi session via documented `pi.setSessionName`, and returns its
  current sanitized alias alongside the unchanged routing ID. No second alias store.
- Presence samples the current session manager's canonical name on the existing
  heartbeat. Declaration refreshes immediately; replaced/stale sessions cannot
  publish through the old source. Schema-1 headers and sidecars are unchanged.
- Read installed Pi `examples/extensions/session-name.ts`, full `extensions.md`,
  `sessions.md`, `session-format.md`, and linked relevant `sdk.md` before API use.
  A guessed singular `docs/session.md` path did not exist; corrected to `sessions.md`.
- RED: `node --experimental-strip-types --test --test-name-pattern='registered session identity' tests/gentle-agents.test.ts`
  failed `'' !== 'Fix auth'` on baseline. Separately,
  `node --experimental-strip-types --test --test-name-pattern='heartbeat refreshes' tests/orchestrator-presence.test.ts`
  failed `'Fallback' !== 'Human rename'` before implementation.
- GREEN: `node --experimental-strip-types --test --test-name-pattern='registered session identity|heartbeat refreshes' tests/orchestrator-presence.test.ts tests/gentle-agents.test.ts`
  passed both tests. Alternates cover human-name preservation, control-only and
  Unicode-limited subjects, idle rename without generation changes, unchanged
  activity/metadata readback, invalid source, replacement, and stale tool context.
- Registered-tool runtime harness observed zero child launches, custom messages,
  and user messages. It drives the existing heartbeat callback deterministically;
  this is not interactive live-model readback or Windows runtime evidence.
- `node --experimental-strip-types --test tests/orchestrator-presence.test.ts tests/orchestrator-discovery.test.ts tests/gentle-agents.test.ts`:
  193 passed, 0 failed. Existing fixture Git probes emitted non-repository/missing-cwd warnings.
- `node scripts/check-types.mjs`: 186 recorded diagnostics, no regressions;
  12 file/code pairs improved. `node scripts/build-runtime-modules.mjs --check`:
  8 generated modules match; one-shot metrics sources validated.
- Shipped parent-only `assets/orchestrator.md` now directs subject declaration once
  a meaningful task is understood, before delegation/cross-session coordination,
  batched with setup when possible. No tiny-reply calls, prompt/private-detail
  subjects, human alias entry, extra model calls, or new metadata verbs/stores.
- Prompt-only completion has no meaningful functional RED: structural assertions
  verify shipped wording, not actual model obedience. Initial budget checks failed
  at 8,249 / 8,201 / 8,193 bytes for the controlled 128-character assets root;
  tightening only the new instruction restored the unchanged 8,192-byte guard.
- Final on-demand spot check of presence/discovery/agents/budget: 228 passed, 0 failed; assessment medium/large under budget, writer verification stands.
- `node --experimental-strip-types --test tests/orchestrator-budget.test.ts`:
  35 passed, 0 failed, including the parent-only subject contract and default
  short/controlled-long prompt budgets. Both type/runtime commands above were
  rerun successfully with the same results; repository identity remains next PR.
- CodeGraph exploration failed because this dedicated worktree has no index;
  used scoped reads, without writing an out-of-scope index. No dependency mutation.
- Rollback for this unit: remove subject/name-source changes from extension and
  presence, shipped subject instruction, and associated tests/docs; keep the
  previous sidecar, transport, and routing behaviors.

## Next stacked units / remaining acceptance

#1701 remains open: authoritative recorded repository/worktree context (reuse `resolveSessionWorktree`, exclude ambient Git env, hash common-directory identity, cache by actual host/child launch cwd with lifecycle invalidation, retain unknown non-Git context); registered authoritative roots if bounded; scalable bounded continuation; interactive live readback. Subject declaration and canonical rename refresh are delivered by Unit 2. Finished/restored children remain excluded from active writer metadata. First-page overflow conservatively leaves context unknown; older publishers remain visible but have unknown discovery metadata.
#1702 remains separate: metadata alone cannot answer arbitrary cross-session reasoning questions.

Rollback boundary: remove this unit's optional sidecar/projection/join and restore raw-ID-only `orchestrator_list`, together with its tests/docs; do not touch transport messaging, existing activity threads, dependency artifacts, or unrelated work.
