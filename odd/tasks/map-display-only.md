# Map display-only: the card is a view, and the command is gone

Status: **closed 2026-10-07. MD-1 (`e1825bdb`), MD-2 (`e9d748ff`), MD-3 (`967d53d8`) and the independent verification's findings (`e0dd9a95`) are committed; the native review, the push and the PR follow.**

Branch: `feat/map-display-only`, stacked on `feat/mapper-persona` (`b466e391`) so this checkout keeps the `mapper` mode that a real project has just had activated. `main` stays at `3f41bdde`, and `feat/mapper-persona` stays untouched.

Provenance: the owner asked, right after the mapper persona landed, whether `/gentle:project-map` could be deleted so the map is always shown. This unit is that change; it is not part of the persona unit.

## Authorization (user decisions, 2026-10-07)

- **Decision 1 — display-only: everything executable goes with the command.** The `/gentle:project-map` command and its thirteen sub-actions are removed, the card's launch gesture goes with them, and the `GENTLE_PI_PROJECT_MAP` gate becomes moot. The map is a view of the project's functional points; the orchestrator does ODD.
- **Decision 2 — the empty state renders the title only.** No message, no instruction.
- Both decisions were taken after the measurements below, and the second one was re-confirmed once the measurement showed that the card calls the command internally.

## The measured facts that shape the unit

- **The card already shows by default**, so the command is not what makes it appear: session visibility starts `undefined` and the effective default is `true` (`extensions/gentle-project-map.ts:1364-1369`), and the executable flag does not gate the card at all (`lib/shell-project-map-gate.ts:18-23` reads it only for the executable routes).
- **The command carries thirteen sub-actions** (`extensions/gentle-project-map.ts:114`), and **six of them cost nothing to delete**: `ensure`, `draft`, `declare`, `approve` and `status` write and read `openspec/project-map.json` (`:1178-1195`, `:1197`, `:1199-1237`, `:1239-1290`, `:1040-1050`, with `writeProjectMapFile` at `:1120-1134` and `:1162-1174`) — which **contradicts D3=b of this same branch**, where no persisted artifact and no `openspec/**` exist — and `show` is redundant because visibility is already true.
- **The command is also internal API.** The card's launch gesture invokes it: `runProjectMapCommand("open …")` (`:1426`), with the tabs wired at `:1382-1412`. So the gesture is removed together with the command, not rewired to a surviving function.
- **The default visibility path has no test.** The extension's test helper injects `{ [PROJECT_MAP_EXECUTABLE_ENV]: "1" }` for every test built through it (`tests/gentle-project-map.test.ts:1078-1079`), and the gate-off tests cover executable-route refusals only (`:1698-1740`). The decision that every real session runs — card visible with the gate unset — is uncovered. That is the F1 obligation, confirmed.
- **The empty state instructs the user to run the command being deleted**: `No Project Map at …` and `Run /gentle:project-map to generate one.` (`lib/shell-project-map-view.ts:332-336`), subtitle `no map` (`:375`), and the same file renders command prompts at `:335` and `:341` that go stale.
- **Documentation to correct**: `docs/project-map.md:3`, `:90-105`, `:139`, `:157-161`, `:304-308`; `docs/gentle-shell.md:246-252`.
- **Dead export to remove while we are here**: `projectMapCardVisible` (`lib/shell-project-map-card.ts:191-193`) has no callers — a PMV-2 obligation that this unit closes.
- **What the card still needs** (so the deletion does not break the view): `lib/project-map-store-root.ts`, `lib/project-map-coordination-state.ts`, `lib/project-map-store-worktrees.ts`, `lib/project-map-launchable.ts`, `lib/project-map-help-modal.ts`, `lib/project-map-description.ts`, `lib/project-map-translations.ts`, and the card modules themselves — the tabs and the `?` explanation are read-only projections and they stay. **One entry of this list was wrong and the verification caught it**: `lib/project-map-launchable.ts` was not needed by the card once the launch gesture went, its only remaining importer was its own test, and it was deleted in `e0dd9a95` along with its package-list entry.

## Objective

The map renders itself, is always visible, and does nothing. Every executable route leaves with the command, so the view, its tabs and its explanation are the whole feature, and the derivation stays exactly as it is.

## Scope and non-goals

In scope: deleting the command surface and the executable half; deleting every module and test that loses all references; removing the gate and its helpers; removing the launch gesture; the title-only empty state; the stale prompts; the docs; and the missing gate-off coverage.

Non-goals: no change to the derivation, the FP format, the mapper persona or the card's read-only gestures (tabs, `?` explanation, the counter and row cap stay); no new persisted artifact and no `openspec/**`; nothing is pushed; and the fork's history is not rewritten — everything deleted here remains recoverable from `3f41bdde` and from this branch's history.

Operating constraints: no push and no commit without an explicit go; single-threaded writes; technical artifacts in English.

## Allowed edit surfaces

- `extensions/gentle-project-map.ts`
- `lib/shell-project-map-*.ts`, `lib/project-map-*.ts` — only the files that become unreferenced
- `tests/gentle-project-map*.test.ts`, `tests/shell-project-map*.test.ts`, `tests/project-map-*.test.ts` — only the files, or the ranges, that test removed code
- `scripts/verify-package-files.mjs` (pack list only)
- `docs/project-map.md`, `docs/gentle-shell.md`
- `odd/tasks/project-map-v4.md` (the roadmap lines the deletion invalidates)
- `odd/tasks/map-display-only.md` (this document; the parent alone maintains it and its memory mirror)

## Work units

- [x] **MD-1 — pin the behaviour before changing it.** *(closed `e1825bdb` — two gate-unset tests, proven able to fail by inverting the effective default and restoring the source byte for byte.)*
  - Add the missing coverage: a test that mounts the extension **with `GENTLE_PI_PROJECT_MAP` unset** and asserts the card is rendered and visible, plus the hide path for the session. This is a **characterization** test, not RED/GREEN: it asserts today's behaviour so the deletion cannot silently change it, and it closes the F1 obligation for the visibility decision.
  - Acceptance: the new test fails if the card's default visibility is inverted, and the file's existing tests keep their environment injection untouched.

- [x] **MD-2 — the map becomes display-only.** *(closed `e9d748ff` — 25 files, +479/−7,744; six modules and ten test files deleted, each with its last reference removed.)*
  - Remove the command registration, the dispatch (`:114`) and the thirteen handlers; remove the card's launch gesture; delete every module and test that loses all references; remove `GENTLE_PI_PROJECT_MAP` and its helpers; delete `projectMapCardVisible`.
  - **The orphan list is measured inside this slice, not assumed**: the first exploration could not close it, because the store family has internal dependencies and the extension owns both the command and the card. The slice reports the list it actually deleted, with the last reference for each.
  - Acceptance: no reference to the command or its actions remains in `extensions/`, `lib/`, `tests/` or `scripts/`; the card still renders, its tabs still project and its explanation still opens; the full suite passes with the same pre-existing failures and no new one; `verify-package-files` passes with the pack list updated.

- [x] **MD-3 — the view tells the truth.** *(closed `967d53d8`, and corrected by `e0dd9a95`: see the verification section — it blanked the wrong empty state.)*
  - Title-only empty state; the two stale prompts in `lib/shell-project-map-view.ts` corrected; `docs/project-map.md` and `docs/gentle-shell.md` rewritten where they document the command; and the roadmap lines in `odd/tasks/project-map-v4.md` that named the removed surface corrected rather than left silently — including D4=a, which no longer has anything to gate.
  - Acceptance: no doc instructs a user to run a command that does not exist, and no doc claims a gate that is gone.

- [x] **MD-4 — verification.** *(closed by `e0dd9a95`: the independent verification's findings are fixed, and its one blocking item is recorded as a transport limit rather than a defect.)*
  - Independent read-only verification of the final state, and one real RPC session with `GENTLE_PI_PROJECT_MAP` unset showing the card mounted with no command run — the gate-off path measured in a live session, which is what the F1 obligation asked for.

## Verification plan

Behaviour changes with runnable deterministic tests use focused RED/GREEN first, then the full suite, `check-types`, `verify-package-files` and `git diff --check` by exit code. Deletions are verified by reference tracing plus the suite: a deletion that leaves a dangling import fails the type gate, and one that leaves a live caller fails the suite. Self-reported numbers are not accepted: each slice gets independent read-only verification before it is believed. Native review runs only under the user's switch, and its candidate is a work-unit commit.

## Open obligations and risks

- **Review budget**: MD-2 is a deletion, so its diff size is measured before the commit, and if it exceeds 400 changed lines the user decides — split by module family, or register the overage. That is this project's standing rule, and a deletion of this size will very likely exceed it.
- **The artifact writer contradiction is closed by deletion, but it is worth recording**: `ensure`, `draft`, `declare`, `approve` and `status` wrote and read `openspec/project-map.json` while D3=b says this branch has no persisted artifact. Nothing else in the branch was writing one.
- **Units that lose their surface**: the port document's D4=a becomes moot, and any roadmap entry that named `worktree`, `open`, `integrate`, `lead` or `contract` as its surface has to be corrected rather than left claiming a surface that no longer exists.
- **The activation dependency**: the `mapper` mode activated in a real project works because this branch is stacked on the persona branch. If this branch is ever rebased onto `main` alone, that activation breaks silently — the persona file would say `mapper` and a session would behave as `gentleman`.

## Verification and closure

Independent read-only verification ran on the final state. Its three findings and their disposition:

- **High, and it was a real defect of MD-3**: the slice blanked `kind: "empty"`, which is the *artifact*-empty case, while the state a project without functional points actually reaches is `kind: "no-fp"` (`extensions/gentle-project-map.ts:209`, `lib/shell-project-map-view.ts:317-320`) — still rendering a message and an instruction. Both empty states now render the title and nothing else, with no subtitle either, because the owner's decision was title only and the card frame paints a subtitle only when it has one (`lib/shell-card.ts:127`).
- **Medium**: `lib/project-map-launchable.ts` survived with no production consumer and its only importer being its own test; deleted.
- **Medium**: "title only with a state subtitle" was a narrower reading than the decision; the subtitle is gone too.

**One blocking item that is a transport limit, not a defect.** A real RPC session against this checkout set the widgets of `btw`, `gentle:yolo`, `gentle-todo` and `gentle-shell-dev-binary`, and never the map's `gentle-project-map`. The verifier found the cause in the installed adapter: RPC **ignores component factories** for widgets (`node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js:123-136`) and does not support custom overlays (`:152-154`), so a successful mount can produce no RPC widget request at all. The map mounts only on `session_start` (`extensions/gentle-project-map.ts:373`), and that wiring is identical to `3f41bdde` (`:1542`), so this is pre-existing and not caused by this unit. **What settles it is an interactive session in a terminal** — the card, its tabs and the `?` — which is the owner's own observation, and RPC cannot substitute for it.

## Delivery chain (upstream pull requests)

**Status 2026-10-08.** The unit is implemented, gate-green and its native review pass is complete: nine candidates (C1..C7, MD-3 and the verifier fix) were reviewed on `feat/map-display-only-split` and all nine were approved with zero findings and burned authority. The archive tag `archive/cockpit-pm9-2026-10-07` (`f4e3b3ec`) and the branch `feat/map-display-only-split` (`4743e958`) are pushed to `origin` (`FacuDemarchi/gentle-shell`).

**Target.** The pull request targets `upstream/main` (`Gentleman-Programming/gentle-shell`, default branch `main`), not the fork's `main`. The branch's merge-base with `upstream/main` (`a805c9de`) is `1f35ab1e` (release 4.0.0), so the delivered range is **34 commits / 17,043+/1,126- across 94 files** — the FP-format skill, the map port and derivation, the mapper persona, MD-1, C1..C7, MD-3 and the verifier fix.

**Delivery strategy.** `stacked-to-main` (owner's decision): independently reviewable slices land on the verified default branch in order.

**Issue linkage.** The owner decided not to wait for a maintainer's `status:approved`. The chain references issue **#1257** ("Add a session-only Project Map preview below Status") with a nonclosing `Refs`, and every PR body states the broader delivered scope. The repository's CI validates neither issue linkage, labels nor size; the owner holds only `pull` on upstream, so neither the `status:approved` label nor any `type:*` label can be applied by this account and a maintainer must add them.

**Base conflict, and why it is perishable.** `upstream/main` moves fast: it advanced from `a805c9de` to `9808b6ef` during a single working session. Against `a805c9de` the only conflicting path was `extensions/gentle-ai.ts` (upstream 149+/36- versus this branch's 35+/12-). Against `9808b6ef` the conflicting set is `assets/orchestrator-memory.md`, `docs/gentle-shell.md`, `extensions/gentle-ai.ts` (upstream now 640+/108-), `extensions/gentle-shell.ts` and `tests/persona-single-channel.test.ts`, and only S1 still merges clean. **Cleanliness must therefore be re-measured at PR time, never assumed from this document.** Resolution (owner's decision): merge `upstream/main` into each slice as its PR is opened, so the reviewed commits keep their SHAs and the nine burned reviews keep mapping; the merge resolution is the slice's own new review candidate. A rebase was rejected because it changes every candidate identity and would force nine new reviewer runs. Synchronising once at the branch tip does not work for a chain: the slices below the tip stay unsynchronised.

**Slices, in order (measured 2026-10-08, `additions + deletions`).**

| # | Slice | Range | Changed lines |
|---|---|---|---|
| S1 | FP-format skill | `efd65ae8..5ac56e8c` | 383 |
| S2 | Map port and derivation | `97a0f963..3f41bdde` | 23,459 |
| S3 | Mapper persona | `cef0fcc6..b466e391` | 418 |
| S4 | MD-1 gate-off test | `e1825bdb` | 40 |
| S5 | C1 card stops launching | `a61cbbde` | 305 |
| S6 | C2 retire the open route | `443434e1` | 1,374 |
| S7 | C3 retire worktree provisioning | `4b3ef38b` | 1,579 |
| S8 | C4 retire integration readiness | `79164d23` | 951 |
| S9 | C5 retire lead and contract | `341a9f03` | 1,039 |
| S10 | C6 retire the artifact writers | `993b8d11` | 1,662 |
| S11 | C7 retire the command | `384f432e` | 1,307 |
| S12 | MD-3 empty state | `1162f8a4` | 191 |
| S13 | Verifier fix | `e6572994` | 135 |
| S14 | Close docs | `4743e958` | 24 |

S1 merges clean against `upstream/main`; S2 and everything above carry the conflict set above, measured at PR time. S2 is the only slice no honest single pass brings near the advisory 400-line budget: its 14 commits are six distinct PMV work units (PMV-2, PMV-3A, PMV-3B, PMV-6, PMV-7, PMV-8) plus the 4.0.0 port, so its sub-slices are the cut this chain uses. Every slice above 400 authored lines reports its overage; the repository documents no size policy beyond the `size:exception` label, and no code, test or doc is trimmed to fit a budget.

**Open.** Push of each slice, pull-request creation and merge remain the owner's decisions.
