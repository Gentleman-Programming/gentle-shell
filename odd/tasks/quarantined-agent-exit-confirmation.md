# Quarantined Agent Exit Confirmation

## Authority and isolation

The user authorizes an autonomous runner fix in the maintained Gentle Pi repository, a separate branch and pull request, regression tests and independent verification. MES, its browser tests, installed packages and live processes are excluded. Never guess ownership, signal unrelated processes, weaken security, or clear quarantine without confirmed exit.

Repository: `Gentleman-Programming/gentle-shell`.
Base: `main` at `75848b029550e37bebadd55e43e55209fbb913b1`.
Branch: `fix/quarantined-agent-exit-confirmation`.
The authenticated GitHub actor has READ permission upstream. Publication must use an authorized contributor destination and respect issue-approval and label policy; no approval is invented.

## Reproduction and intended minimal solution

The runner retains the exact child/process-group binding in its private live map. At the existing cleanup deadline it records failure and quarantine, then clears confirmation timers. If the owned group subsequently disappears without another child-exit event, capacity can remain held indefinitely. Terminal error text alone does not prove current process liveness.

Reproduce with the existing fake child and injected process-control mechanism. Keep the group unconfirmed through the deadline, then make the same bound group return ESRCH without emitting child exit. The minimal polling fix continues safe confirmation through existing runner mechanisms, without arbitrary PIDs or a manual reset API. Independent review found that polling alone does not satisfy the authorized observable-confirmation requirement. Extend the existing `subagent_status` route with a closed exit-confirmation enum, backed only by current-host ownership and confirmed-exit evidence.

Acceptance:
- Unconfirmed, present and permission-error groups retain capacity.
- Confirmed absence of the already-owned group releases capacity once.
- Historical task failure and final result are retained; no duplicate finish occurs.
- Queued work advances only after confirmation.
- Rechecks send no additional termination signals and do not accept caller-supplied PIDs.
- Confirmation timers are cleaned up and do not unnecessarily keep the host alive.
- A missing group binding requires existing trustworthy child-exit evidence, never an assumption.
- Existing status output and structured details expose `confirmed`, `unconfirmed` or `unavailable`, without PIDs.
- Confirmation belongs to the current host and originating session. Historical records, foreign sessions, reload-lost bindings and absent live entries do not authorize confirmation.
- Ordinary running status does not probe or interfere with normal settlement; fresh confirmation is limited to retained quarantine ownership.

## Tasks

- [x] R1 Reproduce and implement owned polling plus fresh status proof with regressions. Work-unit commit: `ebea5675`; independent focused checks 341/341.
- [ ] R2 ACTIVE/BLOCKED: broader checks observed; full unit stage retains 11 baseline failures, with no branch-only failures. Ratchet and runtime checks pass; CI/packed checks are pending.
- [ ] R3 Commit a coherent work unit and prepare/publish a separate PR under target policy.
- [ ] R4 Report evidence and delivery limits; return to the paused MES workflow without running its browser tests.

## Initial evidence

The installed package and maintained checkout both declare gentle-pi 4.0.0. Targeted source exploration found the existing quarantine/confirmation mechanism and regression coverage for late child-exit events, but not disappearance without an event. No source fix or tests have run yet.

The initial read-only scout created a CodeGraph index; it authored no implementation changes. The clone was otherwise clean before branch creation.

Approved issue #633 explicitly covers owned-process cleanup, once-only settlement and retaining queue capacity until confirmation. Use nonclosing `Refs #633` for this follow-up; do not reopen or relabel it. Issue #1740 concerns distinct asynchronous shutdown and is not used as delivery authority. Upstream permission remains READ; contributor destination authorization and exactly one ordinary `type:bug` PR label remain publication requirements.

## Evidence and commits

- Polling RED: three failures (queued child count expected 2, actual 1); subsequent GREEN 3/3. Public runner and registered status RED: four missing-method and four missing-enum failures respectively.
- Final worker GREEN: runner 98/98 twice, registered extension 242/242 twice, combined runner/process/extension 341/341. Independent final checks also passed 4/4 fresh runner, 5/5 status, 98/98 runner and 341/341 combined.
- Safety: current-host immutable launch-session ownership; sole proof insertion at completeExit; no history/absence inference; present/EPERM/EIO remain unconfirmed; normal status does not probe; repeated/stale callbacks never repeat termination or settlement. Text, details and renderer expose the enum.
- Final branch full suite: 5,682 tests, 5,613 passed, 11 failed, 58 skipped. Provider-contract and runtime-harness stages passed. Full suite is not GREEN.
- Exact direct unit-stage comparison in original Git roots: baseline 5,670 / 5,601 passed / 11 failed / 58 skipped; branch 5,682 / 5,613 passed / 11 failed / 58 skipped. Complete failure-name sets are identical; no branch-only failure; 12 additional tests all pass.
- Preserve invalid attempts: baseline pnpm layout preflight aborted before tests; a runtime-directed scratch relocation produced 147 failures and an unexpected capture artifact. Neither was used to establish the original-root comparison. No private logs were inspected by the parent or discarded.
- Typecheck ratchet passed with 186 existing diagnostics and no regressions (not zero-diagnostic compilation). Nine generated runtime modules match; runner is imported directly and is not a generated module.
- Independent diff checks passed; package/lock unchanged; exactly four authorized source/test files changed, 307 diff lines. Local pinned pnpm install ignored lifecycle scripts; earlier loader/pnpm failures are not behavioral RED.
- Current harness was not installed or reloaded. Historical host cleanup remains unknown. No MES/browser test, database operation, unrelated process signal or security relaxation.
- Work-unit commit `ebea5675` contains the four source/test files and this tracker (363 total diff lines). Nonclosing approved issue reference: `Refs #633`. No remote fork, push or PR exists yet; authenticated upstream permission is READ and no current-actor fork was found. Full-suite baseline failures, contributor publication authorization and ordinary type-label assignment remain explicit.
