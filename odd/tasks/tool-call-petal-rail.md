# Tool call petal rail

Locator: `odd/tasks/tool-call-petal-rail.md` · Engram mirror: `odd/tool-call-petal-rail/tasks`
Worktree: `../gentle-pi-tool-rail` · Branch: `feat/tool-call-petal-rail` (from `main` b27bd328b)

## Objective

Make tool calls visually distinct from assistant prose in the Gentle Shell transcript,
the way OpenCode boxes them, but with the Gentle Shell visual language.

## Problem / why

`extensions/quiet-tools.ts` renders read/bash/grep/find/ls/edit/write as bare text lines.
Only the Gentle AI card (`lib/gentle-ai-renderer.ts`, `lib/shell-card.ts`) has a strong
identity. The theme `tool*Bg` colors are nearly the terminal background, so tool rows
blend into the chat.

## Decision (user-approved: "metele y lo vemos" after the rail recommendation)

Lightweight petal rail for ordinary tools, not the full rounded card:

```
▎ ✿ read   extensions/quiet-tools.ts:440-500                 0.2s
▎   62 lines
```

- `▎` rail in the lifecycle tone (warning while running, success when done, error on failure),
  same tone language as the Gentle AI card.
- `✿` glyph + tool title in `toolTitle`, arguments in `accent`.
- Subtle tinted `tool*Bg` in the three themes so the block separates from prose.
- Duration right-aligned when available.

## Scope / constraints

- Only quiet-tools rendering and theme tool backgrounds. Gentle AI card unchanged.
- Existing collapse/expand, sanitization, bounded rows behavior preserved.
- Artifacts in English. Advisory ~400 authored lines per task.

## Tasks

- [x] T1 — Petal rail renderer for quiet tools (`extensions/quiet-tools.ts`, tests). Route: delegated (writer trigger: renderer + tests, 2+ non-trivial files; preparation reading).
- [~] T2 — Tinted tool backgrounds in themes. DROPPED: pi paints `tool*Bg` only for default `Box` shell tools; quiet tools use `renderShell: "self"`, so theme values have no effect on them. A self-painted background inside `PetalRail` is a possible follow-up pending the user's visual review.

- [x] T3 — Card frame alternative behind `GENTLE_PI_TOOL_FRAME=card` (rounded `╭─ ✿ call ─╮` top from the call, sided body + closing rule from the result, tone per lifecycle). Route: inline (user asked for no subagents after reviewing the rail live).

- [x] T4 — Card frame becomes the only look (user choice after live review): rail variant, `GENTLE_PI_TOOL_FRAME` toggle, and the result-body expand hint removed; long or multi-line calls continue on card rows so every command line stays visible (a first-line-only header hid `rm -rf target` in the composed-command test). Route: inline (user asked for no subagents).

## Acceptance criteria

- Every quiet tool row starts with a tone-colored rail; header shows glyph, title, args.
- Error rows show the error tone; running rows the warning tone; finished rows success.
- Width-safe: no line exceeds render width.
- `npm test`-relevant suites and typecheck pass.

## Checks

- `node --experimental-strip-types --test tests/quiet-tool-rendering.test.ts`
- `node scripts/check-types.mjs`

## Delivery

Strategy: `ask-on-risk`. Forecast: ~250 authored lines (single PR).

## Progress

- Worktree and branch created. Feature document created.
- T1 (delegated writer, uncommitted): `extensions/quiet-tools.ts` adds a `PetalRail` component
  that wraps every quiet tool call and result component (not the Gentle AI cards). Rows are
  prefixed with `▎` in the lifecycle tone (`CARD_TONE`: warning while pending, success when
  finished, error on failure) plus a 4-column gutter; the header's gutter carries `CARD_GLYPH`
  in `accent`. Inner content renders at `width - 4`, so wrapped header rows and body rows stay
  indented under the title and no row exceeds the render width (`truncateToWidth` guard).
  Tone derivation mirrors pi's own bg choice: call rows use `context.isPartial !== false` /
  `context.isError`; result rows use `options.isPartial` / `isError`. Expanded output no longer
  starts with a bare blank row. Empty results still render no rows (no stray rail).
- Duration: not implemented. Ordinary quiet tools carry no elapsed data; the durable ledger only
  records gentle-ai bash calls, and porting the timing machinery was out of scope.
- T2 finding: not applied. pi (`tool-execution.js` `updateDisplay`) calls `setBgFn` with
  `toolPendingBg`/`toolSuccessBg`/`toolErrorBg` only when the render container is a `Box`
  (default shell). Quiet tools use `renderShell: "self"`, rendered in a plain `Container`, so
  these backgrounds are never painted for quiet tool rows (nor for other Gentle `self` tools).
  Theme values left unchanged.
- Tests (`tests/quiet-tool-rendering.test.ts`): 3 new rail tests (tone per status, glyph and
  header, body indentation, empty result, width safety at 1–40 columns). RED observed first
  (3 failing: no rail/glyph, no indentation of wrapped rows). Existing content assertions read
  rows through `renderLines`, which now strips the rail prefix; rail tests use raw
  `railedLines`. Expanded assertions drop the leading blank row; narrow-width tests use
  16 columns (12 content + 4 rail) and assert raw row width.
- Checks observed: quiet-tool-rendering 51/51 pass; `node scripts/check-types.mjs` no
  regressions (exit 0); gentle-shell 223/223 pass.

## Next step

User visual review of the rail in a live session; decide on a self-painted background follow-up.

## Verification evidence (T1)

Risk tier: medium (ordinary rendering change with focused tests). Writer self-verification + parent spot check.
- writer: quiet-tool-rendering 51/51, check-types no regressions, gentle-shell.test 223/223
- parent spot check: quiet-tool-rendering 51/51 pass
- duration not implemented (no timing data for ordinary quiet tools)
- native review (RDD on): lineage review-319d41b8a93b4195, medium tier, lens review-reliability, approved and acknowledged (authority burned). Non-blocking advisory findings: R3-001 WARNING quiet-tools.ts:704, R3-002 SUGGESTION quiet-tools.ts:674 (follow-up only).
- live try: `node ../gentle-pi-tool-rail/bin/gentle-shell.mjs` (launcher injects the worktree package root).
- T3: RED observed (card test got the rail row), GREEN: quiet-tool-rendering 52/52, check-types no regressions, gentle-shell.test 223/223. Risk tier: medium (inline, rendering only, opt-in env).
- T3b: card frame moves the expand key to the top rule (dim, right-aligned, 'to collapse' when expanded, only once finished), matching the Gentle AI card; body drops the hint row. RED observed, GREEN: quiet-tool-rendering 52/52, types no regressions, gentle-shell 223/223. Review skipped at user request.
- T4: quiet-tool-rendering 49/49 (rail tests removed, hint assertions inverted to 'not in the body'), types no regressions, gentle-shell 223/223, package-manifest 55/55. Review skipped at user request.
