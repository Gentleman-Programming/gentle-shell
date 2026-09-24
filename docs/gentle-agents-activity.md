# Gentle Agents activity schema (`gentle-agents.activity/v1`)

An interactive RPC host — a client that runs `pi --mode rpc` itself, such as the Gentle Shell desktop app — receives live Gentle Agents subagent state as one bounded JSON document per coalescing window, so it can render a per-chat Helpers view without polling `subagent_status`.

Source map: [publisher](../lib/agents-rpc-publisher.ts), [wiring](../extensions/gentle-agents.ts), [store](../lib/agents-protocol.ts).

## Turning it on

Set `GENTLE_SHELL_INTERACTIVE_HOST=1` on the `pi --mode rpc` process the host spawns directly. `lib/rpc-host.ts`'s `isInteractiveRpcHost(mode, env)` gates the feature on that exact value; any other value, or its absence, keeps RPC headless — the existing subagent-child behavior is byte-identical. `lib/agents-runner.ts` strips the variable from every subagent child's environment, so a subagent spawned by an interactive host never inherits it and stays headless itself.

## Transport

Pi's `setWidget` is the only fire-and-forget RPC push structured enough to carry this: in RPC mode it accepts a `string[]` (sent as `extension_ui_request`) and silently ignores a component-factory function (the shape the TUI card above the editor uses). The publisher and the TUI card therefore share one widget key without colliding on the wire — a plain RPC host or a TUI session only ever sees the factory call, which its own transport ignores or renders locally.

```json
{
  "type": "extension_ui_request",
  "method": "setWidget",
  "widgetKey": "gentle-agents",
  "widgetLines": ["{\"schema\":\"gentle-agents.activity/v1\", ...}"]
}
```

`widgetLines` is always exactly one line: one JSON document, `JSON.stringify`'d, never pretty-printed. Parse it as `gentle-agents.activity/v1`.

## Payload shape

```jsonc
{
  "schema": "gentle-agents.activity/v1",
  "summary": { "running": 1, "queued": 0, "waiting": 0, "finished": 2 },
  "tasks": [
    {
      "summary": {
        "id": "t_abc123",
        "agent": "explore",
        "label": "Map the auth module",
        "prompt": "Explore how authentication works…",
        "status": "running",
        "createdAt": 1732000000000,
        "startedAt": 1732000000100,
        "endedAt": null,
        "lastStep": "reading lib/auth.ts",
        "lastActivityAt": 1732000005000,
        "turns": 2,
        "toolCalls": 3,
        "error": null
      },
      "thread": {
        "version": 7,
        "dropped": 0,
        "items": [
          { "kind": "text", "text": "Looking at the auth flow first." },
          { "kind": "tool", "name": "read", "args": "{\"path\":\"lib/auth.ts\"}", "running": false, "isError": false, "output": "…file contents…" }
        ]
      }
    }
  ]
}
```

`summary` is `TaskSummary` from `lib/agents-protocol.ts`, unchanged. Each task's `summary` is a field whitelist of its `TaskRecord`: `id`, `agent`, `label`, `prompt`, `status`, `createdAt`, `startedAt`, `endedAt`, `lastStep`, `lastActivityAt`, `turns`, `toolCalls`, `error`. Every other `TaskRecord` field — `cwd`, `parentSessionId`, `mode`, `model`, `thinking`, `sessionPath`, `result`, `tokens`, `cost` — is deliberately left out, the same discipline `lib/orchestrator-presence.ts`'s `projectActivity` already applies to same-profile peer discovery.

`thread.items` is a `ThreadItem[]` whitelist too: text/thinking/note items keep `{ kind, text }` (`text` bounded, see below); tool items carry `{ kind: "tool", name, args, running, isError, output }`, where `args` is the tool's argument object `JSON.stringify`'d (never the raw object). `thread.dropped` is the store's own ring-buffer drop counter (unrelated to the per-push item cap below); `thread.version` increments on every thread mutation.

Tasks are ordered `running`, `waiting`, `queued`, then finished tasks by `endedAt` descending (most recently finished first).

## Bounds

Every bound below fails closed: a value that cannot fit is truncated or dropped, and `lib/agents-rpc-publisher.ts`'s `encodeActivityLines` never throws.

| Field | Bound |
|---|---|
| `summary.prompt` | 200 characters, trailing `…` |
| `summary.error`, `summary.label`, `summary.lastStep` | 500 characters, trailing `…` |
| tool `args` (stringified) | 500 characters, trailing `…` |
| tool `output` | 500 characters, trailing `…` |
| text/thinking/note item `text` | 2000 characters, trailing `…` |
| `thread.items` per task | last 40, most recent last |
| whole payload | 256 KiB |

Truncation always keeps the field's prefix and marks the cut with a trailing `…` (never a separate `truncated` flag) — the same convention `projectRpcActivity`'s other bounded fields already use.

When the whole-payload bound is still exceeded after the field- and item-level truncations above, `encodeActivityLines` shrinks the payload in this order:

1. Halve every task's kept `thread.items` (repeatedly, down to one item each).
2. Empty finished tasks' threads entirely.
3. Drop whole finished tasks — oldest-finished first, by `endedAt`.
4. Last resort: once only active (running/waiting/queued) tasks remain, each already down to one thread item, empty every remaining task's thread too — a summary-only payload.

An active task's `summary` (running, waiting or queued) is never dropped; only its `thread.items` shrink. Finished tasks can be dropped whole by step 3, oldest first.

## Coalescing

`createRpcActivityPublisher` subscribes to `TaskStore#subscribeSummary` (task added, removed, or changed status) and to `TaskStore#subscribe(id)` for every known task, including ones added after `start()`. Changes inside a 150 ms window collapse into exactly one `setWidget("gentle-agents", [line])` call; `stop()` tears down every subscription and publishes one final frame.
