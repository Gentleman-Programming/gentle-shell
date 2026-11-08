# Dynamic MCP capability expansion for subagents on Pi 1.0 (#1686)

## Objective and scope
Restore MCP server access for Gentle child agents running on Pi 1.0 native MCP. Because `pi-mcp-adapter` was retired and `--tools` in Pi 1.0 is a strict filter without glob support, child agents with `tools: ... mcp` lose access to all MCP tools.
Treat `mcp` in agent frontmatter as a runtime capability sentinel:
1. Dynamically expand `mcp` into `codemode`, `tool_search`, and all active `mcp__*` tools from the parent session (`request.mcpTools`).
2. Drop the retired literal `"mcp"` token from the child's `--tools` CLI arguments.
3. Support server-scoped tokens (`mcp__<server>`) expanding to tools matching `mcp__<server>__*`.
4. Preserve strict isolation for agents without `mcp` in their frontmatter.

## Completed tasks
- [x] T1: Strict TDD test reproducing lack of MCP expansion in `childArguments`.
- [x] T2: Implement `expandChildTools` in `lib/agents-runner.ts` and wire it into `childArguments`.
- [x] T3: Add `mcpTools` to `TaskRequest` in `lib/agents-runner.ts` and populate it from `pi.getAllTools()` in `extensions/gentle-agents.ts`.
- [x] T4: Verify with unit tests in `tests/agents-runner.test.ts` and `tests/gentle-agents.test.ts`, plus typecheck and package checks.
- [x] T5: Code review follow-up: omit `codemode` and `tool_search` when scoped `mcp__<server>` matches no active tools, and verify generic `mcp` expansion with empty tool list.

## Evidence
Base: upstream/main at cf3012f7. Branch: fix/1686-child-agents-native-mcp-allowlist.
- TDD RED: 2 failed / 1 passed in `tests/agents-runner.test.ts`.
- TDD GREEN: 89/89 passed in `tests/agents-runner.test.ts`.
- Agents extension suite: 190/190 passed in `tests/gentle-agents.test.ts`.
- Review follow-up: 91/91 passed in `tests/agents-runner.test.ts` (TDD RED: 1 failed / 90 passed, TDD GREEN: 91/91 passed).
- Typecheck: 186 recorded baseline diagnostics, 0 regressions, 12 improved.
- Package integrity: 155 files, 69 exact byte-pinned artifacts checked.
