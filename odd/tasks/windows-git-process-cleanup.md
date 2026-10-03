# Windows Git process-tree timeout cleanup (#927)

## Objective
Prevent the shell's Git runner from leaving Windows descendants alive after a command timeout, without restoring background working-tree inventories.

## Authorization
The user authorized preparing the correction and regression coverage, and subsequently explicitly authorized the work-unit commit and opening a PR for #927 without merging. Merge, dependency installation, native build, heavy repository scans and additional runtime cycles remain unauthorized. The parent owns delivery. PR creation is blocked on the issue-first policy: #927 still has status:needs-review rather than status:approved; a separate explicit issue-label approval decision is pending.

## Evidence and rationale
- Base: upstream main `ac6715933287490307146fcc2131ceaea3374141`.
- Current Changes uses captured session evidence rather than periodic expensive Git status scans; preserve that design.
- Bounded Windows Node v24.14.0 / Git 2.45.1 experiment confirmed Git -> shell -> Node parent -> child remained alive after the direct Git process's 5-second timeout. Token heartbeat and PID creation/ancestry verified the descendants before timeout. Three descendants survived through 5.5 seconds; PID-scoped cleanup and fixture removal were confirmed.
- The experiment demonstrated the launcher-chain mechanism, not the original massive Git-status RAM leak or Pi SDK behavior.
- Existing `shellGitRunner` uses direct argv, sanitized environment, hidden Windows console, 5000ms execFile timeout and uncapped output. Killing the parent before tree cleanup loses the ancestor needed to terminate descendants.

## Workspace
- Path: `C:/Users/Blackie/orca/workspaces/main/fix-927-windows-process-cleanup`.
- Branch: `dnlrsls/fix-927-windows-process-cleanup`.
- Preserve unrelated changes in the original main checkout.

## Scope and non-goals
- Add bounded Windows subprocess lifetime handling at the shell Git execution boundary and wire the existing runner into it.
- Preserve GitRunner result semantics, environment sanitation, direct argv, large-output compatibility, hidden windows, and existing non-Windows behavior.
- Add deterministic regression coverage for timeout, ordered tree cleanup, success, spawn errors, cleanup failures, late events, and timer disposal where applicable.
- Do not change watcher cadence, scan policy, session evidence, UI, installer, unrelated subprocesses, dependencies, or generated runtime modules.
- No generic subprocess framework or additional watcher state machine.

## Task checklist
- [ ] T1: Implement and verify Windows Git process-tree timeout cleanup as one coherent work unit, keeping regression tests and explanation with the behavior.
  - Read the existing runner tests and relevant lifecycle APIs.
  - Observe RED for the missing tree cleanup before implementation.
  - Implement the minimum bounded cleanup; observe focused GREEN, then refactor with checks.
  - Independently verify applicable focused behavior and a bounded real Git-for-Windows chain if safely runnable.
  - Run native review under the user-owned switch; record all pending or unavailable checks.
  - Record the work-unit commit after explicit commit authorization. Publication remains a separate decision.

## Acceptance criteria
- On Windows, initiate descendant termination while the owned command parent is still available; never rely on execFile having already killed that parent.
- Tree termination is PID-scoped, console-hidden, uses a trusted system executable and is bounded even when cleanup itself fails.
- Successful completion never kills another process; clear timeout/cleanup timers and handle spawn/error/late-callback races without duplicate settlement.
- A timeout remains a failed command, including when an error reports numeric code zero.
- No broad image-name killing, new expensive scans, swallowed failures, environment injection, or indefinite waits.

## Verification
- Default test-first policy applies to this behavioral change. Use built-in Node TypeScript stripping for dependency-free helper tests.
- Candidate focused command: `node --experimental-strip-types --test tests/shell-git-process.test.ts`, with a bounded command timeout.
- Existing shell runner tests: inspect the exact applicable test-name pattern and prerequisites before execution; no install is authorized if dependencies are absent.
- Structural: authored `git diff --check`; `node scripts/build-runtime-modules.mjs --check` if applicable.
- Runtime: a tiny, bounded Windows Git launcher-chain fixture with pre-timeout heartbeat, strict self-expiry, PID-scoped cleanup and verified absence, never a user-home scan or RAM soak.
- Full suite: evaluate prerequisites and boundedness; report unavailable checks rather than launch unbounded stages.

## Progress
- Isolated Orca worktree created and registered at the exact base; setup hooks skipped.
- T1 in progress. Single bounded writer `murknr47-g-8yy9` settled `partial`; actual edits are `extensions/gentle-shell.ts`, `lib/shell-git-process.ts`, and `tests/shell-git-process.test.ts`. No commits or tracking-document edits by the writer.
- Allowed source surfaces remain those three paths plus `tests/gentle-shell.test.ts`.
- Writer-observed RED: 3 tests, 2 passed / 1 failed (Windows built-in timeout expected 0, observed 5). Initial GREEN: 3 passed. Final regression/refactor checks: 9 passed, 1501.7097ms; stuck cleanup settled in 1027.1925ms.
- Writer `git diff --check` and generated-runtime consistency passed (8 modules).
- Focused shell integration could not load: `ERR_MODULE_NOT_FOUND` for `@earendil-works/pi-coding-agent`; no dependencies installed. Full integration/type validation remain unavailable, not passed.
- Implementation owns the Windows deadline, invokes host-system PID-scoped taskkill before root fallback, and bounds cleanup to 1000ms. Non-Windows retains execFile timeout behavior. Failed cleanup cannot guarantee descendant removal.
- Parent ASSESS returned `unassessable` because untracked files require an explicit declaration; its plan requires independent verification. No native authority started.
- Independent verifier `murkvbuy-h-9g9x` reran the helper suite: 9/9 passed. Authored diff check is empty; generated runtime matches 8 modules. Independently confirmed `node_modules` is absent; shell integration was not launched.
- Verifier request `q2` completed the exact authorized mocked exit-before-close event probe. After `root.emit('exit', 0, null)`, the helper still invoked mocked `taskkill /PID 42 /T /F` and `root.kill`, then returned `{stdout: '', code: 1}`. Missing exit-event handling is a deterministic candidate defect; actual PID reuse was not reproduced.
- Real actual-helper Git runtime preparation and launch stopped before creating a fixture or driver. No real kills or runtime cycles occurred.
- Existing `tests/gentle-shell.test.ts:4586–4601` assertions have no timeout-value mismatch. Tracked diff is only the extension; intended untracked paths are helper, helper tests and task document.
- Verifier `murkvbuy-h-9g9x` settled `partial` with the deterministic blocker. Focused shell integration was skipped after checking absent dependencies, not executed by the verifier; the earlier module-load error belongs to the writer run only.
- Corrective writer `murl0bqg-i-cyc3` settled `partial`. Only helper and helper tests changed: exit-event tracking and shared exitCode/signalCode guards now protect both root-addressing boundaries; four regressions added. Timely callbacks preserve stdout/success; pending streams settle failed at the deadline.
- Correction RED: 9 passed / 1 failed (three calls after exit instead of Git alone), 1444.2659ms. Initial GREEN: 10/10, 1319.2737ms. Expanded/refactor checks: 13/13 including all original nine tests, 2536.8995ms.
- Corrective writer diff check and runtime consistency passed (8 modules). No extension/tracking changes, commits or delivery actions by the writer.
- Corrected-candidate ASSESS again returned `unassessable` for undeclared untracked files; its conservative plan still requires independent verification.
- Independent verifier continuation `murl4dsc-j-h8zh` observed 13/13 passed (2882.8606ms); the original exit-event mock now returns failed code 1 with only the Git invocation, no tree/root kill. Independent diff check is empty; runtime matches 8 modules; scope unchanged. No deterministic blocker found in this rerun.
- Verifier `murl4dsc-j-h8zh` settled `partial`: corrected local checks pass; actual runtime was not launched. Its earlier ENOENT probe observation predates parent file creation.
- Parent assembled the three literal ASCII driver chunks and applied the verifier's Git-init amendment stripping inherited GIT_* variables and disabling templates. Temporary artifact `C:/Users/Blackie/AppData/Local/Temp/gentle-927-fixed-20261002-probe.mjs`: 7898 bytes, SHA-256 `1fd4acee1c5a4549b7bda3b7f06a4a33b4582f1f383a7333f9c13b80ada545f9` (identity of the written artifact, not an independent author digest).
- Runtime verifier continuation `murljfax-k-l7c5` settled `partial`. Readback/hash (7898 bytes and recorded SHA) and syntax passed; the single authorized cycle ran once and exited 1. No retry.
- The driver assumed a direct Git -> shell edge. Shell PID 36040 actually reported parent 34600 rather than injected Git root 56836, so ancestry assertion failed before identities were cached. Node parent 44660 / child 47768 were token matched; child heartbeat arrived at 3.5 seconds.
- No actual taskkill invocation, completed predeadline sample, or asserted helper result exists. The observer rejected missing cached root identity; helper root fallback ran around five seconds, and descendants subsequently self-expired. This is a script-blocked verification, not a demonstrated candidate defect or tree-cleanup success.
- Initial sampled RSS was 285753344 bytes (272.52 MiB), including driver and monitor but omitting the unidentified intermediate process; complete-chain RSS bound was not proved.
- Final scoped checks found all observed PIDs absent: 34600, 56836, 36040, 44660, 47768, 21616, 34192, 65904, 64720. No manual backup kills. Fixture and probe removal reported; independent probe read returned ENOENT.
- Safety limit remains at most 8 concurrent owned processes and bounded self-expiry/cleanup. The first runtime-cycle authorization was consumed.
- User explicitly authorized exactly one additional bounded cycle, correcting only the temporary fixture for the intermediate launcher. Parent restored the unexecuted 7898-byte baseline to `C:/Users/Blackie/AppData/Local/Temp/gentle-927-fixed-v2-20261002-probe.mjs` for verifier-authored narrow ancestry changes; it must not launch until corrected and checked.
- Verifier continuation `murme0zj-l-su98` authored three exact temporary ancestry replacements; parent applied them: root identity cached early, `chainReady` guarding tree invocation, depth <=2 parent-PID traversal to the owned root, exact Git executable allowlist, creation identity validation and at most five fixture PIDs.
- Parent also applied the verifier's four temporary timing refinements: optional query timeout forwarded to CIM command; initial and complete-chain queries share the elapsed launch+3300ms budget. This avoids startup plus two independent 1800ms queries reaching the 5000ms helper deadline before early-abort validation. Actual helper 5000ms deadline / 1000ms cleanup timers remain untouched.
- Verifier confirmed no launch while the refinement was absent. After all seven exact temporary replacements succeeded, parent reconfirmed readback/hash/syntax followed by the one reserved additional cycle (75s command limit). Final v2 artifact: 9332 bytes, SHA-256 `7e79cec2ccafecd352c9556f6468adc9d72e04b0bff8df2e0f85017a7234181b`; readback/syntax passed.
- The reserved v2 cycle ran once with exit 0. Validated creation/ancestry: Git 25020 -> `usr/bin/sh` 27208 -> `usr/bin/sh` 62064 -> Node 50280 -> Node 25680. Child heartbeat at 3.5 seconds. Sampled known-chain + driver + monitor RSS: 276738048 bytes.
- Actual trusted taskkill started at 5013ms with the Git root alive and exitCode/signalCode null, before Git exit around 5262ms. taskkill code 0; actual helper returned failed code 1 at 5266ms with 272 stdout bytes, as required for timeout.
- Five tracked fixture PIDs were absent in the post-helper query before any manual backup; manualBackup false. Final tracked absence and probe/fixture removal reported.
- Limitation: taskkill also reported terminating PID 29952, a root child absent from the pre-CIM sample. Its executable, creation identity and RSS were not captured, so exhaustive tree RSS and total concurrent-process bounds were not proved.
- Final verifier `murme0zj-l-su98` settled: focused runtime passed; overall verification partial because Pi integration is unavailable and complete-tree resource accounting is incomplete. Additional bounded PID-only CIM returned an empty array for all 13 observed fixture/driver/monitor PIDs, including 29952. Probe removal independently confirmed by ENOENT; no backup kills, extra cycle or production edits.
- Independent 13/13 helper tests and corrected exit-event mock remain passed. Actual timeout/tree-cleanup behavior is functionally verified for the controlled Git launcher chain, not the original massive RAM-leak workload. T1 remains in progress pending native review and an explicitly authorized work-unit commit.
- Synchronous CIM/file IPC inside the helper's 1000ms cleanup window is not authorized because observer latency changes the behavior under test. Establish identity/ancestry earlier and observe immediate live/root exit state at tree-kill invocation without blocking; perform post-settlement identity checks asynchronously before backup kills. T1 remains open.
- Scoped independent verification completed with the limitations above. Native review `review-cad676ff5f8606ca` approved the frozen four-path, 344-line candidate at high risk through risk/resilience/readability/reliability lenses; exact acknowledgement returned `authority: burned` and evidence `gentle-ai.review-acknowledged/v1`. No post-burn STATUS.
- Non-blocking native advisory `R3-timeout-stream-disposal` at `lib/shell-git-process.ts:29–35` remains separate later work. Provider explicitly says approval stands and no correction/reopen transition is offered; no source edits were made for it.
- This passive post-review closeout updates only the task record; production and tests remain the reviewed candidate. User explicitly authorized commit and PR creation without merge. Fresh main is still the exact base; original parent dirt is preserved. Commit, publication and PR are not yet performed because the issue-first approval label decision remains pending. Pi integration/full suite remain unavailable, not passed.

## Next step
Ask whether to mark issue #927 status:approved and remove status:needs-review, as required by the loaded PR guide. Do not automatically change public issue triage. Once approved, locate the actual PR template (uppercase template path is absent), confirm fork publication authority and use a compliant fix/* publication branch, then commit and open the authorized PR with exactly one type:bug label and honest verification notes. No merge or workflow approval. T1 remains open until the work-unit commit is recorded.
