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

## Unit 3: authoritative recorded repository scope (complete, `922ee7336559892f8b5f8a4a3188ab723435021b`)

Previous PR: #1715; current branch: `feat/1701-repository-scope`, based on `20d265aa`.
Reuse canonical Git root/common-directory resolution for the host, launch-owned children and registered worktrees; correlate clone identity without parsing remote URLs. Keep non-Git/unresolvable facts unknown, bound projections and refresh on real lifecycle changes, not shell `cd`.

- Added optional scope facts with canonical roots, clone hashes, resolution-attempt time/source; no raw common-directory paths. Reuses the existing resolver and durable session registry entries. Existing owned/unfinished/non-restored task gating and exact schema-1 headers remain intact.
- One derived snapshot caches successful/unknown resolutions; host/launch cwd, admission membership, registered membership/events, and session replacement invalidate it. At most 17 unique paths are resolved per snapshot; stable publication/heartbeat does not probe Git.
- Eight child/eight registered facts maximum; roots requiring normalization or exceeding 256 bytes are unknown, never shortened. Byte overflow withholds both scope lists with exact omission counts. This is not complete registered-root continuation or a global writer/isolation inventory.
- RED: `node --experimental-strip-types --test tests/orchestrator-scope.test.ts` first failed missing module, then the temporary unknown-scope implementation produced the meaningful host assertion `null !== <fixture repo>`. `node --experimental-strip-types --test --test-name-pattern='registered orchestrator_list' tests/gentle-agents.test.ts` failed because candidate scope/host was absent.
- GREEN: `node --experimental-strip-types --test --test-name-pattern='recorded host|registered orchestrator_list' tests/orchestrator-scope.test.ts tests/gentle-agents.test.ts`: 2 passed. Real owned Git fixtures exercise host/child association, sibling versus separate clones, ambient Git routing, non-Git/unavailable, replacement/cwd/membership changes and bounded unknown caching. These alternates were observed GREEN, not separate RED runs.
- Final: `node --experimental-strip-types --test tests/orchestrator-presence.test.ts tests/orchestrator-discovery.test.ts tests/gentle-agents.test.ts tests/orchestrator-scope.test.ts`: 196 passed, 0 failed. Existing fixture probes emit non-Git/missing-cwd warnings. An earlier run exposed a new bus-subscription leak and two incorrect fixture expectations; fixed and rerun successfully.
- `node scripts/check-types.mjs`: 186 recorded diagnostics, no regressions; 12 file/code pairs improved. `node scripts/build-runtime-modules.mjs --check`: 8 modules match; metrics sources validated.
- Registered-tool harness reads peer host/child scope and legacy unknown fallback; host publication harness checks own root, registered-root event refresh, unchanged resolution age on heartbeat and session replacement. Discovery-only harnesses launch zero children and send zero messages; existing admitted-child harness retains its original launches. No new tools/model calls/messages.
- Optional old readers may reject new sidecars as unknown, but activity remains visible. New readers accept legacy scope-free sidecars; malformed scope alone preserves recognizable metadata and stable ID with unknown repository facts.
- CodeGraph query failed (uninitialized dedicated worktree); scoped reads used, no out-of-scope index/dependency writes. Test teardown removes only owned fixture roots. No interactive live profile or native Windows execution claimed.
- Rollback: this unit's scope helper, optional sidecar scope, extension projection/join, tests and documentation only; retain earlier labels/rename/activity/transport behavior. Parent owns task mirror, commit and delivery; Refs #1701 only.

### Pre-commit correction: literal Unicode root safety

- Independent static finding reproduced: two existing Git directories `repo\u00a0name` and `repo name` are distinct, but the shared spelling resolver normalizes the former to the latter. Scope now rejects every normalized separator on input, resolved-root output and sidecar readback; shared resolver semantics are unchanged. This is honest unknown, not faithful resolution of those literal paths.
- RED/GREEN: `node --experimental-strip-types --test tests/orchestrator-scope.test.ts tests/orchestrator-presence.test.ts tests/orchestrator-discovery.test.ts tests/gentle-agents.test.ts`: before the guard, 196 passed / 1 failed with the ASCII twin root and clone hash instead of null; after, 197 passed / 0 failed. Alternates cover all 15 normalized separators, zero resolver probes for rejected inputs, ordinary spaces, Unicode letters, and malformed sidecar fallback retaining the header/recorded workspace.
- Known and unknown facts retain `recorded-workspace/git` source and resolution-attempt time, not heartbeat freshness. Fixtures and private profile storage are confined to the owned temporary root and cleaned in teardown.
- `node scripts/check-types.mjs`: 186 recorded diagnostics, no regressions; 12 file/code pairs improved. `node scripts/build-runtime-modules.mjs --check`: 8 modules match; metrics sources validated. No interactive live-profile or native Windows proof; no new tools/messages/model calls. Parent mirror/review/delivery remain pending; Refs #1701 only.

### Independent actual SDK verification

197 focused tests passed after the correction. Two real Pi SDK sessions in an isolated profile, driven by a local deterministic provider, verified aliases, distinct host clone hashes, child scope through one in-memory adapter, heartbeat rename and session replacement. Measured 1,000 stable projections added zero resolver/Git calls. All 15 normalized separators were independently checked; temporary runtimes/fixtures were disposed and removed. No outbound/paid calls, OS child launches, interactive TUI or native Windows proof.

## Next stacked units / remaining acceptance

#1701 remains open: recorded repository/worktree context and bounded registered-root facts are implemented in Unit 3; Unit 4 now supplies bounded recorded-path continuation beyond eight entries; Git facts beyond the existing prefix and overflow beyond the explicit catalog bounds remain unknown. Isolated actual SDK profile readback passed; interactive TUI was not exercised. Subject declaration and canonical rename refresh are delivered by Unit 2. Finished/restored children remain excluded from active writer metadata. First-page overflow conservatively leaves context unknown; older publishers remain visible but have unknown discovery metadata.
#1702 remains separate: metadata alone cannot answer arbitrary cross-session reasoning questions.

Context decision accepted: initial consultations use published status and curated summaries only. Automatic conversation/system-prompt/file sharing is not authorized; any future expansion needs explicit user enablement. No auxiliary may forge an owner decision. Metadata-only queries, reasoning and decision handling remain pending.

## Unit 4: bounded metadata continuation (native review approved; SDK acceptance pending)

Parent: behavior commit `8a9ccc66` passed native `review-reliability` (`review-657ff6e298bd22b3`), approved and acknowledged/burned. Its non-blocking catalog-write-isolation advisory belongs to later work; the approved review is not reopened. Actual SDK continuation remains unverified (missing adapter), unlike Unit 3's prior SDK proof.

Previous PR: #1720; branch `feat/1701-scope-continuation`, base `9acd5a81`. Continue owned task and recorded registered-workspace metadata past the first eight facts through private, activation/snapshot-bound pages. Reuse existing sources; no transcript/thread reads, extra model calls, receiver wakeups or extra Git probes per heartbeat. Preserve bounded omissions and unknown Git facts for unvisited roots.

Rollback boundary: remove this unit's optional catalog/projection/join and restore the previous first-page `orchestrator_list`, together with its tests/docs; do not touch transport messaging, existing activity threads, dependency artifacts, or unrelated work.

- One private sibling snapshot per activation: 64 KiB maximum, 64 children and
  64 recorded registry paths, eight of each per page, at most eight pages. Whole
  entry overflow has exact omission counts; unsafe literal paths are null.
- Cursors pin session/incarnation, activation and canonical public-catalog
  digest with publisher-minted page tokens. Envelope/header generation still agrees on each read. Caller mutation is detached; stable
  publication is cached. Header schema and existing Git prefix remain unchanged.
- RED: `node --experimental-strip-types --test tests/orchestrator-catalog.test.ts`
  failed 0/1 passing: missing `catalog.tasks` with ten children and ten roots.
  GREEN: same command passed the new behavior; expanded alternates passed 2/2.
- Historical pre-correction: `node --experimental-strip-types --test tests/orchestrator-presence.test.ts tests/orchestrator-discovery.test.ts tests/gentle-agents.test.ts tests/orchestrator-catalog.test.ts`
  passed 197/197. Existing non-repository/missing-cwd Git fixture warnings remain.
- Alternates cover tampered/wrong-peer/stale/replacement cursors, heartbeat and
  generation consistency, private-field exclusion, no new resolver calls, byte
  and entry overflow, missing/legacy/malformed/oversized/symlink/FIFO snapshots,
  scan isolation, owner-only disposal and preservation of replacement files.
- Registered-tool harness verifies selected-peer first/next pages with zero child
  launches, custom messages or user messages. Actual SDK continuation-profile
  readback is deferred to the parent verifier; no live UI or Windows claim.
- `node scripts/check-types.mjs`: 186 diagnostics, no regressions; 12 pairs improved.
  `node scripts/build-runtime-modules.mjs --check`: eight modules match.
- Test-owned OS-temp roots are removed by teardown; publishers dispose only their
  own files. No dependency changes, commits, pushes, PRs or merges by this writer.
  #1701 remains open pending parent verification/review; #1702 remains future
  published-status/curated-summary work, never automatic conversation sharing.

### Busy private-activity correction (current evidence)

RED/GREEN command: `node --experimental-strip-types --test tests/orchestrator-catalog.test.ts tests/orchestrator-presence.test.ts tests/orchestrator-discovery.test.ts tests/gentle-agents.test.ts`.
RED: 196 passed, one failed; unchanged public tasks/roots with only private thread
and activity-time changes advanced activity generation, but continuation returned
undefined instead of t8/t9. GREEN: 197 passed, zero failed after binding tokens to
public catalog bytes, not private generation/envelope bytes. Public status, root,
membership and label deltas still reject old cursors; mismatched current envelope
generation remains unknown. Unrelated legacy metadata preserves page tokens.
`updateDiscovery` owns public-source semantics; production uses the same owned
list for activity and discovery, never infers public membership from empty activity.
Current type/runtime commands above passed again (186 diagnostics, no regressions;
eight modules match). Test-owned fixture teardown remains unchanged.
Actual SDK continuation execution is NOT claimed: parent reports MODULE_NOT_FOUND.
SDK integration is deferred to a separate acceptance unit before #1701 closure.

## Unit 5: explicitly published state (verified first slice; consultations deferred)

Parent assessment: 386-line behavior candidate, medium risk, runtime large writer, under budget; writer self-verification stands with no required independent verifier. Native outcome is unknown, not closed. Actual SDK acceptance, direct consultation receipts, reasoning and correlated owner decisions remain pending.

Previous PR: #1724 (390 changed lines, 197 tests passing, remote functional checks green; CodeRabbit skipped for the stacked base). Branch `feat/1702-published-state`, base `0e5d6f8f`. Reuse canonical SessionManager custom entries for owner-curated objective/progress/decisions/blockers, with generated source/time and bounded payloads. Never import conversation bodies or authority. Metadata-only consultations will read the existing selected-activation projections without waking the owner or calling a model. Reasoning and correlated owner decisions remain later units; neither issue is closed.

- One approved slicing pass delivers optional `state` on `orchestrator_session_id`
  plus targeted `orchestrator_list` readback. Object replaces, null withdraws,
  omission preserves. Four whitelisted strings share 2,048 UTF-8 bytes; records
  fit 4 KiB. Validation precedes naming/persistence; no model-supplied owner/time/grant.
- Public `pi.appendEntry`, not a mutable context-manager cast, writes non-context
  custom entries. Latest typed active-branch entry only; malformed/foreign latest
  suppresses older notes. Startup/reload/tree reload the cache; replacement/shutdown
  clear binding. Recorded cwd is bounded or null; recordedAt is not heartbeat time.
- RED (authorized five-file Node command): 196 passed / one failed,
  `undefined !== 'Verify auth'`; baseline advertised no explicit notes.
  GREEN first slice: 200 passed / zero failed. Alternates cover null restore,
  tree navigation, same-ID/new-manager replacement, human renames, stale sources,
  private-body/summary getter exclusion, UTF-8 and envelope bounds, invalid records,
  and 1,000 cached reads with no extra branch scans. Registered readback observes
  zero child launches/custom messages/user messages; actual SDK proof is deferred.
- `orchestrator_consult` and frozen consultation receipts remain the next unit,
  not implemented or claimed here. Both issues remain open. Parent owns mirror,
  review, commits and delivery. Rollback: only new state/cache/optional sidecar/tool
  wiring and associated tests/docs; preserve existing identity/transport/catalog.

### Separate later R3 catalog-write-isolation hardening

Inspection confirmed catalog failure skipped the discovery write, but did not
withdraw a valid header. Split optional write guards; do not reopen consumed
`review-657ff6e298bd22b3`. RED: same five-file command, 200 passed / two failed,
missing `/repo` metadata for unwritable and symlink catalog roots. Owned temporary
fixtures verify legacy activity remains readable, metadata survives, retry works,
and publisher cleanup stays scoped. Final GREEN: 202 passed / zero failed with
`node --experimental-strip-types --test tests/orchestrator-state.test.ts tests/orchestrator-catalog.test.ts tests/orchestrator-presence.test.ts tests/orchestrator-discovery.test.ts tests/gentle-agents.test.ts`.
`node scripts/check-types.mjs`: 186 diagnostics, no regressions, 12 pairs improved.
`node scripts/build-runtime-modules.mjs --check`: eight modules match; metrics
sources validated. `git diff --check` passed. Existing fixture non-Git/missing-cwd
warnings remain; new R3 fixtures are POSIX-only, not Windows execution proof.
During implementation two incomplete test managers needed supported `getBranch`
stubs, and two new type errors were corrected without changing the baseline.
CodeGraph was lazy-initialized in this dedicated worktree and a read-only query
succeeded; unsupported `explore --depth` failed before scoped source inspection.
No installs, dependency changes, live-model/profile execution, commits or delivery
operations by this writer. Actual SDK acceptance remains separately pending.

### New candidate boundary alignment: recorded cwd

Native `isAbsolute` plus existing Unicode-separator/control/surrogate and byte
boundaries now withhold ambiguous generated cwd as null and reject malformed
non-null readback; no resolver/Git call or prior path-rewrite defect is claimed.
RED: same five-file command, 201 passed / two failed (relative publication and
sidecar readback accepted). GREEN: 203 passed / zero failed, covering all 15
separators and healthy absolute cwd. Type/build/diff checks above passed again.
Curated publication/targeted list slice is complete; consultation/receipt, model
helper, correlated owner reply, and actual SDK acceptance remain pending.

## Unit 6: direct published-state consultation (metadata slice verified; SDK deferred)

Base `75644e32`, previous PR #1729 (388 lines; remote functional checks passed, CodeRabbit skipped for stacked base). Branch `feat/1702-metadata-consult`: a metadata-only `orchestrator_consult` reads the selected peer's whitelisted published projection and returns a bounded frozen snapshot with freshness, incompleteness and explicit non-authority. No receiver wakeups, private history reads or nested model calls. Prepare a permanent actual public-SDK fixture if the coherent slice fits the review budget; otherwise SDK acceptance is the next isolated unit, not a claimed success. Reasoning and correlated peer decisions remain separate; child queries cannot safely masquerade as peer requests.

- Registered `orchestrator_consult` accepts only metadata, exact stable recipient ID
  and optional existing catalog cursor. It reuses selected-activation discovery,
  checks the caller transport after asynchronous listing, and captures frozen JSON.
  No human picker/consent, private context reads, Git probes, launches or messages.
- Receipt bound: 16 KiB, otherwise explicit unavailable; no meaning truncation.
  Identity hashes public content plus activation/incarnation, never private activity.
  Presence observation is separate from historical notes/Git resolution times.
  Source `published_snapshot`, `ownerReply: false`, `authority: none`; paths/tasks
  are recorded context, not exclusive/global writer ownership or review consent.
- RED/GREEN command: `node --experimental-strip-types --test tests/orchestrator-consultation.test.ts tests/orchestrator-state.test.ts tests/orchestrator-catalog.test.ts tests/orchestrator-discovery.test.ts tests/orchestrator-presence.test.ts tests/gentle-agents.test.ts`.
  RED: 202 passed / two failed (missing module and registered consultation tool).
  Final GREEN: 207 passed / zero failed. An intermediate resolver spy incorrectly
  threw during startup; changed it to count/delegate baseline resolution instead.
- Alternates: first/next pages, exact omission counts, detached mutation, replacement,
  invalid cursors, stale/missing/wrong-selected publications, extra authority fields,
  oversized source/snapshot, unknown versus withdrawn notes and historical age.
  Corrupt private activity with an owner-history sentinel does not affect readback;
  private task getters throw if accessed. Registered harness sees no extra resolver
  calls, child launches, custom/user messages or consent selection.
- `node scripts/check-types.mjs`: 186 diagnostics, no regressions; 12 pairs improved.
  `node scripts/build-runtime-modules.mjs --check`: eight modules match; metrics
  sources validated. `git diff --check` passed. Existing fixture Git warnings remain.
- SDK fixture NOT written/executed: adding the isolated provider/two-session/worktree
  fixture would exceed this cohesive slice's 400-line budget; next isolated unit.
  No live model, paid/outbound API, interactive TUI or native Windows proof claimed.
  New owned OS-temp profiles are removed in teardown; no dependency mutation.
- CodeGraph root/index check preceded scoped source reads; index absent and init
  would write outside allowed surfaces. Read-only query confirmed uninitialized;
  narrow provided paths used. Installed SDK/extensions/custom-provider docs and
  relevant session-format/message-type/tool-example references were read.
- Assets keep the existing subject contract and add milestone publication guidance;
  core coordination prose is consolidated to protect the existing prompt budget.
  Dedicated prompt-budget suite was not authorized/run; parent should verify it.
  Both issues remain OPEN; parent owns mirror, assessment, commit and delivery.
  Rollback: consultation helper, conditional discovery binding, tool registration,
  tests/docs only; preserve published-state, catalog, identity and messaging bases.

### Authorized prompt follow-up: confirmed failures (no source fixes)
- `node --experimental-strip-types --test tests/orchestrator-budget.test.ts tests/orchestrator-rdd-ownership.test.ts tests/append-system-prompt-route.test.ts`: 44 passed / 2 failed (46 total); parent-only routing and RDD ownership passed.
- Controlled 128-character assets root renders 8,199 bytes, exceeding 8,192 by seven; Core Role verbatim contract rejects the condensed fixture:11 text. Delivery needs a bounded asset correction, not weakened tests.
- CodeGraph query remained uninitialized; no index created. Filename-scoped fallback found existing suites; owned OS-temp fixtures clean up in their teardown. SDK consultation acceptance remains deferred; no nested helper implemented.

### Asset correction: lazy placement verified
- Parent chose the existing lazy delegation guide for the entire milestone hint. `assets/orchestrator.md` now matches HEAD byte-for-byte (including original Core Role); no existing guardrails, fixtures or caps changed. New guidance sits beside delegation preparation, with safe own state, no extra turns/reads/noise and no consent authority.
- RED remains the observed 44 passed / two failed. GREEN: `node --experimental-strip-types --test tests/orchestrator-budget.test.ts tests/orchestrator-rdd-ownership.test.ts tests/append-system-prompt-route.test.ts`: all 46 passed, zero failures, including verbatim role and 128-character root budget.
- `node --experimental-strip-types --test tests/orchestrator-consultation.test.ts tests/orchestrator-state.test.ts tests/orchestrator-catalog.test.ts tests/orchestrator-discovery.test.ts tests/orchestrator-presence.test.ts tests/gentle-agents.test.ts`: all 207 passed, zero failures; existing fixture Git warnings remain.
- `node scripts/check-types.mjs`: 186 diagnostics, no regressions, 12 pairs improved. `node scripts/build-runtime-modules.mjs --check`: eight modules match; metrics validated. `git diff --check` passed.
- Controlled-long render is 8,176 bytes (derived from prior measured 8,199 minus the 23-byte asset restoration); the unchanged cap test independently passes. Full working slice including parent/staged/new files: 319 changed lines; staged content untouched, parent must restage final restoration and lazy asset.
- Owned temporary fixture teardown retained. SDK artifact/execution and nested helper remain absent; both issues stay open pending separate acceptance and parent delivery.

## Unit 7: actual public-SDK acceptance (functional acceptance verified)

Base `49592c5a`, previous PR #1733 (319 lines; 207 functional and 46 prompt checks passed). Branch `test/1702-consultation-sdk`. Permanent installed SDK 1.0.0 fixture uses `DefaultResourceLoader.reload`, `createAgentSession`, `bindExtensions`, local `registerProvider` and `session.prompt` against production Gentle Agents/Shell tools. Two distinct managers/cwds share an owned trusted profile; a fresh third runtime replaces the owner. No fake business context/private SDK calls, transport adapter, paid/outbound calls or OS child agents.

- Curated objective/progress/decisions/blockers persist via production `pi.appendEntry` on the actual branch, preserving a human name. Actual SDK message entries contain private sentinels absent from frozen receipts. Historical recordedAt/digest, published source, ownerReply false and authority none are asserted.
- Nine then ten actual detached Git worktrees are registered through the SDK tool. First/opaque next pages expose roots beyond eight while Git facts remain the bounded prefix. Membership invalidates old cursors; private history plus omitted state leaves continuation/digest unchanged. Null withdrawal persists and survives SessionManager.open; disposed old owner is unavailable and replacement has unknown fresh notes, no resurrection.
- Each tool prompt has exactly two local driver iterations, not zero model calls. Caller consultations leave owner model count unchanged and add zero measured resolver/Git calls between tool start/end; whole shell prompt setup still probes Git. No 1,000-projection measurement or child-execution proof claimed.
- Output authorization has two selectors: owned 0700 OS-temp root for profile/Git/settings/auth/models/sessions, plus production's exact profile-derived 32-hex socket leaf under canonical /tmp/gentle-pi-<uid>. Preexisting leaf aborts before SDK startup. Actual socket paths, private UID/mode and canonical containment are checked. Captured public production shutdown callbacks receive actual SDK contexts before dispose, which alone does not emit shutdown. Bounded polling verifies presence withdrawal/empty sockets; revalidation precedes nonrecursive rmdir of only that leaf. Never delete UID parent/historical leaves; owned root removal and no-recreation checks follow. Windows explicitly skips.
- Ordinary acceptance addition for existing behavior: strict TDD not active; fixture-development failures are not production RED. Earlier semantic RED evidence stands separately. Initial passing attempt lacked socket-leaf confinement; only the guarded rerun is current acceptance evidence.
- Focused command `node --experimental-strip-types --test tests/orchestrator-consultation-sdk.test.ts`: 1 passed. Authorized ten-file consultation/state/catalog/discovery/presence/agents/budget/RDD/append suite: 254 passed, zero failed; existing non-Git/missing-cwd fixture warnings remain.
- `node scripts/check-types.mjs`: 186 recorded diagnostics, no regressions; 12 pairs improved. `node scripts/build-runtime-modules.mjs --check`: eight modules match, metrics validated. `git diff --check`: passed.
- CodeGraph absent; initialization prohibited outside edit surfaces, narrow known paths used. No production edits, dependency mutation or delivery operations. Both issues remain open for parent whole-feature audit; reasoning helper and correlated owner decisions remain pending. No human consent, native verdict, interactive TUI or Windows runtime claim.

## Unit 8: internal one-run read-only helper (core verified; public integration pending)

Base `d12c8ca5`, previous PR #1734 (347 lines; actual SDK parent rerun passed, combined 254 tests passed). Branch `feat/1702-bounded-helper`. Add an internal SDK-stream engine using only captured published metadata and an explicit question, without tools, history, agents or owner wakeups. Bound total input, requested output, local deadline, concurrency, abort/source checks and actual usage; never retry. Provider abort/token limits are requests, not guaranteed billing caps. No public reasoning route or human permission is activated here: the next integration unit must obtain real UI opt-in bound to the live session/model. Correlated owner decision delivery remains separate.

- Internal `OrchestratorHelper` uses public `ModelRegistry.streamSimple` only;
  SDK imports are type-only. One static system prompt plus one user JSON message,
  nested public-field whitelists, no tools/history/resource files/environment export.
  Source unknowns/omissions and historical times remain visible; capability cursor
  is excluded. Required real-host currentness closure binds caller/selected snapshot.
- Limits: 16 KiB total input, nonempty/control-free 1,024-byte question, requested
  512 tokens/minimal reasoning, 4,096-byte text, local deadline at most 20 seconds.
  No retries. Hard race returns timeout/cancellation even when abort is ignored;
  cancel retains the single-engine lease until actual result settlement. Hung
  providers remain busy. Requests/abort are not guaranteed remote price caps.
- Advice envelopes retain non-authority, captured digest/time/target, model IDs,
  request caps and whitelisted finite nonnegative usage/cost or unknown. Length
  is partial; errors/tool calls/empty/oversized/stale outputs are unavailable, not
  owner negatives. Thinking is dropped; textual grant claims stay untrusted text.
- RED: `node --experimental-strip-types --test tests/orchestrator-helper.test.ts`
  failed the runnable concurrent behavior (`undefined !== 'busy'`); baseline
  invoked two controlled streams. GREEN: same command now passes all seven tests.
  Alternates cover ignored abort/late rejection/lease reuse, caller/engine cancel,
  replacement before/after, private nested getters, detachment, exact UTF-8 input
  and output boundaries, partial/error/tool outcomes and sanitized setup failures.
- Full authorized seven-file helper/consultation/state/catalog/discovery/presence/
  agents command: 214 passed, zero failed; existing non-Git/missing-cwd fixture
  warnings remain. `node --experimental-strip-types --test tests/orchestrator-consultation-sdk.test.ts`:
  one passed, unchanged guarded fixture; actual SDK metadata regression only,
  NOT helper nested-stream acceptance. Engine tests use pure local SDK-compatible
  controlled streams with no profile/socket outputs or paid/external requests.
- `node scripts/check-types.mjs`: initially four new diagnostics, fixed; final
  186 diagnostics, no regressions, 12 pairs improved. Runtime `--check`: eight
  modules match, metrics validated. CodeGraph index absent; initialization would
  violate edit surfaces, so known narrow reads used. Installed SDK/extensions/
  models/custom-provider docs, relevant message/example crossrefs and actual
  public registry/context/options/stream declarations inspected before API use.
- Next unit: real host tool/human UI opt-in and actual SDK nested-stream proof.
  Both issues remain OPEN; no public reasoning/owner reply, human approval/native
  verdict, interactive TUI or Windows proof claimed. Parent prep preserved;
  parent owns mirror, assessment/review, commits and delivery. Rollback boundary:
  new internal helper/test plus this unit's docs/task text only.

## Unit 9: explicit opt-in reasoning consultation (in progress)

Base `938e06e6`, previous PR #1735 (385 lines; 214 functional tests and metadata SDK regression passed). Branch `feat/1702-reasoning-consult`. Connect the bounded helper to an explicit reasoning mode of `orchestrator_consult`, with real supported UI choice and live session/model/target-bound, revocable in-memory cost permission. Metadata remains the default zero-call lane; headless mode fails closed. Revalidate source and caller around dialogs/model work, retain hard non-authority and never derive consent from messages or published notes. SDK nested-call acceptance must be separate evidence from metadata-only SDK proof; correlated owner decisions remain a later protocol unit.

### Unit 9a: permission coordinator and host guard (public wiring deferred)

One authorized cohesive slicing pass keeps this unit under the full 400-line
review budget: shared helper preflight/busy guard plus ephemeral cost-permission
coordinator, deterministic tests and docs. No extension/public tool edits; the
public reasoning and revocation modes, lifecycle hookup and actual nested-SDK
acceptance remain Unit 9b. The coordinator requires live host/source callbacks;
it is not a second authority registry and never starts a run just to grant.

- RED: authorized eight-file Node command reported 214 passed / one failed,
  missing new permission module (import-boundary RED, not a registered-mode
  behavior failure). GREEN: same command finally reported 221 passed / zero
  failed, including scope eviction, running-source/host changes, missing model,
  pre-abort, in-place provider/ID changes and sanitized UI errors.
- Simulated UI tests cover closed denial/unknown choices, headless, malformed and
  oversized inputs before UI, once versus session reuse, changed public snapshots,
  exact manager/ID/cwd/model/registry/target isolation, pending concurrency,
  abort/revoke/changed-source-after-dialog and hung lease across registry changes.
  Published decision text grants nothing; no real human UI proof is claimed.
- Actual existing SDK command passed one metadata regression only; no nested
  helper, interactive TUI, public reasoning denial or owner decision proof.
- CodeGraph root/index check failed before scoped reads; no out-of-scope init.
  Full installed SDK/extensions/TUI/RPC/models and relevant UI/session/virtual-model
  references plus actual public context/dialog/registry declarations were read.
  Parent preparation is preserved; parent owns mirror, review and delivery.
  Both issues remain OPEN. Rollback: coordinator/tests, shared preflight/busy API
  and this slice's docs only; preserve metadata/core execution contracts.
- Final `node scripts/check-types.mjs`: 186 diagnostics, no regressions, 12 pairs
  improved; one new fixture literal-inference diagnostic was corrected first.
  `node scripts/build-runtime-modules.mjs --check`: eight modules match, metrics
  validated. `git diff --check` passed. Existing non-Git fixture warnings remain.
  No installs, dependency/profile/source mutation outside authorized fixtures,
  staging, commits, pushes, PRs, spawning/delegation or merge operations.
### CI fixture readiness correction (local verification; remote recovery pending)
- Historical CI RED supplied by parent: run `37156574198`, job `111301069665`, SDK line 199 expected two records but observed one; 4,637 passed / one failed / 34 skipped. Logical sender ID exists before asynchronous socket publication and is not transport readiness. No new production RED or delayed-start reproduction claimed; strict TDD not active.
- Each actual SDK host now awaits its own SessionManager ID in private transport presence with an actual socket under the exact guarded leaf, a five-second deadline and short I/O yields. The exact two-record assertion remains, strengthened with owner/caller IDs, schema and private file UID/mode checks; no extra model turns or production changes. Replacement uses the same guard; 30-second test cap and owned-output cleanup remain unchanged.
- Focused SDK command above passed three consecutive runs (one test each); the same authorized ten-file suite passed 254/254. Type check: 186 baseline diagnostics, no regressions; runtime check: eight modules match; diff whitespace check passed. Existing fixture Git warnings remain.
- Read-only CodeGraph exploration preceded narrow inspection in this indexed worktree. Parent must propagate the fix through feature branches and obtain fresh remote checks; neither PR's CI recovery nor full-repository validation is claimed. Both issues remain OPEN.

## Unit 9b: public reasoning/revocation tool (functional verification complete; parent review pending)

Base `152855c5`, previous PR #1736 (338-line coordinator slice). SDK startup fix propagated through feature-only merges; fresh #1734/#1735 functional CI passed. Wire explicit reasoning and restrictive revocation into `orchestrator_consult`, preserving metadata as the zero-call default. Actual supported UI supplies cost permission; clear it on every lifecycle boundary, revalidate live caller/model/public source and preserve a still-billable engine lease across runtime replacement. No owner decisions or automatic conversation sharing. SDK nested-helper proof must explicitly distinguish simulated UI choices from real human consent.

- Public kinds are metadata (default), reasoning with required bounded question,
  and restrictive revoke-reasoning. Invalid/irrelevant arguments fail before
  effects; no implicit question routing or helper fallback from unknown metadata.
  Actual SDK context getters supply live caller/model/registry/UI, never grants
  from notes. Canonical selected peer/page and public digest are revalidated
  around dialog/execution; post-execution read retains epoch/model checks.
- Supported lifecycle events clear permissions/cancel work before losing old
  callback authority. A global-symbol weak registry-keyed execution-only map
  survives Pi's moduleCache:false reload loader. Hung ignored-abort streams block
  replacement coordinators without UI until settlement; no grant inheritance.
  Each coordinator owns its cancellation handle, not a successor's engine.
- Meaningful RED: required eight-file Node command observed 221 passed / two
  failed: registered reasoning threw Invalid metadata consultation parameters;
  replacement coordinator started another stream and timed out instead of busy.
  Earlier missing publisher label was a corrected test-fixture error, not RED.
  GREEN: same exact command now passes 224/224. Simulated UI covers deny/once/cache,
  revoke, headless/print/json/RPC, updated public snapshot, running public/canonical
  changes versus private activity, caller/model replacement, cancellation and
  lifecycle scope/pending-choice discard. No real human approval proof claimed.
- Actual SDK command passes one permanent fixture, including new JSON/no-UI
  permission-required denial with exactly two local driver turns, zero nested
  helper calls and unchanged receiver count. Existing guarded socket startup and
  two output selectors/cleanup remain intact. Actual nested-helper SDK execution,
  interactive TUI/human permission and native Windows proof remain DEFERRED.
- Both issues remain OPEN; no correlated owner decision, consent receipt or native
  verdict fabricated. Assets/default list/identity and prompt budgets unchanged.
  Parent prep preserved; mirror, assessment, remote CI and all Git delivery remain
  parent-owned. Rollback: this unit's tool/coordinator/test/doc edits only.
- `node scripts/check-types.mjs`: 186 baseline diagnostics, no regressions, 12
  pairs improved. Runtime `--check`: eight generated modules match; metrics
  validated. `git diff --check` passed. Existing fixture Git warnings remain.
  CodeGraph explore failed without an index before narrow reads; initialization
  would violate edit surfaces. Installed relevant SDK/extensions/TUI/RPC/virtual
  model docs/references and live context/UI/registry/lifecycle declarations were
  inspected. No installs, shared-profile mutations or Git delivery operations.

## Unit 10: actual nested-helper SDK acceptance (functional and independent integration verification complete)

Base `983453e9`, previous PR #1737 (327 lines; 224 functional and actual SDK headless-denial tests passed). Branch `test/1702-reasoning-sdk`. Extend the permanent public-SDK fixture to execute the real nested registry stream through supported host UI bindings with explicitly simulated choices. Assert one helper call, published-only context, limits/usage/non-authority, session permission reuse and revoke/re-prompt; keep metadata/JSON zero-call and receiver untouched. This proves SDK integration, not actual human consent or interactive TUI. Keep both exact owned output selectors and actual transport-readiness polling. Owner decision protocol remains outstanding; the Windows candidate-marker defect is corrected by prerequisite PR #1739.

- Verified installed public `AgentSession.bindExtensions(bindings: ExtensionBindings): Promise<void>` with `mode: "rpc"` and fully typed `uiContext: ExtensionUIContext`; actual SDK getters assert RPC/hasUI. Simulated closed selector choices are test-host responses, NOT real human consent, interactive TUI or RPC wire-client proof. No private context/mode assignment, direct executeTool, production edits or OS child agents.
- Four distinct SDK managers/runtimes (owner, JSON caller, eligible RPC caller, replacement owner) have unique local provider/API IDs. Original two-record/private actual-socket assertions and bounded per-host transport readiness precede the extra caller. Existing nine→ten worktree pagination, frozen history exclusion, withdrawal, SessionManager.open and replacement assertions remain.
- Five nested registry streams measured separately from exactly two main driver turns per tool prompt. Each gets static read-only system plus one public question JSON message, no tools, actual private owner/caller history or parent instructions, raw capabilities or cursor. Public page/digest/unknowns/omissions, requested 512/minimal/none/zero retries/abort, finite fake usage/model IDs and non-authority envelope are asserted. Published fee claims/helper text never grant authority.
- Metadata, headless JSON, decline/unknown add zero helpers. Once re-prompts; session choice reuses changed owner publication under the same SID without UI; revoke has zero UI/helper and requires fresh choice. Owner adds zero calls during consultations except explicitly counted intentional publication prompts. Caller-cwd Git probes remain zero inside consultation; owner publication/shell setup are excluded, not hidden.
- Controlled deferred real SDK helper result plus actual owner-publication change discards old advice as stale-source, no retry. Hung ignored-abort leases/runtime replacement remain controlled unit evidence; no new SDK lease or canonical-replacement-race claim. Both exact output selectors/guarded cleanup and environment restoration remain unchanged; Windows skips.
- Strict TDD not active: ordinary existing-feature acceptance, not production RED. Development failures exposed incomplete UI presentation stubs, wrong cross-page digest expectation and a global Git counter including intentional concurrent owner setup; corrected without weakening caps/readiness or changing production.
- Focused `node --experimental-strip-types --test tests/orchestrator-consultation-sdk.test.ts`: passed three consecutive final runs (one case each, including the combined-suite run). Required twelve-file helper/SDK/consultation/state/catalog/discovery/presence/agents/budget/RDD/append command: 271 passed, zero failed; existing fixture non-Git/missing-cwd warnings remain.
- `node scripts/check-types.mjs`: 186 baseline diagnostics, no regressions, 12 pairs improved. `node scripts/build-runtime-modules.mjs --check`: eight modules match, metrics validated. `git diff --check`: passed. Full A+D delta including parent preparation is below 400 lines.
- CodeGraph status: dedicated worktree uninitialized; no out-of-scope index created, narrow supplied reads used. Full relevant installed SDK/extensions/TUI/RPC/models/custom-provider/virtual-model and UI/session/message/configuration/settings/theme/security references plus public binding/UI/registry/stream declarations inspected. Parent preparation preserved; no installs, shared-profile writes, staging, commits, delivery or merge operations. #1701/#1702 remain OPEN for parent audit. Historical Windows identifiers were not logged; subsequent correction and native Windows CI are recorded below.

## Merge-readiness corrections

Prerequisite #1739 repairs candidate-owner dev/ino Number collisions with same-observation bigint stats (Refs approved #343; marker format and ACL/privacy unchanged). Current-main RED: existing preservation case passed, modeled marker/directory replacements failed; GREEN 3/3. Independent verifier reran candidate/repository suite: 165 passed, eight platform skips. Native Windows, Linux/macOS and packed-install checks passed for exact fix `89736a4d`. Root #1714 now targets its feature branch; merge order starts #1739 then #1714 through the existing chain. No main merge, auto-merge or reload performed.

Current main `a87192ee` propagated by feature-only ancestor merges. Integration preserved helper and upstream BridgeWake code; fixture managers retain entries and branch APIs. Original subject guidance moved verbatim to existing lazy coordination detail, restoring unchanged 8,192-byte guards; subject/canonical suite 49/49. Combined integration suite 453 passed/eight skipped (461 total); independent SDK/permission/BridgeWake integration suite 271/271. Types: 186 baseline diagnostics/no regressions; eight runtime modules match.

New ancestor CI exposed metadata SDK's global Git counter including peer asynchronous publication (178 versus 176). Scope the unchanged zero-Git assertion to each host's injected resolver; nested fixture retains caller-root attribution. Focused actual SDK passed after propagation; corrected #1736 exact `ef913d39` passed Linux, macOS, native Windows, type/runtime/package checks. Final documentation-only tip awaits fresh checks; all slice additions plus deletions remain below 400. Existing SDK simulated-UI, no-authority and owner-decision limitations above remain unchanged.
