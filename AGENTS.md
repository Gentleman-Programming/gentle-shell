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

- Substantial work gets an ODD task document under `odd/tasks/`. Both file
  name styles are accepted: issue-numbered for work tracking a single issue
  (`2256-review-host-relay.md` style), and a short feature name when one
  document spans several related issues (`upstream-contrib-oct.md`), with
  lettered log entries (L1, L2…) per work session.
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

Issues reported with experiments get fixed the same week. Issue #2256 (now
closed) ran the full circle: report with experiments → confirmatory re-test →
the maintainer's surgical fix (11 lines) → verification on the original
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

## Codegraph comes first

Codegraph comes first: for every show, what, where, plan, refactor, code fix, analysis or investigation that needs symbol, structure or call-path discovery, run a codegraph query or explore BEFORE any read/fd/find/rg/grep search whenever the workspace has a .codegraph index. For every refactor, code fix, analysis or investigation, codegraph also precedes any rg/grep symbol search. rg/grep are for exact-string and filename lookups, or when codegraph fails or the index could not be initialized.

- Trust by calling, not by checking: never probe for `.codegraph/` or daemon state before the first codegraph call — file tools are gitignore-blind there and liveness is unknowable in advance. The codegraph tool answers on its own (daemon, then CLI fallback) and is bounded; only its own unavailability message is the signal to fall back to read/grep/find.
- Search-tool gate: codegraph gates the search tools — the session's first fd/find/rg/grep search must come after a codegraph query or explore, and once codegraph has been used, fd/find/rg/grep may be used freely within that investigation for any further search (exact-string, filename, or symbol). The session's first query is the minimum requirement, not a standing credit: it does not satisfy later investigations — each new investigation that needs symbol discovery opens with its own query or explore before its searches.
- Memory ordering: in a workspace with a .codegraph index, codegraph gates memory reads in a prompt that searches the workspace — a search-tool call (grep, find or ls) or a bash command naming rg, grep, fd, find, ag or ack — and two further blocks apply with or without any workspace search: a memory read is refused while any codegraph call is in flight, and a memory read is refused when the same assistant turn's tool batch also lists a codegraph query or explore (a batch's admitted calls run concurrently, so their order cannot satisfy the rule). In such a prompt, codegraph calls of the same step may run in parallel with each other, but every planned codegraph query or explore must have returned before any memory read, and a memory call is never issued in the same parallel block as a codegraph call; then, when memory tools are available, run mem_context and at least one task-scoped mem_search before proceeding further, even when codegraph failed or no index could be initialized. A memory-only prompt — no workspace search, no codegraph call in the same turn or in flight — is not gated.
- Post-compaction revalidation: after compaction or workspace changes, recover target, actor access, and preparation status before using graph evidence; history alone authorizes no init/sync.
- Index hygiene: keep .codegraph/ out of the change — the runtime maintains the local git exclude (including linked worktrees) and the index ships its own .gitignore; never commit index files or hand-edit the exclude.
- Fallback: if codegraph fails or the index could not be initialized, fall back to fd/find/rg/grep directly, and any search that ran without a preceding codegraph call names the skip reason in one line in the final report.
- Staleness: current source prevails over conflicting graph output — inspect the relevant stale files directly, or task-relevant source if the whole index is stale; graph output never replaces tests, compilers, linters, or runtime checks.
- Anti-redundancy: source returned by the graph counts as inspected; do not repeat reads or searches merely to confirm symbols when the required evidence is already present.
- Wrong-project guard: before trusting query/explore -p results for a path whose index you have not verified, run "codegraph status `<path>`" and assert its "Project:" line names that path — codegraph silently answers from the current project (exit 0) when the -p target has no .codegraph index, so the failure fallback never fires and wrong-project hits look identical to correct ones.
- Worktrees: codegraph is workspace-scoped; a linked worktree without an index is seeded from the main checkout by the runtime at session start (copy + sync, init as the fallback), so a session never initializes one by hand — it only states in its report when no symbol search was available. Worktree commands run through the CLI with explicit path args: init/index/sync/unlock/status take a positional path and query/explore take -p, so no cd is needed.
- Subagents: a subagent that can call codegraph does so itself, and for a worktree dispatch it does so via the CLI path args because session-bound codegraph tools answer from the subagent cwd and not the dispatched worktree; when it cannot, the parent session runs the query BEFORE dispatching the subagent and embeds the findings in the task handoff, and a subagent result that claims codegraph verification must quote the query it ran or cite the parent-provided findings, otherwise the claim is treated as not performed.
- Truncation fallback (MCP variant): a middle-cut mcp__codegraph__* result — one carrying "Warning: truncated output" or "…N chars truncated…" — is never worked from: re-run the same query through the native session codegraph tool (daemon path, unaffected by the 20 KB MCP cap) or read the result's [Full output: …] file with offset/limit; use the native tool when the whole report matters, the file when only a slice is missing.
