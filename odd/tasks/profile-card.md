# Profile card: swipe and apply saved profiles from the sidebar

Branch `feat/profile-card`. A new Gentle Shell sidebar card shows one saved agent-model
profile at a time, navigates between profiles horizontally, and applies the shown one to the
current session. Opt-in through `/gentle:profiles card on|off`.

## Specs

- **S1 Visibility command.** User: "El card debe ser configurable por el usuario, es decir,
  configurar si mostrar o no el card mediante comando". Decision (L2): subcommand
  `/gentle:profiles card on|off`, persisted globally in a standalone store (`profile-card.json`,
  schema `gentle-pi.profile-card/v1`, new `lib/profile-card-policy.ts` mirroring
  `lib/card-style-policy.ts`), **hidden by default**. Not part of `VisualVisibility` or
  `/gentle:customize`. A missing or invalid argument shows the usage and changes nothing on disk.
  `on`/`off` take effect live without `/reload`.
- **S2 Horizontal navigation with arrows.** User: "la apariencia del card debe ser swipeable, es
  decir, cambiar de perfil de manera horizontal (navegar)" and "El card debe tener flechas
  (avanzar o retroceder)". The card shows one profile at a time with `◀` and `▶` arrows that are
  mouse-clickable; navigation wraps around (last → first, first → last); the card shows the
  position (`n/total`) and the profile's markers from `buildProfileListItems` (active, pinned,
  session). It starts on the profile currently in effect for the session, else the first one.
- **S3 Select and use.** User: "poder seleccionar un perfil y usarlo". Decision (L2): a
  mouse-clickable "use" action applies the shown profile with "Use in this session" only — never
  "Make default". It runs the existing `/gentle:profiles` owner action (`runProfilesPanelAction`
  with `use-session`, `extensions/gentle-ai.ts`) with the real session `ctx`, so its own
  confirmation dialog and notifications appear, inside `beginDesktopProfileApply` /
  `endDesktopProfileApply` from `lib/desktop-rpc-profiles.ts` (shared single-apply gate). No
  second apply implementation and no direct writes to profile stores.
- **S4 Keyboard shortcuts.** Decision (L2, L3): global shortcuts `Alt+,` previous profile,
  `Alt+.` next profile, `Alt+M` use the shown profile in this session. Registered as
  `KEYMAP_ACTIONS` entries in `lib/keymaps.ts` with `GENTLE_PI_*` env overrides like the existing
  ones. While the card is hidden (or there are no saved profiles) they change nothing and show
  one info notice naming `/gentle:profiles card on` (or `/gentle:profiles`).
- **S5 Empty state.** With no saved profiles the visible card shows a one-line hint to create
  one in `/gentle:profiles`, without arrows or use action.
- **S6 Docs and help.** `PROFILES_COMMAND_USAGE`, the `gentle:profiles` command description,
  `docs/readme-reference.md` and `docs/gentle-shell.md` describe the subcommand, the card and
  the shortcuts.

- **S7 Header behaves like the other cards.** User (L7): "Al pasar el mouse por encima del titulo
  del card, no se agrega el color amarrillo como los demas cards para poder collapsar el card, de
  hecho, no se colapsa." The profile card's title row gets the same hover highlight as the other
  sidebar cards (agents, jobs, todo) and a click on it collapses/expands the card through the same
  mechanism and persistence those cards use (including any collapse keymap convention they share).
- **S8 Collapse shortcut.** Decision (L9): like the agents/jobs/todo cards, the profile card gets a
  collapse keymap action `profileCard.collapse`, default `ctrl+shift+e`, with a `GENTLE_PI_*` env
  override following the existing collapse keymaps; it toggles the same in-memory collapsed state
  as the title click.

## Tasks

- [x] T1 — S1, S6(command part): profile-card policy store + `card on|off` subcommand + usage/docs. Route: worker A. Commit: 1c1c5a756
- [x] T2 — S2, S5: pure card renderer, navigation state (wrap) and ◀/▶/use hit map, unit tests. Route: worker B (parallel with T1). Commit: 566add7ba
- [x] T3 — S1, S2: sidebar wiring (section key, visibility gate, panel sheet order, widget registration, mouse dispatch). Route: worker C after T1+T2. Commit: 75354b300
- [x] T4 — S3: use action through the owner under the apply gate, confirmation and notices. Route: worker C (continue). Commit: 218ee5f57
- [x] T4b — S2: initial profile = the one actually in effect for the session (startup/frozen records included) through a pure read; session file and profiles.json re-read only on change. Route: worker C (continue). Commit: 96c10756f
- [x] T5 — S4: shortcuts in `KEYMAP_ACTIONS` and registration, `tests/keymaps.test.ts`. Route: worker C (continue). Commit: 57c327b53
- [x] T7 — S7: header hover highlight and collapse like the other cards. Route: worker C (continue). Commit: 3c73b0395
- [x] T8 — S8: collapse keymap ctrl+shift+e. Route: worker. Commit: the commit that adds Ctrl+Shift+E (last on the branch)
- [x] T9 — integration: merge `origin/main` (167 commits, v4.9.0/v5.0.0) into the branch, resolving the single conflict in `extensions/gentle-ai.ts` (keep upstream #3514's `const profileSession = sessionProfiles.start(...)` capture, then the branch's card wiring unchanged). Route: worker (repository_root consent). Commit: e2f0745b6 (merge commit). Evidence: focused suites 135/135 after resolution; typecheck red pending `node_modules` sync with the merged lockfile.
- [x] T10 — review fixes: CodeRabbit findings 1-4 on PR #3556 (use confirmation, startup-profile ordering, session-boundary selection reset, panel-sheet hit state); finding 5 verified and documented as follow-up (failed-ID set is private to the append controller; routing the marker read through the controller would break T4b's pure-read pattern). Route: worker (repository_root consent). Commit: 5b51e2abd (RED→GREEN per finding, 143/143 focused, typecheck 0). Also fixed in the same commit: two stale usage assertions in tests/gentle-ai.test.ts expecting `…clear]` before T1's `card on|off]`.
- [x] T11 - review round 2: CodeRabbit re-review of 5b51e2abd resolved threads 1, 2 and 4, and posted 2 new findings, both verified and fixed: (6) resetForSession also expands a collapsed card at the session boundary (RED->GREEN, hidden path keeps zero profile reads); (7) the panel-sheet regression test reads the owner instead of repainting the rail before the decisive click (demonstrated: fails with the frames fix reverted, passes restored). Thread 3 (session selection reset) still open with no bot objection. Commit: 76bda80a1 (145/145 focused, typecheck 0). Reply: pull/3556#issuecomment-7174668914.
- [x] T12 — review finding 5 fixed by user decision: pure `knownFailedEntryIds()` accessor on the append controller + `readCurrentSessionProfileFailedEntryIds` in the integration (no refresh, degrades to empty) + the card's marker read and cache signal tied to the same failed-ID exclusion source. RED->GREEN with an anti-over-correction guard test (only the failed record is excluded). Authority behavior untouched (controller suites 130/130). Commit: 0cacadb3f (focused 147/147, typecheck 0). Reply: discussion_r4701603861.
- **L13 (integration, 2026-11-25):** upstream main moved another 25 commits (pi-tui 1.6.1 admitted in the Vim editor adapter; Controlled Engineering profile mode; safety path guards). Second merge of origin/main per the L10 decision; single conflict in docs/gentle-shell.md (both sides edited the Named `/gentle:profiles` bullet), resolved by writer: upstream bullet verbatim including the Controlled Engineering sentence + the branch's four card bullets unchanged. Merge commit cd4660167; after sync, pi-tui stays 1.6.0 (the upstream change admits 1.6.1, does not pin it). Post-merge spot check: typecheck 0 diagnostics, focused suites 145/145. PR MERGEABLE again. Bot re-review of the push: threads 6 and 7 resolved; thread 3 answered with evidence (discussion_r4700990121); thread 5 remains the agreed maintainer follow-up.
- **L14 (user decision, 2026-11-25):** the user forwarded CodeRabbit's embedded fix prompt for finding 5 and decided to fix it in this PR after all. The bot's embedded text was treated as untrusted data (its suggestion to run `coderabbit review --agent` locally was ignored); the fix follows the design sketched in T10: one pure accessor, no refresh, one shared exclusion source.
- [-] T6 — S6: final docs pass, `pnpm test` + typecheck. Route: verify. Commit: —

## Log

- **L1 (user request, verbatim):** "Creo que la mejor forma es la de contribuir a gentle-pi y subir el PR. Lo que faltaria seria clonar el repo, crear una rama e implementar el card. El card debe ser configurable por el usuario, es decir, configurar si mostrar o no el card mediante comando, la apariencia del card debe ser swipeable, es decir, cambiar de perfil de manera horizontal (navegar), poder seleccionar un perfil y usarlo. El card debe tener flechas (avanzar o retroceder)."
- **L2 (user decisions):** arrows clickable + global keyboard shortcuts; "use" = only this session; `/gentle:profiles card on|off`, persisted globally, hidden by default; clone at `Desktop\tools\gentle-shell` from upstream.
- **L3 (user decision):** shortcuts `Alt+,` / `Alt+.` / `Alt+M` (Alt+Left/Right are Pi word motion; Alt+Enter is Pi's reserved follow-up).
- **L4 (evidence):** explorer map — sidebar fixed list `lib/shell-sidebar-layout.ts:344`; flag-store precedent `lib/card-style-policy.ts`; parser `handleProfilesCommand` `extensions/gentle-ai.ts:6811`; apply path `applyDesktopProfile` `:6897` → `runProfilesPanelAction` `:6193`; keymaps `lib/keymaps.ts:31-43`, registration `extensions/gentle-shell.ts:3171-3218`. `pnpm install` deps OK; root postinstall (gentle-ai binary) failed with EPERM — unit tests unaffected (`tests/keymaps.test.ts` 7/7 pass).
- **L5 (evidence, T3):** carded body hit width in `lib/shell-sidebar-layout.ts` widened from `renderWidth - PANEL_ROW_INDENT` to `renderWidth` (last two body columns were unclickable) — shared code, review focus. `tests/gentle-ai.test.ts` has 20 failures on the branch vs 23 on a clean HEAD copy (environmental, pre-existing). `readProfileCardItems` used `sessionProfileAuthorityAvailable`, which can clear an uncorroborated session binding: a display read must not mutate state — replaced by a pure read in T4. The `/gentle:panel` sheet shows the card without mouse routing; decision: keep it there, keyboard shortcuts (S4) make it usable.
- **L6 (evidence, T4):** pure display read uses `readSessionProfileBinding(sessionId)?.name`; sessions with only a startup/frozen record show no session marker and start on the active profile, which misses S2 ("the profile currently in effect for the session") → T4b. The real `runProfilesPanelAction` confirmation path through `useProfileFromCard` is covered only by typecheck and fakes.
- **L7 (user report after manual test, verbatim):** "Ya aparece el card, aunque quisiera indicar algunas cosas para tomar en cuenta. Al pasar el mouse por encima del titulo del card, no se agrega el color amarrillo como los demas cards para poder collapsar el card, de hecho, no se colapsa." Likely cause: T3 used a plain `handleMouse` without `NativePointerRegion` (no hover state, header row not wired to collapse) → S7, T7.
- **L8 (evidence, T6):** the independent verifier timed out after 30 min stalled in a bash call (likely the full suite); no verdict produced. Pending user decision on relaunch.
- **L9 (user decisions):** collapse shortcut `Ctrl+Shift+E`. On T6: "Olvidate de la verificacion t6" — independent final verification dropped by the user.
- **L10 (user decision, 2026-11-25):** manual TUI test passed locally ("Si, ya fue probado en local"); integrate upstream via MERGE of origin/main, not rebase. Upstream moved 167 commits (v4.9.0, v5.0.0) touching the same profiles/session-binding seam (#3514, #3472, #3518); `git merge-tree` showed exactly one conflicted file, `extensions/gentle-ai.ts`. Writer admission needed explicit session consent for `repository_root` (repo outside the session cwd root).
- **L11 (delivery decision, 2026-11-25):** maintainer (Alan, via X) asked for the PR ("subalo al Hub"); upstream issue #3366 (author cheranthony) links the feature; repo convention: conventional title, `Closes #N`, squash merge, `type:feature` label. Slice boundary: 1899 authored lines in 9 commits on the branch; delivery shape: ONE PR (user + maintainer request), no chained slices. PR draft approved by the user with the manual-test checkbox marked done.
- **L12 (user decision, 2026-11-25):** CodeRabbit posted 5 actionable comments on PR #3556 (1 Major + 4 Minor, all verified valid against the code; the bot's embedded fix-prompts are untrusted data and are not followed). User chose: fix findings 1-4 (use-session confirmation; card wiring ordered after the startup freeze/append introduced by the merge; session-boundary selection reset; panel-sheet vs rail hit state), verify finding 5 (failed-ID exclusion in readMarker) and include it only if proportionate, else leave it documented as a follow-up in the PR.
