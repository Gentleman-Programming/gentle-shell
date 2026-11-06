# R1 native review advisories

Objective: fix the non-blocking findings the two native reviews of the R1 branch left (lineages
`review-46634843fbcff26e` and `review-0ddbadb8c307e151`, both approved), where a finding is a real defect; record the
ones judged not worth changing. Branch `feat/harness-r1-runtime-checks` (rebased on origin/main `b011e52d8`). Runner:
`pnpm test`.

## Specs

- S1 (user, verbatim): "vamos con todas" — after the summary that listed "Los 12 hallazgos que no bloquean de la review
  de R1. Los más útiles: un TMPDIR que puede quedar sin borrar y la señal de slice que informa \"0 líneas\" cuando falla
  `git diff`."
- S2 Findings to examine (id, lens, location as reported; line numbers are pre-rebase and approximate):
  1. R3-scratch-cleanup-leak / R1-child-scratch-removed-on-exit — lib/agents-runner.ts ~1034-1036 (child TMPDIR can be
     left behind, or removed at a moment a descendant may still use it).
  2. R4-commit-slice-diff-failure-reports-zero / R3-001 / R4-commit-slice-timeout-misreport — lib/commit-slice-signal.ts
     ~53-62 (a failed or timed-out `git diff` reports "0 authored changed lines" instead of no line).
  3. R4-commit-slice-sync-git-blocks-parent / R3-commit-slice-sync-git — lib/commit-slice-signal.ts ~31-37 (synchronous
     git calls in the parent tool_result path).
  4. R3-commit-slice-background-shell / R3-002 — extensions/gentle-ai.ts ~10370-10373 (slice line for a background
     shell or a command whose commit has not happened yet).
  5. R3-commit-detect-echo — lib/commit-slice-signal.ts:17 (commit detection on echo/quoted text).
  6. R1-todo-progress-overrides-withdrawal / R1-001 / R3-005 — extensions/gentle-agents.ts ~595-604 (automatic
     progress republishes state the owner withdrew with `state: null`).
  7. R3-todo-progress-cleared-list — extensions/gentle-todo.ts ~289 (cleared list publishes "0/0 done").
  8. R3-delivered-test-lint-false-positive / R3-003 / R4-delivered-test-lint-no-escape — lib/delivered-test-lint.ts
     ~19-43 (false positive cases; no escape hatch).
  9. R3-backstop-zero-threshold — lib/context-backstop.ts:36 (a zero or tiny threshold).
  10. R3-test-path-separator / R3-004 — tests/agents-runner.test.ts ~1874 (path separator assumption in a test).
  11. R3-006 — scripts/run-test-suite.mjs:35 (suggestion).
- S3 For each finding: reproduce it with a failing test first when it is a real defect, then fix; when it is not a
  defect or the fix costs more than it saves, record why in the Log. A withdrawn owner state (`state: null`) must stay
  withdrawn until the owner publishes again. Do not loosen any guard.
- S4 Unchanged: all other behavior (prove touched features' previous cases still hold).

## Tasks

| ID | Specs | Work | Route | Status |
|---|---|---|---|---|
| T1 | S1-S4 | examine and fix findings 1-11 | delegated (parallel with bench T12, disjoint repositories) | done, uncommitted (fixed 1-7, 9, 10; not changed 8, 11; `pnpm test` and `pnpm -s typecheck` pass) |

## Log

- L1 (user, 2026-10-15): "vamos con todas y lo de yolo ya esta arreglado y mergead". Branch rebased onto origin/main
  `b011e52d8` (includes the YOLO push redirect fix) without conflicts.
- L2 (T1, finding 1, fixed): a quarantined POSIX child whose own exit arrived while a descendant still held its
  process group was never probed again (quarantine had cancelled polling and no later event reports the group's end),
  so its TMPDIR and its quarantined slot stayed for the rest of the session. The observed exit now keeps probing the
  group every 1s until it is gone, then completes the exit (scratch removed, slot freed, recorded outcome unchanged).
  Test: `a quarantined child whose exit is seen before its group ends frees its TMPDIR and slot once the group is
  gone` (RED: no probe scheduled after the exit). The other half ("removed while a descendant may still use it") is
  not changed: removal happens only on proven exit (group gone, or on win32 the observed exit, the only proof there),
  the same standard that frees the slot; a descendant that leaves the group (setsid) cannot be tracked.
- L3 (T1, finding 2, fixed): a failed or timed-out `git diff` was read as an empty diff and reported "0 authored
  changed lines"; it now reports nothing. Test: `a failed diff reports nothing instead of zero lines`.
- L4 (T1, finding 3, fixed): the slice report ran up to six `execFileSync` git calls (2s timeout each) in the parent's
  tool_result handler, freezing the interface while git answered. Git now runs through async `execFile`, and the
  handler awaits it. Test: `the parent keeps running while git computes the report` (RED: a setImmediate callback had
  not run when the report returned).
- L5 (T1, finding 4, fixed): `bash_background`/`monitor` results arrive when the job starts, before its commit exists,
  so the slice line described the old HEAD. Only foreground `bash` carries it now. Test: `only a foreground bash commit
  carries the slice line`. Not handled: a trailing `&` inside a foreground bash command (rare; the line still states
  the branch's true current count).
- L6 (T1, finding 5, fixed): detection matched `git commit` anywhere after whitespace (`printf 'run git commit now'`,
  a PR body) and any `echo ... git` segment suppressed a real commit elsewhere in the command (`echo 'staging git
  files' && git commit -m x`). A commit is now a git invocation that starts a shell segment (split on `; & | ( newline`,
  optional leading `VAR=value` assignments). Test: `isGitCommitCommand counts a git invocation that starts a shell
  segment, not text that mentions one`. Known limit: `bash -c "git commit ..."` is not detected (no line; never a
  wrong one).
- L7 (T1, finding 6, fixed): automatic todo progress merged into `state ?? {}`, so after the owner withdrew with
  `state: null` the next todo write republished a state. A withdrawn state now stays withdrawn until the owner
  publishes again. Test: `todo progress publishes merged into the owner's curated state, only for this session`
  (extended; RED: `{ progress: '1/3 done; current: Docs' }` instead of null).
- L8 (T1, finding 7, fixed): a cleared todo list published "0/0 done". It now drops the progress line and keeps the
  curated fields, and publishes nothing when there was no progress line. Same test as L7 (RED: `progress: '0/0 done'`).
  Fixed at the consumer (extensions/gentle-agents.ts), not at the emitter, so peers do not keep the stale count.
- L9 (T1, finding 8, not changed): confirmed false positives: a test fixture string such as
  `isDestructive("git checkout 9e8d7c6 -- src")`, a comment `git diff shows the change from 1a2b3c4`, and a shell line
  `TMPDIR=$(mktemp -d) node --test "$PWD/tests"` (the TMPDIR value runs to the end of the command). Narrowing the
  TMPDIR value to a shell word would also miss JS forms such as `TMPDIR=a + process.cwd()`, and an escape hatch (a
  marker in the content) is one the model can add to bypass the block; both loosen the guard, which S3 forbids. A
  fixture can use a non-mixed id (`deadbee`, `HEAD~1`), and the block reason already names the alternative.
- L10 (T1, finding 9, fixed): a tiny window or fraction floored the threshold to 0, so an empty context reached the
  backstop (one notice at 0 tokens, and the writer/verifier admission checks that share the threshold admitted every
  launch). The window-derived threshold is now at least 1 token. Test: `the threshold is never below one token, so an
  empty context never reaches it`.
- L11 (T1, finding 10, fixed, test only): tests/agents-runner.test.ts built the expected prefix as
  `${tmpdir()}/gentle-pi-subagent-tmp-`, which fails on Windows separators; it now uses `join`. No RED on Linux (the
  file does not run on Windows CI); test: `a relative inherited TMPDIR falls back to the system temp dir, so the
  child's path is absolute`.
- L12 (T1, finding 11, not changed): the suggestion's text is not in this document or the repository. Examined line 35
  (`unitTmp`): it covers only TMPDIR, so on Windows (os.tmpdir reads TEMP/TMP) fixtures would keep the inherited temp
  dir, but `pnpm test` runs only on ubuntu CI and the Windows jobs run their test files directly, not through this
  runner; and if the second mkdtemp threw, configHome would stay, which needs an unwritable temp dir that already
  fails the first mkdtemp. Neither is worth a change without the reviewer's concrete case.
