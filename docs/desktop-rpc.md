# Gentle Desktop RPC

Gentle Shell exposes a structured control channel for Gentle Desktop without changing or patching `pi-coding-agent`. It uses Pi's public extension-command and Extension UI RPC mechanisms.

## Activation

Start Pi in RPC mode with the interactive-host marker:

```sh
GENTLE_SHELL_INTERACTIVE_HOST=1 pi --mode rpc
```

The channel is inactive in the TUI and in headless RPC children. It does not register an agent-callable tool.

## Transport

Desktop sends an ordinary Pi `prompt` command. Its `message` contains `/gentle:desktop` followed by one JSON request:

```json
{
  "id": "pi-42",
  "type": "prompt",
  "message": "/gentle:desktop {\"schema\":\"gentle-shell.desktop-rpc/v1\",\"requestId\":\"desktop-42\",\"method\":\"capabilities\",\"params\":{}}"
}
```

Pi's response to this command only reports prompt disposition:

```json
{
  "id": "pi-42",
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": { "disposition": "handled" }
}
```

The domain response arrives independently as an `extension_ui_request` with `method: "setWidget"`, `widgetKey: "gentle-desktop-rpc"`, and one JSON string in `widgetLines`. Its `requestId` correlates it with the Desktop request, not with the outer Pi prompt ID.

Registered extension commands are consumed by Pi. The real-runtime maintainer probe also verifies that this transport leaves `get_messages` empty rather than adding control traffic to the conversation.

## Requests

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "requestId": "desktop-42",
  "method": "get_snapshot",
  "params": {}
}
```

Requests are limited to 64 KiB. `requestId` is required and limited to 128 characters. Method names use lowercase snake case and are limited to 64 characters.

### `capabilities`

Returns the currently implemented contract; clients must not infer support from a later specification version:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "command": "gentle:desktop",
  "widget": "gentle-desktop-rpc",
  "methods": ["capabilities", "get_snapshot", "get_permission_mode", "set_permission_mode"],
  "events": ["permission_mode_changed"]
}
```

The permission methods and the `permission_mode_changed` event are advertised because this extension wires them; a later slice adds its own methods and events here. Method availability is not a claim that every dependency is loaded — see [Permission limits](#permission-limits).

### `get_snapshot`

Returns the current event sequence and a state projection. The initial transport slice has an empty state object; later domain slices add their own documented fields:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "sequence": 0,
  "state": {}
}
```

This snapshot does not project permission state: use `get_permission_mode` for that. `sequence` is the number of delivered events, so a client that saw `seq: 4` expects `sequence: 4` from a fresh snapshot unless it missed an event.

### `get_permission_mode`

Reads the live permission owner. Params must be an empty object. A read has no effect on stored preferences: it never writes the default store, never changes a permission mode this session already established, and never emits an event.

The owner initializes a session lazily and this read is one of the entry points that does it. The first permission call in a session (a read or a set) resolves the session identity and pins this session's live mode to the trusted default in effect at that moment; that is why a read can be the call that materializes the session's mode. Later default changes therefore affect new sessions, not the one already initialized.

```json
{ "schema": "gentle-shell.desktop-rpc/v1", "requestId": "desktop-43", "method": "get_permission_mode", "params": {} }
```

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-43",
  "ok": true,
  "data": { "mode": "normal", "default_mode": "normal" }
}
```

`mode` is the session mode in effect now; `default_mode` is the trusted default a new primary session would start from. Both are one of `normal`, `auto`, `yolo`, `super-yolo`.

### `set_permission_mode`

Applies a session mode immediately through the existing permission owner (`YoloSessionController`). No restart, no reload, and no separate store: this is the same controller that answers `/gentle:mode` and `/gentle:yolo`.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "requestId": "desktop-44",
  "method": "set_permission_mode",
  "params": { "mode": "auto", "persist": true }
}
```

| Param | Required | Type | Meaning |
| --- | --- | --- | --- |
| `mode` | yes | `normal` \| `auto` \| `yolo` \| `super-yolo` | Session mode to apply now. |
| `persist` | no | boolean, default `false` | Also save `mode` as the trusted default for new primary sessions. |

Only these two params are accepted. Any other key, a non-string `mode`, a non-boolean `persist`, or an unknown mode string is rejected as `invalid_request` with no state change and no event.

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-44",
  "ok": true,
  "data": { "mode": "auto", "default_mode": "auto", "persisted": true, "changed": true }
}
```

`mode` and `default_mode` are re-read from the owner after the attempt, so they are the actual resulting state, not an echo of the request. `persisted` reports whether this request actually saved the default. `changed` reports whether the session mode or the default differs from the state read before the call; a rejected or unchanged request returns `changed: false` and emits no event.

Persistence is delegated to the owner's validated writer, which keeps the file private (`0600`), writes atomically, and refuses to repair a malformed or unreadable preference. A failed save does not roll back the live session change:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-45",
  "ok": true,
  "data": {
    "mode": "auto",
    "default_mode": "normal",
    "persisted": false,
    "changed": true,
    "persist_error": { "code": "default_unchanged", "message": "Default permission mode unchanged" }
  }
}
```

## Responses

Success:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-42",
  "ok": true,
  "data": {}
}
```

Failure:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "response",
  "requestId": "desktop-42",
  "ok": false,
  "error": {
    "code": "unsupported_method",
    "message": "Unsupported Desktop RPC method"
  }
}
```

Current error codes are `invalid_request`, `unsupported_method`, `permission_unavailable`, `permission_denied`, and `internal_error`. A request that cannot supply a valid correlation ID uses `requestId: null`. State/provider failures use the generic `internal_error` message rather than exposing raw paths, credentials, or provider errors. Transport failures from `setWidget` are never retried as a second response.

| Code | Meaning |
| --- | --- |
| `invalid_request` | Malformed envelope, unknown mode, or unsupported params. State unchanged. |
| `unsupported_method` | Method not in `capabilities`. |
| `permission_unavailable` | The permission owner did not answer for this session (extension not loaded, or the session changed). State unchanged. |
| `permission_denied` | The owner refused the change (for example a non-interactive or replaced session). State unchanged. |
| `internal_error` | Unexpected failure; message stays generic. |

## Events

Domain events use the same widget channel:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 1,
  "event": "example_event",
  "data": {}
}
```

The event name above is illustrative; `capabilities` is authoritative for implemented events. `seq` starts at 1 after successful delivery in each newly started session and resets on session shutdown or reload. After shutdown the channel does not answer further commands. Clients should fetch `get_snapshot` after connecting and whenever they detect a sequence gap. Responses do not increment the event sequence.

### `permission_mode_changed`

Emitted at most once per successful `set_permission_mode`, always after its response line, and never for rejected, unavailable, or no-op requests:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "kind": "event",
  "seq": 1,
  "event": "permission_mode_changed",
  "data": {
    "mode": "auto",
    "previous_mode": "normal",
    "default_mode": "auto",
    "persisted": true,
    "source": "desktop"
  }
}
```

`source` is `desktop` because this slice only publishes events for changes it made itself; `persisted` reports whether that request saved the default. Mode changes made elsewhere in the session (for example a `/gentle:mode` prompt) are visible through `get_permission_mode` but do not emit this event.

## Permission limits

- The methods delegate to the Gentle AI extension's permission owner in the same Pi process. When that extension is not loaded, both methods answer `permission_unavailable` instead of guessing state.
- Session changes require the owner's interactive-host admission: the TUI, or an RPC process with `GENTLE_SHELL_INTERACTIVE_HOST=1`. Headless RPC children and subagent children stay closed exactly as before.
- Permission control is never an agent-callable tool; only `/gentle:desktop` over the interactive RPC channel reaches it.
- This slice adds no filesystem watcher and no second store. It does not implement config, usage, agents, jobs, music, or any Desktop Rust change.
- Requests are not queued. Pi's own RPC loop dispatches prompts concurrently, so overlapping `set_permission_mode` calls reach the owner in whatever order their own reads finish, and one can apply right after the other. What stays guaranteed: every request gets exactly one correlated response, responses never cross, and each response and its optional event are published as an adjacent pair with a monotonic `seq`. Send permission requests one at a time and correlate with `requestId`; the maintainer probe does exactly that.

### Trust boundary

`GENTLE_SHELL_INTERACTIVE_HOST=1` is the only gate, and it is a process marker, not a human confirmation. Any actor able to write this Pi process's RPC stdin — or otherwise drive `/gentle:desktop` in the marker-set process — can request permission elevation, including `super-yolo`, and can make it the saved default with `persist: true`. Two consequences follow:

- `hasUI` in RPC mode means the Desktop app's UI surface exists; it is not proof that a person approved anything. This contract adds no confirmation dialog, so approval belongs to the Desktop client and its user.
- The same write access already implies full control of an interactive agent session, so this is not a privilege escalation beyond stdin access. It is still a capability: treat the Desktop client's stdin channel as trusted input, and never let untrusted content (task text, issues, files, agent output) synthesize `/gentle:desktop` permission requests.

## Verification

```sh
node --experimental-strip-types --test \
  tests/desktop-rpc.test.ts \
  tests/desktop-rpc-permissions.test.ts \
  tests/maintainer/desktop-rpc.maintest.ts
```

The permission tests register the real `registerYoloSessionPolicy` owner with an isolated temporary config home and a stub identity resolver; they never read or write the user's own permission store.

The maintainer probe runs the installed Pi runtime with isolated HOME, agent home, config home, session, and temporary directories and no provider or network. It has two cases:

1. transport only — this extension alone proves slash-command dispatch, correlation, and that capabilities advertise the permission domain;
2. live owner — the real `extensions/gentle-ai.ts` owner extension is loaded alongside this extension, and the probe reads the mode, sets `auto` with `persist: false`, observes the response plus one `permission_mode_changed` event, and reads `auto` again in the same process without a restart, while `get_messages` stays empty and no default file is written. Nothing in the probe reimplements the owner.

What this does not prove: a live Desktop conversation approving the request. The probe writes RPC stdin itself, so it demonstrates that the production owner accepts the change and reports it truthfully, not that a person consented. It also does not cover `persist: true` end to end; persistence is covered by the owner and focused unit tests.
