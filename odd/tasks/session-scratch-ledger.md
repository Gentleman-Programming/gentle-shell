# Session scratch and artifact ledger

Objective: the runtime owns the parent session's temporary files and the clones/worktrees it creates, records them in
a persistent per-session ledger outside Engram, cleans what is safe automatically (including after cancelled, stuck,
or crashed sessions), and offers a command to list and clean the rest, so the model spends no tokens remembering or
re-deducing what is garbage. Branch `feat/session-scratch-ledger` from `feat/harness-r1-runtime-checks` (stacked on
gentle-shell#2290). Runner: `pnpm test`.

## Specs

- S1 (user report, verbatim): "En gentle-shell main de hoy, dependiendo del caso crea test temporales, clones etc pero
  después de un largo tiempo se olvida de ellos y peor, si por alguna razón se paraliza una tarea por bloqueante o se
  cancela la misma, los test o temporales no se borran. A veces el modelo por iniciativa puede pedir investigar si los
  temporales son creados por su tarea y pide permiso de borrarlos y eso demuestra que se olvida de ellos. De manera
  persistente en algún lugar además de engram, debería guardar esas rutas y ficheros temporales que crea y al
  finalizar un plan o tarea pueda mirar ahí y borrarlos sin necesidad de gastar tokens deduciendo o leyendo su
  contenido y verificando que se pueden borrar. También podría haber un automatismo que los borre o un comando para
  que borre la basura listada". User: "Si ahira" (implement now) after the proposal below.
- S2 Parent session scratch: at primary session start the runtime creates
  `<inherited tmpdir>/gentle-pi-session-<session id>-XXXX` (mkdtemp, private mode) and points `TMPDIR` (and `TMP`/`TEMP`
  on win32) of the Pi process at it, so every `mktemp` the model runs and every subagent's own TMPDIR (T3) land under
  it. Children never create a session scratch of their own. If creation fails, the session keeps the inherited TMPDIR.
- S3 Ledger: a JSON file per session in gentle-pi's config home (for example
  `<GENTLE_PI_CONFIG_HOME>/scratch/<session id>.json`) records: schema version, session id, owning process id and
  start time, cwd, the scratch dir, and artifacts outside TMPDIR. Writes are atomic (temp file + rename). Never in
  Engram.
- S4 Artifact capture: after a successful foreground parent `bash` command, the runtime records the destination of
  `git clone ... [<dir>]` (the default directory name when omitted) and the path of `git worktree add ... <path>`,
  resolved against the command's directory (reuse the cd-segment resolution from lib/commit-slice-signal.ts), with the
  command line and time. Only paths that exist after the command are recorded. No model call is needed.
- S5 Automatic cleanup: (a) on session shutdown the runtime removes its own scratch dir and deletes the ledger when no
  artifacts remain; (b) at primary session start it sweeps ledgers of dead sessions (owning process not alive and the
  ledger older than a grace period, default 1 hour): removes their scratch dirs, keeps their artifact entries for the
  command. Removal is limited to directories the runtime created (prefix and ledger match; never follow symlinks out).
- S6 Command `/gentle:scratch`: `list` shows the session's scratch dir with its size and every recorded artifact of this
  and dead sessions; `clean` removes scratch dirs without asking and, for recorded worktrees and clones, removes only
  those with no uncommitted changes and no unpushed commits (clones) after one confirmation listing them; dirty ones
  are reported and kept. Worktrees are removed with `git worktree remove` (then pruned), clones with a recursive delete
  of the recorded path only. Headless/no-UI: `clean` removes scratch only and reports artifacts.
- S7 Prompt: the orchestrator text that tells the model to clean its scratch is shortened to say the runtime owns
  session scratch and `/gentle:scratch` lists or cleans recorded clones and worktrees (keep module byte budgets and
  pins; check tests/orchestrator-budget.test.ts and the test-scratch contract tests).
- S8 Docs: docs/readme-reference.md describes the scratch dir, the ledger location and format, automatic cleanup, the
  sweep rule, and the command; the help text of the command matches.

## Tasks

| ID | Specs | Work | Route | Status |
|---|---|---|---|---|
| T1 | S2-S8 | session scratch, ledger, capture, cleanup, command, prompt, docs, tests | delegated (context backstop) | committed (L2-L3); correction batch for L4 uncommitted (L5-L9); re-verification and native review pending |

## Log

- L1 (user, 2026-10-15): report in S1 and "Si ahira". Risk: item 1 (deletes files and directories) — needs an
  independent verifier and native review after the writer.
- L2 (evidence, T1): new extension `extensions/session-scratch.ts` (auto-discovered, registers nothing when
  `GENTLE_PI_AGENTS_CHILD=1`) over `lib/session-scratch.ts`; `lib/commit-slice-signal.ts` now exports
  `SHELL_SEGMENT_SEPARATOR` and `directoryAfterSegment`, shared by `commitTargetDirectory` and S4 capture.
  RED: `tests/session-scratch.test.ts` failed with `ERR_MODULE_NOT_FOUND` for `extensions/session-scratch.ts`.
  GREEN: 19/19, then 22/22 after triangulation. TRIANGULATE: removing the protected-path check at record time fails
  "S4: a clone into the session directory or an ancestor of it is never recorded"; disabling the detached-commit check
  fails "S6: clean keeps a detached worktree whose commits are on no branch" (both restored). S7: the writer line now
  says the runtime owns session scratch and `/gentle:scratch` lists or cleans recorded clones and worktrees (268 to 263
  bytes); `tests/test-scratch-contract.test.ts` pins it (the old writer text lacks the clause). S8: reference section
  "Session scratch and artifact ledger" plus a command row, pinned against `SCRATCH_COMMAND_USAGE`. Checks:
  `pnpm test` all three stages PASS (unit 6956 tests, 6884 pass, 0 fail); `pnpm -s typecheck` 0 diagnostics;
  `node scripts/verify-package-files.mjs` passed (214 files).
- L3 (decisions, T1): reload keeps the scratch (same session); other shutdown reasons remove it and restore the
  inherited `TMPDIR`/`TMP`/`TEMP`. A scratch dir is removed only when it is the recorded real path, carries
  `gentle-pi-session-<safe session id>-`, is a non-symlink directory owned by the current uid, and holds no recorded
  artifact (a scratch holding a clone is kept for `clean`). `clean` empties the live session's scratch (it is still
  `TMPDIR`) except `gentle-pi-subagent-tmp-*` and recorded artifacts. Clones need a clean `git status`, a `.git`
  directory, the recorded path as Git top level, and `rev-list --all --not --remotes` empty; worktrees need a clean
  status, a `.git` file, and, when detached, commits on a branch. Paths that are a filesystem root or the home, config
  home, ledger cwd, or process cwd (or an ancestor) are never recorded or removed. A resumed session id carries the
  artifacts of its earlier ledger. `assets/orchestrator-verification.md` (outside the surfaces) still says the parent
  removes verifier scratch paths; verifier scratch now lives in the child TMPDIR the runner removes.
- L4 (2026-10-15) Independent verifier: 2 blockers, 3 advisories. B1 `/reload` deletes the live scratch: Pi reloads
  extensions with jiti `moduleCache:false` after `clearExtensionCache()`, so module state (the `activeSessions`
  WeakMap) is new; `startSession(reason=reload)` creates a nested scratch and `removeSessionScratch(previous)` (same
  pid) deletes the old one with its contents; the reload test passed only because it reused the module instance.
  B2 `git clone URL dir || (cd dir && git pull)` over an existing user clone exits 0, S4 records `dir`, and `clean`
  removes the user's repo (ignored files included) after one confirmation. Advisories: a forged ledger can name any
  `.../gentle-pi-session-<id>-*` path outside a temp root; shutdown removes nested quarantined subagent TMPDIRs
  (win32 risk; POSIX quarantine follows SIGKILL); assets/orchestrator-verification.md still says the parent removes
  verifier scratch. Branch rebased onto origin/main after gentle-shell#2290 merged (`4372ff2d`).
- L5 (evidence, T1 B1) The ledger now records `tempRoot` (the real dir the scratch was created directly under) and
  `inherited` (temp variables before the session, `null` when unset; shutdown restores them from the ledger).
  `session_start` reuses the ledger's scratch when the ledger names this pid, its scratch passes the removal checks,
  and `TMPDIR` is that dir or inside it; startup never removes a scratch whose ledger names this pid. RED:
  "S2/S5: a reload into a fresh module instance recovers the live scratch from the ledger and quit removes it once"
  (two module instances via `import("../extensions/session-scratch.ts?instance=...")`) failed with `TMPDIR` nested
  (`.../gentle-pi-session-s-1-pg5PtU/gentle-pi-session-s-1-jlVjJB`); "S5: startup never removes a scratch of this
  process that TMPDIR no longer points into" failed (`work.txt` gone). GREEN after the fix; the same-instance reload
  test is kept. TRIANGULATE: disabling the ledger reuse or restoring the same-pid removal fails exactly the
  corresponding test (restored).
- L6 (evidence, T1 B2) Capture is split: `tool_call` resolves the clone/worktree destinations of a foreground `bash`
  command and keeps, by tool call id, only those that do not exist (ENOENT); `tool_result` records a kept one only
  when the command succeeded and it is a directory afterwards. A result without its call records nothing. The clean
  confirmation now says ignored files inside the listed paths are deleted too. RED: "S4: a clone fallback over an
  existing user clone records nothing and clean keeps it" failed (the user's `dir` was recorded); "S4: failed,
  missing, non-bash, and child results are not recorded" failed (a result without a call recorded `no-call`); the
  S6 clean test failed on the confirmation text. GREEN after the fix. TRIANGULATE: treating an existing
  destination as absent fails the fallback test (restored). The test helper now emits `tool_call`, runs the command's
  effect, then `tool_result`; existing tests create their clones inside that effect.
- L7 (evidence, T1 A1) A scratch dir is accepted for removal only when `dirname(scratchDir)` equals the ledger's
  `tempRoot`, and a `tempRoot` inside `$HOME` only when it equals the asking session's own recorded temp root
  (interpretation of "unless it equals the ledger's recorded root": a forged ledger can forge its root too, so a
  home-internal root is trusted only when it is ours). A ledger without `tempRoot` names no removable scratch. RED:
  "S5: a forged ledger naming a session-prefixed directory outside its recorded temp root is refused" (ENOENT:
  `.../work/gentle-pi-session-evil-abc/keep.txt` removed) and "S5: a recorded temp root inside the home is accepted
  only when it is the session's own temp root" failed; GREEN after the fix. TRIANGULATE: dropping the parent check,
  the missing-root check, or the home check each fails its test (restored).
- L8 (evidence, T1 A2/S8) `assets/orchestrator-verification.md`: "after the verdict, the parent removes the scratch
  paths the verifier reports" became "the runtime removes each subagent's own TMPDIR, which holds that copy" (7496 to
  7489 B, budget 7500); `tests/test-scratch-contract.test.ts` pins the new text and the absence of the old (RED:
  "S10: scratch outside the worktree is removed after use" failed on the missing text, GREEN after). Reference:
  `tempRoot`, `inherited`, reload recovery, before/after capture, the temp-root rule, and the ignored-files warning;
  the S8 test pins them (RED: missing `tempRoot`; GREEN after). Checks: `tests/session-scratch.test.ts` 27/27 and
  `tests/test-scratch-contract.test.ts` 4/4; `pnpm test` all three stages PASS (unit 6961 tests, 6889 pass, 0 fail,
  72 skipped); `pnpm -s typecheck` 0 diagnostics; `node scripts/verify-package-files.mjs` passed (214 files).
- L9 (decision, T1) Quarantine advisory documented only: shutdown removing a nested quarantined subagent TMPDIR is a
  win32 risk (POSIX quarantine only follows SIGKILL); not changed in this batch. Known residual: a scratch of this
  pid that `TMPDIR` no longer points into is kept, not tracked, when the same session id starts a new scratch.

## Socket path budget (correction after native review escalation)

- S9 (user decision 2026-10-16: "Nombres mínimos (recomendado)"): native review `review-53947d6fb7bbec8f` escalated
  R3-scratch-socket-path-length: redirecting TMPDIR lengthens paths so Unix domain sockets created under it (for
  example Python multiprocessing `pymp-XXXXXXXX/listener-XXXXXXXX`, 32 bytes) exceed the AF_UNIX limit (104 bytes on
  macOS including the NUL, so at most 103). Requirements:
  - Session scratch basename `gpXXXXXX` (mkdtemp of `gp`, 8 chars, no session id or hash); subagent TMPDIR basename
    `gaXXXXXX` (lib/agents-runner.ts and `SUBAGENT_SCRATCH_PREFIX`).
  - The TMPDIR value given to the process is `join(<inherited TMPDIR exactly as inherited>, <name>)`, never a realpath
    (macOS realpath adds `/private`, 8 bytes); the ledger and every identity/refusal check keep using realpaths.
  - Budget: with an inherited TMPDIR of 48 bytes (macOS `/var/folders/xx/<30 chars>/T`), session scratch + subagent
    TMPDIR + `/pymp-XXXXXXXX/listener-XXXXXXXX` is at most 103 bytes. A test builds a 48-byte inherited TMPDIR and
    asserts the child TMPDIR plus 32 bytes is at most 103.
  - Removal safety that the session id in the name used to give: a scratch dir recorded by the ledger of a live session
    (owning pid alive) is never removed through another session's ledger (sweep and clean). Keep every existing refusal.
  - Reload recovery, shutdown restore, and all existing tests keep passing; update tests and docs that name the old
    prefixes.
- L10 (evidence, S9) Names: `SCRATCH_PREFIX = "gp"` and `SUBAGENT_SCRATCH_PREFIX = "ga"` (lib/agents-runner.ts now
  imports it); `scratchRefusal` accepts only a basename matching `^gp[A-Za-z0-9]{6}$` and `clean` keeps only entries
  matching `^ga[A-Za-z0-9]{6}$` (`scratchNamePrefix` and the session-id hash are gone). `createSessionScratch(base)`
  returns `{ path, realPath }`: `TMPDIR`/`TMP`/`TEMP` get `path` (mkdtemp of `join(<inherited as given>, "gp")`), the
  ledger `scratchDir`/`tempRoot` get real paths. Live-ledger refusal: `heldBy` in extensions/session-scratch.ts adds
  to the held paths of every removal (sweep, `clean`, shutdown, startup replacement) the scratch dirs of every other
  ledger whose pid is alive plus the current session's own; `removeSessionScratch` keeps a dir or entry that equals or
  holds one. RED: "S9: the scratch name is gpXXXXXX whatever the session id" (`gp-ffe054fe-Qo3QGw`), "S9: TMPDIR keeps
  the inherited spelling while the ledger records real paths" (dirname was the real `.../tmp`, not `.../tmp-link`),
  "S9: under a 48-byte inherited TMPDIR, a subagent TMPDIR leaves room for a 32-byte socket name" (129 bytes), the
  updated name assertions in S2/S5/S6/S8 and agents-runner (`gentle-pi-subagent-tmp-adsukK`); after the rename,
  "S9: a dead forged ledger never removes the scratch a live session's ledger records, in the sweep or in clean"
  failed with ENOENT on `gpLiveAb/work.txt`. GREEN after each fix. TRIANGULATE: dropping the current session from the
  live set fails "clean keeps this session's scratch named by a forged ledger"; dropping other live ledgers fails the
  sweep assertion; dropping them only in `clean` fails the clean assertion (all restored). The "another session's
  prefix" case of the S5 refusal test became five non-scratch names (old prefix, old hash form, 7 and 5 random
  characters, wrong letter), all kept. Budget: 48 + `/gpXXXXXX` (9) + `/gaXXXXXX` (9) + 32 = 98 bytes <= 103. Docs:
  reference names `gpXXXXXX`/`gaXXXXXX`, the unresolved spelling, the live-ledger rule, and the budget. Checks:
  `tests/session-scratch.test.ts` 35/35, `tests/agents-runner.test.ts` 99/99, `tests/gentle-agents.test.ts` 259/259,
  `tests/test-scratch-contract.test.ts` 4/4; `pnpm test` all three stages PASS (unit 6985 tests, 6913 pass, 0 fail,
  72 skipped); `pnpm -s typecheck` 0 diagnostics; `node scripts/verify-package-files.mjs` passed (215 files). Known
  residual: the instructions transport dir `gentle-pi-subagent-<agent>-*` the runner creates under TMPDIR is not kept
  by `clean` (unchanged by S9).
