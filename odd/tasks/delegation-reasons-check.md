# Delegation reasons check (T11, S13)

Spec: `odd/tasks/cost-speed-painpoints.md`, T11, S13. Investigation only: no source or config changes. Code under test: `.worktrees/bench-after` (main 29b57a414), baseline `.worktrees/bench-baseline` (c09189269). Model `openai-codex/gpt-6-astra` at `medium` in every arm; workers come from the active profile (`openai/gpt-6.1-terra` at `max`). Scratch (kept): `/private/tmp/delegation-check-KGPJRI`. Benchmark sessions read from `/private/tmp/cost-speed-bench-PSQgUo`.

## 1. Why organic delegated in the baseline (6/6) and not after (0/6)

**Cause: the runtime context backstop, triggered by the always-on prompt alone.** The project `AGENTS.md` file-count rule was in the prompt but no parent cited it.

| Phase | First turn context (tokens) | Backstop (15% of 272k) | Notice | Delegated |
|---|---|---|---|---|
| base F1 O1-O3 | 43,794-43,855 | 40,800 | on the **first** tool result (turn 1), every run | 1 `gentle-ai-worker` (terra/max) at turn 4-5 |
| base F2 O1-O3 | 44,202 | 40,800 | first tool result, every run | 1 `gentle-ai-worker` at turn 3-5 |
| after F1 O2-O4, F2 O1-O3 | 29,852-30,344 (max 32.8k-35.2k) | 40,800 | never | none |

In the baseline, the parent context passed the backstop before any work had started. #3095 removed ~69 KB of `project_context` (79,229 → 10,586 B), which is about 14k tokens. After that change, the always-on context sits about 10.8k tokens below the threshold, so the F1 and F2 tasks never reach it.

The runtime notice the baseline parent received, appended to its first tool result (`lib/context-backstop.ts:59`, wired at `extensions/gentle-ai.ts:12833`):

> Context backstop: the parent context measures 43,855 tokens (16% of the 272,000-token context window), at or past the 40,800-token backstop: delegate the next bounded unit that needs several steps (its reads, edits, and checks) with a short handoff, while single small edits and state checks stay inline.

The parent's own reason, verbatim from each handoff:

| Run | Turn | Task given to the worker | Stated reason |
|---|---|---|---|
| base-F1-O1 | 4 | diagnose all three bugs, fix only the first | "Bounded unit due to parent context backstop" |
| base-F1-O2 | 4 | fix only `total_stock` | "Context-backstop delegation" |
| base-F1-O3 | 5 | diagnose all three, fix only the first | "Delegated due runtime context backstop" |
| base-F2-O1 | 4 | the whole LoanDesk feature | "Delegation reason: runtime context backstop" |
| base-F2-O2 | 3 | the whole LoanDesk feature | "Context-backstop trigger delegates this bounded unit, including reading/preparation" |
| base-F2-O3 | 5 | the whole LoanDesk feature (after reading `orchestrator-writer.md`) | "Delegation reason: runtime context backstop fired" |

In F1 the parent then made the two remaining one-line fixes inline, as the notice's "single small edits ... stay inline" allows.

**Sources.** The rule the parent followed is Gentle Shell's own:

- the runtime notice (`lib/context-backstop.ts`);
- mechanism 7 of the orchestrator prompt: "**Context backstop** — when the runtime signals it → delegate the next unit needing several steps." (`assets/orchestrator.md`);
- the Writer rule's reason (b) in `assets/orchestrator-delegation.md`.

Writer admission let the launch through for the same reason: `rejectUndocumentedWriterLaunch` admits a launch once `contextBackstopReached` is true (`lib/bounded-writer-admission.ts:141`).

**Context-file candidates.** These were loaded in the baseline but were not the stated cause:

- `~/work/gentle-pi/AGENTS.md`, `<!-- gentle-ai:agent-routing -->`: "delegate one narrow exploration when understanding needs 4+ files; delegate one writer for 2+ non-trivial files."
- `~/AGENTS.md`: the `<!-- gentle-ai:orchestrator -->` "Agent Teams Lite — Orchestrator Instructions" block and its own `gentle-ai:agent-routing` block.

No parent quoted or paraphrased them. In F1 a single file was edited, so the file-count rule could not even hold. They did contribute indirectly, because they made up most of the ~69 KB that pushed the always-on context past the backstop.

After #3095 only `gentle-ai:engram-protocol` and `gentle-ai:remote-authorization` remain in the primary.

**After phase.** The parent said nothing about routing: no mention of Task Size, the small path, or the Writer rule. Its thinking was summary titles only (0-60 characters per run). It announced plans such as "I’ll fix them individually ... leave tests unchanged" (after-F1-O2) and "I’ll keep loans separate from catalog ownership ... test rejection order" (after-F2-O2) and worked inline.

The exploration-budget notice ("Exploration budget: 4 tracked lookups ... Ongoing discovery needs one configured explorer ... Preparation for an already-understood authorized inline write remains exempt") fired in after-F1-O4 and after-F2-O1/O2/O3, and in base-F1-O1 and base-F2-O1/O2/O3. No parent launched an explorer; both tasks were fully specified, so the exemption applies.

**Were the benchmark tasks below the thresholds?** Yes. F1 is three one-line fixes in one file; F2 is one unit of behavior. Neither has 2+ independent units heavier than a subagent start. Without the inflated prompt, neither reaches the backstop, so working inline is the designed route.

## 2. State of each delegation reason after #3092, #3093, #3095 and #3096

**How the prompts were compared.** The organic primary prompt was rendered with `__testing.buildGentlePrompt("gentleman", …, ["read","bash","edit","write","subagent_run"])`, the call `tests/primary-session-prompt.test.ts` makes, under `env -i` for both trees. The rendered files are in `prompts/organic-bench-{after,baseline}.md` (25,188 vs 25,490 B).

The only differences:

- the `## Identity Contract` pointer was removed;
- the `## Language Boundary` section moved after `## Mechanisms`;
- one memory line was removed.

The Task Size and Mechanisms sections are byte-identical. Among the lazy modules, `orchestrator-delegation.md` and `orchestrator-full-delegation-card.md` changed one word each ("the harness test-first policy's" → "the test-first"). `orchestrator-writer.md` and `orchestrator-verification.md` are unchanged.

The runtime files have no diff between the two commits: `lib/context-backstop.ts`, `lib/bounded-writer-admission.ts`, `lib/verifier-admission.ts`, `lib/exploration-budget.ts`.

Quotes as rendered after:

- **Task Size (unchanged).** "A task is **small** when all three hold: 1. **Understood** … 2. **Contained risk** … 3. **Resumable from the diff** … The number of files, commands or tests, fixes, or a requested `todo` list never decides size. A task is **large** only when the resume test fails (multi-session work, external waits, deliverables the user wants apart (never several features asked at once), requirements compaction could lose); large tasks get ODD tracking and workers only by the Writer rule, else inline."
- **Writer rule (unchanged).** "5. **Writer rule** — never by file count or a large task alone; only for a reason (`orchestrator-writer.md`): 2+ independent units of behavior, each heavier than a subagent start (several minutes of work: several files or roughly 100+ changed lines), launched together in background, else inline; Context backstop. Small module or command changes stay inline, even when independent." The lazy module adds: "Units of about 100 changed lines or less always run inline … The runtime admits writers only for a feature-document task or at the measured context backstop." `orchestrator-writer.md` adds: "With the Background subagent policy on, launch every independent unit in the same turn via `subagent_run` with `mode: "background"` … serial launches void the reason: if units cannot launch together, work inline."
- **Evidence-budget rule (unchanged).** "understanding needs more than one read batch or >~5 sequential lookups → stop and delegate one `gentle-ai-explore`, handoff at most ~2k tokens with `path:line` evidence". Runtime side: `lib/exploration-budget.ts:54` sends the notice after more than 3 lookups or more than 40,000 bytes.
- **Verification rule (unchanged).** "only a named high-risk item (assess `escalate` when RDD is on or unknown) → independent `gentle-ai-verify`; else inline". Runtime admission is in `lib/verifier-admission.ts`.
- **Context backstop (unchanged).** "7. **Context backstop** — when the runtime signals it → delegate the next unit needing several steps."

**Runtime side of the context backstop.**

- **Threshold:** `contextBackstopThreshold` = `min(cap, floor(fraction × contextWindow))`, with cap 150,000 and fraction 0.15. This gives 40,800 for the 272k window. It measures Pi's `ctx.getContextUsage()` for the whole context, **including the always-on system prompt and tools**.
- **When it fires:** sampled at most once per 5 s per session on `tool_result` in the primary only. One notice per crossing, re-armed after dropping below.
- **Per-run override without editing user config:** yes, through the environment variables `GENTLE_PI_CONTEXT_BACKSTOP_TOKENS`, `GENTLE_PI_CONTEXT_BACKSTOP_FRACTION` and `GENTLE_PI_CONTEXT_BACKSTOP_MEASURE_MS` (`lib/context-backstop.ts:14-17`). Writer and verifier admission read the same environment.
- **Tests:**
  - `tests/context-backstop.test.ts`: 11 tests (threshold, env override, unknown tokens, one notice per crossing, children never notified, commit and write results, throttling);
  - `tests/writer-feature-document-admission.test.ts`: admission at the backstop, scales with the window, honors the environment;
  - `tests/full-delegation-notices.test.ts`: notice wording per mode;
  - `tests/odd-routing-contract.test.ts`: the prompt defers to the runtime signal;
  - `tests/gentle-ai-exploration-budget.test.ts`: both notices compose.

**Could #3092, #3093, #3095 or #3096 suppress a legitimate delegation?** Not through rules or runtime: none of them changes a trigger, a threshold or admission.

- #3095 removed the conflicting `AGENTS.md` routing blocks and, as a side effect, lowered the always-on context below the backstop. That ended the false firing, not a legitimate one.
- #3096 changed the `subagent_run` tool description to state the existing admission: "below the context backstop, organic writers without `Spec: odd/tasks/<existing>.md, T<n>` … [are rejected]". This makes an existing block visible before the launch; it does not add one.
- #3092 and #3093 change only child prompts and agent bodies.

## 3. Do the reasons fire when their condition holds (F3, model runs)

**Fixture.** `fixtures/f3` is the `utilkit` package (4 public tests). The task (`fixtures/f3.prompt.txt`) asks for three independent modules: `semver`, `cron` and `calc`. Each has its own tests and doc file, and the files are disjoint. Each unit is about 100-150 lines of reference code, and a model writes about 250-500 lines with tests and docs. The prompt does not mention delegation, subagents or parallelism.

**Validation before the runs:**

- public tests pass on the fixture;
- hidden suites (`hidden/f3`: semver 10, cron 9, calc 9) fail on the fixture (0/28, import errors);
- the reference solution (`reference/f3`) passes 28/28.

**Harness.** `run.sh` uses the same `env -i` discipline as the benchmark, a 2,400 s timeout and no retries. The harness repos are `~/work/gentle-pi/.worktrees/bench-runs/t11-*`. Runs were strictly sequential, one per tool call. Hashes are in `FROZEN.sha256`.

| Run | Wall | Writers delegated | Launch | Parent's stated reason | Allowed edit surfaces | Rejected | Tokens parent / children | Cost parent / children / total | Hidden semver / cron / calc | Outside / commits |
|---|---|---|---|---|---|---|---|---|---|---|
| F3 bare B1 | 236.5 s | — | — | — | — | — | 367,540 / 0 | $1.085 / 0 / **$1.085** | 10/10, 9/9, 9/9 | none / 0 |
| F3 organic O1 | 649.3 s | 1 (calc), turn 14 | single | "Context backstop delegation: implement the next bounded unit" (notice at 41,642 tokens, after turn 11; semver and cron already written inline) | `utilkit/calc.py`, `tests/test_calc.py`, `docs/calc.md` | 0 | 832,747 / 1,507,475 | $2.052 / $0.345 / **$2.397** | 10/10, 9/9, 9/9 | none / 0 |
| F3 organic O2 | 672.5 s | 2 (cron, calc) + 1 continue | **serial**: cron 243 s, then calc 85 s (returned a question about complex results) + continue 172 s | T3 "Implementing three inline changes"; after the backstop (41,548 tokens, after turn 6): "Context backstop delegation; bounded independent unit" | cron trio; calc trio (disjoint) | 0 | 730,095 / 682,906 | $1.815 / $0.339 / **$2.154** | 10/10, 9/9, 9/9 | none / 0 |
| F3 full delegation FD1 | 478.2 s | 3 writers + 1 cleanup worker | **together** (one `codemode` `Promise`, all started 20:45:59; 172 / 214 / 350 s); cleanup 27 s later | "I’ll delegate the three independent modules in parallel" | `utilkit/${name}.py`, `tests/test_${name}.py`, `docs/${name}.md` per unit (disjoint) | 0 | 281,214 / 1,116,774 | $0.904 / $0.515 / **$1.418** | 10/10, 9/9, 9/9 | none / 0 |
| F3 full delegation FD2 | 392.9 s | 3 writers | **together** (all started 21:09:39; 206 / 233 / 292 s) | same sentence as FD1 | same templated per-unit trio (disjoint) | 0 | 335,164 / 1,476,980 | $0.871 / $0.537 / **$1.408** | 10/10, 9/9, 9/9 | none / 0 |

Public tests passed in every run: 20, 31, 43, 64 and 54 tests respectively. FD1's parent asked a worker to remove `__pycache__` that its own test run had created; it reported "cleanup was blocked by worker policy" (ignored, untracked bytecode).

**Full delegation judged by its purpose:**

- **Orchestrator vs worker share:** the orchestrator took 20% / 18.5% of tokens and 64% / 62% of cost. Per token, the orchestrator costs $2.46-3.21 per M and the terra workers $0.23-0.50 per M, roughly 5-10x cheaper.
- **Parallelism:** independent units really ran in parallel in 2/2 runs.
- **Wall time:** sum vs max of writer durations was 736 vs 350 s (FD1) and 731 vs 292 s (FD2). The same launches done one after another would have taken about 860 s and 830 s instead of 478 s and 393 s.
- **Cost vs organic:** full delegation was the cheapest delegating arm on this task (bare, at $1.09, cost less): $1.41 vs $2.15-2.40 for organic. It was 30% above bare ($1.09), with equal hidden quality.

**Organic.** The Writer rule's parallel reason did **not** fire in 2/2 runs, even though its condition holds: three independent units with disjoint surfaces, each well over 100 lines. Both parents started writing inline. Delegation came only from the context backstop, about 10k tokens of work later, and the backstop notice asks for "the next bounded unit". So O1 delegated one unit, and O2 delegated two units one after another. These runs do not show whether the parallel reason fires when the launches are admissible: F3 had no feature document, so below the backstop writer admission would have rejected an organic writer launch (`lib/bounded-writer-admission.ts:141`); neither parent attempted one (0 rejections).

Organic cost 1.5-1.7x full delegation and about 2x bare, with the same quality. The parent carries 40-50k tokens per turn for 17-20 turns.

**Context backstop probe** (`t11-F1-OP1`, organic F1, `GENTLE_PI_CONTEXT_BACKSTOP_TOKENS=31000`, no config edit). The notice appeared after turn 3: "Context backstop: the parent context measures 31,489 tokens (12% of the 272,000-token context window), at or past the 31,000-token backstop: delegate the next bounded unit that needs several steps …". The parent then made the three one-line fixes inline, as the notice's "single small edits … stay inline" allows. It had no next multi-step unit to delegate. 60.8 s, $0.885, tests pass, no commits.

Delegation after the notice on a real multi-step unit is shown by F3 O1 and O2, where the threshold was crossed naturally.

## 4. Verdict per reason

| Reason | Text intact after | Verified to fire | Notes |
|---|---|---|---|
| Context backstop | yes (byte-identical; runtime unchanged) | **yes**: notice in F3-O1/O2 (natural) and F1-OP1 (env probe); delegation followed in O1/O2 | one unit at a time, serial |
| Writer rule, reason (a) parallel units, organic | yes | **no**: 0/2 F3 runs despite the condition holding; not tested with the launches admissible (no feature document, below the backstop) | see regression R1 |
| Writer rule, parallel, full delegation | yes | **yes**: 3 writers launched together in 2/2 | |
| Evidence-budget (explorer) | yes | runtime notice fires (benchmark and F3 runs); explorer launch **not tested**: every task was fully specified, so the exemption applied | needs a discovery-heavy task |
| Verification rule (named high-risk) | yes | **not tested**: no high-risk item in F1/F2/F3 | |
| Task Size | yes | behavior consistent: F3 handled as small, no feature document | |

## 5. Regressions and risks

**None of the four PRs regressed a delegation reason.** The baseline's 6/6 delegation was a false positive of the context backstop: the static prompt alone passed it.

Findings, all pre-existing and not caused by these PRs:

- **R1 — organic cannot launch parallel writers for a small task.**
  - The Writer rule says to launch 2+ heavy independent units together.
  - Task Size makes "several features asked at once" small, so no feature document is created.
  - Writer admission rejects organic writers without a feature-document task below the backstop (`lib/bounded-writer-admission.ts:141`; the `subagent_run` description now says so).
  - In single-shot mode (`-p`, `--mode json`) the background policy is forced off, and `orchestrator-writer.md` ties "launched together" to background mode and says otherwise "work inline". Full delegation shows that several task-mode writers can be launched together from one `codemode` call.
  - Net effect: without a tracked task, organic writer launches are admitted only once the backstop has fired, so the parallel-units reason the user named cannot be acted on before it; in O1 and O2 the launches after the backstop were serial. Whether a parent launches several units together once launches are admitted was not observed.
  - Not tested: interactive or RPC sessions with the background policy on. Below the backstop, admission would still reject untracked organic writers there; at the backstop it admits them and `orchestrator-writer.md` asks for launches together, so these runs do not establish that delegation there stays serial.
- **R2 — the backstop counts the static prompt.** It measures total context, always-on system prompt and tools included. Its effective work headroom therefore moves with prompt size: 0 tokens in the baseline (it fired at turn 1), about 10.8k tokens after #3095. The 15% gate was calibrated (comment at `lib/context-backstop.ts:11-12`) under a different prompt size. Prompt growth or reduction silently changes when organic delegates.
- **Minor.** The exploration-budget notice fires at the 4th lookup on fully specified tasks and is always waived by the exemption, so it is noise in these runs.

## 6. Engram observations created by the runs (throwaway projects)

Seven `mem_save` observations, all parent-side; workers saved none:

| Project | Observations |
|---|---|
| `t11-f3-o1` | 1 (id 27069) |
| `t11-f3-fd1` | 1 (27073) |
| `t11-f3-o2` | 1 (27078) |
| `t11-f3-fd2` | 1 (27079) |
| `t11-f1-op1` | 3 (27080-27082) |

Every harness session also called `mem_current_project` and `mem_search`, and four called `mem_review`.

## Files

Scratch `/private/tmp/delegation-check-KGPJRI`:

- `run.sh` — one model run;
- `fixtures/` — `f3`, `f3.prompt.txt`, and the copied `f1`;
- `hidden/f3`, `reference/f3`, `FROZEN.sha256`;
- `tools/` — `analyze.py`, `summary.py`, `timeline.py`, `ext.py`, `render.mts`, `hidden.sh`;
- `prompts/` — rendered organic prompts for both trees;
- `sess/`, `out/` — sessions, stdout/stderr, status, tests, hidden results, `walls.txt`;
- `runs-bare/`.

Harness run repos: `~/work/gentle-pi/.worktrees/bench-runs/t11-F3-{O1,O2,FD1,FD2}` and `t11-F1-OP1`.
