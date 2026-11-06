# Gentle Shell forward compatibility for RDD default ON

- Feature: `rdd-default-on`
- Repository: `gentle-pi`, branch `feat/rdd-default-on`
- Parent ledger: `../gentle-ai/odd/tasks/rdd-default-on.md`
- Route: delegated direct (two test files; parent-provided mapping).
- Authorized edits: `tests/native-review-parity.test.ts`, `tests/rdd-status-line.test.ts`, and this ledger only.
- Forecast: fewer than 150 authored changed lines; no commits authorized.

## Objective and scope

Prove that existing consumers can accept a future provider-decided default ON without changing the current pin's OFF/default contract. The parent's corrected read-only map establishes that pinned Gentle AI 3.2.1 still resolves unset status to OFF/default.

- Preserve every pre-existing OFF/default fixture and assertion.
- Add separate synthetic `{global:"", cloneLocal:"", effective:"on", source:"default"}` coverage for rendering, prompt injection, and reaching native review consent.
- Keep Gentle AI as the only mode owner; automation may read mode but must not change it or infer candidate consent.
- Preserve explicit global/clone-local OFF and unavailable fail-closed behavior.
- No production, runtime, generated contract, pin, asset, or release-dependent documentation changes.

## Tasks

- [x] T3.1 Restore current-pin OFF/default coverage and correct the earlier invalid RED interpretation.
- [x] T3.2 Add separate synthetic default-ON consumer coverage; retain source-consistent helper fields and explicit OFF controls.
- [x] T3.3 Run focused checks and whitespace validation for this test-only scope.
- [ ] Release handoff: runtime/docs/default adoption and Gentle AI pin/assets require an explicitly authorized published Gentle AI release.

## Verification and corrected TDD evidence

- TDD exception: this is forward-compatibility coverage of already-supported consumer behavior, requiring no production change. The separately modeled tests passed immediately; there is no valid behavioral RED to claim.
- Earlier assertions deliberately contradicted current-pin OFF/default fixtures. Their two failures were test-model errors, not evidence of a production defect. The earlier 38-test pass after replacing fixtures did not establish adoption of default ON and is superseded by this corrected coverage.
- `node --experimental-strip-types --test tests/native-review-parity.test.ts tests/rdd-status-line.test.ts`: exit 0; 40 passed, 0 failed on the first run of the separately modeled coverage.
- Synthetic default ON renders and is injected into the parent prompt; native START is called once and reaches candidate consent. Mode requests are read-only STATUS and consent is not automatically answered.
- Existing default OFF, explicit global/clone-local OFF, malformed/unavailable status, and candidate consent controls pass unchanged. The helper now populates explicit fields according to the deciding source.
- `git diff --check`: passed (exit 0).
- Package-level commands were executed directly to avoid pnpm's dependency-status install path: `node --experimental-strip-types --test tests/*.test.ts` passed (2,773 passed, 47 skipped, 0 failed); `node scripts/check-provider-contract.mjs` passed (contract 1.2.0, 9 bundle entries, 2 generated baselines).
- Runtime harness remains environmentally unavailable in this isolated worktree. `env -u GENTLE_PI_AGENTS_CHILD node --experimental-strip-types tests/runtime-harness.mjs` stopped at `tests/runtime-harness.mjs:492` with `package-local-binary-missing` for `.gentle-ai/v3.2.1/gentle-ai`. A user-authorized symlink to the existing binary tree was rejected by the runtime's package-local integrity boundary, so the ineffective symlink was removed; no binary was copied or installed. No candidate causality is established, and no successful harness result is claimed.
- The parent supplied an authorized `node_modules` link to existing dependencies; it remains ignored and is not part of the candidate.

## Handoff and acceptance

Immediate test-only forward compatibility is complete. This does not prove the pinned provider defaults ON, enable RDD, add Shell persistence, or authorize release adoption. Production automation controls remain unchanged. Runtime/docs/default adoption and pin/assets must wait for an explicitly authorized published Gentle AI release and separately scoped verification. No commit, install, publish, or remote operation was performed during this correction.
