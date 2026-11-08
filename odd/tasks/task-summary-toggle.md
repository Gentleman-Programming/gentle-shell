# Task summary on/off in /gentle:customize

Branch `feat/task-summary-toggle` from upstream/main 24a926572. Part 1 of 2 of the tool-agnostic rescope of issue #2392 (sibling: `odd/tasks/agent-status-file.md`).
Lets users show or hide the already-merged task summary from the UI instead of hand-editing `herdr-task-summary.json`.

## Specs

- S1 — User goal (verbatim): "La preferencia de mostrar u ocultar el resumen, que es parte de la PR 1." Accepted plan (verbatim): "PR A: opción "Resumen de tarea: sí/no" en `/gentle:customize` (~100–150 líneas). Va en una categoría que ya existe, sin colores ni nada de Herdr, y usa la preferencia que ya está mergeada."
- S2 — `/gentle:customize` offers two explicit choices, `Task summary: on` and `Task summary: off`, in the existing `Layout` category (closest fit; its hint explains it controls the task summary published to terminal tools), following the banner on/off pattern (`explicitChoice`, `(current)` marker on the active value, applyOnMove false). No new category, no color controls.
- S3 — Selecting a choice persists only `enabled` through the existing `writeHerdrTaskSummarySettings` (`lib/herdr-task-summary-policy.ts`), preserving the stored color fields, then emits `HERDR_TASK_SUMMARY_CHANGED` with `{ configHome }` so the running publisher clears or resumes. The event is emitted only after a successful write.
- S4 — A malformed or unreadable preference file is never overwritten: the write is refused, the user gets an error notice, no event is emitted, and the file bytes stay unchanged.
- S5 — Success notice states the effect applies now to the active-task summary published to terminal tools (for example Herdr's sidebar). User-facing copy does not promise any Herdr config change.
- S6 — Help text/docs (`docs/readme-reference.md` task-summary section) describe the new option and the preference file.

## Tasks

- T1 — S2-S6 — background worker, parent-reviewed — RED 5/5 new public-command tests failed (missing choices); GREEN 5/5. `tests/gentle-shell.test.ts`: 334 pass / 14 fail; the 14 also fail on an upstream/main export with the same local node_modules (main: 17 fail), none new. `npm run typecheck`: 22 diagnostics, identical total to upstream/main locally (dependency drift). Risk: none. — commit: see git log (feat(customize): add task summary on/off choices)

## Log

- L1 — User (verbatim): "Alan me dijo Vamos a probar ! Modifica el issue y hagamos esas dos PRS para revisarlo"
- L2 — Earlier decision (verbatim): "no no, volvamos a lo original, lo que ya esta mergeado queda, el 2660 se cierra y esta propuesta que se debe hacer?" #2660 closed 2026-11-06.
