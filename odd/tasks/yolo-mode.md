# Guarded YOLO Mode

## Objective
Provide a human-activated `/yolo on|off|status` command and a YOLO toggle beside Vim in the configuration/look-and-feel menu that remove routine development and delivery permission questions within the authorized task, while retaining destructive-operation safeguards.

## Problem and why
Repeated commit/push/PR confirmations interrupt ordinary work. Existing shell safeguards do not recognize database DROP/TRUNCATE, so preserving them alone does not meet the requested safety boundary.

## Authorized scope and constraints
- Isolated worktree: /Users/alanbuscaglia/work/gentle-pi-worktrees/yolo-mode
- Branch: feat/yolo-mode; starting revision: 290c0dc1352d65ed134bcf07187e81be955645a7.
- Session-only, default off; explicit command activation, reversible, clone/session bound. No persisted global autonomy switch.
- Ordinary commits, non-force pushes and PR preparation may proceed without repeated permission only inside the established task/repository/destination.
- Preserve explicit user restrictions, genuine unresolved product decisions, destination/credential ambiguity, privacy protection, explicit configured blocks, sensitive paths, destructive Git and recognized data-loss guards.
- Never auto-answer provider consent, maintenance/recovery authorization or opaque-token questions. Do not change RDD.
- Parent retains delivery authority; children receive bounded work scope and fail-closed destructive guards, never independent YOLO activation.
- Shell detection is defense-in-depth, not a sandbox or an all-tools safety guarantee.
- No remote publication, PR creation, release, merge, dependency/config changes or edits to unrelated worktrees are authorized for this feature.

## Tasks
- [x] T1 — Add shared recognized data-loss guards to primary and delegated execution.
  - Status: done.
  - Route: delegated direct; preparation/mapping and multi-file writer triggers.
  - Outcome: recognized destructive SQL and broad data deletion require fresh primary confirmation and block headless children; preserve existing hard-deny/config precedence.
  - Acceptance: ordinary commands remain unchanged; mixed commands cannot hide recognized destructive operations; cancellation/no UI fail closed; child extension loading is tested.
  - Risk: high (permission/data-loss boundary).
  - Checks: observed test-first RED/GREEN; focused guard/agent regressions; check-only runtime module validation; typecheck ratchet; independent/native verification according to assessment.
  - Commit: 4e83989998d836b4e490445eb78ed32bbf527567; 519 authored diff lines including 69 ODD tracking lines (450 behavior/tests/docs).
- [ ] T2 — Implement and document session-scoped YOLO command, policy and visible state.
  - Status: done.
  - Route: delegated direct; multi-file writer and preparation triggers.
  - Outcome: on/off/status/toggle, lifecycle isolation/reset, active-only structured prompt, narrowly authorized routine push, status/widget and palette entry.
  - Acceptance: default/off unchanged; no activation from child or arbitrary tool arguments; no unrelated clone leakage; off/reset remove instruction/UI; destructive/config/provider boundaries remain.
  - Risk: high (authorization boundary).
  - Checks: observed RED/GREEN; command/policy/lifecycle/prompt/visibility tests; applicable focused/full/package checks; parent structural spot check; safe runtime smoke when available.
  - Commit: abe7d3e3a2f071b3d231b35823cd17fd9227345d; 625 authored lines including45 tracking lines (580 behavior/tests/docs).

- [x] T3 — Add the same session YOLO control to the configuration/look-and-feel menu beside Vim.
  - Status: done.
  - Route: delegated direct; new menu mapping and multi-file writer triggers.
  - Outcome: /gentle:customize → Editor has a visible YOLO ON/OFF · session only row immediately after Vim controls, synchronized with slash command and using the same primary/session/clone eligibility and revocation path.
  - Constraints: no persistent global/repository YOLO preference, independent grant, model-visible activation or weakened destructive/provider protections.
  - Risk: medium from native ASSESS over T3 diff; large writer self-verification stands, no independent verifier required by returned plan.
  - Checks: observed RED/GREEN, menu render/toggle/synchronization and unchanged guard/runtime tests, proportionate full/package checks and native review.
  - Commit: 62a332baf9c62f8f791339f4dcc79ad635fcc928; 624 authored lines including 22 tracking lines.

## Delivery and review workload
- Strategy: single-pr; user explicitly authorized size:exception (overrides the earlier chain selection).
- Forecast updated: T1 519 authored diff lines (including tracking); T2 557 behavior/tests/docs lines plus tracking updates. T3 menu integration additionally forecast approximately 250 lines. Explicit single-PR size:exception applies to all units; generated runtime unchanged.
- Running count: 1768 authored changed lines across T1 4e8398999 (519), T2 abe7d3e3a (625) and T3 62a332baf (624), including ODD tracking; generated runtime unchanged. Single PR with size:exception.
- One future PR contains both T1 safeguards and T2 YOLO mode, with size:exception. Local work-unit commits remain separate. No remote action is authorized by this choice.
- Native review is enabled by global policy; each candidate is its own work-unit slice, not the accumulated branch. T1 lineage: review-27caafa134c98a95 (high; four provider-selected lenses).
- No meaningful test-first exception is currently known; deterministic unit/runtime tests are applicable.

## Evidence and progress
- Read-only explorer mapped existing guards, structured prompt hook, session permission identity, child extensions and commands.
- Confirmed safety gap: database DROP/TRUNCATE are not in existing classification.
- Pi SDK docs and related examples read by explorer; source spot check confirms confirmCommand evaluates policy before fresh UI approval.
- Linked worktree initially clean. Two untracked ODD documents in the original tree remain untouched.
- Existing main dependencies may be shared via a local ignored node_modules symlink; no install or network required.

- T1 writer paused before edits because the parent supplied incorrect generated destinations for an unnecessary normalization command. Parent inspected scripts/build-runtime-modules.mjs: all eight inputs are outside T1 and remain unchanged; remove build:runtime-modules from required commands, retaining check:runtime-modules. No extra edit surfaces or product authorization are needed.

- T1 source/tests/docs implemented: 378 authored changed lines. Observed RED, then focused GREEN (255/255). Package resource validation passed (155 resources).
- Remaining primary regression run failed five fixtures under inherited GENTLE_PI_AGENTS_CHILD=1; this is not yet claimed resolved. pnpm tried implicit package-manager/dependency installation and aborted; no installation is authorized. Parent confirmed shared dependencies and worktree symlink remain intact.
- Corrected verification uses env GENTLE_PI_AGENTS_CHILD=0 for primary-session regression fixtures and direct node scripts for runtime/typechecking (no install).
- Native ASSESS could not classify untracked scope; it returned unassessable/high-equivalent and requires independent verification. No review authority has been started.

- Independent T1 commands passed (424 tests, runtime/typecheck/package checks, diff whitespace), but source tracing found wrapper option arity, quoted WHERE and separator-provenance bugs; T1 remains incomplete.
- Native four-lens review corroborated four severe deterministic findings: R1-quoted-separator-bypass; R3-double-quoted-shell-payload; R3-quoted-where-identifier; R3-separator-provenance. One correction plan captured with 189 diff lines maximum; transaction awaits corrected candidate. No authority acknowledged and no commit made.

- Bounded correction completed: 86 additions + 14 deletions = 100 diff lines against frozen candidate (limit 189). Regression RED observed (17 intended failures), final GREEN 446/446, runtime/typecheck/package/whitespace checks passed.
- Native targeted validator approved corrected T1. Exact acknowledgement succeeded: authority burned for target sha256:a75df5c21980f655dbefc3ffb0f694e69ad53cd8ed94aa49b642748a1c65b48d, consumed revision sha256:b0c03b1b717fad52bf64963bd3a3818e47ae7fad8cac6ad39d048014ad298810. No further lifecycle call for this candidate.
- Native informational findings R2-token-provenance and R2-wrapper-arity did not block or reopen review; corrected related source remains documented.
- Independent post-correction verifier muocp6wg-7-jwsu passed all required checks: 446 tests, runtime sources, typecheck ratchet, package resources and diff whitespace; no residual blockers in the specified defect classes.

- T2 writer completed the session policy/command/palette/prompt/widget and docs with observed RED (six intended missing-implementation failures), then GREEN341/341. Runtime/typecheck/package/whitespace checks passed; no generated bytes or installs changed.
- Actual SDK loader/command runner/SessionManager coverage ran with stubbed UI and dispatched lifecycle events, not a full interactive/manual TUI smoke.
- Reload explicitly resets YOLO (safer default), as do session replacement/quit/restart; documented accordingly. Review standing permission remains separate.
- Full suite and native T2 review pending. Standard installed packed-runner E2E needs dependency/native installation and is not authorized under current no-install boundary; substitute a clearly labeled offline tarball-content check, not an invented installed-consumer pass.

- T2 native reliability review approved; exact acknowledgement burned lineage review-463450a28c7a3c8f for target sha256:8fd535c4252f1b0a566be84e4787fe09f205b2741af290e4bfb9619281ad8ae7, consumed revision sha256:def39e6cf57e1adf6ad69d648646c0948fcc7b9e9ba2f462cfb9a916c707f652. Non-blocking R3-ambient-guard-tests and R3-newline-waiver remain advisory, not a correction route.
- Final verifier ran dedicated tests14/14 plus runtime/typecheck/resources and offline tarball inclusion check successfully. Full suite did NOT run: official wrapper includes pnpm commands. Parent inspected exported runTestSuite override API and authorizes equivalent direct-node stages; no install/source change required. T2 remains in progress until this proof.
- User explicitly added YOLO to the same configuration/look-and-feel menu as Vim; accepted as T3 without discarding valid T1/T2 work. Same session policy is retained.

- T3 map complete: /gentle:customize Editor rows in extensions/gentle-shell.ts; existing CustomizeRow supports dynamic synchronous labels, preview and async action. Reuse existing VisualCustomizeView, do not change persistent Vim/visual/profile writers.
- Same controller needs host-only callback discovery over pi.events, a shared human-action operation, display-only snapshot/observer refresh and late/reload/absent-owner fail-closed behavior. No synthetic user message or model-facing enable flag.
- Derived T3 surfaces: lib/yolo-session-policy.ts, extensions/gentle-shell.ts, tests/yolo-customize.test.ts, tests/yolo-session-policy.test.ts, tests/yolo-mode.test.ts, tests/yolo-mode-runtime.test.ts, tests/gentle-shell.test.ts, README.md, docs/yolo-mode.md. Existing visual view is read-only reuse.

- Equivalent full suite ran once: unit tests4371 (4326 passed,1 failed,44 skipped), provider contractPASS, runtime harnessFAIL. Candidate-linked failures: tests/review-controller-native-routing.test.ts lifecycle handler count expected1 observed2; runtime-harness legacy model routing invoked first session_start handler, now YOLO reset instead of existing startup logic. No baseline comparison claimed.
- T2 remains incomplete. One scoped functional correction will preserve existing single-hook lifecycle by exposing controller reset and calling it from the primary extension's existing startup/shutdown hooks, rather than weakening native tests or changing the harness.

- T2 scoped lifecycle correction completed (35 additions+12 deletions): controller exposes reset; primary's existing startup/shutdown hooks call it first; no extra hooks or harness weakening. Targeted RED reproduced handler-count/legacy-routing failures, GREEN102/102 plus runtime harnessPASS.
- Corrected full suitePASS:4327 passed,0 failed,44 platform/native-binary-gated skips; provider contract and runtime harnessPASS. Runtime modules/typecheck ratchet187 diagnostics/package resources/whitespace alsoPASS. No baseline adjustment/generated writes/install.
- Changed source is a fresh T2 review candidate; prior approved acknowledgement is not reused. Installed-consumer E2E and full interactive TUI remain skipped; offline archive inclusion already passed.

- Corrected T2 native review approved and exact acknowledgement burned review-81c713cb93df50c5 for target sha256:d2ee6a7b18da5c8800aa2404b529883a268e20e96b31bd2b6906881ef027a22a; consumed revision sha256:a8e1403f9c6d9e71771b8c7a26b99418cc0665529ef589a57ebeb86edb51f7d2. Commit tree exactly matched frozen tree0cb949a16bd36c6af98979036ce0bfd82c7af73b.

- T3 implemented (561 authored lines): same human action/controller, bounded host callback discovery, session/generation UI adapters, transition-only observers, Editor row, slash/menu sync, close/replacement disposal and docs. Parent spot-read confirmed original policy/guard independence and no persistent settings.
- Observed RED367pass/7intendedfail after initial test-import issue; focused GREEN381/381. Full suite4338pass/3fail/44baseline platform-native skips; provider contract and runtime harnessPASS. Failures: two questionnaire privacy fixtures expected3 subscriptions, now4 due private host-discovery subscription; owner-first UI test waited for label update, not async action completion, before Space.
- One scoped T3 test correction authorized: tests/gentle-ai.test.ts explicitly accounts for known private discovery channel without relaxing original privacy/balanced Herdr checks; tests/yolo-customize.test.ts uses a real completion barrier. Parent derives these surfaces within already-authorized feature; no new product scope or production-authority changes.

- T3 bounded test correction completed:46 additions+7 deletions=53 diff lines; totalT3602 authored lines excluding parent tracking. Exact subscription allowlist preserves original private/balanced Herdr assertions and adds no-leakage checks; both load orders wait for component readiness without mutating production.
- Final focused471/471 and complete suite4341passed/0failed/44unchanged platform-native skips; provider contract/runtime harnessPASS. Runtime modules/typecheck ratchet187 diagnostics/resources/whitespacePASS; no source baseline or generated-byte changes.
- SDK tests load both extensions in both orders on real event bus and drive real Theme/component rendering with stubbed terminal transport. Full interactive TUI and installed-consumer E2E remain explicitly unperformed; fixture reads an existing private busy latch and may need maintenance if component internals change.

- T3 native reliability review approved; exact acknowledgement burned review-dd98d133087d4073 for target sha256:d1a717a9c7e4660ef674d498257b089a327cbab3ce35560a56a8b2f145f4752a (revision sha256:544f52d2ed7b87f5b4ca8e1703b1360b7d0ad3379e1632d2ca267ed658e2caf2). Advisory, non-blocking: R3-001 (extensions/gentle-shell.ts refresh path) and R3-002 (runtime test timing).
- Parent spot check after commit: YOLO/guard focused tests 92/92 and offline archive inclusion check passed.
- Not performed: installed-consumer packed E2E (requires dependency/native installation) and manual interactive terminal smoke.
- Open advisory follow-ups: R3-newline-waiver, R3-ambient-guard-tests, R3-001, R3-002, R2-token-provenance, R2-wrapper-arity.

## Next step
All tasks done locally on feat/yolo-mode. Push and single PR (size:exception) remain the user's decision; nothing published.
