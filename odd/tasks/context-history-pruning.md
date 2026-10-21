# Feature: Rolling Window Context Pruning for Historical Tool Outputs

## 1. Diagnosis & Technical Proposal

### Context & Diagnosis
In Pi sessions, tool executions (`bash`, `git diff`, `npm test`, `read`, etc.) produce verbose outputs that are recorded in the session `.jsonl` file and conversation transcript. While valuable for human inspection and terminal display, Pi's default behavior sends the entire conversation history—including hundreds of thousands of characters of historical tool outputs from earlier turns—to the LLM on every single request.
In real-world workflows, a merge task or exploration can execute 60+ bash commands accumulating over 230,000 tokens of stale diffs, test logs, and stdout that are never needed again once the turn is settled. This causes:
1. Massive token consumption on every turn (jumping from ~30k to >260k tokens per prompt).
2. Degraded model reasoning ("lost in the middle" attention failure due to noise).
3. Skyrocketing proxy / inference latency.

### Technical Proposal
Implement an automated, request-local Context Pruning transformer via Pi's `pi.on("context")` extension hook:
- Request-local transformation: Never mutates the session transcript, terminal display, or `.jsonl` disk storage.
- Rolling Window Protection: The current active turn and the immediately preceding turn (`recentTurns = 2`) preserve 100% of their tool results intact so the model can inspect and reflect upon immediately preceding actions.
- Historical Pruning: For turns older than the rolling window, if a `toolResult` message exceeds a configured threshold (`maxRetainedChars = 400`), prune the verbose content to a clean, descriptive summary:
  `[Output omitted from LLM context: N chars / M lines. Result was preserved in session history.]`
- Preservation of Failures: If a tool resulted in an error (`isError: true`), keep an informative error excerpt so the model retains awareness of what broke.
- Zero side-effects: Opt-in / enabled by default with graceful bypass if disabled via environment flag (`GENTLE_PI_CONTEXT_PRUNING=off`).

## 2. Technical Specification & Contracts

### Module: `lib/context-pruning.ts`

```ts
export interface ContextPruningOptions {
  enabled?: boolean;
  recentTurnsToKeep?: number; // Default: 2
  maxRetainedChars?: number;   // Default: 400
}

export function pruneContextMessages(
  messages: readonly any[],
  options?: ContextPruningOptions,
): any[];
```

### Hook Integration: `extensions/gentle-ai.ts`
Register `pi.on("context", (event, ctx) => ...)`:
- Inspects `event.messages`.
- Applies `pruneContextMessages(event.messages)`.
- Returns `{ messages: pruned }` when pruning took place, or `undefined` when unchanged.

## 3. Tasks & Evidence

- [x] T1 — ODD Specification file created (`odd/tasks/context-history-pruning.md`).
- [ ] T2 — Test-first unit test suite in `tests/context-pruning.test.ts`.
- [ ] T3 — Core module implementation in `lib/context-pruning.ts`.
- [ ] T4 — Integration hook in `extensions/gentle-ai.ts`.
- [ ] T5 — Verification of focused and regression test suites.
- [ ] T6 — Work-unit commit on branch `feat/context-history-pruning`.

## 4. Acceptance Criteria & Verification

- `tests/context-pruning.test.ts` passes 100% covering:
  - Preserving recent turns intact.
  - Pruning historical verbose `toolResult` messages.
  - Preserving user, assistant, and short tool messages without truncation.
  - Error retention in failed tool outputs.
  - Opt-out via `GENTLE_PI_CONTEXT_PRUNING=off`.
- Full project test suite passes with zero regressions.
- Live context tokens for long multi-turn sessions are reduced by >70% without altering disk sessions.
