# Orchestrator — Delegation Card (lazy-loaded)

Bind this to the parent Pi session only, on delegation or routing triggers. Read `orchestrator-delegation-reference.md` only when a situation names it (per-action table, Work Routing Ladder, workflows, background, fallback, and language detail).

## Handoff

Subagent-facing prompts should be written in English by default, even when the user speaks Spanish. Generated technical artifacts default to English regardless of the persona; forward this to the executor (language domain detail: reference). Write the handoff instructions in English, but never translate, condense, or paraphrase the user's requirements: pass them by reference to the feature document's `## Specs` (`Spec: odd/tasks/<feature>.md (read until "## Log"). Do T#; S#.`), or include the user's request verbatim when no feature document exists.

Exceptions:

- Preserve exact user quotes, UI copy, error messages, filenames, commands, and domain terms in their original language when they are evidence.
- Ask a subagent to produce Spanish only when its output is intended to be pasted directly to the user, a PR/comment/reply in Spanish, or Spanish-language product/documentation text.

Before delegating, publish subject and state via `orchestrator_session_id` (reference).

#### Delegation Triggers

These are parent-orchestrator routing boundaries; do not pass these rules to child agents as permission to orchestrate. Each trigger holds only when its condition truly holds, and only then is it mandatory, not advisory; no trigger holds by default, and when in doubt work inline. When one fires, stop and delegate through the runtime's subagent mechanism before continuing; executing past a fired trigger inline is a routing defect even if the work succeeds.

1. **Ask:** an open product or design decision gets one focused user question; stop and wait.
2. **Mapping trigger (Evidence-budget rule):** read inline only when the evidence fits one parallel batch of at most 3 calls totaling ~10k tokens. When understanding needs more or over ~5 sequential lookups, delegate one explorer returning a handoff of at most ~2k tokens with `path:line` evidence; never for a small targeted question; then re-evaluate task size. Never explore to read files you will read anyway before writing inline.
3. **Verification rule** (gentle-pi#661/#662, RDD-aware): only a change whose Risk line names a high-risk item (Task Size, assess `escalate`) gets an independent `gentle-ai-verify` run after the change's own checks, as rarely as possible; otherwise whoever made the change runs its focused test and suite inline, small tasks included. Routing: `orchestrator-verification.md`.
4. **Track:** a large task gets the feature document, Engram mirror, `todo`, and work-unit commits (`orchestrator-memory.md`).
5. **Writer trigger (Writer rule):** a large task alone never delegates, and file count never fires this trigger. Delegate one bounded writer per unit only for a named reason: (a) parallelism — 2+ independent units of behavior with disjoint edit surfaces, each needing several minutes of work (several files or ~100+ changed lines; a subagent spends 1-2 minutes reading before it writes), launched together; (b) context — the Context backstop below. A unit is one independent piece of behavior with its code, tests, and docs together: never split one behavior into test, docs, and code writers; a delivery that depends on another is not independent; several small independent changes run inline, one after another. Units of about 100 changed lines or less always run inline: writing them costs less than starting workers. The runtime admits writers only for a feature-document task or at the measured context backstop. Never for a price ratio. Without a reason, the parent works inline, following the logbook (feature document, mirror, `todo`, work-unit commits).
6. **Incident rule:** after a wrong `cwd`, accidental repository/worktree mutation, failed merge recovery, or environment workaround, stop and diagnose it separately before resuming.
7. **Context backstop:** when the parent context passes ~150k tokens, pause and delegate the next bounded unit of work.

**Invariants:** whoever writes, inline or delegated, reuses the existing function for shared state and keeps its invariants (ordering, uniqueness, validation, normalization); writer prompts name those helpers (`orchestrator-writer.md`).

**Differential check (PRESERVE):** forward the harness test-first policy's differential check to writers.

**Preparation trigger:** reading that prepares a delegated write goes with the writer; inline writes read inline. When delegating, read only what decides the route, never the files the worker will read; pass paths, the spec reference, and what to change, not file contents.

**Route declaration:** for large work, record the chosen route per task and its trigger evidence in the feature document, so skipped delegation is observable instead of silent.

These triggers only choose between direct inline and delegated direct inside ODD.

For a large task's bounded writes, prefer the installed package-owned `gentle-ai-worker`, then a user-configured `worker`. If neither worker definition exists, fall back to the native `Agent` even when `subagent_*` tools are available. If no delegation mechanism is available, stop and explain the blocker. Judgment Day phase roles are never generic fallbacks. If the generic writer chain is unavailable, use the documented native generic fallback or stop.

## Launch

- Derive nonempty `## Allowed edit surfaces` before launching a writer (`orchestrator-writer.md`). Parallel writers only with disjoint Allowed edit surfaces (runtime-enforced) or isolated worktrees.
- Pass the session's resolved skill paths under `## Skills to load before work`; children read them first (`orchestrator-skills.md`).
- A child must be able to do the task it is given. Check the agent's declared `tools` in `subagent_list_agents` before launching: never give a read-only explorer shell, HTTP or MCP work, and never assume your own tools transfer to the child. With no qualified agent, report the capability gap; a fired trigger is never replaced by inline work.
- Background (policy on, `subagent_run` present): omit `mode`; it returns a task id at once. End the turn and resume on its `gentle-agents.result` completion message; never sleep or poll `subagent_status`. Otherwise run in the foreground. Detail: reference.
- Do not pass `model` to generic subagents unless the user asks.

#### Key Learnings closing block

Generic Explore/general worker prompts (`gentle-ai-explore`, `gentle-ai-worker`, `gentle-ai-verify`, or their native `Agent` fallback) end with: after the normal result, close the final response text with a `## Key Learnings` block of 1–5 numbered items, each a standalone factual sentence of at least 20 characters and at least 4 words; omit it when there is genuinely no reusable learning. It layers on after the Return contract without changing its fields and applies to final response text only. Engram automatically extracts and persists the items; the worker does not parse the block or call passive-capture tools; this is separate from explicit `mem_save`. Agents that must return strict JSON never receive it.
