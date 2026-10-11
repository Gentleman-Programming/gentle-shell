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

## Work unit prefix

Declare a document's row prefix near its title with `**Work unit prefix:**`
followed by exactly one backticked literal, for example `T` or `HOR-`.
Without a declaration the map expects `FP-`. The reader scans every line,
trims it and strips an optional leading list marker; the colon may be inside
or immediately after the bold marker. The first readable declaration wins,
independently per document, in both display and artifact extraction.

Matching is literal and case-sensitive: the prefix must be followed by digits
and optional dash-separated digits. Under `T`, `T1` and `T2` are rows, while
`TR-1` is a step. A row continued by a Unicode letter or a dot is a sub-element,
never a row, even if its parent is absent: `T1b` and `T1.2` remain steps.

Both omission rules name the source document and leave resolution unchanged:
a declaration with no backticked span, multiple spans, an empty value, whitespace
or a backtick in the value is unreadable and ignored; every subsequent readable
declaration is a duplicate and ignored, even when it repeats the same literal.
An unreadable declaration before the first readable one does not prevent that
later declaration from winning. Preserve existing codes; do not renumber.

## Allowed edit surfaces

Put the declaration in the indented body of its work unit, directly under the
checkbox, not only in a separate explanation heading. The map reads the first
matching declaration line in that unit's body; keep entries on that single line:

```markdown
- [ ] **FP-1 — Resultado aprobado**
  **Allowed edit surfaces:** web: `apps/web/**`, `web/shared.ts`, api: `apps/api/catalog.ts`
```

Authoring requirements: each entry has an optional `surface:` immediately followed
(with optional whitespace) by exactly one backticked repository-relative path;
separate entries with commas. These are format requirements, not parser validation.
Scan left to right: a name opens a group for its path and every subsequent unnamed
path until the next name, whether the name is valid or not.
The parser reads recognized entries rather than validating the whole line: write
exactly one optional `name:` per backticked path, and do not rely on a malformed
prefix being rejected.
Keep the marker literal `**Allowed edit surfaces:**` in English, even in Spanish
narrative. Use only these exact, case-sensitive canonical names, in canonical order:
`productUx`, `web`, `api`, `data`, `security`, `operations`, `tests`.

An explicit canonical name assigns that surface and bypasses the path table.
Before any name opens a group, `surfaceForDeclaredPath` uses the harness-owned defaults in
`lib/project-map-surface-table.ts` (longest prefix wins); the table is not project
configuration. In the example, both `apps/web/**` and `web/shared.ts` belong to
`web`; `api:` then opens a new group. Surfaces are deduplicated in canonical order in
both the display and the artifact derivation.

Both omission rules are mandatory: an unknown name (including a typo) reports the
capability, source document, offending name and declared path, assigns no surface
for each path in its group and never falls back to the table, until a later name
opens a new group; a path before any name with no table match reports a named
omission instead of guessing. Omission paths carry the declared span without a
surface prefix; the document reader normalizes whitespace before parsing, so runs
of spaces or tabs inside a declared path appear collapsed. No declaration
means no declared surfaces, not inferred coverage. Do not invent paths or names
when source input is missing.

A delegation's `## Allowed edit surfaces` block is a different contract: it takes
plain repository-relative paths, one per line. The parent maps the FP declaration
into that block, stripping names and using only confirmed paths; never copy the
``surface: `path` `` form into it. The writer admission gate in
`lib/bounded-writer-admission.ts` checks path-line syntax, not surface names:
the ordinary ``surface: `path` `` entry is neither bare nor wholly backticked
and is rejected. An FP declaration does not itself
authorize delegation or edits.

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
