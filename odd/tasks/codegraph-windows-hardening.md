# CodeGraph Windows hardening — port 5 items from gentle-shell-codegraph-subagents

Ports the five Windows-relevant items selected from the external package
(/Users/admin/Dev/github/gentle-shell-codegraph-subagents) into gentle-shell's
codegraph runtime, on branch `codegraph`. Evidence and plan:
tmp/codegap-windows-port-findings.md, tmp/codegap-windows-port-plan.md.

## Specs

- S1 (canonical key): one directory in any spelling (win32 drive-letter case,
  trailing separators, mapped-drive vs UNC) = one daemon entry AND one lock
  token per kind. Ported shape: `canonicalRoot` (fold+unfold,
  realpathSync.native first, nearest-resolvable-parent fallback, never throws).
- S2 (writer-lock consult): a live CodeGraph writer (`<cwd>/.codegraph/codegraph.lock`
  pid alive, EPERM counts alive) flips a would-be stale lease verdict back to
  held and gates the daemon-less unlock+sync paths (busy = skip, report ok).
- S3 (proxy pid): the win32 shelled spawn's pid is adopted as `{proxy:true}`
  writer pid; a dead holder within a 60s trust window (and any live
  codegraph.lock) keeps the lease held; after that it is stale.
- S4 (seed hardening): seeding never copies a busy main index (new `main-busy`
  outcome, benign like target-exists, NOT deferred/fail-closed); copy/rename
  retry transient EPERM/EBUSY/EACCES; staged `.seeding` files are cleaned when
  placement throws (return `seed-failed`, no raw throw).
- S5 (windowsHide): the taskkill execFile sets `windowsHide: true`, matching
  every other codegraph spawn site.

User verbatim: "investigate how to add this 5 items" (investigation delivered:
tmp/codegap-windows-port-plan.md); authorization: structured approval
"Approve all 5 (Recommended)" — full port, 3 work-unit commits on branch
codegraph, tracked feature.

## Tasks

- T1 (S1): new lib/codegraph-canonical.ts; lockPathFor hashes canonicalRoot;
  daemon.ts canonical swapped to it; tests (injected "win32"). Commit A.
  DONE — d35065a (3 canonical + 12 lease + 6 daemon tests green, untouched suites
  69/69, tsc 0 codegraph errors; RED observed first: module-not-found + ENOENT
  at lockPathFor on missing cwd).
- T2 (S2+S3): codegraphWritingIndex in lease.ts; readLeaseVerdict stale-flip;
  sync gates in prepareReadiness/syncBeforeSearch; runCodegraph onSpawn;
  lock.adopt + writer token fields + 60s window. Commit B.
  DONE — 169ab00 (14 lease + 30 readiness green, RED observed 5 designed
  failures first; untouched suites 51/51; tsc 0 codegraph errors).
- T3 (S4+S5): seed main-busy gate + retryTransient + staged cleanup;
  windowsHide on taskkill. Commit C.
  DONE — 3e89d03 (parent-verified 98/98 across all 6 codegraph suites;
  4 worker deviations signed off: staged hoist, tolerant cleanup rmSync
  (rmSync dir+force throws EISDIR on bun/macOS), between-attempts sleep,
  test sleeps reset; placement order verified unchanged vs HEAD via
  probe worktree).
- T4: independent gentle-ai-verify (Risk: item 4 concurrency), focused suites
  green (bun test tests/codegraph-*.test.ts), tsc no new codegraph errors,
  doc close.
  DONE — verifier S1-S5 ALL PASS + concurrency walk PASS (report
  tmp/codegraph-windows-verify.md; POSIX digest stability proven 9/9 — no
  re-key); advisory fixed in eb164fc (cwd threaded into the init-lock steal
  verdict + POSIX-stability probe test); host suites 115/0. VM battery run
  20261113-202715 (skill vm-testing): linux 192.168.7.38 and windows
  192.168.7.39 — 6/6 suites PASS on both (linux 98 pass 0 fail; windows 98
  pass 0 fail after c5a76af win32 guard on the chmod-000 indexState test,
  rerun 31/0). Feature commits: d35065a, 169ab00, 3e89d03, eb164fc,
  c5a76af on branch codegraph.

## Log

- L1: "investigate in /Users/admin/Dev/github/gentle-shell-codegraph-subagents
  for windows code to include" — investigation, 5 ranked items.
- L2: "investigate how to add this 5 items" — insertion-point map
  (tmp/codegap-windows-port-plan.md).
- L3: structured approval: "Approve all 5 (Recommended)" — implement on branch
  codegraph, 3 work-unit commits, tracked feature.
