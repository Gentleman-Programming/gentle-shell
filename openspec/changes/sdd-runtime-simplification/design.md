# Design: one native SDD decision, existing execution mechanisms

## Current Pi adoption boundary

This is the complete local design, not incorporation by reference. AI units 1–3 are accepted external prerequisites. Pi owns four pending units: 2.1–2.3; Pi 3.1 plus 3.2; 4.3; 5.1. Task 6.1 is final cross-repository verification. Six tasks are checked and eight pending; Pi execution has not begun. Retain automatic mode, OpenSpec artifacts and ask-on-risk.

The external acceptance handoff reports candidate tree `872fa03dd00d62b3189ed6793abde923e53fee6c`, and `ai-runtime-recovery` generation 7 complete with no active attempt. These are adopted external facts, not rerun here or Pi authority. Accepted R3 is bounded marker detection, not universal filesystem atomicity: detected stale success emits no usable authority; distinct replacement instances inherit no roots; external replacement racing publication may leave immutable historical records. Preserve original committed-error receipt identity and publication failures. Later acceptance does not erase historical rejection. Do not reopen/reset the completed AI objective or modify its accepted candidate.

Historical source notes about pending native reconciliation are superseded by this acceptance boundary, not instructions to reset AI. No external apply-progress, marker, ledger, consent, token or verification report is imported. Fresh native status and correctly scoped native `proceed` are required before future Pi execution. No source implementation, acquire/settle, branch, commit, PR, installation, live-provider/managed-child execution or delivery is authorized by this adoption.

## Decision and scope

Fix the existing producer, consumer, and shipped guidance together. Keep status v2, `nextRecommended`, compact acquire/settle, and the immutable common-directory ledger. Pi transports the native-selected action; it does not calculate the next phase. Research tool admission and artifact-write authorization remain separate responsibilities. No engine, ledger, action-envelope version, generator, compatibility framework, or source reuse.

Planning basis: [proposal](proposal.md) and local NR/OA/RS delta specs. Historical admission r8/evidence used supplied AI baseline `3050dc4c` and Pi baseline `564ae19b`. Shell/CodeGraph tools were unavailable in that design phase; bounded exact-source reads were used. Those revisions were not independently checked and no tests ran in that phase. Official installed Pi README, complete extension documentation, and the permission-gate example informed inventory/allowlists and existing event behavior; no new SDK, RPC protocol, extension infrastructure, or TUI component is proposed. Source line numbers and historical diagnoses below require current-code re-evaluation before implementation.

## Current approval and delivery policy

Current human policy supersedes earlier hard-400, integrator-only exception, feature-branch-chain and pre-implementation design-review stops. Keep seven internal functional units (AI 3, Pi 4): strict-TDD implementation, independent verification, then advancement for each unit. Source, fixture migrations, tests and shipped guidance remain cohesive. The 400 authored A+D figure is a target; justified overruns are allowed, not larger native budgets.

The cross-repository plan intends one final PR in AI and one in Pi, both `size:exception`. Pi owns exactly one eventual Pi PR, not a chain or per-unit PRs. Full planning documents count wherever included. Delivery strategy is `exception-ok`; `Chain strategy: size-exception` means no PR chain. No immediate delivery, branch creation, commits, PR/label changes, merge or release is authorized. Native finite budgets, history and consent remain unchanged. Historical planning provenance is not new implementation evidence.

## Ownership and deletion plan

**Pi** paths resolve in this repository; **AI** paths resolve in the external AI repository, never this planning directory. New tests belong beside the named behavior, not in a new framework.

| Owner / existing files and symbols | Necessary change | Delete or preserve |
|---|---|---|
| AI `internal/cli/sdd_status.go:21–81`: `RunSDDStatus`, `RunSDDContinue`; `internal/sddstatus/status.go`: `Resolve`, `resolveByPreferenceOrder`, `applyReviewOfferRouting` | Keep `Resolve`/status pure; explicitly authorized continue prepares consent before rendering. Review-mode lookup failure omits only the advisory offer. | Remove review/preflight prerequisites for inspection; preserve execution authorization and genuine resolution errors. |
| AI `internal/sddstatus/status.go:630–717`; `internal/sddstatus/edit_authority_consent.go`: `readChangeInstanceMarker`, `ensureChangeInstanceMarker`, `newEditAuthorityConsent`; `internal/cli/sdd_attempt.go:258–277` | Move existing random-marker preparation into existing continue; use no-replace publication and readback. Grant compares supplied identity with the current persisted marker, never initializes it. | Remove status-time minting and overwrite races; preserve markers, consent envelope, instance binding, CAS and records. |
| AI `internal/sddstatus/status_v2.go`: `ProjectStatusV2`, `statusV2NextRecommended` | Keep wire shape; cover every emitted action and optional section in producer tests. | Preserve seven dependencies, four `phaseInstructions` groups, bounded vocabulary; no new envelope. |
| Pi `lib/native-review-cli.ts`: `NativeSddStatusV2`, `decodeNativeSddStatusV2`, `sddStatus`; `extensions/gentle-ai.ts:7646–7687`: `handleSddStatusCommand`, `handleSddContinueCommand` | Decode actual v2 fields; keep `sddStatus` read-only. Add narrow `sddContinue` only for authorized continuation, with the same decoder and mutating process classification. | Delete exact-three/`instructions` assumptions and review-negotiation gating of inspection; never continue as status fallback. |
| Pi `lib/sdd-status.ts`: `resolveSddStatus`, `planningRecommendation`, `renderNativeSddPhasePrompt`, dispatcher/status renderers; `extensions/gentle-ai.ts`: selected startup and handlers | Route live reads through native v2; render fields without casting native documents to local status types. | Remove live local dependency reconstruction, `resolve-via-engram`, prefixed-token inference and automatic local fallback. Retain unrelated presentation helpers only where used. |
| Pi `extensions/gentle-agents.ts`: `parseSddChange`, `buildRequest`; `lib/agents-runner.ts`: `SddChangeSelection`, `TaskRequest`, `childArguments` | Carry selected planning/execution action, bounded scope and remediation binding through existing launch. | Replace duplicated phase acceptance lists with one consumer vocabulary, never a phase graph. |
| Pi `lib/sdd-research-capabilities.ts`: `resolveResearchCapabilities`, `researchAgent`; `extensions/gentle-agents.ts`: restriction hook | Restrict routes to selected admitted classes; retain authorized local/persistence tools; recheck child inventory. | Preserve host intersection; delete whole-phase denial caused solely by missing research route. |
| AI `internal/agents/researchcapability/contract.go`: `ForAgent`, `Admit` | Preserve closed declaration/admission and agreement with host fixtures. | No Go host-inventory engine or new research command. |
| AI `internal/sddstatus/runtime_compact.go`, `runtime_ledger.go`, `verification.go` | Reuse readiness, replay, evidence derivation, settlement and remediation predicates; change only demonstrated missing plumbing. | Preserve authority operations, lifetime accounting, refund caps, failed-evidence linkage and write/replay agreement. |
| AI `internal/assets/opencode/commands/sdd-status.md`, `sdd-continue.md`, `internal/assets/skills/_shared/sdd-status-contract.md`; Pi `assets/agents/sdd-apply.md`, `sdd-research.md`, `lib/sdd-preflight.ts` | Align shipped text and managed ownership; add distinct remediation agent through existing SDD installation. | Remove native-Engram bans, manual native-shaped status fabrication, prose dependency graph and status-preflight gate; preserve artifacts and quality guidance. |

No package deletion before caller verification. Inventory retired strings across installed-source assets, help, refusals and tests; leave no executable-looking continuation to a deleted route. Canonical native v2 already omits `sdd-sync`; this is not a sync-removal decision. Preserve explicitly requested sync, artifacts and durability; invent no native sync recommendation or migration.

## Contract and read-only status

1. Keep `schemaName: gentle-ai.sdd-status`, `schemaVersion: 2` and `--contract gentle-ai.sdd-status/v2`. No live legacy schema.
2. Dependencies are exactly `proposal/specs/design/tasks/apply/verify/archive`. Optional `phaseInstructions` contains exactly `apply/verify/remediate/archive`. Request and require instructions for execution handoff; ordinary read-only decoding accepts documented absence. Never alias `instructions`.
3. Bound `nextRecommended` to the producer's existing twelve tokens, including non-phase-executing `archived`, `sdd-new`, `select-change`, `resolve-blockers`. Planning tokens need no invented instruction-group keys.
4. Validate consumed store, nullable selection/locators, action mode, canonical workspace, allowed roots and remediation revision. Discovery may have null selection; selected startup must match requested identity. Unknown/malformed actions refuse before execution even if prose says “ready”.
5. Display dependencies/reasons without recomputing readiness. Native `verify` selected to refresh evidence remains executable despite diagnostic reasons. Status launches nothing, including recommended planning phases.
6. `actionContext` describes existing authority, not consent. Writes intersect its roots, phase artifact/source targets and current human authorization. Carry narrower path grants in existing launch data; native root-wide context never erases design-file-only scope.

### Consent preparation belongs to explicit continuation

Assign preparation to existing `RunSDDContinue`, not grant. Historically `internal/cli/sdd_status.go:51–81` shared `Resolve` with status and had no initialization boundary; the focused historical CodeGraph readback found only `resolveByPreferenceOrder` calling the initializer. The approved behavior change does not claim a safe initializer already existed or that continue must remain a pure alias.

- **Pure output:** remove `ensureChangeInstanceMarker` from `Resolve`. Missing roots and no marker omit optional `consent`; preserve blocking and append a `blockedReasons` explanation naming properly quoted `gentle-ai sdd-continue <selected-change> --cwd <canonical-workspace>`. Explain required authorized change-directory writes and no granted roots. No new reason enum, token, public field, grant invocation or transient usable identity. Present valid marker renders existing bound envelope.
- **Preparation:** small helper called only by `RunSDDContinue` between initial resolution and output. Carry internal missing-root facts, not diagnostic parsing. For selected active OpenSpec needing consent, check current directory/workspace, authorized marker writes and planning-home containment; persist/reuse existing random marker without requiring missing source roots first. Re-resolve through `ProjectStatusV2`/`RenderDispatcherMarkdown`; no grant, attempt, artifact rewrite or automatic launch. Engram-only status invents no filesystem marker.
- **Authorization:** explicit continuation intent is not a read-only query. Host checks narrower human scope includes marker preparation; `actionContext` alone cannot grant it. Marker-only planning scope permits preparation while source roots remain unauthorized and apply blocked. Read-only/excluded-marker scope forbids it. Unsafe selection, out-of-planning-root context or unwritable directory refuses before publication. `--json` changes formatting, not authorization; no new approval flag/protocol.
- **Publication:** replace `os.WriteFile` overwrite with `reviewtransaction.PublishFileNoReplace`. Publish complete random bytes, then read persisted winner; losers reuse winner, not unpersisted tokens. Preserve present bytes; malformed/unreadable markers refuse rather than regenerate. Confirm directory was not replaced before emitting consent. Publication/readback failure emits no usable consent; retry reads rather than overwrites an uncertain write.
- **Grant consumes:** historical `sdd_attempt.go:258–277` passed token to `ForInstance`; `runtime_ledger.go:665–678` validated opaque text, not current marker. Existing CLI grant must compare persisted marker before grant/replay. Absent/mismatch refuses without marker or authority append. Preserve CAS/idempotency and instance-filtered projection. A's grant cannot initialize recreated B from A's token; this is narrow binding, not a new grant mechanism.

**Traceability and limitations:** native 1.2–1.4 prove explicit preparation, planning/source distinction, selection/containment and filesystem failure. Pi 2.2–2.3/5.1 prove actual human read-only/excluded-marker suppression. Directory-at-marker is not permission proof. Ambiguous/unsafe selection, out-of-root context and unwritable-at-entry directories publish nothing. Detected concurrent replacement requires no usable consent, not universal zero-write atomicity across pathname races. Shared publisher fallback can expose partial destination bytes: retain this limitation/proof gap. No-replace proves neither universal atomic visibility nor all-filesystem convergence. Require fail-closed readback and winner convergence; no shared publisher redesign or new permission primitive. Delta-spec quality/scope/consent guarantees remain unchanged. The current accepted R3 boundary above governs external AI acceptance.

**Pi call sites:** `handleSddStatusCommand` and `resolveSelectedNativeSddChangeStartup` use only `sddStatus`; startup/status never prepares consent. Only `handleSddContinueCommand` or expressly authorized continuation uses the new method after scope checks. Replace historical shared `resolveControllerSddStatus` calls at `extensions/gentle-ai.ts:7646–7687` with distinct operations, not fallback. Display preparation instructions losslessly; never execute because status displayed them. Preparation concurrency, stale binding and host scope still require their mapped proofs; the design itself is not implementation acceptance.

## Handoff sequence

```text
Parent -> native status: selected change + canonical cwd, read-only v2
Native -> parent/Pi: one nextRecommended + store/locators/actionContext
Authorized explicit continue -> native continue: prepare missing instance, then bound consent
Parent -> human: existing consent if required; grant only on explicit answer, reread status
Parent -> existing managed launch: selected actor + narrower authorization + intent
Child -> native status / local inventory: confirm identity and actual tools
Runtime owner -> acquire: existing work unit, budgets, request ID, remediation revision
Native -> runtime owner: proceed(token) | blocked | complete
Child -> authorized tools: selected work; persist actual evidence
Runtime owner -> settle: same token, distinct settle ID, truthful terminal facts
Parent -> native status: fresh projection; independent verify if selected; archive only eligible
```

Planning never acquires merely because apply dependencies block. Runtime-bearing work stays bracketed. If parent already acquired, child continues that token, not a second blind acquire. Runner finalization and retained task/session results recover transport; they are not workflow authority.

`extensions/gentle-agents.ts` owns managed runtime brackets. Add narrow acquire/settle methods to existing `NativeReviewCli` exec-file transport with existing compact JSON states. Retain operation IDs, token and exact settle inputs in existing task/session history, not another ledger. Reuse `AgentRunner.onFinish` for failed/interrupted completion; only admitted tokens settle. Post-acquire spawn failure settles interrupted with observed process/cleanup facts. Completed actors supply evidence, not automatic acceptance. Historical adapter had status but no compact-attempt methods; a prompt alone cannot settle interruption.

## Research routes and persistence

`ForAgent`/`Admit` own the closed native maximum `gentle-ai.sdd-research-capability/v1`. Pi owns registered ∩ active ∩ approved ∩ explicit-restriction ∩ selected-class reachability. Thread selected classes and admitted per-class grants into `researchAgent`/`buildRequest`; a union of available classes is not selection. No Go host discovery or gateway-inferred grants.

- Pi documentation requires exactly `fetch_content`; open-web exactly `web_search`, `source_check`, `fetch_content`, `get_search_content`. Other runtimes retain their exact `ForAgent` declarations.
- Preserve separately authorized `read/grep/find/edit/write` and exact Engram read/save tools from agent definition: not research grants. Parent messaging is transport, not research; align its child allowlist.
- `childArguments --tools` does not load extensions. Carry parent's actual resolved extension selection through existing launch inputs; verify child-local registration. No undisclosed extensions, automatic providers, trust grants or substitute fetch tools.
- Preserve selected store and change-local research/preproposal locators. OpenSpec accesses only OpenSpec; Engram uses exact project/topic locators; hybrid requires positive revision and byte-equal dual readback; none cannot set readiness. Source data never changes scope/tool authorization.
- Missing selected tools block collection/proposal, not authorized diagnostic persistence. Retain intent, observed grants, denial/partial evidence and failed calls. Persistence failure returns retained evidence and write failure, never claimed durability or silently switched stores.
- Re-enter with fresh inventory/recovered artifacts after correction; never cache denial as permanent authority. Divergent hybrid remains blocked until retained-intent recovery writes and reads a new matching revision.

This requires launch plumbing and selected filtering, not wording alone: historical `researchAgent` considered both classes; `childArguments` cannot conjure absent tools; research-only filtering removes denial persistence. No new platform is needed.

## Remediation and real evidence

Add typed `remediate` in existing managed mechanism, not apply alias: Pi `assets/agents/sdd-remediate.md`, registered in existing `ASSET_OWNER_BY_KEY`. Extend selection validation/ownership. Carry `remediationState.failedEvidenceRevision` unchanged to acquire/settle. Unsupported consumers explicitly refuse; no guessed upgrade or unverified native shortcut.

Preserve `Acquire` chain/candidate admission. Unchanged failed baseline without existing audited evidence-only authorization remains unsatisfiable; actor cannot edit before admission to evade it. Native recovery predicates and explicit maintainer decisions supply correction/retry; Pi never picks reset/rescope/supersede. Exercise original failed baseline, not conveniently changed fixtures.

Passing correction uses existing `--remediation-evidence` and `DeriveRemediationEvidenceRevision` (`verification.go:718–760`) from concrete focused-test, harness or justified N/A, and rollback evidence. `nativeRuntimeCompletesRemediation` then selects fresh independent verification before acceptance/archive. Failure supplies actual evidence revision and required diagnosis/process/cleanup; interruption omits revision. Neither requires successful verification or passing envelope.

| Actual subject | Existing evidence path; no fabricated source edit |
|---|---|
| Source candidate | Snapshot captures tracked/index changes and declared untracked selection; ledger binds candidate/worktree and measured lines. |
| OpenSpec/Engram artifact | Persist exact locator, store/project, revision and content digest; settle actual evidence revision. Git baseline is context, not proof external artifact bytes changed. |
| Invocation/environment | Persist command, cwd, result/output digest, diagnosis, process/cleanup in phase evidence and settlement fields. Exit alone is not acceptance. |

No new subject union/receipt store: existing artifacts hold locator/content/invocation facts and `EvidenceRevision` binds them. No-diff is not no work/refund. Evidence-only success still requires audited authorization; subject labels are not waivers.

## Finite failure and recovery matrix

| Boundary / outcome | Required behavior |
|---|---|
| Invalid status, wrong worktree, absent executor | Refuse before work; no substitute phase/new attempt. |
| Missing research tool | Persist authorized denial/partial record; block research/proposal; no fallback. |
| Out-of-scope write or divergent/stale recovery | Refuse write; retain evidence/intent; no broader roots/preferred hybrid copy. |
| Admitted failed/interrupted/no-diff | Settle once with truthful available required facts; failure/interruption does not discharge failed evidence. Keep finite charges and legitimate capped refunds. |
| Lost committed-settle reply | Exact ID/token/payload through `Settle` receipt replay; no actor rerun, ordinal or duplicate charge. Projection may reflect later head. |
| Effect possible before settle | Reconcile retained tool/process/artifact observations; unknown stays unknown. No fabricated success/committed record; unsafe rerun refuses. |
| Missing settlement facts | Retain token/uncertainty; refuse execution until existing reconciliation/settlement possible. No automatic retry/reset or invented cleanup. |
| Historical intended-untracked landed | `runtimeReplayedIntendedUntracked` only at historical-to-current capture; fresh selection/later drift strict. |
| Corrected blocker | Reload native facts and existing predicates; no consumer blocker cache/history rewrite. |

Preserve `Finish`/`applyRuntimeFinishEvent` parity, `runtimeReadiness`, `runtimeAttemptRefundsBudget`, receipt-before-mutation replay. Trace reported successor acquire from CLI preflight through `runtimeRescopeSuccessorRequest` to capture; reconcile only where inherited history reaches fresh capture. No new recovery taxonomy/ledger rewrite.

## Acceptance and boundary verification

| Spec IDs | Planned proof (defect RED or preservation where already correct) |
|---|---|
| NR-01; OA-04 | Pure OpenSpec/Engram status without session/launch/review authorization; no marker/authority/artifact mutation. Focused consent cases below, including old invocation after recreation. |
| NR-02–04; OA-03 | Actual `ProjectStatusV2` output, not three-key mocks: all actions, optional instructions, nullable discovery, wrong identity, missing/extra keys, malformed action, misleading prose. Actor/refusal and no local fallback. |
| NR-05–06; RS-01–04,09–10 | Real fixed-extension child: exact grants, each tool absent, SDK-only/inactive tools, narrowed reads/writes, wrong worktree; authorized OpenSpec/Engram denial persistence. |
| NR-07–08 | Corrected inventory/artifacts continue; stale hybrid refuses. Historical untracked→tracked successor and fresh tracked selection have opposite outcomes; later content drift visible. |
| NR-09–10a | Original failed baseline → admitted recovery → distinct actor → bound settle → independent verifier. Stale/discharged revision and unsupported actor refuse; failed/interrupted closes without verifier-success prerequisite. |
| NR-11–12a | Real artifact/invocation with zero source diff; failure/interruption accounting, caps, lost committed reply, uncertain pre-settle effect, missing worktree, exact conflicting replay. Assert record count/lifetime charges. |
| NR-13 | Strict lifecycle evidence and independent verifier; implementer/runner completion or exit zero never acceptance/archive. |
| NR-14–15 | Installed assets + package-local binary + actual child prove status/tools/remediation uptake. Old/missing assets fail before work, not decoder-only. |
| OA-01–02; RS-05–08 | Confirmed no-interview proposal, grouped unresolved prompt, matching hybrid, one-sided recovery, missing-intent refusal. |

Focused consent proofs at native CLI and Pi handlers:

1. Repeated absent/present-marker status has byte-identical filesystem/authority snapshots. Absent yields preparation diagnostic with no consent/grant token; present yields existing envelope without mutation.
2. Authorized continue persists one random marker before consent; repeated/concurrent preparation converges; no grant/attempt recorded.
3. Marker-only planning scope permits preparation while source roots remain missing and apply blocked. Read-only/excluded-marker scope calls no mutating adapter. Ambiguous selection, wrong workspace, out-of-root and unwritable directories publish nothing. Status/startup never continue, even on binary failure.
4. Consent for A, recreate path as B, invoke A's old grant: refusal, no B initialization, authority append or old-root projection. After B preparation, A still refuses; B has distinct identity.
5. Malformed marker, publication failure, replacement during preparation: no overwrite/usable consent; exact valid grant replay preserves CAS/accounting.

Extend existing AI `status_v2_clean_break_test.go`, `runtime_truthful_remediation_settle_test.go`, `runtime_compact_test.go`, `verification_test.go`, `internal/components/sdd/research_state_contract_test.go`; Pi `tests/sdd-research-capabilities.test.ts`, `tests/gentle-agents.test.ts`, `tests/sdd-research-live.test.ts`. Producer fixtures are contract data, not copied implementation/generator. Unit mocks alone are insufficient. Future verification runs focused tests, `go test ./...`, `go vet ./...`, and actual declared Pi commands; record results and independently inspect artifacts. Exact per-task commands are retained in [tasks](tasks.md); none is authorized merely by this plan.

### Threat applicability

| Boundary | Applicability / cases | Safe behavior and RED boundary |
|---|---|---|
| Documentation-like paths | N/A: no executable-file classifier change | No extension-based evidence exemption. |
| Git selection | Applicable: `git -C`, relative/absolute paths | Canonical workspace wins; mismatched child/capture refuses. Test each at native CLI/runner. |
| Commit state | Applicable: staged, `commit -a`, empty index | Historical landing reconciles without hiding drift; fresh invalid selections refuse. Test successor acquire/settle for each. |
| Push | N/A: no automation/destination change | Delivery unauthorized. |
| PR commands | N/A: no composition | No implementation task. |

## Minimal cutover, rollback, and remaining proofs

1. Pair pure status, authorized continue, no-replace reuse, current-marker grant and proofs in one behavior slice. Ship supported continuation with preparation diagnostics and paired guidance/call-site separation. Remaining v2/managed units stay cohesive with tests; independent verification precedes advancement.
2. Prove actual AI build identity + Pi build identity + installed asset manifest/content + existing contract floor. `NATIVE_CLI_CONTRACTS` review rows do not prove SDD compatibility. Invent no release numbers; assume no #605/#608 shipment. Test `childArguments` and `installPackageAssets` directly.
3. Cut over live status/startup/rendering together to v2. No dual-live schema routing. Historical ledger and preference normalization stay readable, not legacy dispatch authority.
4. Roll back producer, consumer and managed assets only to a proven retained-record-compatible tuple. Never delete history, reset budgets, rewrite markers or regain consent. No safe tuple means refuse execution and retain read-only diagnosis.

Initialization owner is existing explicit `RunSDDContinue`; no design-owner gap remains. Future Pi verification still must prove host scope, deployed extension/assets and real-subject boundaries with the accepted AI prerequisite. Historical proposed native proofs are not newly rerun results. Missing tests authorize no new mechanism or issue audit. Forecast cohesive tests/migrations/guidance against 400 A+D, allowing justified overruns; count complete documents in final PRs. Only planning correction is authorized now.

## Non-normative provenance

Optional historical source: `/home/gentleman/work/gentle-ai-worktrees/sdd-runtime-simplification-plan/openspec/changes/sdd-runtime-simplification/design.md`. Optional external acceptance handoff: `/tmp/sdd4484-pi-next.i70lrxm0/handoff.md`. These paths provide provenance only; this design retains its complete requirements, limitations and current boundary without them.
