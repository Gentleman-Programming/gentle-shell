# Spec-by-reference ODD handoffs (gentle-shell#1713)
Branch: `fix/1713-spec-by-reference` (base `origin/main` cf3012f7) · Delivery: ask-on-risk · Runner: `node --experimental-strip-types --test <file>`; full `npm test`, `npm run typecheck`
Engram mirror: `odd/spec-by-reference-handoffs/tasks` · Route: inline for every task (user: "para la tarea de hoy no quiero que delegues nada")

## Specs
S1. The ODD feature doc is the reference: "el doc .md de ODD se genera cuando realmente se necesita, además de eso, la idea es que sea una referencia. Este tendria que tener las specs ahi mismo y funciona estilo bitacora."
    Fixed order: header (2-3 lines) → `## Specs` → `## Tasks` → `## Log`. Stable content on top, growing log last.
S2. Specs quote, never summarize: exact strings, error messages and examples from the user stay literal, in the user's language. Specs may number and order, never rewrite those fragments.
S3. Change = only the affected spec and task: "A diferencia de SDD, un cambio no re hace todo, solo re hace esa spec y la tarea asociada". A change appends a verbatim user Log entry, rewrites only the affected S#, reopens only its T#.
S4. Log is the logbook: first entry L1 holds the original request verbatim; user corrections are logged verbatim; evidence and decisions go here, not in Tasks. Tasks stay one line each (S# links, route, commit, RED→GREEN).
S5. Handoffs pass a reference, not a paraphrase (goal: "minimizar el consumo de tokens y a la vez mantener la guia y calidad"):
    Spec: odd/tasks/x.md (read until "## Log"). Do T2 → S3, S4.
    Report covered S# and any S# you could not satisfy.
    Workers read until `## Log`; when no doc exists, the handoff carries the user's request verbatim. No "translate/condense the request" step.
S6. Verify is grounded in the specs: reads the whole doc including verbatim user Log entries, returns a per-S# verdict, executes the spec's `$` examples the parent authorized (isolated when they mutate state), compares exact output.
S7. User-reported failures are reproduced before the orchestrator decides they already work.
S8. Handoff friction never shrinks content (#1713 cause 5): writer-surface rejection names the offending line and says to resend the same task unchanged except the section; `subagent_continue` of a writer inherits the original task's surfaces when the follow-up has none; an unknown task id lists recent valid ids.

## Tasks
- [x] T1 (S1-S7) inline · doc format + handoff/verify/reproduce contract in assets, agents, extension ODD step, contract tests · RED→GREEN · 9e890dba
- [x] T2 (S8) inline · runtime friction in lib/bounded-writer-admission.ts and extensions/gentle-agents.ts + tests · RED→GREEN · b160c3b8
- [x] T4 (S8) inline · review follow-ups R3-001/002/004/005: e2e continue test, always-backticked inherited surfaces, path-vs-prose rejection advice, exact rejection assertions · RED→GREEN · d9771820
- [x] T5 (S8) inline · review follow-ups of lineage review-b5d3d60f29e54b69: ambiguous whitespace-entry advice, ctx-safe unknown-id error, one heading matcher (R3-003) · RED→GREEN · this work unit
- [x] T3 (S1-S6) inline · canon parity: gentle-ai PR #5215 (665a181a) + regenerated `fixtures/odd-routing-canonical.md` + aligned step 6 and verify wording · RED→GREEN · this work unit (see L19-L21)

## Log
L1 2026-10-03 user (verbatim): > quiero que hagamos esto, pero pimero lo analicemos super bien https://github.com/Gentleman-Programming/gentle-shell/issues/1713
L2 2026-10-03 user (verbatim): > espera para la tarea de hoy no quiero que delegues nada
L3 2026-10-03 user (verbatim): > es que el doc .md de ODD se genera cuando realmente se necesita, además de eso, la idea es que sea una referencia. Este tendria que tener las specs ahi mismo y funciona estilo bitacora. A diferencia de SDD, un cambio no re hace todo, solo re hace esa spec y la tarea asociada
L4 2026-10-03 user (verbatim): > mira como es la estructura ahora, dame la mejor referncia para minimizar el consumo de tokens y a la vez mantener la guia y calidad
L5 2026-10-03 user (verbatim): > me gsuta! vamos con esa
L6 2026-10-03 analysis: paraphrase rule at assets/orchestrator-delegation.md:60 (gentle-pi only); doc format at assets/orchestrator-memory.md:7 mirrored from gentle-ai routing.go; verify agent never sees requirements; no reproduce-first rule; bench B-luna handoffs 283/1786→1542→963/358/285 chars; existing docs median 6.6k, max 39.7k chars, dominated by logs.
L7 2026-10-03 forecast: ~250 authored changed lines across T1+T2 (under the ~400 budget); T3 lives in another repository.
L8 2026-10-03 user (verbatim): > orchestrator-memory.md es algo que recien se llama al hacer odd con archivo .md?
   finding: orchestrator-memory.md and orchestrator-delegation.md are lazy (only named in assets/orchestrator.md:44,66); the B-luna orchestrator never read either. T1 must put the compact doc format and handoff contract in the always-on ODD steps (extensions/gentle-ai.ts:1253-1262) and keep detail in the lazy assets.
L9 2026-10-03 T1 evidence (risk: medium, prompt-contract change; checks: writer self-verification inline, no delegation per L2):
   RED: tests/odd-routing-contract.test.ts new "feature document is the verbatim specification..." failed on missing `## Specs`; doc-format test failed on missing "verification evidence, progress, and next step".
   GREEN: 20 prompt-contract test files 589/589; `npm run typecheck` no regressions; `npm test` all stages passed.
   Decision: fixture line 19 (LB2 "Translate the user's request into concise English") moved to `replaced` in tests/orchestrator-budget.test.ts; its first sentence stays pinned by tests/persona-single-channel.test.ts.
   Always-on prompt grew by the compact contract in extensions/gentle-ai.ts steps 5-6 (orchestrator.md budget untouched).
L10 2026-10-03 T2 evidence (risk: HIGH, touches writer admission; independent verifier not run because the user forbade delegation (L2); RDD assess unavailable: `gentle_review` not exposed in this session):
   RED: rejection-detail test (writer-edit-surface-scope), missing `inheritAllowedEditSurfaces` export (bounded-writer-admission), "Recent task ids" assertion (gentle-agents) all failed first.
   GREEN: writer-edit-surface-scope 14/14, bounded-writer-admission 8/8, gentle-agents 190/190; `npm run typecheck` no regressions; `npm test` all stages passed.
   Decisions: inheritance only for generic writers (gentle-ai-worker, worker), never jd-fix-agent; only when the follow-up and its context carry no heading; inherited surfaces come from the original task prompt (surfaces passed only via `context` are not inherited and still reject). Rejection keeps the canonical text as prefix and appends the concrete problem plus "Resend the same task text unchanged...".
   Gap: continuation inheritance is unit-tested on the helper; the one-line wiring in subagent_continue has no end-to-end writer test.
L11 2026-10-03 next: T3 needs a user decision (gentle-ai canon port lives in another repository); push/PR remain user decisions. Running authored delta: T1 64+/15-, T2 ~95 lines.
L12 2026-10-03 RDD: user granted review of 9e890dba..6c9ebdd7 (risk medium, 14 files, 231 lines) and allowed one reviewer subagent as the only exception to L2. Lineage review-7744719648a3cec2, lens review-reliability: approved; acknowledged (authority burned).
   Non-blocking follow-ups: R3-continue-wiring-unproved (WARNING, no end-to-end continue test); R3-inherit-reserialization (WARNING, inherited entries are backticked only for whitespace, so a quoted path such as one starting with a list marker could round-trip differently; fix: always backtick inherited entries); R3-heading-detection-divergence (SUGGESTION, reuse the canonical heading matcher); R3-rejection-problem-coverage (SUGGESTION, assert empty/repeated-section messages, truncation, status/result hints).
L13 2026-10-03 RDD: doc-only L12 commit re-opened the whole branch range (target f913925b…); user granted review and re-confirmed the reviewer exception. Lineage review-52b799f6e8561bc4: approved; acknowledged. Findings R3-001 (WARNING, no e2e continue test), R3-002 (WARNING, always backtick inherited entries), R3-003 (SUGGESTION, reuse canonical heading matcher), R3-004 (SUGGESTION, rejection advice wrong for invalid paths), R3-005 (SUGGESTION, prefix-only rejection asserts; unasserted messages/truncation/hints).
   Learned: RDD reviews the whole branch base-diff, so post-review doc commits re-open a full review; record outcomes in the next work unit.
L14 2026-10-03 user (verbatim): > dale
   (accepting: fix R3-001, R3-002, R3-004, R3-005 and record L13 as T4; R3-003 stays a follow-up.)
L15 2026-10-03 T4 evidence (risk: HIGH, writer admission; reviewer exception only per L12/L13):
   RED: e2e continue test failed only on unquoted `src/app.ts` (R3-002); quoted-only `-` round-trip failed; invalid paths reported as prose (R3-004). Status/result unknown-id hints already passed (coverage only).
   Mutation: replacing the continue wiring with the raw prompt makes the e2e test fail with the exact rejection; restored, file unchanged vs HEAD.
   GREEN: bounded-writer-admission 8/8, writer-edit-surface-scope 15/15, gentle-agents 191/191; `npm run typecheck` no regressions; `npm test` all stages passed.
   Kept as follow-up: R3-003 (reuse canonical heading matcher).
L16 2026-10-03 RDD: lineage review-b5d3d60f29e54b69 (target 53d44815…, through d9771820) approved; acknowledged. Findings: R3-001 (WARNING) a real unquoted path with a space got the prose advice; R3-002 (SUGGESTION) unknownTask dereferenced ctx unconditionally. R3-003 from the earlier review was still open.
L17 2026-10-03 user (verbatim): > pr y merge
L18 2026-10-03 user (verbatim): > no seria mejor arreglar los hallazgos ?
   T5 evidence (risk: HIGH, writer admission; reviewers allowed per user): RED: ambiguous-entry test (writer-edit-surface-scope) and `TypeError ... reading 'sessionManager'` on a ctx-less subagent_status (gentle-agents). GREEN after fix. An unquoted whitespace entry that is valid when quoted now names both repairs (backticks or move prose); entries invalid even when quoted keep the prose advice. R3-003 is a pure refactor (one regex source), covered by existing inheritance tests.
L19 2026-10-03 user (verbatim): > luego una vez que esto lo tengamos tenemos que hcer la paridad en gentle-ai
L20 2026-10-03 user (verbatim): > ahh si dale haz la paridad
   gentle-ai: issue #5214 (cross-repo refs are rejected there) and PR #5215 merged as 665a181a (commits 6c664915, 122e85b7, 5c460fce, cf8b93e0; feature doc odd/tasks/odd-spec-by-reference.md; its T5 identity is cf8b93e0). Three RDD reviews approved; 18 CI checks green.
L21 2026-10-03 T3 evidence (risk: medium, prompt contract + mirror):
   `node scripts/mirror-odd-routing.mjs --gentle-ai <clean worktree at 665a181a>` regenerated the fixture (previous source e7729359). Two ratchet anchors were stale from earlier canon changes, not from #1713: the 4-file mapping trigger (gentle-ai#5139 adopted the evidence budget) and the SDD trigger clause (canon is ODD-only); both now anchor the current canon text.
   Parity fixes found by the gentle-ai review: step 6 example no longer nests backticks; verify runs only authorized examples, on isolated state when they mutate data; gentle-ai-verify command scope includes spec example commands (tests/package-manifest and tests/odd-integration assertions updated; exact + explicitly-authorized invariant kept).
   RED: contract test (missing canon wording, nested backticks) and two new ratchet anchors failed first. GREEN: 610/610 prompt-contract tests.
