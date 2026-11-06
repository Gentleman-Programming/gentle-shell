# #1091 Inspect/START Committed-Range Parity

## Objective

Make `gentle_review` inspect honor an explicit committed-range selector so the candidate inspected before START matches the `baseRef` and `committedOnly` inputs START will use.

## Problem

The Pi facade's inspect branch currently derives negotiated STATUS from only `cwd`. It silently ignores an input object carrying `baseRef` and `committedOnly`, while ordinary START parses and applies the same selector. A caller can therefore inspect one ambient candidate and attempt to start a different committed-range candidate, which fails closed as projection drift.

## Why

Gentle-shell issue #1091 reports `candidate-target-projection-drift` when reviewing one exact committed range. Current-source triage for Gentle AI #4504 item 4 confirms the facade asymmetry and found no direct inspect-to-START parity test.

## Scope

- Accept the existing JSON `input` shape on `operation: "inspect"` for `baseRef` plus `committedOnly`.
- Forward the explicit selector to negotiated STATUS using the same validation rules as ordinary START.
- Preserve ambient inspect behavior when no selector is supplied.
- Fail closed on malformed or incomplete committed-range input.
- Add focused controller tests for explicit selector forwarding and default behavior.

## Constraints

- Allowed edit surfaces: `extensions/gentle-ai.ts`, `tests/review-controller-native-routing.test.ts`, `tests/native-review-cli.test.ts` only if required, and this task document.
- Do not alter provider-owned target identities, bindings, consent, or lifecycle authority.
- Do not modify Gentle AI or any prepared worktree.
- Technical artifacts remain in English.
- No push or pull request without separate authorization.

## TDD

- Mode: strict TDD enabled.
- Source: project testing configuration persisted for gentle-pi (`strict_tdd: true`).
- Focused runner: `node --experimental-strip-types --test tests/review-controller-native-routing.test.ts`.
- Required cycle: RED → GREEN → REFACTOR.

## Tasks

- [x] **T1 — Prove the inspect divergence.** Added focused explicit-selector and malformed-selector regressions. RED observed: explicit inspect sent `baseRef: undefined` / `committedOnly: undefined`; malformed inputs reached STATUS instead of returning `native-inspect-input-invalid`.
- [x] **T2 — Align inspect selection.** Inspect now validates the exact `{baseRef, committedOnly: true}` input, canonicalizes the base commit, forwards it through initial and intended-untracked STATUS reads, and preserves selectorless behavior. Focused GREEN: 2 passed, 0 failed.
- [x] **T3 — Verify the work unit.** Focused controller tests, the full controller routing file, related native selector tests, the typecheck ratchet, and `git diff --check` all passed. Repository status contains only the two authorized source/test files and this task document.

## Acceptance Criteria

- Explicit committed-only inspect and subsequent START select the same base range.
- Selectorless inspect remains unchanged.
- Invalid selector combinations fail before native mutation with actionable diagnostics.
- Focused tests and type checking pass.

## Progress

- Canonical issue identified as `Gentleman-Programming/gentle-shell#1091`; no duplicate issue was created.
- Tracking created before the first source or test write.
- Strict TDD RED confirmed the controller dropped the explicit inspect selector and accepted malformed selector input.
- Minimal implementation and focused GREEN complete.
- Independent verification passed every acceptance criterion. A low test-coverage note was closed by asserting symbolic `HEAD` canonicalization and selector retention across both intended-untracked STATUS reads.
- Work-unit commit: `19932eacd8612cda070d23c73e452cc8a4b80791` (`fix(review): align inspect committed range`).
- Engram mirror pending: the active Pi session is bound to the `gentle-ai` Engram project and refused a cross-project write.

## Checks

- RED: `node --experimental-strip-types --test --test-name-pattern='INSPECT (forwards an explicit committed-only base selector|rejects malformed committed-range selectors)' tests/review-controller-native-routing.test.ts` — 0 passed, 2 failed with the expected dropped-selector and missing-validation assertions.
- GREEN: same focused command — 2 passed, 0 failed.
- Full controller routing: `node --experimental-strip-types --test tests/review-controller-native-routing.test.ts` — 71 passed, 0 failed.
- Native selector coverage: `node --experimental-strip-types --test --test-name-pattern='negotiated STATUS (forwards|emits)' tests/native-review-cli.test.ts` — 2 passed, 0 failed.
- Typecheck: `pnpm run typecheck` — 197 recorded diagnostics, no regressions; two existing file/code pairs improved.
- Formatting integrity: `git diff --check` — passed.
- Scope check: only `extensions/gentle-ai.ts`, `tests/review-controller-native-routing.test.ts`, and this task document are changed.
- Independent verification: PASS for all five acceptance criteria; 71 controller tests, 2 native selector tests, typecheck ratchet, and diff check passed.
- Follow-up verification: symbolic base canonicalization plus both initial/second STATUS selector assertions — 3 passed, 0 failed; typecheck and diff check passed; no remaining candidate-caused findings.

## Next Step

Run the authorized native review over the committed work unit, then push and open the authorized PR. The Engram mirror remains pending because this session is bound to another project.
