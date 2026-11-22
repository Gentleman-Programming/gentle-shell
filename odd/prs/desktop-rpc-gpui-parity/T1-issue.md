# feat(desktop): read, clear, and follow the session profile binding over Desktop RPC

<!-- Form: Feature Request (.github/ISSUE_TEMPLATE/feature_request.yml). The two boxes below are first-person declarations: the publisher confirms them. -->

### Before submitting

- [ ] I searched open and closed issues and did not find a request for this feature.
- [ ] I reviewed this request and removed credentials, tokens, private paths, hostnames, and other sensitive data.

### Problem or opportunity

gentle-shell-gpui cannot read which profile the current session is bound to: it remembers locally what it last applied, so a profile chosen with `/gentle:profiles` in the terminal, or restored when a session resumes, is invisible to the app. Clearing the session's profile is sent as plain prompt text (`/gentle:profiles clear`), so the app gets no structured result.

### Proposed outcome

- `get_profile_binding {}`: `{ kind, profile, origin }` through the same rule launches, the status bar, and the Desktop feed use (`resolveSessionProfile`).
- `profile_binding_changed` event: a write to this session's binding that changes the answer (not a pin or global change seen through `follow`/`live`; re-read after `config_changed` for those), with `source: "desktop" | "external"`.
- `clear_profile_binding {}`: the `/gentle:profiles clear` owner action, behind the profile apply slot, answering `cleared | unchanged | not_cleared` without forwarding notices.
- No `publish_profile`: publishing a profile to the repository is the repo pin, already writable with `set_config` on `pins`.

### Alternatives considered

A separate `publish_profile` method: rejected, because `/gentle:profiles publish` toggles the same repo pin file `set_config` `pins` already writes with revision safety.

### Additional context

Part of the gentle-shell-gpui parity work: each piece replaces an app-side workaround (reading private files, prompt-text commands, or parsing terminal output). Implementation branch: `feat/desktop-rpc-profile-binding`.
