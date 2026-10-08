# Mapper persona: `/gentle:persona` gains a third mode

Status: **planned 2026-10-07. PMV10-A (`cef0fcc6`), PMV10-B (`955e10c1`) and PMV10-C are closed with their work-unit commits: the mapper persona's implementation is complete and what remains is the user's own observation of the map in a real project.**

Branch: `feat/mapper-persona`, cut from `3f41bdde` — the published tip of `feat/project-map-v4`, which equals `main` and `origin/main`. Owning worktree: `/home/facundo/projects/project-map-v4`, reused rather than recreated because its `node_modules` resolves and `pnpm` runs, so the gates are live without the sibling-worktree recipe.

Provenance: this unit was PMV-10 in `odd/tasks/project-map-v4.md`; it moved here on 2026-10-07 when it got its own branch and its own focus.

## Authorization (user decisions)

- **2026-10-06 — extend `/gentle:persona` with a third mode; do not add a command.** The mapper is a different contract of the same harness, so it reuses one state that already persists per project, already shows in the prompt and already has tests. A separate `/gentle:mapper` would create two orthogonal states (mapper + neutral, mapper + gentleman) with a second file to persist and the same injection channel, for no benefit. opencode's per-message agent selection has no Pi equivalent in the interactive session, so that option collapses into this one.
- **2026-10-06 — the mapper does not start development.** The user's own framing: the user describes functionalities, the agent documents them in the project's map, no development starts, and the switch back to building is `/gentle:persona`.
- **2026-10-07 — the mapper is not a replacement for ODD, and this is the correction that shapes the unit.** The user's words: *"no quiero un reemplazo del ODD ni de sus funciones"* — the mapper exists so that neither the orchestrator nor the user has to load the whole project into context: the map is a guide for both, and after a functionality lands you consult it to know what comes next. So ODD's workflow, its delegation ladder, its tracking and its memory discipline stay in the injected prompt for **every** mode; the mapper adds its own role, its output contract and its boundary on top, and removes nothing.
- **2026-10-07 — write policy: project-scoped.** `/gentle:persona` writes the **project override** in the working directory, creating it when it does not exist, and leaves the global file alone. Consequence accepted rather than hidden: the command stops changing the global default, so that file can then only be changed by hand, and giving the command both scopes would need an explicit scope argument that is **not** in this unit.
- **2026-10-07 — the mapper's persona text is its own**, not the gentleman text with different bullets. This is a statement about the persona text only: the harness around it (ODD, delegation, memory, review) is shared and unchanged.
- **2026-10-07 — tone: Rioplatense with voseo.** The mapper keeps gentleman's language rule, because it is the persona that speaks to the user while the artifacts are English by standing convention. The mode enum is single-valued, so a mapper cannot also be `neutral`; separating mode from tone would be a second persisted field and a separate decision.

## Objective

Mapping becomes a mode of the harness. In it, the project's map — the functional points that say what the project does and what is still missing — is built and kept current, so that the user and the orchestrator can ask *what comes next* without loading the project into context. The map is the guide; the orchestrator keeps implementing, under ODD, exactly as it does today.

## The mapper's contract, derived from the objective

This is what the mode has to mean, and it is the only source the injected text may draw from:

1. **Its job is the map.** The mapper writes and refreshes the functional points of the project in the project's own documents, following the FP format, so the map is a guide for the user and for the orchestrator.
2. **Its value is context economy.** The map must be readable as an answer to *what is next* — which means the rows carry their state and their order, not prose that has to be re-read to be understood.
3. **It does not implement source code.** Implementation belongs to the orchestrator; when the user asks for it, the mapper names `/gentle:persona` as the switch back and does not start it.
4. **It does not replace ODD or any of its functions.** The mapper runs inside ODD: it explores before writing, it tracks the map's own document, and it closes its work with a commit like any other unit. It adds a role; it removes nothing.
5. **It must not depend on a skill triggering by intent.** Its text names the FP format as its output contract directly, so mapping works in a project where nothing explicitly asks for a "functional point".

## Problem and what already exists (all measured 2026-10-06/07)

The mode is harness code, and four traps decide its shape:

1. **The reader maps any unknown value to `gentleman`** (`extensions/gentle-ai.ts:1898`, the fallback at `:1903`): adding `mapper` without touching it stores the mode, shows it as selected and reads it back as gentleman — a silent failure. `readPersonaMode` (`:1909`) resolves project, then global, then `gentleman`, and that precedence is correct today.
2. **`writePersonaMode` (`:1917`) always writes the global file** and the project override only when that file already exists — which is what the write policy replaces.
3. **The enum is shared code with its own tests**: `type PersonaMode` (`:1196`), `PERSONA_OPTIONS` (`:1198`), the persona branch (`:1225`), the handler's guard (`:4659`), and **fifteen** `["gentleman", "neutral"]` loops in `tests/persona-single-channel.test.ts` and `tests/odd-routing-contract.test.ts:338`. The byte budgets at `tests/persona-single-channel.test.ts:197-198` are frozen measurements.
4. **The command's `/reload` advice (`:4668`) is stale.** A real RPC session showed the persona applying on the next message with no reload: `system #1` carried the gentle block in `addendum` and `system #2` was a **patch of `addendum` alone**, because Pi re-derives the sections per run and patches them by name. No enabling piece is needed; the notice is what has to be corrected.

Where the injected prompt is composed, which is what decides the slice boundaries: `buildGentlePrompt` (`:1219`) emits the identity block, the persona bullets, the ODD workflow inline, and then `${getOrchestratorPrompt(...)}`, which renders `assets/orchestrator.md` (`:1120`). `before_agent_start` builds that string (`:9450`) and appends the mirrored review contract after it (`:9469`). Because the mapper removes nothing, **both** the inline ODD workflow and the orchestrator asset stay for it: the mapper is a branch in the persona section, not a second harness.

## Collisions this unit has to resolve

- **Two interactive identities writing the same repository**, with the project's unit document as shared territory: the mapper writes the functional points, the orchestrator works the units and updates their state. The mode decides who is acting, and the document is the handoff — nothing depends on an agent's memory.
- **The map must stay current without extra bookkeeping.** Progress lives in the same documents ODD's tracking already updates, so the mapper owns the *decomposition* and never has to mirror progress by hand.
- **The FP skill triggers on explicit FP intent**, which a mapper must not need: solved by contract point 5 rather than by changing the skill's trigger.
- **The persona enum is shared code with frozen tests**: the mode is added without relaxing a single measurement.
- **The map derives from documents, not from agents**: the mapper's output is read by code that already exists, so this unit changes no derivation and no display.

## Scope and non-goals

In scope: the third mode end to end; the project-scoped write policy; the correction of the stale notice; the mapper's own persona text with its role, output contract and boundary; the docs that list the modes; the measurement that the mode is live.

Non-goals: no `/gentle:mapper` command; **no replacement of ODD or of any of its functions** — the mapper does not drop the ODD workflow, the delegation ladder, the memory discipline or the review lifecycle, and this unit changes none of them; no second persisted field (mode and tone stay one value); **the corrupted-file fallback keeps today's behaviour on purpose** — a project file holding an unknown mode still reads as `gentleman`, and making it fall through to the global is a separate decision rather than a silent widening of this slice; no change to the prompt of the other two modes; no change to the FP format, to the map's derivation or to the map's display.

Operating constraints: no push and no commit without an explicit go; single-threaded writes; technical artifacts in English.

## Allowed edit surfaces

- `extensions/gentle-ai.ts`
- `tests/persona-mapper.test.ts` (new), `tests/persona-single-channel.test.ts`, `tests/odd-routing-contract.test.ts`
- `tests/runtime-harness.mjs` (added during PMV10-A: its persona block asserted the global write and the `Global config:` notice that the project-scoped policy removes, so it belongs to the same behaviour change)
- `docs/gentle-shell.md`, `docs/readme-reference.md`, `README.md` (PMV10-C only)
- `odd/tasks/mapper-persona.md` (this document; the parent alone maintains it and its memory mirror)

## Work units

- [x] **PMV10-A — the third mode, end to end, with an honest role.** *(closed 2026-10-07 with work-unit commit `cef0fcc6` — 7 files, +326/−32, with the independent verification's three findings closed: the reference text lives in this document, the fallback covers the non-string and missing-key cases, and the 16 pre-existing failures were reproduced on a pristine worktree instead of asserted.)*
  - `PersonaMode` and `PERSONA_OPTIONS` gain `mapper` (`:1196`, `:1198`); `readPersonaFile` (`:1898`) recognises it while every unknown value keeps today's `gentleman` fallback byte for byte and `readPersonaMode`'s precedence (`:1909`) is untouched; `handlePersonaCommand` stops rejecting it (`:4659`); `writePersonaMode` (`:1917`) implements the project-scoped policy; the `/reload` advice (`:4668`) is replaced by the measured truth.
  - `buildGentlePrompt("mapper")` gains the mapper's persona text — the mode line, the Rioplatense language rule, and the role in three lines: its job is the project's map, its value is context economy, and it does not implement source code (the switch back is `/gentle:persona`) — while the identity block, the ODD workflow and the orchestrator asset stay exactly as they are. That is the honest minimum, so the mode never impersonates the gentleman block. The text **as PMV10-A shipped it**, kept as that slice's record. It is *not* the current reference any more, because PMV10-B grew it into the block recorded in its own entry below — compare against that one:

    ```ts
    const MAPPER_PERSONA_PROMPT = `Persona:
    - Be direct, technical, and concise.
    - Always respond in the same language the user writes in.
    - When the user writes Spanish, answer in natural Rioplatense Spanish with voseo.
    - Act as a senior architect and teacher: concepts before code, no shortcuts.
    - Treat AI as a tool directed by the human; never present yourself as a default chatbot.
    - Push back when the user asks for code without enough context or understanding.
    - Correct errors directly, explain why, and show the better path.

    Mapper role:
    - Your job is this project's map: the functional points that say what the project does and what is still missing.
    - The map exists so that neither the user nor the orchestrator has to load the whole project into context: after a functionality lands, the map answers what comes next.
    - You write and refresh those functional points in the project's own documents, following the FP format.
    - You do not implement source code. When the user asks for implementation, say that the switch back is \`/gentle:persona\` and that the orchestrator builds it under ODD.
    - Organic Driven Development still governs you: explore before writing, track the map's document, and close your work with a commit. You add a role; you remove nothing.`;
    ```
  - Tests: a new `tests/persona-mapper.test.ts` for the mode's own invariants, and the mode list in the fifteen loops extended **only where the invariant is mode-independent**. Each loop is read on its own: the persona-specific ones keep their numbers and mapper gets its own measured budget in the new file. The existing budgets (`tests/persona-single-channel.test.ts:197-198`) are never relaxed.
  - The runtime harness's persona block (`tests/runtime-harness.mjs`) asserted the removed global write and the `Global config:` notice. It is updated in the same change, and the update is stronger rather than weaker: the global file is now asserted **byte-identical to its seeded one-line JSON**, which the pretty-printed writer could not produce, so "untouched" is proven instead of "rewritten the same way".
  - Acceptance: the mode is selectable, persists per project, renders as `Current persona mode: mapper`, survives a reader round trip, keeps the ODD workflow and the orchestrator asset in its prompt, and no other project changes persona as a side effect.

- [x] **PMV10-B — the mapper's full contract text.** *(closed 2026-10-07 with work-unit commit `955e10c1` — 3 files, +39/−7, on top of `498221a8`.)*
  - The persona text grows from the honest minimum to the complete contract: what the map is for (the guide for the user and the orchestrator, and *what is next* as its question), what it produces (functional points in the project's own documents, following the FP format, carrying state and order), and its boundary (no source implementation; the orchestrator implements; the switch is `/gentle:persona`).
  - **The user approved this text verbatim (2026-10-07)**, and the mapper's persona text must match it line for line. It is the reference an independent verifier compares against; the `Persona:` block above it is unchanged, word for word, from the PMV10-A minimum.

    ```
    Mapper role:
    - Your job is this project's map: the functional points that say what the project does and what is still missing.
    - The map exists so that neither the user nor the orchestrator has to load the whole project into context: after a functionality lands, the map answers what comes next.
    - You write those functional points into the project's own documents, following the FP format. A row carries its functional-point code and what the point is, and nothing else.
    - The state of a row is the checkbox, and ODD's tracking already updates it as work closes. The order of the rows is the order of their codes. So what comes next is the first pending row in code order — read it from there instead of inferring it.
    - Do not add fields, priority markers, dependency notes, or a second copy of the map. When the map cannot answer something, say what is missing instead of inventing it.
    - Read the project before you write: the decomposition comes from what the project actually does, from its documents and its code, not from the conversation alone. Name the documents you read.
    - You do not implement source code. When the user asks for implementation, say that the switch back is `/gentle:persona` and that the orchestrator builds it under ODD.
    - Organic Driven Development still governs you: explore before writing, track the map's document, and close your work with a commit. You add a role; you remove nothing.
    ```

  - Its size is asserted by a measured budget in `tests/persona-mapper.test.ts`: **1,919 B** of rendered persona text, measured after the change and grown from the 1,237 B of the PMV10-A minimum. That budget is the mapper's own and growing it **is** this slice; none of the eight shared budgets in `tests/persona-single-channel.test.ts` moves.
  - The decision that pins the text (2026-10-07): a row carries its code and what the point is, its state is the checkbox ODD's tracking already updates, and its order is the code order — so *what is next* is read rather than inferred. Priority markers, dependency fields and a second copy of the map are out, and the text says so.
  - The text is shown to the user before it is committed. *(Done: approved 2026-10-07.)*
  - Acceptance: with the mode on, the injected prompt carries the full mapper contract **and** the unchanged ODD workflow; with either other mode the prompt is byte-identical to today.

- [x] **PMV10-C — docs and activation.** *(closed 2026-10-07 with work-unit commit `b90c14cf` — 2 files, +21/−11: the documentation now carries the measured truth and the unit's one verification debt is paid.)*
  - The eight `gentleman` mentions in `docs/gentle-shell.md`, `docs/readme-reference.md` and `README.md` gain the third mode, what it is for, the write policy and the measured switch behaviour (next message, no `/reload`).
  - Activation in a real project is the user's own observation, and it is where the map is judged as a guide: describing a functionality, seeing it land, and reading *what is next* from the map without loading the project.

## Verification plan

Behaviour changes with runnable deterministic tests use focused RED/GREEN first, then the full suite, `check-types`, `verify-package-files` and `git diff --check` by exit code. Self-reported numbers are not accepted: each slice gets independent read-only verification before it is believed. Liveness is a real RPC session against this checkout's launcher — `--link --package-root <this worktree>` — showing the mapper block patched into the `addendum` section on the next message, the same measurement already recorded for `neutral`. Native review runs only under the user's switch, and its candidate is a work-unit commit or a PR slice, never this checklist.

## Environment (measured 2026-10-07)

`node_modules` is present in this worktree and `pnpm 11.1.1` is on `PATH`, so the full suite, `check-types` and `verify-package-files` run here as they are. The sibling-worktree recipe from PM6 (real `.gentle-ai` copy plus per-package `node_modules` links) is not needed for this unit.

## Progress and evidence

- 2026-10-07: relevo taken on `feat/project-map-v4` (`3f41bdde`, the only dirty path being `odd/tasks/project-map-v4.md`); the port's document was reconciled (its `Status:` line was stale); the user's decisions were taken in one batch; branch `feat/mapper-persona` created from the published tip with the old refs untouched.
- 2026-10-07, plan rewritten twice on the user's instruction, and both corrections are worth keeping. The **first** version carried another unit's framing (it derived a rule from the superseded capture-intent entry and named that unit's territory in its non-goals). The **second** version was worse in a different way: it built a mapper block that **replaced** the orchestrator's workflow and the delegating contract with an asset of its own, which the user rejected outright — *"no quiero un reemplazo del ODD ni de sus funciones"*. This third version removes both errors: the mapper is a branch in the persona section, ODD and the orchestrator asset stay untouched for every mode, and the role is stated in the user's own terms (the map as the guide that answers *what is next* without loading the project into context). No source file written yet.
- 2026-10-07, PMV10-A implemented by a delegated writer with TDD (RED observed first: the reader returned `gentleman`, the write went to the global path, the mode list lacked `mapper`, and the mapper clause was missing). Delivered: the enum, the reader with the fallback intact, the handler guard, the project-scoped write, the corrected notice, the mapper persona text verbatim, and the `__testing` exports the new test needs. The writer's own measurement of its change: **195 changed lines**, under the 400 budget. Parent-measured evidence on the final state: focused `tests/persona-mapper.test.ts tests/persona-single-channel.test.ts tests/odd-routing-contract.test.ts` **exit 0 — 46/46**; `pnpm test` **exit 1** with `PASS provider-contract`, `PASS runtime-harness` and `FAIL unit-tests` at 5,376 tests / 5,326 pass / **16 fail** / 34 skip; `pnpm run typecheck` exit 0 with 187 diagnostics; `node scripts/verify-package-files.mjs` exit 0 with 190 files; `git diff --check` exit 0.
  - **The finding the writer surfaced and the parent closed.** The runtime-harness stage failed because its persona block asserted the global write the policy removes. That is a real consequence of the user's decision, not a test artifact: the block is updated to the project-scoped policy, and the stage now passes.
  - **The 16 unit failures are pre-existing, and now reproduced instead of asserted.** A pristine worktree at `3f41bdde` with no diff was measured against this tree: `tests/gentle-shell.test.ts` fails **11** and `tests/vim-editor-adapter.test.ts` fails **5** — **16** in both trees, with the same failing test names and the same counts, and neither file imports the extension or anything persona-related. That is a reproduction on a tree that lacks the diff, which is what this project requires before trusting any red or green. The first attribution written here named the wrong file for eleven of them; the independent verifier caught it and the baseline settled it.
- 2026-10-07, **PMV10-A closed**: work-unit commit **`cef0fcc6`** `feat(persona): add a mapper mode that builds the project's map` — 7 files, +326/−32: `extensions/gentle-ai.ts`, the new `tests/persona-mapper.test.ts`, the two loop files, `tests/runtime-harness.mjs`, this document and the port's pointer. Independent verification (`gentle-ai-verify`, read-only) ran on the final state and returned three findings, all closed before the commit: the "verbatim" claim had no reference to compare against (fixed by carrying the text in this document), the fallback test missed non-string and missing-key inputs (four cases added), and the 16 failures were not reproduced (settled by the baseline above). It also confirmed what matters most here: **no frozen byte budget was relaxed**, the fourteen loop edits are identical one-line mode-list replacements, and no remaining caller expects the old global write or the `Global config:` notice. Not pushed.
- 2026-10-07, **PMV10-B closed**: work-unit commit **`955e10c1`** `feat(persona): grow the mapper contract into the full map contract` — 3 files, +39/−7. The approved text is in the code line for line, the mapper budget is 1,919 rendered bytes (the source literal measures 1,921 because `/gentle:persona` carries two escaped backticks, and the arithmetic closes exactly), and the eight contract clauses are asserted against the mapper slice instead of the whole prompt, which makes their non-vacuity structural rather than argued. Independent verification (`gentle-ai-verify`) reported no blocking, high or medium finding and confirmed the part that matters most: **the contract the text declares is the contract the product implements** — state derived from the checkbox (`lib/shell-project-map-draft.ts:117-118,296`) and display order by code (`lib/shell-project-map-display-order.ts:64-82`). Its three unexecuted checks were closed here by mechanics: byte-for-byte fidelity against the approved block, `GENTLEMAN_PERSONA_PROMPT` (498 B) and `NEUTRAL_PERSONA_PROMPT` (639 B) identical to `498221a8`, and the byte recomputation with its two-byte escape difference explained. **A defect of this document was found and fixed**: it carried two reference blocks for the same constant — the historical PMV10-A one and the current one — which made comparing against the wrong block possible (and it happened here); the PMV10-A block is now labelled *as shipped*, not current. Not pushed.
- 2026-10-07, **PMV10-C closed**: work-unit commit **`b90c14cf`** `docs(persona): document the mapper mode and the measured switch` — 2 files, +21/−11. The persona documentation moved to the measured truth and the verification debt is paid. **The premise of this slice was wrong, and it is corrected here rather than quietly dropped**: the plan said the third mode had to be added to eight `gentleman` mentions across three documents, but measured, `README.md` and `docs/gentle-shell.md` contain **no persona-mode documentation at all** — their matches are the brand name and the unrelated word *personal* — so `docs/readme-reference.md` was the only site with something to change, and only its capability row, its two command lines and its persona section were touched. It now carries the `mapper` row, the fact that the mode adds a role instead of replacing one, the project-scoped write policy with the global file named as the inherited default, and the measured switch behaviour with `/reload` explicitly not needed.
  - **The liveness measurement, run for `mapper` — this was the unit's one verification debt.** A real RPC session against this checkout's launcher (`--link --package-root <this worktree>`), in a scratch directory holding a project persona override, with the file flipped on disk between turns. Turn one carried the full section set (96,497 bytes) with the `gentleman` block; turn two carried a **27,567-byte patch** of the persona section with the `mapper` block, and the identity, the ODD workflow, the orchestrator contract and the delegation text were all still present in it. The switch is therefore live on the next message with no `/reload`, and **the mapper does not replace ODD or the orchestrator — confirmed in a live prompt now, not only asserted by tests**.
  - Gates after the documentation change: `pnpm test` exit 1 with `PASS provider-contract`, `PASS runtime-harness` and the same 16 pre-existing failures; `verify-package-files` exit 0 with 190 files; `git diff --check` clean. A documentation-only change takes structural verification rather than RED/GREEN, and native review is skipped for it because the review contract excludes passive documentation-only candidates.

## Open obligations

- **The global persona default becomes unreachable from the command**, which is the write policy read all the way through. Written down rather than discovered later: if both scopes are ever wanted, it is an explicit scope argument and a separate unit.
- **The corrupted-file fallback keeps today's behaviour** by decision, not by oversight: an unknown mode in a project file still reads as `gentleman` and masks the bad value instead of falling through to the global.
- **The tone cannot be composed**: with a single-value enum, `mapper` implies Rioplatense. A neutral mapping mode would be the second persisted field this unit deliberately does not add.
- **What the map carries to answer *what is next* is decided (2026-10-07): nothing new.** A row carries its functional-point code and what the point is, and that is all. Its state is the checkbox that ODD's tracking already updates when work closes, and its order is the order of the codes, so *what is next* is the first pending row in code order. The mapper writes the decomposition and never mirrors progress by hand; priority markers, dependency fields and a second copy of the map are explicitly out.
- **The suite's baseline on this machine is not stable across an install.** The 16 failures above are pre-existing and attributed, but any future red or green in `tests/vim-editor-adapter.test.ts` must be re-measured on a tree that lacks the diff before it is trusted, exactly as the port document already warns.

## Next step

**PMV10-A, PMV10-B and PMV10-C are closed**, so the mapper persona's implementation is complete on `feat/mapper-persona`: a third mode with its own contract, the project-scoped write policy, the corrected notice, the documentation that states all of it, and the liveness measurement that was the unit's only verification debt.

**What remains is not code.** It is the user's own observation of the map as a guide in a real project — describing a functionality, seeing it land, and reading *what is next* from the map without loading the project — plus the open obligations below, which are decisions rather than work: the global default is no longer reachable from the command, the corrupted-file fallback is deliberate, and the tone cannot be composed while the mode enum holds a single value. Nothing is pushed.
