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

## Tasks

- [x] T1 — S1, S6(command part): profile-card policy store + `card on|off` subcommand + usage/docs. Route: worker A. Commit: 89f989edd
- [x] T2 — S2, S5: pure card renderer, navigation state (wrap) and ◀/▶/use hit map, unit tests. Route: worker B (parallel with T1). Commit: 22754ce4b
- [ ] T3 — S1, S2: sidebar wiring (section key, visibility gate, panel sheet order, widget registration, mouse dispatch). Route: worker C after T1+T2. Commit: —
- [ ] T4 — S3: use action through the owner under the apply gate, confirmation and notices. Route: worker C (continue). Commit: —
- [ ] T5 — S4: shortcuts in `KEYMAP_ACTIONS` and registration, `tests/keymaps.test.ts`. Route: worker C (continue). Commit: —
- [ ] T6 — S6: final docs pass, `pnpm test` + typecheck. Route: verify. Commit: —

## Log

- **L1 (user request, verbatim):** "Creo que la mejor forma es la de contribuir a gentle-pi y subir el PR. Lo que faltaria seria clonar el repo, crear una rama e implementar el card. El card debe ser configurable por el usuario, es decir, configurar si mostrar o no el card mediante comando, la apariencia del card debe ser swipeable, es decir, cambiar de perfil de manera horizontal (navegar), poder seleccionar un perfil y usarlo. El card debe tener flechas (avanzar o retroceder)."
- **L2 (user decisions):** arrows clickable + global keyboard shortcuts; "use" = only this session; `/gentle:profiles card on|off`, persisted globally, hidden by default; clone at `Desktop\tools\gentle-shell` from upstream.
- **L3 (user decision):** shortcuts `Alt+,` / `Alt+.` / `Alt+M` (Alt+Left/Right are Pi word motion; Alt+Enter is Pi's reserved follow-up).
- **L4 (evidence):** explorer map — sidebar fixed list `lib/shell-sidebar-layout.ts:344`; flag-store precedent `lib/card-style-policy.ts`; parser `handleProfilesCommand` `extensions/gentle-ai.ts:6811`; apply path `applyDesktopProfile` `:6897` → `runProfilesPanelAction` `:6193`; keymaps `lib/keymaps.ts:31-43`, registration `extensions/gentle-shell.ts:3171-3218`. `pnpm install` deps OK; root postinstall (gentle-ai binary) failed with EPERM — unit tests unaffected (`tests/keymaps.test.ts` 7/7 pass).
