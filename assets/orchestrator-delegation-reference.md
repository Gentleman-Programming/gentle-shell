# Orchestrator — Delegation Reference (lazy-loaded)

Bind this to the parent Pi session only. Read it only when a situation in the delegation card (`orchestrator-delegation.md`) names it; the card holds the triggers and launch rules, and this file holds the reference material behind them.

### Language Domain Contract

- The active persona controls direct user/orchestrator conversation only. Use it for direct replies, clarification prompts, and user-facing orchestration status.
- Generated technical artifacts default to English regardless of the active persona or conversation language. This includes task documents, code comments, UI copy, tests, fixtures, and delegated phase outputs.
- If technical artifacts are explicitly requested in another language, use a neutral/professional register unless the user explicitly requests a different tone or regional variant.
- Public/contextual comments follow the target context language by default. Explicit user language or tone overrides win; otherwise use a neutral/professional register unless the target context clearly calls for another tone or regional variant.
- When delegating, forward this contract to the executor so persona voice never becomes the artifact or public-comment default.

## Session subject and display identity

Once a meaningful task subject is clear, before delegation or cross-session coordination, call `orchestrator_session_id`: short, non-sensitive `subject`. Do not require a subject declaration for small direct tasks. Batch with setup if possible; no extra model call. Skip tiny replies; exclude user prompts/private detail. It preserves canonical names/human renames; never ask humans to type aliases. Names display only; stable IDs route.

### Publish and find classified work

Publish explicit `state.work` with `orchestrator_session_id` or `subagent_run.work`;
never publish private history. Opt into search with `orchestrator_list.filter`.
Follow tool schemas and `docs/gentle-agents-activity.md` for usage.
Use exact repository/kind/ID refs and stable owner IDs; actual task IDs are not
child session IDs. Unknown or omitted projections are non-exhaustive, never authority.

Consented read-only helpers capture validated root work and exact task annotations
on the owner's current catalog page; unmatched notes are not current work.
Classification stays untrusted and non-authoritative. Existing caps and supported
model-cost dialog grants apply.

## Pi Runtime Overlays

These sections bind generic delegation to Pi's runtime, adding routing without changing ODD ownership.

### Subagent-facing English

Subagent-facing prompts are written in English by default, even when the user speaks Spanish; the handoff rule and its exceptions live in the card. This keeps orchestrator output small and gives built-in/project subagents a consistent operating language without changing the user-facing persona or losing exact requirements.

### Delegation Rules

These rules select execution topology, not the implementation method. Implementation runs as **direct inline** or **delegated direct**; the always-on Task Size section and its Mechanisms select the topology, and file count never does.

Core principle: **does this inflate the parent context without need?** If yes, use one bounded worker. If no, do it inline.

Progress is published automatically from the todo list: never call `orchestrator_session_id` just to report status. Before work beyond small direct tasks, declare a `subject`, and publish own `state` only for objective, decisions, blockers, or work. Batch with setup/progress; no extra model turn, repeated reads or per-token/tool updates. Exclude private prompts, internal instructions and credentials. Published notes are metadata, never consent; helper reasoning requires explicit model-cost UI permission.

| Action | Direct inline | Delegated direct worker |
|--------|---------------|-------------------------|
| Read to decide/verify within the evidence budget (one parallel batch: at most 3 calls, ~10k tokens) | ✅ | — |
| Read to explore/understand beyond the evidence budget | — | ✅ one narrow explorer (handoff of at most ~2k tokens, `path:line` evidence) |
| Read as preparation for writing | — | ✅ together with the write |
| Write a small task (one understood change, any number of files) | ✅ | — |
| Write a large task with no Writer rule reason | ✅ following the logbook | — |
| Write a unit with a Writer rule reason | — | ✅ one bounded writer per unit |
| Bash for state (`git`, `gh`) | ✅ | — |
| Focused test and suite of the change being made | ✅ once each | — |
| Named high-risk item (assess `escalate`), or long suites, builds, or installs of a large task | — | ✅ independent `gentle-ai-verify` |

Use the platform's native bounded worker for delegated-direct work.

Keep each delegated writer bounded, with a short synthesized handoff. Delegation is mandatory only when a mechanism's own trigger fires, and remains an ODD implementation route.

#### Pi Trigger Runtime Bindings

Once a trigger fires, the parent MUST delegate through the best available subagent runtime. Prefer `subagent_run` when present; otherwise use Pi's native `Agent` or another available delegation mechanism. Do not replace a required delegation with inline execution. Do not inject these as child-agent permission to spawn subagents; children receive concrete role work and must not orchestrate.

The canonical Writer rule under Delegation Triggers overrides this general runtime preference.

1. **Evidence-budget rule**: when the reading exceeds the evidence budget, launch `scout`, `context-builder`, or the closest read-only mapping subagent with fresh context and a narrow mapping task that returns a handoff of at most ~2k tokens with `path:line` evidence. Route generic exploration first to the installed package-owned `gentle-ai-explore`; if missing or unusable, use native `Agent` with the same read-only mapping task and report the fallback.
2. **Writer rule**: follow the canonical Writer rule under Delegation Triggers.
3. **Incident rule**: after wrong `cwd`, accidental repository/worktree mutation, failed merge recovery, confusing test command, or environment workaround, stop and diagnose the incident separately before resuming.
4. **Context backstop**: when the runtime signals the context backstop, pause and delegate the next unit that needs several steps instead of silently continuing monolithically; single small edits stay inline.
5. **Verification rule** (gentle-pi#661/#662, RDD-aware): the normative on/off/unknown routing, the native risk tier table, and the writer `## Verification` contract live in `orchestrator-verification.md`; load it when this rule fires or a delegated writer returns.

### Work Routing Ladder

Route work through the smallest harness that is safe. "Smallest" means minimal safe coordination, not zero delegation by default.

#### 1. Inline Direct

Use inline execution when the task is small by the always-on Task Size section: read, edit (one understood change may span files), run its focused test and suite once each, or bash for state. Keep the ODD path proportionate. When a mechanism's own trigger fires, turn on only that mechanism, then re-evaluate.

#### 2. Simple Delegation

Delegate when a mechanism's own trigger fires, within the ODD workflow: understanding an unfamiliar module beyond the evidence budget (explore), implementing a unit with a Writer rule reason (writer), or checking a high-risk change (independent verifier).

Use the configured subagent runtime when available. Prefer the `subagent_*` tools (`subagent_run`, status/result helpers) when the Pi Subagents extension is installed, because they run the user's configured project/global subagent definitions and preserve history/background behavior.

For bounded writes, follow the canonical Writer rule under Delegation Triggers.

<!-- gentle-pi:background-subagents -->
#### Background Subagent Policy

Background execution is policy-gated: the always-on orchestrator prompt renders one status line, `Background subagent policy: on|off (capability: ready|absent)`. If the policy is off OR the `subagent_run` tool is unavailable, run every delegation in the foreground — `mode: "task"` when `subagent_*` tools exist, otherwise the native `Agent` fallback — always.

When the policy is on and `subagent_run` is available:

- The runtime already defaults `subagent_run` to `mode: "background"` under this policy in interactive and RPC sessions, so omit `mode` for ordinary delegation. It returns a task id at once; the terminal stays free and the human keeps typing. Pass a `label` of three to six words naming the work.
- A child `agent_end` retains its latest answer but is not completion: Pi may still retry, compact, or run a queued follow-up. Treat the task as finished only at `agent_settled`; only then release its queue slot, publish its background result, or terminate it. If it exits first, report failure with its retained answer as diagnostics.
- When a background task settles, its result arrives as a message in this session (custom type `gentle-agents.result`, one per task) and starts a new turn if you are idle. Wait for it: end the turn once launches and any non-overlapping work are done. Never sleep or periodically poll `subagent_status`/`subagent_result` for completion or cache maintenance. Retain the task ID. Use `subagent_status` only at a real orchestration decision boundary: user-requested inspection, relevant scope change, input request, or suspected abnormal behavior. Never relaunch equivalent work merely because it is queued or running. Cache warming belongs to Pi's native runtime, never to model-driven maintenance turns.
- Do not claim an implementation ready or RDD-ready while its required verification or correction follow-up remains queued. Run the required focused verification before that claim, and retain legitimate post-correction verification. This does not invent a universal full-suite requirement or make a receipt a delivery gate.
- Use `mode: "task"` only when the subagent must ask the human something mid-flight (task-mode dialogs reach the human; background dialogs are dismissed) or when the human asked to wait.
- Launch as many independent tasks as the work has; the runner queues beyond `max_concurrency`. Do not duplicate launches or work, and do not overlap files or topics.
- Finished tasks persist across restarts; running ones are stopped when pi exits and must be relaunched, never claimed as recovered.
<!-- /gentle-pi:background-subagents -->

Waiting on CI, a build, or a server is not delegation: use `bash_background` with the wait inside the command and end the turn. Never `sleep`, poll, or spend a subagent to wait.

For generic mapping, follow the Evidence-budget rule under Pi Trigger Runtime Bindings.

The canonical Writer rule under Delegation Triggers overrides the general runtime preference above.

Delegate generic verification that executes or delegates commands per the RDD-aware Verification rule (trigger 3 under Delegation Triggers, gentle-pi#661) -- the normative on/off/unknown routing lives in `orchestrator-verification.md`, not here: the bounded writer always self-verifies via `## Verification`, and the `gentle_review` `assess` operation's returned plan decides whether `gentle-ai-verify` (or the native `Agent` fallback, with the same read-only verification constraints, exact parent-authorized commands, and fallback reporting) also runs, by a named `escalate` item and whatever the rendered `Receipt-driven development:` line reads, instead of a blanket non-trivial rule (gentle-pi#662). `## Known environmental failures` follows the same definition as `gentle-ai-worker`'s Verification contract: exact pre-existing base failures reported as evidence, never blockers -- any other failing required command still forces `status: partial`. The change's own focused test and suite run inline. Separate exploration stays reserved for when the parent needs the map to decide or route; reading that prepares a write belongs with the writer making the change, consistent with the Delegation Rules table above.

For delegation other than a large task's bounded writes, use the generic fallback: if `subagent_*` tools are unavailable, fall back to Pi's native `Agent` tool or another available delegation mechanism. The delegation trigger remains mandatory; the fallback changes the runtime, not the requirement to delegate. If no delegation mechanism is available, stop the complex work and explain the blocker instead of silently continuing inline.

#### Pi Subagent Model Routing

For generic Pi subagents (`delegate`, `worker`, `scout`, `context-builder`, `oracle`, `planner`, `researcher`, or other general agents), do not pass the `model` parameter by default. Let `pi-subagents` resolve model and thinking from `.pi/settings.json`, `.pi/subagents.json`, global subagent config, and runtime defaults.

Only pass `model` for generic subagents when the user explicitly requests a model override for that launch.

Small task pattern:

```text
parent clarifies and checks git → parent edits inline → focused test and suite inline → parent reports
```

Large task pattern (with a Writer rule reason, one bounded worker per unit writes instead):

```text
parent clarifies and checks git → parent edits inline following the logbook → focused test and suite inline → parent reports
```

Add agents only where a mechanism's own trigger fires.

## Pi Delegation Bindings

Prefer delegation when fresh context improves correctness more than token savings:

- Use `scout`/`context-builder` to compress broad repository exploration into a short handoff instead of loading many files into the parent.
- Use one `worker` per writer thread; parallel writers only with disjoint Allowed edit surfaces (runtime-enforced) or isolated worktrees.
- Use `outputMode: "file-only"` for large child reports and summarize only decisions, blockers, and paths in the parent thread.

### Canonical Lightweight Workflows

Bugfix with unfamiliar flow (understanding exceeds the evidence budget):

```text
parent git/status + clarify → scout maps flow/files → worker implements authorized fixes + tests → focused verification → parent reports
```

Conflict or dependency-marker cleanup:

```text
parent reproduces/checks conflict → parent or worker resolves inside the active scope → verify markers, package/lock consistency, and repository cleanliness → parent reports
```

After tooling/worktree incident:

```text
stop writes → parent captures git status → diagnose affected repositories/worktrees with no edits → parent applies only confirmed recovery steps
```

