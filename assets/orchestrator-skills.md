# Orchestrator — Skills Detail (lazy-loaded)

Bind this to the parent Pi session only, on skill resolution/discovery. Not always-on; loaded on demand from the always-on core's `## Skill Registry Protocol` and `## Intent-Driven Skill Discovery` pointers.

## Skill Registry Protocol

On each enabled primary-session agent start, the `Effective session skills` system-prompt block combines the current disk scan with that session's Pi-resolved records. Use this view to select skills and delegate:

1. Match task context and target files against the effective view's `Trigger / description` column.
2. Pass only matching exact `Path` values to subagents under `## Skills to load before work`.
3. Tell subagents to read those exact `SKILL.md` files before reading, writing, reviewing, testing, or creating artifacts.
4. If no skill matches, continue without project skill injection and report `skill_resolution: none`.

The shared `.atl/skill-registry.md` indexes disk only. Neither it nor Pi's injected `<available_skills>` alone includes the full effective view. If the block is unavailable, say so; a disk-only fallback may omit runtime-only skills. Disk changes appear in the view at the next agent start, not mid-run.

Subagents should receive exact indexed paths. They should not have to rediscover the registry.

Subagents do not independently discover additional project/user `SKILL.md` files or the registry during normal runtime. The parent passes selected project/user skill paths explicitly.

If a subagent reports `skill_resolution`, interpret it as project/user skill resolution:

- `paths-injected`: parent supplied `## Skills to load before work` with exact `SKILL.md` paths.
- `fallback-registry`: subagent self-loaded skill paths from the registry because parent paths were missing; degraded but auditable.
- `fallback-path`: subagent loaded explicit skill paths because parent paths were missing; degraded but auditable.
- `none`: no project/user skills were loaded.

If any subagent reports a fallback instead of `paths-injected`, treat it as an orchestration gap and correct future delegations by passing exact indexed paths directly.

## Intent-Driven Skill Discovery

For skill-shaped requests, do not treat injected `<available_skills>` as complete. Use the registry and filesystem only as a discovery aid; do not let a trigger table override the user's concrete request or turn a small request into a larger workflow.

Discovery order:

1. Consult the `Effective session skills` block, including runtime-only paths, before acting or delegating.
2. Read the matching exact `SKILL.md` path when acting; pass it to the subagent when delegating.
3. If the view is unavailable, disclose the limitation; `.atl/skill-registry.md` is a disk-only fallback, not a complete Pi view.
4. If an expected workflow is absent, search configured skill roots only as a fallback. Prefer the most specific project skill over a global skill with the same intent.
5. If no matching skill exists, continue with the smallest safe fallback and say which expected skill was unavailable.

Common intent hints, not hard routing:

| User intent                | Skill to check                         |
| -------------------------- | -------------------------------------- |
| PR review / GitHub PR URL  | project review skill, then `pr-review` |
| Post-ready review comments | `comment-writer`                       |
| Create/open/prepare PR     | `gentle-ai-branch-pr`                  |
| Split/stack/large PR       | `gentle-ai-chained-pr`                 |

Keep this lightweight: loading a skill should improve the immediate task, not force extra ceremony.
