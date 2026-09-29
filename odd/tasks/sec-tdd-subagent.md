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
    - Scoped native `Agent` fallback for security delegation to test-only edit surfaces and command restrictions, reporting delegation unavailable if unenforceable.
    - Updated sensitive attack surfaces in `assets/orchestrator.md` trigger 6 to include webhook verification, aligning with `orchestrator-delegation.md`.
    - Updated delegation catalog assertions in `tests/package-manifest.test.ts` for `gentle-ai-security.md` (agent count to 4, expected owner assets, all-assets count to 11, and model routing verification for `gentle-ai-security`). Observed all 55/55 tests passing.
