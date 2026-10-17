# FP document rules

## Scope and authority

Apply these rules only to an explicitly requested FP document operation. Keep
context, tasks, rationale, acceptance, and evidence in the authoritative ODD
feature document. Supporting links may point to existing evidence; do not create
a second maintained feature specification or task list.

Write FP narrative, headings, and explanatory labels in Spanish. Keep runtime
skill instructions in English. This is not a repository-wide language policy.
Technical literals (IDs, metadata keys, paths, commands, API identifiers, state
markers, and evidence) are exempt from translation.

## Identity and hierarchy

- Inventory existing FP/task IDs and their relationships before proposing edits.
- Keep stable IDs verbatim in the checklist and corresponding explanation.
- Use `FP-N` only for new identities supported by approved input. Existing codes
  need not match that pattern. Do not rename or renumber to make them fit.
- Preserve checkbox/state markers and completed work. Formatting alone never
  changes completion, execution, review, or commit status.
- Put one document-level membership declaration near the title, before the first
  work-unit checkbox: `**Belongs to:**` followed by exactly one backticked parent
  code. Use only the confirmed existing/approved parent of the document; never
  infer it from task IDs or repeat membership inside task explanations.
- Replace the template's backticked placeholder only with that confirmed code.
  Preserve source metadata. If an existing declaration is malformed, duplicated,
  or ambiguous, report it and ask before changing it; do not discard or reparent
  it to satisfy the format.
- This metadata is an adopted document convention recognized in the preview
  fork, not established native release 4.0.0 parser/Project Map behavior. Writing
  it does not update a release map, validate hierarchy, or refresh anything.

## Content and missing data

Describe the FP's intended outcome, context/problem, scope, and rationale from
approved input. Give each task its own explanation, acceptance criteria, and
verification/evidence section, tied to the checklist's same stable ID.

Preserve technical meaning, including exclusions, negative cases, dependencies,
and exact paths/commands/API identifiers. Translate surrounding prose only;
never translate literal evidence or rewrite commands as supposed equivalents.

Distinguish unknown dependencies from confirmed absence:

- No dependency declaration in the source: report `UNKNOWN` (no declaration),
  not "sin dependencias".
- Explicit unknown declaration: preserve `UNKNOWN`.
- Explicit confirmed absence: preserve that assertion without inventing an edge.
- Explicit dependency: preserve its exact target and meaning. Do not infer edges
  from numbering, checklist order, or similar titles.

Report missing explanations and acceptance criteria as missing. Use visible
placeholders in a draft, not guessed facts. Escalate genuinely ambiguous identity
or hierarchy before editing the affected content.

## Approval and evidence

For an existing document, return a bounded formatting/translation proposal with
its target path, ID/state inventory, proposed changes, gaps, and ambiguities.
Apply only the approved proposal; expanded semantic changes need new approval.
New documents may be drafted from approved input. Neither route authorizes task
execution, conversion scripts, parser changes, or automatic registry refresh.

Separate a planned verification from observed evidence. Record exact authorized
commands, expected behavior, and pending checks without claiming they passed.
Keep actual outcomes (including failures), artifacts, and prior evidence intact.
Do not tick tasks, fabricate receipts, or manufacture successful verification.
The example is fictional and supplies no evidence about a real repository.

## Final inspection

Check that every checklist task has an explanation with the same ID, document
membership has one backticked confirmed parent code before the first checkbox,
states and literals survived, missing data is visible, and evidence
still distinguishes pending from observed. Return unresolved gaps even when the
formatting proposal is otherwise ready. These are authoring checks, not a claim
of structural validator enforcement or guaranteed skill discovery.
