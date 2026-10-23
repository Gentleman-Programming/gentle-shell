# AGENTS.md — working conventions for every agent in this repository

Gentle Shell is the packaged desktop Shell: a Pi-based TUI daemon for the
Gentleman ecosystem. Every agent — human-driven, delegated, or autonomous —
working in this repository follows the same discipline. Read this file before
the first action; re-read it before reporting status.

## The one rule that governs all others

**Never report test or verification status you did not run in this session.**
Pasted transcripts, remembered runs, and "should pass" reasoning are not
evidence. Run the suite, paste the real output, name the exact commands.

History: agents in this ecosystem have reported "all tests pass" with the
package not compiling, and fabricated transcripts with passing counts. The
rule exists because of real incidents.

## Verification commands

- Full suite: `pnpm test`
- Single file: `node --test tests/<file>.test.ts`
- Runtime modules: `pnpm check:runtime-modules`

Some tests are environment-dependent (Windows/WSL paths, network reachability,
npm-driven installs). A failure that reproduces on a clean checkout of
upstream `main` is environment, not regression — say so explicitly, with the
clean-checkout evidence, instead of fixing blindly.

## Organic Driven Development

- Substantial work gets an ODD task document under `odd/tasks/`. The repo
  convention is issue-numbered file names when the work tracks an issue
  (`2256-review-host-relay.md` style), with lettered log entries (L1, L2…)
  per work session.
- Task documents carry: the goal, the slices, the evidence per slice, the
  open questions, and the permanent rules learned. Update them as the work
  moves; they are the resume point after any interruption.
- Permanent rules learned the hard way get recorded in the task document as
  binding rules (see the L3/L4 pattern in this repo's ODD history).

## Work-unit commits

- One logical change per commit; tests travel with the code they cover.
- Conventional Commits: `fix(scope): ...`, `feat(scope): ...`, `docs: ...`.
- Never mix unrelated changes in one commit. Reviewers reject mixed branches:
  a retry PR that also carried desktop shortcut changes, external-link
  behavior and a Fedora setup script was demanded split three ways.

## Upstream coordination — the replicable formula

Issues reported with experiments get fixed the same week. Issue #2256 closed
the full circle: report with experiments → confirmatory re-test → the
maintainer's surgical fix (11 lines) → verification on the original
reproduction machine → public confirmation → closed by the maintainer.

The formula:

1. Reproduce with the exact failing test names and the dates.
2. State the conditions explicitly (outside CI, after an upgrade, platform).
3. Re-test confirmatorily when the maintainer asks or ships a fix.
4. Verify on the original reproduction machine after the fix lands.
5. Confirm publicly, naming the maintainer's fix.

CodeRabbit reviews every PR. Resolve its minors or explain why not; the
maintainers (decode2, Alan) iterate fast and merge clean branches only — a
branch that also drags unrelated commits buries its own fix.

## Linear work

- Project tracking lives in Linear (workspace `bladimir-parra-lordastaroth`).
- The CLI: `linear` (brew). Configure the default team once: `linear config`.
- Issue-first: the work tracks an issue; the PR references it; the status
  updates carry evidence — commit hashes, test runs, PR links.
- A status without evidence is a claim, not an update.

## Credentials and environment

- Credentials never travel through chat, issues, PRs, or commits. An env dump
  pasted into a chat leaks every key it carries.
- The secrets live in `~/.env` (sourced by `.zshenv`) or the app vaults;
  reference them by name, never by value.
- Pasting through chat rewrites product names, eats spaces adjacent to `.`,
  and strips underscores from `__pycache__`-style tokens — re-derive exact
  strings from intent, never from a paste.

## Engram memory rule

Children save observations; the host ends the session. An agent working in
this repo saves its discoveries (bug fixes, decisions, patterns) before
returning, and never calls mem_session_end.

## The skills this repo ships

`skills/` carries the shared skill family (branch-pr, chained-pr,
cognitive-doc-design, comment-writer, issue-creation, judgment-day…). Use
them — they encode the same conventions this file states, at the workflow
level.
