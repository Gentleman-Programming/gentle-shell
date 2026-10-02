# History agent-dir roots (1618)

## Objective
The prompt history extension resolved the v2 store root and the transcript-scan sessions root from a hardcoded `join(homedir(), ".pi", "agent")`, ignoring the agent home gentle-shell actually runs with (`GENTLE_SHELL_HOME`, `--home`, `PI_CODING_AGENT_DIR`). Under the isolated home, capture wrote to the vanilla Pi store and the transcript bootstrap never saw gentle-shell sessions. Resolve both roots from Pi's `getAgentDir()`.

## Problem and why
gentle-shell#1618: under the default isolated home (`~/.gentle-shell/agent`) or any custom home, prompt capture leaked into `~/.pi/agent/history/` and the sessions scan read the wrong tree. Reporter @osantis supplied a controlled file:line pin and the banner-fix precedents (39c8d870, 1393db7c); green-lit taking it in-thread 2026-10-01.

## Authorized scope and constraints
- Issue #1618 (`bug`, `status:needs-review`, `type:bug`; awaiting triage label — reporter's go-ahead recorded in-thread). Worktree gentle-shell-1618, branch fix/1618-history-agent-dir on fork, base origin/main.
- The legacy pre-v1 migration source deliberately stays on vanilla `~/.pi/agent` (those files predate Gentle Shell homes) — accepted in-thread.
- No scope beyond the two roots; banner parity only.

## Tasks
- [x] T1 — Fix: `extensions/history/index.ts` resolves the store root and sessions root per extension load from Pi's `getAgentDir()` (honors `PI_CODING_AGENT_DIR`); `LEGACY_AGENT_DIR` preserved for `migrateLegacyStores()`. Regression tests `tests/history-agent-dir-defaults.test.ts` (prior session; commit 2a622914; npm-generated package-lock.json dropped in 9666b792, repo uses pnpm).
- [x] T2 — Refresh 2026-10-02: merged origin/main (19 commits, clean auto-merge; 55791d9b). Verification: history family + agents-history 311/311, new regression test 2/2, `node scripts/check-types.mjs` baseline 187 no regressions (worktree node_modules realigned from the main checkout after a fresh frozen install resolved peer types differently — sources byte-identical to main), `node scripts/build-runtime-modules.mjs --check` matches. Size gate: 100 changed lines vs main (≤ 400). PR opened against #1618 (issue awaiting `status:approved`; maintainer-side gate).
