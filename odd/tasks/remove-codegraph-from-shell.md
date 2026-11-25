Remove the native CodeGraph integration from gentle-shell. CodeGraph stays an optional third-party tool that gentle-ai installs and exposes to Pi through its own MCP configuration (`gentle-ai/internal/agents/pi/adapter.go:119-187`, "intentionally contains no gentle-pi path").
Branch `refactor/remove-codegraph-from-shell` from main `c11318f9d`.

## Specs

S1. User request, verbatim: "te digo algo no quiero codegraph en gentle shell, que eso lo instala gentle ai como opcional como ya lo hace, porque no queremos dependencias de terceros en gentle shell"

S2. gentle-shell ships no CodeGraph runtime: no `codegraph` tool, daemon, leases, readiness, worktree seeding, index sync/init, git-exclude maintenance, MCP exposure, or CodeGraph-first gate. Deleting `extensions/codegraph-*.ts` unloads them, because `package.json` loads the whole `./extensions` directory.

S3. A user who chose CodeGraph in gentle-ai keeps it through MCP. MCP-named CodeGraph tools (`mcp__codegraph__*`) still count as exploration in `lib/exploration-budget.ts` and still infer the `exploring` phase in `lib/odd-phase-inference.ts`. Only native-tool names are removed.

S4. Shipped prompts and docs stop instructing agents to use a native `codegraph` tool or to obey CodeGraph-first ordering:
- the `AGENTS.md` "Codegraph comes first" section;
- `assets/agents/*.md`, `assets/orchestrator-full-delegation.md`;
- `docs/*.md`, `skills/rdd-defect-workflow/SKILL.md`.

  Docs may say once that CodeGraph is optional and comes from gentle-ai via MCP.

S5. No data migration. The daemon, lease, seeding, gate and MCP-exposure PRs (#3305, #3306, #3307, #3308, #3312) were never released; the last tag, v5.0.0, predates them.

S6. Unrelated behavior is unchanged:
- remove only CodeGraph-specific tests and cases;
- prompt-budget and golden tests may only shrink;
- never weaken unrelated assertions.

  Historical `odd/tasks/*.md` and `design/**` files stay as they are. The repository `.gitignore` entry for `.codegraph/` stays, as harmless hygiene for contributors who use gentle-ai's optional CodeGraph.

## Tasks

- T1 (S2, S3, S5, S6) Delete the native runtime and its tests; update `child-context.ts`, `exploration-budget.ts`, `odd-phase-inference.ts` and every test that referenced them. Route: gentle-ai-worker. Commit: `refactor(codegraph): remove the native CodeGraph runtime from gentle-shell`.
- T2 (S4, S6) Remove CodeGraph guidance from shipped prompts, `AGENTS.md`, docs and the skill; update the prompt/budget tests. Route: same worker. Commit: `docs(codegraph): drop native CodeGraph guidance; it comes from gentle-ai`.

## Log

L1. "te digo algo no quiero codegraph en gentle shell, que eso lo instala gentle ai como opcional como ya lo hace, porque no queremos dependencias de terceros en gentle shell"
L2. Context: the user was alarmed that five CodeGraph PRs by @carolitascl (#3305–#3308, #3312; ~11.1k lines) were merged by @barbatdev with no human approval. Four more CodeGraph PRs by the same author are open: #3432, #3394, #3382, #3315.
L3. Evidence: gentle-ai already wires CodeGraph into Pi via MCP (`internal/agents/pi/adapter.go:119-187`). Only `extensions/child-context.ts` imports the native tool; `lib/exploration-budget.ts` and `lib/odd-phase-inference.ts` reference tool names only.
