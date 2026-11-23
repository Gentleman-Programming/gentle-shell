# TPS usage notification — /gentle:customize toggle

Request (user, 2026-11-21): after the bundled TPS notification could not be
disabled, "crea un PR que haga que se agregue a /gentle:customize para que se
pueda desactivar". Upstream repo: Gentleman-Programming/gentle-pi. Branch
`feat/tps-customize-toggle` from origin/main.

## Specs

- **S1 Store.** "A settings file in the gentle-pi config home, following the
  notification-policy pattern": `tps.json`, schema `gentle-pi.tps/v1`,
  `enabled: boolean` (default `true`), strict shape validation, atomic write
  (unique temp + rename, mode 0600). Missing or malformed file resolves to the
  default (enabled) with a `malformed`/`readError` flag, like notifications.
- **S2 Gate.** "gentle-tps reads the policy fresh at every agent_end and skips
  the notification when disabled." A fresh read keeps the customize toggle
  live within a running session; a missing/malformed/unreadable file enables
  the notification (fail open, same as today's behavior).
- **S3 Customize row.** "A toggle in the Notifications category of
  /gentle:customize", following the animations dual-row pattern: one row per
  state, label `TPS usage notification: ON|OFF (current)`, Enter applies,
  preview explains what the notification is. Written through the same store
  (S1), effective from the next agent run without reload.
- **S4 Command description.** The `/gentle:customize` description lists the
  new toggle among the configurable things.
- **S5 Docs.** The TPS section in `docs/readme-reference.md` documents the
  toggle and its file.
- **S6 Tests.** "Policy: defaults, validation, parse, resolve, write round
  trip." Extension: disabled policy suppresses the notification; malformed
  file still notifies; enabled keeps current behavior. Tests inject
  `configHome`/io, never touch the real home.

## Tasks

- T1 [S1, S6] `lib/tps-policy.ts` + `tests/tps-policy.test.ts`. Route: inline, test-first. Commit: ed252a4 (+ Tps type rename folded in)
- T2 [S2, S6] Gate in `extensions/gentle-tps.ts` + extended `tests/gentle-tps.test.ts`. Route: inline, test-first. Commit: 8b75d73
- T3 [S3, S4] Rows + description in `extensions/gentle-shell.ts` + customize test + S5 docs. Route: inline. Commits: b8442d5, category fix 4852233
- T4 [S5] Docs (docs/readme-reference.md TPS section). Route: inline. Commit: folded into b8442d5
- T5 verification: `node scripts/check-types.mjs` clean (0 regressions); targeted tests 18/18 (`tests/tps-policy.test.ts`, `tests/gentle-tps.test.ts`) plus the new customize E2E row test. Full `pnpm test` compared against a clean origin/main worktree: 42 unique failures pre-existing on main in this environment, 41 on the branch; the diff is only known-flaky environment tests (Windows execFile timeout on Linux, timestamp-header fallback, runtime binary digest). The first full-suite run caught a real regression (TPS rows landed in the History category, breaking the History customize E2E) — fixed in 4852233 and re-verified.

## Log

- L1 User request (2026-11-21): "Eso si, crea un PR que haga que se agregue a
  /gentle:customize para que se pueda desactivar" (the TPS notification).

- L2 User decision (2026-11-21): rejected the local patch of the installed
  extension ("quitalo no me gusta los parches momentaneos"); the installed copy
  was restored byte-identical and the fix is delivered upstream instead.
  Deliverable: PR to Gentleman-Programming/gentle-pi — commits ed252a4,
  8b75d73, b8442d5, 4852233.
