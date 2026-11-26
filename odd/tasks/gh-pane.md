# GitHub pane (`/gentle:gh`)

Objective: a read-only GitHub section in the sidebar and a `/gentle:gh` overlay listing open pull requests and open issues, modeled on `/gentle:changes`.
Branch: `feat/gh-pane`. Upstream issue: Gentleman-Programming/gentle-shell#3076 (repo is not the human's: delivery is a fork branch plus a cross-repo PR carrying `Closes #3076`). Runner: `node --experimental-strip-types --test tests/<file>.test.ts`, suite `pnpm test`.

## Specs

- S1 The `/gentle:gh` command exists and opens a view inside the harness: "Quiero agregar una /gentle:gh y me abra algo parecido a lo que tengo en lazygh dentro de gentle-shell. Es posible?"
- S2 It shows open pull requests and open issues: "Realmente quiero visualizar las prs abiertas y las issues abiertas".
- S3 It lives with the harness's own panels, not beside them: "Quizas poner los paneles dentro del panel donde estan los paneles que de gentle-shell" and "donde las pondrias en el shell?".
- S4 It follows the `/gentle:changes` shape: "podemos hacer algo similar al /gentle:changes".
- S5 Phase 1 is overview only — lists plus a detail pane; no diff tab, no conversation tab, no merge or comment action (explicit selection: "Solo overview (fase 1)").
- S6 Read-only against GitHub: no writes, no merge, no comment, no review submission.

## Tasks

- T1 [S2,S6] `lib/gh-client.ts`: resolve `owner/name` from `git remote get-url origin` (ssh, ssh://, https, git@) and parse `gh pr list`/`gh issue list` JSON into typed models. Route: inline. Status: done (RED: module absent → GREEN tests/gh-client.test.ts 10).
- T2 [S2,S6] `lib/gh-state.ts`: in-memory store with a coarse TTL, load/error/empty states, and a `version` the rail digest can read. Route: inline. Status: done (RED: module absent → GREEN tests/gh-state.test.ts 12; strip-only mode rejects parameter properties).
- T3 [S3] `lib/gh-rail.ts` plus the `"github"` entries in `lib/shell-sidebar-layout.ts` (`sections`) and `lib/shell-panel.ts` (`SHEET_ORDER`), so the section appears in the rail and in `/gentle:panel`. Route: inline. Status: done (RED: module absent → GREEN tests/gh-rail.test.ts 13; rail order pinned in tests/shell-sidebar-layout.test.ts 68).
- T4 [S4,S5] `lib/gh-view.ts`: grouped list plus detail pane, keys copied from `WorktreeChangesView`, injected dependencies, no Pi knowledge. Route: inline. Commit: `feat(gh): add the grouped pull request and issue overview view`.
- T5 [S1,S3,S5] `extensions/gentle-gh.ts`: register `/gentle:gh`, mount the overlay like `showChangesOverlay`, register the sidebar part; docs and palette entry. Route: inline. Commit: `feat(gh): wire the /gentle:gh command and its overlay`.
- T6 Verify: focused tests per task, full unit suite, `pnpm run typecheck`, existing sheet tests adjusted for the fifth section. Route: inline. Commit: folded into T3/T5 evidence.

Route evidence: no Writer trigger reason — every task depends on the previous one's types, so they are not independent units and the parent works inline.

## Log

- L1 (2026-11-10) User: "este es el repositorio gentle-shell. Me gustaria que revises como esta armado. Quiero agregar una /gentle:gh y me abra algo parecido a lo que tengo en lazygh dentro de gentle-shell. Es posible?"
- L2 User: "Quizas poner los paneles dentro del panel donde estan los paneles que de gentle-shell"
- L3 User: "Realmente quiero visualizar las prs abiertas y las issues abiertas, donde las pondrias en el shell?"
- L4 User: "podemos hacer algo similar al /gentle:changes"
- L5 User: "si dale, pero ojo que este repo no es mio. Quiero que crees la issue y la podamos resolver"
- L6 User: "quiero que lo hagamos"
- L7 Decision (asked, answered): detail scope = "Solo overview (fase 1)".
- L8 Issue filed: https://github.com/Gentleman-Programming/gentle-shell/issues/3076 with `feature_request.yml`; the actor has `viewerPermission: null` upstream, so the form's `enhancement` and `status:needs-review` labels were dropped by GitHub and a maintainer must apply them.
- L9 Design evidence: `/gentle:panel` is a read-only projection of the rail (`lib/shell-panel.ts` `SHEET_ORDER`; panes satisfy only `{ render(width): string[] }`), so the sheet section is a digest and the interaction belongs to the overlay. `WorktreeChangesView` is a plain class with injected deps, which is why it is unit-testable. No `owner/name` resolver exists in the tree. `lib/gentle-shell-bundled.ts` strips `GH_TOKEN`/`GITHUB_TOKEN` from child env, so `gh` (which resolves its own credentials) is the data source. `lib/odd-phase-inference.ts` already classifies `gh ... list` as read-only.
- L10 Slice boundary (after T2): `0d4f571f7` + `2fe350678` = 713 authored lines for the client and the store with their tests. The feature is therefore delivered in two reviewable slices: slice 1 is the rail section over the client and store (T1-T3), slice 2 is the `/gentle:gh` overlay (T4-T5). Slice 1 stands on its own value: counts in the rail without opening anything.
