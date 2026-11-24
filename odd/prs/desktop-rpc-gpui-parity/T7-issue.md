# feat(desktop): list agent definitions and the default orchestrator over Desktop RPC

<!-- Form: Feature Request (.github/ISSUE_TEMPLATE/feature_request.yml). The two boxes below are first-person declarations: the publisher confirms them. -->

### Before submitting

- [ ] I searched open and closed issues and did not find a request for this feature.
- [ ] I reviewed this request and removed credentials, tokens, private paths, hostnames, and other sensitive data.

### Problem or opportunity

gentle-shell-gpui reads agent definition files and Pi's `settings.json` itself to list agents and the default orchestrator.

### Proposed outcome

`list_agent_definitions {}`: the agents `subagent_list_agents` discovers (name, description, scope, declared model, thinking, mode, tools), problem counts, subagent defaults, and the default orchestrator status and model. No paths, prompt bodies, or problem text. No event.

### Alternatives considered

_No response_

### Additional context

Part of the gentle-shell-gpui parity work: each piece replaces an app-side workaround (reading private files, prompt-text commands, or parsing terminal output). Implementation branch: `feat/desktop-rpc-agent-definitions`.
