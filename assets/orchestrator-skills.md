# Orchestrator — Skills Detail (lazy-loaded)

Bind this to the parent Pi session only, on skill resolution/discovery. Not always-on; loaded on demand from `assets/orchestrator.md`'s `## Skill Registry Protocol` and `## Intent-Driven Skill Discovery` pointers.

## Skill Registry Protocol

The parent resolves skills once per session or before first delegation:

1. Read `.atl/skill-registry.md` if present.
2. Match task context and target files against the `Trigger / description` column.
3. Pass only matching `Path` values to subagents under `## Skills to load before work`.
4. Tell subagents to read those exact `SKILL.md` files before reading, writing, reviewing, testing, or creating artifacts.
5. If the registry is absent, continue but mention that project-specific skill paths were unavailable.

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

1. Read `.atl/skill-registry.md` when present.
2. If the registry suggests a specific skill, load the indexed `SKILL.md` path before acting.
3. If the expected skill is absent from the registry but the request clearly names a known workflow, search common project/user skill dirs such as `./skills`, `.pi/skills`, `.agents/skills`, `~/.config/opencode/skills`, `~/.claude/skills`, and other configured skill roots.
4. Prefer the most specific project skill over a global skill with the same intent.
5. If no matching skill exists, continue with the smallest safe fallback and say which expected skill was unavailable.

Common intent hints, not hard routing:

| User intent                | Skill to check                         |
| -------------------------- | -------------------------------------- |
| PR review / GitHub PR URL  | project review skill, then `pr-review` |
| Post-ready review comments | `comment-writer`                       |
| Create/open/prepare PR     | `gentle-ai-branch-pr`                  |
| Split/stack/large PR       | `gentle-ai-chained-pr`                 |

Keep this lightweight: loading a skill should improve the immediate task, not force extra ceremony.
