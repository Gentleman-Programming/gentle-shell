# Feature: Gentle AI Subagent Lifecycle Cards & Live Activity Stream

## Objective
Elevate subagent executions in the Pi transcript to first-class Gentle AI visual citizens, displaying unified Gentle card frames with lifecycle statuses, agent roles, task labels, model metadata, and live in-flight activity streaming instead of quiet, generic `working...` text.

## Problem / Why
- Subagent delegation (`gentle-ai-worker`, `gentle-ai-explore`, `gentle-ai-verify`, SDD phases) is the architectural foundation of ODD and Gentle AI, yet in the transcript it rendered as a plain, unstyled `@ agent run · gentle-ai-worker` tool line.
- The `label` parameter and model/thinking profiles were discarded by the tool call renderer.
- During synchronous `mode: "task"` execution, the user stared at a blind `working...` spinner with zero feedback on in-flight tools, files being edited, or test commands running.
- Failures (such as preconditions or errors) were dumped as raw text rather than styled error cards.

## Authorized scope
- `lib/agents-renderer.ts` (new): `GentleAgentCallCard`, `GentleAgentResultCard`, state management, lifecycle statuses, and card renderers.
- `extensions/gentle-agents.ts`: wire card renderers to `renderCall` and `renderResult`, forward `onUpdate` during `launch` to stream live subagent activity from `store.subscribe`.
- `tests/agents-renderer.test.ts` (new): comprehensive unit tests for subagent card call and result rendering, lifecycle states, label formatting, and live updates.
- `tests/gentle-agents.test.ts`: update existing tool registration / render tests to verify the unified card contract.

## Constraints
- Must use Gentle Shell's existing card design system (`lib/shell-card.ts`) for visual consistency (`cardTop`, `cardLine`, `cardBottom`, tones).
- Glyph: `AGENTS_GLYPH` (`❀`).
- Title: `Gentle AI`.
- Subtitle: `${status} · ${agent}${label ? ` · ${label}` : ""}`.
- Non-blocking: live updates must be lightweight and safe when no TUI is attached.
- Preserve backward compatibility for background mode, continuation, and headless/print modes.

## Tasks
- [x] **T1 — Create `lib/agents-renderer.ts` with RED tests.** Implemented `GentleAgentCallCard`, `GentleAgentResultCard`, and `renderGentleAgentCall` / `renderGentleAgentResult` supporting lifecycle statuses, task labels, profile details, and live activity rows.
- [x] **T2 — Wire card rendering and live `onUpdate` in `extensions/gentle-agents.ts`.** Integrated renderer in `tool()` definition, forward `onUpdate` in `launch()`, and stream `lastStep` / in-flight tools from `store.subscribe`.
- [x] **T3 — Verify focused test suites.** Ran `tests/agents-renderer.test.ts` and `tests/gentle-agents.test.ts`. 153/153 tests pass.
- [x] **T4 — Integration check and verification evidence.** Verified formatting across narrow and wide viewports, error handling, and clean git diff.

## Acceptance criteria
1. `subagent_run` renders a Gentle AI card (`❀ Gentle AI`) with tone reflecting status (amber for preparing/running, green for completed, red for failed/cancelled).
2. The card subtitle includes the agent name and explicit task `label` (or auto-derived `taskLabel`).
3. While running in task mode, in-flight tool execution or current step is streamed to `onUpdate` and visible in the card frame.
4. Finished results close the card frame neatly; errors display in red error tone with clear diagnostic text.
5. All gentle-agents tests pass.

## Verification evidence
- RED: Initial tests caught missing `keyHint` fallback and wrapped error line match. Resolved cleanly.
- GREEN:
  - `node --experimental-strip-types --test tests/agents-renderer.test.ts` (9/9 pass)
  - `node --experimental-strip-types --test tests/gentle-agents.test.ts` (107/107 pass)
  - `node --experimental-strip-types --test tests/agents-widget.test.ts` (10/10 pass)
  - `node --experimental-strip-types --test tests/agents-view.test.ts` (28/28 pass)
  - `node --experimental-strip-types --test tests/quiet-tool-rendering.test.ts` (49/49 pass)
  - Full focused suite: 153/153 tests pass.
- `git diff --check`: clean, zero whitespace or syntax errors.
- `node scripts/build-runtime-modules.mjs --check`: passes, runtime matches TypeScript sources.
