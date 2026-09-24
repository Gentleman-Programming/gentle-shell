# Tasks: simplify SDD runtime interpretation — Pi ownership

This self-contained adoption/current-state record preserves the complete approved task plan and records implementation separately from independent acceptance. Current persisted task state: 14 tasks, 13 complete and 1 pending. Checked AI work is an accepted external prerequisite, never work performed by this repository. Retain automatic mode, OpenSpec artifacts and ask-on-risk.

AI units 1–3 are accepted externally; task 3.1 now includes implemented Pi preservation, with combined unit-2 independent review pending. The adopted external boundary is candidate tree `872fa03dd00d62b3189ed6793abde923e53fee6c`, `ai-runtime-recovery` generation 7 complete, no active attempt. This supersedes historical pending reconciliation notes, not immutable rejection history. Accepted R3 is bounded marker detection, not universal atomicity: detected stale success emits no usable authority; replacement instances inherit no roots; external replacement racing publication may leave immutable historical records. Preserve committed-error receipt identity and publication failures. Do not reopen/reset AI or change its accepted candidate. Pi units 1–3 are implemented; unit 3 (task 4.3) awaits parent-owned independent review. Historical unit-2 review notes below are retained as provenance. No external attempt or authority is imported.

All commands below are future proof requirements, not authorization to execute them now. AI paths/commands belong to the external AI repository; Pi paths/commands belong here. Source line numbers and provisional diagnoses require current-code re-evaluation.

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | Pi units 1–4: provisional 300–390, 280–390, 330–400, 210–290 authored A+D; recount against actual code before admission |
| 400-line target risk | High; justified cohesive overruns allowed, not a larger native attempt budget |
| Chained PRs recommended | No |
| Suggested internal sequence | Pi 1 → 2 → 3 → 4; accepted AI units are external prerequisites |
| Delivery strategy | exception-ok |
| Chain strategy | size-exception |

Exactly one eventual Pi PR uses `size:exception`. Internal units are verification/rollback boundaries, not PR slices. Full planning documents count toward the eventual PR; the final total is not yet measured. No branch, commit, PR, publishing, installation or live-provider/child execution is authorized. Native status alone does not grant execution; require fresh correctly scoped `proceed` before future work.

## Delivery topology, forecasts and execution rules

Keep seven internal functional units (AI 3, Pi 4), each behavior/tests/fixture migrations/shipped guidance together. Independent verification precedes advancement; never defer repair of a broken slice. The current policy supersedes historical hard-400, integrator-only exception, branch-chain and pre-implementation design-review stops, not finite budgets, history or consent.

The cross-repository plan retains proposed final branch names `feat/sdd-runtime-simplification-ai` and `feat/sdd-runtime-simplification-pi`, each targeting its repository's `main`; create neither now. No child branches, tracker bases or predecessor PR bases. One final PR per repository is intended, both `size:exception`; Pi owns only its eventual PR. Internal units are verification/rollback boundaries, not delivery slices. Final tuple acceptance authorizes no merge.

| Repository / internal unit | Focus | Provisional authored A+D |
|---|---|---:|
| AI 1 (1.1–1.4) | pure status, continue, marker binding, fixture migrations/proofs | 711–881 before historical planning correction |
| AI 2 (AI 3.1) | admission/recovery preservation | 60–85 |
| AI 3 (4.1–4.2) | demonstrated runtime/replay/remediation plumbing | 250–330 |
| Pi 1 (2.1–2.3) | v2 consumer, distinct handlers, host scope | 300–390 |
| Pi 2 (Pi 3.1, 3.2) | selected grants, bounded persistence | 280–390 |
| Pi 3 (4.3) | typed remediation, bracket transport | 330–400 |
| Pi 4 (5.1) | installed uptake, boundary proof | 210–290 |

Historical AI unit 1 reforecast recorded 711–881 A+D against original implementation and 350–560 next-edit A+D before that planning correction. The conditional proposed 950 ceiling was never ratified and is not a hard gate/native limit. Cohesive behavior, both fixture migrations and missing proofs justified overrun, not compressed prose/dropped assertions. That three-file correction was measured separately against preceding bytes, not charged to the old 25–40 documentation allowance. Older task allocations below are provisional, superseded by whole-unit reforecast. Recount subsequent work against actual candidates including tests/guidance. Neither final PR total is measured; include complete planning documents, not implementation-only subtotals or just this correction's delta.

Required final tuple: one AI build identity, one Pi build identity, installed asset manifest/content and `gentle-ai.sdd-status` v2 floor, proving producer → Pi → managed child. Process success, child self-report or decoder-only tests are insufficient.

For every unit:

- Run preservation before defect RED; record RED → GREEN → TRIANGULATE → REFACTOR truthfully, with paired tests/assets.
- Implementer records commands/artifacts/rollback; a different verifier reruns commands, inspects artifacts/records/diff and provides acceptance. Exit alone is insufficient.
- Retire local live dispatch, exact-three assumptions, native-Engram bans and legacy guidance only after callers upgrade. Historical records remain readable; no dual-live reader/compatibility layer.
- No engine, ledger, framework, generator, new protocol/command, automatic reset, source reuse, upstream dependency or speculative test outside guarantees. Proposed source edits require their defect RED.

## 1. AI unit 1 — accepted external prerequisite

### 1.1 Preserve the existing v2 status contract before defect tests
- [x] **Start → end:** Start from the current AI v2/status behavior; add only preservation characterizations ending with an explicit baseline for seven dependencies, four instruction groups, and opaque present-consent output. Runtime settlement/replay preservation is owned solely by 4.1 and is not counted here.

  - **Paths:** AI `internal/sddstatus/status_v2_clean_break_test.go`.
  - **Depends on:** maintainer implementation authorization; no prior unit. **Forecast:** provisional 40–50 AI unit 1 lines.
  - **Focused command (future):** `go test ./internal/sddstatus -count=1 -json`.
  - **Managed/native boundary:** N/A—native preservation; uptake in 5.1. **Independent proof:** JSON record includes each intended case; no legacy live normalization. **Rollback:** remove only added characterization cases.

### 1.2 RED: specify pure status, explicit continue preparation, and stale-marker refusal
- [x] **Start → end:** Start with status able to initialize/overwrite marker state and grant not comparing current persisted identity; end with failing tests that require read-only status snapshots, authorized continue preparation, no-replace/readback convergence, and A→recreated-B stale grant refusal.

  - **Paths:** proposed AI `internal/cli/sdd_status_continue_consent_test.go`, `internal/cli/sdd_attempt_marker_binding_test.go`; `internal/sddstatus/status_v2_clean_break_test.go`. Historical genuine RED: `TestSDDStatusDoesNotPrepareConsentMarker`, `TestSDDAttemptRefusesRecreatedMarker`. Historically already-passing `TestSDDContinuePlanningMarkerScopePreparesWhileApplyStaysBlocked` and `TestSDDContinueRefusesWithoutMarkerScope` are preservation, not defect RED. Classify remaining proofs truthfully.
  - **Depends on:** 1.1. **Forecast:** provisional 80–100 AI unit 1 lines.
  - **Focused command (future):** `go test ./internal/cli ./internal/sddstatus -count=1 -json`; distinguish two historical defect failures from preservation/new gaps. Verify actual `run` and assertions, not filename filters.
  - **Managed/native boundary:** native CLI repeated status has byte-identical marker/authority snapshots; explicit preparation re-renders v2 while source roots remain ungranted/apply blocked. Human marker-scope precheck belongs to Pi 2.2–2.3/5.1, not writable native fixtures. **Independent proof:** observed RED creates no attempt/grant/artifact rewrite. **Rollback:** delete only proposed RED cases.

### 1.3 GREEN: move preparation to existing continue and bind grant to the persisted marker
- [x] **Start → end:** Start from 1.2's failing cases; end with `RunSDDStatus`/`Resolve` pure, only existing `RunSDDContinue` preparing an active selected OpenSpec marker when the current human scope includes the planning-directory marker path (even if source edit roots remain ungranted and apply stays blocked), and grant/replay refusing absent/mismatched/recreated identity without minting or authority append.

  - **Paths:** AI `internal/cli/sdd_status.go`, `internal/sddstatus/status.go`, `internal/sddstatus/edit_authority_consent.go`, `internal/cli/sdd_attempt.go`, `internal/sddstatus/runtime_ledger.go`; retain 1.2 tests. Migrate both `e2e/organicruntime/sdd_consent_wiring_e2e_test.go` loops in this unit using built-binary explicit continue then read-only status. Preserve initial no-marker/no-authority, missing-root ordering, exact grant/decline, same-parent readiness, foreign-common-directory blocking and single-repository byte identity. Keep `consentStatus` read-only; no invented tokens.
  - **Depends on:** 1.2. **Forecast:** provisional 150–190 lines including proofs and paired `internal/assets/opencode/commands/sdd-status.md`, `sdd-continue.md`, `internal/assets/skills/_shared/sdd-status-contract.md` guidance.
  - **Focused commands (future):** unfiltered 1.2 JSON command; `go test ./internal/cli ./internal/sddstatus -count=1`; `go test ./... -count=1`; `go vet ./...`. Independently inspect both fixture loops and missing proofs; historical focused passes alone do not accept.
  - **Managed/native boundary:** explicit preparation returns bound consent with source roots ungranted/apply blocked; compare repeated absent/present marker, artifact, authority, allowed-root snapshots. Unsafe/ambiguous selection, out-of-root and unwritable-at-entry publish nothing. Detected concurrent replacement emits no usable consent, not universal zero-write pathname atomicity. Host owns actual human read-only/excluded-marker suppression. Directory-at-marker is filesystem failure, not scope or unwritable-directory proof.
  - **Independent proof:** concurrent winner readback, malformed/readback failure, stale A versus absent/persisted distinct B retaining A's prior grant; refusal preserves marker/authority/attempt state. Shared publisher fallback may expose partial bytes: retain limitation/proof gap and fail-closed readback; no universal visibility claim or shared publisher redesign. **Rollback:** paired behavior/assets/tests/both organic fixture migrations together; never delete markers/history/budgets.

### 1.4 TRIANGULATE/REFACTOR: consolidate resolver facts without new status protocol
- [x] **Start → end:** Start with passing primary status/continue tests; add malformed marker, publication failure, valid grant replay, Engram-only no-marker, and nullable discovery triangulation; end with shared internal missing-root facts rather than diagnostic parsing and no new public field/token/reason enum.

  - **Paths:** AI `internal/sddstatus/status.go`, `internal/sddstatus/edit_authority_consent.go`, proposed `internal/cli/sdd_status_continue_consent_test.go`, `internal/cli/sdd_attempt_marker_binding_test.go`.
  - **Depends on:** 1.3. **Forecast:** old 25–35 allocation superseded by whole-unit reforecast; negative proofs remain required.
  - **Focused command (future):** unfiltered 1.2 package command with `-count=1 -json`; verify named cases ran.
  - **Managed/native boundary:** N/A—native negatives in 1.3; internal permutations here. **Independent proof:** `ensureChangeInstanceMarker` unreachable from `Resolve`, unchanged schema/version. **Rollback:** only triangulation/refactor hunks, preserving 1.3.

## 2. Pi unit 1 — implemented in this repository

### 2.1 Preserve supported consumer behavior before decoder defects
- [x] **Start → end:** Start from accepted current supported-action behavior; characterize supported status rendering and refusal-before-execution without preserving the exact-three defect; end with a baseline that remains valid after v2 expansion.

  - **Paths:** proposed `tests/native-review-cli-sdd-status-v2.test.ts`, `tests/sdd-status-continue.test.ts`.
  - **Depends on:** independently verified AI unit 1 fixture/CLI and Pi implementation authorization. **Forecast:** provisional 55–75 Pi unit 1 lines.
  - **Focused command (future):** `node --experimental-strip-types --test tests/native-review-cli-sdd-status-v2.test.ts tests/sdd-status-continue.test.ts`.
  - **Managed/native boundary:** N/A—consumer preservation; child in 5.1. **Independent proof:** producer-emitted v2, not invented legacy alias. **Rollback:** only proposed baseline cases.

### 2.2 RED: require the complete producer contract and no status-to-continue fallback
- [x] **Start → end:** Start with the baseline; end with failing cases for all emitted action tokens, seven dependencies, optional four instruction groups, nullable discovery, wrong identity, malformed/unknown action, misleading prose, and separate status/continue calls.

  - **Paths:** proposed `tests/native-review-cli-sdd-status-v2.test.ts`, `tests/sdd-status-continue.test.ts`; `tests/gentle-agents.test.ts`.
  - **Depends on:** 2.1 and AI unit 1 producer fixture. **Forecast:** provisional 110–145 Pi unit 1 lines.
  - **Focused commands (future):** 2.1 command plus `node --experimental-strip-types --test tests/gentle-agents.test.ts`; record RED first.
  - **Managed/native boundary:** `handleSddStatusCommand` cannot mutate; expressly authorized continuation alone calls mutating adapter. Read-only/excluded-marker human scope suppresses it; marker-only planning authorization may call without source roots. **Independent proof:** malformed/prose routes never launch phases. **Rollback:** only RED cases.

### 2.3 GREEN/TRIANGULATE/REFACTOR: cut live reads to native v2 and keep handlers distinct
- [x] **Start → end:** Start from 2.2 RED; end with native v2 decode/rendering and `sddStatus` read-only, a narrow authorized `sddContinue` adapter call, and no live local readiness reconstruction, `resolve-via-engram`, prefixed-token inference, automatic fallback, or `instructions` alias.

  - **Paths:** `lib/native-review-cli.ts`, `lib/sdd-status.ts`, `lib/sdd-preflight.ts`, `extensions/gentle-ai.ts`, `assets/agents/sdd-apply.md`; retain 2.1–2.2 tests.
  - **Depends on:** 2.2; synchronize with independently verified AI unit 1 before tuple acceptance. **Forecast:** provisional 135–170 lines including guidance in Pi unit 1.
  - **Focused commands (future):** 2.2 commands, then package-declared `pnpm test`.
  - **Managed/native boundary:** status/startup use native status only; authorized continue alone invokes native continue, displays preparation text without executing it. **Independent proof:** verifier runs handlers against AI unit 1 binary/fixture and checks logs for no fallback/mutation. **Rollback:** consumer/handler/asset/tests together to proven tuple, no dual-live reader.

## 3. Pi unit 2 — implemented; independent review pending

AI unit 2's native portion of 3.1 is accepted externally. It proves native admission and instruction contracts, not Pi host execution. The Pi implementation checkbox is now complete; independent acceptance remains a separate parent-owned review.

2A selection/extension transport and 2B bounded artifact persistence/readback are implemented (123 focused tests pass). Tasks 3.1 and 3.2 are checked as implementation completion, not independent functional-unit acceptance or advancement; parent owns combined unit-2 review. See cumulative apply-progress for evidence.

### 3.1 Preserve native and managed admission/recovery facts before defects
- [x] **Start → end:** Start with closed native declaration/admission and the currently supported managed route; end with separate preservation cases for exact class grants, matching/one-sided/missing-intent recovery, strict stale/divergent refusal, confirmed proposal handoff that does not interview, and automatic unresolved choices emitted once as a lossless grouped prompt—without encoding a whole-phase tool denial as desired behavior.

  - **Paths:** AI `internal/agents/researchcapability/contract.go`, `internal/components/sdd/research_state_contract_test.go`; Pi `tests/sdd-research-capabilities.test.ts`, `tests/sdd-research-live.test.ts`. Proposed unique native preservation names: `TestConfirmedProposalHandoffDoesNotInterview`, `TestAutomaticUnresolvedChoicesEmitOneGroupedPrompt`.
  - **Depends on:** independently verified AI unit 1 only for shared status scope facts. **Forecast:** provisional 60–85 AI and 45–65 Pi lines in their respective unit 2.
  - **Focused commands (future):** AI `go test ./internal/agents/researchcapability ./internal/components/sdd -count=1 -json`; Pi `node --experimental-strip-types --test tests/sdd-research-capabilities.test.ts tests/sdd-research-live.test.ts`. Verify JSON `run/pass` for the two names and `TestHybridRestartRequiresByteEqualStateWithoutStorePreference`.
  - **Managed/native boundary:** N/A—preservation; selected transport in 3.2/5.1. **Independent proof:** no host-inventory engine/new capability class. **Rollback:** only characterization cases.

### 3.2 RED/GREEN/TRIANGULATE/REFACTOR: provision only selected admitted routes while retaining authorized persistence
- [x] **Start → end:** Start with failing cases for documentation/open-web exact selected grants, inactive/missing extension tools, separately authorized read/write/Engram persistence, narrowed OpenSpec path, wrong worktree, and denial persistence; also require missing-tool denial → corrected capability/artifact facts → continuation with the **same** bounded selected-store path/scope, never a broadened or replacement scope. End with existing launch data carrying selected classes/per-class grants and actual extension selection, with child-local inventory recheck.

  - **Paths:** `lib/sdd-research-capabilities.ts`, `extensions/gentle-agents.ts`, `lib/agents-runner.ts`, `assets/agents/sdd-research.md`; retain 3.1 tests.
  - **Depends on:** 3.1 and independently verified Pi unit 1. **Forecast:** provisional 235–325 Pi unit 2 lines.
  - **Focused commands (future):** 3.1 Pi command first demonstrates RED; after GREEN, package-declared `pnpm test`. Verify named continuation retains identical bounded scope through denial/correction.
  - **Managed/native boundary:** fixed extension selection, selected tools callable; each absent/inactive route blocks collection/proposal while authorized selected-store persistence remains. **Independent proof:** inspect actual child allowlist, loaded extension selection, both OpenSpec/Engram locator readbacks, not self-report. **Rollback:** selected-class plumbing/research asset/tests together; retain intent/evidence, never broaden roots/switch stores.

## 4. Native recovery prerequisite and Pi unit 3

### 4.1 Preserve existing native settlement and replay guarantees before defect RED
- [x] **Start → end:** Start from existing runtime tests; end with distinct characterization cases for finite failed/interrupted/no-diff settlement, replay receipt idempotency, caps, failed-evidence binding, and fresh-selection strictness, without asserting the reported successor-acquire connection already passes.

  - **Paths:** AI `internal/sddstatus/runtime_compact_test.go`, `runtime_truthful_remediation_settle_test.go`, `verification_test.go`.
  - **Depends on:** 1.1 and independent acceptance of preceding AI units; AI unit 3. **Forecast:** provisional 30–45 lines, sole AI unit 3 preservation allocation.
  - **Focused command (future):** `go test ./internal/sddstatus -count=1 -json`; verify actual intended cases including `TestCompactAcquire*`, `TestCompactSettle*`, `TestRuntimeFinishRecordsTruthful*` and verification cases, not filename filtering.
  - **Managed/native boundary:** native acquire/settle preservation. **Independent proof:** no verifier-success prerequisite for failed/interrupted settlement. **Rollback:** only characterization cases.

### 4.2 RED/GREEN/TRIANGULATE/REFACTOR: make only demonstrated native recovery plumbing changes
- [x] **Start → end:** Start with RED cases from the original failed baseline for successor-acquire replay, later-drift strictness, lost reply, and uncertain pre-settlement effect; end with the smallest proven connection through existing predicates, or a documented no-source-change result if the RED premise is invalidated by current behavior.

  - **Paths:** AI `internal/sddstatus/runtime_compact.go`, `runtime_ledger.go`, `verification.go`; retain 4.1 tests. Proposed unique RED names: `TestRuntimeSuccessorAcquireReconcilesHistoricalUntracked`, `TestRuntimeReplayRetainsLaterDrift`, `TestRuntimeUncertainEffectRefusesUnsafeReplay`.
  - **Depends on:** 4.1; AI unit 3 blocks final tuple. **Forecast:** provisional 220–285 lines; unit 3 total 250–330.
  - **Focused command (future):** unfiltered 4.1 command; separate RED/GREEN/triangulation/refactor, verify proposed `run` records.
  - **Managed/native boundary:** retained token/settle ID, real artifact/invocation evidence, record count/lifetime charges. **Independent proof:** exact committed-payload replay without actor rerun; unknown effects stay unknown. **Rollback:** only demonstrated plumbing/paired cases; preserve immutable records/CAS/consent/caps/failed evidence.

Tasks 4.1–4.2 are accepted external AI unit 3 facts. The bounded R3 marker-detection contract above applies; do not reinterpret acceptance as universal zero-stale-append atomicity or reopen the exhausted AI objective.

### 4.3 RED/GREEN/TRIANGULATE/REFACTOR: give the managed child typed remediation and existing compact bracket transport
- [x] **Start → end:** Start with RED tests requiring `remediate` to refuse if unsupported, carry `failedEvidenceRevision` unchanged when supported, acquire once, and settle pass/fail/interruption through existing compact JSON; end with narrow adapter methods and runner finalization using retained session/task history, not a second ledger.

  - **Paths:** `lib/native-review-cli.ts`, `extensions/gentle-agents.ts`, `lib/agents-runner.ts`, `lib/sdd-preflight.ts:25–64,760–769` (`ASSET_OWNER_BY_KEY`), proposed `assets/agents/sdd-remediate.md`; `tests/gentle-agents.test.ts`, proposed `tests/sdd-managed-runtime-settlement.test.ts`.
  - **Depends on:** independently verified 4.2 and preceding Pi units, including Pi unit 1. **Forecast:** provisional 330–400 Pi unit 3 lines; explain/reforecast cohesive overruns.
  - **Registration/install proof:** RED requires absent remediation asset rejection by owner registry/install path; GREEN registers through existing `ASSET_OWNER_BY_KEY`/installation and proves installed content is selected actor before launch. 5.1 is final re-proof, not first registration.
  - **Focused commands (future):** `node --experimental-strip-types --test tests/gentle-agents.test.ts tests/sdd-managed-runtime-settlement.test.ts`, then `pnpm test`.
  - **Managed/native boundary:** post-acquire spawn failure settles interrupted with process/cleanup; absent ownership/install refuses before launch; lost settle reply uses same token/ID/payload, no rerun/double charge. **Independent proof:** installed owner/manifest, native record count/charges/evidence binding; no verifier-success prerequisite for failure/interruption. **Rollback:** adapter/runner/preflight registration-install/typed asset/tests together; retain records, refuse unsupported consumers.

Task 4.3 is implemented as Pi-owned unit 3. Asset ownership/install registration and focused proof are included; independent review is parent-owned, and task 5.1 remains the final tuple re-proof.

The five frozen unit-3 critical findings are corrected under `pi-unit3-review-corrections`; 4.3 was temporarily unchecked during correction and restored only after all correction gates passed. Cumulative RED/GREEN, physical durability, workload and final check evidence is in apply-progress; independent acceptance remains parent-owned.

## 5. Pi unit 4 — implemented; independent acceptance pending

### 5.1 RED/GREEN/TRIANGULATE/REFACTOR: prove the real producer → Pi → managed-child tuple
- [x] **Start → end:** Start with a failing controlled boundary case using the built AI binary after its internal units pass independent verification, fixed Pi extension selection, and installed assets; end with a managed child that receives native v2 action/context, selected research/persistence tools, and typed remediation support, or fails safely before work when an asset/provisioning capability is deliberately absent.

  - **Paths:** `extensions/gentle-ai.ts`, `assets/agents/sdd-apply.md`, `assets/agents/sdd-research.md`, proposed `assets/agents/sdd-remediate.md`, `lib/agents-runner.ts`; proposed `tests/sdd-native-managed-uptake.test.ts`. 4.3 already owns/proves remediation registration/install.
  - **Depends on:** independently verified AI 1–3 and Pi 1–3 including 4.3. Pi unit 4 carries only required final wiring/test adjustments. **Forecast:** provisional 210–290 lines; final PR accounting separate.
  - **Focused commands (future):** package-declared `pnpm run test:dev-binary`; `node --experimental-strip-types --test tests/sdd-native-managed-uptake.test.ts`. Record exact binary paths/build identities and installed manifest/content.
  - **Managed/native boundary:** scope-authorized producer → Pi → child proves read-only/excluded-marker adapter suppression; supported action, denial/partial persistence, stale/wrong-worktree refusal, remediation binding and incomplete-asset refusal.
  - **Independent proof:** integrator involved in neither implementation independently rebuilds/runs boundary, inspects native artifacts/ledger/manifest, accepts neither child report nor exit zero. **Rollback:** hold/revert complete tuple only to one proven to read retained records; otherwise refuse and retain read-only diagnosis.

Final tuple requires an independently built AI identity, Pi identity, installed asset manifest/content and native v2 floor. No decoder test, child report or exit zero substitutes for this boundary proof. Execution and installation need separate authorization.

## 6. Independent final verification — cross-repository, pending

### 6.1 Verify both repositories without claiming implementation acceptance from a command alone
- [x] **Start → end:** Start after all internal work units have independent acceptance and their RED/GREEN/TRIANGULATE/REFACTOR records and the 5.1 tuple passes; end with independently recorded full-suite results, diff/asset/record inspection, spec traceability, and a maintainer review package—never a delivery action.

  - **Paths:** review AI `internal/cli/`, `internal/sddstatus/`, `internal/agents/researchcapability/`, `internal/components/sdd/`, `internal/assets/`; Pi `lib/`, `extensions/`, `assets/agents/`, `tests/`. No new source asset.
  - **Depends on:** 1.1–5.1 including 4.3. **Forecast:** no source lines; evidence uses existing authorized verification process, not a framework.
  - **Focused commands (future):** AI `go test ./... -count=1`, `go vet ./...`; Pi package-declared `pnpm test`, `pnpm run check:runtime-modules`, `pnpm run test:dev-binary`.
  - **Managed/native boundary:** independently built 5.1 rerun and resulting artifact/record inspection. **Independent proof:** map results below; inspect absence of retired dispatch strings in upgraded live callers/assets/help/refusals/tests. Report failures as failures; exit alone is insufficient. **Rollback:** review-only, no direct code rollback; use failing unit boundary.

Task 6.1 is not an eighth implementation unit. Preserve per-unit strict TDD, independent implementer/verifier separation, source/test/guidance cohesion, finite accounting and all negative controls. No runtime execution or validation of implementation is claimed by adoption.

## Spec coverage matrix

| Spec ID | Owning task |
|---|---|
| NR-01 | 1.2–1.4 |
| NR-02 | 2.2–2.3 |
| NR-03 | 2.3 |
| NR-04 | 2.2 |
| NR-05 | 3.2 |
| NR-06 | 3.2 |
| NR-07 | 4.2 |
| NR-08 | 4.2 |
| NR-09 | 4.3 |
| NR-10 | 4.3 |
| NR-10a | 4.3 |
| NR-11 | 4.1–4.2 |
| NR-12 | 4.2 |
| NR-12a | 4.2 |
| NR-13 | 6.1 |
| NR-14 | 5.1 |
| NR-15 | 5.1 |
| OA-01 | 3.1 |
| OA-02 | 3.1 |
| OA-03 | 2.3 |
| OA-04 | 1.2–1.3 native preparation; 2.2–2.3/5.1 host scope suppression |
| RS-01 | 3.1 |
| RS-02 | 3.1 |
| RS-03 | 3.2 |
| RS-04 | 3.2 |
| RS-05 | 3.1 |
| RS-06 | 3.1 |
| RS-07 | 3.1 |
| RS-08 | 3.1 |
| RS-09 | 3.2 |
| RS-10 | 3.2 |

## Threat applicability and next gate

Carry design threat controls into mapped tests: canonical Git selection (`git -C`, relative/absolute paths) at native CLI and runner handoff; staged, `commit -a`, empty-index historical landing versus fresh invalid selection/later drift across successor acquire/settle. No executable-file classifier change or extension-based exemption. Push automation/destination and PR composition are N/A; no delivery authorized.

No bench corpus/driven scenario is planned: proofs are native CLI, managed child, asset/provisioning and ledger boundaries; accepted design identifies no bench asset. Do not add benchmarks merely to create coverage.

Fresh native status and correctly scoped Pi admission remain required before future execution. No acquire/settle, source implementation, asset install, live-provider/child execution, branch/commit/PR or delivery is authorized now. Historical native-reconciliation/reset notes do not reopen accepted AI. Record partial progress honestly; policy changes never turn failed evidence into acceptance.

## Non-normative provenance

Optional canonical task source: `/home/gentleman/work/gentle-ai-worktrees/sdd-runtime-simplification-plan/openspec/changes/sdd-runtime-simplification/tasks.md`. Optional acceptance handoff: `/tmp/sdd4484-pi-next.i70lrxm0/handoff.md`. These paths are provenance only; every task requirement, command, rollback boundary and checkbox state is retained locally without them.
