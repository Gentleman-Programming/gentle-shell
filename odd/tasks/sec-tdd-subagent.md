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
    - Addressed CodeRabbit review feedback on `assets/agents/gentle-ai-security.md`: aligned the agent description, purpose statement, and non-blocking rejection guidance so `gentle-ai-security` returns findings and evidence to the parent orchestrator (which owns updating the active ODD task file) rather than implying subagent ownership over ODD tasks.
- Previous continuation superseded by the full review implementation below. Historical checks above are not evidence for the new work.

## Authorized review implementation
The user authorized all proposals from the human review on PR #1537, including runtime, CodeGraph, and ODD changes previously deferred. Preserve historical SEC-1 through SEC-6 evidence; the contracts below supersede historical tool-confinement decisions.

### Delivery and safety
- Strategy: auto-chain, stacked-to-main, selected explicitly by the user. Verified upstream default branch: main.
- Keep each entire PR diff at most 400 additions plus deletions, including tests and docs. Existing #1537 starts at 225 changed lines, head `0d5c5338`. Measure actual branch-base diffs before delivery; never compress code to fit.
- Forecast: 8 or more coherent slices, approximately 2,000–3,200 changed lines total; refine after runtime mapping. First slice updates #1537 if its full diff fits; later branches target the preceding branch. Publishing slices is authorized; merging is not.
- One writer at a time. Use delegated implementation for multi-file changes and command verification. Applicable deterministic behaviors require observed RED, GREEN, then focused refactor checks.
- A role split is least privilege, not an OS sandbox. Tool admission is not per-edit enforcement. CodeGraph init creates an index. Bash/network guarantees require independently enforced isolation; do not pretend a command allowlist confines repository-controlled test execution.
- No secrets or live external attacks. Mutation verification uses an isolated disposable candidate, never a destructive revert in the active tree. Policy edits require separate human approval, even for agents with write tools.

### New tasks and proposed slice boundaries
- [x] SEC-7: Convert security to an analyst with read/grep/find/codegraph only; route test authoring to worker and execution to verifier; remove writable detection policy and circular fallback. Route: delegated multi-file writer. Checks: agent tools, generic contracts, ODD routing, packaging. Commit: `688085ec`.
- [ ] SEC-8: Test real security dispatch and model/profile selection, including effective tool denial; use existing dispatch harness rather than prose-only assertions. Route: delegated writer. Checks: dispatch and profile integration tests. Status: in progress; next PR slice.
- [ ] SEC-9: Implement typed finding evidence and deterministic lifecycle validation: hypothesis/refuted/advisory/verified/remediated/locked; require assertion-specific RED, GREEN, isolated mutation RED, provenance, and independent severe-finding confirmation. Route: delegated writer. Checks: transition, malformed-evidence, setup-error, provenance and severity tests.
- [ ] SEC-10: Add deterministic sensitive-diff floor using paths/dependencies/patterns; graph may only expand scope. Integrate automatic ODD consent routing and structured declined-audit records without blocking or inventing a vulnerability. Route: delegated writer. Checks: triggers, false-negative floors, consent and decline integration tests.
- [ ] SEC-11: Extend bounded CodeGraph wrapper with structured callers/callees/impact/affected, index/commit provenance and affected regression selection with conservative fallback. Route: delegated writer. Checks: wrapper validation, output bounds, stale-index and missing-edge cases.
- [ ] SEC-12: Respect telemetry opt-out in CodeGraph and child invocations; document index and subprocess side effects honestly. Route: delegated writer. Checks: subprocess environment, inherited overrides, no unintended enablement.
- [ ] SEC-13: Bind per-actor identity and capabilities at spawn; reject prohibited tools/paths before execution and reject out-of-scope captured writes at exit without attributing unrelated concurrent changes to the child. Route: delegated writer. Checks: child hook, identity, path/glob/symlink, continuation and exit-capture integration tests.
- [ ] SEC-14: Add protected versioned negative specification, deterministic enforcement and canaries; prevent actor modification of policy and .semgrep without human approval. Route: delegated writer. Checks: one violation canary per claimed invariant, policy ownership and malformed-policy fail-closed tests.
- [ ] SEC-15: Implement the supported bash/network isolation path with explicit capability detection and safe unsupported-platform behavior, not prompt guarantees; keep ordinary user setup organic. Route: delegated writer following bounded architecture mapping. Checks: supported isolation and unsupported/missing-sandbox cases; report any unavailable OS checks.
- [ ] SEC-16: Verify and publish all bounded slices, link dependencies and follow-ups, and respond to the reviewer with observed evidence. Route: delegated verifier plus parent delivery. Checks: per-slice focused/full applicable suites, <=400-line diffs, package integrity and user-owned native RDD boundaries.

### Acceptance and progress
- All proposals must have implemented behavior and applicable checks, or an explicit unresolved blocker; a prompt-only promise is not implementation of runtime enforcement.
- No new ODD CLI, specialist orchestration runtime, mandatory manual configuration, or automatic merge. Existing parent/subagent flow remains the user-facing entry point.
- Mapping received; reject scout suggestions that call test surfaces a sandbox or add mem_save to the read-only analyst. Broader runtime and CodeGraph mapping still required before their slices.
- SEC-7 evidence: observed contract RED then GREEN; independent verifier confirmed 17/17 agent/ownership and 76/76 packaging/routing tests, package check 156 files/69 pinned artifacts, and whitespace checks. Prompt reduced from 9,190 to 8,175 bytes without raising the 8,192-byte cap.
- Native review `review-f85ef0763165beb9`: high tier, four lenses approved; exact acknowledgement burned authority. Nonblocking clean-gate/CodeGraph advisories belong to later SEC-9/SEC-11, not reopening this review. Initial sync stop resolved with the exact provider sync command.
- First slice boundary: `688085ec`, full PR diff 389 changed lines before this evidence update (including task file). Next: publish #1537 updates after final size check, then branch `test/sec-tdd-dispatch` from this boundary for SEC-8. Runtime dispatch is not yet proven by the contract-only SEC-7 tests. Engram mirror available.
