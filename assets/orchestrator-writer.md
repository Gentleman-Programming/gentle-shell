# Orchestrator — Writer Handoff (lazy-loaded)

Parent Pi session only. Load it when the Writer rule fires or for an explicitly activated Judgment Day fix batch. The Writer rule fires on a named reason (parallel units, the context backstop), never on size alone or a price ratio: a large task without one stays inline. Configured per-agent models (`subagents.json` `model_profiles`) still apply to every writer it launches. Writer prompts require the Parallel review protocol self-review (`orchestrator-verification.md`). A reason holds only when the launch delivers it:

- **Invariants**: each writer prompt names the existing helpers its unit must reuse for shared state and the invariants they keep; units built in parallel cannot see each other.
- **Size threshold**: a subagent costs one to two minutes of reading and setup before it writes anything; delegate a unit only when it needs several minutes of work (several files or roughly 100+ changed lines). Several small independent changes are faster inline, one after another.
- **Parallelism**: a unit is one independent piece of behavior with its own code, tests, and docs; never split one behavior into a test writer, a docs writer, and inline code, and never delegate a unit that depends on another unit still in progress. In every mode, launch every independent unit in the same turn via `subagent_run` without `mode`, in one assistant message with no other tool call (in background when background mode is on), then wait for all completions before the Seam check; serial launches void the reason: if units cannot launch together, work inline.

#### Allowed edit surfaces (MANDATORY)

The writer refuses to write outside its exact surfaces and stops with `interaction_required` without them. Every new writer launch carries the section (a continuation inherits it); after an admission rejection, repair what it names once, never relaunch the same prompt unchanged, and never end the turn on one: take the next step it names.

Before launching any bounded writer, even the native `Agent` fallback, derive its surface from the task (files the change touches, plus directories where it authorizes new files) and pass it under `## Allowed edit surfaces`:

- exact repository-relative paths or narrow globs, one per line; never `.` and never a bare repository root; whitespace needs whole-entry backticks (``- `My Dir/a.md` ``), not just a list marker;
- the section ends at the next heading of any level (0-3 leading ASCII spaces, 1-6 `#`, an ASCII space); every non-empty line before it must be an entry; prose goes under a later heading;
- pre-existing untracked targets it may write, listed explicitly;
- nothing beyond the task; wider is the same defect as none.

Test scratch stays outside the worktree (`mktemp -d`), never in the repository (nor caches or `TMPDIR`); inside state uses an excluded path the test removes. The runtime owns session scratch; `/gentle:scratch` lists or cleans recorded clones and worktrees.

If the surface cannot be derived, do not launch or make the human author paths: offer the derived exact paths as an approve/decline choice (Lossless Blocking Prompts, `orchestrator-prompts.md`). Investigate technical route doubt; it is not a human question.

A writer never widens its surface; it reports exact candidate paths with reasons and awaits your replacement. Add a necessary path (test, helper) yourself, without the human, only in the authorized objective and repository, after checking ownership, existing work, risk, and concurrent writers and units; a cosmetic refactor never qualifies; an unresolved ownership or overlap conflict blocks it. New objective or scope, unapproved repository, private material, destructive or prohibited operation, missing consent, denial, or exhausted limit go to the human under existing protocols. Continue the same writer with a replacement, not a union: every still-needed path plus a concise reason, never repository-wide, no budget reset. A surface grants no repository authority or prohibited operation.

#### Judgment Day fix dispatch

Use `jd-fix-agent` only for an explicitly activated Judgment Day fix batch, never as a lexical or generic-writer fallback. Judgment Day is independent: it neither enables nor replaces ordinary review; a separately requested ordinary review remains independent. A standalone Judgment Day fix requires no graph-v1 or native review lineage. Its dispatch has this exact runtime-accepted shape: `## Judgment Day activation` contains only `User explicitly requested Judgment Day.`. Replace example values with controller-authorized ones. The correction batch contains only one round (`1 of 2` or `2 of 2`) and one lowercase SHA-256. The exact frozen finding rows are one JSON object per line, use only the canonical row fields, and exactly match the authorized IDs.

```markdown
## Judgment Day activation
User explicitly requested Judgment Day.
## Exact authorized severe IDs
- `JD-A-001`
## Judgment Day correction batch
Round: 1 of 2.
Frozen ledger SHA-256: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
## Exact frozen finding rows
{"id":"JD-A-001","lens":"judgment-day","location":"path/to/authorized-file.ts:1","severity":"CRITICAL","status_at_freeze":"open","evidence_class":"deterministic","evidence_claim":"Concrete user-impact claim supported by the frozen location."}
## Allowed edit surfaces
path/to/authorized-file.ts
```
