# gentle-shell#1159 — audited abandon derives its inventory inputs

Issue: https://github.com/Gentleman-Programming/gentle-shell/issues/1159
Claim: issuecomment-5954784304 (2026-10-02, reporter kfiguera credited)
Branch: fix/1159-abandon-inventory-derivation (fork danielgap/gentle-pi)
Worktree: ~/gentleman/gentle-shell-1159

## Goal

The facade `gentle_review abandon` must complete without caller-supplied
inventory-derived fields. The caller supplies lineage, actor, and reason; the
facade freshly reads the native authority inventory, locates the single
eligible compact-v2 entry, derives expectedRevision, snapshotIdentity,
capturedLensResults, and findingsPresent, renders the exact eight-line
`gentle-ai.review-abandon-authorization/v2` binding, and asks for fresh
interactive approval before mutating.

## Fix fronts (from the thread)

1. Derivation gap (kfiguera, HernandoLM): no facade operation publishes
   `entries[].discarded_work`, so a facade-only caller cannot construct the
   authorization input at all.
2. Encoding divergence (CogniDevAI, IsraelitoMX): the facade rendered
   `captured_lens_results` verbatim from caller input while native recomputes
   its ordered (ordinal-prefixed) record, so the binding could only match when
   the caller guessed the prefixed form.
3. Misleading envelope (dasafo): `missing_input` reported `lineage` although
   the caller supplied the top-level `lineageId`, and listed
   `capturedLensResults` as if it were a native flag.

Design: mirror the REPAIR_LEGACY_ALIAS precedent (self-authorizing operation
whose binding can only be derived from a fresh native inventory read), with a
strict input key set and injected-field rejection like
`executeNativeLegacyAliasRepair`.

## Tasks

- [ ] T1 RED — controller tests for the derive flow in
  tests/review-controller-native-recovery.test.ts: happy path derives the four
  fields and commits with the exact eight-line binding; injected
  inventory-derived fields rejected; no eligible entry blocked; missing
  actor/reason reported; top-level lineageId accepted as the lineage source;
  headless fails closed; declined approval aborts without mutation.
- [ ] T2 GREEN — extensions/gentle-ai.ts: new `executeNativeAbandon`
  (strict {lineage|lineageId, actor, reason} contract, fresh reviewStatus()
  read, single compact-v2 entry with discardedWork, derived binding, UI
  self-authorization), interceptor skip for ABANDON in
  authorizeDestructiveReviewOperation, dispatch route with context.
- [ ] T3 Contract text — tool description (gentle-ai.ts) and
  docs/readme-reference.md updated to the derive contract;
  review-authority-recovery-docs.test.ts assertions kept true.
- [ ] T4 Provenance note — comment at the captured_lens_results binding render
  in lib/native-review-cli.ts stating the values must come verbatim from the
  native inventory projection.
- [ ] T5 Verify — targeted suites green (review-controller-native-recovery,
  review-authority-recovery-docs, native-review-cli) + full extension check.
- [ ] T6 Ship — work-unit commit, native review under RDD, PR via branch-pr
  (closes #1159).

## Evidence log

- 2026-10-02 claim posted (issuecomment-5954784304).
- 2026-10-02 exploration: `executeNativeAuthorityMaintenance` demands
  expectedRevision/snapshotIdentity/capturedLensResults/findingsPresent;
  `authorizeDestructiveReviewOperation` derives the UI binding from those
  caller fields; `decodeNativeReviewStatusEntry` already exposes
  lineageId/revision/snapshotIdentity/discardedWork{capturedLensResults,
  findingsPresent}; `executeNativeLegacyAliasRepair` is the derive+UI-confirm
  precedent.
