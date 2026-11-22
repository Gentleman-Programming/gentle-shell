# feat(tower): print the Tower URL as one JSON line with gentle-shell tower --json

<!-- Form: Feature Request (.github/ISSUE_TEMPLATE/feature_request.yml). The two boxes below are first-person declarations: the publisher confirms them. -->

### Before submitting

- [ ] I searched open and closed issues and did not find a request for this feature.
- [ ] I reviewed this request and removed credentials, tokens, private paths, hostnames, and other sensitive data.

### Problem or opportunity

gentle-shell-gpui starts `gentle-shell tower --no-open` and parses the human line `Gentle Tower: <url>`. A Desktop RPC read cannot replace this: no registry of a running Tower exists and its URL carries a per-launch secret token.

### Proposed outcome

`gentle-shell tower --json` prints one line `{"schema":"gentle-shell.tower/v1","url":...,"host":"127.0.0.1","port":...}` instead of the text lines. Output without the flag is unchanged; a start failure stays text on stderr with exit 1.

### Alternatives considered

A `get_tower` RPC: rejected, it could only see a Tower started by the same session and would expose the token from a session-scoped server.

### Additional context

Part of the gentle-shell-gpui parity work: each piece replaces an app-side workaround (reading private files, prompt-text commands, or parsing terminal output). Implementation branch: `feat/desktop-rpc-tower`.
