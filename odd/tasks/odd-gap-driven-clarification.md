# ODD gap-driven clarification

Objective: stop the harness from silently assuming costly decisions (scope, stack, architecture, data, deployment, credentials) and from implementing deferred ideas; replace "one question at a time" with gap-driven grouped questionnaires and a per-feature `## Future` section.
Branches: `feat/odd-gap-driven-clarification` in gentle-ai and gentle-pi (gentle-shell). Delivery: `ask-on-risk`. Runners: gentle-ai `go test ./...`; gentle-pi `npm test` (node --test).

## Specs

Canonical texts below are normative: both repositories must carry them byte-identical wherever the mirrored contract carries the replaced text. Adapt only surrounding list numbering/markup where a file uses a different wrapper.

- **S1 — Gap analysis replaces "one focused question" (ODD step 3, short form).** Replace the step-3 sentence "ask one focused user question only for a real unresolved product decision, then stop and wait" with this canonical step 3:

  > 3. **Resolve uncertainty.** Recommend optional research only for a named uncertainty. From the exploration, list the gaps the request and the repository leave open, and ask only those that block now or a foreseeable later task and are costly to undo (scope, stack, architecture, data, deployment, security-relevant configuration); answer the rest from evidence or record a visible default assumption. Ask them in one grouped questionnaire, a question alone first only when its answer changes the others; then stop and wait. Use at most one scoped read-only assumption challenge for a high-consequence unproven premise.

- **S2 — Gap analysis detail (reference paragraph).** Where the long-form reference text says "The parent owns product decisions: ask one focused user question only for a real unresolved product decision, then stop and wait; workers return gaps to the parent rather than assuming choices.", replace that sentence with:

  > The parent owns product and foundation decisions. After exploring, list the gaps the request, the repository, and the installed tools leave open, and classify each: answered by evidence, do not ask; blocks now or a foreseeable later task and is costly to undo once code depends on it (scope or audience, stack, architecture, data store, deployment target, security-relevant configuration), ask; cheap to change, choose a sensible default and record it as a visible assumption the user can correct. Ask about a later task upfront as a possibility, record the answer with the condition it depends on, and ask again only if that condition changes. Clarification is complete when no costly blocking gap remains, not when every gap is closed; when more than about five gaps qualify, ask the root decision (objective or scope) first. Use the structured question tool when available: group independent questions into one questionnaire, and ask a question alone first only when its answer changes the others. Each question offers the recommended option with its reason, a relevant alternative, "Decide for me" (choose and record the assumption), and "Explain each option" (explain each option didactically, then ask only that question again); free text stays available. When a better result needs a tool that is not installed, recommend it as an option in that questionnaire and never install without consent. Never leave generated services with empty or default credentials: generate secrets into an ignored environment file and commit only a placeholder example. Workers return gaps to the parent rather than assuming choices.

- **S3 — Ask trigger.** Replace the Ask trigger/mechanism wording "an open product or design decision gets one focused user question; stop and wait" with:

  > open gaps that block now or a foreseeable later task and are costly to undo get one grouped questionnaire (a question alone first only when its answer changes the others); stop and wait

- **S4 — Deferred ideas stay deferred (`## Future`).** In the feature-document structure (step 5 and its long form), add a `## Future` section between `## Tasks` and `## Log` with this canonical sentence:

  > `## Future` holds ideas the user explicitly defers; they never become `S#` or tasks.

  And add to the long-form reference text:

  > When the user frames something as a later idea, do not implement or prepare it: record it under `## Future` in the current feature document, let it inform choices that would otherwise block it, and surface it only at that feature's close, on its resume, and when new work touches the same area; the user plans, keeps, or discards each item. Small work without a document reports a deferred idea in its closing report.

- **S5 — Close surfaces Future (ODD step 7).** Append to step 7 (Close), after the sentence that reports the verified outcome and next step:

  > Present the feature's `## Future` items and let the user plan, keep, or discard each.

- **S6 — Personas group questions (gentle-ai only; neutral and gentleman, every agent variant).** Replace "Ask at most one question at a time, then STOP and wait." (and its equivalent phrasings, e.g. "Ask at most one question at a time. After asking it, STOP and wait.") with:

  > Group questions that do not depend on each other into one batch; ask a question alone first only when its answer changes the others, then STOP and wait.

- **S7 — YOLO is permissions only (gentle-pi only).** Remove the sentence "Make ordinary reversible implementation choices without needless interviews." from the YOLO session policy and its doc (`lib/yolo-session-policy.ts`, `docs/yolo-mode.md`); update tests that pin it. YOLO keeps granting permissions and nothing else.

- **S8 — Mirror parity.** gentle-pi's mirrored ODD contract (`fixtures/odd-routing-canonical.md`, `extensions/gentle-ai.ts` harness steps, `assets/orchestrator-*.md`) must carry S1, S3, S4, S5 byte-identical to gentle-ai's canonical routing asset; contract tests stay green in both repositories.

Assumption (not requested, recorded): "Decide for me" / "Explain each option" labels are English in artifacts; the runtime translates them into the user's language per the Language Domain Contract.

## Tasks

| ID | Specs | Repo | Route | Status | Commit |
|----|-------|------|-------|--------|--------|
| T1 | S1-S6, S8 (source of truth) | gentle-ai | delegated (Writer trigger a: parallel, disjoint repos) | done | gentle-ai eef1f704a |
| T2 | S1-S5, S7, S8 (mirror) | gentle-pi | delegated (Writer trigger a: parallel, disjoint repos) | done (fixture via T2b; 3 full-suite failures under base comparison) | 587bdb902 |
| T3 | S1-S8 | both | independent verifier (Risk item 3: mirrored contracts others consume) | in_progress | — |
| T2b | S8 | gentle-pi | inline (parent): regenerate `fixtures/odd-routing-canonical.md` with `npm run mirror:odd-routing -- --gentle-ai <T1 checkout>` after T1 commit | done | (this commit) |
| T4 | — | both | issues + PRs (gentle-shell#2224 and gentle-ai#5513 created; PRs pending) | in_progress | — |

## Future

(none)

## Log

- **L1 (2026-10-14, user feedback relayed by Alan, verbatim):** "Hola Alan! Te comento que cuando le pongo a hacer una actividad desde cero, usualmente suelta 2 preguntas de aclaración antes de iniciarse con odd (me toca detenerlo y aclarar manualmente detalles) y suele dejar por fuera cuál arquitectura va a usar, cual stack se va a usar, y asume una al azar de las que tenga instaladas, qué base de datos usar, si tengo contenedores suele asumir que usaré 1 en vez de dejarme elegir si usaré docker o vps, etc en pos de hacer más escalable (o no) a futuro el proyecto; también asume las bases de datos en configuración genérica (vanila sin ponerle la contraseña)... Adicional me gustaría que en caso de no tener las herramientas necesarias, me sugiera instalar las que Son más convenientes (si no las tengo instaladas) para tener un mejor resultado, ejemplo opendesign para interfaces web o posgresql si quiero una base de datos de manejos robustos, etc, en base a lo que solicito y dejarme elegir el alcance (si no lo planteé) ya que a peticiones vagas toma mayormente que el alcance será para uso personal o local cuando quizás quiero alcance mundial.Y si de verdad no tengo conocimientos de lo que le estoy pidiendo, que ahí me ofrezca la opción "decidir por mí" o "explícame didácticamente cada opción" para hacer que el modelo sí sea determinista (asuma) en esa decisión o el usuario entienda y decida mejor. También que si planteo algo como una visión futura o algo que me gustaría hacer para después, después de sentar las bases de lo que pedí, efectivamente la deje para después como una sugerencia para recordatorio post odd, ya que actualmente asume que lo quiero ya y empieza a prepararlo, cuando dejo claro que es una idea con [miras] a hacerlo en el futuro y quizás para otra sesión... La verdad que muchas veces no sé determinar si el problema deriva del modelo o del arnés, así que si por si acaso es el arnés, dejo esta petición. Gracias."
- **L2 (Alan, verbatim):** "Una cosa que no me gusta mucho es el tema del future.md. [...] debería ser como un apartadito o algo por el estilo que esté relacionado con la feature que se estaba trabajando. [...] ¿cuándo hay que leer eso? ¿Cuál es el criterio con el cual tenemos que leer esto? Después, lo de Yolo, no lo entiendo porque Yolo en sí es para permisos de la gente."
- **L3 (Alan, verbatim):** "El tema es ver cuántas preguntas y cuándo consideramos que está listo. [...] algo que no quiero es tener 160 preguntas. Necesitamos ver muy bien dónde están los huecos y rellenarlos. [...] No es siempre para un proyecto nuevo y que eso sea el trigger. Luego sobre el output style, no debería decir eso. Ask at most one question at a time, then stop and wait. [...] lo que se pueda agrupar, agrupamos. Si necesitamos una pregunta antes para poder resolver las siguientes, es solamente esa pregunta. [...] Y esto tiene que ser algo también neutral, como también el modo gentleman."
- **L4 (Alan, verbatim):** "a la parte de solo bloquea una tarea posterior que se pregunta cuando llegue a esa tarea, yo creo que igualmente la preguntaría antes, ¿eh? diciendo que hay una posibilidad de que esto suceda y a ver qué quiere hacer y que ya eso quede definido y en caso de que cambie bien las condiciones que generen ese bloqueo, volver a preguntar cualquier cosita."
- **L5 (Alan, verbatim):** "Dale y mejor hagamos los dos a la vez"
- **L6 (analysis):** Root cause is the harness: ODD step 3 limits questions to "a real unresolved product decision"; YOLO policy says "Make ordinary reversible implementation choices without needless interviews"; personas say "Ask at most one question at a time". Design agreed in conversation; Engram `design/odd-gap-driven-clarification`. gentle-pi `SOUL.md` carrying the persona line is untracked local state, not in the repository; out of scope. Related, not duplicate: gentle-ai#5478 (optional PRD phase before ODD).
- **L7 (evidence):** gentle-pi `fixtures/odd-routing-canonical.md` is a generated, sha-pinned snapshot (`scripts/mirror-odd-routing.mjs`, checked by `tests/odd-routing-canonical-ratchet.test.ts` via block_sha256 and source_commit); never hand-edit, regenerate from the committed T1 checkout (T2b). Issue gentle-shell#2224 created.
- **L8 (Alan decision, 2026-10-14):** budgets: "Subir presupuestos (Recomendado)" — gentle-pi orchestrator-tracking.md budget 12,600 → 14,100 B, orchestrator-delegation.md 20,800 → 20,900 B for S2/S3. gentle-ai issue checkbox: "Sí, marcarlo" — gentle-ai#5513 created with status:needs-review (no status:approved).
- **L9 (evidence, T2):** RED 3 failures on old text; GREEN odd-routing-contract 16/16 (parent spot check re-ran: 16/16), yolo-session-policy 5/5, ratchet+budget+contract+yolo 61/61, typecheck clean. `npm test`: 6677 pass / 3 fail (orchestrator-consultation-sdk publish test; two review-host-relay-routing refusals) — all pass in isolation; base comparison running. Base comparison (origin/main, same node_modules): the two review-host-relay-routing refusals fail on base too (pre-existing, not caused by this change); orchestrator-consultation-sdk passed on base and passes isolated on the branch (load-flaky, unrelated files). Core `assets/orchestrator.md` Ask row is a condensed pointer (8,400 B core budget); canonical S3 lives in orchestrator-delegation.md — T3 to confirm acceptable for S8. Commit 587bdb902.
- **L10 (evidence, T1/T2b):** T1 committed gentle-ai eef1f704a (27 files, +155/-40); RED/GREEN reported by writer; parent spot check `go test ./internal/components/agentguidance/ ./internal/assets/` ok. `go test ./...`: internal/cli timed out at 10m default (passes with -timeout 40m in 1029s); legacyassets TestReleasedSDDAgentDigestsMatchGenerator fails on origin/main too (pre-existing, environmental). T2b regenerated fixture from eef1f704a (block sha 4755b62e…); regeneration also pulled unrelated upstream drift since 0dda889 (writer named-reason trigger, Risk line, `--agent pi`), so the ratchet anchor for the writer trigger was updated to the new canon. ODD contract tests 77/77.
