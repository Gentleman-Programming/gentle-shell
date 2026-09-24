# Pin Gentle AI v3.6.1 and release gentle-pi v3.6.0

Repository-relative locator: `odd/tasks/pin-gentle-ai-3.6.1-release.md`

## Objective and rationale
Ship gentle-pi v3.6.0 with the published Gentle AI v3.6.1 pin rather than the older v3.6.0 pin. Approved issue: https://github.com/Gentleman-Programming/gentle-shell/issues/1362. Upstream release: https://github.com/Gentleman-Programming/gentle-ai/releases/tag/v3.6.1.

## Scope and constraints
- Worktree: `1362-pin-gentle-ai-3.6.1`; branch `fix/1362-pin-gentle-ai-3.6.1`, starting from origin/main `5df9590e`.
- User authorized PR, push, tag, GitHub Release and GitHub Actions publication for `Gentleman-Programming/gentle-shell` using the current authenticated gh and Git sessions. No local npm publication.
- Pin only published v3.6.1 archives, extracted binaries and Windows module Sum with verified provenance; regenerate derived modules, never hand-edit.
- No retagging; tag only the exact published main head; GitHub Actions dispatch from main. Delivery strategy: ask-on-risk. Forecast: 50–150 authored lines for the pin and release metadata, subject to contract comparison; generated modules excluded from the authored count.
- Effective TDD: strict, source `openspec/config.yaml`, runner `pnpm test` (read-only exploration evidence). Observe RED then GREEN and refactor for implementation.

## Tasks
- [x] T1 — Pin the published Gentle AI v3.6.1 artifacts, update any evidence-backed contract metadata, regenerate runtime modules and update tests/docs as needed. Route: delegated writer (multi-file write and preparation triggers). Acceptance met: signed checksums, four archive and binary digests and Windows Sum verified; explicit capabilities/v2.6 row, focused/packed/full checks, commit and RDD outcome recorded below.
- [ ] T2 — Deliver the pin PR linked to #1362 and release gentle-pi v3.6.0 from the merged exact main head. Route: parent release coordination, bounded delegated verification where appropriate. Acceptance: checks pass, PR merged under repository policy, annotated tag and GitHub Release with canonical notes, successful `publish.yml` dispatch from main, npm version/dist-tag verified, release validation linked; commit/tag/run identities recorded.

## Progress and verification evidence
- Issue #1362 is open, `status:approved`, `type:chore`; prior pin PR #1344 merged. Upstream v3.6.1 release has four platform archives and signed checksums. The branch started at `origin/main` `5df9590e`; `package.json` was already v3.6.0.
- T1 implemented in `bc2b1e0a240c5e18628658a4f4a8fe3550ed27ad` (`feat(runtime): pin published gentle-ai v3.6.1`). The v3.6.0 and v3.6.1 provider-contract bundles are byte-identical; the published v3.6.1 binary advertises capabilities/v2.6. Runtime module regenerated. Strict TDD RED: pin and new capability-row assertions failed before implementation; GREEN: focused suite 135/135. `pnpm test`: 3,346 passed, 38 skipped, 0 failed (Windows-specific checks unavailable on macOS). `pnpm run check:runtime-modules`, `node scripts/verify-package-files.mjs`, and `node scripts/test-packed-runner.mjs` all passed. Independent focused spot check: 65 passed, 0 failed. A preceding independent attempt hit a PID-named fixture `EEXIST` collision (133 passed, 1 failed); isolated scenario passed twice and final focused run passed. Runtime harness: packed runner passed against the published v3.6.1 asset. Rollback: revert the T1 pin work unit and its paired tests/docs, without reverting unrelated work.
- Native RDD assessment: high (`process_boundary`), 210 frozen changed lines. Review lineage `review-7d59c0496084d97d` approved by four lenses and acknowledged; authority burned. Nonblocking readability advisory R2-001 on this progress document is informational, not a correction. Delivery remains ordinary repository policy.
- T2 pending. Running authored line count: about 204 lines for T1 including the task document (generated runtime excluded); under the 400-line delivery heuristic. PR slice: T1 pin work unit plus this progress update; release follows merge.

## Next step
Push the feature branch, create the approved issue-linked PR, merge after checks; only then tag the exact merged `main` head and publish through Actions.
