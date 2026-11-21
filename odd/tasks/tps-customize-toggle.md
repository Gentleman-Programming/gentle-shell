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

- T1 [S1, S6] `lib/tps-policy.ts` + `tests/tps-policy.test.ts`. Route: inline, test-first. Commit: TBD
- T2 [S2, S6] Gate in `extensions/gentle-tps.ts` + extended `tests/gentle-tps.test.ts`. Route: inline, test-first. Commit: TBD
- T3 [S3, S4] Rows + description in `extensions/gentle-shell.ts`. Route: inline. Commit: TBD
- T4 [S5] Docs. Route: inline. Commit: TBD
- T5 verification: full suite + typecheck. Commit: TBD

## Log

- L1 User request (2026-11-21): "Eso si, crea un PR que haga que se agregue a
  /gentle:customize para que se pueda desactivar" (the TPS notification).
