# Claude-bridge usage attribution

pi-claude-bridge 0.9.3 (commit a3fd575, bridge #171) forwards Claude Code's
`rate_limit_event` to pi's `after_provider_response` as
`anthropic-ratelimit-unified-*` headers. gentle-shell already parses those
headers, but files every snapshot under `anthropic`, while the bar reads
`usage.get(ctx.model.provider)` (`claude-bridge`). Result: no usage in the bar
for claude-bridge sessions. This supersedes the globalThis bus approach of
PR #1400.

Fix: attribute a header snapshot to the provider that served the response
(`ctx.model.provider`), falling back to the header-inferred provider.

## Tasks

- [x] T1 Migrate local pi-claude-bridge checkout to upstream v0.9.3 and confirm live that headers reach `after_provider_response` with `ctx.model.provider === "claude-bridge"`.
- [x] T2 RED: gentle-shell test where a claude-bridge session receives unified headers and the bar shows `claude 5h … · week …`.
- [x] T3 GREEN: attribute header snapshots to the serving provider in `extensions/gentle-shell.ts`.
- [x] T4 Verify: focused tests + typecheck, then live gentle-shell session on claude-bridge shows usage in the bar and `/gentle:usage`.

## Evidence

- T1: probe on pi 1.2.0 + bridge 0.9.3 logged `provider: "claude-bridge"`, `5h-utilization 0.02`, `7d-utilization 0`.
- T2: new test failed before the fix (footer had no `claude 5h`).
- T3/T4: `node --test tests/gentle-shell.test.ts tests/shell-usage.test.ts tests/shell-bar.test.ts` 377/377; `npm run typecheck` no regressions; bridge `npm run test:unit` 330/330. Live gentle-shell on `claude-bridge/claude-haiku-4-5`: bar `usage 5h 2% · week 0%`, `/gentle:usage` shows `✿ claude-bridge` with claude 5h and week rows.
- Commit: eb7968e46 fix(shell): file header usage under the provider that served the response.
