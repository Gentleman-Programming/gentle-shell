# gentle-shell #1558 — writer admission agreement + launch-seam tests

Issue: #1064 (slice 2, PR #1558). Reviewer: barbatdev (2026-10-03 19:21 UTC) — merge blocked on two scoped items.

## Goal

1. **Regression**: the non-git writer admission resolves `admittedModel` from
   pin/global layers only while the launch path resolves through
   `sessionOrPinModelProfiles` (session binding first). With a binding present,
   the two disagree and the writer fails with
   `"Writer effective profile or session changed during preparation"`.
   Fix: resolve the admitted model through `sessionOrPinModelProfiles` too
   (hoist the single binding read above the admission block).
2. **Launch-seam tests** (the two registered gaps, in `tests/gentle-agents.test.ts`):
   - session-over-pin at the real launch seam;
   - queue freeze under rebind (a queued launch keeps the routing frozen into
     its task request even if the session rebinds).

## Tasks

1. [x] RED→GREEN: writer-admission regression test + admission fix (`extensions/gentle-agents.ts`).
2. [x] Launch-seam tests: session-over-pin + queue freeze under rebind.
3. [x] Focused checks (full `gentle-agents.test.ts`, typecheck), work-unit commits, push.
4. [x] RDD review lifecycle for the candidate (inspect → start → capture → acknowledge).

## Evidence

- Commits: `71c8161fa` fix(agents): writer admission agreement (RED→GREEN, regression test included); `19efec0fd` test(agents): session-over-pin + queue freeze at the launch seam. Pushed to `fork/feat/1064-session-effective-routing` (4ffe4f9e1..19efec0fd).
- Checks: `tests/gentle-agents.test.ts` 175/175, `tests/session-profile-binding.test.ts` green, `scripts/check-types.mjs` no regressions.

## Out of scope

- Follow-up #1064 slices (reload/edit/delete semantics, orchestrator/default handling, lens routing, resume persistence, store-write hardening).

- RDD: lineage review-7bd1feb74621ae95, tier medium (lens review-reliability), closed **approved** and acknowledged; advisory follow-ups: catalog-miss branch untested (gentle-agents.ts:1214-1220), stale launch-seam binding comment (:1267-1269).
- Docs commit: bd15da867.
