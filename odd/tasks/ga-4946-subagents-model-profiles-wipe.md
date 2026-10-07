# gentle-ai#4946: preserve user `model_profiles` in `~/.pi/agent/subagents.json`

Delivery repo: gentle-shell (gentle-pi npm package). Cross-repo close of
Gentleman-Programming/gentle-ai#4946. Branch: `fix/4946-preserve-subagents-model-profiles`
(base `6e681f1d0`). Test runner: `npm test` in the repo root (vitest-style suites under `tests/`).

## Specs

S1. "`gentle-ai sync` — and applying a Pi model profile from the TUI Model Configuration menu — rewrites `~/.pi/agent/subagents.json` with gentle-ai's own default, deleting every `model_profiles` entry configured for Pi subagents." (gentle-ai#4946 body)

S2. "The configured `model_profiles` survive a sync, or gentle-ai backs the file up and asks before overwriting it." (gentle-ai#4946 Expected Behavior)

S3. "The same write re-materialises `~/.pi/agent/agents/*.md` from embedded templates that carry no `model:` / `thinking:` frontmatter." (gentle-ai#4946 body) — Reporter's own scoping: "Restoring the `.md` frontmatter is pointless because the next sync re-materialises those files, so `subagents.json` is the only file worth restoring." S3 is context, not an acceptance surface; the fix must not regress package-asset re-materialization, and does not attempt to preserve user frontmatter inside package-managed agent files.

S4. Evidence base from the report: "subagents.json is reduced to a single entry (`review-refuter`)", and "The pre-change backup covers `~/.pi/agent/agents/*.md` but not `subagents.json`".

## Tasks

- T1 | S1, S4 | inline | commit | Deterministic reproduction (RED): unit test in `tests/` proving the startup sweep path (`applySavedModelConfig` → `applyModelConfig(Async)` → `updateSubagentModelProfile(user, …)`) deletes user-authored `model_profiles` entries the store never owned, leaving only provider review roles. DONE (RED): `tests/model-profiles-preservation.test.ts` — clear store entry `{worker: {}}` deletes user `model_profiles.worker` (`openai/gpt-4o` expected, gone; 0/3 pass).
- T2 | S2 | inline | commit pending | Design note answering the ownership question posted in the claim (issuecomment-6036215922): startup sweep clears only entries it previously materialized (ownership tracking), vs backup-before-destructive-sweep. RESOLVED: ownership tracking via sidecar `materialized-model-profiles.json` (kind `gentle-pi.materialized-model-profiles/v1`) beside each `subagents.json` scope; consented flows (panel save, confirmed profile apply) keep full destructive semantics; stale GC (names with no discoverable definition) stays destructive. Backup-ask rejected: fixes nothing the ownership gate does not, and leaves data loss between backups.
- T3 | S1, S2 | inline | commit pending | Implement the chosen fix in `extensions/gentle-ai.ts` (+ `lib/` if shared). Preserve the consented profile-apply replacement semantics (explicit `/gentle:models` flow with its confirmation). DONE: `applySavedModelConfig` passes `{sweepMode:true}`; `applyModelConfig(Async)` gate clears (both surfaces: subagents.json + agent frontmatter) to tracked names in sweep mode, second-loop stale GC exempted; tracking read/write helpers with best-effort sidecar writes.
- T4 | S1–S3 | inline | commit pending | Checks: focused suites for touched areas, repo typecheck/tests; regression test proving the consented profile-apply clear flow still works. DONE: 177/177 (model-profiles-preservation NEW 3/3, model-routing-authority, agent-profiles, gentle-ai.test.ts 115/115); runtime-harness PASS (one scenario expectation updated to the approved S2 semantics, disclosed); provider-contract PASS; full unit battery: 8 failures all verified pre-existing on the clean base via stash (monitor/jobs 6, header-parse NaN 1, SDK load 1); check-types: no regressions.
- T5 | S1–S4 | inline | Native review (RDD) on this root, then PR closing Gentleman-Programming/gentle-ai#4946 (branch-pr, work-unit commits recorded below).

## Log

L1. 2026-10-07 user: "busca en que podemos aportar" → opportunities radar; then "adelante con gentle-ai#4146", corrected via question to the radar pick gentle-ai#4946 (user selected "#4946 (mi pick)").
L2. 2026-10-07 Claim posted: https://github.com/Gentleman-Programming/gentle-ai/issues/4946#issuecomment-6036215922 (reporter mgg1976 credited; first deliverable = repro + design proposal; stand-down offered).
L3. 2026-10-07 Diagnosis map (read-only, both repos at current main): gentle-ai Go never writes `subagents.json`. gentle-pi extension activation sweep at `extensions/gentle-ai.ts` ~9862-9864: `installPackageAssets` (agents/*.md templates → S3 frontmatter loss) + `applySavedModelConfig` → materialization that also deletes entries; `PROVIDER_REVIEW_ROLES` always materialized → matches S4 single-survivor.
L4. 2026-10-07 RED evidence: `tests/model-profiles-preservation.test.ts` initial run 0/3 — persisted clear `{worker:{}}` deletes user `model_profiles.worker`.
L5. 2026-10-07 Contract conflict found and resolved: runtime-harness pinned the OPPOSITE of S2 twice (`explicitInheritClears` for tracked entries — kept, fix satisfies it via tracking; persisted-clear-deletes-hand-authored-project-routing — superseded by approved S2, harness expectation updated with disclosure). Boundary: hand edits made AFTER a harness-materialized write are still re-materialized by the store's non-clear entries (store remains authoritative for values it owns); only unconsented DELETION of never-owned entries changed.
