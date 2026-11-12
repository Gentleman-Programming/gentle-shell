# TODO freshness after custom-triggered runs

Before: source `79e8e7f631a56cd7dda425729a37843380ea363d`.
After: source `dbcd8852e548093cc549c0533a4787f137ab8271`.

Actual `gentle-todo` extension registration and widget factory, actual Pi TUI terminal rendering, SDK 1.5.2, Node 24.21, ttyd 1.7.7 and Chromium 1248. A controlled local event driver writes the same two tasks, then invokes three `before_agent_start` events with `messageType: custom` and no user prompt. The before card reports `stale · 3 turns`; the after card does not. Task text is unchanged. Each pair uses identical terminal dimensions, theme and pixel viewport: 100x30 / 826x553, and 70x24 / 590x443. The narrow terminal emulates a viewport, not a physical mobile device.

These are component-level PTY screenshots, not the complete interactive Shell, a native background subagent completion, an external model or provider run. The included fixture uses the actual product component with controlled host context. No installed user profile is modified. Both dark/light pairs and widths were visually inspected. Fixture lives outside the code PR; source commits identify the product behavior.

`capture-todo-2336.mjs` locally adapts the existing capture helper used for #3178, pointing it at the isolated source snapshots, this fixture, and a single capture two seconds after readiness. Source snapshots are exact Git archives; the after snapshot differs only by the committed `extensions/gentle-todo.ts` change. Dependencies use the existing Linux SDK 1.5.2 stage.

Finished-list clearing remains governed by the existing next-run behavior, including custom runs. This change only aligns freshness aging with the user-message count used during session replay; events without messageType retain legacy counting.
