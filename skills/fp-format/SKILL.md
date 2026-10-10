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
- Declare the document's row prefix near its title using `**Work unit prefix:**` followed by exactly one backticked literal (for example `T`); without it the map expects `FP-`. The first readable declaration wins per document. The reader scans every line after trimming and stripping an optional list marker; the colon may be inside or immediately after the bold marker.
- Match the prefix literally and case-sensitively, followed by digits and optional dash-separated digits: `T1` is a row under `T`, `TR-1` is not. Unicode-letter or dot continuations (`T1b`, `T1.2`) stay sub-element steps, never rows, even without their parent.
- Report both prefix omission rules: no backticked span, multiple spans, an empty value, whitespace or a backtick in the value makes a declaration unreadable; subsequent readable declarations are duplicates even if identical. Each omission names the document and leaves resolution unchanged; an unreadable marker does not prevent a later readable declaration from winning.
- Report missing descriptions/criteria; absent dependencies mean `UNKNOWN`, not none. Never invent facts or passes.
- Propose existing-document formatting/translation; await approval before applying.
- Put one document-level `**Belongs to:**` near the title, before checkboxes, with one backticked confirmed parent code; never infer or repeat it per task.
- Report malformed/ambiguous declarations and ask before changing them. Membership is a convention, not release 4.0.0 map behavior.
- Put `**Allowed edit surfaces:**` on one indented line inside the work-unit body, directly below its checkbox, as shown in the format rules. Each entry is an optional `surface:` followed immediately (allowing whitespace) by exactly one backticked path; scan left to right, with each name opening a group for that path and subsequent unnamed paths until the next name, valid or not. The parser reads recognized entries, not whole-line syntax validation.
- Use exact canonical names: `productUx`, `web`, `api`, `data`, `security`, `operations`, `tests`. Canonical group names bypass the table; paths before any name use `surfaceForDeclaredPath` and the harness's canonical table default (longest prefix wins).
- Unknown names poison their group: each path until the next name produces its own omission naming the capability, source document, offending name and path, with no surface and no fallback. Paths before any name with no table match also produce named omissions. Omission paths carry the declared span without a surface prefix; the document reader normalizes whitespace before parsing, so runs of spaces or tabs inside a declared path appear collapsed. Never guess.
- A parent must map the declaration to plain repository-relative paths, one per line, in a delegation's `## Allowed edit surfaces` block. Never copy a prefixed entry there: `lib/bounded-writer-admission.ts` blocks anything other than a bare or wholly backticked path. Preserve the English marker in Spanish documents.

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
