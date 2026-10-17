---
name: gentle-ai-fp-format
description: "Trigger: FP format, functional point documentation, crear FP, actualizar FP, documentar puntos funcionales, formatear FP en español. Draft or propose Spanish FP documentation within ODD."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Use for explicit FP documentation intent in ODD, not global formatting or task execution.

## Hard Rules

- Keep ODD feature documents authoritative, without duplicates.
- Write Spanish narrative; preserve IDs, states, meaning, exact paths/commands/APIs, dependencies, and evidence.
- Preserve non-`FP-N` codes; never renumber.
- Report missing descriptions/criteria; absent dependencies mean `UNKNOWN`, not none. Never invent facts or passes.
- Propose existing-document formatting/translation; await approval before applying.
- Put one document-level `**Belongs to:**` near the title, before checkboxes, with one backticked confirmed parent code; never infer or repeat it per task.
- Report malformed/ambiguous declarations and ask before changing them. Membership is a convention, not release 4.0.0 map behavior.

## Decision Gates

| Situation | Action |
| --- | --- |
| New document, approved input | Draft from template |
| Existing document | Propose a bounded diff; await approval |
| Ambiguous identity/hierarchy | Stop and ask before changing it |
| Missing input | Report gaps; leave explicit placeholders |

## Execution Steps

1. Read the authoritative document and format rules below.
2. Inventory IDs, states, hierarchy, dependencies, and evidence.
3. Use the template/example; explain each task with acceptance and verification.
4. Check preservation, Spanish prose, and gaps. Listed commands do not authorize execution.

## Output Contract

Return draft/proposal or approved edits, paths, preserved IDs, gaps, approval status, and observed/pending verification.

## References

- [Format rules](references/format-rules.md)
- [Template](assets/fp-document-template.md)
- [Fictional example](assets/fp-document-example.md)
