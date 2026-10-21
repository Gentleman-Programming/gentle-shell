# Native Git bootstrap and same-session writer parity

## Objective
Allow authorized development in an initially unversioned project to use Gentle AI's native repository preparation and launch real bounded writers without restarting the parent Pi session.

## Problem and rationale
Pi previously rejected explicit unversioned review targets before native preparation and retained absent startup Git identity after the original project became a repository. Preparation must support writer-first development without restoring the unsafe passive startup behavior documented in #656.

## Scope and human authorization
- Isolated worktree: `../gentle-pi-rdd-bootstrap-parity`.
- Feature branch: `fix/rdd-non-git-bootstrap-parity`.
- Baseline: `338f1f654cf614cbb9956a5bb57488e62612e5c9`.
- Preserve primary checkout and unrelated notification work.
- Allow preparation only after a successful own development source write/edit, explicit selected review, or admission of a valid generic bounded writer (`gentle-ai-worker`/`worker`).
- Require validated effective RDD-on. Off, unknown, unavailable and malformed mode fail closed.
- Native Gentle AI owns initialization, ancestor reuse and broken-metadata safeguards. Pi adds no independent `git init` or repair policy.
- Passive startup, conversation, exploration, invalid dispatch and task/memory/documentation-only bookkeeping never initialize Git.
- Protect canonical HOME, filesystem root, sensitive/escaping targets and foreign-repository consent.
- Preparation creates no commits, remotes, review lineage, source ownership receipt or preparation-only Changes attribution.
- Adopt missing Git identity only from the original session-bound canonical project; retained established identity cannot disappear into new bootstrap eligibility.
- Manager object, session ID and binding incarnation must remain current across asynchronous preparation. Cancellation and lifecycle revocation are independent boundaries.
- An explicitly selected safe foreign project remains usable from a HOME session; HOME itself is never bootstrapped.

The human selected the installed development binary, offline deterministic provider and real production Pi children. No published-pin download, dependency install, shared `node_modules` mutation, global configuration change or paid/external fixture model call is authorized.

## Delivery strategy
- Approved issue: [#1567](https://github.com/Gentleman-Programming/gentle-shell/issues/1567), labels `bug`, `type:bug`, `status:approved`.
- Target: `github.com/Gentleman-Programming/gentle-shell`, default branch `main`.
- Human authorized existing `gh` session over HTTPS for scoped issue creation/approval, branch push, one PR and merge after checks. No SSH, force-push or release.
- Human selected `Closes #1567` and one PR with `size:exception`.
- Rationale: native preparation, retained authority, lifecycle revocation and genuine writer continuation form one integration behavior. Keep their negative and real-process regressions together instead of omitting tests or splitting artificial review slices.
- Source/test slice: **1,592 authored lines**, excluding this document (960 tracked additions +197 deletions +435 untracked lines). Earlier 1,435 was an arithmetic error; prior corrected counts were 1,335 and 1,482.
- Cohesive parity work-unit commit: `d2dd989488fb8b553760ef08b936a23348563f8e` (`fix(review): prepare native Git safely for same-session writers`). Its 14 implementation paths exactly match the approved immutable candidate; only this passive task document differs. Initial commit:1,699 authored lines including the107-line document. A passive documentation closure records the observed evidence; no source mutation after checks. Push, PR and merge remain pending.

## Tasks and routing
- [x] **T1 — Guard native preparation entry.** Verified with full/focused/native/independent checks; closed in work-unit commit `d2dd989488fb8b553760ef08b936a23348563f8e`. Route: delegated multi-file writer with shared admission and validation before preparation. Trigger: multiple nontrivial source files and preparatory reading.
- [x] **T2 — Preserve same-session Git authority and prove real writers.** Verified with actual SDK children and independent checks; closed in work-unit commit `d2dd989488fb8b553760ef08b936a23348563f8e`. Route: delegated mapping/writer and independent high-risk verification. Trigger: cross-module flow across four or more files.
- [x] **T3 — Reject revoked explicit-review incarnation.** RED/GREEN and independent PASS observed; closed in work-unit commit `d2dd989488fb8b553760ef08b936a23348563f8e`. Route: one additional narrowly bounded correction explicitly authorized by the human, followed by independent verification. Trigger: shared lifecycle helper plus explicit review entry paths.

T3 edit surfaces were exactly `extensions/gentle-ai.ts`, `lib/bounded-writer-admission.ts`, `tests/bounded-writer-admission.test.ts` and `tests/review-controller-workspace-root.test.ts`. No automatic further correction loop is authorized.

## Acceptance criteria
1. Successful source, explicit review and admitted generic writer entries may prepare only after mode, profile/model, discovered role, bounded surface and selected project validation.
2. Invalid dispatch neither prepares nor queues a child; valid admission prepares before OS spawn.
3. Established metadata loss, root/common-dir drift, shutdown and manager replacement produce no preparation, native STATUS/START, queue, spawn or recreated `.git` from a stale context.
4. Explicit INSPECT/ordinary START capture the original incarnation before a mode await and require it afterward. Revocation never becomes permissive missing-binding fallback; legitimate never-bound compatibility remains intact.
5. Existing clone, linked-worktree, foreign consent and safe explicit selection from sandbox HOME remain valid.
6. Actual production children use the installed SDK/CLI, reach RPC readiness and settle/complete under unchanged parent manager/session ID, without reload. Implicit and explicit first-action dispatch have separate fresh fixtures.
7. Retired IMPORT/EXPORT return `legacy-operation-retired` without irrelevant repository discovery; INSPECT retains the two-call public route.
8. Checks run after final normalization. Skips and ratchet diagnostics are not reported as passes or clean typing.

## Verification commands
Focused suite:
```sh
node --experimental-strip-types --test tests/bounded-writer-admission.test.ts tests/writer-edit-surface-scope.test.ts tests/gentle-agents.test.ts tests/profile-pin.test.ts tests/session-worktree-registry.test.ts tests/gentle-shell.test.ts tests/review-agent-end-preflight.test.ts tests/review-controller-workspace-root.test.ts tests/review-controller-native-routing.test.ts tests/review-controller-retired-ops.test.ts tests/windows-hidden-processes.test.ts
```

Actual SDK/development binary proof:
```sh
GENTLE_AI_DEV_BINARY="$GENTLE_AI_DEV_BINARY" GENTLE_PI_REQUIRE_DEV_BINARY=1 node --experimental-strip-types --test --test-name-pattern='SDK non-Git bootstrap|pre-bootstrap SDK session' tests/devbinary/native-review-parity.devtest.ts tests/devbinary/non-git-subagent-bootstrap.devtest.ts
```

Additional checks:
```sh
node scripts/check-types.mjs
node scripts/build-runtime-modules.mjs --check
node scripts/check-provider-contract.mjs
git diff --check
node --experimental-strip-types --test tests/*.test.ts
node --experimental-strip-types tests/runtime-harness.mjs
```

Full-unit and harness execution use owned disposable npm user/global configuration, cache and logs, `npm_config_offline=true` and `npm_config_ignore_scripts=true`. Harness V8 coverage confirms the final picker/registry phases. Shared dependencies remain untouched; unsafe automatic pnpm installation is not used.

## Observed evidence
Initial independent verification found five actual unit regressions and a static established-Git-loss defect. A scoped correction closed retired envelopes, duplicate discovery and authority-loss handling. Subsequent independent verification confirmed all commands but identified explicit-review revocation during a mode await; the human authorized T3.

T3 RED reproduced four failures: INSPECT/ordinary START × shutdown/same-ID manager replacement each reached STATUS with an un-aborted caller signal. GREEN covered shutdown, replacement, rebinding, changed ID and cancellation: zero stale STATUS/START/bootstrap. Live selected project from sandbox HOME remained allowed; HOME and candidate bytes unchanged.

Final writer evidence:
- Focused suite: **623/623 passed**.
- Real SDK/development fixtures: **3/3 passed**; implicit child PID99812 and explicit PID628 reached RPC readiness, settled and completed after native-before-spawn assertions with unchanged parent sessions.
- Full unit suite: **4,117 total; 4,066 passed, zero failed, 51 skipped**.
- Type ratchet: **188 recorded diagnostics, no regressions, 10 improved pairs**; not clean typing.
- Runtime modules and provider contract: passed.
- Whitespace: passed.
- Harness: silent exit0; V8 coverage corroborated final picker and registry execution.
- Installed process SDK/CLI: **0.87.1**, not proof of the original interactive incident's unknown version.
- Native development executable: **3.0.0-20260928192733-61692e5ff953**, not published **3.7.0** compatibility proof.

Final independent task `munpvo22-i-6p2y`: **PASS**, prior explicit lifecycle blocker closed. All12 held-mode public-tool cases passed with revocation independent of caller abortion; live and never-bound compatibility retained. It independently confirmed focused623, devSDK3, fullunit4,117/4,066pass/zeroFAIL/51skip, type188 ratchet10improvements, provider/whitespace and coverage-complete harness. The parent's requested runtime-module spot check ran first and passed. Actual implicitPID86100 and explicitPID86836 completed under unchanged parent sessions. Candidate fingerprints and shared dependency link unchanged; no remaining blocker within scope. No further audit expansion or automatic correction is authorized.

## Native review evidence
Final normalized 14-path implementation slice:
- Candidate tree: `aef68b5a8bc34518f3daf59a5671086e00ce94af`.
- Target: `sha256:c57e7d7c741a5b7f763ca299150c564fa344b9eac5436750340378baa15e4506`.
- Lineage: `review-3e3128fc93751c51`, medium tier, 1,592 lines, one consolidated reliability review.
- Approved, then exact acknowledgement consumed revision `sha256:504ca09c6251318150a57f2dec4105bb08accd1459acc165d1f92df39f0cb2ce` and burned authority (`gentle-ai.review-acknowledged/v1`).
- `R3-target-drift` at `extensions/gentle-ai.ts:7657` is informational, nonblocking, separate later work. No correction is offered; do not reopen/replay this immutable candidate's review.
- Prior approved candidates were superseded by explicitly authorized source corrections, not replayed.

Review closure is not delivery authorization or a substitute for independent functional disposition.

## Gaps and next step
Published-pin, native-platform and unavailable PATH-Pi exclusions remain **51 skips**, not passes. No modified scripts or skills require shellcheck/skill-load proof. Repository has no PR template; use the issue/type/summary/changes/test/checklist structure from the branch/PR skill without inventing a template.

Independent disposition, native review and work-unit commit are complete. Publish the authorized branch and one linked PR with `type:bug` and `size:exception`, confirm target-policy CI, then merge under the human's authorization. No merge on an unverified green claim or a remaining blocker.
