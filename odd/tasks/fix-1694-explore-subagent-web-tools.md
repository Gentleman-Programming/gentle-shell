# Task Breakdown: Fix #1694 Add Read-Only Web/Doc Tools to gentle-ai-explore for ODD Research

**Feature:** `fix-1694-explore-subagent-web-tools`  
**Issue:** #1694 (`bug(odd): gentle-ai-explore has no web tools, so delegated research is blocked and falls back to the parent`)  
**Strategy:** Strict TDD, ODD workflow, Conventional Commits  

---

## Tasks

### 1. Test (RED): Unit tests expecting web_search and fetch_content in gentle-ai-explore
- [ ] Update assertions in:
  - `tests/generic-agent-tools.test.ts`
  - `tests/package-manifest.test.ts`
  - `tests/runtime-harness.mjs`
  to expect `web_search` and `fetch_content` as part of `gentle-ai-explore.md`'s allowed read-only inspection tools.
- [ ] Evidence: Red test failure before updating `assets/agents/gentle-ai-explore.md`.

### 2. Implementation (GREEN): Update gentle-ai-explore.md with web tools
- [ ] In `assets/agents/gentle-ai-explore.md`:
  - Add `web_search` and `fetch_content` to `tools:`.
  - Add instruction guidance for external documentation/web research when web tools are available.
- [ ] Evidence: Green test pass.

### 3. Verification & Regressions
- [ ] Run targeted test suites (`node --test tests/generic-agent-tools.test.ts`, `tests/package-manifest.test.ts`, `node tests/runtime-harness.mjs`).
- [ ] Run full test suite (`pnpm test`), package verification, and typecheck (`pnpm typecheck`).
- [ ] Evidence: 0 regressions, all tests green.

### 4. Work-Unit Commit
- [ ] Create conventional commit: `fix(odd): add read-only web tools to gentle-ai-explore agent (#1694)`.
