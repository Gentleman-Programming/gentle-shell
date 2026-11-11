---
name: gentle-ai-skill-registry
description: "Trigger: update skills, skill registry, actualizar skills, after skill changes. Index available skills by trigger and path."
license: MIT
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Use this skill after installing, removing, creating, moving, or renaming skills, or when a delegator needs a fresh skill index.

## Hard Rules

- The registry is an index, not a compiler or summary. `SKILL.md` remains the source of truth.
- Do not generate or inject compact rules by default; preserve author intent by passing exact skill paths to subagents.
- Refresh `.atl/skill-registry.md` as a shared disk-only index; do not save session-only runtime rows to the file or Engram.
- Skip `sdd-*`, `_shared`, and `skill-registry`; deduplicate by skill name, preferring project-level skills over user-level skills.
- In Pi, the effective view is `<available_skills>` plus the on-disk rows of the `Effective session skills` block in the system prompt.
- Preserve Git-tracked targets during automatic refresh. Deliberate `/skill-registry:refresh` overrides that guard; unchanged rendered bytes remain untouched even on force.

## Decision Gates

| Situation | Action |
| --- | --- |
| Same skill exists globally and in project | Keep the project-level skill |
| Pi-resolved skill and loose scan share a path | In the effective view use the active Pi record, or suppress the path when disabled; the shared disk index remains independent |
| Same skill exists in multiple global locations | Keep the first source in scan order |
| No skills found | Write an empty registry so agents stop searching blindly |
| Agent will delegate work | Select matching effective-view rows and pass their exact `SKILL.md` paths |

## Execution Steps

1. Use `/skill-registry:refresh` for a deliberate disk-index refresh. It scans known project and user roots, reads frontmatter, and publishes deterministic rows and a non-authoritative cache.
2. For Pi selection, consult the effective view: `<available_skills>` plus the `Effective session skills` rows.
3. Pass selected exact paths to subagents and require them to read each `SKILL.md` before work.
4. Return the registry path, disk skill count, and whether bytes changed.

## Output Contract

Return:
- Project name and `.atl/skill-registry.md` path.
- Number of indexed skills.
- Whether the registry changed or was already byte-identical.
- Any skipped or duplicate skills when relevant.

## References

- `docs/skill-style-guide.md` — how skills should be authored before indexing.
- `assets/orchestrator-skills.md` — Pi delegator protocol (effective view, exact paths).
