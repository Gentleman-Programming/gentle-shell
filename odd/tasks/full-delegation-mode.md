# Full delegation mode

Per-profile runtime switch that moves the orchestrator from organic inline-first work to supervisor-only work: every authorized mutation goes to a bounded writer, and the injected rules change with the active profile without restarting.

Branch: `feat/full-delegation-mode` · Delivery: `single-pr` (user decision, L8; forecast was ~450 authored lines, actual ~900 with tests) · Runner: `pnpm test` (node --experimental-strip-types --test tests/*.test.ts)

## Specs

- **S1** A profile may opt into full delegation mode. Any profile without the option behaves exactly as today: the rendered orchestrator core is byte-identical to the pre-change output.
- **S2** The mode travels with the profile and follows live profile switches. User's words: "la idea es, por las dudas, que si yo estoy en un perfil "normal" siga como siempre pero a la primera que cambio a un perfil cuyo orquestador esta en full delegation mode, que ya cambie su actuar de una, pero si vuelvo al anterior vuelva a las reglas de siempre". Switching takes effect on the next turn (the profiles panel action itself runs between runs); no process restart is required in either direction.
- **S3** In full delegation mode the orchestrator never implements inline. Every authorized mutation goes to a bounded writer, one writer per unit of behavior with its code, tests and docs together, with an explicit `## Allowed edit surfaces`. The orchestrator keeps authorize, explore-for-routing, decide, ask, feature document plus mirror plus `todo`, work-unit commits, verification, and reporting.
- **S4** Context does not grow: exactly one variant block is injected per turn, never both, and the rendered core stays within the existing 9250-byte budget asserted by `tests/orchestrator-budget.test.ts`. Detail stays in lazily referenced assets, never inlined.
- **S5** `/gentle:profiles` exposes the switch on the shown profile with a single key press (`w`), shows the mode on the **Orchestrator row** beside the tier indicator with **equal visual weight for both modes** — distinct only by glyph and label, never by tone — and states what each mode does in the Orchestrator row's description line, so neither mode reads as the lesser or the special one.
- **S6** An unknown or malformed mode value is never silently accepted: it is dropped on read and surfaced through the existing drops channel, the same contract `normalizeProfilesFile` already uses for dropped profiles and dropped agents.
- **S7** The memoized orchestrator core re-renders when the mode changes. The process-lifetime cache key includes the mode, so no stale block survives a profile switch.
- **S8** The option and its semantics are documented where the profiles panel and the orchestrator rules are already documented.

## Tasks

| ID | Specs | Route | Status | Evidence |
| --- | --- | --- | --- | --- |
| T1 | S1, S2, S6 | inline | done | `99e493561`; `lib/agent-profiles.ts` workflow map, normalization, serialization, lifecycle; `tests/agent-profiles-workflow.test.ts` (9 green) |
| T2 | S2, S7 | inline | done | `5f3687d3a`; `lib/orchestrator-mode-policy.ts` resolver with source attribution; `tests/orchestrator-mode-policy.test.ts` (9 green) |
| T3 | S1, S3, S4, S7 | inline | done | `15ad6c5c1`; `assets/orchestrator-full-delegation.md`, `applyDelegationMode` + cache key in `extensions/gentle-ai.ts`, packaged-asset list; `tests/orchestrator-delegation-mode.test.ts` (8 green). Measured: organic 9146 B, full delegation 5611 B (-3535 B) |
| T4 | S5 | delegated | done | `9cfacecb6`; `w` toggle with draft semantics, atomic save/use-session persistence through `setProfileOrchestratorMode`, orchestrator-row chip beside the tier, mode draft survives switch-save and the custom-model reopen; `tests/profiles-panel-delegation-mode.test.ts` (16 green) |
| T5 | S8 | inline | done | `5a10a7984` + the peer-modes docs rewrite; `docs/gentle-shell.md`, `docs/readme-reference.md` |

## Log

**L1** (user request, verbatim): "te comento lo que quiero trabajar desde un nuevo worktree, ahora mismo tenemos el concepto de delegacion organica, cuando el orquestador puede hace todo inlines pero claro tenemos reglas para evitar el context rot y empezar a delegar, como por ejemplo el 15% de la ventana o tambien cuando el costo de delegar es menor que la tarea a implementar. Que quiero hacer? hay una casuistica donde es necesario que un orquestador SOLO orqueste, las implementaciones las haga un sub agente, por ejemplo aquellos que utilizan modelos frontier para investigar, orquestar, pero luego utiliza sub agentes con modelos locales. Que quiero? tener la posibilidad de en /gentle:profile poder optar por agregar una condicion al orquestador que diga "full delegation mode" y con esto que haga "switch" a esto nuevo workflow. Este cambio debe ser a nivel runtime para no llenar el contexto con cosas que no queremos"

**L2** (user requirement, verbatim): "la idea es, por las dudas, que si yo estoy en un perfil "normal" siga como siempre pero a la primera que cambio a un perfil cuyo orquestador esta en full delegation mode, que ya cambie su actuar de una, pero si vuelvo al anterior vuelva a las reglas de siempre"

**L3** (accepted decisions, from the questionnaire): persistence is per profile, not a standalone policy file; the panel exposes a dedicated key plus a footer indicator rather than a menu entry; the mode delegates mutations only, leaving exploration/verification to the orchestrator's judgement instead of forcing every action through a subagent.

**L4** (accepted deviation, rationale): the approved shape nested the flag at `profiles[name].workflow.orchestratorMode`. `normalizeProfilesFile` (`lib/agent-profiles.ts:143`) runs every profile through `normalizeModelConfig`, whose contract is `Record<string, AgentRoutingEntry>` and which drops any non-routing key while reporting it as a dropped agent — the nested flag would be destroyed on the first read and reported as a broken role. The flag therefore lives in a sibling `workflow` map keyed by profile name at file level. Same profile, same file, same live-switch semantics, no change to the routing contract.

**L5** (discovery, evidence): `getOrchestratorPrompt` memoizes the rendered core on `policy:capability:singleShot:rddStatusLine` (`extensions/gentle-ai.ts:1309`), so the mode must join that key or a switch renders stale for the rest of the process.

**L6** (discovery, evidence): the ODD protocol steps come from the digest-verified mirrored bundle `routing/pi.md` and the review contract from `orchestration/pi.md`, both locked in `contracts/review-provider-contract-mirror/provider-contract.lock.json`. Those are contract artifacts and stay untouched; the mode variant lives in `assets/` only, so this change does not alter a published contract.

**L7** (discovery, evidence): Pi clones `_baseSystemPromptOptions` per `before_agent_start` emit, and `use-session` writes an `origin: "user"` binding that `resolveSessionProfile` consults before any frozen snapshot, so a per-profile flag read through the resolver follows live switches. The startup freeze pins only the `inherited` branch, which is why the resolver must never read the `readFrozen*` views.

**L8** (user decision, delivery): one branch and one pull request (`single-pr`), chosen when the running authored-line count crossed the review-focus threshold. No push, PR or merge without the user asking.

**L9** (accepted deviation, rationale): the approved panel key was `d`, but `d` is already bound to **Make default** (`ROUTING_TABLE_HINTS`, `handleTableKey`). The toggle uses `w` and the hint reads `w mode`; nothing was rebound.

**L10** (measured baseline failure, not caused by this change): `tests/orchestrator-budget.test.ts` fails at the branch point `6b0721bc2` with `getOrchestratorPrompt() returned 9266 B at controlled 128-char assets root, exceeds the 9250 B budget` — 16 B over, reproduced in a detached worktree at that commit with no local changes. Left untouched; the organic path stays byte-identical by design, so this change neither fixes nor worsens it.

**L11** (user requirement change, verbatim): "puedes poner el orcanic o el full-delegation al lado de fast? del orquestador? asi lo tenemos más fácil como referencia"

Rewrote S5 only: the mode moved from the footer status to the Orchestrator row, beside `Fast` / `Standard`. Rationale: the footer status is already pinned by an existing assertion in `tests/gentle-ai.test.ts` and is read far from the routing decision, while the Orchestrator row is where the profile is actually evaluated. The footer chip is dropped rather than duplicated, so the mode keeps exactly one place on screen.

**L12** (known baseline failures, verbatim names, evidence: the identical set reproduces on a `mktemp` scratch clone of the branch point with a symlinked `node_modules` and no local diff, so none is caused by this feature). `tests/gentle-ai.test.ts` reports 196 tests, 180 pass, 16 fail, and the 16 are:

- a frozen profile deleted from profiles.json is named, and no tab carries ◉
- a profile frozen at startup carries ◉ and opens first after the default changes
- a session profile edited in profiles.json after the freeze or the binding says its launches keep the older routing
- clear after a new session's new start, as Pi records it, goes back to the defaults it started with
- clear after a new session's startup start, as Pi records it, goes back to the defaults it started with
- clear after a session's own start goes back to the defaults it started with
- clear right after a session's own start with a startup profile says it is already there and writes nothing
- clear right after a session's own start with no startup profile says it is already there and writes nothing
- From what's running now in a frozen session saves the frozen routing, not the global one or a later pin
- provider review roles skip the orchestrator fallback for a profile frozen at the session's own start
- provider review roles skip the orchestrator fallback for an inherited profile
- reviewer routing follows the profile the session froze at startup, not later global routing
- reviewer routing in follow mode reads the profile the target resolves now
- reviewer routing keeps a frozen pin snapshot after the pin changes
- reviewer routing of a session frozen without a profile ignores a pin added later
- the subagents.json notice follows whether the session resolves a profile, not the pin

The whole cluster is session-freeze, pin and reviewer-routing behavior — the same area this feature reads through `resolveSessionProfile` and deliberately does not freeze. Left untouched: they are the user's to triage, and fixing them inside a delegation-mode feature would be exactly the scope creep that hides a real regression later.

**L13** (user correction, verbatim): "ojo, organic no es peor que full-delegation, necesitamos diferenciar que solo son dos modos diferentes y quiero mostrar tambien que hace cada uno pero de una manera comoda"

Rewrote S5 only. Two defects fixed: the chip carried a ranking nobody asked for (`accent` for full delegation against `dim` for organic), and it named the modes without saying what they do. Both modes now share one tone — the distinction is glyph plus label alone — and the Orchestrator row's existing description slot states both behaviours and the key, symmetric in length so neither mode reads as the special case.

**L14** (panel final state, after two user corrections): the chip lives on the Orchestrator row only, has no mouse region, and its form table carries `{text, mode}` with **no tone field** — a single `ORCHESTRATOR_MODE_CHIP_TONE = "status"` renders both modes alike, so a per-mode ranking is not expressible rather than merely avoided. The symmetric ladder is `◎ organic` / `◎ org` / `◎` and `⚡ full delegation` / `⚡ full` / `⚡`, with the fallback chain yielding first. `ORCHESTRATOR_MODE_EXPLAINER` (`◎ inline · ⚡ writer · w switches`) is appended to the existing cursor-bound description slot only while the Orchestrator row is focused, is identical for both modes, and drops before it can wrap.

**L15** (user correction, verbatim): "cambia el rayo por otra cosa"

`⚡` out of both source and tests, `⇄` in. The bolt is the same hierarchy as the tone had, in another channel: lightning means fast/power in every UI convention, so it read as the better mode. `⇄` states a handoff — work goes out to a writer and comes back — which is exactly what the mode does, and it stays distinct from the fallback arrow `↪` that lives on the same row. Rungs and the explainer keep their symmetry: `◎ organic` / `⇄ full delegation`, and `◎ inline · ⇄ writer · w switches`.

**L16** (delivery mechanics, before the PR): the branch was cut from local `main` at `6b0721bc2`, which carried 21 commits never pushed to `origin` and was 76 commits behind `origin/main` (`ff6f710be`). Pushing as-is would have shown 21 unrelated commits in the PR and diffed against a stale orchestrator core. Rebased the 12 feature commits onto `origin/main` with `--onto` (clean, no conflicts; the two splice anchors still occur exactly once upstream), which drops the unrelated commits and keeps the PR to this feature. After the rebase the canonical budget test passes 33/33 — upstream fixed the 16-byte overage recorded in L10 — and the 16 `tests/gentle-ai.test.ts` failures of L12 are re-measured on the new base before merge rather than assumed unchanged. Pre-rebase state preserved as branch `feat/full-delegation-mode-prerebase`.

**L17** (regression the full suite caught, and the row policy it settled): the first full run on the rebased tree reported **9103 tests, 9009 pass, 1 fail** — and the single failure was this feature's. `tests/profile-fast-tier.test.ts` asserts `Fast ▾\s+↪ fallback/model`, i.e. that the fallback chain sits directly after the tier, and the chip had been inserted between them. The chip was moved to **after** the chain rather than editing that assertion: the adjacency is existing, asserted behaviour of the row, and a new reference does not get to move it. Because a chip that simply loses to the chain would then vanish whenever a fallback is configured, the chain is now sized around the chip's shortest **word** form, so the chain yields first and the mode stays readable down to ~70 columns; below ~60 the row holds neither and the model name wins, exactly as before this feature. Verified by rendering at 100/90/80/70/60/50 rather than deriving the fit by hand.

Also from that run: the 16 `tests/gentle-ai.test.ts` failures of L12 and the 16-byte budget overage of L10 are **both absent on `origin/main`** — upstream fixed them across the 76 commits this branch was rebased onto. Neither is this feature's to claim or to fix.

