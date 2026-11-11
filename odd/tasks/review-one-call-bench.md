# Native review in one parent call: benchmark before and after (T5, S7)

User (S7): "Apruebo pero antes de pr quiero que hagas bench y compruebes los cambios, de paso dame la diff en costo y tokens con main base deñ último bench".

Result in one paragraph: on the same seven inputs, prompts and models, the native review on `feat/review-one-call` (234cf3a31) took a median of 4 parent review-tool calls instead of 8. Parent turns fell from 14 to 9, total cost from $1.647 to $0.865 (−47.5%), and wall time from 323.5 s to 145.7 s (−55.0%). Reviewer runs, reviewer tokens and reviewer cost did not change. Detection did not change either: real defects 1/6 → 1/6 (the same R1 D1), synthetic 4/4 → 4/4, no blocker on either clean diff. R3 and R4 were again approved with known defects. `gentle_review_run` closed approved reviews in one call (4 of 7 inputs). On the three reviews that needed the refuter it stopped with `blocked` after the lens group, so the parent had to call it a second time. That stop comes from code this feature did not change (anomaly 1). n=1 per input; every number below is one observation.

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
