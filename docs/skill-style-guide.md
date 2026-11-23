# Skill Style Guide

This guide is the normative style contract for LLM-first skills shipped with or created inside `drakonc-pi` projects.

## Purpose

A skill is a runtime instruction contract for an LLM. It should make future agent behavior more reliable by encoding reusable workflow rules, decision gates, and output expectations.

A skill is not a tutorial, article, README, or generic checklist for humans.

## When to create a skill

Create or update a skill when:

- a workflow or convention is reused across sessions;
- project-specific constraints differ from generic best practices;
- a decision tree helps the agent choose safely;
- templates, schemas, or local references improve repeatability;
- agents keep missing the same instruction without an explicit runtime contract.

Do not create a skill for:

- one-off tasks;
- generic documentation;
- rules that belong in tests, linters, or executable code;
- broad background context without concrete execution rules.

## Required structure

Use this directory shape:

```text
skills/{skill-name}/
├── SKILL.md
├── assets/       # optional: templates, schemas, examples, fixtures
└── references/   # optional: longer local docs or rationale
```

`SKILL.md` must use this section order:

1. `Activation Contract`
2. `Hard Rules`
3. `Decision Gates`
4. `Execution Steps`
5. `Output Contract`
6. `References`

Omit optional supporting directories when they are not needed.

## Frontmatter

Use YAML frontmatter with this shape:

```yaml
---
name: {kebab-case-skill-name}
description: "Trigger: {phrases users or agents will say}. {What this skill does}."
license: Apache-2.0
metadata:
  author: drakoncman-programming
  version: "1.0"
---
```

Rules:

- `name` must be kebab-case and match the skill directory unless there is a deliberate compatibility reason.
- `description` must be one physical line, quoted, YAML-safe, and trigger-rich.
- Put essential trigger words first in `description`.
- Do not add a `Keywords` section.
- Preserve license and metadata unless the project has a stronger local convention.

## Writing rules

- Write imperative runtime instructions, not explanatory prose.
- Keep `SKILL.md` concise: target 180–450 tokens, recommended max 700, hard max 1000.
- Prefer bullets and compact decision tables over paragraphs.
- State when to activate the skill and when not to activate it.
- Preserve author intent when improving an existing skill.
- Do not invent domain policies, triggers, or constraints. Ask or mark ambiguity instead.
- Move long examples, schemas, generated templates, and background rationale to `assets/` or `references/`.
- References must point to local files that ship with the project or package.

## Decision gates

Use a table when choices matter:

```markdown
| Situation | Action |
| --- | --- |
| Missing frontmatter | Fix required fields |
| Existing skill covers it | Update the existing skill instead |
| Long examples needed | Move them to `assets/` |
```

Decision gates should prevent unsafe overreach, duplicate skills, and unnecessary ceremony.

## Output contract

Every skill should tell the agent what to return. Good output contracts include:

- files created or modified;
- commands or verification run;
- registry refresh needed;
- unresolved ambiguities;
- residual risks.

## Registry expectations

After creating, removing, moving, or renaming project skills, refresh the skill registry when available:

```text
/skill-registry:refresh
```

The registry is an index. `SKILL.md` remains the source of truth.
