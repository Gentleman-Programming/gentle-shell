# Universal per-session agent-status file

Branch `feat/agent-status-file` from upstream/main 24a926572. Part 2 of 2 of the tool-agnostic rescope of issue #2392 (sibling: `odd/tasks/task-summary-toggle.md`).
Publishes each session's agent status as a documented JSON file so any terminal tool, not only Herdr, can show it with a small adapter.

## Specs

- S1 — User goal (verbatim): "Lo mismo en cualquier otra herramienta, con un adaptador chiquito." Accepted plan (verbatim): "PR B: publicar el estado en un formato universal (~300–400 líneas). Escribe un archivo JSON por sesión con agente, estado y título de la tarea, y documenta ese formato para que cualquier herramienta lo lea. Herdr sigue funcionando igual que hoy."
- S2 — Schema `gentle-shell.agent-status/v1`, one JSON object per file: `schema`, `agent` (`"gentle-shell"` or `"pi"`, same label rule as `herdrAgentLabel`), `session` (stable session id), `pid`, `cwd`, `state` (`"working" | "blocked" | "idle"`), `task` (`{ "title": string }` or `null`), `updatedAt` (ISO 8601 UTC). The title is the raw sanitized `in_progress` todo title (same selection and control/bidi sanitizing as `activitySummary`, bounded length), never the Herdr-rendered rows, icon, or ellipsis layout.
- S3 — State rules mirror `extensions/gentle-herdr-agent.ts`: attention/blocked (`NOTIFICATION_ATTENTION_EVENT`) dominates; `agent_start` → working; settled with `ctx.isIdle()` → idle; session start initializes from `ctx.isIdle()`.
- S4 — `task` is `null` when there is no `in_progress` todo or the task-summary preference is disabled; changing the preference (`HERDR_TASK_SUMMARY_CHANGED`) updates the file.
- S5 — Location: `<gentlePiConfigHome()>/agent-status/<file>.json`, one file per session (filename derived from the session id, filesystem-safe). Directory created private (0700), files written 0600 via exclusive temp + rename; refuse symlinked directories or files found when writing, a loose existing status directory, and a foreign-owned or world-writable config home; ancestors above the config home are trusted (same model as `lib/orchestrator-presence.ts`). Works on Linux, macOS and Windows (no XDG_RUNTIME_DIR dependency); on Windows privacy comes from the inherited config-home ACLs, with no extra check.
- S6 — Liveness: the file is rewritten on every status change (coalesced) and refreshed at least every 10 s while the session runs (`updatedAt`); it is removed on session shutdown. Readers treat a file whose `updatedAt` is older than 30 s as stale. Write/remove failures never break the session (contained, no throw into Pi).
- S7 — Scope: only interactive top-level sessions publish (no `GENTLE_PI_AGENTS_CHILD` children). Independent of Herdr: publishes with or without Herdr; the existing Herdr publisher and its behavior are unchanged.
- S8 — Documentation `docs/agent-status.md`: location, schema with an example, field meanings, lifecycle/staleness rule, privacy note, and a minimal reader example (for example a `jq` one-liner) showing how a tool adapter consumes it; linked from `docs/readme-reference.md`.

## Tasks

- T1 — S2-S8 — background worker + parent correction (L4) — RED 9 missing-API failures, then heartbeat 1 !== 2, then world-writable home accepted (4/5); GREEN 39/39 focused (`tests/agent-status.test.ts tests/gentle-agent-status.test.ts tests/gentle-herdr-activity.test.ts tests/herdr-activity.test.ts`, isolated HOME). Herdr output byte-identical. `npm run typecheck`: 22, same total as upstream/main locally, none in new files. Risk: item 2 (private file store). Independent verify: S2-S4, S6, S7 pass; S5/S8 corrected per L4; Windows/macOS not exercised natively. — commit: see git log (feat(status): publish a universal per-session agent-status file)

## Log

- L1 — User (verbatim): "Alan me dijo Vamos a probar ! Modifica el issue y hagamos esas dos PRS para revisarlo"
- L2 — Alan's feedback relayed by the user (verbatim): "Mí mayor, depender o asociarnos demasiado a herdr / Vaya a saber si mañana es mejor orca o lo que sea / Lo que si veo bien, ofrecer como una Api para tener todo listo y que sea fácil la integración con cualquiera / No solo herdr"
- L3 — Location and liveness (S5, S6) are parent design choices under the accepted plan; reversible before merge.
- L4 — Independent verify blocked S5/S8: ancestor TOCTOU and Windows ACL claims overstated. Parent correction: refuse foreign-owned or world-writable config home (RED 4/5 → GREEN), S5 and privacy docs narrowed to the presence store's trust model; Windows ACL behavior documented as inherited, unverified natively.
