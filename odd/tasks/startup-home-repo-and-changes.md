# Startup speed, home-repo guard, and /gentle:changes reconciliation

Objective: stop Gentle Shell from creating or silently using a home-level Git repository, make startup faster (especially on Windows), and stop `/gentle:changes` from listing work already committed.
Branch: `fix/startup-home-repo-and-changes` · Delivery: single-pr (user: one PR, work in slices = one work-unit commit per task) · Test runner: `node --experimental-strip-types --test <file>`, suite `pnpm test`, types `pnpm typecheck`.

## Specs

- **S1 — Home bootstrap guard.** User: "Gentleshell, para poder funcionar, te obliga a crear un punto git. ¿Bien? Por el tema de RDD y demás. Entonces, claro, si vos abrís Gentleshell en el home, te crea un punto git ahí. y eso te hace explotar todo. Tenemos que ver cómo manejarlo." Native Git bootstrap (`safeBootstrapDirectory`) must refuse the home directory regardless of Windows path casing or drive-letter case, any ancestor of the home, and broad user folders directly under home (Documents, Desktop, Downloads, OneDrive*). Accepted plan block: "Guard del home".
- **S2 — Home repository warning.** When the session cwd resolves to a Git toplevel that is the home directory (or a refused broad folder), show one warning at startup telling the user to open Gentle Shell inside a project folder, and skip startup-only heavy Git work (skill-registry `git ls-files`, startup review negotiation). (Assumption: warning text is ours to write; no product decision open.)
- **S3 — /gentle:changes reconciliation.** User: "no anda bien el gentle:changes porque cuando termina la tarea a veces quedan los cambios reflejados pero ya se comiteo y subió todo". Captured entries whose file now matches HEAD (not listed by `git status --porcelain`) are hidden; reconciliation only removes, never attributes; it runs when the panel opens/refreshes and when the agent turn ends, never during startup (existing `gitCalls()===0` startup tests keep passing). A file that changes again reappears.
- **S4 — Startup quick wins.** Accepted plan block "Arranque: mejoras rápidas": per-process memo for `resolveSessionWorktree(cwd)` during startup; startup RDD status read populates the RDD status memo so the first prompt does not respawn it; timeouts on skill-registry `git ls-files` and banner `git branch`; skill-registry regeneration deferred off the awaited `session_start` path.
- **S5 — Startup structural.** Accepted plan block "Arranque: estructural": startup review negotiation no longer awaited inside `session_start` (runs after, result applied when ready) and the startup `review mode status` spawn gets a short timeout; the gentle-ai binary SHA-256 verification is cached keyed by file identity (path, dev, ino, size, mtime) and recomputed whenever any of them changes; on Windows, aborting a native CLI call kills the whole process tree (grandchild git included).

## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S1 | inline | pending | — |
| T2 | S3 | delegated (parallel with T3, disjoint surfaces) | pending | — |
| T3 | S2, S4 | delegated (parallel with T2) | pending | — |
| T4 | S5 | inline or delegated after T3 (shares gentle-ai.ts) | pending | — |

Issue: one issue covering all blocks (single PR), opened in Gentleman-Programming/gentle-shell.

## Log

- L1 (2026-10-12) User original requests, verbatim: "cuando se inicia gentle shell a un user le pasa esto: ~/.moshi/uploads/message (5).txt" / "Dice que le tarda 47 segundos en abrir" / "Dice que lo arreglo así: Quite el .git, y se soluciono" / "Si y además quiero que investigues dos cosas: 1- que podemos hacer para que gentle Shell cargue más rápido 2- no anda bien el gentle:changes porque cuando termina la tarea a veces quedan los cambios reflejados pero ya se comiteo y subió todo" / the S1 quote above.
- L2 User chose "Issue + implementar" and selected all four blocks: Guard del home, gentle:changes, Arranque: mejoras rápidas, Arranque: estructural.
- L3 Evidence: process sample showed gentle-ai.exe waiting ~17.6s on git under a home-level repo. `safeBootstrapDirectory` (lib/bounded-writer-admission.ts:117) only refuses filesystem root and exact `realpathSync(homedir())`. `/gentle:changes` never consults git (lib/session-changes.ts refresh is a no-op). Startup: Pi awaits session_start handlers serially; ~17 sync `git rev-parse` per startup; two awaited gentle-ai spawns (30s default timeouts); skill-registry awaits `git ls-files` without timeout; binary SHA-256 recomputed every invocation; abort kills gentle-ai but not grandchildren.
- L4 (2026-10-12) User: "crea un solo pr como mejoras de inicio pero trabaja todo en slices". Delivery switched to single-pr; each task stays its own work-unit commit; one issue instead of one per block.
