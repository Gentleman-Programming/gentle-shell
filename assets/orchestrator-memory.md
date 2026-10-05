# Orchestrator — Memory Detail (lazy-loaded)

Bind this to the parent Pi session only, on organic progress/recovery. Not always-on; loaded on demand from `assets/orchestrator.md`'s `## Memory Contract` pointer.

### Organic feature continuity

For large authorized organic implementation (Task Size in `orchestrator.md`), the parent maintains `odd/tasks/<feature-name>.md` and an Engram recovery copy under topic `odd/<feature-name>/tasks`, scoped to the current project. Use a descriptive filename-safe feature name, reuse the same identity, and never overwrite another feature. Keep one feature document, not a separate plan file or topic. It is the specification subagents read by reference, so keep this fixed order, stable content first and the growing log last:

1. A header of two or three lines: objective, branch, delivery strategy, and test runner.
2. `## Specs`: numbered `S1`..`Sn` requirements, constraints, and acceptance criteria with their checks. Quote the user's exact strings, error messages, commands, and examples verbatim, in the user's language; you may number and order them, but never summarize or reword those fragments. Do not add requirements the user never asked for; mark assumptions as assumptions.
3. `## Tasks`: one line per task, using stable task IDs, with its linked `S#`, route (inline or delegated), status, and commit identity or RED/GREEN evidence.
4. `## Log`: the logbook. `L1` holds the user's original request verbatim; later user corrections are logged verbatim with their date. Problem analysis, rationale for meaningful accepted changes, verification evidence, progress, and next step go here. Routine corrections stay brief; no exhaustive decision journal.

Mirror the full current document and repository-relative file locator, not only a summary or completion notice. Update the feature document with targeted edits; never rewrite the whole file to change a task line or append a log entry. When a code-execution tool such as `codemode` is available, refresh the Engram mirror inside one script that reads the file and saves its content, so the document is never re-emitted as output tokens.

Accepted user, review, or verification changes automatically update affected intent and TODOs, unlike a process that regenerates every artifact: a requirement change appends its verbatim `## Log` entry, rewrites only the affected `S#`, and reopens only its linked task; preserve valid completed and unrelated work; add genuinely new tasks or reopen invalidated items with a reason, and revise their checks. Findings alone never authorize scope expansion or automatic acceptance. New business scope still requires user authorization. Check off only observed outcomes with applicable proof; record failed, unavailable, skipped, or pending checks honestly. The parent merges bounded worker results rather than replacing the entire feature with one worker's partial view.

Persist local progress first, then mirror through the existing injected Engram save tool. Read back both writes; they are not atomic. If Engram is unavailable, preserve local progress and explicitly mark the mirror pending; do not claim persistence succeeded or block unrelated safe work. Resynchronize when available. If a file write is unsafe or unavailable, preserve existing state and report the limitation. Preserve both versions on irreconcilable edits and ask only about the real conflict; never silently prefer a newer timestamp.

On resume, use `mem_context`, then project/feature-scoped `mem_search`, and `mem_get_observation` for the full saved document; read the actual task file. Do not infer active work from the newest global memory. Reconcile current requirements, code, and proof before continuing the next unfinished task. Preserve pending mirrors and conflicting edits; a missing copy is not permission to overwrite surviving progress. Use the injected equivalents of these existing memory tools, never invent availability.

Before implementation or resume, the parent reads both the actual file and full observation, reconciles them, and passes the locator, task IDs, and linked `S#`; workers read the document until `## Log` before edits. Small work without a document still receives its authorized scope and checks.

The existing `todo` tool is the required session/UI projection for large ODD, not a third authority. After reconciling and writing the durable file and Engram copy, create or rebuild the visible `todo` list from the same feature tasks before the first source write; after every task transition and material plan change, update both durable copies and the visible projection in the same turn; its replay or completed-list clearing must not delete or replace the durable file or Engram copy. If the projection is unavailable, record that limitation without pretending it is synchronized. Small/read-only work does not acquire an ODD artifact or todo list merely because the UI can display tasks.

Memory lifecycle rule (when Engram exposes lifecycle metadata/tooling):

- At session start or before architecture-sensitive work, call the injected Engram review tool with action `list` for the current project when the tool is available.
- If the injected Engram review tool is unavailable, do not fail the task. Continue with the injected Engram context/search tools, and still apply lifecycle metadata from any returned observations when present.
- `active` memories may be used normally.
- `needs_review` memories are stale context, not trusted facts.
- When a retrieved memory is marked `needs_review`, surface that stale context to the user and verify it against current evidence before relying on it.
- Do NOT call the injected Engram review tool with action `mark_reviewed` automatically. Only call `mark_reviewed` after explicit user confirmation or through a dedicated memory maintenance command.
