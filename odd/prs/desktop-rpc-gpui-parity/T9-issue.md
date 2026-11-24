# feat(desktop): read package status over Desktop RPC with get_status

<!-- Form: Feature Request (.github/ISSUE_TEMPLATE/feature_request.yml). The two boxes below are first-person declarations: the publisher confirms them. -->

### Before submitting

- [ ] I searched open and closed issues and did not find a request for this feature.
- [ ] I reviewed this request and removed credentials, tokens, private paths, hostnames, and other sensitive data.

### Problem or opportunity

gentle-shell-gpui has no structured way to show what `/gentle:status` reports (persona, dev-binary override, managed assets, model routing).

### Proposed outcome

`get_status {}`: `{ package, odd, persona, devBinary, assets, modelConfig, severity }`, the same facts and the same severity rule as `/gentle:status`, without paths, `--force` hints, or display text. `/gentle:doctor` stays in the terminal. No event.

### Alternatives considered

_No response_

### Additional context

Part of the gentle-shell-gpui parity work: each piece replaces an app-side workaround (reading private files, prompt-text commands, or parsing terminal output). Implementation branch: `feat/desktop-rpc-status`.
