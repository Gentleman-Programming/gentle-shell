# Session scratch review advisories

Objective: fix the non-blocking findings the native reviews of gentle-shell#2300 (session scratch and artifact ledger,
merged as `d79265b99`) left, where each is a real defect reproducible through the public interface. Branch
`fix/scratch-review-advisories` from origin/main `d79265b99`. Runner: `pnpm test`.

## Specs

- S1 (user, verbatim): "arregla 3 y luego sigue oor 1, pr con size exception y borra el worktree" — item 3 was "Las
  advertencias de las reviews sobre el scratch. Las principales: al cerrar la sesión se borran los `TMPDIR` de
  subagentes en cuarentena; si el sistema reusa el número de proceso, una sesión muerta puede parecer viva; y borrar
  un clone puede dejar huérfanos sus worktrees vinculados."
- S2 Quarantined subagent TMPDIR (findings R1-shutdown-removes-nested-subagent-tmpdirs, R3-quarantined-subagent-tmp-removed,
  extensions/session-scratch.ts ~100-111, lib/agents-runner.ts quarantine at ~992): on session shutdown, and in
  `/gentle:scratch clean` for the live session, a subagent TMPDIR (`gaXXXXXX`) under the session scratch whose child is
  still running or quarantined (exit unconfirmed) is kept, not deleted; the rest of the scratch is removed. When anything
  is kept at shutdown, the ledger keeps the scratch entry so a later startup sweep (owning process dead, past grace)
  removes it. The runner must expose (or the extension must learn) which `ga*` dirs belong to live or quarantined
  children; choose the smallest mechanism, for example the runner reporting its live scratch dirs through the existing
  agents extension state or `pi.events`.
- S3 PID reuse (R3-pid-reuse-liveness, extensions/session-scratch.ts ~118): a ledger counts as live only when its pid is
  alive AND that process started at the time the ledger recorded (`processStartedAt`, within a tolerance of a few
  seconds). Read the process start time portably: Linux `/proc/<pid>/stat` field 22 with the boot time and clock ticks,
  macOS/BSD `ps -o lstart= -p <pid>`, Windows skip the start-time check (pid liveness only). If the start time cannot be
  read, treat the ledger as live (fail safe: never remove). Test with an injected start-time reader.
- S4 Linked worktrees of a clone (R1-clone-removal-orphans-linked-worktrees, lib/session-scratch.ts ~360-365): a recorded
  clone whose repository has linked worktrees (`git worktree list --porcelain` shows more than the main one, ignoring
  prunable ones) is kept with reason "has linked worktrees".
- S5 Clean empties the live TMPDIR (R3-clean-empties-live-tmpdir, R1-clean-empties-live-session-temp-entries,
  extensions/session-scratch.ts ~273, lib/session-scratch.ts ~200-206): `/gentle:scratch clean` on the live session
  removes only entries older than the moment the command started minus 60 seconds and never removes `ga*` dirs of live
  or quarantined children (S2); entries a running command may be using right now stay.
- S6 Reload fallback (R3-reload-fallback-inherits-scratch, extensions/session-scratch.ts ~147-151): when reload cannot
  recover the live scratch from the ledger, the fallback must not treat the current `TMPDIR` (which may point at the old
  scratch) as the inherited one; it uses the ledger's recorded `inherited` value when present, else the current TMPDIR
  only if it is not a `gp*` scratch dir.
- S7 Unchanged: everything else, including all existing refusals; prove the touched features' previous cases still hold.
  Docs in docs/readme-reference.md describe the new rules.

## Tasks

| ID | Specs | Work | Route | Status |
|---|---|---|---|---|
| T1 | S1-S7 | fixes with tests | delegated (context backstop) | done (uncommitted; L2-L8) |

## Log

- L1 (user, 2026-10-16): request in S1. The PR uses the `size:exception` label at the user's explicit instruction.
- L2 (T1, S2): mechanism is a per-process registry on `globalThis` (`Symbol.for("gentle-pi.live-subagent-scratch")`) in
  lib/session-scratch.ts: the runner holds a `ga*` dir from `mkdtemp` until it removes it (spawn failure, or
  `cleanupLive`, which keeps a quarantined child's dir until its exit is proven). `pi.events` was rejected:
  extensions/gentle-agents.ts unsubscribes its listeners at `session_shutdown`, handler order is not guaranteed, and a
  runner of a module instance from before a /reload may still hold a quarantined child. Shutdown now keeps held dirs,
  removes the rest of the scratch, and leaves `scratchDir` in the ledger for the sweep; extensions/gentle-agents.ts is
  unchanged. The `/gentle:scratch clean` half was already met (contents-only removal keeps every `ga*` entry, covered by
  "S6: clean removes scratch without asking..."). RED: "advisories S2: session shutdown keeps a running or quarantined
  subagent's TMPDIR..." failed with "a quarantined child's TMPDIR stays"; GREEN after the change.
- L3 (T1, S3): `processStartTime(pid, platform)` reads Linux `/proc/<pid>/stat` field 22 with `btime` and
  `getconf CLK_TCK`, macOS/BSD `ps -o lstart=` (LC_ALL=C), and returns undefined on Windows or any failure. A ledger is
  live when its pid is alive and the start time is unreadable or within `PROCESS_START_TOLERANCE_MS` (5 s) of
  `processStartedAt`; used by the sweep, `heldBy`, the replaced-session removal, and `endedLedgers`. RED: "advisories S3:
  a ledger counts as live only when..." failed with "a reused pid started an hour later...", and "...read from the OS,
  and skipped on Windows" failed with "exports processStartTime"; GREEN after. Existing tests with real `process.pid`
  ledgers still pass, so the real Linux reader agrees with `processStartedAt`.
- L4 (T1, S4): `checkArtifact` keeps a clone when `git worktree list --porcelain` shows more than one non-prunable
  entry ("has linked worktrees"), and when the list fails or is empty ("Git worktrees unavailable"). RED: "advisories
  S4: clean keeps a recorded clone with linked worktrees..." failed with "nothing is offered for removal"; GREEN after,
  including the prunable control.
- L5 (T1, S5): clean takes `now() - 60 s` before anything else, and for the live scratch keeps every entry whose
  newest mtime or ctime anywhere inside it (no symlinks followed, at most 200,000 entries, unreadable counts as
  recent) is at or after it. ctime is counted so files extracted with old mtimes stay. RED: "advisories S5: clean keeps
  the live scratch's entries changed within the minute..." failed with "an entry changed 30 s before clean stays";
  GREEN after. Two previous tests that expected instant emptying ("S6: clean removes scratch without asking..." and
  "S6: a declined confirmation...") now inject a clock two minutes ahead; their other assertions are unchanged.
- L6 (T1, S6): on a reload that does not recover the scratch, the inherited values come from this process's ledger
  (`pid` equal to this process), else from the current variables, except that a `gpXXXXXX` value counts as its
  parent directory (the directory the scratch was made in, as TMPDIR keeps the inherited spelling). The decision for
  that "else" branch is the parent rather than unset: it keeps the original temp root, also for a Pi nested in another
  session. Startup (not reload) still inherits a `gpXXXXXX` TMPDIR as it is (control in the test). The inherited values
  are written back to the environment before `tmpdir()` is asked, so an inherited unset TMPDIR no longer resolves to the
  old scratch. RED: "...restores the ledger's inherited TMPDIR" failed with ENOENT (no scratch created, ledger
  deleted), "...never inherits a gpXXXXXX TMPDIR" with "the new scratch is not nested in the old one", and "...recorded
  TMPDIR unset..." (with the write-back disabled) with ENOENT; all GREEN after.
- L7 (T1, S7): docs/readme-reference.md describes the five rules; "advisories S7: the reference documents the advisory
  rules" failed first with "missing live or quarantined subagent", GREEN after. All previous session-scratch tests pass,
  and the existing S8 docs terms are still present.
- L8 (T1, verification): `node --experimental-strip-types --test` on tests/session-scratch.test.ts 43/43 and
  tests/agents-runner.test.ts 100/100; `pnpm test` all stages passed (unit 7013 tests, 6941 pass, 0 fail, 72 skipped;
  provider-contract and runtime-harness PASS); `pnpm -s typecheck` no regressions; `node scripts/verify-package-files.mjs`
  passed. Note: a test that drives `process.env` must clear `GENTLE_PI_AGENTS_CHILD`, since the runner may itself run
  inside a subagent, where the extension registers nothing.
- L9 (parent, 2026-10-16): native review `review-e6f96fb8f1a7b6c5` of 9f4040bcb approved and acknowledged with 9 non-blocking
  findings. Fixed the consequential one in a follow-up commit: R1-start-time-mismatch-deletes-live-scratch (with
  R3/R4 linux-btime-shifts-with-clock-steps, R3 macos-lstart-local-time-parse, R3 getconf-failure-not-cached) — the
  wall-clock reconstruction of the start time could make a live session look ended after a clock step, and then
  another session's sweep would remove its scratch. Now the ledger records `processStartToken` (Linux `/proc/<pid>/stat`
  start ticks, macOS/BSD raw `ps -o lstart=` text with LC_ALL=C TZ=UTC) and liveness compares tokens for equality;
  a missing or unreadable token keeps the ledger live (old ledgers keep pid liveness). RED: "advisories S3: a ledger
  counts as live only when its pid has the start token..." failed ("a reused pid has another start token...") and
  "...start token is read from the OS..." failed ("exports processStartToken"). GREEN: session-scratch + agents-runner
  144/144, typecheck 0 diagnostics. Remaining advisories (clean walks held entries before cheap keep checks, git
  version for linked worktree porcelain, ps spawned per ledger on macOS) stay as follow-ups.
