# #1494 overhead re-measurement (T1 / S2)

Date: 2026-11-10. Scratch (kept, not deleted): `/private/tmp/overhead-1494-X8jpvt`.

## Verdict

| Criterion (S1/S2): A ≤ 1.5x B, median | Ratio A/B | Result |
|---|---|---|
| Wall time, full delegation with sol-low parent + terra-max workers (A1–A3; parent forced to sol low by the benchmark, not a real configuration) | **7.38x** (316.7 s / 42.9 s) | **FAIL** |
| Tool calls, parent top-level | 0.71x (10 / 14) | pass |
| Tool calls, parent with `codemode` inner calls expanded | 1.29x (18 / 14) | pass |
| Tool calls, parent + child workers | **3.00x** (42 / 14) | FAIL |
| Parent tokens (total) | 3.15x (274,458 / 87,211) | n/a (not in criterion) |
| Parent + child tokens | 5.76x (502,294 / 87,211) | n/a |
| Organic mode (n=3, AO1–AO3 vs B1–B4): wall / effective calls / parent tokens | 1.19x / 1.21x / 4.35x | wall + calls **pass** |
| Full delegation, Astra-medium orchestrator + NaN DeepSeek Flash workers (AF1/AF4/AF5 vs B1–B4+B6): wall / effective calls / parent+child calls | 3.23x / 1.29x / 2.57x | **FAIL** (wall, total calls) |
| Full delegation, user's real profile: Astra-medium orchestrator + terra-max workers (AT1–AT3 vs B1–B4+B6+B7): wall / effective calls / parent+child calls | 3.88x / 1.29x / 2.86x | **FAIL** (wall, total calls) |

The A1–A3 rows (and every "A" or "sol-low + terra-max" label below) describe a configuration that does not exist in practice. The benchmark forced the parent to `openai-codex/gpt-6.1-sol` at `low` while the profile routed workers to terra-max. The user's real full-delegation configuration is the AT arm.

The ratios above for full-delegation use B1–B3 (median 42.9 s). Against the B1–B4 median (45.15 s), full-delegation wall time is 7.01x; the call ratios do not change, and parent tokens are 3.12x. See "Organic arm (n=3)" below.

Current main no longer shows the original failure classes: zero `gentle_review` calls, zero `gentle_odd_phase` calls, no ODD file or `.gitignore`/`.atl/` in the target repo, no per-test verifier subagents. The remaining wall-time overhead in the user's default mode comes from **full-delegation mode**: the parent sends every fix to a `gentle-ai-worker`. Those workers run on the profile's routed model, `openai/gpt-6.1-terra` at `max` thinking, not the parent's `gpt-6.1-sol`/`low` (a benchmark-forced parent, not a real configuration; see the AT section for the user's real profile). Subagent calls take 197–370 s of the 258–449 s wall time (63–82%). In organic mode (n=3) the same harness ran inline and stayed within the bound for both time and calls.

## Setup

- Code under test: worktree `.worktrees/overhead-1494`, HEAD `116c0e997` (origin/main), package version 4.7.0. Launched as `node <worktree>/bin/gentle-shell.mjs`. The default package root is the worktree, and the isolated home declares no gentle-pi, so the launcher injects the worktree's own copy (plain injection, no take-over).
  - Verified from the session files: skills load from `<worktree>/skills/...`, and the prompt references `<worktree>/assets`. `node_modules` is a symlink to the main checkout's `node_modules`, so the Pi runtime is that checkout's `@earendil-works/pi-coding-agent`.
- Pi 1.5.0 (both arms). Python 3.14.7. Engram v3.0.0-20261007205017 (shared server).
- Home: isolated `~/.gentle-shell/agent` for both arms (see Caveat 2). Packages in its settings: `pi-web-access`, `pi-btw`, `pi-claude-bridge`, `gentle-engram@0.4.2`. Arm A loads all of them; arm B's `--no-extensions` drops their extensions, but user skills still load (B system prompt is about 15 KB vs. 54 KB for A).
- Model: `openai-codex/gpt-6.1-sol`, thinking `low`, for both parents. The session files confirm `model_change openai-codex/gpt-6.1-sol` and `thinking_level_change low`. The profile's `orchestrator` key (`openai/gpt-6-astra`) did not override the CLI `--model`.
- Workflow mode: active profile `openai-oauth-delegation` in `~/.gentle-shell/gentle-ai/profiles.json`, with `workflow.openai-oauth-delegation.orchestratorMode = "full-delegation"`.
  - Confirmed in the session system prompts: A1–A3 contain `You are a COORDINATOR in full delegation mode`.
  - Per-run override without editing config: env `GENTLE_PI_ORCHESTRATOR_MODE=organic` (`lib/orchestrator-mode-policy.ts:7`). AO1 used it, and its prompt contains the organic `You are a COORDINATOR, not the default executor`.
  - The same profile routes `gentle-ai-worker` to `openai/gpt-6.1-terra` with `max` thinking. Subagent `details` confirm this for every worker call.
- Fixture: the issue's `inventory.py` verbatim, plus `tests/__init__.py` and `tests/test_inventory.py`. `ITEMS = [pear:5, apple:2, fig:9]`, and the tests are `InventoryTest.test_total_stock` (`== 16`), `test_parse_price_with_thousands` (`parse_price("$1,234.50") == 1234.50`), and `test_low_stock_inclusive_and_sorted` (`low_stock(ITEMS, 5) == ["apple", "pear"]`). Baseline: 3 tests, `FAILED (failures=2, errors=1)`. Each run copied `fixture2/` into `runs/<id>`, ran `git init`, and committed it.
- Prompt: the issue's prompt verbatim (`/private/tmp/overhead-1494-X8jpvt/prompt.txt`).
- Order: A1, B1, A2, B2, A3, B3 (interleaved), then AO1. Follow-up: AO2, B4, AO3. One run per slot, timeout 900 s, all exit 0. No model run was retried (see "Excluded runs").

### Exact commands (`/private/tmp/overhead-1494-X8jpvt/run.sh`)

```bash
CLEAN="env -i HOME=$HOME PATH=$PATH USER=$USER LOGNAME=$USER SHELL=/bin/bash LANG=en_US.UTF-8 TERM=dumb TMPDIR=/tmp"
MODEL=openai-codex/gpt-6.1-sol; THINK=low
WT=~/work/gentle-pi/.worktrees/overhead-1494
# B (bare + todo)
$CLEAN PI_CODING_AGENT_DIR=$HOME/.gentle-shell/agent timeout 900 pi -p --mode json --no-extensions \
  -e $WT/extensions/gentle-todo.ts --model $MODEL --thinking $THINK --session-dir $S/sess/$id "$PROMPT" </dev/null
# A (gentle-shell from the worktree, user default = full delegation)
$CLEAN GENTLE_SHELL_SKIP_STARTUP_UPDATE=1 timeout 900 node $WT/bin/gentle-shell.mjs -p --mode json \
  --model $MODEL --thinking $THINK --session-dir $S/sess/$id "$PROMPT" </dev/null
# AO (diagnostic, organic)
$CLEAN GENTLE_PI_ORCHESTRATOR_MODE=organic GENTLE_SHELL_SKIP_STARTUP_UPDATE=1 timeout 900 node $WT/bin/gentle-shell.mjs -p --mode json \
  --model $MODEL --thinking $THINK --session-dir $S/sess/$id "$PROMPT" </dev/null
# after each run, in the run repo:
git status --short --untracked-files=all; python3 -m unittest
```

Analysis scripts: `tools/analyze.py`, `tools/table.py`, `tools/effective.py`, and `tools/children.py` under the scratch directory.

## Per-run results

"Eff calls" counts parent tool calls with each `codemode` script's inner `tools.*` calls expanded (regex count). Tokens are parent-session sums of `usage`: input / output / cacheRead / total. Every run created no file in the target repo beyond the `M inventory.py` edit and untracked `__pycache__/` from the `python3` runs.

| Run | Tests | Wall s | Top calls | Eff calls | subagent run+continue | mem_* | todo | odd_phase | review | Parent tokens in/out/cache/total | Child calls | Child tokens total |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 | 3/3 | 449.3 | 13 | 16 | 1+2 (worker) | 1 | 4 | 0 | 0 | 28,078 / 1,117 / 317,184 / 346,379 | 24 | 205,086 |
| B1 | 3/3 | 39.6 | 13 | 13 | 0 | 0 | 4 | 0 | 0 | 7,706 / 659 / 73,344 / 81,709 | – | – |
| A2 | 3/3 | 316.7 | 10 | 18 | 1+2 (worker) | 3 | 4 | 0 | 0 | 29,640 / 1,402 / 239,616 / 270,658 | 24 | 230,619 |
| B2 | 3/3 | 58.2 | 14 | 14 | 0 | 0 | 4 | 0 | 0 | 14,449 / 698 / 72,064 / 87,211 | – | – |
| A3 | 3/3 | 257.6 | 10 | 18 | 3+0 (worker) | 3 | 4 | 0 | 0 | 27,434 / 1,520 / 245,504 / 274,458 | 26 | 227,836 |
| B3 | 3/3 | 42.9 | 14 | 14 | 0 | 0 | 5 | 0 | 0 | 8,045 / 643 / 80,000 / 88,688 | – | – |
| AO1 (organic) | 3/3 | 50.5 | 15 | 16 | 0 | 3 | 4 | 0 | 0 | 24,921 / 1,062 / 333,824 / 359,807 | – | – |

Tool calls by name (effective):

- A1: bash 3, read 3, subagent_list_agents 1, todo 4, orchestrator_session_id 1, subagent_run 1, subagent_continue 2, mem_save 1.
- A2: bash 3, read 3, subagent_list_agents 1, orchestrator_session_id 1, todo 4, subagent_run 1, subagent_continue 2, mem_save 3.
- A3: bash 3, read 3, subagent_list_agents 1, orchestrator_session_id 1, todo 4, subagent_run 3, mem_save 3.
- AO1: todo 4, bash 4, read 2, edit 3, mem_save 3.
- B1: todo 4, bash 4, read 2, edit 3. B2: todo 4, bash 5, read 2, edit 3. B3: todo 5, bash 4, read 2, edit 3.

Child (worker) calls: A1 bash 14, read 6, edit 3, find 1. A2 bash 13, read 6, edit 3, find 2. A3 bash 14, read 7, edit 3, find 2. All children ran `openai/gpt-6.1-terra` at `max`.

Subagent time inside the parent (call → result): A1 369.9 s, A2 199.5 s, A3 196.6 s.

Final todo state: all 3 tasks `done` in every run. A3's todo calls were all inside `codemode`; its final output was `3 tasks · 3 done`.

### Medians and ratios

| Metric | A median | B median | A/B |
|---|---|---|---|
| Wall time | 316.7 s | 42.9 s | 7.38x |
| Top-level tool calls | 10 | 14 | 0.71x |
| Effective parent calls | 18 | 14 | 1.29x |
| Parent + child calls | 42 | 14 | 3.00x |
| Parent tokens total | 274,458 | 87,211 | 3.15x |
| Parent input (uncached) | 28,078 | 8,045 | 3.49x |
| Parent output | 1,402 | 659 | 2.13x |
| Parent + child tokens | 502,294 | 87,211 | 5.76x |
| Engram ops | 3 | 0 | – |

Engram observations written to the throwaway fixture projects: 18 in total, across projects `a1` (3: one each from A1, A1-contaminated, and A1-pycfixture), `a2` (3), `a3` (3), `ao1` (3), `ao2` (3), and `ao3` (3). Each one matches a parent `mem_save`, some of them called inside `codemode`. B wrote none.

## Organic arm (n=3)

Same setup as AO1 for every run: `env -i`, home `~/.gentle-shell/agent`, `openai-codex/gpt-6.1-sol` `low`, `fixture2/` in a fresh repo, `GENTLE_PI_ORCHESTRATOR_MODE=organic`. All three system prompts contain the organic block and none contain the full-delegation one. Stderr was empty and the run repos show only `M inventory.py` (plus untracked `__pycache__/`). B4 was interleaved between AO2 and AO3 to show timing drift; at 47.4 s it falls inside the B1–B3 range (39.6–58.2 s).

| Run | Tests | Wall s | Top calls | Eff calls | Subagents | mem_save | todo | odd_phase | review | Parent tokens in/out/cache/total |
|---|---|---|---|---|---|---|---|---|---|---|
| AO1 | 3/3 | 50.5 | 15 | 16 | 0 | 3 | 4 | 0 | 0 | 24,921 / 1,062 / 333,824 / 359,807 |
| AO2 | 3/3 | 53.6 | 17 | 17 | 0 | 3 | 4 | 0 | 0 | 25,282 / 1,095 / 377,344 / 403,721 |
| AO3 | 3/3 | 60.1 | 16 | 17 | 0 | 3 | 4 | 0 | 0 | 47,778 / 1,114 / 333,696 / 382,588 |
| B4 | 3/3 | 47.4 | 14 | 14 | 0 | 0 | 5 | 0 | 0 | 14,321 / 639 / 73,600 / 88,560 |

Effective calls by name:

- AO1: todo 4, bash 4, read 2, edit 3, mem_save 3.
- AO2: todo 4, bash 5, read 2, edit 3, mem_save 3.
- AO3: todo 4, bash 5, read 2, edit 3, mem_save 3. AO1 and AO3 each had one `codemode` call with 2 `read`s inside.
- B4: todo 5, bash 4, read 2, edit 3.

The only `mem_*` operation is `mem_save`; none ran inside `codemode`. Engram observations: `ao1` (3), `ao2` #26950–26952, `ao3` #26953–26955.

| Metric (median) | Organic AO1–AO3 | B1–B4 | AO/B | ≤1.5x |
|---|---|---|---|---|
| Wall time | 53.6 s | 45.15 s | **1.19x** | ✅ |
| Effective tool calls | 17 | 14 | **1.21x** | ✅ |
| Top-level tool calls | 16 | 14 | 1.14x | ✅ |
| Parent tokens total | 382,588 | 87,885.5 | 4.35x | – |
| Parent input (uncached) | 25,282 | 11,183 | 2.26x | – |
| Parent output | 1,095 | 651 | 1.68x | – |
| Parent cacheRead | 333,824 | 73,472 | 4.54x | – |
| Subagent runs | 0 | 0 | – | – |
| mem_* ops | 3 | 0 | – | – |

B1–B4 values: wall 39.6 / 58.2 / 42.9 / 47.4 s; effective calls 13 / 14 / 14 / 14; tokens 81,709 / 87,211 / 88,688 / 88,560.

Organic token overhead is mostly the larger always-on prompt read from cache: the system prompt is about 56 KB in organic runs vs. 15 KB in B.

### Organic `mem_save` titles (per-fix saves, for T4)

| Run | Fix 1 (total_stock) | Fix 2 (parse_price) | Fix 3 (low_stock) |
|---|---|---|---|
| AO1 | T5 `Fix inventory total skipping first item` | T9 `Fix inventory price thousands separators` | T13 `Fix inclusive sorted inventory low-stock results` |
| AO2 | T6 `Fix inventory total skipping first item` | T10 `Fix inventory price thousands parsing` | T14 `Fix inclusive sorted inventory low-stock results` |
| AO3 | T5 `Fix total stock skipping first item` | T9 `Fix price parsing with thousands separators` | T13 `Fix inclusive sorted low-stock results` |

Every organic run repeats the same cycle three times: edit → run the focused test → `mem_save` (alone in its turn) → `todo` (alone in its turn).

- The 3 `mem_save` calls are the entire call excess over B: 17 vs. 14 effective calls.
- Each save is a separate bookkeeping-only turn.
- Bookkeeping-only turns: 7 of 15–17 in organic vs. 4–5 of 13–14 in B. Bookkeeping share of calls: 41–44% vs. 29–36%.

## Astra + DeepSeek Flash (full delegation)

User request (verbatim): "Si querés hacer una prueba creando un perfil o algo que sea orquestador astra y después como subagente de worker y explorador y todo, ponelo con DeepSic 4.1 flash de NAN." Follow-up: orchestrator at medium effort.

The goal is to measure full delegation in its intended setup: an expensive orchestrator with very light workers.

### Setup

- **Model ids** (from `gentle-shell --list-models`):
  - Orchestrator: `openai-codex/gpt-6-astra`, thinking `medium`.
  - Workers: `nan/deepseek-v4-flash`. This is the only DeepSeek Flash on NaN; there is no 4.1. The parent confirmed it is the intended model.
  - NaN lists `deepseek-v4-flash` as adaptive reasoning (`lib/nan-provider.ts:45`), so the selected level does not change its depth. Child sessions record `thinking: max`, inherited because the profile entry sets no level.
- **Profile mechanism:** a pin can only name a profile that already exists in the global store, and a scratch `GENTLE_PI_CONFIG_HOME` would have dropped the user's super-yolo permission mode, which tools cannot copy. With parent authorization I added one profile to `~/.gentle-shell/gentle-ai/profiles.json`. `active` and every other profile are unchanged.
  - Backup: `/private/tmp/overhead-1494-X8jpvt/profiles.json.backup-before-bench` (sha1 `cf9fe0c97f33e6616a03740378a406260236d365`).
  - Pure additions; `diff backup new` shows only `472a473,487` and `479a495,497`:

  ```json
  "bench-astra-flash": {
    "orchestrator": { "model": "openai-codex/gpt-6-astra", "thinking": "medium" },
    "gentle-ai-worker": { "model": "nan/deepseek-v4-flash" },
    "gentle-ai-explore": { "model": "nan/deepseek-v4-flash" },
    "gentle-ai-verify": { "model": "nan/deepseek-v4-flash" }
  }
  ```

  plus, under `workflow`: `"bench-astra-flash": { "orchestratorMode": "full-delegation" }`. The profile was left in place.
- **Per-run selection:** a local pin in each run repo, `runs/<id>/.git/gentle-ai/profile-pin.json`, containing `{"kind":"gentle-pi.agent_model_profile_pin","version":1,"profile":"bench-astra-flash"}`. It sits inside `.git/`, so it is invisible to `git status`.
  - Pins route roles only, so the orchestrator model came from the CLI: `... gentle-shell.mjs -p --mode json --model openai-codex/gpt-6-astra --thinking medium ...`.
  - Everything else is the same as arm A: `env -i`, home `~/.gentle-shell/agent`, `fixture2/`, the same prompt, and a 900 s timeout.
- **Confirmed from the session files:**
  - Every parent has `model_change openai-codex/gpt-6-astra` and `thinking medium`.
  - Every system prompt contains `COORDINATOR in full delegation mode`.
  - Every subagent result reports `model: nan/deepseek-v4-flash`, and every child session has `model_change nan/deepseek-v4-flash`. This also shows the pin's routing was applied.
  - All stderr was empty. Only `M inventory.py` appears in each repo (plus untracked `__pycache__/`).
- **Order:** AF1 ran on its own. B5, AF2 and AF3 then ran **concurrently** by mistake: all three started at 17:01:29Z because they were issued in one tool batch. With parent approval, AF4, B6 and AF5 then ran strictly one at a time.
  - Medians use AF1 + AF4 + AF5 and B1–B4 + B6.
  - AF2, AF3 and B5 are reported as labeled concurrent extras, outside the medians.

### Results

"Parent eff" counts parent calls with `codemode` inner calls expanded.

- **Cost:** Pi's per-message `usage.cost`, an estimate from the catalog price (`totalFromProvider: false`). NaN children record $0 because NaN models carry no price in Pi's catalog, so child cost is reported as tokens only.
- **Sub s:** time from each subagent call to its result in the parent.

| Run | Tests | Wall s | Parent eff | Subagents run+cont | Child calls | mem_save | todo | Parent tokens in/out/cache/total | Child tokens total | Parent cost $ | Sub s |
|---|---|---|---|---|---|---|---|---|---|---|---|
| AF1 | 3/3 | 153.1 | 17 | 3+0 | 23 | 3 | 4 | 27,303 / 1,599 / 199,424 / 228,326 | 230,077 | 0.552 | 94.6 |
| AF4 | 3/3 | 135.3 | 18 | 1+2 | 12 | 3 | 4 | 28,155 / 1,460 / 274,176 / 303,791 | 173,645 | 0.629 | 65.4 |
| AF5 | 3/3 | 155.7 | 20 | 1+2 | 16 | 3 | 4 | 28,417 / 1,470 / 225,536 / 255,423 | 207,934 | 0.583 | 82.2 |
| B6 | 3/3 | 47.8 | 13 | 0 | – | 0 | 4 | 13,888 / 645 / 67,072 / 81,605 | – | 0.041 | – |
| *AF2 (concurrent)* | 3/3 | 136.4 | 18 | 1+2 | 13 | 3 | 4 | 27,579 / 1,303 / 248,320 / 277,202 | 188,174 | 0.589 | 66.1 |
| *AF3 (concurrent)* | 3/3 | 153.5 | 17 | 3+0 | 20 | 3 | 4 | 27,820 / 1,552 / 200,832 / 230,204 | 208,641 | 0.557 | 90.5 |
| *B5 (concurrent)* | 3/3 | 49.4 | 15 | 0 | – | 0 | 5 | 14,450 / 686 / 79,872 / 95,008 | – | 0.044 | – |

All five AF runs used `gentle-ai-worker` only, with zero explore or verify agents, and made 0 `gentle_review` and 0 `gentle_odd_phase` calls.

Parent tools (effective):

- AF1: read 3, bash 2, subagent_list_agents 1, todo 4, orchestrator_session_id 1, subagent_run 3, mem_save 3.
- AF4: bash 3, read 3, subagent_list_agents 1, orchestrator_session_id 1, todo 4, subagent_run 1, subagent_continue 2, mem_save 3.
- AF5: bash 6, subagent_list_agents 1, read 2, orchestrator_session_id 1, todo 4, subagent_run 1, subagent_continue 2, mem_save 3.

Child tools: AF1 bash 14, read 6, edit 3. AF4 bash 7, read 2, edit 3. AF5 bash 9, read 4, edit 3.

All 3 `mem_save` calls ran inside `codemode` in every AF run. `todo` calls inside `codemode`: 4 of 4 (AF1), 2 of 4 (AF4), 3 of 4 (AF5).

AF `mem_save` titles (one per fix):

| Run | Titles |
|---|---|
| AF1 | `Fix inventory total stock counting`, `Fix inventory price thousands parsing`, `Fix inclusive sorted low stock results` |
| AF4 | `Fix total stock skipping first item`, `Fix price parsing thousands separators`, `Fix inclusive sorted low stock results` |
| AF5 | `Fix inventory total stock counting`, `Fix inventory comma price parsing`, `Fix inclusive sorted inventory low stock` |

Engram: 15 observations in projects `af1`–`af5` (#26957–26971).

Bookkeeping share: 8 of 17–20 effective calls (40–47%). Bookkeeping-only turns: 2 of 8 (AF1), 4 of 11 (AF4), 1 of 9 (AF5).

### Medians and ratios

B baseline is the median of B1–B4 + B6: wall 47.4 s, 14 effective calls, 87,211 parent tokens, $0.041. For comparison, the other arms are re-expressed against the same B median.

| Metric (median) | AF Astra-med + Flash | AF/B | Full-deleg sol-low + terra-max (A1–A3; parent forced to sol low by the benchmark, not a real configuration) | A/B | Organic (AO1–AO3) | AO/B |
|---|---|---|---|---|---|---|
| Wall time | 153.1 s | **3.23x** ❌ | 316.7 s | 6.68x ❌ | 53.6 s | **1.13x** ✅ |
| Parent effective calls | 18 | 1.29x ✅ | 18 | 1.29x ✅ | 17 | 1.21x ✅ |
| Parent + child calls | 36 | **2.57x** ❌ | 42 | 3.00x ❌ | 17 | 1.21x ✅ |
| Parent tokens | 255,423 | 2.93x | 274,458 | 3.15x | 382,588 | 4.39x |
| Parent + child tokens | 463,357 | 5.31x | 502,294 | 5.76x | 382,588 | 4.39x |
| Subagent time / wall | 82.2 s (54%) | – | 199.5 s (63%) | – | 0 | – |
| Cost (Pi estimate) | $0.583 parent + NaN unpriced | 14.3x (parent only) | $0.163 parent + child | 3.98x | $0.099 | 2.43x |

Reading:

- With the intended setup, full delegation halves wall time against sol/terra-max (153 s vs. 317 s) but still fails the ≤1.5x criterion at 3.2x.
- The floor is structural: three serial worker round-trips, 65–95 s in total, plus Astra-medium parent turns. Wall time minus subagent time leaves 58–74 s for the parent's own 8–11 turns.
- Cheap workers do not make the parent cheap. Astra at medium costs about $0.58 per run on its own, 14x the bare run and 6x the organic run, because the parent still carries the full always-on prompt across 8–11 turns.
- Organic remains the only configuration within the bound on this task.

## Astra + Terra (full delegation, user's real profile)

User request (verbatim): "lo que sería el benchmark de Full Delegation lo hiciste con Sol Low y Terra Max. No, la idea era Astra con Terra, justamente para hacer la comparativa entre Astra y DeepSeek."

### Setup

Exactly the AF setup (`fixture2/`, same prompt, `env -i`, home `~/.gentle-shell/agent` with super-yolo preserved, fresh repo per run, orchestrator `--model openai-codex/gpt-6-astra --thinking medium`, 900 s timeout). Only the pin changes: each run repo gets `.git/gentle-ai/profile-pin.json` set to `{"kind":"gentle-pi.agent_model_profile_pin","version":1,"profile":"openai-oauth-delegation"}`, the user's real active profile.

That profile routes:

- `gentle-ai-worker`: `openai/gpt-6.1-terra` @ `max`
- `gentle-ai-explore`: terra @ `medium`
- `gentle-ai-verify`: `openai/gpt-6.1-sol` @ `high`

Its workflow is full-delegation. `profiles.json` was not modified for this arm: sha1 `0f5c4895…` before and after, and `active` is still `openai-oauth-delegation`.

Run order: AT1, B7, AT2, AT3, strictly one at a time, each in its own awaited tool call.

Confirmed from the session files:

- Every parent has `model_change openai-codex/gpt-6-astra` and `thinking medium`.
- Every system prompt contains `COORDINATOR in full delegation mode`.
- Every subagent result reports `openai/gpt-6.1-terra` with `thinking max`, and every child session has the same model and level.
- Stderr was empty, and each repo shows only `M inventory.py` (plus untracked `__pycache__/`).

### Results

Cost is Pi's estimate from catalog prices (`totalFromProvider: false`).

| Run | Tests | Wall s | Parent eff | Subagents run+cont | Child calls | mem_save | todo | Parent tokens in/out/cache/total | Child tokens total | Parent $ | Child $ | Total $ | Sub s (share) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| AT1 | 3/3 | 182.5 | 18 | 1+2 | 22 | 3 | 4 | 27,147 / 1,498 / 323,584 / 352,229 | 204,085 | 0.670 | 0.051 | 0.721 | 119.3 (65%) |
| AT2 | 3/3 | 176.7 | 17 | 1+2 | 23 | 3 | 4 | 26,734 / 1,369 / 222,976 / 251,079 | 246,766 | 0.559 | 0.049 | 0.608 | 124.7 (71%) |
| AT3 | 3/3 | 176.2 | 18 | 1+2 | 28 | 3 | 4 | 27,414 / 1,396 / 247,680 / 276,490 | 245,374 | 0.592 | 0.063 | 0.655 | 123.3 (70%) |
| B7 | 3/3 | 43.6 | 14 | 0 | – | 0 | 5 | 7,774 / 637 / 79,872 / 88,283 | – | 0.030 | – | 0.030 | – |

All three AT runs used `gentle-ai-worker` only (zero explore or verify agents) and made 0 `gentle_review` and 0 `gentle_odd_phase` calls.

Parent tools (effective):

- AT1: bash 3, read 2, find 1, subagent_list_agents 1, orchestrator_session_id 1, todo 4, subagent_run 1, subagent_continue 2, mem_save 3.
- AT2: bash 2, read 3, subagent_list_agents 1, orchestrator_session_id 1, todo 4, subagent_run 1, subagent_continue 2, mem_save 3.
- AT3: bash 3, read 3, subagent_list_agents 1, orchestrator_session_id 1, todo 4, subagent_run 1, subagent_continue 2, mem_save 3.

Child tools: AT1 bash 13, read 6, edit 3. AT2 bash 14, read 6, edit 3. AT3 bash 18, read 6, edit 3, find 1.

Bookkeeping: 8 of 17–18 effective calls (44–47%). Bookkeeping-only turns: 7 of 13 (AT1), 3 of 9 (AT2), 3 of 10 (AT3).

AT `mem_save` titles (one per fix):

| Run | Titles |
|---|---|
| AT1 | `Fix total_stock including first item`, `Fix inventory price thousands separators`, `Fix inclusive sorted low stock results` |
| AT2 | `Fix inventory stock aggregation`, `Fix inventory comma price parsing`, `Fix inclusive sorted low stock results` |
| AT3 | `Fix total_stock first-item omission`, `Fix price parsing thousands separators`, `Fix inclusive sorted low-stock results` |

Engram: 9 observations in projects `at1`–`at3` (#26973–26985).

### Side by side

B baseline is the median of B1–B4 + B6 + B7: wall 45.5 s (B values 39.6 / 58.2 / 42.9 / 47.4 / 47.8 / 43.6), 14 effective calls, 87,747 parent tokens, $0.0357. B5 (concurrent) is excluded. Arm medians come from their own runs; ratios are against this B.

| Metric (median) | AT Astra-med + terra-max (real profile) | AF Astra-med + NaN Flash | Organic (AO1–AO3) | Sol-low + terra-max (A1–A3; parent forced to sol low by the benchmark, not a real configuration) | B |
|---|---|---|---|---|---|
| Wall time | 176.7 s (**3.88x** ❌) | 153.1 s (**3.36x** ❌) | 53.6 s (**1.18x** ✅) | 316.7 s (6.96x ❌) | 45.5 s |
| Parent effective calls | 18 (1.29x ✅) | 18 (1.29x ✅) | 17 (1.21x ✅) | 18 (1.29x ✅) | 14 |
| Parent + child calls | 40 (2.86x ❌) | 36 (2.57x ❌) | 17 (1.21x ✅) | 42 (3.00x ❌) | 14 |
| Parent tokens | 276,490 (3.15x) | 255,423 (2.91x) | 382,588 (4.36x) | 274,458 (3.13x) | 87,747 |
| Child tokens | 245,374 | 207,934 | 0 | 227,836 | 0 |
| Parent + child tokens | 521,864 (5.95x) | 463,357 (5.28x) | 382,588 (4.36x) | 502,294 (5.72x) | 87,747 |
| Subagent time share | 70% | 53% | 0% | 63% | 0% |
| Cost, parent | $0.592 (16.6x) | $0.583 (16.3x) | $0.099 (2.8x) | $0.097 (2.7x) | $0.036 |
| Cost, child | $0.051 | unpriced (NaN = $0 in Pi's catalog) | $0 | $0.064 | $0 |
| Cost, total | $0.655 (**18.3x**) | ≥ $0.583 (≥ 16.3x) | $0.099 (2.8x) | $0.163 (4.6x) | $0.036 |

The AF "subagent time share" median is taken over AF1/AF4/AF5 (62%, 48%, 53%).

Reading:

- **Speed:** Astra + Flash is about 24 s faster than Astra + Terra, in both wall time (153 s vs. 177 s) and subagent time (82 s vs. 123 s). Both fail ≤1.5x by a wide margin.
- **Cost:** in both Astra arms, the Astra-medium parent is about 90% of the estimated cost ($0.56–0.67 per run). Terra-max workers add only about $0.05. Switching workers to DeepSeek Flash therefore saves time but almost no money on this task; the orchestrator choice dominates cost.
- **Calls:** the parent shape is identical across all full-delegation arms: 17–18 effective calls, one worker task per fix, and one `mem_save` per fix.
- **Only passing configuration:** organic remains the only configuration within the ≤1.5x bound.

## Bookkeeping attribution (for T4)

Bookkeeping = `todo`, `mem_*`, `gentle_odd_phase`, `orchestrator_session_id`.

| Run | Effective calls | Bookkeeping calls | Share | Tool turns | Bookkeeping-only turns |
|---|---|---|---|---|---|
| A1 | 16 | 6 | 38% | 13 | 6 |
| A2 (median) | 18 | 8 | 44% | 10 | 3 |
| A3 | 18 | 8 | 44% | 10 | 3 |
| AO1 / AO2 / AO3 (organic) | 16 / 17 / 17 | 7 / 7 / 7 | 44% / 41% / 41% | 15 / 17 / 16 | 7 / 7 / 7 |
| B1 / B2 / B3 / B4 | 13 / 14 / 14 / 14 | 4 / 4 / 5 / 5 | 31% / 29% / 36% / 36% | 13 / 14 / 14 / 14 | 4 / 4 / 5 / 5 |

Median A run (A2), in order:

| Turn | Calls | Purpose | Bookkeeping-only? |
|---|---|---|---|
| T0 | bash | `pwd; git status; ls`: orient | no |
| T1 | codemode[read, bash, subagent_list_agents] | read source, baseline `python3 -m unittest`, list agents | no |
| T2 | codemode[read, read, orchestrator_session_id, todo] | read tests, read `orchestrator-full-delegation-card.md`, name session, write 3-task list | no (mixed) |
| T3 | subagent_run gentle-ai-worker | fix `total_stock` | no |
| T4 | codemode[mem_save, todo] | save fix 1 to Engram, mark task 1 done | **yes** |
| T5 | subagent_continue | fix `parse_price` | no |
| T6 | codemode[mem_save, todo] | save fix 2, mark task 2 done | **yes** |
| T7 | subagent_continue | fix `low_stock` | no |
| T8 | codemode[mem_save, bash] | save fix 3, final `python3 -m unittest` + diff | no (mixed) |
| T9 | todo | mark all done | **yes** |

Reading of the data:

- The bookkeeping share in A (38–44%) is above B (29–36%). The excess comes almost entirely from `mem_save` (one per fix, i.e. "save after each bug fix" applied literally) plus one `orchestrator_session_id`.
- `todo` counts are the same in both arms (4 vs. 4–5), because the prompt explicitly asks for a task list.
- Bookkeeping is not where the time goes. Bookkeeping `codemode` scripts run in 0.1–0.2 s, and each bookkeeping-only turn costs one parent model turn. The wall-time excess is the worker subagents (63–82% of A's wall time).
- In organic mode (n=3), the same 3× `mem_save` pattern appears as 3 extra separate turns, yet wall time stays at 1.19x.

## Excluded runs (reported, not counted)

| Run | Wall s | Why excluded |
|---|---|---|
| A1-contaminated | 42.2 | Launched with this worker's own environment, which carries `GENTLE_PI_AGENTS_CHILD=1`, `GENTLE_SHELL_CHILD_PACKAGE_INJECTION` (pointing at the main checkout), `PI_SESSION_*`, and `HERDR_*`. The harness treated the primary as a child: no orchestrator workflow block, no `todo` tool, and child safety blocked a `git restore`. Not representative. Every counted run uses `env -i`. |
| A1-pycfixture | 566.4 | The first fixture copy had `__pycache__/*.pyc` committed (setup mistake: unittest was run in the fixture before committing). The model spent 2 extra worker subagents restoring the `.pyc` files (5 `subagent_run` in total). Fixed by `fixture2/` without bytecode. |
| B1-authfail | 3.2 | Plain `pi` home `~/.pi/agent` failed with `OAuth refresh failed for openai-codex … refresh_token_reused` before any model output. No model turn happened. B was then pointed at the same home as A (`PI_CODING_AGENT_DIR=~/.gentle-shell/agent`). Credentials were not touched. |

## Caveats

1. n=3 for full-delegation A, n=3 for organic, n=4 for B. One task, one model.
2. Both arms share the isolated home and its OpenAI Codex login. This deviates from the issue's B command (default Pi home) only because that home's token was stale. B still loads user skills.
3. "Same model and effort" holds for the parent sessions only. Under the user's profile, full-delegation workers run `openai/gpt-6.1-terra` at `max` on provider `openai`, which is a large part of A's time.
4. `codemode` hides inner tool calls in top-level counts. Effective counts come from a regex over the script text.
5. Wall time is measured around the whole launcher process, so it includes gentle-shell startup and Engram.
6. Engram is the user's shared server. The fixture observations are in projects `a1`, `a2`, `a3`, `ao1`, `ao2`, `ao3`, `af1`–`af5`, `at1`–`at3` (42 in total) and were not deleted.
7. The AF arm added a `bench-astra-flash` profile to the user's `profiles.json` (see the Astra section for the backup and the exact lines). B5, AF2 and AF3 ran concurrently and are excluded from the medians.
8. The AT arm used the user's existing `openai-oauth-delegation` profile through a scratch pin. No config change was made.
