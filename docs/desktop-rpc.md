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
  "methods": ["capabilities", "get_snapshot"],
  "events": []
}
```

### `get_snapshot`

Returns the current event sequence and a state projection. The initial transport slice has an empty state object; later domain slices add their own documented fields:

```json
{
  "schema": "gentle-shell.desktop-rpc/v1",
  "sequence": 0,
  "state": {}
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

Current error codes are `invalid_request`, `unsupported_method`, and `internal_error`. A request that cannot supply a valid correlation ID uses `requestId: null`. State/provider failures use the generic `internal_error` message rather than exposing raw paths, credentials, or provider errors. Transport failures from `setWidget` are never retried as a second response.

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

## Verification

```sh
node --experimental-strip-types --test \
  tests/desktop-rpc.test.ts \
  tests/maintainer/desktop-rpc.maintest.ts
```

The maintainer test spawns the installed Pi runtime with isolated HOME, session, and temporary directories. It uses no provider, credentials, network service, or runtime patch.
