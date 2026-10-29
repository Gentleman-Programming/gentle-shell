# RDD START Schema Compatibility

## Objective

Make the canonical Pi review decoder accept the provider-owned generated-path marker emitted in START/v4 manifests, so an isolated committed-only range containing `pnpm-lock.yaml` reaches the consent/start lifecycle instead of collapsing to `schema-incompatible`.

## Constraints

- Use strict behavioral TDD from the user request: observe a focused RED before changing production code.
- Preserve exact-record rejection for unrelated fields and invalid marker values.
- Change the canonical contract directly; add no compatibility shim, alternate decoder, fallback, or retry.
- Do not modify Mena Nails and do not start BF-04.
- Work only on `fix/rdd-start-schema-compat` and close the unit with one Conventional Commit.
- Run independent read-only verification before commit.

## Authorization and issue evidence

- User explicitly authorized implementation and commit in this worktree.
- RDD mode: `on` (global).
- Canonical approved authority line: closed issue #1091 is `status:approved` and its comments identify the clean committed-range `schema-incompatible` continuation; open issue #1239 has the exact generated-manifest reproduction but remains `status:needs-review`. This unit narrows to the already-reproduced contract mismatch and does not claim closure of #1239.
- No matching open PR was found by the pre-write search.

## Mechanism map (completed before source writes)

| Claim | Current anchor | Evidence |
| --- | --- | --- |
| Direct committed-only START reaches the provider consent contract. | Provider-issued `review.status` transition executed unchanged | Detached `7d6d3ec5..` over `d8d6aba1..` returned `gentle-ai.review-integration.consent/v3`, high risk, 6 files, 282 lines, including `pnpm-lock.yaml`. |
| The facade fails only after the host grants that same candidate and decodes START/v4. | `lib/native-review-cli.ts:2237-2255` | Consent is discriminated before START decoding; the later response enters `decodeReviewStartResponse`. |
| START manifests share one strict entry decoder. | `lib/review-integration-v2.ts:1152-1164`, `1256`, `1313-1321` | `decodeChangedPathEntry` is reused by START/v3 and START/v4 and rejects every undeclared key. |
| The provider emits a `generated` marker for recognized generated paths. | Reproduction plus issue #1239 comment | The isolated range contains `pnpm-lock.yaml`; direct consent succeeds, while `gentle_review start` returns `schema-incompatible`, no known lineage, and reconciles to the unchanged start route. The captured decoder diagnosis in #1239 is `start.changed_path_manifest[...].generated is not allowed`. |
| Existing tests do not lock the marker contract. | `tests/review-integration-v2.test.ts:350-373` and repository grep | START manifest invariants are tested, but no generated-path marker case exists. |

### Claim-versus-code mismatch

The earlier hypothesis that automatic committed-range adoption caused this failure is contradicted by the isolated explicit-base reproduction. The failing mechanism is the strict manifest entry contract, not selector adoption.

## Causal invariant

A provider START/v4 response and Pi's canonical START decoder must describe the same changed-path manifest vocabulary. The optional `generated: true` classification is provider evidence; Pi must preserve it while continuing to reject false/non-boolean values and unrelated keys.

## Operator flow and controls

- Positive flow: detached clean worktree at `7d6d3ec5`, base `d8d6aba1`, explicit committed-only STATUS, direct consent/v3, then facade START.
- Negative controls: absent marker remains valid; unrelated unknown keys remain invalid; `generated: false` and non-boolean marker values remain invalid if the provider contract emits only truthy `omitempty` evidence.
- Rollback: revert the single work-unit commit; no stored authority record or migration is changed.

## Task

- [x] RSC-1 — Add the failing generated-manifest regression, update the canonical changed-path contract without compatibility machinery, run focused/full contract checks and independent verification, then commit conventionally.

## Route and checks

- Route: delegated `gentle-ai-worker` because the implementation changes a production decoder and its test.
- Trigger evidence: multi-file write rule (2 non-trivial files).
- TDD mode: strict, source `explicit user request`.
- Exact RED/GREEN runner: `node --experimental-strip-types --test tests/review-integration-v2.test.ts`.
- Broader checks: worker derives existing package checks from repository scripts; independent verifier reruns the focused test and contract/runtime guard.
- Forecast: under 60 authored changed lines; delivery strategy `single-pr`; no chain required.

## Progress

- 2026-09-22: read-only mechanism map completed.
- 2026-09-22: exact isolated reproduction completed in `/tmp/gentle-shell-rdd-start-schema-repro`; direct native START returned consent/v3, while `gentle_review start` returned `schema-incompatible` with `mutation_outcome: unknown` and reconciliation showing no candidate/lineage.

## Evidence

- RED (2026-09-22): `node --experimental-strip-types --test tests/review-integration-v2.test.ts` failed only the new `START/v4 preserves provider-generated manifest evidence while retaining exact omitempty validation` regression with `TypeError: start.changed_path_manifest[0].generated is not allowed` (38 pass, 1 fail).
- GREEN (2026-09-22): `node --experimental-strip-types --test tests/review-integration-v2.test.ts` passed (39 pass, 0 fail), including acceptance and preservation of `generated: true` and rejection of `generated: false`, `generated: "true"`, and an unrelated manifest key.
- Contract/runtime guard (2026-09-22): `pnpm run check:provider-contract` passed: provider contract mirror check passed for contract `1.2.0`.
- Generated runtime remediation (2026-09-22): independent verification found `runtime/review-integration-v2.mjs` stale. `pnpm run build:runtime-modules` regenerated all six declared outputs; only `runtime/review-integration-v2.mjs` retained a Git diff.
- Post-remediation verification (2026-09-22): focused test passed (39 pass, 0 fail); `pnpm run check:provider-contract` passed; `pnpm run check:runtime-modules` reported runtime matches TypeScript sources; `git diff --check` passed.
- Independent verification (2026-09-22): focused test 39/39 passed; provider contract and runtime-module guards passed; `git diff --check` passed; changed scope contained only this task document, the canonical decoder, its generated runtime mirror, and the regression test. No Mena Nails or BF-04 path was touched.
- Native assessment (2026-09-22): `unassessable` because the task document is intentionally untracked before the work-unit commit; the returned high-risk fallback required writer self-verification plus an independent verifier, both completed successfully.
- Commit evidence: the Conventional Commit that first adds this document is the RSC-1 work-unit commit; its immutable identity is reported from `git rev-parse HEAD` after creation.
