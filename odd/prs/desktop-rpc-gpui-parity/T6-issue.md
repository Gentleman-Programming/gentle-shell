# feat(desktop): push subagent progress (turns, tool calls, running tool) in agents_update

<!-- Form: Feature Request (.github/ISSUE_TEMPLATE/feature_request.yml). The two boxes below are first-person declarations: the publisher confirms them. -->

### Before submitting

- [ ] I searched open and closed issues and did not find a request for this feature.
- [ ] I reviewed this request and removed credentials, tokens, private paths, hostnames, and other sensitive data.

### Problem or opportunity

`agents_update` fires only on status changes, so gentle-shell-gpui parses the `gentle-agents` terminal widget to show turns, tool calls, and the current step of a running subagent.

### Proposed outcome

`list_subagents` and `agents_update` entries gain optional `turns`, `toolCalls`, and `activeTool` (the running tool's name when it is a plain identifier, never its arguments). Progress inside a turn emits at most once per session every 500 ms; status changes stay immediate. No new event.

### Alternatives considered

A separate `agents_progress` event: rejected, clients would merge two streams.

### Additional context

Part of the gentle-shell-gpui parity work: each piece replaces an app-side workaround (reading private files, prompt-text commands, or parsing terminal output). Implementation branch: `feat/desktop-rpc-subagent-progress`.
