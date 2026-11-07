# Full delegation mode: remove the organic conflicts

Follow-up to PR #2976. In full delegation mode the injected rules said "never implement" while the runtime and the rest of the prompt still enforced the organic, inline-first workflow, so a small task deadlocked.

Branch: `fix/full-delegation-mode-conflicts` (from `origin/main` `bac4c4a3f`) · Delivery: `single-pr` (carried over from the parent feature) · Runner: `node scripts/run-test-suite.mjs` plus `node scripts/check-types.mjs` (this worktree has its own `node_modules`, so the local typecheck is authoritative)

## Specs

- **S1** In full delegation mode a generic bounded writer is admitted for any authorized change, small ones included, without a feature document and without the context backstop. `## Allowed edit surfaces` stays mandatory. Organic mode keeps today's admission exactly.
- **S2** Organic rules are removed from the full delegation context algorithmically, never annotated. User's words: "Es que para el 2 no hay que decir esto no sirve. Bien, lo que hay que hacer es que ni siquiera tenga que leerlo, que desaparezca del contexto. O eso es algo que se hace a nivel algorítmico." This covers the projected ODD steps (from the digest-verified mirror, which stays byte-identical on disk), the shared tail of the core, and every lazy asset the full delegation render names.
- **S3** The full delegation core keeps a `## Task Size` that decides tracking and risk only (resume test, high-risk items 1-6, Risk line), never who writes, so references to Task Size from shared lazy assets resolve instead of dangling.
- **S4** The full delegation core states how the human switches the mode (`/gentle:profiles`, `w` on the shown profile, then Save or Use in this session) and that it applies on the next turn, with no new session.
- **S5** Runtime notices emitted in full delegation mode do not tell the parent to work inline (context backstop, exploration budget, todo block).
- **S6** A closure test pins S2: the full delegation render, and every lazy asset it names, contain none of the organic routing phrases. It fails the day the mirrored contract or a named asset reintroduces one.
- **S7** An integration test reproduces the reported deadlock: a full delegation profile, a small task with no feature document, a writer launch, and the launch is admitted.
- **S8** Organic mode renders byte-identical to before this change.

## Tasks

| ID | Specs | Route | Status | Evidence |
| --- | --- | --- | --- | --- |
| T1 | S1, S7 | inline | done | `rejectUndocumentedWriterLaunch` takes `orchestratorMode`; the call site resolves it from the session environment like the prompt does. RED 3 of 15 → GREEN 15/15; neighbours 51/51; typecheck 0. Risk: item 2 (guard) — own commit |
| T2 | S2, S3, S4, S6, S8 | inline | done | projected ODD steps (2, 4, 6, resume pointer) and shared tail; generated `orchestrator-full-delegation-card.md` with drift check; variant Task Size (risk list spliced from the organic core) and switch line; three shared lazy assets made mode-neutral. Closure test RED 4/6 → GREEN 7/7; mode tests 17/17; 198/201 → 201 after updating three superseded assertions; typecheck 0; full core 7423 B at a 128-char root |
| T3 | S5 | inline | pending | mode-aware runtime notices |
| T4 | S1-S8 | delegated | pending | independent verifier over the whole branch (Risk: item 2) |
| T5 | S4 | inline | pending | docs |

## Log

**L1** (user report, verbatim): "revisa todo porque hay situaciones conflictivas" with a screenshot of the agent answering: "Hay un conflicto en la configuración de esta sesión: - El modo de delegación completa me prohibe editar archivos directamente. - El controlador de subagentes rechaza delegar una tarea pequeña como esta. La solución práctica es cambiar a un perfil que permita la edición directa para tareas pequeñas y comenzar una sesión nueva. [...] No tengo confirmado el nombre exacto del ajuste en tu instalación, así que prefiero no indicarte un comando que podría ser incorrecto."

**L2** (user correction, verbatim): "Es que para el 2 no hay que decir esto no sirve. Bien, lo que hay que hacer es que ni siquiera tenga que leerlo, que desaparezca del contexto. O eso es algo que se hace a nivel algorítmico."

**L3** (user authorization, verbatim): "Ok" — to the plan: mode-aware writer admission, algorithmic removal at three layers (projected ODD steps, lazy assets, runtime notices), a closure test, and the integration test of the reported case.

**L4** (root cause, evidence): `rejectUndocumentedWriterLaunch` (`lib/bounded-writer-admission.ts:126`) admits a generic writer only with a `Spec: odd/tasks/<x>.md ... T<n>` line naming an existing file, or past the context backstop; its rejection tells the agent to write inline and forbids creating a feature document. Its only caller (`extensions/gentle-ai.ts` subagent_run tool_call, ~12663) never passed the mode. The parent feature hit this exact rejection during its own T4 launch and treated it as a process gate instead of a contradiction.

**L5** (design decision): organic lazy assets are pinned by contract tests (for example `tests/task-size-routing-contract.test.ts:286` requires `#### Allowed edit surfaces (MANDATORY)` in `orchestrator-writer.md`), so they are not split. Instead the full delegation render never names a file carrying organic routing rules, and S6 enforces it. "Task Size" itself is not an organic phrase: shared assets use it to define large and high-risk work, so the variant restores a tracking-and-risk-only section and those references resolve again.

**L6** (measured before the change): the full delegation render (`buildGentlePrompt`, 21,931 B) still carried projected ODD step 2 ("Do not delegate exploration of files you will read anyway to work inline"), step 4 ("small work follows its small path") and step 6 ("when in doubt, work inline"), and named `orchestrator-writer.md` and `orchestrator-delegation-reference.md`, both full of organic routing.

**L7** (design, T2): the shared rules full delegation still needs (handoff language, launch checks, allowed edit surfaces, background policy, Key Learnings) keep one source. `scripts/build-full-delegation-card.mjs` projects them by heading, paragraph prefix and marker out of the organic cards into `assets/orchestrator-full-delegation-card.md`; every selection and pointer rewrite throws when its anchor moves, and `tests/full-delegation-closure.test.ts` fails when the card drifts from its sources. The high-risk paragraph is spliced from the organic core into the variant at render time rather than copied, and a missing paragraph falls back to the organic rules whole.

**L8** (finding, T2): the closure test had to be transitive. Three shared lazy assets (`orchestrator-memory.md`, `orchestrator-prompts.md`, `orchestrator-skills.md`) named the raw `orchestrator.md`, which leads to every organic card. Their references were provenance ("loaded from `orchestrator.md`'s pointer", "Task Size in `orchestrator.md`") and now say "the always-on core", which is exact in both modes. `orchestrator-prompts.md` also said "small tasks never need it", false in full delegation, where a writer's edit-surface candidate list is relayed through its Lossless Blocking Prompts; the load conditions alone already state when to read it.

**L9** (superseded assertions): three tests in `tests/orchestrator-delegation-mode.test.ts` from PR #2976 pinned the old design (no `## Task Size` in full delegation, `orchestrator-delegation-reference.md` named in both modes, the variant injected verbatim). They were rewritten to S3 and S2 rather than kept, because they asserted exactly the behaviour this fix removes.

