# Gentle Shell statistics schema (`gentle-shell.statistics/v1`)

A non-TUI host — a client that runs `pi --mode rpc` itself — receives the session statistics aggregates as one bounded JSON document per coalescing window, so it can render totals, breakdowns and the timeline without polling. A human billing hours gets the same numbers as a file through the exporters.

Source map: [publisher](../lib/session-statistics-rpc.ts), [aggregate](../lib/session-aggregate.ts), [timeline](../lib/session-timeline.ts), [exporters](../lib/session-export.ts).

## Transport

Pi's `setWidget` is the only fire-and-forget RPC push structured enough to carry this: in RPC mode it accepts a `string[]` (sent as `extension_ui_request`) and silently ignores a component-factory function. The statistics publisher uses its own widget key, `gentle-statistics`, so it can never collide with `gentle-agents.activity/v1`.

```json
{
  "type": "extension_ui_request",
  "method": "setWidget",
  "widgetKey": "gentle-statistics",
  "widgetLines": ["{\"schema\":\"gentle-shell.statistics/v1\", ...}"]
}
```

`widgetLines` is always exactly one line: one JSON document, `JSON.stringify`'d, never pretty-printed. Parse it as `gentle-shell.statistics/v1`. The publisher is a module with no wiring yet; I8 wires it to an overlay.

## Payload shape

```jsonc
{
  "schema": "gentle-shell.statistics/v1",
  "asOf": 1732000000000,
  "totals": {
    "turns": 5,
    "cost": { "nanoUsd": 6000000, "provenance": "partial", "absent": 2 },
    "tokens": { "input": 650, "output": 210, "cacheRead": 80, "cacheWrite": 15, "reasoning": 58, "total": 955, "provenance": "measured" },
    "ratios": { "cacheReadShare": 0.0837, "cacheWriteShare": 0.0157, "reasoningShareOfOutput": 0.2761, "outputToTotal": 0.2198, "costPerTurn": 0.0012, "tokensPerTurn": 191 }
  },
  "counts": {
    "sessions": { "value": 1, "provenance": "measured" },
    "subagents": { "value": 2, "provenance": "measured" },
    "toolCalls": { "value": 10, "provenance": "partial" }
  },
  "perModel": [{ "key": "p1/m1", "bucket": { "turns": 2, "cost": {}, "tokens": {}, "ratios": {} } }],
  "perAgentClass": [{ "key": "orchestrator", "bucket": {} }],
  "perSubagent": [{ "key": "S1", "label": "build", "bucket": {} }],
  "perProject": [{ "key": "projA", "bucket": {} }],
  "timeline": {
    "segments": 827,
    "modelMs": 5844898,
    "toolMs": 13508144,
    "idleMs": 6779869,
    "wallClockMs": 26132924,
    "modelLatency": [{ "model": "m1", "count": 2, "medianMs": 2000, "p90Ms": 2000 }],
    "toolDurations": [{ "command": "pnpm test", "count": 1, "medianMs": 3000, "p90Ms": 3000, "parallelCount": 1 }]
  }
}
```

`totals` is a `UsageBucket` from `lib/session-aggregate.ts`: `turns`, the six token counters, and the derived ratios. `timeline` is `null` when no timeline is supplied; when present, `idleMs` is an estimate (the wall clock the model and tool segments do not cover), never a measured time.

## Provenance and unavailable markers

Every monetary and token figure carries `provenance`: `measured` while every component was reported, `partial` as soon as one component reported no cost, forever. An unavailable ratio is `null`, never a blank or a zero. Counts carry provenance too: the orchestrator's own tool calls are not in a usage record, so an aggregate that includes a parent record reports its `toolCalls` count as `partial` rather than a silently smaller number.

## Bounds

Every bound fails closed. A value that cannot fit is dropped or shrunk; the encoder never throws.

| Field | Bound |
|---|---|
| breakdown key (`perModel`/`perAgentClass`/`perSubagent`/`perProject`) | 120 characters, trailing `…` |
| `perSubagent.label` | 120 characters, trailing `…` |
| entries per breakdown (`perModel`, `perAgentClass`, `perSubagent`, `perProject`) | 20 |
| `timeline.modelLatency`, `timeline.toolDurations` | 20 entries each |
| whole payload | 64 KiB |

## Oversize is a discard, not a silent truncation

When the payload exceeds the bound, `encodeStatisticsLines` shrinks it in order: halve every breakdown's entries (repeatedly, down to zero), then drop the timeline. If even that does not fit, it returns **no lines** and the publisher sends nothing — a partial payload is never presented as complete. Malformed input fails closed to no lines.

## Coalescing and the attempt slot

The publisher coalesces a burst of requests into one `setWidget` call per window (150 ms default) and publishes a final frame on `stop`. Publishing holds a single attempt slot: a request while a frame is in flight is discarded, never queued. A `setWidget` failure is reported to `onError` and never thrown into the session.

## Exporters

`lib/session-export.ts` renders I4's `UsageAggregate` and nothing else, so the export and any UI cannot diverge. All three mark provenance and write `n/a` for an unavailable ratio.

- **Markdown** (`exportStatisticsMarkdown`): a session summary plus one row per scope, with a provenance column.
- **CSV** (`exportStatisticsCsv`): one row per scope, with `cost_provenance`, `tokens_provenance` and `ratios_provenance` columns.
- **JSON** (`exportStatisticsJson`): the versioned envelope `{ "schema", "generatedAt"?, "session", "perModel", "perAgentClass", "perSubagent", "perProject" }`, with `ratios.provenance: "derived"`.

The output is deterministic for a given aggregate; `generatedAt` is injected and omitted by default, so golden files are stable across runs. Only allowlisted aggregate fields are read: prompt text, response text and filesystem paths cannot reach any artifact.
