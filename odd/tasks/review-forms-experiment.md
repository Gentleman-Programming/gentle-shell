# Review forms experiment (T9c, S11)

Question (user, S11): is a verify worth it, is RDD worth it, and in which form: native RDD with separate processes, plain lens subagents, one independent verifier, or nothing but tests?
Answer in one paragraph: on these seven diffs, no form caught more than 2 of the 6 real defects. Each form caught different ones, and two real defects were caught by none. All three model forms found 4 of 4 seeded synthetic defects. Native RDD cost the most: median $1.65 per review, 2.2x the lens fan-out and 1.7x the verifier. It found the fewest real defects (1 of 6) and raised no blocking false alarm. 91% of its cost went to the parent driving the protocol (13–16 turns); the lens completions themselves cost $0.08–0.33. Plain lens subagents were the cheapest and fastest (median $0.76, 154 s). The verifier was the slowest (median 376 s, one run took 1,414 s), but it was the only form that proved findings by running code. Tests alone took seconds and cost nothing; they caught both R1 defects, including one that no model form caught.

n=1 per arm and input. Seven inputs, one model routing. The provider was shared with other sessions: about 10 Pi processes were running at the start. Read every number below as one observation, not a rate.

## Setup

- Scratch, kept and never deleted: `/private/tmp/review-forms-k4o3El`. Layout: `inputs/<ID>` (one clone per input, branch `review`), `runs/<ID>-<arm>` (a fresh `--shared` clone per run, no remote), `keys/<ID>.md` (answer keys, written before any model run; `keys/WRITTEN_AT`), `sess/<id>` (parent sessions), `out/` (stdout, stderr, meta, metrics), `tools/` (scripts).
- Package root: `pkg/`, a scratch clone of gentle-pi at main `29b57a414` (the T7 after-phase commit). It has `node_modules` linked to the main checkout (Pi 1.5.2) and a byte-identical copy of the pinned `gentle-ai` 4.4.0 binary and `integrity.json` from `~/work/gentle-pi/.gentle-ai/v4.4.0/`. The `.worktrees/bench-after` tree has no `.gentle-ai/`, so the native arm could not run from it.
- Launch method: same as the benchmark harness, `/private/tmp/cost-speed-bench-PSQgUo/run.sh`, arm O:
  `env -i HOME PATH USER LOGNAME SHELL=/bin/bash LANG TERM=dumb TMPDIR=/tmp GENTLE_AI_HOME=<isolated> GENTLE_PI_ORCHESTRATOR_MODE=organic GENTLE_SHELL_SKIP_STARTUP_UPDATE=1 timeout 1500 node pkg/bin/gentle-shell.mjs -p --mode json --model openai-codex/gpt-6-astra --thinking medium --session-dir sess/<id> "<prompt>"` (`tools/run-model.sh <ID> <arm> <base-sha>`). Pi stays on the user's real agent directory through the launcher's normal resolution, so no credentials were copied or read. Each run was one tool call, awaited before the next.
- Metrics: `tools/metrics.py` reuses `analyze.py` from the benchmark harness (`sess()`, `children()`). It covers the parent session, the child sessions (found through `~/.gentle-shell/agent/gentle-agents/tasks/*.json` by `parentSessionId`), and the native reviewer completions from the `host_relay.reviewer(_runs)` evidence in the parent's `gentle_review_capture*` results. Costs are Pi's estimates (`totalFromProvider: false` everywhere); nothing was unpriced. Cache writes were reported as 0 in every session; the `openai-codex` provider does not report cache writes (`odd/tasks/cost-speed-bench.md`, Cache), so this does not show that none occurred.
- Prompts: `tools/prompt.py`; the exact text of each run is in `out/<id>.prompt.txt`. Every prompt is review-only: no edits, no network, and a final list of findings with file:line, severity and whether each one blocks. Arms b and c paste the full `git diff <base> HEAD`. Arm a gives the `START` input and grants consent in advance ("I, the human, grant consent…").
- Arm d (no model): `tools/arm-d.sh` and `tools/arm-d-base.sh`. Focused tests are the test files touched by the diff, plus tests named after a touched module, plus tests that name a touched `assets/` or `docs/` path (`tools/focused.py`). Commands: `env -i PATH HOME=<tmp> TMPDIR=<tmp> NO_UPDATE_NOTIFIER=1 node --experimental-strip-types --test <files>`, then `node --experimental-strip-types tests/runtime-harness.mjs`, then `git diff --check <base> HEAD`. The same files and the harness also run at the base; only failures that are new at the head count. That comparison is needed because 77 editor/vim tests in `tests/gentle-shell.test.ts` fail identically at base and head with the main checkout's `node_modules`.

### Isolation of the review mode (arm a)

- The user's real state before anything ran (binary `~/work/gentle-pi/.gentle-ai/v4.4.0/gentle-ai`, cwd `.worktrees/bench-after`): `global: off, effective: off, source: global` (`user-mode-before.json`, 2026-11-10T20:26:18Z).
- Read-only probe: `env -i HOME PATH TMPDIR GENTLE_AI_HOME=<scratch>/gaihome gentle-ai review mode status --json` reported `global: "", effective: on, source: default`. In the same minute the real environment still reported `off / global`. That proves isolation. `HOME` stays real, so Pi keeps its login.
- Only then: `review mode enable --scope=global` with `GENTLE_AI_HOME=<scratch>/gaihome`. Scratch status afterwards: `on / global`. Real status: unchanged `off / global`; `~/.gentle-ai/state.json` mtime still Nov 9.
- Arms b and c ran in a second isolated home, `<scratch>/gaihome-off`, set with `review mode disable --scope=global`. That matches the user's setting without touching the real state. Every run's `out/<id>.meta` records the status it saw: 8 `on` (arm a), 15 `off`.
- After all runs, real status: `global: off, effective: off, source: global` (`user-mode-after.json`). It is byte-identical to the before file apart from the timestamp line.

### Model routing actually used (from session files)

- Parent: `openai-codex/gpt-6-astra`, thinking `medium`, in all 23 sessions.
- Native lenses and refuter (arm a): `openai/gpt-6.1-sol`, from `host_relay.reviewer.reviewerModel`. The relay evidence does not record effort. The user's routing (`~/.gentle-shell/agent/subagents.json`) has `review-*: openai/gpt-6.1-sol, effort high`.
- Lens subagents (arm b): `openai/gpt-6.1-sol`, thinking `high` (session `thinking_level_change`).
- Verifier (arm c): `openai/gpt-6.1-sol`, thinking `high` (user routing `gentle-ai-verify: sol high`).

## Inputs and answer keys

| ID | Base | Head | Built how | Known defects (answer key, in words) |
|---|---|---|---|---|
| R1 | `0cbfd1f54` | `0757895d1` | real commit (PR #3095 rebase) | 2. D1: unresolved conflict markers in `extensions/child-context.ts:30-36`, so the module does not parse. D2: the new `docs/readme-reference.md` section names the `sdd-orchestrator` and `sdd-model-assignments` blocks, which `tests/package-manifest.test.ts:130` forbids. |
| R2 | `a09e67452` | `b8ed85176` | real commit (PR #3080) | 1. `scripts/pi-update.mjs` `piAgeExclusion` exempts only `@earendil-works/pi-coding-agent` from pnpm's release age. The exact co-published `@earendil-works/*` packages Pi pins (direct and transitive) are not exempted, and same-name rules are not merged, so a strict `minimumReleaseAge` fails with `ERR_PNPM_STRICT_MIN_RELEASE_AGE_REQUIRES_SAVE` (fixed by 116c0e997). |
| R3 | `116c0e997` | `586bb9ad8` | 63c5acfdd cherry-picked. Final wording replaced by the first pass "never keep repairing helpers or relaunch for that prerequisite". Regression test "keeps the human-requested relaunch after a repaired prerequisite" removed; two test strings adjusted to match. | 1. `assets/orchestrator-verification.md:26` lost "automatically". The relaunch ban is now absolute and contradicts the always-on "Authorized work continuity" paragraph (`extensions/gentle-ai.ts` ~1660: the human may request one new attempt after a repaired prerequisite). |
| R4 | `c09189269` | `6f1d8c88a` | ce3ae68fd cherry-picked. `gentle-ai-verify.md` env clause reduced to "`env -i` with an explicit `PATH`, `HOME`, and `TMPDIR` (set … `NODE_COMPILE_CACHE` there too, and `NO_UPDATE_NOTIFIER=1`)", with "for every probe" gone. The resume sentence in worker/verify/explore ends "unless the parent says they changed; read only what the follow-up names." The two regression tests were removed and `agent-body-history.json` was rebuilt (base history plus the 3 new hashes), so no hash test detects it. | 2. D1: the verifier's `env -i` clause no longer carries `NODE_COMPILE_CACHE` and `NO_UPDATE_NOTIFIER=1` for every probe. D2: "read only what the follow-up names" can make a resumed child skip unread spec or code, and "unless the parent says they changed" replaces "unless they changed". |
| C1 | `676ffb4e9` | `0cbfd1f54` | real commit (PR #3093, CI green, verified) | 0 (clean control). |
| S1 | `4df89db` | `aa7bf2b98` | synthetic invoice service (TypeScript, `node --test`). The feature commit has 4 seeded defects; its tests pass 6/6. | 4. Risk: `src/export.ts` interpolates the request `customer` into an `execSync` shell string. Reliability: `src/listing.ts` `pageCount` uses `Math.floor`, dropping a partial last page; tests cover only exact multiples. Resilience: `src/rates.ts` `loadRates` swallows fetch errors and returns `{}` with no retry or signal, so totals silently use 0. Readability: `formatAmount` also sets `invoice.exported = true`, a misleading name for a function that does two things. |
| S2 | `4df89db` | `ff0a0af58` | the same base with a clean feature commit of similar size (100 vs 102 added lines; ceil paging with boundary tests, missing rate throws, RFC 4180 CSV, no shell, no mutation); tests 6/6 | 0 (clean control). |

Full shas are in `tools/inputs.txt`; full keys are in `keys/*.md`. Deviations from the task text:

- R2 uses the commit's real parent `a09e67452`. The task named `0488da162`, one commit further back, which only adds a README-only docs commit.
- R4 was rebuilt once before any model run. The first build dropped the `NO_UPDATE_NOTIFIER=1` string entirely, and `tests/verify-first-launch-contract.test.ts` (T22) caught it; that arm-d run is kept under `runs/_invalid` and `out/_invalid`.
- R3 as built also overflows the 7,900 B budget of `orchestrator-verification.md` (7,913 B; `tests/task-size-routing-contract.test.ts:177-180`). That is a second real defect introduced by my reconstruction. The focused-test selection did not include that test file, so it was not noticed before the runs. It is scored as real-but-unlisted.

## Per-run measurements

Model calls = parent turns + child turns + relay completions. Tokens are summed over all sessions and relay completions. Cache writes were reported as 0 everywhere (not reported by the provider, see Setup).

| run | wall s | parent turns | model calls | input | output | cacheRead | parent $ | child $ | relay $ | total $ | human prompts (interactive) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| S1-a2 | 337.3 | 14 | 19 (14+0+5) | 84,283 | 19,127 | 595,968 | 1.767 | 0 | 0.126 | 1.893 | 3 |
| S1-b2 | 137.5 | 3 | 19 (3+16+0) | 100,555 | 8,171 | 148,480 | 0.521 | 0.199 | 0 | 0.721 | 0 |
| S1-c | 249.6 | 3 | 10 (3+7+0) | 49,391 | 14,018 | 139,008 | 0.517 | 0.155 | 0 | 0.673 | 0 |
| S2-a | 290.5 | 14 | 18 (14+0+4) | 69,679 | 13,245 | 590,208 | 1.571 | 0 | 0.076 | 1.647 | 2 |
| S2-b | 134.8 | 3 | 18 (3+15+0) | 98,063 | 6,728 | 141,824 | 0.516 | 0.181 | 0 | 0.696 | 0 |
| S2-c | 210.1 | 3 | 10 (3+7+0) | 43,646 | 9,593 | 129,536 | 0.502 | 0.102 | 0 | 0.604 | 0 |
| C1-a | 280.7 | 15 | 19 (15+0+4) | 70,292 | 13,047 | 540,928 | 1.444 | 0 | 0.090 | 1.534 | 2 |
| C1-b | 215.0 | 3 | 27 (3+24+0) | 142,064 | 9,772 | 412,160 | 0.555 | 0.318 | 0 | 0.872 | 0 |
| C1-c | 886.1 | 3 | 18 (3+15+0) | 115,985 | 16,291 | 962,560 | 0.563 | 0.384 | 0 | 0.947 | 0 |
| R1-a | 323.5 | 14 | 19 (14+0+5) | 125,900 | 18,190 | 511,232 | 1.605 | 0 | 0.215 | 1.820 | 3 |
| R1-b | 98.9 | 3 | 21 (3+18+0) | 145,374 | 6,014 | 362,752 | 0.456 | 0.302 | 0 | 0.758 | 0 |
| R1-c | 223.8 | 4 | 15 (4+11+0) | 108,995 | 8,708 | 618,112 | 0.493 | 0.278 | 0 | 0.771 | 0 |
| R2-a | 396.8 | 16 | 21 (16+0+5) | 169,109 | 21,000 | 597,888 | 1.698 | 0 | 0.328 | 2.026 | 3 |
| R2-b | 238.5 | 4 | 34 (4+30+0) | 242,476 | 9,079 | 1,203,072 | 0.601 | 0.588 | 0 | 1.189 | 0 |
| R2-c | 375.6 | 3 | 18 (3+15+0) | 207,829 | 13,771 | 1,831,040 | 0.563 | 0.632 | 0 | 1.195 | 0 |
| R3-a | 337.1 | 15 | 19 (15+0+4) | 77,780 | 12,887 | 529,920 | 1.445 | 0 | 0.101 | 1.546 | 2 |
| R3-b | 153.9 | 3 | 19 (3+16+0) | 149,593 | 4,299 | 222,976 | 0.373 | 0.295 | 0 | 0.668 | 0 |
| R3-c | 1414.0 | 3 | 19 (3+16+0) | 160,245 | 17,863 | 1,455,232 | 0.641 | 0.522 | 0 | 1.163 | 0 |
| R4-a | 279.7 | 13 | 17 (13+0+4) | 84,184 | 13,162 | 460,288 | 1.377 | 0 | 0.117 | 1.494 | 2 |
| R4-b | 227.6 | 3 | 21 (3+18+0) | 248,853 | 11,711 | 262,656 | 1.077 | 0.428 | 0 | 1.506 | 0 |
| R4-c | 528.3 | 3 | 16 (3+13+0) | 128,734 | 19,411 | 937,984 | 0.779 | 0.396 | 0 | 1.175 | 0 |

- Setup attempts, kept and not counted in the arm summaries:
  - S1-a (34.5 s, $0.455) stopped at the native consent envelope (the prompt had no consent grant).
  - S1-b (68.0 s, $0.505): all four `subagent_run` calls with `review-*` agents were rejected, so no reviewer ran (anomaly 2).
- Refuter: ran in S1-a2, R1-a and R2-a, as one relay completion each (`provider_refuter`, not a `pi` subprocess in this build). Validator: ran in no run. Correction-required reviews stop before it, and approved ones did not need it.
- Human-facing prompts in arm a: each run needs the start consent, plus one acknowledgement per reviewer model-run forecast (`blocker.actor: user`, category `consent`): the lens group, and the refuter when it runs. Headless, these were answered by the parent from the advance grant in the prompt.
- Engram: 0 `mem_*` tool calls in all 23 parent sessions and 35 child sessions. Passive captures by the gentle-engram plugin were not inspected, so no throwaway-project counts are claimed.

Arm d (no model):

| input | head wall s | base wall s | new failures at head | caught |
|---|---|---|---|---|
| R1 | 37.3 | 40.6 | 2 (`tests/child-context-files.test.ts` fails to load; "public docs and metadata advertise ODD and review without retired phase workflow"), runtime harness exit 1, `git diff --check` exit 2 | D1 and D2 |
| R2 | 43.5 | 49.0 | 1, unrelated: `tests/session-scratch.test.ts:801` "process start token … another process has another token", an OS-token flake | none (1 noise failure) |
| R3 | 15.6 | 15.6 | 0 (the budget test was not in the focused set) | none |
| R4 | 25.5 | 26.3 | 0 | none |
| C1 | 24.4 | 24.0 | 0 | — (no false alarm) |
| S1 | 0.2 | — | 0 (6/6 pass) | none |
| S2 | 0.2 | — | 0 (6/6 pass) | — |

## Scoring

A known defect counts as found only when the finding names its location and what is wrong. Not-in-key findings are classified as real-but-unlisted (R), advisory (A) or false positive (FP). "Blocking" means the arm itself said the finding blocks.

| input | arm a (native RDD) | arm b (lens subagents) | arm c (one verifier) | arm d (tests) |
|---|---|---|---|---|
| R1 | D1 BLOCKER ✓; D2 ✗. Not in key: R "the without-cwd test passes `undefined`, which activates the helper's default `cwd`" (the default parameter at `tests/child-context-files.test.ts:251` makes it true); R "two protocol-bearing files in the nearest directory cause deduplication to stop entirely" (code keeps the ancestor copy, contrary to the docs' "drop the copies in its ancestor directories"; minor edge) | D1 BLOCKER ✓; D2 ✗. Same two R; A "environment isolation … duplicate[s] `tests/primary-context-files.test.ts:85–141`" | D1 BLOCKER ✓, proven (3 test files fail to load, harness fails, diff --check fails); D2 ✗. R: the same nearest-directory tie | D1 ✓, D2 ✓ |
| R2 | known ✗. Not in key: R "With npm `json=true`, the registry query returns a quoted JSON string … aborting otherwise valid updates" (CRITICAL; the verifier reproduced it in R2-c); A "Global Shell-supplied installations reinstall Shell without constraining its Pi peer" (CRITICAL; plausible from the code, the version check runs after the install; not reproduced) | known ✓ (lens-resilience, WARNING, non-blocking: "Exempting only Pi leaves its exact-version, co-published dependencies age-filtered"). Not in key: A BLOCKER "Global adjacent-peer tests manufacture the updated peer version in mocks" (coverage gap); A "preflight checks lack tests for failed exits"; A SUGGESTION on inert fixture fields | known ✗. R: the npm `json=true` failure, reproduced ("fails at HEAD and passes at base"), WARNING, blocking | ✗ (1 unrelated flaky failure) |
| R3 | ✗ (APPROVED; lenses exposed no findings) | ✗. A "Relaunch instructions do not require telling the replacement verifier that the sole correction is already consumed"; A "'If none' ambiguously describes when to relaunch" | ✗. R BLOCKER, proven: "increases the module to 7,913 bytes, exceeding its 7,900-byte budget", which fails `tests/task-size-routing-contract.test.ts` (a reconstruction artifact) | ✗ |
| R4 | ✗ ✗ (APPROVED; no findings exposed) | ✗ ✗ ("All four lenses … returned empty ledgers") | D2 BLOCKER ✓ ("'read only what the follow-up names' prevents necessary first-time reads during continuation"); D1 ✗ | ✗ ✗ |
| C1 (clean) | 0 blocking. A WARNING: tests assert the skills array is emptied, not the rendered prompt | **1 blocking**: BLOCKER "Tests assert synthetic hook-array mutation, not the model-visible prompt" (A: the same coverage remark arm a filed as a WARNING; a false alarm as a blocker). A WARNING: ownership identified by name, scope and filename | **1 blocking**: BLOCKER "identifies package ownership using only name, global scope, and filename … customized global agents … lose their skills catalog", reproduced. A: documented design (`lib/agents-runner.ts:344-349` comment); a false alarm as a blocker | 0 |
| S1 | 4/4 ✓ (risk, reliability and resilience CRITICAL; readability WARNING). Not in key: R CSV escaping; A "synchronous archive creation blocks the worker's event loop"; A "a failed export retry can overwrite a valid archive" | 4/4 ✓ (risk BLOCKER; reliability and resilience CRITICAL; readability WARNING). Not in key: R "`../private` escapes the intended source and output directories" (path traversal, CRITICAL); R CSV escaping | 4/4 ✓ (two CRITICAL, rest WARNING; all marked blocking; injection reproduced). Not in key: R path traversal, reproduced; R CSV escaping | 0/4 |
| S2 (clean) | 0 blocking. A: CSV formula injection; A: pagination test cannot tell date order from insertion order | 0 blocking. 4 A WARNINGs (formula injection, missing rounding/CRLF/ordering test cases), 1 A SUGGESTION | **1 blocking**: BLOCKER "Converting 50 EUR cents at 1.13 … returns 56 because the computed product is `56.49999999999999`", reproduced. I classify it R (float rounding of money) with overstated severity; under the clean-control rule it counts as a false alarm | 0 |

## Summary per arm

Recall on real defects is over R1–R4, 6 known; synthetic recall is S1, 4 known. "Found" totals are over all 10 known defects. Cost and time medians are over the 7 inputs.

| arm | real recall | synthetic recall | blockers on clean diffs (C1+S2) | median cost | median wall | total cost (7 inputs) | cost per known defect found | parent share of cost |
|---|---|---|---|---|---|---|---|---|
| a native RDD | 1/6 (R1 D1) | 4/4 | 0 | $1.647 | 323.5 s | $11.96 | $2.39 (5 found) | 91% |
| b lens subagents | 2/6 (R1 D1, R2) | 4/4 | 1 (C1) | $0.758 | 153.9 s | $6.41 | $1.07 (6 found) | 64% |
| c one verifier | 2/6 (R1 D1, R4 D2) | 4/4 | 2 (C1, S2; I classify the S2 one as real) | $0.947 | 375.6 s | $6.53 | $1.09 (6 found) | 62% |
| d tests only | 2/6 (R1 D1, R1 D2) | 0/4 | 0 (1 unrelated flaky failure on R2) | $0 | 24.4 s | $0 | $0 (2 found) | — |

- All four arms together found 4/6 real defects. R3 D1 (the lost "automatically") and R4 D1 (the env clause) were found by none. Both are prompt-wording regressions whose regression tests had been removed.
- Lens completions inside native RDD cost $0.076–0.328 per review. The parent's 13–16 turns around them cost $1.38–1.77. Parent model turns of about 90 s each appear while the parent composes the collect-binding arguments (S1-a2, 20:41:41 → 20:43:14 → 20:44:48).
- Arm b and c parents cost about $0.37–1.08 with only 3–4 turns. A fresh parent's first turn (about 140 KB of prompt) dominates that. R4-b's parent is the outlier ($1.08) because it pasted the diff four times (11.7k output tokens).

## What only one arm found

- Native RDD (a): the global Shell reinstall that does not pin the Pi peer to the latest version (R2, advisory, not reproduced). The event-loop-blocking export and the overwrite-on-retry (S1, advisories).
- Lens subagents (b): the R2 known defect (co-published packages not exempted from release age). The duplicated test setup (R1, advisory). Missing rounding, CRLF and ordering test cases and the undocumented `Rates` contract (S2, advisories). The two R3 relaunch-wording advisories.
- Verifier (c): R4 D2. The R3 byte-budget overflow, proven by a failing test. The S2 float-rounding error, proven by a probe. It was also the only arm that reproduced findings (shell injection and path traversal on S1, npm `json=true` on R2, the ownership-by-name case on C1).
- Tests (d): R1 D2, the forbidden `sdd-` names in docs.

## Anomalies

1. **The headless native review asked for consent.** The explorer's map (`lib/native-review-cli.ts:202-227`, "headless reviews without asking") does not match what happened. `START` returned `native-review-consent-required` (risk `high`), and each reviewer model-run forecast came back as a `consent` blocker with `actor: user`. Arm a only completes headless when the prompt pre-grants consent and the parent answers `answer-consent` and `reviewerRunAcknowledged: true` itself.
2. **The lens agents cannot run as plain subagents.** `subagent_run` with `review-risk` and the other three is rejected outside a native lineage. `lib/review-candidate-view.ts:1998` allows only `agent|agents|task|context|mode` (the parent's `label` is rejected), requires `mode: "task"`, and requires a controller-owned frozen candidate view. So arm b used `.pi/agents/lens-<lens>.md` project copies of `assets/agents/review-<lens>.md`, with the body byte-identical and only `name` changed. They were pinned with `model: openai/gpt-6.1-sol` and `thinking: high` to match the user's `review-*` routing, and `.pi/` was excluded from git. This is the closest available form of "plain lens subagents", not the shipped one.
3. **Approved native reviews hide findings from the parent.** On R3 and R4 the review ended APPROVED, and the parent could not list any findings ("the native tools did not expose individual findings"). The lineage state is consumed: only `terminal-consumption/v1/*.json` remains under `.git/gentle-ai`. So zero findings on those two runs cannot be told apart from "lenses found nothing". Non-blocking WARNINGs were exposed on C1 and S2.
4. **The verifier's wall time is long and variable.** It took 886 s on C1 and 1,414 s on R3, close to the 1,500 s timeout, because it ran full suites at head and base. Its runtime-harness probes failed in every gentle-pi run because its tar copies exclude `.git` ("scratch copies lacked Git-worktree metadata"). It left scratch at `/tmp/vfy.AGdk13`, `/tmp/r4.GDXikB` and `/tmp/r4.3aLskU`.
5. **Environmental test failures.** 77 editor/vim tests fail at both base and head with the main checkout's `node_modules`. One flaky OS-token test showed up as a new failure on R2.
6. **The R3 and R4 reconstructions are approximations of the first passes.** They are faithful to the key's defect texts; extra artifacts are noted above.
7. **The provider was shared.** About 10 Pi processes were running at the start, so wall times carry that noise (the T7 noise floor was about 15%).

## What the data supports and what it does not

Supported, within n=1:

- **Native RDD costs about twice as much as lens fan-out for no extra detection here.** It found 1/6 real defects against 2/6 for b and c, and the same 4/4 synthetic. It was the only model arm with no blocking false alarm on the clean diffs.
- **The cost of native RDD is the parent driving the lifecycle, not the reviewer processes.** That is 13–16 parent turns at about $0.1 each, versus at most $0.33 for all lens and refuter completions. These runs do not show whether moving the lenses into separate processes or into subagents would keep that split: the native lenses ran as relay completions, and arm b also dropped the review lifecycle. Fewer parent round-trips target the measured cost (for example, one call that runs the whole headless lifecycle); that was not measured either.
- **Each form saw different defects.** Static lens reading caught a dependency-graph defect (R2). The executing verifier caught a semantic prompt regression (R4 D2), a byte budget (R3) and a float bug (S2), and it reproduces what it reports. Tests caught the mechanical defects of R1 for free.
- **A no-model test pass is worth running first in every form.** It is seconds, $0, and it caught the R1 defect no model form caught.
- **Blocking false alarms on clean diffs came from the plain lenses and the verifier, not from native RDD.** The plain lenses gave one (C1) and the verifier two (C1, S2). Native RDD raised no blocker on either clean diff; its lenses reported non-blocking WARNINGs there (on C1 the coverage remark arm b filed as a blocker). The refuter did not run on C1 or S2 (it ran only in S1-a2, R1-a and R2-a), so this result cannot be attributed to it, and the native S2 warnings did not include the verifier's float-rounding finding.

Not supported:

- Any ranking between b and c. They tied on recall, 2/6 each with different defects, and the cost gap ($0.76 vs $0.95 median) is within one run's variance.
- A general recall rate. These are 7 inputs, n=1 each. The model is sampled, and a rerun could flip any single detection.
- Conclusions for other routings: all reviewers here were `gpt-6.1-sol`. Effort `high` is recorded in the arm b sessions; for arm c it is the configured routing, and for the native lenses and refuter it is only the configured routing, because the relay evidence does not record effort (Setup).
- Native RDD's value as an authority record (receipts, lineage, correction bounds). This experiment measures detection, cost and time only.
- Wall-time comparisons finer than about 15%, given the shared provider.
- That plain `review-*` subagents behave like arm b. The shipped dispatch guard blocks them (anomaly 2); arm b used renamed copies.

## Reproduce

```sh
S=/private/tmp/review-forms-k4o3El
$S/tools/arm-d.sh <ID> <base> && $S/tools/arm-d-base.sh <ID> <base>     # arm d
$S/tools/run-model.sh <ID> <a|b|c> <full-base-sha> [suffix]              # ONE model run per call, awaited
cd $S && python3 -B tools/metrics.py <id>... > out/metrics.jsonl         # metrics
```
