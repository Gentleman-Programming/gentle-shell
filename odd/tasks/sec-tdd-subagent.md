# Sec-TDD Subagent and Post-Worker Workflow

## Objective
Package the `gentle-ai-security` subagent in Gentle Shell, integrated into the Organic Driven Development (ODD) workflow as a post-worker security auditor and Sec-TDD test-authoring specialist with an organic user confirmation gate and explicit ODD vulnerability documentation.

## Problem / why
Security-sensitive changes (authentication, authorization, session management, untrusted inputs, payment gateways, encryption, webhook verification) require defensive negative regression tests to prevent regressions. Running security auditing inline or unprompted introduces unwanted token overhead and friction. A post-worker subagent gated by an organic user prompt allows developers to opt in, document real vulnerabilities in ODD, observe RED tests, delegate the fix to the worker, and observe GREEN before continuing the task checklist.

## Authorized scope
- Packaging `assets/agents/gentle-ai-security.md` in `gentle-shell`.
- Asset ownership registration in `lib/agent-assets.ts` (`delegation` owner).
- Updating orchestrator delegation rules and prompt contracts in `assets/orchestrator.md` and `assets/orchestrator-delegation.md` to define the post-worker trigger, the explicit user ask gate, ODD vulnerability documentation, and fix delegation to the worker.
- Tests covering generic agent tool contracts in `tests/generic-agent-tools.test.ts` and packaging manifests in `tests/package-manifest.test.ts`.
- Work units kept under 400 lines per slice.

## Constraints and decisions
- **Post-Worker Invocation**: `gentle-ai-security` runs strictly **after** `gentle-ai-worker` completes an implementation task affecting sensitive attack surfaces, not before or in parallel.
- **Organic User Ask Gate**: Before invoking `gentle-ai-security`, the orchestrator presents a brief, organic confirmation to the user identifying the touched sensitive surface and the proposed audit. If the user declines or insists on leaving the code as is, the orchestrator immediately respects the decision without friction or blocking.
- **Defensive Sec-TDD Loop**:
  1. Hypothesis refutation against existing controls.
  2. If a flaw is verified, author a negative regression test (observed RED).
  3. Document the vulnerability finding and evidence in the ODD task file (`odd/tasks/<feature>.md`).
  4. Delegate the production code remediation to `gentle-ai-worker` (security agent does not edit production code).
  5. Verify that the negative test now passes (observed GREEN).
  6. Mark task complete and resume the TODO list.
- **Tool Confinement**: `read`, `grep`, `find`, `edit`, `write`, `bash`, `mem_save`. Edit surface is confined to security tests and static rules (`tests/security/`, `**/*.security.test.*`, `.semgrep/`).
- **No live attacks, no real credentials**: All verification uses local test harnesses and synthetic fixtures. Prompt confinement is recognized as non-sandboxing; explicit tool and path constraints apply.

## Tasks
- [x] SEC-1: Register `agents/gentle-ai-security.md` in `lib/agent-assets.ts` and package `assets/agents/gentle-ai-security.md` with strict tools and confinement contracts.
- [x] SEC-2: Update `assets/orchestrator.md` and `assets/orchestrator-delegation.md` with the post-worker trigger, the organic user ask gate, ODD vulnerability tracking, and worker fix delegation.
- [x] SEC-3: Add unit tests verifying `gentle-ai-security.md` tool allowlist, edit surface rules, and asset manifest integration in `tests/generic-agent-tools.test.ts`.
- [x] SEC-4: Run focused test suite, observe GREEN, evaluate work-unit commits via native RDD assessment, and prepare handover checklist.
- [x] SEC-5: For verified HIGH/CRITICAL findings, have the security agent request a user decision on generating a separate vulnerability document; keep the parent responsible for relaying the question and generate nothing without consent. Test the prompt contract.
- [x] SEC-6: Integrate current `upstream/main` into the PR branch, resolve the two orchestrator asset conflicts without losing either side's routing rules, and verify the merged tree.

## Progress / evidence
- 2026-09-24:
  - Created task plan and branch `feat/sec-tdd-subagent` in `/home/reaan/Work/gentle-shell`.
  - Packaged `assets/agents/gentle-ai-security.md` (87 lines) declaring tools `[read, grep, find, edit, write, bash, mem_save]` and strict test confinement.
  - Registered delegation ownership in `lib/agent-assets.ts` and package verification in `scripts/verify-package-files.mjs`.
  - Added trigger 6 to `assets/orchestrator.md` and `assets/orchestrator-delegation.md` covering the post-worker execution, the organic user confirmation gate, ODD tracking, and worker fix delegation.
  - Verified tests in `tests/generic-agent-tools.test.ts` (RED -> GREEN, 4/4 passing) and package resources (153 files check passed).
  - Total authored lines: ~135 lines (well below the 400-line review limit). Production code and git commits remain uncommitted until explicit user confirmation.
  - Authored work-unit commit `bc69c135` (`feat(odd): package gentle-ai-security subagent with post-worker Sec-TDD workflow`).
  - Pushed branch `feat/sec-tdd-subagent` to `origin`.
  - Opened pull request `Gentleman-Programming/gentle-shell#1537` linking issue #1530.
  - Resolved CodeRabbit review findings in `assets/orchestrator.md` and `assets/orchestrator-delegation.md`:
    - Defined clean-audit path (no verified flaw -> report clean result and resume checklist directly without requiring RED tests or worker remediation).
    - Clarified clean-audit status requirements in orchestrator and delegation rules: clean audit and resumption require `status: completed` with no verified vulnerabilities; `status: partial`, `status: blocked`, and `status: interaction_required` require completing the audit, clearing blockers, or providing needed input first.
    - Scoped native `Agent` fallback for security delegation to test-only edit surfaces and command restrictions, reporting delegation unavailable if unenforceable.
    - Updated sensitive attack surfaces in `assets/orchestrator.md` trigger 6 to include webhook verification, aligning with `orchestrator-delegation.md`.
    - Updated delegation catalog assertions in `tests/package-manifest.test.ts` for `gentle-ai-security.md` (agent count to 4, expected owner assets, all-assets count to 11, and model routing verification for `gentle-ai-security`). Observed all 55/55 tests passing.

## Continuation (PR #1537 merge and severe-vulnerability document option)
- Scope: edit the existing security-agent contract and its parent relay/tests; merge `upstream/main` into this branch without dropping upstream changes. A separate vulnerability document is optional and must not be generated automatically; security tests and ODD finding tracking remain required regardless of that choice.
- Acceptance: only verified HIGH/CRITICAL findings offer the document question; the user can decline without blocking remediation; parent relays the choice and authorizes document generation separately. Merge simulation reports content conflicts in `assets/orchestrator.md` and `assets/orchestrator-delegation.md` (fetched `upstream/main` at `1162ce90`). No unmerged paths or conflict markers remain; relevant tests and package checks pass.
- Route: SEC-5 delegated bounded writer (multi-file security agent/tests), SEC-6 delegated bounded writer for conflicted assets after parent begins merge; parent owns commits and verification spot checks.
- TDD: test-first for behavior contract; `node --experimental-strip-types --test tests/generic-agent-tools.test.ts tests/package-manifest.test.ts`. Configured ODD mode not established from repository settings; do not claim configured TDD beyond observed RED/GREEN.
- Delivery: existing PR branch, one work-unit commit per task; no push/merge to remote without user decision. Engram mirror pending: installed Engram binary lacks `instance-id` support.
- Blocked 2026-09-25: `gentle-ai-explore` failed twice (`assistant reported an error`, once after 15 turns and once immediately on narrow retry). The Pi session has no native `Agent` fallback; mandatory mapping cannot be completed safely. No source, test, or merge changes made. Repository remains clean except this task document. Engram mirror attempt failed with incompatible binary. Resume by restoring subagent runtime, mapping conflicts read-only, then SEC-5 and SEC-6.
- Progress 2026-10-01:
  - Subagent connectivity recovered: `gentle-ai-explore` and `gentle-ai-verify` operational.
  - Merged `upstream/main` (commit `1162ce90`) into `feat/sec-tdd-subagent` (SEC-6):
    - Resolved conflict in `assets/orchestrator.md` preserving both upstream evidence budget / context backstop routing and the Sec-TDD trigger 6.
    - Resolved conflict in `assets/orchestrator-delegation.md` preserving upstream ASSESS writer model/effort profiling and continuation projection alongside the Sec-TDD trigger 6.
    - Created merge commit `d9e81cca` after conflict resolution.
  - Implemented SEC-5:
    - Added `Severe Vulnerability Documentation (Optional & User-Gated)` section to `assets/agents/gentle-ai-security.md`.
    - Gated document generation strictly to verified `CRITICAL` or `HIGH` findings.
    - Explicitly stated that document generation is never automatic, requires explicit user consent, non-severe findings (`MEDIUM`/`LOW`/`INFO`) do not prompt, and declining does not block test authoring or worker remediation.
    - Added `document_request` schema to the Return Contract.
    - Authored contract tests in `tests/generic-agent-tools.test.ts`. Observed RED failure on assertion, then GREEN after pattern refinement (all 5/5 passing).
    - Verified full manifest and routing suites: `tests/package-manifest.test.ts` (55/55 PASS), `tests/generic-agent-tools.test.ts` (5/5 PASS), `tests/odd-routing-contract.test.ts` (14/14 PASS), `tests/odd-routing-canonical-ratchet.test.ts` (7/7 PASS), `scripts/verify-package-files.mjs` (156 files PASS), and runtime modules check (PASS).
- Next: Author work-unit commit for SEC-5, commit task document, review candidate, and report status to user.

## Follow-up items
- **Runtime enforcement gate for `gentle-ai-security`**: CodeRabbit noted that Pi's runtime does not enforce file-path or bash restrictions beyond prompt confinement. The orchestrator already documents "report test-authoring delegation unavailable if unenforceable" as the mitigation. A runtime gate analogous to `rejectUnscopedBoundedWriterDispatch` (checking allowed edit surfaces at dispatch time) would be a systematic improvement for all delegation agents, not only `gentle-ai-security`. This belongs to a separate PR/issue once the enforcement mechanism is designed.
