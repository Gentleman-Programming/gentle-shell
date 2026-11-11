# Cost and speed benchmark (S8)

Two phases ran on 2026-11-10 with the same harness:

- **base** (T0), 18:30–19:22 UTC, on main `c09189269`.
- **after** (T7), 19:27–20:12 UTC, on main `29b57a414`.

Only the package root changed between them. The "After (T7)" and "Before vs after" sections are at the end of this report.

Scratch (persistent, not deleted): `/private/tmp/cost-speed-bench-PSQgUo`. It contains the README, `run.sh`, `tools/`, the fixtures, the hidden suite, the reference solution, all session files and outputs, `out/base-metrics.json`, `out/after-metrics.json` and `out/compare-base-after.md`.

## Headline, base phase (medians, n=3 per arm and task)

| Task | Arm | Wall s | Time / B | $ total (Pi estimate) | Cost / B | Parent + child calls | Calls / B | Parent + child tokens | Tokens / B |
|---|---|---|---|---|---|---|---|---|---|
| F1 | B bare | 56.8 | 1.00x | 0.290 | 1.00x | 16 | 1.00x | 110,447 | 1.00x |
| F1 | O organic | 153.7 | **2.71x** | 1.251 | **4.32x** | 32 | 2.00x | 833,861 | 7.55x |
| F1 | FD full delegation | 228.6 | **4.02x** | 1.231 | **4.25x** | 45 | 2.81x | 1,027,982 | 9.31x |
| F2 | B bare | 90.9 | 1.00x | 0.346 | 1.00x | 16 | 1.00x | 130,834 | 1.00x |
| F2 | O organic | 228.1 | **2.51x** | 0.999 | **2.89x** | 35 | 2.19x | 674,536 | 5.16x |
| F2 | FD full delegation | 225.0 | **2.48x** | 1.025 | **2.96x** | 34 | 2.12x | 706,510 | 5.40x |

Quality was identical across all 18 runs:

- Public tests passed in every run.
- The hidden acceptance suite passed 18/18 in all 9 F2 runs.
- No run changed a file outside the task, and no run made a commit.
- In full delegation, every edit was made by workers.

What differs between arms is time and cost, not quality.

The Astra-medium parent is about 90–97% of the harness cost: $1.05–1.24 per F1 run and $0.85–0.97 per F2 run. Terra-max workers add $0.04–0.13. The parent carries about 212–214 KB of system prompt plus tool definitions on every turn. Bare Pi carries 19 KB.

## Setup

- **Code under test:** worktree `~/work/gentle-pi/.worktrees/bench-baseline`, detached at origin/main `c091892699589c26f310fa5b6de91536d7d4268f`, package version 4.7.0. Its `node_modules` is a symlink to the main checkout's `node_modules`, which holds `@earendil-works/pi-coding-agent` **1.5.2**.
  - Bare Pi was launched from that root's `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`.
  - The harness was launched with `node <root>/bin/gentle-shell.mjs`, whose bundled CLI resolves to the same package.
  - The isolated home declares no gentle-pi package, so the launcher injects the root's own copy (same mechanism as #1494).
  - The worktree stayed clean throughout.
- **Other versions:** Node v24.14.1, Python 3.14.7, Engram v3.0.0-20261007205017 (shared server), and `gentle-engram@0.4.2`. The home also has `pi-web-access`, `pi-btw` and `pi-claude-bridge`.
- **Home:** `~/.gentle-shell/agent` for every arm. Bare Pi gets it through `PI_CODING_AGENT_DIR`. Super-yolo is preserved: the primary prompt contains `<gentle-super-yolo-session>`.
- **Model:** `--model openai-codex/gpt-6-astra --thinking medium` in every arm. Every parent session records `model_change openai-codex/gpt-6-astra` and `thinking medium`.
- **Workflow mode:** set per run with `GENTLE_PI_ORCHESTRATOR_MODE`. Confirmed in each system prompt:
  - Every O prompt contains `COORDINATOR, not the default executor`.
  - Every FD prompt contains `COORDINATOR in full delegation mode`.
  - B has no orchestrator block.
- **Worker routing:** taken from the active profile `openai-oauth-delegation`. Every child session and every subagent result reports `openai/gpt-6.1-terra` at `max`.
  - `~/.gentle-shell/gentle-ai/profiles.json` was not modified: sha1 `e3b0b88122750d50f7220da96ff3b3f245ff5157` before and after, `active` still `openai-oauth-delegation`.
  - No profile pin was written.
- **Run location:**
  - **Harness arms (O, FD):** each run is a fresh `git init` copy of the fixture under `~/work/gentle-pi/.worktrees/bench-runs/base-<task>-<arm><n>/`. Every O and FD primary session's `project_context` section lists exactly `~/AGENTS.md` (67,088 B including its wrapper tag) and `~/work/gentle-pi/AGENTS.md` (12,253 B), 79,406 B in total. Every worker session lists both files in their stripped child form: 13,230 B and 9,117 B, 22,412 B in total.
  - **Bare arm (B):** stays in `/private/tmp/cost-speed-bench-PSQgUo/runs-bare/`, with no AGENTS.md (empty `project_context`), as the drift reference.
- **Order:** strictly sequential, one model run per tool call, each awaited before the next. Arms were interleaved: F1 B1, O1, FD1, B2, O2, FD2, B3, O3, FD3, then F2 in the same order.
  - Timeouts: 900 s for F1 and 1500 s for F2.
  - All 18 runs exited 0. Every stderr was empty. Nothing timed out and nothing was retried or excluded.

### Exact commands (`run.sh <phase> <package-root> <task> <arm> <n>`)

```bash
CLEAN="env -i HOME=$HOME PATH=$PATH USER=$USER LOGNAME=$USER SHELL=/bin/bash LANG=en_US.UTF-8 TERM=dumb TMPDIR=/tmp"
MODEL=openai-codex/gpt-6-astra; THINK=medium; TO=900   # F1; 1500 for F2
# B (bare Pi + todo)
$CLEAN PI_CODING_AGENT_DIR=$HOME/.gentle-shell/agent timeout $TO node $ROOT/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  -p --mode json --no-extensions -e $ROOT/extensions/gentle-todo.ts --model $MODEL --thinking $THINK --session-dir $S/sess/$id "$PROMPT" </dev/null
# O (organic)
$CLEAN GENTLE_PI_ORCHESTRATOR_MODE=organic GENTLE_SHELL_SKIP_STARTUP_UPDATE=1 timeout $TO node $ROOT/bin/gentle-shell.mjs \
  -p --mode json --model $MODEL --thinking $THINK --session-dir $S/sess/$id "$PROMPT" </dev/null
# FD (full delegation)
$CLEAN GENTLE_PI_ORCHESTRATOR_MODE=full-delegation GENTLE_SHELL_SKIP_STARTUP_UPDATE=1 timeout $TO node $ROOT/bin/gentle-shell.mjs \
  -p --mode json --model $MODEL --thinking $THINK --session-dir $S/sess/$id "$PROMPT" </dev/null
# after each run, in the run repo:
git status --short --untracked-files=all; git rev-parse HEAD   # vs the fixture commit
env -i PATH=$PATH HOME=/private/tmp PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest
tools/hidden.sh <run repo>   # F2 only; PYTHONPATH=<run repo>, cwd = scratch hidden/f2
```

Metrics come from `tools/analyze.py` and `tools/table.py`:

- **Parent:** the `--session-dir` JSONL.
- **Children:** each task record in `~/.gentle-shell/agent/gentle-agents/tasks/*.json` whose `parentSessionId` equals the parent session id points to a child session through its `sessionPath`. A `subagent_continue` reuses the same child session and is counted once.
- **Effective calls:** parent tool calls with each `codemode` script's inner `tools.*(` calls expanded by regex.
- **Bookkeeping:** `todo`, `mem_*`, `gentle_odd_phase` and `orchestrator_session_id`.
- **Cost:** Pi's per-message `usage.cost.total`. `totalFromProvider` is `false` everywhere, so cost is a catalog estimate. Astra and Terra are both priced; no model in these runs was unpriced.

## Tasks

**F1:** the #1494 three-fix fixture (`inventory.py` plus 3 failing tests) and its exact prompt (fix three bugs, track them as a task list, unattended, no commit, short summary).

**F2:** a small Python package, `library/` (`catalog.py` with `normalize_isbn` and `Catalog`), with 5 passing public tests in `tests/test_catalog.py` and a README. The prompt asks for a new `library/loans.py` with a `LoanDesk` class, exported from the package, plus new tests in `tests/test_loans.py`, under 8 numbered rules:

1. ISBN normalization on every method, with messages showing the normalized ISBN.
2. `checkout` returns `day + 14`.
3. Four `ValueError` messages in a stated check order: `unknown ISBN: <isbn>`, `already borrowed: <isbn>`, `loan limit reached: <member>`, `no copies available: <isbn>`. The boundary is that exactly 3 loans are allowed and the fourth is refused. A refused checkout changes nothing.
4. `available`.
5. `return_book` late fee: 25 cents per day, capped at 500, and 0 on the due day.
6. `not on loan: <isbn>`, with no state change.
7. `loans(member)` sorted.
8. Preserved behavior: `Catalog.copies` is unaffected by loans, and copies added later through `Catalog.add` become available.

The prompt ends with the same unattended instructions as F1 (no questions, no commit, short summary). Unlike F1, it does not ask for a task list.

The hidden acceptance suite (scratch `hidden/f2/test_hidden_loans.py`, never copied into a run repo) has 18 test methods covering all 8 rules:

| Rule | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 (preserved) |
|---|---|---|---|---|---|---|---|---|
| Test methods | 2 | 1 | 7 | 1 | 3 | 1 | 1 | 2 |

The suite runs against a run repo through `PYTHONPATH`.

Validation before any model run:

| Check | Result |
|---|---|
| Public tests on the fixture | `OK` (5 tests) |
| Hidden suite on the fixture | fails, `FAILED (failures=1, errors=17)` |
| Reference solution (scratch `reference/f2`), public tests | `OK` |
| Reference solution, hidden suite | 18/18 `OK` |

Frozen hashes (`FROZEN.sha256`, sha256). Fixture hashes cover a manifest of every file's sha256:

| Item | sha256 |
|---|---|
| F1 fixture manifest | `7a529f794719bb3449fa64a394645d1cf60831bcedb9e9274a4e7215bea08e7d` |
| F2 fixture manifest | `94b67ee81ce26c35a8a8c52361007cd7bdc7786f000e68c834cb5a7205911663` |
| F1 prompt | `6441b0bc7193e12484ba749686cdbf1e466d534c658884be5ed2ffa6aa568194` |
| F2 prompt | `9e80f8e3563c93e610bde1f98311311b3ae0522213d386d2440ad5e9e338f5a2` |
| Hidden suite | `0cc989e83d7128ab8ea5fa7df9bf94f5c2f20fcc7b5b157aad5bf4bdb37efcd8` |
| Reference `loans.py` | `8226c8d641bb1d14cfa1b0618898b52cca27147d457578bf4b3277916e9b5dc0` |

Fixtures and the hidden suite are read-only in scratch.

## Per-run results

Column notes:

- **Subagents:** role, then child sessions / successful rounds.
- **mem_\*:** parent calls + child calls.
- **Edits P/C:** `edit` and `write` calls in the parent / in children.

| Run | Wall s | Parent turns | Eff calls parent | Child calls | Subagents | Rejected | Parent tok in/out/cache/total | Child tok total | $ parent | $ child | $ total | mem_* P+C | todo | BK-only turns | Public | Hidden | Outside | Commit | Edits P/C | Reports checks |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| F1-B1 | 57.0 | 17 | 16 | 0 | – | 0 | 9,662 / 866 / 101,760 / 112,288 | 0 | 0.242 | 0 | 0.242 | 0+0 | 5 | 5 | OK (3) | – | 0 | no | 3/0 | yes |
| F1-O1 | 296.6 | 15 | 19 | 14 | worker 1/1 | 0 | 48,837 / 1,546 / 644,736 / 695,119 | 138,742 | 1.210 | 0.041 | 1.251 | 5+1 | 4 | 7 | OK (3) | – | 0 | no | 2/1 | yes |
| F1-FD1 | 232.4 | 13 | 19 | 26 | worker 1/3 | 0 | 50,377 / 1,503 / 564,864 / 616,744 | 400,940 | 1.144 | 0.087 | 1.231 | 4+3 | 4 | 4 | OK (3) | – | 0 | no | 0/3 | yes |
| F1-B2 | 50.8 | 16 | 15 | 0 | – | 0 | 16,263 / 822 / 85,760 / 102,845 | 0 | 0.289 | 0 | 0.289 | 0+0 | 5 | 5 | OK (3) | – | 0 | no | 3/0 | yes |
| F1-O2 | 153.7 | 14 | 18 | 10 | worker 1/1 | 0 | 48,216 / 1,488 / 601,984 / 651,688 | 132,948 | 1.159 | 0.035 | 1.193 | 4+1 | 4 | 5 | OK (3) | – | 0 | no | 2/1 | yes |
| F1-FD2 | 228.6 | 11 | 20 | 35 | worker 1/3 | 0 | 49,784 / 1,576 / 473,344 / 524,704 | 515,096 | 1.050 | 0.093 | 1.143 | 5+3 | 6 | 5 | OK (3) | – | 0 | no | 0/3 | yes |
| F1-B3 | 56.8 | 17 | 16 | 0 | – | 0 | 16,530 / 861 / 93,056 / 110,447 | 0 | 0.301 | 0 | 0.301 | 0+0 | 5 | 5 | OK (3) | – | 0 | no | 3/0 | yes |
| F1-O3 | 151.9 | 16 | 17 | 15 | worker 1/1 | 0 | 48,049 / 1,360 / 686,080 / 735,489 | 175,237 | 1.235 | 0.045 | 1.279 | 4+1 | 4 | 8 | OK (3) | – | 0 | no | 2/1 | yes |
| F1-FD3 | 215.3 | 14 | 17 | 26 | worker 1/3 | 0 | 50,147 / 1,350 / 612,224 / 663,721 | 364,261 | 1.181 | 0.069 | 1.250 | 2+3 | 4 | 6 | OK (3) | – | 0 | no | 0/3 | yes |
| F2-B1 | 89.2 | 17 | 16 | 0 | – | 0 | 8,754 / 2,784 / 119,296 / 130,834 | 0 | 0.346 | 0 | 0.346 | 0+0 | 6 | 6 | OK (12) | 18/18 | 0 | no | 3/0 | yes |
| F2-O1 | 229.1 | 7 | 12 | 22 | worker 1/1 | 0 | 51,272 / 1,444 / 281,344 / 334,060 | 340,476 | 0.866 | 0.132 | 0.999 | 4+2 | 0 | 3 | OK (16) | 18/18 | 0 | no | 0/3 | yes |
| F2-FD1 | 244.6 | 8 | 14 | 24 | worker 1/1 | 0 | 56,463 / 1,594 / 329,344 / 387,401 | 439,414 | 0.974 | 0.128 | 1.101 | 3+1 | 0 | 2 | OK (18) | 18/18 | 0 | no | 0/6 | yes |
| F2-B2 | 91.2 | 18 | 17 | 0 | – | 0 | 18,698 / 2,861 / 119,552 / 141,111 | 0 | 0.450 | 0 | 0.450 | 0+0 | 6 | 6 | OK (14) | 18/18 | 0 | no | 4/0 | yes |
| F2-O2 | 215.3 | 6 | 11 | 24 | worker 1/1 | 0 | 55,028 / 1,418 / 227,712 / 284,158 | 376,270 | 0.849 | 0.128 | 0.976 | 4+1 | 0 | 2 | OK (23) | 18/18 | 0 | no | 0/4 | yes |
| F2-FD2 | 225.0 | 7 | 14 | 20 | worker 1/1 | 0 | 55,103 / 1,431 / 280,576 / 337,110 | 369,400 | 0.903 | 0.122 | 1.025 | 3+1 | 0 | 3 | OK (16) | 18/18 | 0 | no | 0/5 | yes |
| F2-B3 | 90.9 | 15 | 14 | 0 | – | 0 | 8,929 / 2,942 / 102,912 / 114,783 | 0 | 0.339 | 0 | 0.339 | 0+0 | 4 | 4 | OK (14) | 18/18 | 0 | no | 3/0 | yes |
| F2-O3 | 228.1 | 8 | 13 | 25 | worker 1/1 | 0 | 51,794 / 1,566 / 324,736 / 378,096 | 382,572 | 0.921 | 0.111 | 1.032 | 4+1 | 0 | 3 | OK (17) | 18/18 | 0 | no | 0/4 | yes |
| F2-FD3 | 175.3 | 6 | 14 | 19 | worker 1/1 | 0 | 55,428 / 1,412 / 232,064 / 288,904 | 299,289 | 0.857 | 0.096 | 0.953 | 3+1 | 0 | 2 | OK (17) | 18/18 | 0 | no | 0/4 | yes |

"Reports checks" means the final answer states the test result, for example `All 18 tests pass with python3 -m unittest`. Cache-write tokens were 0 in every session.

Parent `mem_*` calls by name:

| Run | Parent `mem_*` calls |
|---|---|
| F1-O1 | `mem_current_project`, `mem_search`, `mem_save` ×2, `mem_session_summary` |
| F1-O2 | `mem_current_project`, `mem_search`, `mem_save` ×2 |
| F1-O3 | `mem_current_project`, `mem_search`, `mem_save` ×2 |
| F1-FD1 | `mem_current_project`, `mem_search`, `mem_review`, `mem_save` |
| F1-FD2 | `mem_current_project`, `mem_search`, `mem_save` ×3 |
| F1-FD3 | `mem_current_project`, `mem_search` |
| F2-O1, F2-O2 | `mem_current_project`, `mem_search`, `mem_review`, `mem_save` |
| F2-O3 | `mem_current_project`, `mem_search`, `mem_review`, `mem_session_summary` |
| F2-FD1–3 | `mem_current_project`, `mem_search`, `mem_save` |

Every worker called `mem_save` 1–3 times.

Subagent launches:

- Every O and FD run launched exactly one `gentle-ai-worker` session.
- F1-FD runs used `subagent_run` plus 2 `subagent_continue`, one per fix (sequential fixes, not corrections).
- Every other harness run used a single `subagent_run`.
- No run launched an explore or verify agent, and no launch was rejected.
- Correction rounds: 0 in every run.

## Medians and ratios vs B

### F1

| Metric (median) | B | O | O/B | FD | FD/B |
|---|---|---|---|---|---|
| Wall s | 56.8 | 153.7 | 2.71x | 228.6 | 4.02x |
| Parent turns | 17 | 15 | 0.88x | 13 | 0.76x |
| Effective calls, parent | 16 | 18 | 1.12x | 19 | 1.19x |
| Child calls | 0 | 14 | – | 26 | – |
| Calls parent + child | 16 | 32 | 2.00x | 45 | 2.81x |
| Parent tokens in / out / cacheRead | 16,263 / 861 / 93,056 | 48,216 / 1,488 / 644,736 | – | 50,147 / 1,503 / 564,864 | – |
| Parent tokens total | 110,447 | 695,119 | 6.29x | 616,744 | 5.58x |
| Child tokens in / out / cacheRead | – | 19,839 / 3,063 / 115,840 | – | 48,069 / 4,327 / 348,544 | – |
| Child tokens total | 0 | 138,742 | – | 400,940 | – |
| Tokens parent + child | 110,447 | 833,861 | 7.55x | 1,027,982 | 9.31x |
| $ parent | 0.290 | 1.210 | 4.18x | 1.144 | 3.95x |
| $ child | 0 | 0.041 | – | 0.087 | – |
| **$ total** | **0.290** | **1.251** | **4.32x** | **1.231** | **4.25x** |
| `mem_*` (parent) | 0 | 4 | – | 4 | – |
| `todo` | 5 | 4 | – | 4 | – |
| Bookkeeping-only turns | 5 | 7 | – | 5 | – |
| Subagent time (s, share of wall) | 0 | 70.6 (43–65%) | – | 152.0 (65–70%) | – |

### F2

| Metric (median) | B | O | O/B | FD | FD/B |
|---|---|---|---|---|---|
| Wall s | 90.9 | 228.1 | 2.51x | 225.0 | 2.48x |
| Parent turns | 17 | 7 | 0.41x | 7 | 0.41x |
| Effective calls, parent | 16 | 12 | 0.75x | 14 | 0.88x |
| Child calls | 0 | 24 | – | 20 | – |
| Calls parent + child | 16 | 35 | 2.19x | 34 | 2.12x |
| Parent tokens in / out / cacheRead | 8,929 / 2,861 / 119,296 | 51,794 / 1,444 / 281,344 | – | 55,428 / 1,431 / 280,576 | – |
| Parent tokens total | 130,834 | 334,060 | 2.55x | 337,110 | 2.58x |
| Child tokens in / out / cacheRead | – | 36,910 / 14,269 / 324,480 | – | 36,324 / 13,298 / 316,672 | – |
| Child tokens total | 0 | 376,270 | – | 369,400 | – |
| Tokens parent + child | 130,834 | 674,536 | 5.16x | 706,510 | 5.40x |
| $ parent | 0.346 | 0.866 | 2.50x | 0.903 | 2.61x |
| $ child | 0 | 0.128 | – | 0.122 | – |
| **$ total** | **0.346** | **0.999** | **2.89x** | **1.025** | **2.96x** |
| `mem_*` (parent) | 0 | 4 | – | 3 | – |
| `todo` | 6 | 0 | – | 0 | – |
| Bookkeeping-only turns | 6 | 3 | – | 2 | – |
| Subagent time (s, share of wall) | 0 | 170.4 (72–79%) | – | 170.2 (73–76%) | – |

## Prompt bytes per turn (first system message; identical across runs of an arm)

| Session | Sections total | preamble | tools (text) | rules | docs | addendum | project_context | skills | cwd | mcp_servers | Tool definitions (JSON) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B primary | 14,384 | 126 | 348 | 1,390 | 1,293 | 716 | 0 | 10,441 | 70 | – | 4,861 (5 tools) |
| O primary | 160,917 | 126 | 2,064 | 4,826 | 1,293 | 56,809 | 79,406 | 15,749 | 81 | 563 | 53,382 (60 tools) |
| FD primary | 158,498 | 126 | 2,064 | 4,826 | 1,293 | 54,642 | 79,406 | 15,749 | 82 | 310 | 53,382 (60 tools) |
| `gentle-ai-worker` child (O and FD) | 57,885 | 126 | 164 | 232 | 1,293 | 17,585 | 22,412 | 15,749 | 81 | 243 | 6,198 (8 tools) |

O `mcp_servers` was 563 B in F1-O1 and 310 B in F2-O1.

Per turn, by this transcript method, the primary carries about 214 KB (O) or 212 KB (FD), against 19 KB for B, and a worker carries 64 KB. These totals are estimates: the tool-definition column lists every registered tool and is an upper bound on what is sent (L37; see the final phase). No session recorded a system-prompt patch after the first message.

- **Project context (primary):** `~/AGENTS.md` 67,088 B and `~/work/gentle-pi/AGENTS.md` 12,253 B. In the worker they are 13,230 B and 9,117 B, already stripped by `lib/child-context-files.ts`.
- **Skills:** the `skills` section is 15,749 B in both primary and worker.
- **Second skill catalog:** the primary addendum also carries a new `## Effective session skills` table of 25,511 B, a second skill catalog that was not present in #1494's addendum (#1494 organic addendum: 31,146 B; now 56,809 B). The rest of the addendum is nearly unchanged:

| Addendum part | Bytes |
|---|---|
| Authorized work continuity | 14,183 |
| Orchestrator block (core role through Safety) | ~9,600 |
| `<gentle-super-yolo-session>` | 1,958 |
| Todo list | 737 |
| gentle-engram protocol | ~2,790 |

- **Engram protocol:** it reaches the primary through `~/AGENTS.md`, the project `AGENTS.md`, and the gentle-engram addendum.

## Quality

| Task / arm | Public tests | Hidden acceptance (F2) | Files outside task | Commit | Edits made by | Final answer reports checks |
|---|---|---|---|---|---|---|
| F1 B | 3/3 runs OK | – | 0 | none | parent | 3/3 |
| F1 O | 3/3 runs OK | – | 0 | none | parent 2 fixes + worker 1 fix (every run) | 3/3 |
| F1 FD | 3/3 runs OK | – | 0 | none | worker only (parent 0 edits) | 3/3 |
| F2 B | 3/3 runs OK (12–14 tests) | 18/18, 18/18, 18/18 | 0 | none | parent | 3/3 |
| F2 O | 3/3 runs OK (16–23 tests) | 18/18, 18/18, 18/18 | 0 | none | worker only (parent 0 edits) | 3/3 |
| F2 FD | 3/3 runs OK (16–18 tests) | 18/18, 18/18, 18/18 | 0 | none | worker only (parent 0 edits) | 3/3 |

Files changed:

- F1: only `M inventory.py`.
- F2: only `M library/__init__.py`, `?? library/loans.py` and `?? tests/test_loans.py`.

Untracked `__pycache__/` from the models' own test runs is ignored. HEAD equals the fixture commit in every run.

## Engram

Harness runs wrote **36 observations in 12 throwaway projects**:

| Project | Observations |
|---|---|
| `base-f1-o1` | 4 |
| `base-f1-o2` | 3 |
| `base-f1-o3` | 3 |
| `base-f1-fd1` | 4 |
| `base-f1-fd2` | 6 |
| `base-f1-fd3` | 3 |
| `base-f2-o1` | 3 |
| `base-f2-o2` | 2 |
| `base-f2-o3` | 2 |
| `base-f2-fd1` | 2 |
| `base-f2-fd2` | 2 |
| `base-f2-fd3` | 2 |

Counts are from `engram projects list`. The bare arm wrote none. These projects were not deleted.

## Anomalies

1. **Organic delegated in all 6 runs.** In #1494, organic ran inline: parent `gpt-6.1-sol`/low, run in `/tmp` without `AGENTS.md`. Here every O run launched a terra-max `gentle-ai-worker`.
   - On F1 the parent fixed 2 bugs itself and delegated 1.
   - On F2 the worker did all the work.
   - As a result, O is 2.5–2.7x B in wall time and costs about the same as FD.
2. **Engram protocol from `AGENTS.md` runs in every harness session.** All 12 harness parents opened with `mem_current_project` + `mem_search`. 4 also called `mem_review` and 2 called `mem_session_summary`. None of this was requested by the task.
3. **F1-O1 outlier:** 296.6 s, with a 192.7 s worker. The other two O runs took 153.7 s and 151.9 s. It counts in the median, which is unaffected.
4. **Cost is not comparable with #1494.** The B arm here runs Astra medium ($0.24–0.45 per run), while #1494's B ran sol-low ($0.036).
5. **Parent input tokens are flat.** The parent's uncached input is about 48–56k tokens in every harness run, about 3–6x B. It is the first turn's full system prompt plus tools, about 212 KB. Later turns are mostly cache reads.

## Caveats

1. n=3 per arm and task, two tasks, one orchestrator model.
2. **Provider load:** during the baseline, other delegated writers (T1, T3) used the same provider account (L6). Bare runs were interleaved as the drift reference. B F1 ranged 50.8–57.0 s and B F2 89.2–91.2 s, so drift was small.
3. **B differs in location as well as harness:** it runs in `/private/tmp` without `AGENTS.md`. It measures bare Pi, not "Gentle Shell without `AGENTS.md`".
4. **Costs are Pi catalog estimates** (`totalFromProvider: false`), not billed amounts.
5. **Wall time includes startup:** it covers the whole launcher process, including Gentle Shell startup and Engram.
6. **`codemode` calls are expanded by regex** over script text. They appear in the parent counts as effective calls.
7. **Run repos are retained:** the repos in `~/work/gentle-pi/.worktrees/bench-runs/` are kept for inspection. `.worktrees/` is already untracked in the main checkout.

## Re-run for the after phase (T7)

The after phase changes one parameter: the package root.

1. Prepare a worktree at main with the merged tasks. Symlink its `node_modules` to the main checkout's, and confirm it holds Pi 1.5.2.
2. Run the loop, one run per tool call, awaited:

   ```bash
   S=/private/tmp/cost-speed-bench-PSQgUo; ROOT=<after worktree>
   for t in F1 F2; do for n in 1 2 3; do for a in B O FD; do $S/run.sh after $ROOT $t $a $n; done; done; done
   ```

3. Build the tables:

   ```bash
   python3 -B $S/tools/table.py after > $S/out/after-tables.md
   ```

The scratch README has the details. Keep the profile, the home and the model flags unchanged. Run ids are prefixed by phase, so the base data stays intact.

## After (T7)

### Setup

- **Code under test:** worktree `~/work/gentle-pi/.worktrees/bench-after`, detached at origin/main `29b57a414e2c980a129074dbfb0114ce169df1a0`, with the same `node_modules` symlink. It includes four merged tasks on top of the baseline:
  - #3093: generic children get no skills catalog.
  - #3092: agent guidance.
  - #3095: the primary filters context files and dedupes the Engram protocol.
  - #3096: orchestrator prompt diet.

  The range also contains #3091 (new NaN models). No arm here uses NaN.
- **Preconditions, checked before any model run:**
  - Pi `@earendil-works/pi-coding-agent` is 1.5.2.
  - `profiles.json` sha1 is `e3b0b88122750d50f7220da96ff3b3f245ff5157`, the same as in the baseline, with `active` still `openai-oauth-delegation`.
- **Everything else unchanged:** same `run.sh`, model `openai-codex/gpt-6-astra` at `medium`, timeouts, fixtures and frozen hashes, home and `env -i`.
  - Harness run repos live under `~/work/gentle-pi/.worktrees/bench-runs/after-*`.
  - Bare runs live in `runs-bare/` in scratch.
- **Provider load:** no other agent used the provider during this phase.
- **Order:** F1 B1, O1 (concurrent, see below), then B4, O4, FD1, B2, O2, FD2, B3, O3, FD3, then F2 B1, O1, FD1, B2, O2, FD2, B3, O3, FD3. Every run exited 0 with empty stderr. Nothing timed out or was retried.

**Concurrency incident.** I issued `after-F1-B1` and `after-F1-O1` in one tool batch by mistake, so they ran **concurrently**: both started at 19:27:51Z.

- The parent chose to keep them as labeled concurrent extras outside the medians.
- Sequential replacements `after-F1-B4` and `after-F1-O4` were added.
- F1 medians use B2–B4 and O2–O4.

This is the same kind of incident as in the #1494 benchmark (B5/AF2/AF3), handled the same way. O1 did not delegate either, like every other organic run in this phase.

```bash
python3 -B $S/tools/table.py after --exclude after-F1-B1,after-F1-O1 > $S/out/after-tables.md
python3 -B $S/tools/compare.py base after --exclude after-F1-B1,after-F1-O1 > $S/out/compare-base-after.md
```

### Evidence that the after code ran

Checked on the first O session (after-F1-O1, confirmed again on O4) and the first FD session (after-F1-FD1) before the rest of the matrix.

- **Primary project context:** 10,622 B, down from 79,406.
  - `~/AGENTS.md` keeps 1,440 B, and its only managed block is `gentle-ai:remote-authorization`.
  - `~/work/gentle-pi/AGENTS.md` keeps 9,117 B, and its only managed block is `gentle-ai:engram-protocol` (8,997 B).
  - Dropped from the primary: `gentle-ai:orchestrator` and `gentle-ai:agent-routing` in both files, and the home `gentle-ai:engram-protocol` copy.
- **Worker system prompt:** the `skills` section is absent. Project context is 10,622 B (the same two blocks), down from 22,412.
- **Language Boundary:** the full-delegation primary contains `## Language Boundary`.
- **Primary per turn (transcript method):** sections 91,215 B (O) and 89,165 B (FD); tool definitions 53,552 B (60 tools, an upper bound on what is sent) in both.

### Per-run results

The columns mean the same as in the baseline table. Rows in *italics* are the concurrent extras, excluded from the medians.

| Run | Wall s | Parent turns | Eff calls parent | Child calls | Subagents | Rejected | Parent tok in/out/cache/total | Child tok total | $ parent | $ child | $ total | mem_* P+C | todo | BK-only turns | Public | Hidden | Outside | Commit | Edits P/C | Reports checks |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| *F1-B1 (concurrent)* | 47.9 | 17 | 16 | 0 | – | 0 | 14,367 / 852 / 95,104 / 110,323 | 0 | 0.281 | 0.000 | 0.281 | 0+0 | 5 | 5 | OK (3) | – | 0 | no | 3/0 | yes |
| *F1-O1 (concurrent)* | 74.4 | 17 | 19 | 0 | – | 0 | 33,895 / 1,156 / 503,680 / 538,731 | 0 | 0.900 | 0.000 | 0.900 | 4+0 | 4 | 7 | OK (3) | – | 0 | no | 3/0 | yes |
| F1-B4 | 47.4 | 16 | 15 | 0 | – | 0 | 22,528 / 822 / 79,744 / 103,094 | 0 | 0.346 | 0.000 | 0.346 | 0+0 | 5 | 5 | OK (3) | – | 0 | no | 3/0 | yes |
| F1-O4 | 61.9 | 17 | 21 | 0 | – | 0 | 34,927 / 1,253 / 506,880 / 543,060 | 0 | 0.919 | 0.000 | 0.919 | 6+0 | 4 | 7 | OK (3) | – | 0 | no | 3/0 | yes |
| F1-FD1 | 221.2 | 11 | 21 | 26 | worker 3/3 | 0 | 36,469 / 1,953 / 343,808 / 382,230 | 183,733 | 0.806 | 0.061 | 0.868 | 7+0 | 4 | 4 | OK (3) | – | 0 | no | 0/3 | yes |
| F1-B2 | 58.2 | 16 | 15 | 0 | – | 0 | 13,090 / 827 / 90,496 / 104,413 | 0 | 0.263 | 0.000 | 0.263 | 0+0 | 5 | 5 | OK (3) | – | 0 | no | 3/0 | yes |
| F1-O2 | 61.2 | 15 | 20 | 0 | – | 0 | 33,500 / 1,286 / 443,264 / 478,050 | 0 | 0.843 | 0.000 | 0.843 | 6+0 | 4 | 5 | OK (3) | – | 0 | no | 3/0 | yes |
| F1-FD2 | 373.4 | 10 | 20 | 40 | worker 3/3 | 0 | 39,146 / 1,923 / 304,000 / 345,069 | 281,170 | 0.792 | 0.180 | 0.972 | 6+0 | 4 | 3 | OK (3) | – | 0 | no | 0/3 | yes |
| F1-B3 | 48.9 | 17 | 16 | 0 | – | 0 | 16,289 / 865 / 93,440 / 110,594 | 0 | 0.300 | 0.000 | 0.300 | 0+0 | 5 | 5 | OK (3) | – | 0 | no | 3/0 | yes |
| F1-O3 | 52.2 | 12 | 20 | 0 | – | 0 | 33,124 / 1,192 / 346,240 / 380,556 | 0 | 0.737 | 0.000 | 0.737 | 6+0 | 4 | 2 | OK (3) | – | 0 | no | 3/0 | yes |
| F1-FD3 | 246.1 | 12 | 19 | 29 | worker 3/3 | 1 | 34,813 / 1,717 / 355,072 / 391,602 | 209,092 | 0.789 | 0.073 | 0.862 | 3+0 | 4 | 4 | OK (3) | – | 0 | no | 0/3 | yes |
| F2-B1 | 99.0 | 18 | 17 | 0 | – | 0 | 12,718 / 2,914 / 125,184 / 140,816 | 0 | 0.398 | 0.000 | 0.398 | 0+0 | 6 | 6 | OK (14) | 18/18 | 0 | no | 4/0 | yes |
| F2-O1 | 91.8 | 10 | 14 | 0 | – | 0 | 35,887 / 3,039 / 298,880 / 337,806 | 0 | 0.810 | 0.000 | 0.810 | 4+0 | 0 | 1 | OK (13) | 18/18 | 0 | no | 3/0 | yes |
| F2-FD1 | 205.3 | 6 | 15 | 23 | worker 1/1 | 0 | 40,261 / 1,383 / 168,576 / 210,220 | 244,381 | 0.640 | 0.088 | 0.728 | 4+0 | 0 | 1 | OK (13) | 18/18 | 0 | no | 0/4 | yes |
| F2-B2 | 82.3 | 15 | 14 | 0 | – | 0 | 16,645 / 2,771 / 96,256 / 115,672 | 0 | 0.401 | 0.000 | 0.401 | 0+0 | 4 | 4 | OK (13) | 18/18 | 0 | no | 3/0 | yes |
| F2-O2 | 99.7 | 8 | 14 | 0 | – | 0 | 36,071 / 2,870 / 231,936 / 270,877 | 0 | 0.736 | 0.000 | 0.736 | 4+0 | 0 | 1 | OK (16) | 18/18 | 0 | no | 3/0 | yes |
| F2-FD2 | 333.9 | 6 | 15 | 25 | worker 1/1 | 0 | 41,244 / 1,439 / 169,600 / 212,283 | 338,122 | 0.654 | 0.146 | 0.800 | 3+0 | 0 | 1 | OK (20) | 18/18 | 0 | no | 0/5 | yes |
| F2-B3 | 90.0 | 16 | 15 | 0 | – | 0 | 5,820 / 2,816 / 115,072 / 123,708 | 0 | 0.314 | 0.000 | 0.314 | 0+0 | 4 | 4 | OK (13) | 18/18 | 0 | no | 4/0 | yes |
| F2-O3 | 90.7 | 10 | 13 | 0 | – | 0 | 34,432 / 3,040 / 299,904 / 337,376 | 0 | 0.796 | 0.000 | 0.796 | 3+0 | 0 | 2 | OK (15) | 18/18 | 0 | no | 3/0 | yes |
| F2-FD3 | 267.0 | 7 | 14 | 21 | worker 1/1 | 0 | 41,553 / 1,500 / 201,344 / 244,397 | 254,928 | 0.692 | 0.135 | 0.826 | 3+0 | 0 | 1 | OK (18) | 18/18 | 0 | no | 0/4 | yes |

Subagent launches:

- **F1 FD:** each run launched **three fresh `subagent_run` workers**, one per fix, instead of the baseline's 1 run + 2 `subagent_continue`.
- **F1-FD3 had 1 rejected launch.** Its first `subagent_run` was refused at admission with "Writer tasks must include the exact Markdown heading `## Allowed edit surfaces` …". The parent relaunched with the heading.
- **F2 FD:** one worker per run.
- No explore or verify agent was launched. Correction rounds: 0 in every run.
- No organic run (0 of 4, including the extra O1) launched a subagent.

### Medians and ratios vs B (after)

#### F1

| Metric (median) | B | O | O/B | FD | FD/B |
|---|---|---|---|---|---|
| Wall s | 48.9 | 61.2 | 1.25x | 246 | 5.03x |
| Parent turns | 16 | 15 | 0.94x | 11 | 0.69x |
| Eff calls parent | 15 | 20 | 1.33x | 20 | 1.33x |
| Child calls | 0 | 0 | – | 29 | – |
| Calls parent+child | 15 | 20 | 1.33x | 48 | 3.20x |
| Parent tokens | 104,413 | 478,050 | 4.58x | 382,230 | 3.66x |
| Child tokens | 0 | 0 | – | 209,092 | – |
| Tokens parent+child | 104,413 | 478,050 | 4.58x | 600,694 | 5.75x |
| $ parent | 0.2996 | 0.8426 | 2.81x | 0.7916 | 2.64x |
| $ child | 0 | 0 | – | 0.0727 | – |
| $ total | 0.2996 | 0.8426 | 2.81x | 0.8675 | 2.90x |
| mem_* parent | 0 | 6 | – | 6 | – |
| todo | 5 | 4 | 0.80x | 4 | 0.80x |
| BK-only turns | 5 | 5 | 1.00x | 4 | 0.80x |
| Subagent s | 0 | 0 | – | 178 | – |

#### F2

| Metric (median) | B | O | O/B | FD | FD/B |
|---|---|---|---|---|---|
| Wall s | 90 | 91.8 | 1.02x | 267 | 2.97x |
| Parent turns | 16 | 10 | 0.62x | 6 | 0.38x |
| Eff calls parent | 15 | 14 | 0.93x | 15 | 1.00x |
| Child calls | 0 | 0 | – | 23 | – |
| Calls parent+child | 15 | 14 | 0.93x | 38 | 2.53x |
| Parent tokens | 123,708 | 337,376 | 2.73x | 212,283 | 1.72x |
| Child tokens | 0 | 0 | – | 254,928 | – |
| Tokens parent+child | 123,708 | 337,376 | 2.73x | 499,325 | 4.04x |
| $ parent | 0.3981 | 0.7962 | 2.00x | 0.654 | 1.64x |
| $ child | 0 | 0 | – | 0.1345 | – |
| $ total | 0.3981 | 0.7962 | 2.00x | 0.8 | 2.01x |
| mem_* parent | 0 | 4 | – | 3 | – |
| todo | 4 | 0 | 0.00x | 0 | 0.00x |
| BK-only turns | 4 | 1 | 0.25x | 1 | 0.25x |
| Subagent s | 0 | 0 | – | 208 | – |

For F1, B is the median of B2–B4 and O is the median of O2–O4.

## Before vs after

All values are medians, n=3 per arm and task.

- **Change:** (after − before) / before.
- **Before / B and After / B:** each phase's ratio against its own bare-arm median.
- **Tokens:** the sum of parent and children, by type. Cache-write tokens were 0 throughout.
- **Cost:** Pi's catalog estimate.

### Headline

| Task | Arm | Wall s before → after | Change | $ total before → after | Change | Time / B before → after | Cost / B before → after |
|---|---|---|---|---|---|---|---|
| F1 | B | 56.8 → 48.9 | −14% | 0.290 → 0.300 | +3% | – | – |
| F1 | O | 153.7 → 61.2 | **−60%** | 1.251 → 0.843 | **−33%** | 2.71x → 1.25x | 4.32x → 2.81x |
| F1 | FD | 228.6 → 246.1 | **+8%** | 1.231 → 0.868 | **−30%** | 4.02x → 5.03x | 4.25x → 2.90x |
| F2 | B | 90.9 → 90.0 | −1% | 0.346 → 0.398 | +15% | – | – |
| F2 | O | 228.1 → 91.8 | **−60%** | 0.999 → 0.796 | **−20%** | 2.51x → 1.02x | 2.89x → 2.00x |
| F2 | FD | 225.0 → 267.0 | **+19%** | 1.025 → 0.800 | **−22%** | 2.48x → 2.97x | 2.96x → 2.01x |

### Full metrics

#### F1

| Arm | Metric | Before | After | Change | Before / B | After / B |
|---|---|---|---|---|---|---|
| B | Wall s | 56.8 | 48.9 | -14% | – | – |
| B | $ total | 0.289 | 0.300 | +3% | – | – |
| B | $ parent | 0.289 | 0.300 | +3% | – | – |
| B | $ children | 0.000 | 0.000 | – | – | – |
| B | Eff calls parent+children | 16 | 15 | -6% | – | – |
| B | Eff calls parent | 16 | 15 | -6% | – | – |
| B | Calls children | 0 | 0 | – | – | – |
| B | Tokens input (P+C) | 16,263 | 16,289 | +0% | – | – |
| B | Tokens output (P+C) | 861 | 827 | -4% | – | – |
| B | Tokens cacheRead (P+C) | 93,056 | 90,496 | -3% | – | – |
| B | Tokens total (P+C) | 110,447 | 104,413 | -5% | – | – |
| O | Wall s | 153.7 | 61.2 | -60% | 2.71x | 1.25x |
| O | $ total | 1.251 | 0.843 | -33% | 4.32x | 2.81x |
| O | $ parent | 1.210 | 0.843 | -30% | 4.18x | 2.81x |
| O | $ children | 0.041 | 0.000 | -100% | – | – |
| O | Eff calls parent+children | 32 | 20 | -38% | 2.00x | 1.33x |
| O | Eff calls parent | 18 | 20 | +11% | 1.12x | 1.33x |
| O | Calls children | 14 | 0 | -100% | – | – |
| O | Tokens input (P+C) | 68,676 | 33,500 | -51% | 4.22x | 2.06x |
| O | Tokens output (P+C) | 4,609 | 1,253 | -73% | 5.35x | 1.52x |
| O | Tokens cacheRead (P+C) | 760,576 | 443,264 | -42% | 8.17x | 4.90x |
| O | Tokens total (P+C) | 833,861 | 478,050 | -43% | 7.55x | 4.58x |
| FD | Wall s | 228.6 | 246.1 | +8% | 4.02x | 5.03x |
| FD | $ total | 1.231 | 0.868 | -30% | 4.25x | 2.90x |
| FD | $ parent | 1.144 | 0.792 | -31% | 3.95x | 2.64x |
| FD | $ children | 0.087 | 0.073 | -17% | – | – |
| FD | Eff calls parent+children | 45 | 48 | +7% | 2.81x | 3.20x |
| FD | Eff calls parent | 19 | 20 | +5% | 1.19x | 1.33x |
| FD | Calls children | 26 | 29 | +12% | – | – |
| FD | Tokens input (P+C) | 98,446 | 60,720 | -38% | 6.05x | 3.73x |
| FD | Tokens output (P+C) | 5,830 | 9,773 | +68% | 6.77x | 11.82x |
| FD | Tokens cacheRead (P+C) | 933,760 | 500,736 | -46% | 10.03x | 5.53x |
| FD | Tokens total (P+C) | 1,027,982 | 600,694 | -42% | 9.31x | 5.75x |

#### F2

| Arm | Metric | Before | After | Change | Before / B | After / B |
|---|---|---|---|---|---|---|
| B | Wall s | 90.9 | 90.0 | -1% | – | – |
| B | $ total | 0.346 | 0.398 | +15% | – | – |
| B | $ parent | 0.346 | 0.398 | +15% | – | – |
| B | $ children | 0.000 | 0.000 | – | – | – |
| B | Eff calls parent+children | 16 | 15 | -6% | – | – |
| B | Eff calls parent | 16 | 15 | -6% | – | – |
| B | Calls children | 0 | 0 | – | – | – |
| B | Tokens input (P+C) | 8,929 | 12,718 | +42% | – | – |
| B | Tokens output (P+C) | 2,861 | 2,816 | -2% | – | – |
| B | Tokens cacheRead (P+C) | 119,296 | 115,072 | -4% | – | – |
| B | Tokens total (P+C) | 130,834 | 123,708 | -5% | – | – |
| O | Wall s | 228.1 | 91.8 | -60% | 2.51x | 1.02x |
| O | $ total | 0.999 | 0.796 | -20% | 2.89x | 2.00x |
| O | $ parent | 0.866 | 0.796 | -8% | 2.50x | 2.00x |
| O | $ children | 0.128 | 0.000 | -100% | – | – |
| O | Eff calls parent+children | 35 | 14 | -60% | 2.19x | 0.93x |
| O | Eff calls parent | 12 | 14 | +17% | 0.75x | 0.93x |
| O | Calls children | 24 | 0 | -100% | – | – |
| O | Tokens input (P+C) | 91,938 | 35,887 | -61% | 10.30x | 2.82x |
| O | Tokens output (P+C) | 15,713 | 3,039 | -81% | 5.49x | 1.08x |
| O | Tokens cacheRead (P+C) | 560,640 | 298,880 | -47% | 4.70x | 2.60x |
| O | Tokens total (P+C) | 674,536 | 337,376 | -50% | 5.16x | 2.73x |
| FD | Wall s | 225.0 | 267.0 | +19% | 2.48x | 2.97x |
| FD | $ total | 1.025 | 0.800 | -22% | 2.96x | 2.01x |
| FD | $ parent | 0.903 | 0.654 | -28% | 2.61x | 1.64x |
| FD | $ children | 0.122 | 0.135 | +10% | – | – |
| FD | Eff calls parent+children | 34 | 38 | +12% | 2.12x | 2.53x |
| FD | Eff calls parent | 14 | 15 | +7% | 0.88x | 1.00x |
| FD | Calls children | 20 | 23 | +15% | – | – |
| FD | Tokens input (P+C) | 92,787 | 65,776 | -29% | 10.39x | 5.17x |
| FD | Tokens output (P+C) | 14,729 | 21,318 | +45% | 5.15x | 7.57x |
| FD | Tokens cacheRead (P+C) | 597,248 | 411,520 | -31% | 5.01x | 3.58x |
| FD | Tokens total (P+C) | 706,510 | 499,325 | -29% | 5.40x | 4.04x |

### Bare-arm drift reference

The bare arm's code and prompt are unchanged: 14,384 B sections in base and 14,385 B in after, the extra byte being the longer `cwd`. Tool definitions are 4,861 B in both.

| Task | Base B runs (s) | Median | After B runs (s) | Median | Change |
|---|---|---|---|---|---|
| F1 | 57.0 / 50.8 / 56.8 | 56.8 | 58.2 / 48.9 / 47.4 (*47.9 concurrent extra*) | 48.9 | −14% |
| F2 | 89.2 / 91.2 / 90.9 | 90.9 | 99.0 / 82.3 / 90.0 | 90.0 | −1% |

- **F1:** the −14% shift in bare time with unchanged code is the noise floor. It is about the same size as the baseline's provider sharing could explain. Treat time changes within about ±15% as noise.
- **Bare cost:** +3% on F1 and +15% on F2. That comes from how many input tokens missed the cache, not from code.

### Prompt bytes per turn

| Session | Part | Before | After | Change |
|---|---|---|---|---|
| Primary O | sections total | 160,917 | 91,215 | −43% |
| | of which project_context | 79,406 | 10,622 | −87% |
| | of which skills | 15,749 | 15,704 | −0.3% |
| | of which addendum | 56,809 | 56,459 | −0.6% |
| | of which rules | 4,826 | 4,591 | −5% |
| | tool definitions | 53,382 (60) | 53,552 (60) | +0.3% |
| | **per turn (transcript estimate)** | **214,299** | **144,767** | **−32%** |
| Primary FD | sections total | 158,498 | 89,165 | −44% |
| | of which project_context | 79,406 | 10,622 | −87% |
| | of which skills | 15,749 | 15,704 | −0.3% |
| | of which addendum | 54,642 | 54,408 | −0.4% |
| | tool definitions | 53,382 (60) | 53,552 (60) | +0.3% |
| | **per turn (transcript estimate)** | **211,880** | **142,717** | **−33%** |
| `gentle-ai-worker` | sections total | 57,885 | 30,511 | −47% |
| | of which project_context | 22,412 | 10,622 | −53% |
| | of which skills | 15,749 | 0 (absent) | −100% |
| | of which addendum | 17,585 | 17,748 | +0.9% |
| | tool definitions | 6,198 (8) | 6,198 (8) | 0% |
| | **per turn (transcript estimate)** | **64,083** | **36,709** | **−43%** |

The bytes saved come almost entirely from context-file filtering (#3095) and the worker skills removal (#3093):

- The orchestrator addendum shrank by only 234–350 B. The #3096 diet was offset by the Language Boundary that full delegation gained.
- The tool definitions grew by 170 B.
- The `## Effective session skills` table in the primary addendum is unchanged: 25,506 B (88 rows) between its begin and end markers, against 25,551 B in the base phase measured the same way. The baseline's heading-to-next-heading measure gave 25,511 B.

**For the parent, recorded without acting on it:** the table is rendered by `appendEffectivePrompt` in `extensions/skill-registry.ts` (lines 473–480, markers `EFFECTIVE_BEGIN`/`EFFECTIVE_END` at 460–461). Its usage instructions are in `assets/orchestrator-skills.md`.

**Engram protocol copies in the after primary:** two copies remain.

- The project `AGENTS.md` block `gentle-ai:engram-protocol` (8,997 B) is still loaded.
- gentle-engram's own addendum protocol (`## Engram Persistent Memory — Protocol`, about 2,790 B) is also present.
- Only the home `~/AGENTS.md` copy (11,788 B) was dropped.

Workers carry the same project block.

### Organic delegation

| Phase | Organic runs that delegated | What the parent did |
|---|---|---|
| base | **6 of 6** (one `gentle-ai-worker`, terra-max, per run) | F1: delegated 1 fix and made 2 fixes inline (2 parent edits + 1 worker edit). F2: made no edits; the worker implemented everything. |
| after | **0 of 6** (0 of 8 including the 2 extras) | Every run worked inline. F1: 3 parent edits and a focused test run. F2: wrote `loans.py`, updated `__init__.py` and wrote `tests/test_loans.py` (3 parent edits). |

Delegation was the main cost of organic mode in the baseline. Without it, organic wall time fell 60% in both tasks. Organic is now 1.25x B on F1 and 1.02x B on F2.

### Memory calls (`mem_*`) per session

These are the startup calls driven by the Engram protocol, counted per parent session (12 counted harness sessions per phase).

| Call | Base (12 sessions) | After (12 sessions) |
|---|---|---|
| `mem_current_project` | 12 | 12 |
| `mem_search` | 12 | 12 |
| `mem_review` | 4 | 7 |
| `mem_session_summary` | 2 | 2 (F1-FD1, F1-FD2) |
| parent `mem_save` per run, F1 O | 2 / 2 / 2 | 3 / 3 / 3 (one per fix) |
| parent `mem_save` per run, F1 FD | 1 / 3 / 0 | 3 / 3 / 1 |
| parent `mem_save` per run, F2 O / F2 FD | 1, 1, 0 / 1, 1, 1 | 1, 1, 1 / 1, 1, 1 |
| worker `mem_save` | 1–3 per worker session (19 in total) | **0** |

Every harness session in both phases still opens with `mem_current_project` and `mem_search`. Removing the home `engram-protocol` block did not remove these calls.

### Rejected launches and correction rounds

| Phase | Rejected `subagent_run` | Correction rounds | Worker sessions per F1 FD run |
|---|---|---|---|
| base | 0 | 0 | 1 (run + 2 continue) |
| after | **1** (F1-FD3, missing `## Allowed edit surfaces`) | 0 | 3 (3 fresh runs) |

### Cache read vs input (parent)

The cache-read share of the parent prompt is computed as cacheRead / (cacheRead + input).

| Arm | Base | After |
|---|---|---|
| O | 81–93% | 87–94% |
| FD | 81–92% | 80–91% |
| B | 84–93% | 78–95% |

Parent uncached input fell, while the cache share stayed in the same range:

| Arm | Base | After |
|---|---|---|
| O | 48–55k | 33–36k |
| FD | 50–56k | 35–42k |

Worker cache share was 76–93% (after) against 85–93% (base).

### Where full-delegation time went

FD wall time rose (+8% on F1, +19% on F2) while FD cost fell. The extra time is in the workers.

| | Base | After |
|---|---|---|
| F1 FD worker output tokens, per run | 3.9–5.5k | 5.9–21.4k |
| F2 FD worker output tokens, per run | 10.7–14.4k | 12.2–21.4k |
| F1 FD subagent time (s) | 145–160 | 150–306 |
| F2 FD subagent time (s) | 128–181 | 158–280 |

- The two slowest runs (F1-FD2 at 373 s and F2-FD2 at 334 s) are the ones with the highest worker output: 21.4k tokens in F2-FD2, and 10.6k in the first worker of F1-FD2.
- In F1, three fresh workers replace one worker that was continued. Each fresh worker cold-starts, but each one is short (49–67 s in FD1 and FD3).
- Whether the extra worker reasoning comes from #3092's guidance or from terra-max variance cannot be separated with n=3.

### Quality, both phases

| Task / arm | Phase | Public tests | Hidden (F2) | Files outside task | Commit | Edits by | Final answer reports checks |
|---|---|---|---|---|---|---|---|
| F1 B | base / after | 3/3 OK / 3/3 OK | – | 0 / 0 | none / none | parent / parent | 3/3 / 3/3 |
| F1 O | base / after | 3/3 OK / 3/3 OK | – | 0 / 0 | none / none | parent + worker / parent | 3/3 / 3/3 |
| F1 FD | base / after | 3/3 OK / 3/3 OK | – | 0 / 0 | none / none | workers only / workers only | 3/3 / 3/3 |
| F2 B | base / after | 3/3 OK / 3/3 OK | 18/18 ×3 / 18/18 ×3 | 0 / 0 | none / none | parent / parent | 3/3 / 3/3 |
| F2 O | base / after | 3/3 OK / 3/3 OK | 18/18 ×3 / 18/18 ×3 | 0 / 0 | none / none | worker / parent | 3/3 / 3/3 |
| F2 FD | base / after | 3/3 OK / 3/3 OK | 18/18 ×3 / 18/18 ×3 | 0 / 0 | none / none | workers only / workers only | 3/3 / 3/3 |

The concurrent extras also passed, with no outside files and no commit.

**Verdict: graded quality did not change.**

- Every run in both phases passed the public tests.
- Every F2 run passed the hidden suite 18/18.
- No run touched a file outside the task or made a commit.
- In every FD run, the workers made all edits.
- Every final answer reports its checks.

**What got worse, or is a residual:**

1. **FD wall time.** +8% on F1 and +19% on F2. Its ratio to B worsened from 4.02x to 5.03x on F1 and from 2.48x to 2.97x on F2. The cause is longer worker reasoning, and on F1 also three fresh workers instead of continues.
2. **FD output tokens.** +68% on F1 and +45% on F2. Worker cost on F2 rose 10%.
3. **One rejected launch** (F1-FD3), where the baseline had none. The admission requirement is still missed sometimes.
4. **More bookkeeping.** In F1, organic parents save one `mem_save` per fix: 3 per run, up from 2. `mem_review` ran in 7 sessions, up from 4.
5. **Fewer new tests from inline organic F2 runs.** These runs wrote 8–11 new tests (13–16 total), where the base-phase workers wrote 11–18 (16–23 total). This is ungraded: the hidden suite still passed 18/18.
6. **Engram protocol still reaches the primary twice:** the project block (8,997 B) plus gentle-engram's addendum. The 25.5 KB `Effective session skills` table is unchanged.

### Engram, after phase

The after runs created **27 observations in 13 throwaway projects**:

| Project | Observations |
|---|---|
| `after-f1-o1` (concurrent extra) | 3 |
| `after-f1-o2` | 3 |
| `after-f1-o3` | 3 |
| `after-f1-o4` | 3 |
| `after-f1-fd1` | 4 |
| `after-f1-fd2` | 4 |
| `after-f1-fd3` | 1 |
| `after-f2-o1` | 1 |
| `after-f2-o2` | 1 |
| `after-f2-o3` | 1 |
| `after-f2-fd1` | 1 |
| `after-f2-fd2` | 1 |
| `after-f2-fd3` | 1 |

The base phase created 36 in 12 projects. Counts are from `engram projects list`. The bare arm wrote none. These projects were not deleted.

### Caveats (both phases)

1. n=3 per arm and task, two tasks, one orchestrator model (Astra medium), one worker model (terra-max).
2. **Unequal provider load:** the baseline shared the provider with other agents (T1 and T3 writers); the after phase did not. The bare-arm drift is −14% on F1 and −1% on F2.
3. **One concurrent pair in the after phase:** excluded and replaced, see above.
4. **Costs are Pi catalog estimates** (`totalFromProvider: false`).
5. **Model variance:** terra-max reasoning length varies widely between runs (worker output from 1.7k to 21.4k tokens per session). FD time differences of this size are within what n=3 can resolve only weakly.

## Final phase (70becff64)

P11 (S15). One phase, `final`, on 2026-11-10/11, 23:56 to 01:50 UTC, plus four runs of the multi-unit task F3 from the delegation check (T11).

### Setup

- **Code under test:** worktree `~/work/gentle-pi/.worktrees/bench-final`, detached at `70becff648472b855134db81c03f6c1d4fe5520a` (main `1308f5479` plus PR #3112), Pi `@earendil-works/pi-coding-agent` 1.5.2, same `node_modules` link. Every run's `.meta` records `root_head=70becff64…` and `pi=1.5.2`.
- **Merged since `after` (29b57a414), from `git log 29b57a414..70becff64`:** #3099 skill contradictions, #3101 verification by change kind, #3100 reply-language anchors append-only, #3103 effective skills block, #3102 lazy-module contradictions, #3104 assess tests isolation, #3105 review follow-ups, #3106 todo reminder append-only, #3107 late child-query answers, #3108 always-on prompt verdicts, #3110 parallel writer admission, #3111 tools by mode (1308f5479), #3112 approved text verdicts (70becff64).
- **Not in the tree:** P9b (conflict-marker refusal on commits, admission rejections that name the invalid line, a 16 KB cap on child reports) was still in verification. It should not move these numbers: every child report in these tasks is far below 16 KB, no run committed, and no launch in the final phase was rejected (the message change acts only on a rejected launch).
- **Unchanged:** both harnesses (`/private/tmp/cost-speed-bench-PSQgUo`, `/private/tmp/delegation-check-KGPJRI`), their `run.sh`, fixtures, hidden suites and tools (`shasum -c FROZEN.sha256` OK in both before the first run); `openai-codex/gpt-6-astra` at `medium` for every parent; workers from the active profile `openai-oauth-delegation` (every child session `openai/gpt-6.1-terra@max`); `profiles.json` sha1 `e3b0b88122750d50f7220da96ff3b3f245ff5157` before and after; real HOME as `run.sh` sets it.
- **Review mode:** `gentle-ai review mode status` printed `receipt-driven development: off (decided by global)` before the first run and after the last.
- **Order:** F1 B1 O1 FD1, B2 O2 FD2, B3 O3 FD3; F2 in the same order; F3 O3, FD3, O4, FD4; then the quiet replacements F1 FD4, FD5, FD6. One run per tool call, each awaited. Every run exited 0 with empty stderr; nothing timed out, nothing was retried or repeated.
- **Process counts:** `pgrep -fl "gentle-shell.mjs|pi-coding-agent" | wc -l` was 0 before the first run and 0 after the last; from final-F2-B1 on it was recorded immediately before and after every run, and was 0 every time (column `pgrep` below; `–` = not recorded per run).

**Known contamination, final-F1-B1 through final-F1-FD3.** While these nine runs ran, the parent session had other subagents working on this machine (a verifier running timing probes and test suites, two writers, a ledger worker) on the same account and the same worker model as the full-delegation arm's workers (`gpt-6.1-terra`). The process count above stayed 0 during that window, so it does not detect that load. The F1 full-delegation cell was therefore run again under quiet conditions as FD4–FD6 (the parent launched nothing until the phase ended). Both versions are reported; nothing is dropped.

```bash
S=/private/tmp/cost-speed-bench-PSQgUo; ROOT=~/work/gentle-pi/.worktrees/bench-final
cd $S && ./run.sh final $ROOT F1 B 1   # … one per call, order above
python3 -B tools/table.py final > out/final-tables.md
python3 -B tools/compare.py base final > out/compare-base-final.md
python3 -B tools/compare.py after final --exclude after-F1-B1,after-F1-O1 > out/compare-after-final.md
# F3 (delegation-check harness: its own run.sh, no phase argument)
D=/private/tmp/delegation-check-KGPJRI; cd $D
./run.sh $ROOT F3 O 3; ./run.sh $ROOT F3 FD 3; ./run.sh $ROOT F3 O 4; ./run.sh $ROOT F3 FD 4
```

`tools/table.py` only reads n=1–4, so `out/final-tables.md` and both `out/compare-*-final.md` put FD1–FD4 into the F1 full-delegation median (355.9 s, n=4) and leave FD5 and FD6 out. The medians below come from the same `analyze.run()` per run, computed in scratch (`/private/tmp/p11-gGaaWv/med.py`, `all-metrics.json`), with the F1 full-delegation cell shown three ways.

### Per-run results

Cost is Pi's catalog estimate, parent / workers / total. Hidden = F2 hidden suite. Public tests passed in every run; no run changed a file outside the task or committed.

| Run | rc | Wall s | $ parent | $ workers | $ total | Parent turns | Workers (sessions / rounds) | Hidden | pgrep before / after | Load |
|---|---|---|---|---|---|---|---|---|---|---|
| final-F1-B1 | 0 | 42.8 | 0.283 | 0 | 0.283 | 16 | – | – | – | contaminated |
| final-F1-O1 | 0 | 58.0 | 0.653 | 0 | 0.653 | 12 | – | – | – | contaminated |
| final-F1-FD1 | 0 | 421.2 | 0.718 | 0.084 | 0.802 | 12 | 1 / 3 | – | – | contaminated |
| final-F1-B2 | 0 | 44.0 | 0.227 | 0 | 0.227 | 16 | – | – | – | contaminated |
| final-F1-O2 | 0 | 85.8 | 0.789 | 0 | 0.789 | 17 | – | – | – | contaminated |
| final-F1-FD2 | 0 | 399.1 | 0.621 | 0.147 | 0.768 | 9 | 1 / 3 | – | – | contaminated |
| final-F1-B3 | 0 | 47.8 | 0.361 | 0 | 0.361 | 17 | – | – | – | contaminated |
| final-F1-O3 | 0 | 51.3 | 0.644 | 0 | 0.644 | 12 | – | – | – | contaminated |
| final-F1-FD3 | 0 | 312.7 | 0.625 | 0.140 | 0.764 | 9 | 1 / 3 | – | – | contaminated |
| final-F2-B1 | 0 | 73.8 | 0.370 | 0 | 0.370 | 11 | – | 18/18 | 0 / 0 | quiet |
| final-F2-O1 | 0 | 86.5 | 0.634 | 0 | 0.634 | 8 | – | 18/18 | 0 / 0 | quiet |
| final-F2-FD1 | 0 | 287.9 | 0.546 | 0.135 | 0.681 | 6 | 1 / 1 | 18/18 | 0 / 0 | quiet |
| final-F2-B2 | 0 | 68.6 | 0.283 | 0 | 0.283 | 11 | – | 18/18 | 0 / 0 | quiet |
| final-F2-O2 | 0 | 83.8 | 0.684 | 0 | 0.684 | 10 | – | 18/18 | 0 / 0 | quiet |
| final-F2-FD2 | 0 | 203.9 | 0.567 | 0.113 | 0.679 | 6 | 1 / 1 | 18/18 | 0 / 0 | quiet |
| final-F2-B3 | 0 | 70.4 | 0.362 | 0 | 0.362 | 11 | – | 18/18 | 0 / 0 | quiet |
| final-F2-O3 | 0 | 78.5 | 0.651 | 0 | 0.651 | 9 | – | 18/18 | 0 / 0 | quiet |
| final-F2-FD3 | 0 | 459.3 | 0.613 | 0.146 | 0.760 | 7 | 1 / 2 | 18/18 | 0 / 0 | quiet |
| final-F1-FD4 | 0 | 172.5 | 0.674 | 0.045 | 0.718 | 11 | 1 / 3 | – | 0 / 0 | quiet |
| final-F1-FD5 | 0 | 183.6 | 0.645 | 0.069 | 0.714 | 10 | 1 / 3 | – | 0 / 0 | quiet |
| final-F1-FD6 | 0 | 167.8 | 0.619 | 0.051 | 0.670 | 9 | 1 / 3 | – | 0 / 0 | quiet |

Organic delegated in 0 of 6 runs (as in `after`). No `subagent_run` was rejected at admission in any final run.

### Medians: base, after, final (time AND cost)

`after` uses its published exclusions (after-F1-B1 and after-F1-O1, concurrent). Δ = (final − x) / x.

| Task | Arm | Wall s base / after / final | Δ time vs after | Δ time vs base | $ total base / after / final | Δ cost vs after | Δ cost vs base | Time / B final (after) | Cost / B final (after) |
|---|---|---|---|---|---|---|---|---|---|
| F1 | B | 56.8 / 48.9 / 44.0 | −10% | −23% | 0.290 / 0.300 / 0.283 | −6% | −2% | – | – |
| F1 | O | 153.7 / 61.2 / 58.0 | −5% | −62% | 1.251 / 0.843 / 0.653 | −23% | −48% | 1.32x (1.25x) | 2.31x (2.81x) |
| F1 | FD, quiet FD4–6 (used) | 228.6 / 246.1 / 172.5 | −30% | −25% | 1.231 / 0.868 / 0.714 | −18% | −42% | 3.92x (5.03x) | 2.53x (2.90x) |
| F1 | FD, FD1–3 as run (contaminated) | 228.6 / 246.1 / 399.1 | +62% | +75% | 1.231 / 0.868 / 0.768 | −11% | −38% | 9.07x | 2.72x |
| F1 | FD, all six | – / – / 248.1 | +1% | +9% | – / – / 0.741 | −15% | −40% | – | – |
| F2 | B | 90.9 / 90.0 / 70.4 | −22% | −23% | 0.346 / 0.398 / 0.362 | −9% | +5% | – | – |
| F2 | O | 228.1 / 91.8 / 83.8 | −9% | −63% | 0.999 / 0.796 / 0.651 | −18% | −35% | 1.19x (1.02x) | 1.80x (2.00x) |
| F2 | FD | 225.0 / 267.0 / 287.9 | +8% | +28% | 1.025 / 0.800 / 0.681 | −15% | −34% | 4.09x (2.97x) | 1.88x (2.01x) |

Parent / worker cost medians, final: F1 O 0.653 / 0; F1 FD quiet 0.645 / 0.051 (FD1–3: 0.625 / 0.140); F2 O 0.651 / 0; F2 FD 0.567 / 0.135. In `after`: F1 FD 0.792 / 0.073, F2 FD 0.654 / 0.135.

**Which F1 FD value is used and why:** FD4–FD6. FD1–FD3 overlapped known load on the same worker model; their parent behaviour was identical to FD4–FD6 (one worker, `subagent_run` plus two `subagent_continue`, 9–12 parent turns, 0 rejections), and the difference is in worker time: subagent time 254–342 s against 111–128 s, worker input tokens 31–43k against 17–33k. The quiet runs on the same tree are not around 400 s, so the code alone does not produce the 400 s; the shared load is the likely cause, not an established one, because the worker token counts also differed between the groups and these measurements do not separate provider load from worker variance. The other contaminated cells (F1 B and O) were not repeated; their bare reference ran in the same window.

**F1 full delegation, quiet runs against `after`:** worker sessions 1 (after: 3 fresh workers per run), rounds 3 in both (after: 3 `subagent_run`; final: 1 `subagent_run` + 2 `subagent_continue`), subagent time 111–128 s (after: 150–306 s), worker output 3.2–5.2k tokens (after: 5.9–21.4k), parent turns 9–11 (after: 10–12).

**F2 full delegation:** final-F2-FD3 (459 s, quiet) spent 201 s of a 406 s subagent time on a `subagent_continue` asking the worker to delete the `__pycache__` files created by the parent's own `python3 -m unittest`; the worker returned `status: blocked` because its contract forbids deletion. Without that round the run is about 258 s. The same pattern (a worker launched to delete bytecode) appears in the old t11-F3-FD1 (27 s).

### Bare arm as the day's noise reference

The bare prompt changed by 24 B (`rules` 1,390 → 1,366: the `todo` tool guideline shortened by P7, loaded through `-e $ROOT/extensions/gentle-todo.ts`); tool definitions 4,861 B in all three phases.

| Task | after B runs (s) | Median | final B runs (s) | Median | Change | $ median after → final |
|---|---|---|---|---|---|---|
| F1 | 58.2 / 48.9 / 47.4 | 48.9 | 42.8 / 44.0 / 47.8 | 44.0 | −10% | 0.300 → 0.283 (−6%) |
| F2 | 99.0 / 82.3 / 90.0 | 90.0 | 73.8 / 68.6 / 70.4 | 70.4 | −22% | 0.398 → 0.362 (−9%) |

Bare F2 also took fewer parent turns (16 → 11 median) with an unchanged prompt. Time changes up to about ±20% and cost changes up to about ±10–15% occur in the bare arm between phases with only the 24 B prompt change above (the `todo` guideline); the data cannot separate that change from noise, so this band is the day's drift reference, not a pure noise measurement; organic time changes against `after` (−5%, −9%) are inside that band, organic cost changes (−23%, −18%) are outside it.

### Prompt bytes per turn (first system message, same method as above)

Sections = the first system message's sections; tool definitions = its `toolsAdded` JSON. Organic from F1-O1, full delegation from F1-FD1, worker from the first FD worker session.

| Session | Part | base c09189269 | after 29b57a414 | final 70becff64 | final vs after |
|---|---|---|---|---|---|
| Primary O | sections total | 160,917 | 91,215 | 77,093 | −14,122 |
| | of which addendum | 56,809 | 56,459 | 42,826 | −13,633 |
| | of which skills | 15,749 | 15,704 | 15,616 | −88 |
| | of which rules / tools text | 4,826 / 2,064 | 4,591 / 2,064 | 4,525 / 1,693 | −66 / −371 |
| | of which project_context | 79,406 | 10,622 | 10,622 | 0 |
| | tool definitions (transcript) | 53,382 (60) | 53,552 (60) | 53,542 (60) | −10 |
| | **per turn (transcript estimate)** | **214,299** | **144,767** | **130,635** | **−14,132 (−10%)**; vs base −39% |
| Primary FD | sections total | 158,498 | 89,165 | 75,113 | −14,052 |
| | of which addendum | 54,642 | 54,408 | 40,845 | −13,563 |
| | tool definitions (transcript) | 53,382 (60) | 53,552 (60) | 53,542 (60) | −10 |
| | **per turn (transcript estimate)** | **211,880** | **142,717** | **128,655** | **−14,062 (−10%)**; vs base −39% |
| `gentle-ai-worker` | sections total | 57,885 | 30,511 | 30,540 | +29 |
| | tool definitions | 6,198 (8) | 6,198 (8) | 6,198 (8) | 0 |
| | **per turn (transcript estimate)** | **64,083** | **36,709** | **36,738** | **+29** |

The addendum reduction is the removed `## Effective session skills` table (25.5 KB in `after`; the block is now absent because every on-disk skill is already listed by Pi) net of text added since. **Tool definitions are an upper bound:** the transcript's `toolsAdded` lists every registered tool, not what is sent (L37). The bytes actually declared in the request were not measured in this phase; #3111's own offline capture with real Pi measured 34,521 → 27,321 B (34 → 28 tools) for its configuration, and that change is not visible in this column.

### F3, multi-unit task (three independent modules), old runs on 29b57a414 next to new runs on 70becff64

Hidden suite 28/28 (semver 10/10, cron 9/9, calc 9/9) in all nine runs; public tests passed; no files outside the task; no commits. Bare reference t11-F3-B1 (29b57a414): 236.5 s, $1.085.

| Run | Tree | Wall s | $ parent / workers / total | Parent turns | Writers launched | Launch messages | Rejected | Children (start UTC, duration) | Overlap | Backstop notice | Fixes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| O1 | 29b57a414 | 649.3 | 2.052 / 0.345 / 2.397 | 20 | 1 | 1 (turn 14) | 0 | 20:36:38 426 s | no | after turn 11, before the launch | – (parent wrote semver and cron inline) |
| O2 | 29b57a414 | 672.5 | 1.815 / 0.339 / 2.154 | 17 | 2 + 1 continue | 3 (turns 9, 11, 12) | 0 | 20:58:50 243 s; 21:03:15 85 s; 21:04:48 172 s | no | after turn 6, before the launches | continue |
| **O3** | 70becff64 | 758.5 | 0.738 / 0.537 / 1.274 | 9 | 3 | **1 (turn 4, three `subagent_run`, no other call)** | 0 | 00:46:48 188 s / 278 s / 663 s | **yes** | after turn 8, after the launch | none |
| **O4** | 70becff64 | 551.3 | 0.887 / 0.683 / 1.570 | 8 | 3 | **1 (turn 3, three `subagent_run`, no other call)** | 0 | 01:14:31 183 s / 244 s / 438 s | **yes** | after turn 5, after the launch | none |
| FD1 | 29b57a414 | 478.2 | 0.904 / 0.515 / 1.418 | 7 | 3 + 1 | 1 `codemode` (turn 3) + 1 (turn 5) | 0 | 20:45:59 172 s / 214 s / 350 s; 20:52:05 27 s | yes | after turn 5 | new worker for bytecode cleanup |
| FD2 | 29b57a414 | 392.9 | 0.871 / 0.537 / 1.408 | 9 | 3 | 1 `codemode` (turn 4) | 0 | 21:09:39 206 s / 233 s / 292 s | yes | none | none |
| **FD3** | 70becff64 | 886.9 | 0.823 / 0.446 / 1.269 | 9 | 3 + 1 continue | **3 (turns 3, 4, 5, one `subagent_run` each)** | 0 | 00:59:05 303 s; 01:04:30 178 s; 01:07:48 194 s; continue 01:11:09 108 s | **no** | none | `subagent_continue` of the calc worker |
| **FD4** | 70becff64 | 1,091.7 | 1.067 / 0.629 / 1.696 | 8 | 3 | **3 (turns 3, 4, 5, one `subagent_run` each)** | 0 | 01:23:21 353 s; 01:29:33 322 s; 01:35:15 312 s | **no** | none | none |

Medians, old → new: organic 660.9 s → 654.9 s, $2.276 → $1.422 (−38%), parent $1.934 → $0.812; full delegation 435.6 s → 989.3 s (+127%), $1.413 → $1.482 (+5%).

- **Organic (PR #3110):** in both new runs the parent launched three writers in ONE assistant message containing only the three `subagent_run` calls, at turn 3–4, before the context backstop notice; none was rejected; the children ran concurrently (same start second). In the old runs the parent wrote one or two modules inline and delegated the rest only after the backstop, one launch per message, serially. Organic wall time is unchanged at the median because the slowest child dominates (calc 663 s in O3, 438 s in O4); cost fell because the parent made 8–9 turns instead of 17–20. O3 also recorded two provider errors on turns 5–6 (`WebSocket error`, `upstream connect error … connection termination`) that Pi retried.
- **Full delegation:** in both new runs the parent launched the three writers one per assistant message, each `mode: "task"` awaited before the next, so the children never overlapped; in the old runs it launched all three from one `codemode` call (`Promise.allSettled`) and they overlapped. In FD3 the parent wrote "I'll delegate the three independent modules in parallel" on turn 2 and then launched them on turns 3, 4 and 5. The final FD prompt now reads "Two or more independent units with disjoint surfaces launch together in one turn, as direct `subagent_run` calls in one message with no other tool call"; the old one read "… launch together in one turn" with no call form. The fix to a unit (FD3) continued the same worker with `subagent_continue`, as the new rule "Fixes to one unit continue its worker" states; in old FD1 the parent launched a new worker for a cleanup.

### Cache (parent session, no extra runs)

`/private/tmp/p11-gGaaWv/cache.py`, per assistant turn of the parent session: input, cache read, cache write; "drops" = turns whose cache read is lower than the previous turn's. Medians per phase and arm; F1 FD final = quiet FD4–6 (FD1–3: input 31,925, cache read 232,064, 88.2%, 0 drops).

| Task / arm | Input base / after / final | Cache read base / after / final | Cache write | Cache-read share base / after / final | Drops (median; total) base / after / final |
|---|---|---|---|---|---|
| F1 B | 16,263 / 16,289 / 15,244 | 93,056 / 90,496 / 89,088 | 0 | 84.9 / 85.2 / 85.4% | 2;4 / 2;7 / 1;6 |
| F1 O | 48,216 / 33,500 / 28,895 | 644,736 / 443,264 / 296,320 | 0 | 93.0 / 93.0 / 91.1% | 0 / 0 / 0 |
| F1 FD | 50,147 / 36,469 / 31,306 | 564,864 / 343,808 / 260,864 | 0 | 91.8 / 90.4 / 89.3% | 0 / 0 / 0 |
| F2 B | 8,929 / 12,718 / 17,223 | 119,296 / 115,072 / 60,928 | 0 | 92.0 / 90.8 / 77.8% | 1;2 / 1;3 / 2;4 |
| F2 O | 51,794 / 35,887 / 28,359 | 281,344 / 298,880 / 229,248 | 0 | 84.6 / 89.3 / 89.0% | 0 / 0 / 0 |
| F2 FD | 55,428 / 41,244 / 34,283 | 280,576 / 169,600 / 146,176 | 0 | 83.6 / 80.7 / 81.3% | 0 / 0 / 0 |
| F3 O (old O1–2 / new O3–4) | 89,563 / 40,140 | 684,800 / 226,432 | 0 | 88.4 / 84.8% | O1 t11, O2 t8 / O3 t5 |
| F3 FD (old FD1–2 / new FD3–4) | 44,672 / 53,660 | 259,904 / 231,168 | 0 | 85.2 / 80.8% | none / FD4 t4 |

- `openai-codex` reports `cacheWrite` 0 on every turn of every session in all phases: the provider's usage data does not expose cache writes.
- No organic or full-delegation F1/F2 parent session in any phase has a turn whose cache read falls, so there is no prefix rewrite here for #3100 and #3106 to remove. Their effect was measured on pi-claude-bridge by the P1/P1b verifiers (L43, L60), whose explicit cache breakpoints make a moved tail visible; this provider's automatic prefix caching keeps the common prefix, and these runs are 6–17 turns long.
- The F3 drops are to 0 cache read. O3 turn 5 is the provider error turn (no usage). FD4 turn 4 followed a 353 s wait for a child, and old O1/O2 followed long waits too; with no request bodies recorded, provider cache expiry cannot be told apart from a prefix rewrite. Bare-arm drops (4 / 7 / 6 on F1, 2 / 3 / 4 on F2) are partial and did not fall in `final`; the bare arm also loads the todo extension.

### Excluded, failed, not measured

- **Excluded from the comparison:** none of the final runs. FD1–FD3 of F1 are shown separately and not used for the F1 FD comparison value (reason above). `after-F1-B1` and `after-F1-O1` stay excluded on the `after` side as published.
- **Failed:** none (21 harness runs and 4 F3 runs, rc 0, stderr empty, no timeout).
- **Not measured:** tool declarations actually sent per request (transcript upper bound only); cache writes (not reported by the provider); whether the F1 B and O runs of the contaminated window were slowed (not repeated).
- **Harness tool label:** `analyze.py` labels the final organic prompt mode `none` because the organic addendum no longer contains `COORDINATOR, not the default executor`; every final O session contains `COORDINATOR who executes understood work inline` and every FD session `COORDINATOR in full delegation mode`.

### Limits

1. n=3 per arm for F1/F2 (F1 FD: 3 contaminated + 3 quiet), n=2 per arm and tree for F3.
2. One parent model and effort (Astra medium) and one worker routing (terra-max).
3. Shared provider: the first nine runs overlapped other agents on the same account and worker model; the process count did not detect it.
4. P9b (three runtime guards) is not in the tree; see Setup for why it should not move these numbers.
5. Costs are Pi catalog estimates (`totalFromProvider: false`).

### What the data supports

- Transcript estimate (first system message plus the transcript's tool definitions, an upper bound on what is sent; the bytes sent were not measured): the per-turn primary prompt fell another 14.1 KB (−10%) from `after`, 39% below base, in both modes; the worker estimate is unchanged (+29 B). Nearly all of it is in the system-message sections (−14,122 B O, −14,052 B FD); the tool-definition column moved −10 B.
- Measured outside these runs, recorded in the feature document's log: the rendered primary prompt pins went 25,180 → 24,164 B organic and 23,123 → 22,128 B full delegation (L55, L76, L84); #3111's offline captures with real Pi measured the declarations at 34,521 → 27,321 B with `codemode` and no `design/` directory (L68, L72).
- Organic cost fell 23% (F1) and 18% (F2) against `after`, 48% and 35% against base; the bare arm moved −6% and −9% over the same interval.
- Organic time against `after` (−5%, −9%) is within the bare arm's −10% and −22% drift; against base it is −62% and −63%.
- Full-delegation cost fell 18% (F1 quiet) and 15% (F2) against `after`, 42% and 34% against base.
- F1 full delegation now uses one worker continued twice instead of three fresh workers; quiet F1 FD time is 30% below `after` and 25% below base.
- Organic mode now launches independent writers in one message, without rejections and before the backstop, and they run concurrently (2 of 2 new F3 runs; 0 of 2 old).
- Full delegation on F3 launched its writers serially in both new runs (parallel in both old runs); F3 FD wall time rose from 393–478 s to 887–1,092 s with similar cost.
- Quality: hidden suites 18/18 in every F2 run and 28/28 in every F3 run; public tests passed; no outside files; no commits; full-delegation edits all by workers.

### What the data does not support

- That organic wall time changed against `after`: the change is inside the bare drift.
- That F2 full-delegation time changed: the three runs span 204–459 s, and one 201 s round was a refused cleanup.
- That the anchor (#3100) or todo (#3106) changes affected these runs: there were no cache-read drops to remove in the harness arms, and the provider reports no cache writes.
- That the serial full-delegation launches on F3 are caused by the new "direct `subagent_run` calls in one message" wording: n=2 per tree, and the rule text is the only prompt difference identified for that step, not a tested cause.
- That the tool-declaration change of #3111 reduced the bytes sent: the transcript method does not show it.
- Anything about other models, interactive background mode, or P9b.

## Full delegation after the launch-sentence fix (8b2a492b6)

P6b live check, 2026-11-11 02:22–02:35 UTC. Tree `.worktrees/fd-parallel-launch` at 8b2a492b6 (main e8a56a1a4 plus the reworded `orchestrator-full-delegation.md:25`); same harness (`/private/tmp/delegation-check-KGPJRI`, `shasum -c FROZEN.sha256` OK), `./run.sh $ROOT F3 FD 5` then `FD 6`, one per tool call, each awaited. Both rc 0, empty stderr, no timeout, no retry, no provider error (no assistant message with `stopReason: error`, no retry event in the JSON stream). `gentle-ai review mode status`: `receipt-driven development: off (decided by global)` before and after. `pgrep -fl "gentle-shell.mjs|pi-coding-agent" | wc -l`: 0 before and after each run; no other Gentle Shell subagent ran (visible: this check's parent and worker sessions, three idle interactive `gentle-shell` processes, one `gh pr checks 3114 --watch`, gone after FD6). Workers `openai/gpt-6.1-terra@max`. Scratch `/private/tmp/p6bl-pPjkOF`.

| Run | Tree | Launches (calls / messages / route) | Overlap | Wall s | $ parent / workers / total | Hidden |
|---|---|---|---|---|---|---|
| FD1 | 29b57a414 | 3 + 1 / 2 / `codemode` + direct | yes | 478.2 | 0.904 / 0.515 / 1.418 | 28/28 |
| FD2 | 29b57a414 | 3 / 1 / `codemode` | yes | 392.9 | 0.871 / 0.537 / 1.408 | 28/28 |
| FD3 | 70becff64 | 3 + 1 continue / 3 + 1 / direct, one per message | no | 886.9 | 0.823 / 0.446 / 1.269 | 28/28 |
| FD4 | 70becff64 | 3 / 3 / direct, one per message | no | 1,091.7 | 1.067 / 0.629 / 1.696 | 28/28 |
| FD5 | 8b2a492b6 | 3 / 1 / `codemode` | yes | 360.2 | 0.652 / 0.443 / 1.094 | 28/28 |
| FD6 | 8b2a492b6 | 3 / 1 / `codemode` | yes | 386.6 | 0.643 / 0.517 / 1.159 | 28/28 |

- **FD5:** parent turn 4 of 7 held one `codemode` call and nothing else; the script ran `Promise.allSettled(jobs.map(… tools.subagent_run({agent:"gentle-ai-worker", mode:"task", …})))` over three units. Children started 02:23:17, durations 210 / 221 / 277 s, ended 02:26:47 / 02:26:58 / 02:27:54. No `subagent_continue`, no new worker for a fix, no verifier (3 worker sessions). Public 51 tests OK; 13 child edits, 0 parent edits; no outside files; no commits.
- **FD6:** parent turn 3 of 6 held one `codemode` call and nothing else; same `Promise.allSettled` over three `subagent_run` (`mode: "task"`). Children started 02:29:38, durations 193 / 235 / 302 s, ended 02:32:51 / 02:33:33 / 02:34:40. No `subagent_continue`, no new worker for a fix, no verifier (3 worker sessions). Public 64 tests OK; 15 child edits, 0 parent edits; no outside files; no commits.

What the two runs show:

- 2 of 2 runs launched the three writers from one `codemode` call in one assistant message with no other tool call; 0 of 2 on 70becff64, 2 of 2 on 29b57a414 (FD1 adding one direct launch later).
- Children overlapped in 2 of 2 (same start second); the slowest child took 277 s of 360.2 s wall (FD5) and 302 s of 386.6 s (FD6).
- Median wall 70becff64 → 8b2a492b6: 989.3 s → 373.4 s (−62%); against 29b57a414 (435.6 s): −14%.
- Median total cost 70becff64 → 8b2a492b6: $1.482 → $1.127 (−24%); parent $0.945 → $0.647; against 29b57a414 ($1.413): −20%.
- Parent turns 7 and 6 (8 and 9 on 70becff64; 7 and 9 on 29b57a414).
- Hidden 28/28 and public tests pass in both; total spend of the check $2.254.

What two runs cannot show:

- That the sentence alone caused the change: 8b2a492b6 also differs from 70becff64 by the merges up to e8a56a1a4 and seven tightened passages of the same file; n=2 per tree.
- How often the parent launches one per message with the new sentence: with 0 of 2 the one-sided 95% upper bound for that rate is 78%.
- That the parent uses direct `subagent_run` calls in one message (the other route the sentence names): neither run used it.
- Behavior with a `todo` update at launch time, with fixes (`subagent_continue`), with a verifier, on other tasks, other models, or interactive background mode: none occurred or was tested.
- The cost drop beyond noise: the bare arm's day-to-day drift was not measured in this window.
