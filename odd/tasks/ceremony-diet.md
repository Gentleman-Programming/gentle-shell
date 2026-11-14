# Orchestrator ceremony diet

Reduce the orchestrator's redundant "ceremony" in full-delegation runs without touching delegation or admission rules. RDD is now on (global), so delivery passes through native review.

## Specs

S1 (cut A). Human: "simplificar la ceremonia". In full-delegation mode the orchestrator must derive `## Allowed edit surfaces` from the repository layout (directory/file names, e.g. `ls`), not by reading the full task docs into its own context; the writer reads the docs. Keep admission's nonempty-surfaces requirement intact and keep "explore for a map to decide or route".

S2 (cut B). Remove duplicated clauses from `assets/orchestrator-full-delegation-card.md` that already live in the injected prompt: card:24 clause 1 (derive nonempty Allowed edit surfaces) duplicates orchestrator.md:40 + full-delegation.md:23; card:24 clause 2 (parallel writers only with disjoint surfaces) is byte-identical to `assets/orchestrator.md:84` which survives projection. Pure dedup, no behavior change, shrinks the card.

S3 (cut C1). Remove the duplicate `gentle-ai:engram-protocol` managed block from project `AGENTS.md` (lines 1–133). gentle-engram already injects `MEMORY_INSTRUCTIONS` every turn (`gentle-engram/plugin/pi/index.ts:131,3215`); the project copy is a duplicate that adds the aggressive session-start/proactive-save ceremony.

S4 (cut C2, separate repo gentle-engram). In headless/bench mode, defer the memory ceremony (`mem_current_project`, `mem_search`, `mem_save`, `mem_session_summary`) rather than removing it for interactive sessions. Implement in `gentle-engram/plugin/pi/index.ts`.

## Tasks

T1 [done] S1-S3 — tracking and branch from local main f1e68aa44; feature document — commit: none (local doc).
T2 [pending] S1 — FD projection: derive surfaces from layout, stop self-reading docs before delegation — commit: pending.
T3 [pending] S2 — card dedup (two clauses) — commit: pending.
T4 [pending] S3 — remove engram-protocol duplicate from AGENTS.md — commit: pending.
T5 [pending] S4 — gentle-engram headless memory deferral — commit: pending.
T6 [pending] S1-S4 — re-measure FD after cuts; native review receipts for delivery — commit: pending.

## Log

L1. Human: "HZcemls los 3" (hacemos los 3, cuts A/B/C), then "Ambos" (C1 + C2), then "Activa rdd".
L2. RDD enabled (global on). Delivery of these changes requires native review receipts.
L3. Bench-base caveat: the F3/F4 cost benches ran on `feat/scoped-agent-memory` tip 9c56193f6, not `main`; re-measurement after cuts must compare against the same base or state the drift.
L4. T2+T3 (A+B) implemented in gentle-pi: full-delegation ODD step 2 now derives nonempty ## Allowed edit surfaces from the repository layout (ls), never by reading the full task docs; the writer reads the docs. Card's duplicated first Launch bullet dropped via build-full-delegation-card.mjs projection rewrite and regenerated. Byte budget preserved (FD 22,113/22,365 B under 22,128/22,380 pins); pinning suites green (full-delegation-notices 7/7, exploration-budget 7/7, prompt-diet-contract 12/12, always-on-prompt-verdicts 11/11, closure 10/10, primary-session-prompt 7/7). Pre-existing #3009 macOS socket EINVAL on verify-first-launch-contract is environmental, not caused here. Diff: 4 files, +9/-3.
L5. C1 (source removal of engram-protocol from AGENTS.md) dropped: the file is shared — OpenClaw's workspace AGENTS.md is the same file Pi loads as project context — so source removal either breaks OpenClaw (no runtime injection, its only engram surface) or leaves Pi's ceremony intact. Explorer 3a-u9fo confirmed per-runtime: OpenCode/Codex have runtime injection (safe), Kilo conditional (engram setup rewrites same file), Kimi different artifact (no-op), OpenClaw static-block-required (would break). Human chose option 1: drop C1, keep C2, and add a Pi-side filter that drops the engram-protocol block from Pi's injected context (like #3095 drops orchestrator blocks), leaving the file on disk for OpenClaw. Tradeoff accepted: Pi loses session-start mem_current_project, proactive mem_save, mem_review lifecycle, capture_prompt, ambiguous_project recovery — rules gentle-engram's MEMORY_INSTRUCTIONS does not carry.
L6. Benchmark (F4, FD oauth, 3 reps each, hidden 92/92 every run). Clean comparison both RDD-off: baseline (ceremony on) parent $0.750 / total $1.518 / 7 turns / 437.8 s; after (ceremony off) parent $0.513 / total $1.219 / 6 turns / 426.8 s. Delta: parent −32%, total −20%, wall −2.5% (flat), memory ceremony calls gone (no mem_current_project/mem_search/mem_save). RDD-on intermediate (parent $0.571) confirmed the RDD gentle_review confound understated the saving. Blind quality review of the 9 F4 solutions (3 bare + 3 baseline-FD + 3 ceremony-FD) launched to confirm the cost saving did not degrade code quality.
L7. Blind quality review of the 9 F4 solutions (3 bare + 3 baseline-FD + 3 ceremony-FD), ~170 spec-derived probes, hidden 92/92 every run: zero defects anywhere; ceremony-FD == baseline-FD (median score 9 both, test-depth only), bare 7-8 (thinner tests, pre-existing — bare does not delegate to test-heavy writers). Verdict: the ceremony cuts saved 20% cost / 32% parent with no quality regression.
