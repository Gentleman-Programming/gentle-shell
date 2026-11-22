# feat(desktop): read and change the background-subagents policy over Desktop RPC with confirmation

<!-- Form: Feature Request (.github/ISSUE_TEMPLATE/feature_request.yml). The two boxes below are first-person declarations: the publisher confirms them. -->

### Before submitting

- [ ] I searched open and closed issues and did not find a request for this feature.
- [ ] I reviewed this request and removed credentials, tokens, private paths, hostnames, and other sensitive data.

### Problem or opportunity

gentle-shell-gpui toggles background subagents by sending `/gentle:background-subagents enable|disable` as prompt text and reads the policy by opening `background-subagents.json` itself.

### Proposed outcome

- `get_background_subagents {}`: `{ effective, source, malformed, projectFile, globalFile, capability }`, no paths and no raw environment value.
- `set_background_subagents { policy, confirmationToken? }`: the same two-call confirmation as `set_review_mode`; writes the machine-wide file with the command's own writer, and the confirmation says when a project file still decides.

### Alternatives considered

Writing the project file too: rejected, the command only writes the machine-wide file.

### Additional context

Part of the gentle-shell-gpui parity work: each piece replaces an app-side workaround (reading private files, prompt-text commands, or parsing terminal output). Implementation branch: `feat/desktop-rpc-background-subagents`.
