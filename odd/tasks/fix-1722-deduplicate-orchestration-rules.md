# Skip duplicate gentle-ai orchestration blocks from ancestor AGENTS.md (#1722)

## Objective and scope
When a user has `~/AGENTS.md` (or an ancestor `AGENTS.md`) written by gentle-ai, gentle-shell loads the orchestration rules twice:
1. From gentle-shell's own injected harness (`appendSystemPrompt` in `extensions/gentle-ai.ts` containing `## el Gentleman Identity and Harness` and `# el Gentleman Orchestrator`).
2. From ancestor `AGENTS.md` loaded into Pi's `systemPromptOptions.contextFiles`.

This causes:
- ~15,000 extra input tokens on every request, defeating the 8,192 B core budget.
- Potential canon divergence between old gentle-ai managed blocks and gentle-shell's injected orchestrator.

Scope of fix:
1. In `systemPromptOptions.contextFiles`, identify ancestor context files (e.g. `$HOME/AGENTS.md` or any context file in an ancestor directory above `cwd`).
2. Filter out duplicate `gentle-ai` managed blocks (`orchestrator`, `sdd-orchestrator`, `sdd-model-assignments`, `agent-routing`, `engram-protocol`, `remote-authorization`, `codegraph-guidance`) from ancestor context files while preserving all unmanaged project text byte-for-byte.
3. Ensure orchestrator-only managed blocks (`ORCHESTRATOR_ONLY_MANAGED_BLOCKS`) are filtered from any context file in gentle-shell sessions, so only gentle-shell's orchestrator prompt is delivered.
4. If a context file becomes empty after filtering, omit it from `contextFiles`.
5. Wire the filtering into `before_agent_start` in `extensions/gentle-ai.ts` for primary sessions.

## Tasks
- [x] T1: Strict TDD tests in `tests/child-context-files.test.ts` and `tests/append-system-prompt-route.test.ts` reproducing duplicate rules and verifying ancestor context file filtering.
- [x] T2: Extend `lib/child-context-files.ts` with ancestor file detection and generalized managed block filtering.
- [x] T3: Hook session context file filtering into `before_agent_start` in `extensions/gentle-ai.ts` before appending the orchestrator prompt.
- [x] T4: Verify with test suite, typecheck, package checks, and update task evidence.

## Evidence
Base: upstream/main at 9f597f27. Branch: fix/1722-deduplicate-orchestration-rules.
- TDD RED: SyntaxError / missing export and assertion failures reproduced.
- TDD GREEN:
  - 22/22 passed in `tests/child-context-files.test.ts`
  - 5/5 passed in `tests/append-system-prompt-route.test.ts`
  - 33/33 passed in `tests/orchestrator-budget.test.ts`
  - 78/78 passed across related prompt & context suites
- Typecheck: 186 recorded diagnostics, 0 regressions.
- Runtime modules check: matched TypeScript sources.
- Provider contract mirror check: passed.
