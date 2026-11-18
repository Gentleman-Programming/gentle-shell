# Feature: CodeGraph daemon-unavailable CLI fallback

When the CodeGraph daemon cannot serve a query/explore (never started, died,
hung, or has no project loaded), the tool currently returns "The CodeGraph
daemon is unavailable, so the search could not run" and every search of the
session degrades to read/grep/find. The search must still run through the CLI
as a last resort.

## Specs

- S1: "include to fix this: The CodeGraph daemon is unavailable" — after the
  two daemon attempts (with the warm-up between them) fail, the tool runs the
  same fixed query/explore command through the CLI once and returns its output
  instead of the daemon-unavailable message.
- S2: "not in the commit" — this behavior change is its own work unit, not
  part of the AGENTS.md docs commit (efae243).
- S3: The daemon stays the only path while it answers: a healthy daemon never
  spawns a CLI process (pinned by the existing test).
- S4: When the daemon cannot serve AND the CLI fails, the existing failure
  messaging applies ("CodeGraph failed to run" / "codegraph binary was not
  found"), with `status` details, so the daemon-specific message disappears.

## Tasks

- T1 (S1, S3, S4): RED tests — daemon `unavailable`/`timeout` with a working
  CLI returns the CLI output with `viaDaemon: false`; daemon ok never spawns
  the CLI (existing pin); daemon down + CLI throws reports the standard
  failure; rewrite the two tests that pinned the no-fallback behavior. Route:
  inline. Commit: this work unit. DONE — RED observed on exactly the 4
  target tests, all others green.
- T2 (S1): implement the last-resort CLI fallback in
  `extensions/codegraph-tools.ts` `execute` (non-init branch), then GREEN,
  typecheck, full codegraph test files. Route: inline. Commit: this work
  unit. DONE — 33/33 codegraph-tools, 19/19 codegraph-readiness, 4/4
  codegraph-daemon, tsc zero errors in codegraph files (16 pre-existing
  unrelated elsewhere). Init path untouched; existing init pins still pass.

## Log

- L1: "commit first then go" + "include to fix this: The CodeGraph daemon is
  unavailable" + "not in the commit" (user, 2026-11-13 session). Plan approved
  via structured question ("Approve and start", "Group A only"), then the
  daemon fix was added to scope by the user.
- L2: RED observed on the 4 target tests (tmp/ga-red-fallback.txt); spliced
  implementation (tmp/ga-splice-fallback.mjs, byte-dump first — the read
  display under-rendered one indent level); GREEN 33/33 + 19/19 + 4/4; tsc
  codegraph errors 0. Risk: none (behavior pinned both paths; init untouched).
- L3: Work unit committed as f3c9c80. Independent verification
  (gentle-ai-verify, 2026-11-13): S1 PASS, S2-S4 PASS, no blockers; test
  counts reproduced; native assess risk medium, writer self-verification
  stands (no review due). CLOSED.
