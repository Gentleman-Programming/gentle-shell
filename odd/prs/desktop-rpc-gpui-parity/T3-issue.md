# feat(desktop): add persona, banner, and notifications config stores to Desktop RPC

<!-- Form: Feature Request (.github/ISSUE_TEMPLATE/feature_request.yml). The two boxes below are first-person declarations: the publisher confirms them. -->

### Before submitting

- [ ] I searched open and closed issues and did not find a request for this feature.
- [ ] I reviewed this request and removed credentials, tokens, private paths, hostnames, and other sensitive data.

### Problem or opportunity

gentle-shell-gpui reads and writes `persona.json` (global and project), `banner.json`, and `notifications.json` directly, so it depends on file layouts it does not own and never hears about changes made in the terminal.

### Proposed outcome

Three new stores on the existing `get_config` / `set_config` contract, with `config_changed`:
- `persona` (`global+project`): writes like `/gentle:persona` (global file, plus the project file only when it exists).
- `banner`: `{ showRose, showTextLogo, color }`.
- `notifications`: every `file:` sound path is replaced by the marker `"file"`; a write can keep an existing file sound through the marker, never introduce a new path.

Out of scope: telemetry (a consent switch) and the Pi theme (Pi persists it through an asynchronous settings queue and exports no installed-theme list).

### Alternatives considered

A theme store writing `settings.json`: deferred until Pi exposes its theme list and an awaitable write.

### Additional context

Part of the gentle-shell-gpui parity work: each piece replaces an app-side workaround (reading private files, prompt-text commands, or parsing terminal output). Implementation branch: `feat/desktop-rpc-settings-stores`.
