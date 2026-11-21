---
name: gentle-ai-skill-creator
description: "Trigger: /skill-creation, skill creation, skill creator, create skill, new skill. Create LLM-first skills with valid frontmatter."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Use this skill when creating or updating a reusable AI skill for Pi or another agent runtime.

Create a skill when:
- a workflow or convention is reused across sessions;
- generic agent behavior needs project-specific constraints;
- a decision tree helps the agent choose safely;
- examples, templates, or references would make future execution more reliable.

Do not create a skill for a one-off task, generic documentation, or rules that belong in code/tests.

## Hard Rules

- Follow `../../docs/skill-style-guide.md` as the normative source for skill structure and style.
- A skill is an LLM runtime contract, not human-facing docs.
- Keep `SKILL.md` concise: target 180–450 tokens, max 1000.
- Use imperative instructions and concrete gates; avoid tutorials and background prose.
- Frontmatter `description` must be one physical YAML-safe line and include trigger words first.
- Do not add a `Keywords` section; put essential trigger words in `description`.
- Put templates, schemas, and generated examples in `assets/`.
- Put longer rationale or local doc links in `references/`.
- After changing project skills, refresh the registry with `/skill-registry:refresh` when available.

## Decision Gates

| Need | Action |
| --- | --- |
| Small reusable behavior | Create `skills/{skill-name}/SKILL.md` only |
| Templates, schemas, fixtures | Add `skills/{skill-name}/assets/` |
| Longer explanation or edge cases | Add `skills/{skill-name}/references/` |
| Existing skill covers it | Update the existing skill instead |
| Skill affects delegation discovery | Ensure trigger words appear in `description` |

## Execution Steps

1. Read `../../docs/skill-style-guide.md` before creating or updating skills.
2. Inspect existing skills and confirm the new skill does not duplicate one.
3. Choose a kebab-case skill name that matches the user-facing trigger.
4. Create or update this structure:

```text
skills/{skill-name}/
├── SKILL.md
├── assets/       # optional
└── references/   # optional
```

5. Use this frontmatter shape:

```yaml
---
name: {skill-name}
description: "Trigger: {phrases users or agents will say}. {What this skill does}."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---
```

6. Write sections in this order: Activation Contract, Hard Rules, Decision Gates, Execution Steps, Output Contract, References.
7. If this is a packaged `gentle-pi` skill, add it to `scripts/verify-package-files.mjs`.
8. Refresh or document the skill registry update path.

## Output Contract

Return:
- Files created or modified.
- Whether this created a new skill or updated an existing one.
- Any supporting `assets/` or `references/` files added.
- Whether package verification or skill registry refresh is needed.

## References

- `../../docs/skill-style-guide.md` — normative LLM-first skill style guide.
- `../skill-registry/SKILL.md` — registry refresh and indexing contract.
