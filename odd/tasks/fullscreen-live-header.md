# Feature: fullscreen-live-header

## Objective
Design A for the fullscreen (>=140 cols) Gentle Shell layout: a one-row live header above the transcript+rail hstack carries everything that ticks per frame (context gauge, cost) plus the session identity (brand, cwd, branch, dirty, model · effort · profile); the right rail keeps only event-driven cards (Project, Changes, Agents, TODO). Sidebar cards switch from the champagne INFO frame to the rose palette (frame `border`, title `accent`). `working…` stays in the prompt title next to the flower; the header never shows it.

Design reference: https://claude.ai/artifact/Fg1oGGRT2e4ZUGY4Ktc6uL (page "Diseño A").

## Problem / Why
- `prepare()` in lib/shell-sidebar-layout.ts re-renders every rail section when any digest changes, and the footer digest (`JSON.stringify(footerModel())`) changes on every context/cost tick, so the whole 50-col rail re-renders and pi-tui's alt screen rewrites every shared row (`tui-alt-screen.js:1473` diffs whole rows).
- Info density is capped by the fixed `RAIL_WIDTH = 50` and single vertical stacking; live counters compete with static identity for the same column.
- The user prefers the rose frame palette over the champagne `CARD_TONE.INFO` frame for sidebar cards.

## Scope
In: fullscreen layout only (`host.mode === "fullscreen" && width >= SIDEBAR_BREAKPOINT`). Header row, Status card slimmed to Project/Changes, sidebar card palette, per-section render memo in `prepare()`, tests, README note.
Out: narrow (<140) bottom bar behaviour, per-model usage table (stays in `/gentle:usage`), warning/error card tones, prompt/petal animation, Pi internals beyond the existing NODE replacement.

## Constraints
- TDD strict (source: CLAUDE.md "Strict TDD Mode: enabled"). Runner: `node --experimental-strip-types --test tests/<file>.test.ts`; full: `pnpm test`; types: `pnpm run typecheck`.
- Conventional Commits, one work-unit commit per task with tests alongside; no AI attribution.
- Header and rails are pi-tui `Component`s composed via the existing `NODE` replacement; use a `vstack` `[header (basis 1, grow 0), hstack(left, rail)]` — `StackLayoutNode` supports `"vstack" | "hstack"` (layout-node.d.ts).
- Artifact language: English for code, comments, tests, docs.
- ~400 authored changed lines per task is a planning heuristic only.

## Tasks
- [x] T1 — Sidebar card palette: add a `CARD_TONE.PANEL` (or split title/frame roles) so `renderCard` can paint frame with role `border` and title with role `accent`; use it for the Status card (lib/shell-bar.ts:230) and the Todos/Agents sidebar cards. Warning/error/success tones unchanged. Tests in tests/shell-card.test.ts + call-site tests.
- [ ] T2 — Live header row: `renderShellHeaderBar(model, theme, width): string` in lib/shell-bar.ts (left: `✿ Gentle Shell ⟡ cwd branch ±dirty ⟡ model · effort · profile`; right-aligned: `ctx <gauge> NN% ⟡ $cost`; degrade left segments first when width is short, same rules as the compact bar). Install it as a fullscreen header component in lib/shell-sidebar-layout.ts: `vstack` of header (1 row, own digest = JSON of the header model) over the existing hstack; the header replaces `renderSidebarBanner` in the rail (banner removed from rail when header is active). Wire in extensions/gentle-shell.ts via a new `sidebarHeader(tui, rail)` or an extension of `sidebarPart`. Status card drops Model/Effort/Context/Cost/Usage groups and keeps Project (cwd, branch, session, profile) + Changes + Integrations. Tests: tests/shell-bar.test.ts, tests/shell-sidebar-layout.test.ts, tests/gentle-shell.test.ts.
- [ ] T3 — Per-section render memo: `prepare()` caches each section's rendered lines keyed by (section digest, revision-of-that-part, contentWidth, theme) so a header/Status digest change does not re-render Agents/TODO. Keep the throwing-digest degradation. Tests in tests/shell-sidebar-layout.test.ts proving Agents/TODO `render` is not called when only the footer digest changes.
- [ ] T4 — Docs: README section for the fullscreen layout (header row, rail contents, palette). Commit with T3 or separately.

## Acceptance criteria
- At >=140 cols fullscreen: first row is the header; rail shows Project, Changes, Agents, TODO cards with `border` frame + `accent` title; no `working…` in the header; banner not duplicated.
- <140 cols: unchanged bottom bar.
- A context/cost change re-renders only the header (and nothing in Agents/TODO).
- `pnpm test` and `pnpm run typecheck` pass (known unrelated failures, if any, listed below).

## Delivery
Strategy: ask-on-risk (default). Forecast ≈ 450–600 authored changed lines across T1–T4 → likely one PR slice; ask if the running count exceeds ~400 before the next commit.
Delivery budget boundary: branch point `0c844e8f` on main.

## Progress / Evidence
- T1 (sha: pending commit) — added `CARD_TONE.PANEL` (frame role `border`, title role `accent`) in lib/shell-card.ts; wired it into the Status card (lib/shell-bar.ts), the Todos sidebar rail (lib/shell-todo.ts, `options.scrollable`), and the Agents sidebar rail (lib/agents-widget.ts, new `options.panel`), leaving warning/error/success tones and the above-editor widgets on their existing tones.
  - RED: `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /^<border>╭<\/border>.../` (tests/shell-card.test.ts, then repeated per call-site test in shell-bar/shell-todo/agents-widget).
  - GREEN: `node --experimental-strip-types --test tests/shell-card.test.ts tests/shell-bar.test.ts tests/shell-todo.test.ts tests/agents-widget.test.ts tests/gentle-shell.test.ts tests/gentle-todo.test.ts tests/gentle-agents.test.ts` → 217/217 pass.
  - `pnpm run typecheck` → no regressions (197 recorded diagnostics, 2 improved).

## Next step
T2.
