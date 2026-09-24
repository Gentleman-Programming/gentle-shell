# Feature: SDD trigger boundary (no preflight on mere mention)

## Objective

Naming SDD in a request — asking about it, reporting a bug in it, or referencing it — must never start the SDD preflight, neither in the runtime detector nor in the model's own judgment.

## Problem

1. The former runtime detector (`lib/sdd-preflight.ts`, `hasAffirmativeSddIntent`) attempted to classify natural-language intent with marker and exception regexes. Review proved the approach remained both over-inclusive and under-inclusive.
2. Natural language does not need to be a runtime trigger: the parent/orchestrator selects SDD semantically, while deterministic dispatch and `before_agent_start` gates already enforce preflight at the actual execution boundary.
3. The lazy workflow wording must describe that split clearly so discussion remains side-effect free and selected SDD work cannot bypass preflight.

## Scope

- gentle-pi only (user decision): `lib/sdd-preflight.ts`, preflight/runtime harness tests, `assets/orchestrator.md`, and `assets/sdd-orchestrator-workflow.md`.
- Non-goals: gentle-ai provider templates (`internal/components/sdd/session_preflight.go`, per-agent `sdd-orchestrator.md` assets) — same flaw exists there, deferred by user choice.

## Constraints

- Runtime input detection is syntax-only: slash commands trigger; ordinary natural-language text never triggers preflight directly.
- Natural-language SDD selection belongs to the parent/orchestrator; the existing dispatch and `before_agent_start` gates enforce preflight when an SDD action is actually attempted.
- Mentions, questions, comparisons, reviews, negatives, and bug reports stay ordinary conversation; slash commands always trigger.

## Tasks

- [x] T1: Add bug-class regression cases to `tests/sdd-preflight.test.ts` and observe the original classifier fail.
- [x] T2: Trial a bounded natural-language classifier and observe focused GREEN; later superseded after adversarial review showed the taxonomy remained brittle.
- [x] T3: Evaluate adding the boundary to `assets/orchestrator.md`; preserve the byte-exact core contract and keep detail in the mandatory lazy asset.
- [x] T4: Add the explicit SDD trigger boundary to `assets/sdd-orchestrator-workflow.md`.
- [x] T5: Run the full test suite and report results.
- [x] T6: Replace natural-language input classification with slash-only deterministic detection; retain action-boundary preflight gates.
- [x] T7: Replace regex-taxonomy tests with input-boundary and action-gate contract coverage, including previously observed false positives and false negatives.
- [x] T8: Align the lazy workflow wording with syntax-only input detection plus semantic parent routing, then re-run focused and broad verification.

## Acceptance criteria

- New regression cases pass; existing preflight tests keep passing.
- Full suite green (only the 2 pre-existing base failures remain: windowsHide, R1).
- The explicit non-trigger boundary lives in the lazy `sdd-orchestrator-workflow.md`, which the core mandates reading before any SDD handling. Revised: the always-on core (`assets/orchestrator.md`) is contractually frozen (byte-budget test at 8,192 B with ~7 B headroom, plus disposition-mapped union tests pinning the trigger sentence, lazy-surface enumeration, and hard preflight invariant byte-exact), so the boundary text cannot live there without a sanctioned contract update.

## Progress

- [x] T1: Added bug-class regression cases to `tests/sdd-preflight.test.ts` (new test "discussing SDD itself never triggers preflight even with a loose intent marker" + 2 true cases). RED observed: "necesito reportar un bug del preflight de SDD" triggered.
- [x] T2: Trialed a tighter `hasAffirmativeSddIntent` with bounded governance and exception classes; focused tests reached GREEN, but adversarial review proved the classifier remained brittle and T6 later removed it.
- [x] T3 (revised): `assets/orchestrator.md` reverted to contract wording; the boundary lives in the lazy workflow asset (T4). First attempt added ~870 B to the core and broke 3 budget/contract tests; reverted after reading `tests/orchestrator-budget.test.ts` (BUDGET_BYTES, disposition map, named-pointer assertions).
- [x] T4: Added the explicit SDD trigger boundary (positive + negative + ambiguity rule) to `assets/sdd-orchestrator-workflow.md` (Lazy SDD Preflight section). No budget applies to the lazy asset; no contract test pins its wording.
- [x] T5: Full verification run (evidence below).
- [x] T6–T8: Removed the natural-language classifier. The input hook is slash-only; natural-language messages reach the parent without UI or disk side effects; existing dispatch and `before_agent_start` gates remain the deterministic preflight authority. Updated focused tests, RPC/input integration tests, runtime harness expectations, and lazy workflow wording.

## Verification evidence

- RED: focused boundary tests initially failed 3 cases against the old classifier.
- `node --experimental-strip-types --test tests/sdd-preflight.test.ts tests/sdd-preflight-rpc-input.test.ts`: 38/38 pass.
- Budget/contract/preflight bundle: 83/83 pass; `git diff --check` passed.
- `pnpm run typecheck`: no regressions (197 baseline diagnostics; 2 file/code pairs improved).
- `pnpm run check:provider-contract`: passed (contract 1.2.0).
- `pnpm run test:harness`: exit 0 after updating the harness from natural-language triggering to slash-only triggering.
- `pnpm test`: 2,660 tests, 2,620 pass, 2 fail, 38 skip — the same two pre-existing base failures (`windowsHide`, `R1`).

## Revised architecture

- Input hook: only explicit `/sdd*` and `/gentle-sdd*` commands can originate preflight.
- Natural language: parent/orchestrator decides whether the user explicitly selected SDD; text alone has no side effect.
- Execution boundary: existing `before_agent_start` and SDD dispatch gates run/reuse preflight before any SDD actor starts.
- Result: mentioning the word `SDD` cannot open UI, while a real SDD route remains mechanically unable to execute without preflight.

## Follow-up (optional, out of scope here)

- gentle-ai provider templates have the same fuzzy wording (`internal/components/sdd/session_preflight.go` "affirmative natural-language SDD request", per-agent `sdd-orchestrator.md` "or an equivalent natural-language request") — deferred by user decision.
- If the core ever needs the boundary inline, the sanctioned path is updating `tests/orchestrator-budget.test.ts` CURRENT_* expected strings plus a compensating ≥100 B diet elsewhere in `orchestrator.md`.
