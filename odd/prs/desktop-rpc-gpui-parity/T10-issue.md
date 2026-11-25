# feat(desktop): add cost per day and usage per provider to get_usage_stats

<!-- Form: Feature Request (.github/ISSUE_TEMPLATE/feature_request.yml). The two boxes below are first-person declarations: the publisher confirms them. -->

### Before submitting

- [ ] I searched open and closed issues and did not find a request for this feature.
- [ ] I reviewed this request and removed credentials, tokens, private paths, hostnames, and other sensitive data.

### Problem or opportunity

`get_usage_stats` reports tokens per day and per model only, so gentle-shell-gpui cannot chart cost per day or split usage by provider.

### Proposed outcome

`byDay` rows gain `cost`; a bounded `byProvider` (50 rows) with `truncated.byProvider`. Computed by the same `aggregateStats` the `/gentle:stats` panel uses.

### Alternatives considered

_No response_

### Additional context

Part of the gentle-shell-gpui parity work: each piece replaces an app-side workaround (reading private files, prompt-text commands, or parsing terminal output). Implementation branch: `feat/desktop-rpc-read-gaps`.
