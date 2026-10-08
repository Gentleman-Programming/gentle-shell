# Feature: Dynamic Subagent Specialization (DSS) in gentle-pi

## Part 1: Diagnosis & Technical Proposal

### 1.1 Context and Problem
Under Organic Driven Development (ODD), the orchestrator operates under the "Pure Thinker" mandate: parent session context must stay thin (< 20k tokens) by delegating deep code inspections to `gentle-ai-explore` and mutations to `gentle-ai-worker`.
However, existing subagent archetypes in `gentle-pi` are strictly static (`assets/agents/*.md`). Specifically:
- `gentle-ai-explore` is defined with a generic topology-mapping role and static tools (`read`, `grep`, `find`, `codegraph`).
- When a task requires specialized domain discovery (e.g., architectural synthesis for ODD Part 1/Part 2, security auditing, SQL performance, a11y inspection), `gentle-ai-explore` either lacks the domain instructions or the necessary read-only tooling (such as `read_symbol`, `lens_diagnostics`, or web/docs inspection).
- Consequently, the orchestrator is forced to either perform heavy post-processing in the parent thread (violating the context budget) or accept low-fidelity exploration reports.

### 1.2 Proposed Architecture: Subagent Derivation & Specialization Overlay
Instead of creating unconstrained dynamic agents from scratch or bloating the static catalog, `gentle-pi` implements **Dynamic Subagent Specialization (DSS)** by ephemeral derivation:
- The orchestrator targets a base static archetype (`gentle-ai-explore` or `gentle-ai-worker`).
- The dispatch payload in `subagent_run` accepts an optional `specialization` overlay.
- The subagent runner (`lib/agents-runner.ts`) merges the specialization instructions into the child process system prompt and permits authorized read-only tool extensions for read-only archetypes.
- Permissions and sandboxing are strictly monotonic: an explorer subagent can never gain mutation tools (`write`, `edit`, arbitrary bash).
- The specialization is surfaced clearly in the TUI card rendering (`lib/agents-renderer.ts`).

---

## Part 2: Technical Specification & Contracts

### 2.1 Protocol Schema (`lib/agents-protocol.ts` & `extensions/gentle-agents.ts`)
```typescript
export interface SubagentSpecialization {
  /** Concise badge / label for TUI visualization (e.g. "ODD Architect", "SQL Auditor") */
  label?: string;
  /** Domain-specific directives and focus instructions merged into the subagent prompt */
  instructionsOverlay: string;
  /** Controlled extension of read-only tools (whitelisted for read-only bases) */
  extraTools?: string[];
  /** Expected structure or template for the return report */
  outputContract?: string;
}
```

In `subagent_run` parameters:
```typescript
specialization?: SubagentSpecialization;
```

### 2.2 Security & Sandbox Invariants
1. **Read-Only Base Invariant:** If `agent.tools` does not contain `write` or `edit`, `extraTools` may ONLY contain tools from `ALLOWED_READONLY_EXTENSIONS` (`read_symbol`, `read_enclosing`, `lens_diagnostics`, `web_search`, `fetch_content`, `source_check`, `ast_grep_search`, `ast_grep_outline`). Any attempt to inject mutating tools throws a validation error before process spawn.
2. **Ephemeral Lifespan:** Specialization never mutates disk assets (`assets/agents/*.md`) or persistent configuration (`subagents.json`). It lives exclusively in the memory of the spawned RPC child.
3. **Prompt Composition:** The subagent prompt in `agents-runner.ts` appends a clearly demarcated section:
   ```markdown
   ## DYNAMIC SPECIALIZATION OVERLAY (Active for this execution)
   - Specialized Role: {label}
   - Specific Directives: {instructionsOverlay}
   - Output Contract: {outputContract}
   Respect this specialization as your primary lens while strictly adhering to your base constraints.
   ```

### 2.3 UI Visualization (`lib/agents-renderer.ts` & `lib/agents-widget.ts`)
When `task.specialization?.label` is present:
- Render agent badge as: `<agent-name> ▸ [<specialization-label>]` (e.g. `gentle-ai-explore ▸ [ODD Architect]`).

### 2.4 Dispatch Resilience & Cross-Repo Normalization
1. **`workspace_root` Independent Clone Guidance (`lib/session-worktree-registry.ts` & `extensions/gentle-agents.ts`):**
   - When `workspace_root` points to a valid Git repository with a `commonDir` distinct from the parent session's `commonDir`, fail with actionable guidance:
     `Select an existing worktree in the same Git clone as this session. For an independent Git repository, pass repository_root instead of workspace_root.`
2. **In-Repository Absolute Path Normalization (`extensions/gentle-ai.ts`):**
   - In `hasTaskScopedAllowedEditSurfaces` / `rejectUnscopedBoundedWriterDispatch`, resolve the effective target root (`input.repository_root ?? input.workspace_root ?? ctx.cwd`).
   - If an entry in `## Allowed edit surfaces` is an absolute path that resolves strictly inside the target root (without escaping via `..` or targeting root `.`), normalize it in-place to a clean repository-relative path before validating and dispatching.
   - Any absolute path outside the target root (`/etc/passwd`, `C:\outside.ts`, `/tmp/...`) continues to fail closed immediately.

---

## Part 3: Tasks & Evidence

- [x] Task 1: Document feature proposal and technical architecture in `odd/tasks/dynamic-subagent-specialization.md`
- [x] Task 2: Extend subagent protocol schema (`lib/agents-protocol.ts` & `extensions/gentle-agents.ts`) with `SubagentSpecialization`
- [x] Task 3: Implement runner prompt synthesis and tool sandbox validation in `lib/agents-runner.ts`
- [x] Task 4: Add specialization badge rendering in `lib/agents-renderer.ts` and widget layout
- [x] Task 5: Update orchestrator delegation guidelines in `assets/orchestrator-delegation.md` for ODD dynamic specialization
- [x] Task 6: Add automated tests for specialization validation, tool safety sandbox, and child config generation in `tests/`
- [x] Task 7: Verify whole test suite and run functional validation
- [ ] Task 8: Implement actionable `workspace_root` vs `repository_root` guidance and in-repo absolute path normalization for `## Allowed edit surfaces`
- [ ] Task 9: Verify dispatch resilience and path normalization with unit tests in `tests/`

---

## Part 4: Acceptance Criteria & Verification

1. **Protocol Acceptance:** `subagent_run` accepts `specialization` with `label`, `instructionsOverlay`, `extraTools`, and `outputContract`.
2. **Sandbox Enforcement:** Attempting to add `write` or `edit` to `gentle-ai-explore` via `extraTools` fails fast with a clear validation error.
3. **Prompt Delivery:** Child subagent receives the combined prompt containing both base instructions and the dynamic specialization block.
4. **UI Transparency:** The active subagent card displays the specialized label alongside the base agent name.
5. **No Regression:** All existing subagent tests pass cleanly.
