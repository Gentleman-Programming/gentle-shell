# Orchestrator — Skills Detail (lazy-loaded)

Bind this to the parent Pi session only, on skill resolution/discovery. Not always-on; loaded on demand from the always-on core's `## Skill Registry Protocol` and `## Intent-Driven Skill Discovery` pointers.

## Skill Registry Protocol

The effective view is `<available_skills>` plus the on-disk rows of the `Effective session skills` system-prompt block: on each enabled primary-session agent start, that block lists the skills found in project and other agents' skill directories that Pi did not load (every skill when Pi renders no `<available_skills>`), and is absent when there are none. A block row whose name is also in `<available_skills>` won precedence (a project copy outranks a user or package copy); use the block's row. In `<available_skills>` the `Trigger / description` is `<description>` and the `Path` is `<location>`. Use this view to select skills and delegate:

1. Match task context and target files against the effective view's `Trigger / description` column.
2. Pass only matching exact `Path` values to subagents under `## Skills to load before work`. Match the delegated task's own files and actions, never a fixed set: a child that will not commit gets no commit skill, and one that writes no docs gets no docs skill.
3. Tell subagents to read those exact `SKILL.md` files before reading, writing, reviewing, testing, or creating artifacts.
4. If no skill matches, continue without project skill injection and report `skill_resolution: none`.

The shared `.atl/skill-registry.md` indexes disk only and is never the full effective view. The view is unavailable only when neither `<available_skills>` nor the block is present: then say so; a disk-only fallback may omit runtime-only skills. Disk changes appear in the view at the next agent start, not mid-run.

Subagents receive exact indexed paths and never rediscover the registry or other project/user `SKILL.md` files during normal runtime.

Among package subagents only `gentle-ai-worker` reports `skill_resolution`, as `paths-injected`, `paths-invalid` (blocked; the unreadable path is in `risks`), or `none`; the fallback values below come from non-package agents.

If a subagent reports `skill_resolution`, interpret it as project/user skill resolution:

- `paths-injected`: parent supplied `## Skills to load before work` with exact `SKILL.md` paths.
- `fallback-registry`: subagent self-loaded skill paths from the registry because parent paths were missing; degraded but auditable.
- `fallback-path`: subagent loaded explicit skill paths because parent paths were missing; degraded but auditable.
- `none`: no project/user skills were loaded.

If any subagent reports a fallback instead of `paths-injected`, treat it as an orchestration gap and correct future delegations by passing exact indexed paths directly.

## Intent-Driven Skill Discovery

For skill-shaped requests, do not treat injected `<available_skills>` as complete. Use the registry and filesystem only as a discovery aid; do not let a trigger table override the user's concrete request or turn a small request into a larger workflow.

Discovery order:

1. Consult `<available_skills>` and the `Effective session skills` block, when present, before acting or delegating.
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
