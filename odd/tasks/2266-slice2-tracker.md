# Slice 2 publication coordination — T7 / S10–S11

Strategy: `feature-branch-chain`; all four PRs draft/no-merge.
Parent owns transplant, verification, remote publication and URL insertion.

## Boundaries

- Verified upstream main: `cb0c5a2e548e278bd65fc503552b10862c4efa11` (parent evidence).
- Workspace branch: `feat/2266-slice2-tracker`; initially coordination docs only.
- Source units: `671362918` (42), `88736250b` (198), `d5fbd6b41` (310 changed lines).
- Transplant only after clean non-mutating merge-tree preflight; stop on conflict.
- Preserve source tests/docs; candidate counts must be rechecked after transplant.
- Child branches layer on tracker → 01-dispatch → 02-job-ipc → 03-registration.
- Tracker targets `Gentleman-Programming/gentle-shell:main` from `rubenpenap:feat/2266-slice2-tracker`.
- Children target `rubenpenap/gentle-shell`, each against its immediate parent.
- Bodies: `odd/pr/2266-slice2-chain/`; all PR URLs pending.

## Remaining gates

- [ ] Parent transplants source and verifies clean child-only diffs.
- [ ] Fresh focused tests/typecheck on current upstream (runner/extension/tests changed).
- [ ] Native review with valid candidate lineage; current candidates unreviewed.
- [ ] Offline core-corpus before/after/compare, preserving both run exits.
- [ ] Packed-install verification and target-policy required CI.
- [ ] Source-chain review/integration and Slice 3 functional-release coordination.

Historical only: 136/136 focused, typecheck 0; compatibility differentials matched.
Old full suite: 7,385 total / 7,290 passed / 22 failed / 73 skipped; baseline environmental diagnosis recorded in original task, not current-base proof.
Native retained-selection mismatch created no lineage/approval; do not infer a waiver.
#2552 diagnostics remain separate; no paid LLM bench, new scenarios or measurement claims.
