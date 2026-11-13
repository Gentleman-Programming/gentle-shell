# Native review in one parent call: benchmark before and after (T5, S7)

User (S7): "Apruebo pero antes de pr quiero que hagas bench y compruebes los cambios, de paso dame la diff en costo y tokens con main base deñ último bench".

Result in one paragraph: on the same seven inputs, prompts and models, the native review on `feat/review-one-call` (234cf3a31) took a median of 4 parent review-tool calls instead of 8. Parent turns fell from 14 to 9, total cost from $1.647 to $0.865 (−47.5%), and wall time from 323.5 s to 145.7 s (−55.0%). Reviewer runs did not change (31 in both arms); over the seven inputs reviewer tokens went from 383,091 to 384,538 (+1,447, +0.4%) and reviewer cost from $1.053 to $1.076 (about +$0.02, +2.1%). Detection did not change: real defects 1/6 → 1/6 (the same R1 D1), synthetic 4/4 → 4/4, no blocker on either clean diff. R3 and R4 were again approved with known defects. `gentle_review_run` closed approved reviews in one call (4 of 7 inputs). On the three reviews that needed the refuter it stopped with `blocked` after the lens group, so the parent had to call it a second time. That stop comes from code this feature did not change (anomaly 1). n=1 per input; every number below is one observation.

Second pass (`final` arm, 4eb357f8b, after the fixes of L7–L8; section "Second pass" at the end): `gentle_review_run` took exactly one call in all seven runs, the refuter reviews included. Approved runs returned `advisory_finding_claims`, and no parent launched a child to recover finding text. Medians, base → after → final: review-tool calls 8 → 4 → 4, parent turns 14 → 9 → 6, total cost $1.647 → $0.865 → $0.625 (final −62.0% vs base, −27.8% vs after; estimates), wall time 323.5 → 145.7 → 83.3 s. Detection was unchanged at 1/6 real and 4/4 synthetic. R2 was approved this time, so three diffs with known defects were approved (R2, R3, R4). In the consent probe (R3 without the advance grant), the parent stopped at the START consent, relayed it, and did not answer it.

## Setup

- Harness: `/private/tmp/review-forms-k4o3El` (last benchmark, read only). Everything new is under `/private/tmp/review-forms-k4o3El/one-call/`: `tools/` (`run-native.sh`, `prompt.py` copied unchanged, `extract.py`, `summarize.py`, `trace.py`), `runs/<id>` (fresh `--shared` clones of `inputs/<ID>` branch `review`), `sess/<id>` (parent sessions), `out/` (stdout jsonl, stderr, meta, status, prompts, `walls.txt`, `extract-base.jsonl`, `extract-after.jsonl`, `summary.txt`), `gaihome/` (isolated review-mode home), `pkg-after/`, and `FROZEN.sha256`, written after the runs. It holds the input heads, the package heads, and hashes of the tools, prompts and binary.
- Form measured: arm `a`, native RDD (`tools/run-model.sh <ID> a <base>` in the last benchmark).
- Base = the recorded arm-a runs of the last benchmark: `R1-a R2-a R3-a R4-a C1-a S1-a2 S2-a`, not re-run. `S1-a` is excluded as in that report: it was a setup attempt stopped at consent. Their package root was `pkg/`, a clone at main `29b57a414`.
- After = one new run per input. Package root `one-call/pkg-after`, a `--shared` clone of the repository checked out at `234cf3a31` (`feat/review-one-call`). The worktree `.worktrees/review-one-call` has no `.gentle-ai/`, so the native arm cannot run from it, and writing one there was outside the allowed surfaces. That is the same situation and remedy as the last benchmark. `diff -rq` (excluding `.git`, `.gentle-ai`, `node_modules`, `.atl`) found no difference between `pkg-after` and the worktree. `pkg-after/.gentle-ai/v4.4.0/{gentle-ai,integrity.json}` are byte copies from `pkg/` (sha256 `5bb53e7e…` / `ff753c51…`). Both commits pin `INSTALLER_VERSION = "4.4.0"`, `node_modules` links to the main checkout, and `pnpm-lock.yaml` is identical at `29b57a414` and `234cf3a31`.
- Code delta between base and after: `29b57a414..234cf3a31` is 21 main commits up to origin/main `6e61ac3bd` plus the feature commit. The main commits include edits to the four `assets/agents/review-*.md` lens bodies, orchestrator assets and `extensions/gentle-ai.ts`. The feature commit (`6e61ac3bd..234cf3a31`) touches `lib/review-coordinator.ts`, `extensions/gentle-ai.ts`, docs and tests. No run isolated the feature commit from the intervening main commits.
- Launch, after arm (`one-call/tools/run-native.sh <ID> <id> after plain`), run from the run clone:
  `env -i HOME=$HOME PATH=$PATH USER LOGNAME SHELL=/bin/bash LANG=en_US.UTF-8 TERM=dumb TMPDIR=/tmp GENTLE_AI_HOME=one-call/gaihome GENTLE_SHELL_NO_AUTO_SETUP=1 DO_NOT_TRACK=1 GENTLE_AI_TELEMETRY=0 GENTLE_PI_ORCHESTRATOR_MODE=organic GENTLE_SHELL_SKIP_STARTUP_UPDATE=1 timeout 1500 node one-call/pkg-after/bin/gentle-shell.mjs -p --mode json --model openai-codex/gpt-6-astra --thinking medium --session-dir one-call/sess/<id> "<prompt>"`.
  Base arm, as recorded: the same command with root `pkg/`, `GENTLE_AI_HOME=<scratch>/gaihome`, and without `GENTLE_SHELL_NO_AUTO_SETUP=1 DO_NOT_TRACK=1 GENTLE_AI_TELEMETRY=0`. This task required those three variables. They gate auto-setup and telemetry (`bin/gentle-shell.mjs:1583`, `lib/telemetry-trigger.ts:64-65`). No other difference in environment, model, effort, timeout or session handling.
- Models (from the session files): parent `openai-codex/gpt-6-astra`, thinking `medium`, in all 14 sessions. Reviewers `openai/gpt-6.1-sol` in all 62 relay completions (`host_relay`/`reviewer_runs` evidence). The relay evidence does not record effort; the user's routing is `review-*: sol, high`. Two after runs also launched one `gentle-ai-explore` child (`openai/gpt-6.1-terra`, medium); see anomaly 3.
- Prompt: `tools/prompt.py` arm `a`, unchanged. Each after prompt is byte-identical to the base prompt of the same input (`cmp`, including S1 against `S1-a2`). The prompt already contains the advance grant "I, the human, grant consent to review this change: if START returns the native consent envelope, answer it with `gentle_review` operation answer-consent and answer "granted" for its consentBinding, without asking me." No sentence was appended (see Consent).
- Time windows (UTC): base runs 2026-11-10 20:41–22:35. After runs 2026-11-11 08:47:56–09:05:54, one at a time, each awaited. No run hit the 1,500 s timeout; every run exited 0 and left the run clone clean (`git status` empty, HEAD unchanged).
- Review mode, user's real configuration (read-only `gentle-ai review mode status --json`, pinned binary `~/work/gentle-pi/.gentle-ai/v4.4.0/gentle-ai`, cwd the worktree, no `GENTLE_AI_HOME`):
  - before (`one-call/user-mode-before.json`, 2026-11-11T08:47:23Z): `global: off, clone_local: "", effective: off, source: global`.
  - after (`one-call/user-mode-after.json`, 2026-11-11T09:06:01Z): identical apart from the timestamp line (`diff` of the remaining lines is empty).
  - Isolation: before enabling, `GENTLE_AI_HOME=one-call/gaihome` read `global: "", effective: on, source: default` while the real configuration read `off / global`. `review mode enable --scope=global` then ran only with `GENTLE_AI_HOME=one-call/gaihome`. Every after run's meta shows `on / global`, and `~/.gentle-ai/state.json` kept its 2026-11-09 mtime.
- Metrics (`one-call/tools/extract.py`): parent turns, tool calls and tokens come from the parent session's assistant messages. Parent cost is Pi's catalog estimate (`usage.cost.total`, `totalFromProvider: false` everywhere). Reviewer tokens and cost come from `host_relay.reviewer(_runs)` in `gentle_review_capture*` results (base) and from `details.reviewer_runs` in `gentle_review_run` results (after). Child sessions are found through `~/.gentle-shell/agent/gentle-agents/tasks/*.json` by `parentSessionId`. "Review-tool calls" counts direct parent calls to `gentle_review*` tools. The base parents' `codemode` attempts to call `tools.gentle_review`, which failed because that tool does not exist inside codemode, count only under all parent calls. Applied to `R1-a`, the extractor reproduces the last report's parent cost ($1.6049) and relay cost ($0.215). Cache writes were 0 everywhere; the `openai-codex` provider does not report them.

## Per input, base → after

| input | review-tool calls | all parent calls | parent turns | parent input / cache read / output tokens | reviewer runs / tokens | cost parent / reviewers / total $ (estimate) | wall s | outcome | known defects found |
|---|---|---|---|---|---|---|---|---|---|
| R1 | 9 → 5 | 13 → 8 | 14 → 9 | 53,573 / 511,232 / 11,158 → 46,134 / 240,768 / 1,859 | 5 / 79,359 → 5 / 78,962 | 1.605 / 0.215 / 1.820 → 0.795 / 0.214 / 1.009 | 323.5 → 154.1 | correction_required → escalated (`native_stop_required`, `unknown_causality`) | D1 ✓ D2 ✗ → D1 ✓ D2 ✗ |
| R2 | 9 → 5 | 15 → 7 | 16 → 8 | 52,051 / 597,888 / 11,594 → 45,394 / 212,608 / 1,121 | 5 / 126,464 → 5 / 125,013 | 1.698 / 0.328 / 2.026 → 0.723 / 0.319 / 1.041 | 396.8 → 176.4 | correction_required → correction_required | ✗ → ✗ |
| R3 | 8 → 4 | 14 → 8 | 15 → 9 | 41,455 / 529,920 / 10,013 → 30,998 / 225,792 / 943 | 4 / 39,199 → 4 / 39,584 | 1.445 / 0.101 / 1.547 → 0.583 / 0.105 / 0.688 | 337.1 → 96.9 | APPROVED → APPROVED | ✗ → ✗ |
| R4 | 8 → 4 | 12 → 11 | 13 → 12 | 39,955 / 460,288 / 10,342 → 32,130 / 317,824 / 1,411 | 4 / 47,049 → 4 / 46,850 | 1.377 / 0.117 / 1.494 → 0.710 / 0.115 / 0.835 (incl. child 0.010) | 279.7 → 143.4 | APPROVED → APPROVED | ✗ ✗ → ✗ ✗ |
| C1 (clean) | 8 → 4 | 14 → 7 | 15 → 8 | 40,680 / 540,928 / 9,923 → 31,995 / 195,840 / 1,167 | 4 / 32,736 → 4 / 34,526 | 1.444 / 0.091 / 1.534 → 0.574 / 0.109 / 0.683 | 280.7 → 127.1 | APPROVED → APPROVED | 0 blocking → 0 blocking |
| S1 | 9 → 5 | 13 → 7 | 14 → 8 | 58,661 / 595,968 / 11,684 → 48,979 / 231,424 / 1,489 | 5 / 33,065 → 5 / 33,514 | 1.767 / 0.126 / 1.893 → 0.796 / 0.130 / 0.925 | 337.3 → 145.7 | correction_required → correction_required | 4/4 → 4/4 |
| S2 (clean) | 8 → 4 | 13 → 11 | 14 → 12 | 47,617 / 590,208 / 10,088 → 34,942 / 345,472 / 1,537 | 4 / 25,219 → 4 / 26,089 | 1.571 / 0.076 / 1.647 → 0.772 / 0.084 / 0.865 (incl. child 0.009) | 290.5 → 146.4 | APPROVED → APPROVED | 0 blocking → 0 blocking |

Review-tool calls by tool and operation:

- Base, every run: `gentle_review` `inspect` 1, `start` 1, `answer-consent` 1, `status` 2 (C1: 1), and `gentle_review_capture_group` 2 (forecast, then acknowledged resend). Refuter runs (R1, R2, S1) add `gentle_review_capture` 2; approved runs (R3, R4, C1, S2) add `acknowledge-approved` 1. C1 also has `export` 1.
- After, every run: `gentle_review` `inspect` 1, `start` 1, `answer-consent` 1, then `gentle_review_run` once on R3, R4, C1 and S2 and twice on R1, R2 and S1. No after parent called `status`, `gentle_review_capture`, `gentle_review_capture_group` or `acknowledge-approved` itself.
- The remaining parent calls, in both arms, were reads of `.git/gentle-ai`, source files and `git` (`bash`, `read`, `ls`, `codemode`). R4 and S2 after also made `subagent_list_agents`, `orchestrator_session_id` and `subagent_run` calls (anomaly 3).

## Medians and totals (7 inputs)

| metric | base median | after median | Δ median | base total | after total | Δ total |
|---|---|---|---|---|---|---|
| parent review-tool calls | 8 | 4 | −4 (−50.0%) | 59 | 31 | −28 (−47.5%) |
| all parent tool calls | 13 | 8 | −5 (−38.5%) | 94 | 59 | −35 (−37.2%) |
| parent turns | 14 | 9 | −5 (−35.7%) | 101 | 66 | −35 (−34.7%) |
| parent input tokens | 47,617 | 34,942 | −12,675 (−26.6%) | 333,992 | 270,572 | −63,420 (−19.0%) |
| parent cache-read tokens | 540,928 | 231,424 | −309,504 (−57.2%) | 3,826,432 | 1,769,728 | −2,056,704 (−53.7%) |
| parent output tokens | 10,342 | 1,411 | −8,931 (−86.4%) | 74,802 | 9,527 | −65,275 (−87.3%) |
| reviewer runs | 4 | 4 | 0 | 31 | 31 | 0 |
| reviewer tokens | 39,199 | 39,584 | +385 (+1.0%) | 383,091 | 384,538 | +1,447 (+0.4%) |
| parent cost $ (estimate) | 1.571 | 0.723 | −0.848 (−54.0%) | 10.907 | 4.952 | −5.955 (−54.6%) |
| reviewer cost $ (estimate) | 0.117 | 0.115 | −0.002 (−1.3%) | 1.053 | 1.076 | +0.022 (+2.1%) |
| child cost $ (estimate) | 0 | 0 | 0 | 0 | 0.019 | +0.019 |
| total cost $ (estimate) | 1.647 | 0.865 | −0.781 (−47.5%) | 11.960 | 6.046 | −5.913 (−49.4%) |
| wall s | 323.5 | 145.7 | −177.8 (−55.0%) | 2,245.6 | 990.0 | −1,255.6 (−55.9%) |

The parent's share of total cost went from 91.2% to 81.9%. The base parents' output tokens (about 10k per run) went mostly into composing collect-binding arguments for the capture tools. In the after runs, `gentle_review_run` relays those bindings inside the tool.

## Control runs

None. The R1 pilot on the after code, with the unchanged prompt, completed the review (terminal state `escalated`). Following step 1 of the task, all seven after runs used the unchanged prompt, step 2 was skipped, and no sentence was appended. So the base-vs-after difference contains no prompt change. The prepared sentence file `one-call/tools/consent-sentence.txt` was never used.

## Quality (same grading as `review-forms-experiment.md`)

A known defect counts only when a finding names its location and what is wrong.

| input | base (arm a) | after |
|---|---|---|
| R1 | D1 BLOCKER ✓; D2 ✗; R: missing-cwd test, nearest-directory tie | D1 BLOCKER ✓ (risk and reliability corroborated by the refuter; the resilience and readability duplicates failed location verification, and the provider escalated on them); D2 ✗; the same two R as WARNINGs |
| R2 | known ✗; R: npm `json=true` (CRITICAL); A: global Shell reinstall | known ✗; the same R (npm `json=true`, CRITICAL, blocks, refuter-corroborated); the other three lenses reported nothing |
| R3 | ✗ (APPROVED, no findings exposed) | ✗ (APPROVED). One advisory: `R2-setup-correction-budget`, readability, `assets/orchestrator-verification.md:26`, WARNING. That is the known defect's line, but the result carries no description, and the parent wrote that "the precise defect cannot be confirmed". It is not counted. |
| R4 | ✗ ✗ (APPROVED, no findings exposed) | ✗ ✗ (APPROVED; the result has no `advisory_findings` key; an explorer child found no saved reports) |
| C1 (clean) | 0 blocking; A WARNING (test asserts the array, not the prompt) | 0 blocking; the same A WARNING (`tests/child-skills-catalog.test.ts:26-33`); A WARNING on ownership by name (`lib/agents-runner.ts:353-354`, the finding arm c had filed as a blocker) |
| S1 | 4/4; R CSV escaping; A event loop; A retry overwrite | 4/4 (command injection, partial page and rate outage CRITICAL; formatter mutation WARNING); R CSV escaping (CRITICAL, blocks); A retry overwrite |
| S2 (clean) | 0 blocking; A formula injection; A ordering test | 0 blocking; A formula injection; A per-invoice rounding policy; A ordering test |

- Totals: real defects found 1/6 → 1/6 (R1 D1 in both); synthetic 4/4 → 4/4; blockers on clean diffs 0 → 0.
- Reviews that approved a diff with a known defect: R3 and R4 in both arms.

## Consent and forecasts in each after run

| run | consent | `gentle_review_run` calls → outcome | forecasts recorded | `advisory_findings` | parent single operations |
|---|---|---|---|---|---|
| R1 | parent called `answer-consent` `granted` itself, from the prompt's advance grant ("I'm submitting `granted` as you explicitly instructed") | 2: `blocked` (inner `native-reviewer-group-status-reconciled`, next `collect` / `provider_refuter_required`), then `stopped` (`escalated`) | 1 + 1 (4 lenses; refuter) | absent (not approved) | inspect, start, answer-consent |
| R2 | same | 2: `blocked` (same inner outcome), then `input-required` (`correction_required`) | 1 + 1 | absent | same |
| R3 | same | 1: `closed` (`native-approved-acknowledgement-completed`, `delivery: ordinary-repository-policy`) | 1 (4 lenses) | present, 1 finding | same |
| R4 | same | 1: `closed` | 1 | key absent | same |
| C1 | same | 1: `closed` | 1 | present, 2 findings | same |
| S1 | same | 2: `blocked` (same inner outcome), then `input-required` (`correction_required`) | 1 + 1 | absent | same |
| S2 | same | 1: `closed` | 1 | present, 3 findings | same |

- No run returned `consent-required` from `gentle_review_run`: in every run the parent had already run `inspect`, `start` and `answer-consent` itself before calling the run tool with the new `lineageId`. The prompt orders exactly those steps and states the grant as the human's. So these runs do not show what the new guidance does in a headless run without an advance grant; that case was not run.
- No run stopped at a reviewer-model-run forecast. Each forecast came back in the run result's `forecasts`, and a heuristic text search found each parent mentioning it in a later message (1–2 messages per run). The base runs needed 2 parent calls per forecast (capture, then resend with `reviewerRunAcknowledged: true`).
- `advisory_findings` entries carry only `id`, `lens`, `location`, `severity` and `disposition`, never a description. In the base runs R3 and R4 exposed no findings at all.

## Anomalies

1. **`gentle_review_run` stops after a lens group that needs the refuter.** On R1, R2 and S1 the first call returned `outcome: "blocked"`, with the capture result `status: "reconciled"`, `outcome: "native-reviewer-group-status-reconciled"`, and the next transition a `collect` for `provider_refuter_required`. The coordinator accepts only `native-last-event-closure` and `native-reviewer-result-captured` after a capture (`lib/review-coordinator.ts:166-167` at 234cf3a31; the same list is at line 158 at 6e61ac3bd, so this predates the feature). `extensions/gentle-ai.ts:10587` emits `native-reviewer-group-status-reconciled` for a reconciled group. Every parent recovered with a second `gentle_review_run` call on the same lineage. This contradicts S2's "one call drives an ordinary native review" for any review whose lenses report findings that need the refuter. Reported, not fixed. Per run, that is one extra parent call and one extra parent turn.
2. **R1 ended `escalated` instead of `correction_required`.** The provider escalated with `unknown_causality` on two duplicate BLOCKER reports (resilience, readability) whose location verification failed. The risk and reliability reports of the same defect were corroborated. The provider binary (4.4.0) is the same in both arms, but the lens agent bodies changed on main between the two commits. One run cannot tell model variance from that change.
3. **Approved findings without descriptions led to extra parent work.** Because `advisory_findings` has no text, the R4 and S2 parents spent extra calls searching `.git/gentle-ai`, and each launched one `gentle-ai-explore` child to find the descriptions ($0.0098 and $0.0092, included in the totals; the explorer found no saved reports). The C1 and S2 parents rebuilt the explanations by reading source. S2's parent said so in its answer. These are why R4 and S2 still took 11 parent calls and 12 turns.
4. **The parent still answers consent itself in this harness.** The prompt grants consent in advance and orders `answer-consent`, and the parent complied in all 7 runs. That matches the base runs and the last benchmark's anomaly 1. These runs neither confirm nor refute the new consent guidance.
5. **Environment changes required by this task:** `GENTLE_SHELL_NO_AUTO_SETUP=1 DO_NOT_TRACK=1 GENTLE_AI_TELEMETRY=0` were set in the after runs only.
6. **Shared provider:** these runs used the same provider as other sessions (a process count at setup matched 4 `gentle-shell|bin/pi` processes; rough indicator). Base and after ran about 11 hours apart.
7. Failed or excluded runs: none failed. The R1 pilot is the R1 after run: same prompt, same code, completed. Base `S1-a` stays excluded as in the last report.

## Spend

After runs, Pi catalog estimate: $6.046 in total ($4.952 parent, $1.076 reviewers, $0.019 explorer children). No control runs. Cap $20, not reached.

## What the data does not show

- Any rate or variance: n=1 per input and arm, and model variance was not measured. A rerun could flip a single detection, the R1 escalation or a wall time.
- The effect of the feature commit alone: the base ran at `29b57a414`, the after run at `234cf3a31`, and 21 main commits lie between them, including lens-body and orchestrator-asset edits. Reviewer tokens and cost barely moved (+0.4% / +2.1% in total). The parent-side drop matches the `gentle_review_run` call pattern (the capture and status calls left the parent), but no run separated the two code changes.
- How the run behaves without the prompt's advance consent grant, with a UI, or when the coordinator itself starts the review (`assess` → `start` → `consent-required`). Every parent started the review by hand before calling the run.
- Wall-time differences finer than about 15% (the shared-provider noise floor in the last benchmark), and differences caused by the 11-hour gap.
- Cache writes: the provider reports none, so cost excludes them in both arms.
- Any other routing: the parent was `gpt-6-astra` medium and the reviewers were `gpt-6.1-sol` throughout.

## Second pass: `final` arm (4eb357f8b)

The first pass found two problems: refuter reviews took two `gentle_review_run` calls, and approved findings came back without text. L7 and L8 record their fixes. This pass reruns the seven inputs on the fixed code (arm `final`) and adds one probe that is not part of the comparison.

### Setup (second pass)

- Everything new is under `/private/tmp/review-forms-k4o3El/one-call-final/`: `pkg-final/`, `gaihome/`, `runs/`, `sess/`, `out/`, `tools/`, `FROZEN.sha256` (written after the runs) and `user-mode-before.json` / `user-mode-after.json`. Nothing under `one-call/` or the earlier harness was modified.
- Package root: `pkg-final`, a `--shared` clone checked out at `4eb357f8b` (234cf3a31 + ab5f84d01 + 4eb357f8b). It has the same pinned binary copied from `pkg/`: `gentle-ai` sha256 `5bb53e7e…`, `integrity.json` `ff753c51…`. `node_modules` links to the main checkout. `diff -rq -x .git -x .gentle-ai -x node_modules -x .atl <worktree> pkg-final` printed nothing; the worktree was clean at 4eb357f8b.
- Launch: `one-call-final/tools/run-native.sh <ID> <ID>-final final plain`. It is the first-pass script with only the output directory and package root changed. The command, environment (including `GENTLE_SHELL_NO_AUTO_SETUP=1 DO_NOT_TRACK=1 GENTLE_AI_TELEMETRY=0`), model, effort and 1,500 s timeout are those of the after arm.
- Isolation: before enabling, `GENTLE_AI_HOME=one-call-final/gaihome` read `global: "", effective: on, source: default` while the real configuration read `off / global`. `review mode enable --scope=global` then ran only with that home. All 8 runs' meta files show `on / global`.
- Review mode of the user's real configuration (read-only status, same binary and cwd as the first pass): before, 2026-11-11T09:31:44Z: `global: off, clone_local: "", effective: off, source: global`. After, 2026-11-11T09:45:11Z: identical apart from the timestamp line. `~/.gentle-ai/state.json` mtime is still Nov 9.
- Prompts are unchanged. Each `cmp` printed nothing:
  `cmp ../out/R1-a.prompt.txt out/R1-final.prompt.txt`, the same for R2, R3, R4, C1 and S2, and `cmp ../out/S1-a2.prompt.txt out/S1-final.prompt.txt`.
- Time window (UTC): final runs 2026-11-11 09:32:08–09:44:17; consent probe 09:44:23–09:45:02. One run at a time, each awaited. Every run exited 0 with no timeout and left its clone clean.
- Models from the session files: parent `openai-codex/gpt-6-astra` medium; reviewers `openai/gpt-6.1-sol` in all 30 relay completions. No child sessions.
- Metrics: the same `extract.py`. Two changes, both in `one-call-final/tools/extract.py`: a `final` root, and the run-result fields `claims_key` / `claims_n` (`advisory_finding_claims`). The `advisory_findings` count now reads its `findings` list; in the first pass the field was a dict, so that count printed `None`. Three-arm table: `tools/summarize3.py` → `out/summary3.txt`.

### Per input, base / after / final

| input | review-tool calls | `gentle_review_run` calls | all parent calls | parent turns | parent input / cache read / output tokens (final) | reviewer runs / tokens (final) | total $ (estimate) | wall s | outcome (final) | known defects found (final) |
|---|---|---|---|---|---|---|---|---|---|---|
| R1 | 9 / 5 / 4 | 0 / 2 / 1 | 13 / 8 / 6 | 14 / 9 / 7 | 42,180 / 170,624 / 931 | 5 / 78,948 | 1.820 / 1.009 / 0.852 | 323.5 / 154.1 / 131.1 | escalated (`native_stop_required`, `unknown_causality`) | D1 ✓ D2 ✗ |
| R2 | 9 / 5 / 4 | 0 / 2 / 1 | 15 / 7 / 5 | 16 / 8 / 6 | 30,238 / 133,376 / 763 | 4 / 100,556 | 2.026 / 1.041 / 0.731 | 396.8 / 176.4 / 121.5 | APPROVED (no refuter) | ✗ |
| R3 | 8 / 4 / 4 | 0 / 1 / 1 | 14 / 8 / 5 | 15 / 9 / 6 | 30,503 / 132,352 / 776 | 4 / 39,880 | 1.547 / 0.688 / 0.584 | 337.1 / 96.9 / 80.2 | APPROVED | ✗ |
| R4 | 8 / 4 / 4 | 0 / 1 / 1 | 12 / 11 / 4 | 13 / 12 / 5 | 29,770 / 105,728 / 688 | 4 / 46,578 | 1.494 / 0.835 / 0.550 | 279.7 / 143.4 / 62.5 | APPROVED | ✗ ✗ |
| C1 (clean) | 8 / 4 / 4 | 0 / 1 / 1 | 14 / 7 / 4 | 15 / 8 / 5 | 29,882 / 105,600 / 742 | 4 / 33,358 | 1.534 / 0.683 / 0.539 | 280.7 / 127.1 / 83.3 | APPROVED | 0 blocking |
| S1 | 9 / 5 / 4 | 0 / 2 / 1 | 13 / 7 / 7 | 14 / 8 / 8 | 45,340 / 228,096 / 1,071 | 5 / 32,654 | 1.893 / 0.925 / 0.856 | 337.3 / 145.7 / 153.3 | correction_required | 4/4 |
| S2 (clean) | 8 / 4 / 4 | 0 / 1 / 1 | 13 / 11 / 6 | 14 / 12 / 7 | 33,070 / 177,408 / 871 | 4 / 24,937 | 1.647 / 0.865 / 0.625 | 290.5 / 146.4 / 77.7 | APPROVED | 0 blocking |

Final cost split, parent / reviewers (estimate, $): R1 0.639 / 0.213; R2 0.474 / 0.257; R3 0.476 / 0.108; R4 0.438 / 0.112; C1 0.442 / 0.097; S1 0.735 / 0.121; S2 0.552 / 0.073. Child cost was 0 in every final run.

### Medians and totals, base / after / final, with final's differences

| metric | median B / A / F | F − B | F − A | total B / A / F | F − B | F − A |
|---|---|---|---|---|---|---|
| parent review-tool calls | 8 / 4 / 4 | −4 (−50.0%) | 0 (0.0%) | 59 / 31 / 28 | −31 (−52.5%) | −3 (−9.7%) |
| `gentle_review_run` calls | 0 / 1 / 1 | +1 | 0 | 0 / 10 / 7 | +7 | −3 (−30.0%) |
| all parent tool calls | 13 / 8 / 5 | −8 (−61.5%) | −3 (−37.5%) | 94 / 59 / 37 | −57 (−60.6%) | −22 (−37.3%) |
| parent turns | 14 / 9 / 6 | −8 (−57.1%) | −3 (−33.3%) | 101 / 66 / 44 | −57 (−56.4%) | −22 (−33.3%) |
| parent input tokens | 47,617 / 34,942 / 30,503 | −17,114 (−35.9%) | −4,439 (−12.7%) | 333,992 / 270,572 / 240,983 | −93,009 (−27.8%) | −29,589 (−10.9%) |
| parent cache-read tokens | 540,928 / 231,424 / 133,376 | −407,552 (−75.3%) | −98,048 (−42.4%) | 3,826,432 / 1,769,728 / 1,053,184 | −2,773,248 (−72.5%) | −716,544 (−40.5%) |
| parent output tokens | 10,342 / 1,411 / 776 | −9,566 (−92.5%) | −635 (−45.0%) | 74,802 / 9,527 / 5,842 | −68,960 (−92.2%) | −3,685 (−38.7%) |
| reviewer runs | 4 / 4 / 4 | 0 | 0 | 31 / 31 / 30 | −1 (−3.2%) | −1 (−3.2%) |
| reviewer tokens | 39,199 / 39,584 / 39,880 | +681 (+1.7%) | +296 (+0.7%) | 383,091 / 384,538 / 356,911 | −26,180 (−6.8%) | −27,627 (−7.2%) |
| parent cost $ (estimate) | 1.571 / 0.723 / 0.476 | −1.095 (−69.7%) | −0.246 (−34.1%) | 10.907 / 4.952 / 3.755 | −7.151 (−65.6%) | −1.197 (−24.2%) |
| reviewer cost $ (estimate) | 0.117 / 0.115 / 0.112 | −0.004 (−3.7%) | −0.003 (−2.4%) | 1.053 / 1.076 / 0.983 | −0.070 (−6.7%) | −0.093 (−8.6%) |
| child cost $ (estimate) | 0 / 0 / 0 | 0 | 0 | 0 / 0.019 / 0 | 0 | −0.019 |
| total cost $ (estimate) | 1.647 / 0.865 / 0.625 | −1.022 (−62.0%) | −0.240 (−27.8%) | 11.960 / 6.046 / 4.738 | −7.222 (−60.4%) | −1.309 (−21.6%) |
| wall s | 323.5 / 145.7 / 83.3 | −240.2 (−74.3%) | −62.4 (−42.8%) | 2,245.6 / 990.0 / 709.6 | −1,536.0 (−68.4%) | −280.4 (−28.3%) |

The parent's share of total cost was 91.2% / 81.9% / 79.3% in base / after / final. The final total has one fewer reviewer run than after because R2-final was approved without the refuter.

### Run calls, claims and finding-text recovery in each final run

| run | `gentle_review_run` → outcome | facade calls inside | forecasts recorded | `advisory_findings` / `advisory_finding_claims` | extra parent calls for finding text | child |
|---|---|---|---|---|---|---|
| R1 | 1 → `stopped` (`escalated`) | 7 | 2 (4 lenses; refuter) | absent / absent (not approved) | 2: `find .git/gentle-ai`, `read review-state.json` | none |
| R2 | 1 → `closed` | 5 | 1 | 1 finding / 1 claim | none | none |
| R3 | 1 → `closed` | 5 | 1 | 1 / 1 | none | none |
| R4 | 1 → `closed` | 5 | 1 | key absent / key absent (approval with no findings) | none | none |
| C1 | 1 → `closed` | 5 | 1 | 1 / 1 | none | none |
| S1 | 1 → `input-required` (`correction_required`) | 7 | 2 | absent / absent (not approved) | 3: `find .git/gentle-ai`, two `read`s of `review-state.json` | none |
| S2 | 1 → `closed` | 5 | 1 | 1 / 1 | none | none |

- No final run stopped at a forecast. Every forecast came back in `forecasts`, and every parent relayed it in its final text.
- On approved runs the parent quoted the claim text as the finding's description. In the first pass the R4 and S2 parents had launched an explorer for it; no parent did this time.
- Claims are returned only for an approved closure. On the two non-approved runs (R1, S1) the parents still read `.git/gentle-ai/.../review-state.json` to list the findings, as in base and after.
- The remaining non-review calls in R2, R3 and S2 (`git rev-parse`, `git diff --stat`) checked the commit range, not finding text.

### Single `gentle_review` operations before the run, and why

Every final parent called `gentle_review` `inspect`, then `start`, then `answer-consent` (`granted`), and then `gentle_review_run` with the new `lineageId`. The prompt dictates those three steps:

> "Run a native RDD review of exactly that committed range with all four lenses: call `gentle_review` with {"operation":"inspect"}, then START with input {…}. I, the human, grant consent to review this change: if START returns the native consent envelope, answer it with `gentle_review` operation answer-consent and answer "granted" for its consentBinding, without asking me."

The R4 and S2 parents gave this as their reason: "I'll submit your explicit grant for this change" (R4), "I'm submitting your explicit `granted` authorization" (S2). The tool guidance (`extensions/gentle-ai.ts`, `gentle_review_run` `promptGuidelines`) says to prefer the run over single operations, and on `consent-required` to "relay the consent to the human and submit only the human's explicit answer, once, with gentle_review answer-consent". In these runs the prompt's explicit steps were followed ahead of the run's own assess/inspect/START.

### Quality, final arm (same grading)

| input | final |
|---|---|
| R1 | D1 BLOCKER ✓ (four lens reports; three refuter-corroborated, the risk one escalated as location-unverified); D2 ✗; R missing-cwd test (WARNING) |
| R2 | known ✗. APPROVED with one WARNING (A): the reinstall branch does not prove the adjacent Pi peer is re-resolved to latest (`scripts/pi-update.mjs:384-386`). This is close to the base arm's advisory on the global Shell reinstall. The npm `json=true` finding of base and after was not raised. |
| R3 | ✗. APPROVED with one WARNING (A, `assets/orchestrator-verification.md:26`): "if none" could be read as allowing another relaunch after the correction was used. That is the opposite of the key's defect (the lost "automatically" makes the ban absolute). |
| R4 | ✗ ✗ (APPROVED, no findings) |
| C1 (clean) | 0 blocking; A WARNING: tests prove the array is emptied, not the outgoing prompt |
| S1 | 4/4 (shell injection, partial page and rate outage CRITICAL; formatter mutation WARNING); R CSV escaping (WARNING); A event-loop blocking |
| S2 (clean) | 0 blocking; A WARNING: the pagination test does not prove oldest-first ordering |

- Totals, base / after / final: real 1/6 / 1/6 / 1/6 (R1 D1 each time); synthetic 4/4 each; blockers on clean diffs 0 each.
- Approved with a known defect: base R3, R4; after R3, R4; final R2, R3, R4. In base and after, R2 ended `correction_required` on a real-but-unlisted finding (npm `json=true`) that the final lenses did not report. One run cannot tell model variance from the code change here; the lens bodies are identical between after and final (`234cf3a31..4eb357f8b` touches no `assets/`).

### Consent probe (R3, not part of the comparison)

- Prompt diff against `out/R3-final.prompt.txt`: one sentence removed, nothing else.
  `- … "committedOnly":true}. I, the human, grant consent to review this change: if START returns the native consent envelope, answer it with \`gentle_review\` operation answer-consent and answer "granted" for its consentBinding, without asking me. Then follow every native continuation …`
  `+ … "committedOnly":true}. Then follow every native continuation …`
  The removal is done by `tools/drop-consent.py`, which asserts the sentence occurs exactly once.
- Review-tool calls: `gentle_review` `inspect`, then `gentle_review` `start`, which returned `native-review-consent-required`. Nothing else: no `answer-consent`, no `gentle_review_run`, no lineage, no reviewer run. `gentle_review_run` was never called, so it did not return `consent-required`; the consent came from the `start` the prompt asks for.
- The parent stopped and relayed the consent. Its final message begins:
  > "**Blocked: native consent required.** No lineage was created, no mutation occurred, and no reviewers ran. **No findings were produced; this is not a clean-review verdict.** The blocker requires the **user** to resolve consent through the host. No human can answer in this session, so I cannot continue or supply consent myself."
  It then listed reason, benefit, risk (`medium`, 8 files, 39 lines), the `granted` / `declined` choices, the `consentBinding`, and both provider-issued invocations unchanged.
- The same message also claimed: "**Range discrepancy:** START received your exact base commit, but the returned consent invocations name `7fed438c…` instead." `7fed438c0a6a2a4f34e4b67641a27d0f52dfcad1` is the tree of the base commit `116c0e99…` (`git rev-parse 116c0e99…^{tree}` in the run clone), so that claim is wrong.
- Cost $0.381 (estimate), wall 41.5 s, 3 parent turns.

### Anomalies (second pass)

1. R1 ended `escalated` (`unknown_causality`) for the second time. The first pass had the same result; base ended `correction_required`. This time the escalated report is the risk lens's (location unverified), with the other three corroborated.
2. R2-final was approved. Its lenses did not report the npm `json=true` finding that made base and after `correction_required`, so the refuter did not run (4 reviewer runs instead of 5). This accounts for part of R2's lower final cost (reviewer $0.257 vs $0.319). n=1, so this cannot be attributed to the code.
3. The parents still drive `inspect`, `start` and `answer-consent` themselves because the prompt orders them. The one-call path that includes assess/START (`consent-required` from the run itself) was not exercised in any run.
4. The consent probe's "range discrepancy" claim misread the base tree as a different commit (see above).
5. On non-approved reviews (R1, S1) the run result still carries no finding text, so the parent reads the review state file (2–3 extra calls).
6. Failed or excluded runs: none. No retries.

### Spend (second pass)

Pi catalog estimates: the seven final runs cost $4.738 ($3.755 parent, $0.983 reviewers) and the consent probe $0.381, so this pass cost $5.119 in total, against a $12 cap. The two passes together cost $11.165.

### What the data does not show (second pass)

- Everything listed for the first pass still applies: n=1 per input, no variance measured, one routing, a shared provider, cache writes not reported, and the base at `29b57a414` with 21 main commits before the feature.
- Between after and final the only code change is the feature's two fix commits, and the wall-time and cost differences between those two arms (−42.8% and −27.8% median) are single observations. Part of the gap is R2 skipping the refuter, and part is time-of-day; neither was controlled.
- The consent probe is one run on one input. It shows what this parent did with this prompt, not a rate. It also does not exercise `consent-required` from `gentle_review_run`, because the prompt makes the parent call `start` itself.
- Whether the returned claims change detection: the graded results are identical in all three arms.

## Quality validation (M 6e61ac3bd vs F 4eb357f8b)

User: "Si pero válida que la calidad sea la misma o mejor". Arm M is the exact base of the feature branch, so the only code difference between the arms is the feature (`git diff --stat 6e61ac3bd 4eb357f8b`: 11 files, `extensions/gentle-ai.ts`, `lib/review-coordinator.ts`, docs, tests and `odd/`). Runs are repeated and interleaved M, F, M, F.

**Verdict: not established.** Rules 2, 3 and 4 hold. Rule 1 is not established: the reviewers' lens prompts are not recorded as text in either arm, so they could not be compared. What could be compared matches (byte counts, model, relay code), but that does not prove identical inputs. The rule requires all four, so "same or better" is not validated.

The pass was interrupted once (anomaly 1) and stopped at the $25 cap with five planned runs missing (see Spend). n is 2–3 per input.

### Setup

- Root: `/private/tmp/review-forms-k4o3El/one-call-quality/`. It holds `tools/` (`run-native.sh`, `step.sh`, `extract.py`, `findings.py`, `relay.py`, `table.py`, `prompt.py`), `runs/`, `sess/`, `out/`, `analysis/` (`findings.jsonl`, `relay.jsonl`, `table.txt`), `gaihome/`, `FROZEN.sha256`, and `user-mode-before.json` / `user-mode-resume.json` / `user-mode-after.json`. Nothing outside this directory was written.
- **M**: `one-call-quality/pkg-m`, a `--shared` clone at `6e61ac3bd`, plus the same pinned binary copied from `pkg/` (`gentle-ai` `5bb53e7e…`, `integrity.json` `ff753c51…`). On M the parent drives the native review step by step.
- **F**: `one-call-final/pkg-final` at `4eb357f8b`. `diff -rq` against the worktree (now at `1c3d51d9c`) differs only in `odd/tasks/review-one-call-bench.md` and `odd/tasks/review-one-call.md`, which `1c3d51d9c` changed. F also counts the five `final` runs of the second pass (same tree, prompt, models and launch, run 2026-11-11 09:32–09:44).
- Launch: identical to the second pass (`run-native.sh <ID> <id> <m|f> plain`). Same environment including `GENTLE_SHELL_NO_AUTO_SETUP=1 DO_NOT_TRACK=1 GENTLE_AI_TELEMETRY=0`, same parent model `openai-codex/gpt-6-astra` medium, reviewers `openai/gpt-6.1-sol` in all completions, timeout 1,500 s.
- Isolated home `one-call-quality/gaihome`: before enabling it read `on / default` while the real configuration read `off / global`; `review mode enable --scope=global` ran only there, and every run meta shows `on / global`.
- Prompts: every run's prompt is byte-identical to the base prompt of its input (`cmp ../out/<ID>-a.prompt.txt out/<id>.prompt.txt` exited 0; S1 against `S1-a2`), printed by `step.sh` for each run.
- User's real review mode (read-only status, pinned binary, cwd the worktree): before 2026-11-11T12:04:34Z, at resume 13:19:27Z, after 13:22:23Z. All three read `global: off, clone_local: "", effective: off, source: global`. Before and after are identical apart from the timestamp line. `~/.gentle-ai/state.json` mtime is still Nov 9.
- Time window (UTC): runs 12:04–13:17:57. Every run clone is clean with HEAD unchanged (19 of 19).
- Findings come from what the provider recorded, not from the parent's text:
  - correction_required and escalated lineages: `review-state.json` (`admitted_role_results`, `fix_finding_ids`, refuter outcomes, admission downgrades);
  - approved (consumed) lineages: the approved closure's `advisory_findings` as returned to the parent, plus `advisory_finding_claims` on F. On M the closure carries no claim text, because the M facade drops `reviewer_results` (L7), so M advisories have id, lens, location and severity only.
- Relay completeness (`tools/relay.py`): a recorded finding counts as relayed when its id, or its file with an overlapping line, appears in the parent's final message.

### Runs (defect inputs R1–R4, S1; clean inputs only from F `final`)

Columns: tokens are parent input / cache read / output. Relay is blocking / non-blocking recorded / advisory returned, as relayed-of-recorded. Cost is a Pi estimate.

| arm | run | outcome | reviewer runs | reviewer tokens | turns / calls / review calls | tokens | relay | cost $ | wall s |
|---|---|---|---|---|---|---|---|---|---|
| M | R1-m1 | correction_required | 4 lenses + refuter | 78,648 | 14 / 13 / 9 | 52,796 / 501,760 / 11,189 | 4/4, 2/2, — | 1.798 | 385.4 |
| M | R1-m2 | correction_required | 4 + refuter | 78,330 | 14 / 13 / 9 | 37,212 / 521,856 / 11,521 | 4/4, 2/2, — | 1.675 | 334.9 |
| F | R1-f1 | escalated (`unverified_location` downgrade) | 4 + refuter | 79,630 | 7 / 6 / 4 | 42,173 / 171,136 / 1,246 | 3/3, 3/3, — | 0.875 | 132.6 |
| F | R1-f2 | escalated (same) | 4 + refuter | 79,253 | 7 / 6 / 4 | 30,004 / 190,208 / 1,093 | 3/3, 3/3, — | 0.761 | 106.2 |
| F | R1-final | escalated (same) | 4 + refuter | 78,948 | 7 / 6 / 4 | 42,180 / 170,624 / 931 | 3/3, 2/2, — | 0.852 | 131.1 |
| M | R2-m1 | correction_required | 4 + refuter | 125,117 | 13 / 12 / 9 | 94,093 / 416,128 / 11,417 | 1/1, 1/1, — | 2.247 | 400.7 |
| M | R2-m2 | correction_required | 4 + refuter | 126,035 | 14 / 13 / 9 | 52,219 / 508,032 / 11,332 | 1/1, 1/1, — | 1.925 | 394.1 |
| F | R2-f1 | approved | 4 lenses | 102,275 | 6 / 5 / 4 | 44,888 / 175,616 / 735 | —, —, 1/1 | 0.936 | 158.6 |
| F | R2-f2 | approved | 4 lenses | 101,348 | 5 / 4 / 4 | 14,443 / 121,088 / 823 | —, —, 2/2 | 0.572 | 119.9 |
| F | R2-final | approved | 4 lenses | 100,556 | 6 / 5 / 4 | 30,238 / 133,376 / 763 | —, —, 1/1 | 0.731 | 121.5 |
| M | R3-m1 | approved | 4 lenses | 39,474 | 15 / 14 / 8 | 24,357 / 548,992 / 10,003 | —, —, 1/1 | 1.397 | 285.7 |
| M | R3-m2 | approved | 4 lenses | 39,585 | 13 / 12 / 8 | 39,861 / 451,328 / 10,103 | —, —, 1/1 | 1.460 | 287.7 |
| F | R3-f1 | approved | 4 lenses | 39,612 | 6 / 5 / 4 | 14,496 / 148,608 / 702 | —, —, 1/1 | 0.435 | 73.8 |
| F | R3-f2 | approved | 4 lenses | 39,296 | 11 / 10 / 4 | 32,150 / 283,776 / 1,421 | —, —, 0/0 | 0.786 | 120.9 |
| F | R3-final | approved | 4 lenses | 39,880 | 6 / 5 / 4 | 30,503 / 132,352 / 776 | —, —, 1/1 | 0.584 | 80.2 |
| M | R4-m1 | approved | 4 lenses | 46,894 | 13 / 12 / 8 | 39,155 / 444,672 / 9,598 | —, —, 0/0 | 1.432 | 268.6 |
| M | R4-m2 | approved | 4 lenses | 46,916 | 17 / 16 / 8 | 74,696 / 585,984 / 10,029 | —, —, 0/0 | 1.959 | 327.7 |
| F | R4-f1 | approved | 4 lenses | 46,844 | 6 / 5 / 4 | 30,173 / 132,096 / 628 | —, —, 0/0 | 0.581 | 65.0 |
| F | R4-f2 | approved | 4 lenses | 47,507 | 5 / 4 / 4 | 30,047 / 105,600 / 665 | —, —, 1/1 | 0.560 | 61.0 |
| F | R4-final | approved | 4 lenses | 46,578 | 5 / 4 / 4 | 29,770 / 105,728 / 688 | —, —, 0/0 | 0.550 | 62.5 |
| M | S1-m1 | correction_required | 4 + refuter | 32,449 | 13 / 12 / 9 | 52,605 / 491,520 / 11,299 | 6/6, 4/4, — | 1.701 | 333.4 |
| M | S1-m2 | correction_required | 4 + refuter | 32,947 | 15 / 14 / 9 | 105,761 / 531,968 / 11,483 | 6/6, 4/4, — | 2.287 | 362.1 (derived, anomaly 1) |
| F | S1-f1 | correction_required | 4 + refuter | 32,737 | 7 / 6 / 4 | 45,396 / 188,544 / 1,105 | 5/5, 5/5, — | 0.820 | 125.0 |
| F | S1-final | correction_required | 4 + refuter | 32,654 | 8 / 7 / 4 | 45,340 / 228,096 / 1,071 | 5/5, 5/5, — | 0.856 | 153.3 |
| F | C1-final (clean) | approved | 4 lenses | 33,358 | 5 / 4 / 4 | 29,882 / 105,600 / 742 | —, —, 1/1 | 0.539 | 83.3 |
| F | S2-final (clean) | approved | 4 lenses | 24,937 | 7 / 6 / 4 | 33,070 / 177,408 / 871 | —, —, 1/1 | 0.625 | 77.7 |

Medians over the defect-input runs (M n=10, F n=14; Pi estimates for cost):

| metric | M | F |
|---|---|---|
| total cost | $1.749 | $0.746 |
| wall | 334.2 s | 120.4 s |
| parent turns | 14 | 6 |
| parent calls | 13 | 5 |
| review-tool calls | 9 | 4 |
| parent output tokens | 11,244 | 800 |
| reviewer tokens | 46,905 | 47,176 |
| reviewer runs | 5 | 4 |

### Known-defect detections (same grading as the experiment report)

A known defect counts only when a provider-recorded finding names its location and what is wrong.

| defect | M (2 runs) | F (3 runs: final, f1, f2; S1: final, f1) |
|---|---|---|
| R1 D1 conflict markers | 2/2 (BLOCKER) | 3/3 (BLOCKER) |
| R1 D2 forbidden `sdd-` names in docs | 0/2 | 0/3 |
| R2 co-published packages not exempted | 0/2 | 0/3 |
| R3 lost "automatically" | 0/2 | 0/3 |
| R4 D1 verifier `env -i` clause | 0/2 | 0/3 |
| R4 D2 "read only what the follow-up names" | 0/2 | **1/3** (R4-f2, WARNING, `assets/agents/gentle-ai-worker.md:34`) |
| S1 risk (shell injection) | 2/2 | 2/2 |
| S1 reliability (partial page) | 2/2 | 2/2 |
| S1 resilience (swallowed rate failure) | 2/2 | 2/2 |
| S1 readability (formatter mutation) | 2/2 | 2/2 |
| **total** | **10 of 20** | **12 of 26** (pass-only f1/f2: 7 of 16) |

- R3: both M runs recorded one readability WARNING at the key's line (`assets/orchestrator-verification.md:26`; ids `R2-relaunch-eligibility`, `R2-unused-correction-guard`), with no recorded text (see Setup). The parents described it from the source as the "if none, relaunch once" wording. The F advisories at the same line carry text, and that text describes the "if none" ambiguity, not the key's lost "automatically". None is counted, in either arm.
- Real defects outside the key:
  - npm `json=true` (R2): M 2/2, recorded CRITICAL, refuter-corroborated, blocking. F 2/3, recorded as WARNING advisories (R2-f1, R2-f2); R2-final did not record it.
  - Nearest-directory tie and missing-cwd test (R1): both arms.
  - CSV escaping (S1): both arms.
  - Event-loop blocking or overwrite-on-retry (S1): both arms.
- Approved with a known defect: M R3 2/2, R4 2/2. F R2 3/3, R3 3/3, R4 3/3.
- Clean inputs: F 0 false blocks in 2 runs (C1-final, S2-final, one advisory each). M has no clean run in this pass.

### Structural check (R1 and S1, what each reviewer received)

- **Not recorded.** Neither arm records the materialized prompt text. The relay records keep `prompt_bytes`, `subject_hash` (which includes lineage-specific ids), model, usage and cost. Reviewer completions are relay calls, not Pi sessions with transcripts.
- **Lens prompt lengths are identical in every run of both arms**, per lens and input:
  - R1: risk 54,556, resilience 54,570, reliability 54,581, readability 54,602 bytes, in R1-m1, R1-m2, R1-f1, R1-f2 and R1-final;
  - S1: 18,696 / 18,710 / 18,721 / 18,742, in S1-m1, S1-m2, S1-f1 and S1-final;
  - the same holds for R2, R3 and R4 in every run.
  Reviewer model `openai/gpt-6.1-sol` in all 116 lens completions (60 M including the base arm-a runs, 56 F); every one has `stopReason: stop`.
- **Refuter prompt lengths differ from run to run in both arms.** R1: 50,757 and 51,341 (M); 50,380, 50,164 and 50,172 (F). They depend on what that run's lenses found.
- **Code:** `git diff 6e61ac3bd 4eb357f8b` leaves `lib/review-host-relay.ts`, `lib/review-relay-contract.ts`, `lib/review-candidate-view.ts`, `assets/` and `contracts/` unchanged. Its `extensions/gentle-ai.ts` hunks are the approved-closure claim mapping (after reviewers ran) and the `gentle_review_run` registration and forecast handling. The provider binary that materializes prompts is byte-identical in both roots.
- **Result: identity of the lens inputs is not shown.** Equal lengths, the same model and an unchanged relay path are consistent with identical inputs up to lineage ids, but the text was not compared.

### Verdict (the four rules)

1. **Reviewer inputs identical between arms: not established.** Lens prompt byte counts, model and relay code match; the text is not recorded, so it was not compared. Refuter inputs differ per run in both arms.
2. **No known defect found in every M run and in no F run: holds.** The only defects found in every M run (R1 D1 and the four S1 defects) were also found in every F run.
3. **Detection share not lower in F by more than one run's worth: holds.** M found 10 of 20, F 12 of 26. At M's share F would have 13 of 26; the shortfall is 1 detection, and one run's worth at M's share is 1 (2 opportunities per run on average × 0.5). Pass-only F: 7 of 16 against an expected 8; the shortfall is also 1.
4. **Relay completeness not lower in F and no more false blocks than M: holds.**
   - Relay: M relayed 22/22 blocking, 14/14 recorded non-blocking and 2/2 returned advisories. F relayed 19/19, 18/18 and 7/7 (plus 2/2 on clean inputs).
   - False blocks: F had 0 in 2 clean runs, so it cannot have more than M; but M has no clean run in this pass.
   - On approved reviews, M parents could relay only id and location, because the claim text was not returned (R3-m1: "omitted its detailed explanation"). F parents relayed the reviewers' claim text.

Rule 1 is not established, so the rule's conclusion is: **not validated as "same or better"**. Rules 2–4 show no detection, relay or false-block loss in F at these counts.

### Anomalies

1. **Interrupted and resumed.** The parent session closed during S1-m2; the wrapper that records exit code, wall time and clone status was killed.
   - S1-m2's own evidence: its stdout ends with `agent_settled` and `aborted: false`, as in the other runs; the final assistant message (13:17:57Z) is complete; the lineage is `correction_required`; the clone is clean with HEAD unchanged.
   - It is counted as complete. Its wall time (362.1 s) is derived from the session's first and last timestamps, not measured by the wrapper.
   - No re-run was made: S1-m2b was not needed by this evidence.
   - The isolated setup was in a normal state: empty `LOCK` and `state.json.lock` files exist in every run, and no half-written lineage was found.
2. **R1 outcome split by arm.** F ended `escalated` in 3/3 runs, and so did the first-pass pilot on 234cf3a31. M ended `correction_required` in 2/2, and so did the base `R1-a` on 29b57a414.
   - In every escalated run the provider's admission downgraded exactly one lens BLOCKER with reason `unverified_location`; that lens had recorded `causal_disposition: unknown` (locations `:29`, `:29-35`, `:26`).
   - No downgrade occurred in any M or base run.
   - Lens prompt lengths are identical, and the cause is not determined. If outcomes were exchangeable between arms, a 4–0 / 0–3 split would arise by chance with probability 1/35.
3. **R2 outcome split by arm.** M recorded npm `json=true` as CRITICAL (refuter-corroborated) and ended `correction_required` 2/2. F approved 3/3: the lenses recorded the same issue as a WARNING in 2 runs and not at all in 1. The defect is outside the key, so rules 2–3 do not count it, but F approved a diff with a real defect that M blocked.
4. **Parents looking for finding text.** R3-f2 (F, approved with no advisory) and R4-m2 (M) each launched one `gentle-ai-explore` child ($0.0076, $0.0089).
5. **M approved closures carry no claim text** (pre-feature behavior, L7), so M advisories cannot be graded beyond their location.

### Spend

The pass cost $24.207 (Pi estimates, 19 runs: M $17.881 over 10 runs, F $6.326 over 9 runs). The $25 cap stopped further runs. The next planned run, S1-f2, was expected to cost about $0.82–0.86 against $0.79 remaining. Not run:
- S1-f2;
- C1 and S2, one run each on M and on F;
- the optional third M runs.

### Limits

- n = 2 (M) and 2–3 (F) per input. Each detection is still a near-binary observation, and model variance is not measured.
- Clean-input false blocks have no M sample in this pass, and only 2 F runs.
- Rule 1 cannot be decided from records that do not keep the prompt text.
- The F `final` runs were made 2.5 hours earlier than the interleaved runs.
- This pass measures detection and relay only: not authority records, consent behavior (both arms answered consent from the prompt's advance grant) or other routings.

## R1 and R2 repeated (inconclusive)

Question: is the by-arm split of L10 (R1 escalated in F 3/3 vs M 0/2; R2 approved in F 3/3 vs blocked in M 2/2) chance? Same arms, M = 6e61ac3bd and F = 4eb357f8b.

**Verdict for both inputs: inconclusive; no difference between the arms is shown.** Both outcomes now occur in both arms, and the two-sided Fisher exact p is 0.2424 for each input. That does not establish that chance caused the earlier split: with 5 and 6 runs per arm the test cannot rule out a real difference, and the direction in both inputs is against the feature. The pre-stated rule of this pass called this result "chance"; the label below is kept as applied, and it means only "not distinguishable from chance with these counts".

### Setup

- Root: `/private/tmp/review-forms-k4o3El/one-call-quality2/`. It holds `tools/` (`run-native.sh`, `step.sh`, `extract.py`, `lenses.py`, `fisher.py`), `runs/`, `sess/`, `out/`, `analysis/lenses.jsonl`, `gaihome/`, `FROZEN.sha256`, and `user-mode-before.json` / `user-mode-after.json`.
- Package roots, unchanged and used read-only, at the same commits and pinned binary as L10: `one-call-quality/pkg-m` (6e61ac3bd, clean) and `one-call-final/pkg-final` (4eb357f8b, clean). The worktree at 3589defa7 adds only a test and document entries.
- Launch, environment (including the three isolation flags), models and timeout are identical to L10.
- Isolated home: `one-call-quality2/gaihome` read `on / default` before `review mode enable --scope=global` was run in that home only; every run meta shows `on / global`.
- Order, strictly interleaved: R1-M, R1-F, R2-M, R2-F, for three rounds (12 runs, 2026-11-11 13:38–14:27 UTC). All rc=0, no timeouts, no retries, and all 12 clones are clean.
- Prompts: `cmp ../out/R1-a.prompt.txt out/R1-<arm><n>.prompt.txt` and `cmp ../out/R2-a.prompt.txt out/R2-<arm><n>.prompt.txt` exited 0 for all 12 runs.
- A fourth round was not run: three rounds cost $14.888, and a round costs about $5.2 against the $17 cap.
- User's real review mode: before 13:38:09Z and after 14:27:03Z, both `global: off, clone_local: "", effective: off, source: global`, identical apart from the timestamp line.
- **Prompt text: not compared.** No existing, supported option records the materialized reviewer prompt text. There is no debug, trace or dump setting in `lib/review-host-relay.ts`, `lib/review-relay-contract.ts` or the `gentle_review*` code of `extensions/gentle-ai.ts`; the relay's only environment settings are timeouts, the buffer size and the relay contract. The binary's help shows no such flag. None was improvised.

### Per run (this pass)

Columns: outcome; the conflict-marker finding per lens (risk / resilience / readability / reliability) as cited line in `extensions/child-context.ts`, severity and `causal_disposition` (`i` = introduced, `u` = unknown); provider downgrades; reviewer tokens total/reasoning per role; cost (Pi estimate); wall.

| run | outcome | risk | resilience | readability | reliability | downgrade (`unverified_location`) | reviewer tokens total/reasoning | cost $ | wall s |
|---|---|---|---|---|---|---|---|---|---|
| R1-m1 | correction_required | 27 BLOCKER i | 30 BLOCKER i | 30 BLOCKER i | 30 BLOCKER i | none | risk 15,597/633, res 15,955/970, read 16,554/1,292, rel 16,022/893, refuter 15,113/61 | 1.767 | 362.3 |
| R1-f1 | escalated | 30 BLOCKER i | 30 BLOCKER i | 29 BLOCKER u | 27 BLOCKER i | readability | 15,887/895, 15,729/772, 16,091/937, 16,210/1,034, refuter 14,867/60 | 0.903 | 118.7 |
| R1-m2 | escalated | 29 BLOCKER u | 30 BLOCKER i | 30 BLOCKER i | 30 BLOCKER i | risk | 15,757/770, 15,506/516, 16,207/1,034, 16,624/1,372, refuter 14,856/38 | 1.794 | 346.7 |
| R1-f2 | escalated | 30 BLOCKER i | 26 BLOCKER u | 30 BLOCKER i | 30 BLOCKER i | resilience | 15,815/872, 15,369/368, 16,494/1,216, 16,498/1,236, refuter 14,814/57 | 0.707 | 120.8 |
| R1-m3 | escalated | 27 BLOCKER i | 26 BLOCKER u | 26 BLOCKER u | 26 BLOCKER u | resilience, readability, reliability | 15,767/798, 15,355/398, 16,123/1,004, 16,431/1,238, refuter 14,193/0 | 1.931 | 382.6 |
| R1-f3 | correction_required | 30 BLOCKER i | 30 BLOCKER i | 30 BLOCKER i | 30 BLOCKER i | none | 15,854/908, 15,599/635, 16,093/1,034, 16,258/1,142, refuter 15,094/38 | 0.539 | 96.7 |

For R2, the columns are the npm `json=true` finding per lens (severity, location in `scripts/pi-update.mjs`, or "—" when the lens did not report it) and the refuter's result:

| run | outcome | risk | resilience | readability | reliability | refuter | reviewer tokens total/reasoning | cost $ | wall s |
|---|---|---|---|---|---|---|---|---|---|
| R2-m1 | approved (no findings recorded) | — | — | — | — | did not run | risk 24,279/516, res 25,655/1,867, read 24,626/899, rel 25,885/2,070 | 1.800 | 376.7 |
| R2-f1 | approved | — | — | — | — (one WARNING about `tests/pi-update.test.ts:78-79`, not `json`) | did not run | 24,533/723, 24,429/685, 24,703/984, 26,011/2,017 | 0.683 | 135.9 |
| R2-m2 | correction_required (blocked on `json`) | — | — | — | CRITICAL `:303-304` | corroborated | 24,053/285, 25,666/1,895, 24,981/1,245, 26,847/2,908, refuter 23,223/82 | 1.901 | 364.7 |
| R2-f2 | approved | — | WARNING `:303-304` | — | — (WARNING on adjacent peer `:384-387`) | did not run | 24,220/432, 26,998/3,031, 24,755/1,034, 26,747/2,668 | 0.585 | 132.7 |
| R2-m3 | approved | — | WARNING `:303-304` (id `R4-json-view-output`; M closures carry no claim text) | — | — (WARNING on adjacent peer `:384-386`) | did not run | 24,010/224, 25,994/2,070, 24,352/587, 26,502/2,436 | 1.657 | 331.0 |
| R2-f3 | correction_required (blocked on `json`) | — | CRITICAL `:302-303` | — | — | corroborated | 24,485/674, 24,954/1,034, 24,734/1,000, 25,126/1,348, refuter 23,207/58 | 0.624 | 99.0 |

### Pooled same-commit tests

Pooled runs: this pass plus L10's same-commit runs. M: one-call-quality R1-m1, R1-m2, R2-m1, R2-m2. F (4eb357f8b): one-call-quality R1-f1, R1-f2, R2-f1, R2-f2, and one-call-final R1-final, R2-final.

R1, escalated vs not:

| arm | escalated | not escalated |
|---|---|---|
| M (6e61ac3bd) | 2 (q2 R1-m2, R1-m3) | 3 (q R1-m1, R1-m2; q2 R1-m1) |
| F (4eb357f8b) | 5 (q R1-f1, R1-f2; R1-final; q2 R1-f1, R1-f2) | 1 (q2 R1-f3) |

Two-sided Fisher exact p = **0.242424** (`tools/fisher.py`; hypergeometric probabilities for the M-escalated cell x = 1..5: 0.015152, 0.181818, 0.454545, 0.303030, 0.045455; observed x = 2).

R2, blocked on npm `json=true` vs not:

| arm | blocked | not blocked |
|---|---|---|
| M (6e61ac3bd) | 3 (q R2-m1, R2-m2; q2 R2-m2) | 2 (q2 R2-m1, R2-m3) |
| F (4eb357f8b) | 1 (q2 R2-f3) | 5 (q R2-f1, R2-f2; R2-final; q2 R2-f1, R2-f2) |

Two-sided Fisher exact p = **0.242424** (x = 0..4: 0.045455, 0.303030, 0.454545, 0.181818, 0.015152; observed x = 3).

Older trees, not pooled: 29b57a414 R1-a correction_required and R2-a blocked on `json` (two lenses CRITICAL); 234cf3a31 R1-pilot escalated and R2-after blocked on `json`.

Verdict by the rule:
- **R1: "chance" by the pre-stated rule, that is, inconclusive.** Both outcomes occur in both arms, and p = 0.2424 ≥ 0.05.
- **R2: "chance" by the pre-stated rule, that is, inconclusive.** Both outcomes occur in both arms, and p = 0.2424 ≥ 0.05.

### Observations

- **R1 escalation tracks the cited line, in both arms.** Across all 13 R1 runs listed here (11 pooled, 2 on older trees), a conflict-marker finding was downgraded for `unverified_location` exactly when its lens cited line 26, 29 or 29-35 and recorded `causal_disposition: unknown`. Citations of lines 27, 28 and 30 (all `introduced`) were never downgraded. Every run with at least one such citation escalated; every run without one ended `correction_required`.
- **R2 blocks or approves on one lens's severity for the `json` finding.** It blocked when a lens rated it CRITICAL (the refuter then corroborated it) and was approved when the lenses rated it WARNING or did not report it. This happened in both arms.
- **Prompt sizes:** lens prompt byte counts for R1 and R2 are the same as in L10 in all 12 runs, in both arms.

### Anomalies

1. **R1-m3 (M):** the parent captured `review-risk` alone with `gentle_review_capture` (forecast, then acknowledged) before capturing the other three lenses with `gentle_review_capture_group`. So in this run one lens finished before the other three started; every other M run captured all four as one group. The three lenses captured together all cited line 26 with `unknown` and were downgraded.
2. **Explorer launched:** the R2-m1 parent (approved, no findings) launched one `gentle-ai-explore` child ($0.0104) to look for findings.
3. **R2-m3 claim text:** its `json` advisory is identified by id and location only, because M approved closures carry no claim text (L7).

### Spend

$14.888 (Pi estimates; M $10.848 over 6 runs, F $4.040 over 6 runs) against a $17 cap.

### Limits

- n = 5 (M) and 6 (F) per input. p = 0.24 does not show the arms are equal; it shows these counts are compatible with chance.
- Reviewer prompt text was not compared: no supported recording option exists.

## Correction findings in the run result (N 966f97aa6 vs F 4eb357f8b, S1)

User (S7): "antes de pr quiero que hagas bench y compruebes los cambios". Change under test (T11, L15): when a native review ends in a correction request, the `input-required` result of `gentle_review_run` carries `correction_findings` and `correction_finding_claims` at the top level.

Result: in all three N runs the run returned the blocking findings with their claims, and the parent wrote its answer with no further tool call. In the two base runs the parent searched for and read `review-state.json` 2–3 times. Medians, base → N: parent tool calls 6.5 → 4, parent turns 7.5 → 5, total cost $0.838 → $0.696 (−17.0%, Pi estimates), wall 139.2 → 123.0 s. The four planted defects were recorded by the provider in every run of both arms. All blocking findings reached the parent's final message in both arms: paraphrased in base, verbatim in N. No N parent relayed any non-blocking finding. In base every non-blocking finding was relayed, among them planted defect D4 (formatter mutation, WARNING). n = 2 (base) and 3 (N), one input.

### Setup

- Root: `/private/tmp/review-forms-k4o3El/one-call-findings/`, which holds `tools/`, `pkg-n/`, `gaihome/`, `runs/`, `sess/`, `out/`, `analysis/` (`post.jsonl`, `medians.txt`, `findings-<id>.json`, `x-<id>.json`), `FROZEN.sha256` and `user-mode-before.json` / `user-mode-after.json`. Nothing under the earlier pass directories was written; their transcripts, run clones and outputs were only read.
- Tools: copies of `one-call-quality2/tools/` plus `one-call-quality/tools/relay.py`. Three copied files differ from their sources, and only in paths:
  - `run-native.sh`: output directory `one-call-findings`, a single root `n`;
  - `step.sh`: output directory, and extract kind `cf`;
  - `extract.py`: adds the `cf` root.
  `tools/post.py` is new. It reads transcripts, run results and run clones, and records the calls after the run, the run-result keys, the provider-recorded findings (through the unchanged `findings.py`) and relay completeness (the `relay.py` rule, plus a claim-text check).
- **N**: `pkg-n`, a `--shared` clone of the repository checked out at `966f97aa6`, with the same pinned binary copied from `pkg/` (`gentle-ai` `5bb53e7e…`, `integrity.json` `ff753c51…`) and `node_modules` linked to the main checkout. `diff -rq -x .git -x .gentle-ai -x node_modules -x .atl <worktree> pkg-n` printed nothing (exit 0); the worktree was clean at 966f97aa6.
- **Base**: the existing arm F runs of S1 on 4eb357f8b, which were not re-run: `one-call-final` `S1-final` (09:40 UTC) and `one-call-quality` `S1-f1` (12:40 UTC). The same extraction was applied to their transcripts.
- Code delta: `4eb357f8b..966f97aa6` is 34 commits and 69 files, not only T11. It includes the merged #3134–#3136, #3144 (T10), docs changes to `assets/agents/gentle-ai-verify.md` and `assets/orchestrator-verification.md`, design, installer and skill-registry changes, and the `package.json` engines range. T11 itself (`34050930d..966f97aa6`) touches `lib/review-coordinator.ts`, `extensions/gentle-ai.ts` (tool description and guidance), docs and tests. No run isolated T11 from the rest.
- Launch: `tools/step.sh S1 n <k>` → `run-native.sh S1 S1-n<k> n plain`. Command, environment (including `GENTLE_SHELL_NO_AUTO_SETUP=1 DO_NOT_TRACK=1 GENTLE_AI_TELEMETRY=0`), parent model `openai-codex/gpt-6-astra` medium and the 1,500 s timeout are as in L10/L12. Reviewers: `openai/gpt-6.1-sol` in all 15 N completions. No child sessions.
- Prompts: each `cmp` exited 0. The checks were `cmp ../out/S1-a2.prompt.txt out/S1-n<k>.prompt.txt` (from `step.sh`), `cmp out/S1-n1.prompt.txt out/S1-n2.prompt.txt`, `cmp out/S1-n1.prompt.txt out/S1-n3.prompt.txt`, and `cmp` against `one-call-final/out/S1-final.prompt.txt` and `one-call-quality/out/S1-f1.prompt.txt`.
- Isolated home: `one-call-findings/gaihome` read `global: "", effective: on, source: default`. `review mode enable --scope=global` then ran only with that home. Every run meta shows `on / global`.
- Runs: 2026-11-11 19:26:20–19:32:34 UTC, one at a time, each awaited. All three exited 0 with no timeout and no retry, and each clone is clean with HEAD unchanged.
- Lens prompt sizes are identical in all five runs (risk 18,696, resilience 18,710, reliability 18,721, readability 18,742 bytes). Refuter prompt sizes differ per run (15,232 to 16,485).

### Per run

Tokens are the parent's input / cache read / output. Costs are Pi catalog estimates (`totalFromProvider: false`).

| arm | run | `gentle_review_run` calls → outcome | all parent calls | review-tool calls | parent turns | parent tokens | reviewer runs / tokens | cost parent / reviewers / total $ | wall s |
|---|---|---|---|---|---|---|---|---|---|
| base | S1-final | 1 → `input-required` (correction_required) | 7 | 4 | 8 | 45,340 / 228,096 / 1,071 | 5 / 32,654 | 0.735 / 0.121 / 0.856 | 153.3 |
| base | S1-f1 | 1 → `input-required` (correction_required) | 6 | 4 | 7 | 45,396 / 188,544 / 1,105 | 5 / 32,737 | 0.698 / 0.122 / 0.820 | 125.0 |
| N | S1-n1 | 1 → `input-required` (correction_required) | 4 | 4 | 5 | 37,065 / 118,144 / 1,248 | 5 / 33,424 | 0.551 / 0.130 / 0.681 | 125.1 |
| N | S1-n2 | 1 → `input-required` (correction_required) | 4 | 4 | 5 | 37,535 / 118,144 / 1,593 | 5 / 33,050 | 0.573 / 0.123 / 0.696 | 123.0 |
| N | S1-n3 | 1 → `input-required` (correction_required) | 4 | 4 | 5 | 37,517 / 118,400 / 1,627 | 5 / 34,018 | 0.575 / 0.133 / 0.708 | 122.2 |

Every run used the same review-tool calls: `gentle_review` inspect, start and answer-consent (the prompt orders them), then one `gentle_review_run`, which made 7 facade calls and recorded 2 forecasts. The first N run ended in a correction request, as did every other run.

### After the run returned

| run | parent calls after the run result | reads of the review state | child launched | `correction_findings` / `correction_finding_claims` | truncated / omitted |
|---|---|---|---|---|---|
| S1-final | 3: `bash` `find .git/gentle-ai -type f -name '*.json'`, `read` `review-state.json` ×2 | 3 (find + 2 reads) | no | absent / absent (5 ids nested under `result.result.next_transition.correction_request.findings`) | — |
| S1-f1 | 2: `bash` `git rev-parse …; find .git/gentle-ai -type f`, `read` `review-state.json` | 2 (find + read) | no | absent / absent (5 nested) | — |
| S1-n1 | 0 | 0 | no | 5 / 5 | none / none |
| S1-n2 | 0 | 0 | no | 6 / 6 | none / none |
| S1-n3 | 0 | 0 | no | 6 / 6 | none / none |

- Parent turns after the run result: base 4 and 3, N 1, 1 and 1 (the final message).
- In every N run, the `correction_findings` ids equal the provider's `fix_finding_ids` in `review-state.json` and the ids nested in the relayed STATUS envelope. Each `correction_finding_claims` value equals the recorded finding's `claim` byte for byte; none reached the 1,024-byte cut.

### Relay completeness and planted defects

Located means the `relay.py` rule: the finding's id, or its file with an overlapping line, appears in the final message. Verbatim means the whole recorded claim appears in the final message after whitespace and markdown-marker normalization.

| run | blocking: located / verbatim | non-blocking recorded: id in final message | planted defects recorded by the provider | planted defects in the final message |
|---|---|---|---|---|
| S1-final | 5/5 / 0/5 (paraphrased table) | 5/5 (all listed with id, location, severity, "Blocks: No") | 4/4 | 4/4 |
| S1-f1 | 5/5 / 0/5 (paraphrased) | 5/5 | 4/4 | 4/4 |
| S1-n1 | 5/5 / 5/5 | 0/6 | 4/4 | 3/4 (D4 absent) |
| S1-n2 | 6/6 / 6/6 | 0/4 | 4/4 | 3/4 (D4 absent) |
| S1-n3 | 6/6 / 6/6 | 0/6 | 4/4 | 3/4 (D4 absent) |

- Planted defects in every N run, all `introduced`: D1 command injection (risk, CRITICAL); D2 partial page (reliability, CRITICAL); D3 swallowed rate failure (resilience, CRITICAL); D4 formatter mutation (readability `R2-hidden-export-mutation` at `src/export.ts:14-17`, WARNING, plus a reliability WARNING at `src/export.ts:16`). The refuter corroborated every blocking finding.
- D4 and the other WARNINGs are recorded by the provider but are not in the correction request (L15: it holds only the findings to fix), so they are not in `correction_findings`. None of the three N final messages contains "formatAmount", "exported", "CSV" or "event loop", or says that non-blocking findings exist and were not returned. N1 says "All five returned findings are CRITICAL". Some non-blocking findings score "located" under the `relay.py` rule only because they share a file and line with a blocking one (for example `src/rates.ts:19`); by id, 0 were relayed.
- N2 and N3 also printed the two forecasts as a JSON block, which may explain part of the higher output tokens (not measured).

### Medians, base (n=2, mean of the two) vs N (n=3)

| metric | base | N | N − base |
|---|---|---|---|
| `gentle_review_run` calls | 1 | 1 | 0 |
| parent calls after the run | 2.5 | 0 | −2.5 (−100%) |
| state-file reads after the run | 2.5 | 0 | −2.5 (−100%) |
| parent turns | 7.5 | 5 | −2.5 (−33.3%) |
| all parent tool calls | 6.5 | 4 | −2.5 (−38.5%) |
| review-tool calls | 4 | 4 | 0 |
| parent input tokens | 45,368 | 37,517 | −7,851 (−17.3%) |
| parent cache-read tokens | 208,320 | 118,144 | −90,176 (−43.3%) |
| parent output tokens | 1,088 | 1,593 | +505 (+46.4%) |
| reviewer runs | 5 | 5 | 0 |
| reviewer tokens | 32,696 | 33,424 | +729 (+2.2%) |
| parent cost $ (estimate) | 0.716 | 0.573 | −0.143 (−20.0%) |
| reviewer cost $ (estimate) | 0.122 | 0.130 | +0.008 (+6.4%) |
| total cost $ (estimate) | 0.838 | 0.696 | −0.142 (−17.0%) |
| wall s | 139.2 | 123.0 | −16.2 (−11.6%) |

### Anomalies

1. The non-blocking findings, including planted D4, no longer reached the user in N. Base parents found them in the state file and listed them. N parents did not read the state file, and the run result does not carry them.
2. The parent still runs inspect, start and answer-consent itself (prompt-ordered), as in every earlier pass.
3. Failed or excluded runs: none. No retries.

### Spend

N runs: $2.085 (Pi estimates: parent $1.699, reviewers $0.386), against a $5 cap. The base runs were not re-run.

### Real review mode

Read with the read-only status command (pinned binary `~/work/gentle-pi/.gentle-ai/v4.4.0/gentle-ai`, cwd the worktree, no `GENTLE_AI_HOME`):
- before, 2026-11-11T19:25:45Z: `global: off, clone_local: "", effective: off, source: global`;
- after, 2026-11-11T19:32:39Z: the same, and identical to before apart from the timestamp line.

`~/.gentle-ai/state.json` mtime is still Nov 9. `enable` and `disable` were never run against the real configuration.

### What the data does not show

- n = 2 (base) and 3 (N) on one input (S1). No variance was estimated, and the cost and time differences are small-sample medians of Pi estimates. Base and N ran at different times of day (09:40 and 12:40 vs 19:26–19:32 UTC).
- The base-to-N delta contains 33 commits besides T11 (Setup), so the differences are not attributed to T11 alone. The observed mechanism (no state-file read after the run in N, 2–3 in base) is the one T11 targets.
- The escalated outcome is not covered. The provider sends no finding text for it (L15), and S1 did not escalate.
- Approved runs, the other inputs, cut or omitted claims, and a malformed correction request were not exercised.
- Whether the N parent would mention non-blocking findings with different guidance or another input was not tested.

## Non-blocking findings in the run result (P and Q on a23db9f7a, S1)

User (S7): "antes de pr quiero que hagas bench y compruebes los cambios". This pass re-runs the S1 benchmark of L16 with the feature of L18–L19 complete.

- **P** = a23db9f7a with a provider that knows `--non-blocking-findings`: 3 valid runs.
- **Q** = a23db9f7a with the pinned v4.4.0 provider, which refuses the flag: 1 valid run.
- **Base** (S1-final and S1-f1 on 4eb357f8b) and **N** (S1-n1 to n3 on 966f97aa6) are the L16 runs. They were not re-run; the same extraction was applied to their transcripts.

Result:
- In every P run, `gentle_review_run` returned the provider's non-blocking findings with their claims: 2, 5 and 3, the same ids the provider recorded in `review-state.json`, none cut, none left out.
- Every P final message listed them by id, under a heading separate from the findings to correct, together with planted defect D4.
- No P parent read the review state.
- Medians, base → N → P (estimates): total cost $0.838 → $0.696 → $0.708; parent turns 7.5 → 5 → 5; state-file reads after the run 2.5 → 0 → 0; planted defects in the final message 4 → 3 → 4; non-blocking findings in the final message 5 of 5 → 0 → all recorded.
- Q got the provider's refusal once. The STATUS was repeated without the flag, the flag was not sent again, and neither key came back. Like N, its final message had no non-blocking finding and no D4.
- Three of the first four runs overlapped in time and are excluded (anomaly 1). The valid Q run hit a reviewer 503 (anomaly 2).

### Setup

- Root: `/private/tmp/review-forms-k4o3El/one-call-nonblocking/`, holding `gentle-ai-new`, `pkg/`, `bin/`, `gaihome/`, `runs/`, `sess/`, `out/` (with `<id>.argv`), `analysis/` (`post-nb.jsonl`, `medians.txt`), `tools/`, `FROZEN.sha256` and `user-mode-before.json` / `user-mode-after.json`. Earlier pass directories were read only; nothing under them was changed or deleted.
- Provider builds:
  - **P**: `go build -o <root>/gentle-ai-new ./cmd/gentle-ai`, run in the gentle-ai worktree `non-blocking-findings` at e7720e6f4 (sha256 `ac606638…`). `git status` in that worktree was empty after the build.
  - **Q**: the pinned v4.4.0 binary copied from `pkg/` (`5bb53e7e…`, `integrity.json` `ff753c51…`).
- Package root: `pkg/`, a `--shared` clone of the repository at a23db9f7a, with the pinned binary under `.gentle-ai/v4.4.0/` and `node_modules` linked to the main checkout. `diff -rq -x .git -x .gentle-ai -x node_modules -x .atl <worktree> pkg` printed nothing (exit 0).
- How each arm selects its provider. The pinned path verifies the binary against the release digest, so a locally built provider cannot sit there. Both arms therefore use Gentle Shell's dev-binary override, `GENTLE_PI_GENTLE_AI_DEV_BINARY`, pointing at a per-run wrapper `bin/provider-<id>`. The wrapper appends argv and exit code to `out/<id>.argv` and runs the real binary (P: `gentle-ai-new`; Q: the pinned copy). So Q runs the pinned binary but is not resolved through the pinned path.
- Tools: copies of `one-call-findings/tools/`; `run-native.sh`, `step.sh` and `extract.py` differ only in the output directory, the arm (p|q), the wrapper and the override variable. `tools/post-nb.py` is new and read-only.
- Launch otherwise identical to L16: parent `openai-codex/gpt-6-astra` medium; reviewers `openai/gpt-6.1-sol` in every completion; timeout 1,500 s; `GENTLE_SHELL_NO_AUTO_SETUP=1 DO_NOT_TRACK=1 GENTLE_AI_TELEMETRY=0`. Isolated `gaihome` read `on / default` and was enabled globally there only; every run meta shows `on / global`.
- Prompts: `cmp ../out/S1-a2.prompt.txt out/S1-<id>.prompt.txt` exited 0 for all seven runs. All `.prompt.txt` files share one sha256 (`FROZEN.sha256`), the same as the L16 N prompts.
- Runs, UTC: S1-p1 21:06:10–21:08:48; S1-p2, S1-p3 and S1-q1 21:09:06–21:12:38, overlapping; S1-p4 21:14:02–21:16:34; S1-p5 21:16:39–21:18:48; S1-q2 21:18:55–21:24:05. All exited 0 with no timeout, and every clone is clean with HEAD unchanged.

### Per run (valid runs)

Tokens are parent input / cache read / output; costs are Pi catalog estimates. Result bytes is the text of the last `gentle_review_run` result the model received.

| arm | run | `gentle_review_run` calls → last outcome | parent calls | turns | parent tokens | reviewer runs / tokens | cost parent / reviewers / total $ | wall s | result bytes |
|---|---|---|---|---|---|---|---|---|---|
| base | S1-final | 1 → input-required | 7 | 8 | 45,340 / 228,096 / 1,071 | 5 / 32,654 | 0.735 / 0.121 / 0.856 | 153.3 | 17,290 |
| base | S1-f1 | 1 → input-required | 6 | 7 | 45,396 / 188,544 / 1,105 | 5 / 32,737 | 0.698 / 0.122 / 0.820 | 125.0 | 18,017 |
| N | S1-n1 | 1 → input-required | 4 | 5 | 37,065 / 118,144 / 1,248 | 5 / 33,424 | 0.551 / 0.130 / 0.681 | 125.1 | 21,165 |
| N | S1-n2 | 1 → input-required | 4 | 5 | 37,535 / 118,144 / 1,593 | 5 / 33,050 | 0.573 / 0.123 / 0.696 | 123.0 | 23,220 |
| N | S1-n3 | 1 → input-required | 4 | 5 | 37,517 / 118,400 / 1,627 | 5 / 34,018 | 0.575 / 0.133 / 0.708 | 122.2 | 23,654 |
| P | S1-p1 | 1 → input-required | 4 | 5 | 38,617 / 118,400 / 1,914 | 5 / 34,015 | 0.600 / 0.130 / 0.731 | 160.1 | 28,997 |
| P | S1-p4 | 1 → input-required | 4 | 5 | 37,658 / 118,400 / 1,953 | 5 / 31,946 | 0.593 / 0.115 / 0.708 | 155.0 | 24,017 |
| P | S1-p5 | 1 → input-required | 4 | 5 | 37,701 / 118,400 / 1,677 | 5 / 32,182 | 0.579 / 0.116 / 0.696 | 131.4 | 23,998 |
| Q | S1-q2 | 2 → blocked, then input-required | 9 | 10 | 45,033 / 310,272 / 4,401 | 6 / 32,851 | 0.981 / 0.123 / 1.104 | 312.1 | 20,943 (blocked: 3,011) |

Each run's lineage ended `correction_required`.

Run result keys and provider STATUS invocations (from the argv logs; P and Q only):

| run | `correction_findings` / claims | `non_blocking_findings` / claims | truncated / omitted / omitted count | raw set in nested record | STATUS with flag (refused) / without |
|---|---|---|---|---|---|
| S1-p1 | 8 / 8 | 2 / 2 | none | no | 3 (0) / 12 |
| S1-p4 | 5 / 5 | 5 / 5 | none | no | 3 (0) / 12 |
| S1-p5 | 5 / 5 | 3 / 3 | none | no | 3 (0) / 12 |
| S1-q2 | 6 / 6 | absent / absent | — | no | 1 (1, exit 1) / 20 |

- In P, the 3 flagged STATUS calls are the run's facade `status` reads. The parent's direct `inspect` and `start` STATUS calls carried no flag.
- In Q, the one flagged call was the run's first STATUS. It exited 1 and was followed at once by the same STATUS without the flag; no later call carried it.

### Medians, base (n=2, mean of two) / N (n=3) / P (n=3), with P's differences; Q (n=1) for reference

| metric | base | N | P | P − base | P − N | Q |
|---|---|---|---|---|---|---|
| `gentle_review_run` calls | 1 | 1 | 1 | 0 | 0 | 2 |
| parent calls after the last run result | 2.5 | 0 | 0 | −2.5 (−100%) | 0 | 0 |
| reads of review state / `.git/gentle-ai` (whole session) | 2.5 | 0 | 0 | −2.5 (−100%) | 0 | 0 |
| parent turns | 7.5 | 5 | 5 | −2.5 (−33.3%) | 0 | 10 |
| all parent tool calls | 6.5 | 4 | 4 | −2.5 (−38.5%) | 0 | 9 |
| parent input tokens | 45,368 | 37,517 | 37,701 | −7,667 (−16.9%) | +184 (+0.5%) | 45,033 |
| parent cache-read tokens | 208,320 | 118,144 | 118,400 | −89,920 (−43.2%) | +256 (+0.2%) | 310,272 |
| parent output tokens | 1,088 | 1,593 | 1,914 | +826 (+75.9%) | +321 (+20.2%) | 4,401 |
| reviewer tokens | 32,696 | 33,424 | 32,182 | −514 (−1.6%) | −1,242 (−3.7%) | 32,851 |
| parent cost $ (estimate) | 0.716 | 0.573 | 0.593 | −0.124 (−17.3%) | +0.020 (+3.4%) | 0.981 |
| reviewer cost $ (estimate) | 0.122 | 0.130 | 0.116 | −0.006 (−4.6%) | −0.013 (−10.3%) | 0.123 |
| total cost $ (estimate) | 0.838 | 0.696 | 0.708 | −0.130 (−15.6%) | +0.012 (+1.7%) | 1.104 |
| wall s | 139.2 | 123.0 | 155.0 | +15.9 (+11.4%) | +32.0 (+26.0%) | 312.1 |
| run result bytes | 17,654 | 23,220 | 24,017 | +6,364 (+36.0%) | +797 (+3.4%) | 20,943 |

The P−N cost, token and result-size differences are small next to the run-to-run spread within N and within P, and are inconclusive at n=3. The wall-time difference is not attributed to the change: N and P ran hours apart, and part of P's median comes from S1-p1, which ran before the overlapping runs.

### After the run

- **Base**: the parents searched `.git/gentle-ai` and read `review-state.json` (3 and 2 calls).
- **N**: no call after the run result.
- **P**: no call after the run result.
- **Q (S1-q2)**:
  - The first `gentle_review_run` returned `blocked` (anomaly 2).
  - The parent then called `gentle_review` `status`, then `codemode` (which called `gentle_review` status inside it), then `gentle_review_capture` twice (forecast, then acknowledged) for the failed `review-risk` lens.
  - A second `gentle_review_run` returned `input-required`, and the parent wrote its answer with no further call.
  - It never read the review state.

### Relay of non-blocking findings and planted defects

Non-blocking means a finding the provider recorded in `review-state.json` that is not in `fix_finding_ids`. "In final" means its id appears in the parent's final message. A planted defect counts as in final when the final message names it (keywords per defect: injection/shell; pageCount, page count or partial page; rate; formatAmount or `exported`). In every valid run the provider recorded all four planted defects, D4 as WARNINGs.

| run | blocking: located / verbatim | non-blocking recorded | non-blocking in final | separated from findings to correct | D1 | D2 | D3 | D4 in final |
|---|---|---|---|---|---|---|---|---|
| S1-final | 5/5, 0/5 (paraphrased) | 5 | 5 | table column "Blocks: No" | ✓ | ✓ | ✓ | ✓ |
| S1-f1 | 5/5, 0/5 (paraphrased) | 5 | 5 | per-finding blocking flag | ✓ | ✓ | ✓ | ✓ |
| S1-n1 | 5/5, 5/5 | 6 | 0 | — | ✓ | ✓ | ✓ | ✗ |
| S1-n2 | 6/6, 6/6 | 4 | 0 | — | ✓ | ✓ | ✓ | ✗ |
| S1-n3 | 6/6, 6/6 | 6 | 0 | — | ✓ | ✓ | ✓ | ✗ |
| S1-p1 | 8/8, 8/8 | 2 | 2 (claims verbatim 2/2) | "### Blocking" / "### Non-blocking" | ✓ | ✓ | ✓ | ✓ |
| S1-p4 | 5/5, 5/5 | 5 | 5 (5/5 verbatim) | separate non-blocking heading | ✓ | ✓ | ✓ | ✓ |
| S1-p5 | 5/5, 5/5 | 3 | 3 (3/3 verbatim) | separate non-blocking heading | ✓ | ✓ | ✓ | ✓ |
| S1-q2 | 6/6, 6/6 | 5 | 0 | — | ✓ | ✓ | ✓ | ✗ |

In every P run, the ids in `non_blocking_findings` were exactly the provider's recorded non-blocking ids.

### Anomalies

1. **Three runs overlapped; my error.** S1-p2, S1-p3 and S1-q1 were launched in one batch and ran at the same time (21:09:06–21:12:38), against the one-run-at-a-time rule.
   - They are kept on disk and in `post-nb.jsonl` and excluded from every table and median above. They were replaced by S1-p4, S1-p5 and S1-q2, run one at a time.
   - What the excluded runs show:
     - S1-p2 and S1-p3 returned 5/5 non-blocking findings with claims, relayed 5/5 by id, D4 included.
     - S1-q1 got the same single refusal, then no flag.
     - In S1-q1 the `review-reliability` reviewer echoed a wrong `subject_hash` (`binding_mismatch`), so the first run returned `blocked`, and the parent called STATUS and a second run (6 reviewer runs, $0.847, 214.3 s).
2. **S1-q2: reviewer provider 503.** The `review-risk` reviewer completion failed with `OpenAI API error (503): upstream connect error … connection termination`, and the first run returned `blocked` (`pi-host-relay-transport-failure`).
   - The parent recovered inside the session: it captured that lens alone, then made a second run call.
   - That recovery explains Q's 10 turns, 6 reviewer runs, $1.104 and 312.1 s; those numbers do not measure the flag fallback.
   - A harness retry was not made: another Q run (about $0.85) would have passed the $6 cap.
3. **More blocking findings in S1-p1.** It recorded 8 blocking and 2 non-blocking findings; the other runs recorded 5–6 blocking. These are the reviewers' own severities, the same in kind as the L12 variation.
4. **P outputs more text.** P's parent output tokens and result bytes are higher than N's, since the result and the final message now carry the non-blocking findings and their claims.

### Spend

- All 7 runs: $5.514 (Pi estimates: parent $4.635), against a $6 cap.
- Valid runs: P $2.134, Q $1.104.
- Excluded overlapping runs: $2.277.

### Real review mode

Read with the read-only status command (pinned binary `~/work/gentle-pi/.gentle-ai/v4.4.0/gentle-ai`, cwd the worktree, no `GENTLE_AI_HOME`):
- before, 2026-11-11T21:05:35Z: `global: off, clone_local: "", effective: off, source: global`;
- after, 2026-11-11T21:24:14Z: identical apart from the timestamp line.

`~/.gentle-ai/state.json` mtime is still Nov 9. `enable` and `disable` were never run against the real configuration.

### What the data does not show

- Few runs (P 3, Q 1, base 2, N 3) on one input. No variance was estimated, and no difference here is attributed to the change beyond the observed mechanism: no state reads; non-blocking findings and D4 present in P's final messages and absent from N's and Q's.
- The escalated outcome was not exercised live; S1 ends in a correction request. It is covered only by the tests and the verifier's provider runs (L18–L19).
- The valid Q run is dominated by an unrelated reviewer 503, so Q's cost, turns and time do not measure the fallback. Its argv shows the fallback: one refusal, then no flag.
- Commits differ beyond this feature. Base 4eb357f8b, N 966f97aa6 and P/Q a23db9f7a are separated by main merges (L16 setup: 33 commits between base and N; this pass adds the merge of origin/main bc9b438af and L18–L19). The provider in P is a local build of an unreleased change, selected through the dev-binary override.
- Wall time is not comparable across passes: N and P ran hours apart, and S1-p1 ran next to nothing while the overlapping runs did not count.
