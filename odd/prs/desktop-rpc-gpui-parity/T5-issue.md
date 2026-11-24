# feat(desktop): read credential status and reload credentials over Desktop RPC

<!-- Form: Feature Request (.github/ISSUE_TEMPLATE/feature_request.yml). The two boxes below are first-person declarations: the publisher confirms them. -->

### Before submitting

- [ ] I searched open and closed issues and did not find a request for this feature.
- [ ] I reviewed this request and removed credentials, tokens, private paths, hostnames, and other sensitive data.

### Problem or opportunity

gentle-shell-gpui reads `auth.json` keys to know which providers have credentials, and new credentials only reach a session when its backend restarts. Related: #3384 (sign-in for extension providers, option (c)); this issue covers status and reload only, no login.

### Proposed outcome

- `get_auth_status {}`: `{ providers: [{ provider, displayName, configured, type, source }], truncated }`, never a value, label, or command.
- `reload_credentials {}`: `modelRegistry.refresh({ allowNetwork: false })`, shared across concurrent calls, answering failed provider ids without error text.
- No login or logout.

### Alternatives considered

Reading `auth.json` in the bridge: rejected, it would be a second owner of a secret file.

### Additional context

Part of the gentle-shell-gpui parity work: each piece replaces an app-side workaround (reading private files, prompt-text commands, or parsing terminal output). Implementation branch: `feat/desktop-rpc-auth-status`.
