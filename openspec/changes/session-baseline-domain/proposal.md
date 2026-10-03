# First deliverable: session file-baseline domain

**Status:** approved. This is the first scoped implementation unit of approved issue [#765](https://github.com/Gentleman-Programming/gentle-pi/issues/765).

## Outcome

Create one pure, caller-owned baseline domain. It records a first supplied baseline for a canonical file key and compares later supplied states without reading files or using Git.

## Scope

**First stacked PR to main:** new `lib/session-file-baseline.ts` and `tests/session-file-baseline.test.ts` only. The module has no session singleton: its caller owns the per-session and ancestry registry.

**Included:** canonical `repositoryIdentity + worktreeRoot + relativePath` keys; first-result retention, including unavailable; defensive immutable key/state snapshots; absent/available/unavailable comparison.

**Excluded:** file bytes, filesystem or Git access, capture timing, session/ancestry propagation or persistence, managed children, rendering/UI claims, and integration hooks.

## Delivery boundary

| Item | Decision |
| --- | --- |
| Work unit | Pure domain plus dependency-free Node built-in tests |
| Estimate | 210–300 changed lines, including tests |
| Candidate review | One focused PR, below the 400-line budget |
| Stack | First slice to `main`; no size exception |
| Planning model | `gpt-5.6-terra` via OpenAI Codex |

The broader feature remains separately sliced: parent capture, persistence, managed children, and the view follow later. Existing main grouping is tracked in [#725](https://github.com/Gentleman-Programming/gentle-pi/pull/725); it is not part of this unit.
