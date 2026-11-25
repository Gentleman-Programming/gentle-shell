# Controlled Engineering profile option

Per-profile, off-by-default option that adds authoring-time rules restraining unrequested machinery.
Branch `feat/controlled-engineering`, base origin/main 1f6322cb9, worktree `.worktrees/controlled-engineering`.
No push, pull request or merge without the user; S5 gates the merge.

## Specs

S1. «poder poner a un perfil de gentle shell la capacidad de "controlar la sobre ingenieria"» and «el mapa de perfles es solo poder poner la opcon de "Controlled Engineering" en el mismo, porque no todos los modelos tienen este problema, con openai es constante». A per-profile on/off option named "Controlled Engineering", off by default. A profile that does not enable it behaves exactly as today: same system prompt, same `profiles.json` bytes.

S2. Approved text by role (L12 «Sí, dividila (Recomendado)», with the verifier rule «Comandos del proyecto en su copia (Recomendado)» and the precedence line «Reescribirla (Recomendado)»; it replaces the single text of L7 and L9). When the option is on, exactly one of two sections is added to the system prompt verbatim, once. Both start with the common part.

Common part:

```markdown
## Controlled Engineering

Do what the request and the evidence need, complete and correct.
Nothing enters without a reason you can point to.

Work the way the project already works:
- Before you build, test or run anything, find how the project does it
  (AGENTS.md, README, scripts, CI config) and use that command, environment
  and data setup as documented.
- Run a documented project command as written (for example its make
  target). Do not expand it into the commands behind it or change its
  flags.
- Do not create a new environment, container, database, test harness or
  tool path when the project has one. If the documented one fails, report
  the failure with its output; do not build a replacement.
```

Writer section = common part, a blank line, then:

```markdown
Before writing:
- Name the evidence for each thing you will build: the user's words, a
  failing test, an observed failure, or a caller that exists today. A case
  nobody reported and no real producer reaches gets no code.
- Name the smallest change that resolves it (often one line, a message, or
  a deletion). Start there.
- Smallest at the root, not at the symptom: find the callers of what you
  touch and fix the shared cause once.

Each of these needs a requirement that names it; otherwise leave it out:
- a new state, flag, option, config key, command or mode
- a retry, timeout, lock, watchdog, cache or fallback
- an interface, layer, wrapper or generic parameter with a single use
- a second copy or recomputation of something another place already owns
- a schema, contract version or compatibility path for data nothing ships
- variants, extra artifacts or checks the request did not name

Verify in proportion:
- The project's existing tests for what you changed, plus the test of each
  rule you changed, are complete verification unless the user asked for more.
- Anything beyond that (a scratch copy, an isolated environment, an extra
  script, a second pass) needs a reason from the request or a named risk.
  Say what you are about to do and why, in one line, before doing it.
- Where this section and broader verification guidance differ, this section
  decides how you verify, at every risk level. How much you verify, what a
  high-risk change requires, and review consent stay as that guidance says.

Always keep: validation at trust boundaries, handling that prevents data
loss, security checks, everything the user asked for, and the test of each
rule you changed. Size is not the goal: do not compress or split code to
look small.

Before finishing, read your diff and list what it adds beyond the smallest
change. Remove what has no reason. Close with `Additions: none` or one line
per addition with its reason.
```

Verifier section = common part, a blank line, then:

```markdown
Verify in proportion:
- Run the project's documented commands for what changed, in your copy of
  the repository, plus the checks your task names. That is complete
  verification unless your task asks for more.
- Never create a container, database, toolchain or environment of your own.
  If a documented command cannot run from your copy, report that check as
  not verified, with the reason and the output; do not build a replacement.
- Anything else needs a reason from your task or a named risk. Say what you
  are about to do and why, in one line, before doing it.
- Where this section and broader verification guidance differ, this section
  decides how you verify, at every risk level. How much you verify, what a
  high-risk change requires, and review consent stay as that guidance says.
```

S3. Reach by role (L3, L7, L12). The writer section goes to the primary session when the active profile has the option on and its effective orchestrator mode is `organic`, and to child sessions of `gentle-ai-worker` and `jd-fix-agent` whenever the launching session's profile has the option on. The verifier section goes to child sessions of `gentle-ai-verify` under the same condition. Nothing goes to the primary session in `full-delegation`, nor to explore or review agents. The launcher tells the child which section it gets through the existing mark: `GENTLE_PI_CONTROLLED_ENGINEERING` is `writer` or `verify`; any other value, `1` included, gives no section.

S4. The option is toggled in the `/gentle:profiles` editor and saved with the profile, the same way the orchestrator mode is.

S5. «A/B antes de mergear (Recomendado)». Before merge: paired runs on an OpenAI profile, option off against on, with tasks taken from our own cases; report per arm unjustified additions, hidden-check results, tokens, cost and time.

S6. «y codegraph desde cuando es parte de la instalacion base de gentle shell? yo pensaba que no venia». The section names no tool outside the base install (no codegraph).

Non-goals, decided with the user: intensity levels, runtime notices at the first write, turn-end checks, a codebase map, `shortcut:` comments, a usage band, Gentle Desktop UI.

## Tasks

- [x] T1 (S1-S4, S6) Persist the option, toggle it in the editor, deliver the section by role; tests and docs. Route: one gentle-ai-worker. Commits: dc17c3728 (persistence), 68a91a231 (editor toggle and delivery by role).
- [x] T2 (S1-S4, S6) Independent verification (Risk item 3: the workflow map and the child launch path are shared with the orchestrator mode and the Fast tier) and native review assess. Route: gentle-ai-verify, then gentle_review assess. Commit: n/a.
- [x] T4 (S2, S3) Split the section by role (L12): writer and verifier texts, role-valued mark; tests and docs. Route: one gentle-ai-worker. Commits: 79737fae0 (split; native review approved, lineage review-2943bccc92758619) and the review follow-up commit after it.
- [ ] T3 (S5) A/B on an OpenAI profile before merge. Route: parent, bench harness. Commit: pending.

## Log

L1. Original request, verbatim: «ok te tengo trabajo potente, quiero que analises de pie a cabeza https://github.com/DietrichGebert/ponytail y quiero que hagamos algo, revisa en engram todo lo que sea trabas, sobre ingenieria, busca ejemplos luego compara en codigo todo porque lo que quiero es podcer poner a un perfil de gentle shell la capacidad de "controlar la sobre ingenieria" pero no lo quiero hacer desde un punto de vista de un gordo vago que simplifica todo y hace lo menos posible como ponytail, sino que quiero que tengamos nuestra propia solucion basandonos en experiencia propia»

L2. Scope correction, verbatim: «el mapa de perfles es solo poder poner la opcon de "Controlled Engineering" en el mismo, porque no todos los modelos tienen este problema, con openai es constante»

L3. Decisions by question (2026-11-25): reach «Sesión principal + writers (Recomendado)»; validation «A/B antes de mergear (Recomendado)».

L4. User, verbatim: «otra cosa que veo tambien, que por ejemplo para - Prompt: una sección aparte después de extensions/gentle-ai.ts:13216, leída en vivo en cada turno. No toca el caché del prompt del orquestador. no seria una carga constante en contexto? no podria controlarse por runtime?» Decision: «Por rol + medir sobrecarga (Recomendado)»; runtime delivery is built only if the A/B shows the fixed section costs. Next step chosen: «Implementá con el borrador actual».

L5. User, verbatim: «y codegraph desde cuando es parte de la instalacion base de gentle shell? yo pensaba que no venia». Evidence: the tool wrapper ships (`extensions/codegraph-tools.ts`), the binary comes from the user's PATH (`docs/bundled-install.md:357`). Hence S6.

L7. Requirement change (2026-11-25) after enterprise feedback the user shared as two voice messages (summary in Engram observation 27641): colleagues on a brownfield Symfony/Docker app with OpenAI models report «el sistema hace demasiadas verificaciones»; the agent says it will verify and silently builds an isolated environment instead of using the test setup documented in the project. Decisions by question: text with the blocks "Work the way the project already works" and "Verify in proportion" «Aprobada»; conflict with general verification guidance «Gana la sección (Recomendado)»; verifier «Sí, también el verificador (Recomendado)». S2 and S3 rewritten; T1 reopened for the text and the agent list only.

L8. T1 first pass (worker mwwa18cb-3-iliv): 7 files, +330/-64; focused tests 28/28; typecheck failed only on TS2307 in untouched tests because the worktree had no `node_modules`. Worker-reported risk: a child launched without the gentle-pi package does not load `extensions/gentle-ai.ts` and would not receive the section.

L9. Requirement change (2026-11-25) after a third voice message and a screenshot: the project Makefile passes `--env-file .env.local` to docker compose; the agent does not run `make docker-exec` as asked, or runs the underlying command with a flag that ignores the env files, and the containers fail. Decision by question: add the line «Sí, sumala (Recomendado)»; the sentence about env files goes «Solo en la regla general (Recomendado)», not in this section. User, verbatim: «esto ultimo no es para el controlled sino para todos, ahi el agente no lee el archivo ni entra en detalles, porque lo bloqueamos? si por ejemplo yo hago un script como el de hostgator para que use mi ssh porque lo vamos a bloquear ? no tiene sentido, la idea es que el NO cargue claves y demas para que no se filtren». The sensitive-path guard and the general secret wording are a separate change, outside this feature.

L10. T2 evidence (verifier mwwatk7n-6-f7br): S1, S2, S3, S4, S6 PASS; 163/163 focused tests; typecheck clean; differential against base identical for profiles without the option (file bytes and primary prompt). Advisories: (1) a child launched by hand with only the curated extensions gets the mark but not the section, undocumented; (2) a non-boolean option value drops the whole workflow entry, including a valid `full-delegation` mode; (3) one extra `profiles.json` read when the mode comes from the env override; (4) the primary follows the effective mode, env override included. Parent decision: fix (2) by treating only `true` as on and dropping nothing, document (1), leave (3) and (4). Full suite: 12024 tests, 6 failures under triage against base (verifier mwway9bt-7-kpot).

L11. Delivery evidence (2026-11-25): full-suite triage (verifier mwway9bt-7-kpot): the 6 failures also fail on base 1f6322cb9 under the suite environment (macOS `/tmp` symlink, the codegraph socket in the worktree, host HOME leakage, and `tests/windows-hidden-processes.test.ts` already failing on base); none caused by this change. Commits dc17c3728 and 68a91a231, each with a clean typecheck and its focused tests green. Native review of the committed range 1f6322cb9..68a91a231, lenses risk, readability and reliability: approved and acknowledged, lineage review-a7b0deea69970f99, five non-blocking findings. Follow-up applied for two of them (stale reach comment in the prompt test; the env override interaction pinned and documented); left as reported: naming the role list, launch tests for an unreadable store, rendering the chip on narrow terminals.

L12. Requirement change (2026-11-25), user, verbatim: «¿No te parece que podríamos justamente dividirla? O factorizarla. ... Para, por ejemplo, el orquestador, el worker, pero el verify que le importa. ¿A verify no le importa para nada? Lo de fijarse antes de justamente escribir, porque no va a escribir, va a verificar. Entonces, al verificador, ¿qué le importa? El verifying proportion. ¿No le importa el resto? ¿O estoy mal? Hay partes que conviene para cada agente o entidad.» Parent analysis given to the user: the verifier also needs "Work the way the project already works" (the reported environments and containers appear while verifying); "Verify in proportion" spoke of "what you changed", wrong for a verifier; and the line "High-risk changes and review consent keep their own rules" switched the section off for the verifier, which is launched only for high-risk items. Decisions: «Sí, dividila (Recomendado)»; verifier rule «Comandos del proyecto en su copia (Recomendado)»; precedence «Reescribirla (Recomendado)». S2 and S3 rewritten; T4 added before the A/B so the pilot measures the final text.

L6. Evidence behind the text: ponytail analysis and our own incidents, Engram observation 27641 (`design/controlled-engineering`). The doctrine is the "Over-engineering review" of `.openclaw/skills/systemic-issue-triage/SKILL.md`, moved from merge time to authoring time.
