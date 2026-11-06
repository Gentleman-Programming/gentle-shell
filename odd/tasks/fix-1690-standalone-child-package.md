# Fix #1690: standalone subagents load the gentle-pi package

## Objective

In isolated standalone Gentle Shell, delegated children (`pi --mode rpc`) must load the same gentle-pi package as the parent. Acceptance target: an isolated child behaves like a regular gentle-pi child, where `settings.json` declares the package.

## Problem

In isolated mode the launcher injects the package into the parent only through `pi -e <packageRoot>` (`lib/gentle-shell-launcher.ts` `buildPiInvocation`, ~:918-947), and setup removes `npm:gentle-pi` from the isolated home `settings.json`. The runner never forwards that injection. `childArguments` (`lib/agents-runner.ts:258`) adds `--extension` only for `request.extensionPaths`, which holds just `child-context.ts` and `child-safety.ts` (`extensions/gentle-agents.ts:114`, `:148`, `:1304`). Children lose the guardrails gate, `subagent_parent_message`, session-change capture (#1688), codegraph, `gentle_review_scope`, the review permission relay, and package skills/prompts. Pi drops unknown `--tools` names silently.

## Decided direction

barbatdev on #1690 (2026-10-03 04:19Z):

1. Forward the parent's package to children when the parent received it through `-e`, not through `settings.json`.
2. Move the orchestrator-only filtering that `child-context.ts` does today into the fully loaded package. The curated child-entrypoint list goes away. (Superseded in T5: with the injection signal, children load the whole package; without it, the curated list stays as a frozen fallback, now child-context, child-safety and nan-provider.)
3. The runner warns when a tool requested in `--tools` does not exist in the child.

## Design constraints (verified on origin/main ac671593, Pi 1.0.0)

- No grandchildren: `agentsEnabled()` returns false when `GENTLE_PI_AGENTS_CHILD=1` (`extensions/gentle-agents.ts:152`).
- Prerequisite: `gentle-ai.ts` `session_start` (~:9673) has no child guard. It runs `installPackageAssets`, `migrateLegacyProjectModelOverrides` and `applySavedModelConfig` (~:9715-9717). Forwarding the package without a guard would make every child rewrite shared files. Regular gentle-pi children probably hit this today already.
- The launcher must signal the injection explicitly (env), not leave the child to infer it from argv or `import.meta.url`.
- Launcher cases: no declaration → forward `packageRoot`. Takeover (`--no-extensions` + other `-e` set) → forward the full set or define a scope. A declaration already in settings → forward nothing, or the package registers twice.
- Once the package is forwarded, drop `child-context.ts`/`child-safety.ts` from the child args, or make them idempotent.
- Pi 1.0 RPC has no tool listing (no `get_tools`). The missing-tool warning needs either a child-side self-check reported over the child IPC, or a parent-side check. Verify before choosing.
- Windows: pass paths as plain argv elements, absolute, with no shell quoting.
- Overlaps: #593 / PR #605 (child extension selection), #1688 (child capture; GuidoCarda has a local fix).

## Constraints

- Technical artifacts in English. Test-first wherever there is a deterministic runnable test.
- No PR until barbatdev answers whether to wait for `status:approved` (the issue has `status:needs-review,type:bug`).
- Out of scope: #1647, #1064/#1557/#1558.

## Tasks

- [x] T1 Hook audit: classify every gentle-pi package hook that would newly run in a child (session_start, before_agent_start, tool_call, timers, UI, registrations) as must-run, must-skip or harmless. Record the table in this document. Route: delegated read-only (`gentle-ai-explore`, task mus95p0g-1-r2m0); the parent spot-checked `hasUI` in the Pi rpc loader. See "Child hook audit". Commit `5848fb80`.
- [x] T2 Child guards for the must-skip items in "Child hook audit" (gentle-ai session_start writes, skill-registry, history, pi-pretty fallback, optional startup-banner), with tests. Route: delegated writer (musez9uu-2-2u6i), verified by `gentle-ai-verify` (musfh6tb-3-entu). The child also skips the review-permission revoke/refresh: the grant is host-only (`lib/review-session-standing-permission.ts:162`) and the child relay is created at load. Commit: see Evidence.
- [x] T2b Review follow-ups from the T2 RDD review (non-blocking): (a) WARNING `tests/gentle-ai-child-guards.test.ts:83-93`: the "keeps local resets" test does not assert that the child-local resets still run; add a real assertion. (b) SUGGESTION `extensions/gentle-ai.ts:9681-9686`: the early return skips any session state initialized further down; wrap only the parent steps in the guard, or assert the child state explicitly. Route: delegated writer (musgdawc-4-k2ug). Done: (a) the tests now prove that the child elapsed-timing ledger and the reminder re-arm run (RED 2/6 with the guard moved above the resets; GREEN 6/6); (b) the parent-only work moved into `startParentSession`, which children never call. `tests/gentle-ai.test.ts` 102/102; typecheck shows no regressions. Known gaps: `yolo.reset`/`reviewSidebar.reset` have no direct assertion, and the `reminderManager` reset is proven only in the green direction. Commit: the T2b commit carrying this line.
- [x] T3 Launcher injection signal: `buildPiInvocation` exports the injected extension set (and the takeover flag) to the parent env for the three cases, with tests. Route: delegated writer (musgrl7b-5-7p0z, continued as musgx2ah-6-dep2). One env var, `GENTLE_SHELL_CHILD_PACKAGE_INJECTION` = JSON `{version:1, noExtensions, extensionPaths}`, defined once in `lib/child-package-injection.ts` (encoder, a parser that never throws and requires absolute paths, and the child argv helper). Takeover sets the exact deduped `-e` set with `noExtensions: true`; no declaration sets `[packageRoot]`; declaration and pi subcommand delete any inherited value. Passthrough `-e` (herdr, user-typed) is deliberately excluded. `bin/gentle-shell.mjs` imports the generated `runtime/gentle-shell-launcher.mjs`, so the module was registered in `scripts/build-runtime-modules.mjs` and `scripts/verify-package-files.mjs`, and the runtime was regenerated. Evidence: launcher 213/213, module 6/6, bin 129/129 (the new bin test went RED with the assignment disabled), package-manifest 56/56; `build-runtime-modules --check` and `verify-package-files` pass; check-types shows no regressions. Commit: the T3 commit carrying this line.
- [x] T4 Runner forwarding: gentle-agents builds the child extension args from that signal (takeover set with `--no-extensions`; with no signal, e.g. a declared package, the curated fallback of three entries including `nan-provider.ts`) and drops the curated entries when the package is forwarded, with tests. Route: delegated writer (mush6xaa-7-zm8u). `childExtensionRequest(deps.env, curated)` in `extensions/gentle-agents.ts` uses a valid injection, or falls back to the curated entries; `TaskRequest.noExtensions`; `childArguments` builds the args through `childPackageExtensionArgs`. Provenance: the "host provenance" comment is a leftover from a check removed in `cc5fbd94`; both values come only from the host env or deps by construction (reword in T5). Evidence: RED 2/3 (missing `--no-extensions`; curated paths in the takeover case), GREEN; agents/child/gentle-agents suites 497/497; check-types shows no regressions; runtime `--check` is clean. Commit: the T4 commit carrying this line.
- [x] T5 Move the `child-context.ts`/`child-safety.ts` behavior into the loaded package, gated on `GENTLE_PI_AGENTS_CHILD`, with no double registration, with tests. Route: inline (comment-only). Finding: both files are already package entrypoints gated on `GENTLE_PI_AGENTS_CHILD` (T1), so with the signal (T4) the filtering already runs inside the fully loaded package, as barbatdev asked. Decision (user, 2026-10-03): keep the two curated entries as a **frozen** fallback for a parent without the signal (a manual `pi -e <package>`); new child-facing behavior ships only in the package. No double registration: Pi dedupes by realpath (`resource-loader.js:781-792`), which covers the declared case. Only the comments changed (`extensions/gentle-agents.ts` fallback comment, the stale provenance comment in `lib/agents-runner.ts`); no tests run because there is no behavior change. Commit: the T5 commit carrying this line.
- [x] T6 Missing `--tools` warning: choose between a child self-check over IPC and a parent-side check (verify first), implement, test. Route: read-only design exploration (mushqp8h-8-nntz), user-approved design, delegated writer (musi137n-9-yscv). Pi 1.0 drops unknown `--tools` names silently (`agent-session.js:1080,1121-1125`) and RPC has no tool listing, so the check runs in the child:
  - the runner exports `GENTLE_PI_AGENTS_REQUESTED_TOOLS`, byte-identical to `--tools` (shared `requestedTools`; a stale inherited value is removed);
  - the gentle-agents child branch compares it with `pi.getAllTools()` at the first `before_agent_start` (moved there by T6b; it ran at session_start in the first version), skips `mcp__*` (async registration) and non-name entries such as `"*": false`, and sends one marked `notify` (`MISSING_TOOLS_NOTE_PREFIX`);
  - `agents-protocol` turns only that marked notify into a task NOTE (transcript); every other notify stays dropped.
  
  IPC was rejected (it would reach the parent model as a message), and so was a parent-side static check (fragile). The T4 review suggestion (`noExtensions` with empty paths) is pinned by a test. Evidence: RED 8 (plus a real RED for the early NOTE with the mapping disabled), GREEN; agents/child/gentle-agents suites 504/504; check-types shows no regressions; runtime `--check` is clean. Known limits: no check in curated-fallback mode (gentle-agents is not loaded in the child); one check per child process; an early NOTE sets `sawRunEvent`, which only drops the "no first run event" suffix from a stall-timeout message (`agents-runner.ts:623`), the same as existing extension_error NOTEs. Commit: the T6 commit carrying this line.
- T7 live probe (verifier musixf7x-a-nqas, Pi 1.0.0 `dist/bundle/cli.js`, children spawned like the runner with temp homes, only `get_commands` sent, no model call):

  | Scenario | /gentle:* | Duplicate names | Missing-tools notify | child-context / child-safety loaded | Median startup |
  |---|---|---|---|---|---|
  | A curated fallback, no packages | 0 | none | none (gentle-agents not loaded) | 1 / 1 | 279 ms |
  | B `--extension <package root>` (#1690, no declaration) | 18 | none | yes | 1 / 1 | 548 ms |
  | C′ takeover shape (`--no-extensions`, dummy package with an extension, package root) | 18 | none | yes | 1 / 1 | 481 ms |
  | D gentle-pi declared + curated `--extension` (regular gentle-pi baseline) | 18 | none | yes | 1 / 1 (deduped under the package) | 516 ms |

  - Target met: B == C′ == D == 18 and A == 0, with no duplicate command names.
  - Notify text: `gentle-agents: requested tools missing in child: subagent_parent_message, definitely_missing_tool`. `codegraph` is present; `subagent_parent_message` shows only because the probe had no owned IPC.
  - child-context/child-safety loading was confirmed through Pi's `DefaultResourceLoader` (each exactly once). The probe's own delegated shell also had an `rm -rf` blocked by child-safety.
  - No gentle-pi shared-state writes: Pi core creates `{}` `auth.json`/`models-store.json` in every home, scenario A included; git status was unchanged.
  - Cost: about +270 ms startup over the curated fallback, on par with regular gentle-pi.
  - Takeover with an extension-less package (only `package.json`) crashes the child at startup ("Failed to load extension"). The launcher's `otherPackageInjections` does not filter such packages either, so a takeover parent would hit the same failure first; the child only mirrors a set the parent already started with. Tracked as a pre-existing follow-up.
- T6 RDD review (native Claude Code session): `approved`, medium risk, one lens, candidate `41177ae4` against base `b54a2897` on `review/1690-t6`, no correction; authority burned (lineage `review-bc3c0b01e4e11e1f`). WARNING: the session_start check can falsely report a tool that a later-loaded extension registers in its own session_start. SUGGESTION: prove that a fully satisfied `--tools` gives no note in a real child.
- T6 follow-up probe (verifier musjdncb-c-r14g, live Pi 1.0.0 children): a satisfied list (`read,grep,find,ls,codegraph`, plus the built-in `bash`) gives no note; the control (`zz_missing`) is reported; a tool registered in a later extension's session_start was reported falsely when the package loaded first (3a) and not in the reverse order (3b). Pi does register and activate such a tool (loader.js:231-240 → `_refreshToolRegistry`); session_start handlers run in load order (runner.js:807-830).
- [x] T6b (PR3, commit `7629bd4d` on `fix/1690-child-package-forwarding`, writer musjhj67-d-ba2b in worktree `fix-1690-pr3`): the comparison and its once-guard moved to the first `before_agent_start`, which fires after every session_start; the handler returns undefined. RED: the late-registration test reported `late_tool` on the old code; GREEN; agents/child/gentle-agents 505/505; check-types shows no regressions. PR4 was rebased onto it cleanly (T7 tests/docs is now `cb956596`); the docs bullet now says the check happens when the first prompt starts. Not re-run live: probe case 3a with the new code.
- T7 RDD review (native Claude Code session): `approved`, medium risk, one lens, candidate `3eeb92cd` (cb956596 + 3eeb92cd) against base `7629bd4d` on `fix/1690-child-package-acceptance`, no correction; authority burned (lineage `review-bc3533bc74a5409d`). WARNING: test (b) mirrors Pi's discovery rules by hand rather than calling the real resolver, so it detects repo-side changes only. The end-to-end proof is the live probe above (DefaultResourceLoader, each file once). SUGGESTIONS: name the helper self-checks as such, not as product coverage; one doc line on the pre-existing takeover crash with an extension-less package.
- T7 tests and docs (writer musjb8nt-b-6bso): `tests/child-package-entrypoints.test.ts` pins (a) the frozen fallback `childContextExtensionPaths()` = exactly [child-context, child-safety], a T5 review suggestion, and (b) package entrypoint discovery: `pi.extensions` ["./extensions"], no index/package.json/ignore files in `extensions/`, and both child files top-level (the T4 review warning). These are characterization tests, proven to bite by temporarily adding a fake entry and a fake index.ts (0/2), then restored. `docs/gentle-shell.md` § Gentle Agents documents forwarding, the child skips, confirm-as-question, the missing-tools note and the frozen fallback; the parent corrected the confirm bullet for background children. Results: 178/178; verify-package-files, check-types and package-manifest 56/56 pass. Commit: the T7 tests/docs commit carrying this line.
- T6b live re-run (verifier muskw8r1-e-uyqt): a real child with a fake offline provider (`http://127.0.0.1:9/v1`, no real credentials; Pi checks model/auth before `before_agent_start`) received one prompt. Case 3a (package first, `late_tool` registered in a later session_start) produced no note. The control (`zz_missing`) was reported 6 ms after the prompt, before `agent_start`. No note appeared before the prompt, and the real homes were unchanged.
- [x] T7 Acceptance probe: spawn like the runner (`--mode rpc --session-dir <tmp>`, `GENTLE_PI_AGENTS_CHILD=1`, isolated home) and compare RPC `get_commands` with a regular gentle-pi child (baseline 18 `/gentle:*` vs 0); measure startup cost; update docs. Route: `gentle-ai-verify`.

## Child hook audit (T1)

Audited statically on ac671593 against Pi 1.0.0 `@earendil-works/pi-coding-agent/dist`.

**Loader facts**

- `pi.extensions: ["./extensions"]` has no `index.ts`. Pi loads every top-level `extensions/*.ts` file plus `extensions/history/index.ts`, 18 entrypoints in total (`package-manager.js:377-456`). `child-context.ts` and `child-safety.ts` are therefore already package entrypoints.
- Pi dedupes extension paths by canonical path, CLI paths first (`package-manager.js:2058-2062`, `resource-loader.js:316-318,656-668`). Forwarding `-e <packageRoot>` together with `--extension child-*.ts` loads each file once.
- In an rpc child, `ctx.hasUI` is **true**: `rpc-mode.js:231` binds an RPC UI context and `runner.js:363` defines `hasUI`. Every `hasUI` guard takes the UI branch in children. Select/confirm/input/editor calls become a task ASK to the parent (`agents-protocol.ts:154,332-333`). notify/setStatus/setWidget calls are dropped.

**Must-skip in children (new `GENTLE_PI_AGENTS_CHILD` guard)**

1. `gentle-ai.ts:9715-9717` session_start: `installPackageAssets(force)`, `migrateLegacyProjectModelOverrides`, `applySavedModelConfig`. All three write shared state.
2. `skill-registry.ts:631` session_start: writes `.atl/` into the child cwd, renames the legacy registry, and starts a recursive fs watcher (gated on `hasUI`, which is true).
3. `history/index.ts:1361-1399`: writer init, `before_agent_start` prompt capture (would record delegation prompts as user history), GC.
4. `pi-pretty.ts:42`: the `!shellEnabled` fallback loads upstream pi-pretty with FFF indexing per child.
5. Optional hardening: `startup-banner.ts:647` is skipped today only because a piped stdout has no rows/cols.

**Uncertain, decide in T2**

- `gentle-ai.ts:9683-9696,9744-9747` session_start repository-preparation binding and review-status negotiation (spawns the native CLI per child); `tool_result` `recordReviewMutation`/`prepareBoundSessionRepository` (`:9854-9866`).
- Guardrails `confirmCommand` (`gentle-ai.ts:1822-1828`): its headless block is skipped because `hasUI` is true, so commands classed "confirm" in a child would ASK the parent user and the task would wait. Today they run unprompted. **Decided by the user (2026-10-03): the child asks the parent for confirmation.** Keep the ASK path, no child bypass; cover it with a test.
- Parent decision for T2: the repository-preparation binding, startup review negotiation and `prepareBoundSessionRepository` belong to the parent session (the child already runs in the parent's resolved worktree), so skip them in children. Keep the child-local resets and `recordReviewMutation` (child session only). The writer verifies whether review-permission revoke/refresh must stay for the child relay.

**Must-run (gained by forwarding)**

The gentle-ai `tool_call` guardrails, review relay handshake and review tools; gentle-shell session-change capture (runs before the shell guard); gentle-agents child `subagent_parent_message`; codegraph; nan-provider; child-context and child-safety.

**Already harmless in children**

gentle-shell UI/timers, the gentle-agents host, gentle-todo, runtime-metrics, gentle-stats, resume-hint, ask-user-*, quiet-tools, and the gentle-ai `before_agent_start`/`agent_end` (child-guarded).

## Working layout

- T1-T2 live on `fix/1690-standalone-child-package` (worktree `gentle-shell-worktrees/fix-1690-standalone-child-package`). Its RDD review of `a67bb7f5` runs from a separate native Claude Code session, and nothing else writes in that worktree while the review is open.
- T3 onward continue on `fix/1690-child-package-forwarding` (worktree `gentle-shell-worktrees/fix-1690-child-package-forwarding`), stacked on `a67bb7f5`. If the review adds a correction commit, rebase this branch onto it before delivery.

## Polish round (2026-10-03)

- P1 `d2ca0c46` (PR1): awaited `tool_execution_start` handlers; a child test proving `yolo.reset`/`reviewSidebar.reset` (it bites when either call is removed or the guard moves above them). 109/109.
- P2 `c3de137b` (PR2): `buildPiInvocation` takes an explicit `cwd` (bin passes `process.cwd()`); the signal is deduped after absolutizing; the `-e` argv is unchanged; runtime regenerated. 405/405.
- P4 `4a9b4d69` (PR4): helper self-checks split from the product tests; test (b) notes that it mirrors Pi's rules by hand; a docs bullet on the pre-existing takeover crash.
- The chain was rebased cleanly: PR1 `d2ca0c46`, PR2 `c3de137b` (T3 = `45fcc37d`), PR3 `8efa46c7` (T4 `c7c03449`, T5 `0e6521b3`, T6 `fd405cb1`, T6b `8efa46c7`), PR4 `4a9b4d69`. The approved patches are unchanged; only the bases moved.
- Chain verification (verifier musll8ax-i-gkko): every branch clean and ancestry correct. Targeted tests 159/564/1063/1067 pass. check-types, runtime `--check` and verify-package-files pass on all four. The PR4 full suite gives 4635 pass, 1 fail, 44 skipped. The failure is `tests/history-session-scan-extract.test.ts:244` (file mtime vs `Date.now()` under `os.tmpdir()`); it fails the same way on the PR1 base, and the stack never touches that file. It is pre-existing and environment-dependent (likely the WSL2 clock), not caused by #1690.
- RDD pending for P1, P2 and P4.
- PR #1712 (carlosmoradev, "Fixes #1688", opened 14:37Z) adds `child-capture.ts` as a third curated entry. That conflicts with the frozen list, and once the package is forwarded `installSessionChangeCapture` (no idempotency guard) would be installed twice in children. A coordination comment is drafted for the user.

## Rebase onto origin/main 653dad90 (2026-10-04)

- #1690 got `status:approved` from barbatdev (2026-10-03 18:59Z). The chain was rebased onto `653dad90`, 125 commits newer. One textual conflict in `tests/gentle-agents.test.ts` (upstream #1713 test next to T4's test): both tests kept.
- Two semantic conflicts were found by the verifier and fixed: `2efe8919` (PR1) keeps the dev-binary notice in children for upstream test `tests/gentle-ai-dev-binary-surfacing.test.ts:236-259`, and `1030d68d` (PR2) passes `cwd` in the upstream bin fixture.
- Tips: PR1 `2efe8919`, PR2 `1030d68d`, PR3 `89295f6e`, PR4 this branch. Focused suites 178/584/1105/1109 pass; check-types, runtime `--check` and verify-package-files pass on all four; the PR1 full suite passes; the PR4 full suite has 2 failures in `tests/history-session-scan-extract.test.ts` (mtime vs `Date.now`), a known timing flake untouched by the chain (passes alone 14/14).
- RDD reviews after the rebase, all `approved` with no correction and authority burned:
  - PR1 polish `c3f3c158..2efe8919` (`review-388a341464ae8fcc`). WARNING: the child dev-binary branch is only covered by the upstream test; the invalid-override toast and the describe-failure path have no child test.
  - PR2 polish `ac5ea634..1030d68d` (`review-1cd635fb601b1443`). Suggestions: no bin-level test pins the bin `cwd` and spawn coupling; the no-declaration branch is not tested with a relative `packageRoot`.
  - T4 rebased `ad09a68e` on `1030d68d` (`review-b620b477747a1aca`). The range-diff against `78391611` changes only context lines. WARNING: T4 drops the curated entries before T5, which is fine because they ship together in PR3. Suggestion: line references in this document are stale after the rebase.
  - PR4 polish `8a40d5f4..172aaddd` (`review-238aba2660e2a7fd`): no findings.
- Line numbers cited in this document refer to the pre-rebase code.

## Merge of origin/main after #1770 landed (2026-10-05)

- #1770 merged as `a8ecb141`. #1772 conflicted with upstream #1558 (session routing) and the #1731 work (writer surfaces). Resolution: keep both sides. `childExtensionRequest` replaces the curated spread, and the new `writerSurfaces`/`writerRoot` request fields stay next to `noExtensions`; upstream tests sit next to the T4 test.
- Upstream `ccd669ac` (Alan, #1731 T32) added `./nan-provider.ts` as a third curated entry, because nan models failed in children. Kept, with user approval: the frozen fallback is now three entries. Forwarded children get nan-provider from the package anyway. #1773 updates the frozen-list test and the docs to the three entries.
- Agents/child/gentle-agents suites 545/545; check-types and runtime `--check` pass.

- Post-sync RDD reviews, both `approved` with no correction and authority burned:
  - #1772 (`review-9dfe7af2bbd8b41e`): candidate `cc781909` (tree identical to `8f5f3f0c`) against a review-only base `644cec80` = #1771 merged with main `a8ecb141`. The writer-surface and #1558 code is intact; the injection only replaces the curated entries.
  - #1773 (`review-79c81e810edd3a47`): `242626d5` against `8f5f3f0c`. The frozen-list test bites: removing `./nan-provider.ts` from the list, or deleting the file, fails it.
- The T7 notes above (a fallback of "exactly [child-context, child-safety]", 178/178, self-checks at `:37-50`) describe the two-entry version. Since this sync the fallback has three entries (605/605), and the helper self-checks are at `tests/child-package-entrypoints.test.ts:49-65`. `childExtensionRequest` is cited by name; its line numbers moved.

## Delivery budget

As of `f384d2a1`, the branch carries 322 changed lines against origin/main in code and tests (T2), plus about 100 in this ODD document, roughly 420 in total. The forecast for T2b-T7 is about 600-800 more lines, so a single PR would exceed the 400-line budget several times over. Proposed: stacked PRs to main, each landable on its own:

**Re-sliced on 2026-10-03 (user-approved) into four stacked PRs:** PR1 = T1+T2+T2b (`fix/1690-standalone-child-package` @`54effec6`), PR2 = T3 (`fix/1690-launcher-injection-signal` @`a72978e3`; T3 alone is 380 changed lines), PR3 = T4+T5+T6 (`fix/1690-child-package-forwarding`; about 239 code+test lines; re-sliced again on 2026-10-03 with user approval, and T4 must ship with T5), PR4 = T7. Original proposal:

1. PR1, child guards: T1 + T2 + T2b. On its own it changes nothing for isolated children, and it hardens regular gentle-pi children, which already load the package. About 460 lines including this document; slightly over budget because of the tests and the doc.
2. PR2, package forwarding: T3 + T4 + T5.
3. PR3, the missing-tool warning, the acceptance probe and docs: T6 + T7.

**Chain strategy: stacked PRs to main, confirmed by the user on 2026-10-03.** Branch plan:

- PR1: `fix/1690-standalone-child-package`. Once T2b is committed here, fast-forward that branch to include it (the docs commit plus T2b).
- PR2: a new branch from the PR1 tip, for T3-T5.
- PR3: a new branch from the PR2 tip, for T6-T7.

Every PR carries the chain context and a dependency diagram (chained-pr skill). No PR before barbatdev answers on `status:approved`.

## Pending follow-ups

- [x] Optional PR4 polish (T7 review): rename the helper self-check assertions in `tests/child-package-entrypoints.test.ts:37-50`; optionally add one line to `docs/gentle-shell.md` § Gentle Agents about the pre-existing takeover crash with an extension-less package.

- [ ] Pre-existing: a takeover `-e` of a settings package without extensions (only `package.json`, skills-only) makes pi exit with "Failed to load extension" (seen in the T7 probe for a child; `otherPackageInjections` in `lib/gentle-shell-launcher.ts:707` does not filter such packages for the parent either). Confirm on the parent, then file it or fix it separately.

- [ ] Agent frontmatter `"*": false` (`assets/agents/review-reliability.md:5`) is passed verbatim to `--tools` by `parseTools` (`lib/agents-config.ts:173-177`) and dropped by Pi. It predates #1690 and is ignored by the T6 check; decide whether the parser should drop it.
- [ ] Optional: exclude task NOTEs from `sawRunEvent` (`lib/agents-runner.ts:785,798`) so stall timeouts keep the "no first run event" hint; affects extension_error/auto_retry NOTEs too.

- [x] Optional PR2 polish (T3 review suggestions, non-blocking): (1) `lib/gentle-shell-launcher.ts:980-981`: `absoluteExtensionPath` resolves against `process.cwd()`, so `buildPiInvocation` is not pure; inject the cwd or pin it with a test. (2) `:956`: the set is deduped by raw string before the paths are made absolute; dedupe after absolutizing (harmless today because pi dedupes by realpath).

- [x] Optional PR1 polish (T2b review suggestions, non-blocking): (a) `tests/gentle-ai-child-guards.test.ts:90-94`: await the `tool_execution_start` handler before counting ledger entries; (b) `extensions/gentle-ai.ts:9686-9688`: no test asserts that `yolo.reset`/`reviewSidebar.reset` run in a child. Add one, or narrow the comment.

- [ ] **Report upstream: `gentle_review` unreachable from Pi over pi-claude-bridge.** Target: pi-claude-bridge (elidickinson) or gentle-shell; decide after confirming the cause.
  - Symptom (2026-10-03, Gentle Shell standalone, Pi 1.0.0, pi-claude-bridge 0.9.0, model Opus 5.5): the gentle-pi tool `gentle_review` (registered unconditionally, `extensions/gentle-ai.ts:9526`) never reaches the model. `gentle_review_capture`, `gentle_review_capture_group` and `gentle_review_scope` do. The model's own instructions say some tools are deferred, and a SessionStart hook asks it to run `ToolSearch`, which it does not have.
  - Hypothesis (not verified): the bridge provider path starts Claude Code with `tools: []` (`pi-claude-bridge/src/index.ts:1960`, comments at :136 and :918), so the built-in `ToolSearch` is unavailable, while Claude Code still defers part of the MCP tool set. Deferred tools then become unreachable. `ToolSearch` is also always blocked in AskClaude mode (`src/index.ts:168`).
  - Impact: RDD inspect/START cannot run from a Pi session on this provider. Workaround in use: run the reviews from a native Claude Code session.
  - To confirm before filing: restart with `ENABLE_TOOL_SEARCH=false` (all tools sent upfront) and check that `gentle_review` appears; check whether the deferral depends on tool count or schema size; search existing bridge issues (related: #153, Pi 1.0 mcp_servers).

## Acceptance criteria

- An isolated standalone child exposes the same package commands and tools as a regular gentle-pi child.
- Child launches do not rewrite shared files (assets, agent frontmatter, `subagents.json`, project `.pi/settings.json`).
- The package registers exactly once in every launcher case (no declaration, takeover, declaration).
- A requested tool that is missing in the child produces a visible warning.

## Evidence

- T1: commit `5848fb80` (static audit; the loader facts were re-confirmed on Pi 1.0.0 during T2 verification).
- T2 RDD review (native Claude Code session): `approved`, medium risk, one lens (review-reliability), candidate `a67bb7f5` against base `5848fb80`, no correction; authority burned (lineage `review-71c63d42e08bde90`). Two non-blocking findings were tracked as T2b.
- T2b RDD review (native Claude Code session): `approved`, medium risk, one lens (review-reliability), candidate `54effec6` against base `f384d2a1`, no correction; authority burned (lineage `review-8c111c00f615d9c9`). Both T2 findings confirmed resolved. Two new non-blocking suggestions were tracked in "Pending follow-ups".
- T5 RDD review (native Claude Code session): `approved`, medium risk (classified from the .ts files although the change is comment-only), one lens, candidate `b54a2897` against base `78391611` on `review/1690-t5`, no correction; authority burned (lineage `review-b6e97876ce384292`). The reviewer confirmed that no executable line changed and that the comments match T4; claim (1), that child-context/child-safety are package entrypoints, was checked against `package.json`. Suggestions: (a) a test pinning `childContextExtensionPaths` to exactly the two current entries, so the frozen list is enforced (do it in T7); (b) the T7 live probe must show no duplicate commands in the declared and takeover cases (added to the running probe).
- T4 RDD review (native Claude Code session): `approved`, medium risk, one lens, candidate `78391611` against base `a72978e3` on `review/1690-t4`, no correction; authority burned (lineage `review-abb3acfc02a43af1`). WARNING (non-blocking): with the signal, the curated entries are dropped, so the reviewer asked that T4 not ship without T5. Parent assessment: T4 and T5 ship together in PR3 anyway, and the forwarded package root already contains `child-context.ts`/`child-safety.ts` as entrypoints (T1 loader facts), so children keep both. T7's live probe must confirm it. SUGGESTION: add a test for `noExtensions: true` with an empty `extensionPaths` (`lib/agents-runner.ts:264`); the T3 parser rejects that shape, but no test inside T4 proves it.
- T3 RDD review (native Claude Code session): `approved`, medium risk, one lens, candidate `a72978e3` against base `54effec6` on `fix/1690-launcher-injection-signal`, no correction; authority burned (lineage `review-3327730cc6f0c700`). Two non-blocking suggestions were tracked in "Pending follow-ups".
- T2: RED→GREEN per guard (writer). Verification on a real `pnpm install --frozen-lockfile` with pi-coding-agent 1.0.0: focused tests 55/55; wider set 517/518, the one failure being `tests/history-session-scan-extract.test.ts:197` (mtime vs `Date.now()`, untouched code), which then passed 14/14 three times in isolation, so treated as a timing flake; `node scripts/check-types.mjs` gives the same result on the branch and on origin/main (186 recorded, no regressions). Loader facts on 1.0.0: rpc `hasUI` is true (`rpc-mode.js:230-232`, `runner.js:404-405`); `mergePaths` dedupes by realpath with the CLI paths first (`resource-loader.js:403-405,781-792`). Commit: the T2 commit carrying this line.
