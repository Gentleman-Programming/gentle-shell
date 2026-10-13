# README and landing refresh for the v4.1 release line (2026-10-12)
Objective: update the gentle-ai README, the Gentle Shell (gentle-pi) README, and the gentlemanprogramming.com landing (`Gentleman-Programming/new-terminal-landing`) with the new delegation model, the v4.1 features, and the measured benchmarks. Branches: `docs/readme-refresh-oct12` (gentle-ai, gentle-shell), `docs/landing-refresh-oct12` (landing). Delivery: one PR per repository. Checks: structural readback, repository doc/format checks, landing build.

## Specs
- S1 (verbatim): "necesito que leas el reade tanto de gentle-ai, gentle-shell y tambien de la landing de gentlemanprogramming.com y me actualices la información con la nueva forma de delegar, novedades de funcionalidades, benchmarks y tal"
- S2 New delegation model (sources: gentle-ai #5250 / gentle-shell #1794 "delegate for a reason, not for size"; #5218 / #1723 task sizing; #5215 / #1718 spec by reference): small work (understood, contained risk, resumable from the diff) runs inline with no subagents or task document; delegation needs a named reason — an exploration map beyond the inline evidence budget (one batch, about 3 calls / 10k tokens), parallel writers with disjoint edit surfaces, or the long-session context backstop; high-risk changes get an independent verifier; the feature document holds the user's spec verbatim and handoffs reference it instead of paraphrasing.
- S3 v4.1 features: gentle-ai v4.1.0/v4.1.1 (proportionate native review with agent-selected lenses, provider contract 1.3.0, SDD cleanup on sync, OpenCode hardening, Gentle Shell installer candidates, Windows Full Suite green); Gentle Shell 4.1.0 (clean-machine installers and browser wizard, bundled Gentle Shell, background jobs and monitors, contextual Auto permissions, cross-session coordination, session-bound profiles, review by risk, startup and Changes).
- S4 Benchmarks: only published, sourced numbers with their caveats (local bench, n=1, API-equivalent cost); never invent or round favorably; show the large-task time gap honestly.
  - #1494 → #1723 (gpt-6.1-sol low, same hidden acceptance suites): 3-line bug 335 s / 56 turns / $0.339 → 77 s / 10 turns / $0.105 (no subagents, no ODD document); shared-root-cause bug 479 s / $0.361 → 276 s / $0.207 (one explore); data migration 559 s / $0.403 needing a feedback round → 539 s / $0.555 accepted at round 0 (one independent verifier).
  - #1713 (same model gpt-6-luna medium, 26 hidden checks): paraphrased handoffs never passed — 13 failing after the first attempt, 23/26 after two feedback rounds — fixed by spec by reference (#1718).
  - #1794 vs Codex CLI vanilla, same model, hidden acceptance, blind review: small 1.8 min / $0.07 vs 1.9-2.3 min / $0.09-0.11 (Gentle Shell above in 1 of 2); medium 2.8 min / $0.10 vs 3.2-3.6 min / $0.12-0.15 (above in 3 of 3); large 6.1 min / $0.23 vs 17.5-17.9 min / $0.68-0.74 (Gentle Shell first on quality; Codex accepted unknown categories). All accepted on the first round; the large-task time gap is an open follow-up.
- S5 Keep each repository's existing structure, voice, and links; English artifacts; no unrequested sections or claims.

## Tasks
- [x] T1 (S1-S5) gentle-ai README — inline, gentle-ai#5476
- [x] T2 (S1-S5) Gentle Shell README — inline, #2134
- [x] T3 (S1-S5) landing (new-terminal-landing) — inline, RED 6 → GREEN 198/198, astro build 0 errors
- [ ] T4 PRs, checks, merge per repository policy

## Log
- L1 (2026-10-12, user): "y una cosa, necesito que leas el reade tanto de gentle-ai, gentle-shell y tambien de la landing de gentlemanprogramming.com y me actualices la información con la nueva forma de delegar, novedades de funcionalidades, benchmarks y tal"
- L2: Earlier the user said "hazlo tu no uses un explorer" (release notes); this work is done inline by the parent.
- L3: Landing identified as `new-terminal-landing` (live title "Gentle-AI stack for teams: memory, process and proof" = src/pages/index.astro:57).
- L4: Landing also carried statements made false by v4.0.0 (SDD "not deprecated", file-count routing, RDD "opt-in and off by default", gentle-ai 2.5.1 help snapshot); updated with the real v4.1.1 `--help` and `review mode status` output. Costs use "USD" because the landing guard forbids `$<digit>` (no pricing claims). Telemetry copy that describes historical `sdd` rows is unchanged. Out of scope: the Pi (0.84.4) and engram (1.20.0) version snapshots in the landing tool table.
