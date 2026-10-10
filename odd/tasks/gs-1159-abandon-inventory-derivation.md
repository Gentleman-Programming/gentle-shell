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

- [x] T1 RED — controller tests for the derive flow in
  tests/review-controller-native-recovery.test.ts (5 tests: derive+commit with
  exact eight-line binding, top-level lineageId, injected-field rejection,
  ineligible/incomplete inventory, headless+declined fail-closed). Observed RED
  (5 failing), then GREEN with T2.
- [x] T2 GREEN — extensions/gentle-ai.ts: executeNativeAbandon (strict
  {lineage|lineageId, actor, reason}, fresh reviewStatus() read, single
  compact-v2 entry with discardedWork, derived binding, UI self-authorization),
  interceptor early-return for ABANDON, dispatch route with context, dead
  abandon branches removed from the caller-supplied maintenance family.
- [x] T3 Contract text — tool description and docs/readme-reference.md now
  state the derive contract (also fixes the stale nine-line/evidence-record
  wording); review-authority-recovery-docs.test.ts green.
- [x] T4 Provenance note — comment at the captured_lens_results binding render
  in lib/native-review-cli.ts: values must arrive verbatim from the native
  inventory projection (ordinal-prefixed order).
- [x] T5 Verify — recovery suite 26/26; docs+cli batch 68/68; focused trio
  (relay routing, restart parity, integration-v2) 86/86; pnpm typecheck zero
  regressions; full suite only two known flakes (dev-binary surfacing,
  history ts precedence) that pass standalone on base 4fcddc2f — pre-existing,
  subsystem-disjoint.
- [x] T6 Ship — work-unit commit fcf02de1; native review approved (lineage review-09c6de152830006e, 0 corrections, authority burned); PR #1668 opened against Gentleman-Programming/gentle-shell from fork branch fix/1159-abandon-inventory-derivation; type:bug label requested in-body (maintainer-side).

## Evidence log

- 2026-10-02 claim posted (issuecomment-5954784304).
- 2026-10-02 exploration: `executeNativeAuthorityMaintenance` demanded
  expectedRevision/snapshotIdentity/capturedLensResults/findingsPresent;
  `authorizeDestructiveReviewOperation` derived the UI binding from those
  caller fields; `decodeNativeReviewStatusEntry` already exposes
  lineageId/revision/snapshotIdentity/discardedWork{capturedLensResults,
  findingsPresent}; `executeNativeLegacyAliasRepair` is the derive+UI-confirm
  precedent.
- 2026-10-02 implementation: commit fcf02de1 on
  fix/1159-abandon-inventory-derivation (+261/−21 across 5 files). Verification
  by gentle-ai-verify + base-flake confirmation inline.
- 2026-10-02 shipped: native review APPROVED (medium tier, lens review-reliability, 3 informational advisories: uncovered blocked-path branches, eligibility pre-check ignoring entry state, reason enum unenforced); acknowledgement burned authority (gentle-ai.review-acknowledged/v1, consumed sha256:04d88c18...). PR: https://github.com/Gentleman-Programming/gentle-shell/pull/1668
- 2026-10-02 post-PR hardening: CodeRabbit actionable (recheck derived authority after approval) implemented as native-abandon-authority-changed (drift test added, 27/27); runtime/native-review-cli.mjs regenerated fixing verify + session-transport-macos checks. All checks green except CodeRabbit re-review pending.
- 2026-10-02 maintainer round: dnlrsls compared 18c2ece9 against their independent branch and steered the delta into this PR (no duplicate). Landed in aa5a84fe: authoritative-inventory + lineage-uniqueness selection (nativeAbandonCandidate), cancellation guards at both consent boundaries, docs evidence-record fix, adapter-level registered-tool battery (32/32 total). Reply: issuecomment-5957523970. Awaiting maintainer review round 2.
