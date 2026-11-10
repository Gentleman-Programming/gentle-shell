# Slice 2 publication coordination — T7 / S10–S11

Strategy: `feature-branch-chain`; all four PRs draft/no-merge.
All four branches and draft PRs published after human OAuth reauthorization; no force-push or merge. Source refs and isolated remote diffs verified.

## Boundaries

- Verified upstream main: `cb0c5a2e548e278bd65fc503552b10862c4efa11` (parent evidence).
- Workspace branch: `feat/2266-slice2-tracker`; initially coordination docs only.
- Rebased source heads: `1bd87f203` (46), `73cc0e8ff` (194), `223ed83e7` (310 changed lines), total 550.
- Preflight conflicts were diagnosed without an index/merge state; test-only overlaps reconciled while preserving both upstream and slice behavior.
- Source tests/docs and exact parent topology retained; individual child diffs verified.
- Child branches layer on tracker → 01-dispatch → 02-job-ipc → 03-registration.
- Tracker targets `Gentleman-Programming/gentle-shell:main` from `rubenpenap:feat/2266-slice2-tracker`.
- Children target `rubenpenap/gentle-shell`, each against its immediate parent.
- Bodies: `odd/pr/2266-slice2-chain/`; tracker https://github.com/Gentleman-Programming/gentle-shell/pull/2575; children https://github.com/rubenpenap/gentle-shell/pull/1, https://github.com/rubenpenap/gentle-shell/pull/2, https://github.com/rubenpenap/gentle-shell/pull/3.

## Remaining gates

- [x] Parent transplanted source and verified clean child-only diffs and topology.
- [x] Current-base child 01 runner 119/119; child 02 messaging/runner 127/127; child 03 parent and independent focused 140/140, typecheck 0.
- [ ] Current-base full suite: `pnpm test` exited 1 before tests, `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`; no reinstall/retry/CI override. Fresh off-path historical differential remains unverified.
- [ ] Native review with valid candidate lineage; current candidates unreviewed.
- [ ] Offline core-corpus before/after/compare, preserving both run exits.
- [ ] Packed-install verification and target-policy required CI.
- [ ] Source-chain review/integration and Slice 3 functional-release coordination.

Historical only: 136/136 focused, typecheck 0; compatibility differentials matched.
Old full suite: 7,385 total / 7,290 passed / 22 failed / 73 skipped; baseline environmental diagnosis recorded in original task, not current-base proof.
Native retained-selection mismatch created no lineage/approval; do not infer a waiver.
#2552 diagnostics remain separate; no paid LLM bench, new scenarios or measurement claims.

Publication checks: all four PRs OPEN and draft; child labels exactly `type:bug`; upstream tracker label requires maintainer action. Tracker CI is running for coordination docs only; child PRs currently have no checks reported. No source CI pass inferred from tracker CI.
