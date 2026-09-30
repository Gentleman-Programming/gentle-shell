# Billable hours (`gentle-shell.billable-hours/v1`)

An operator who bills hours at an hourly rate gets an hours report and its cost from the same statistics numbers. The report is honest about which part of the total time is measured and which is derived, and it is **opt-in**: not everyone has the same billing scheme, so the command and the panel key do not exist until it is enabled.

Source map: [report](../lib/billable-hours.ts), [exporters](../lib/session-export.ts), [command](../extensions/statistics.ts).

## Turning it on

The feature is off unless one of these is set:

| Variable | Effect |
|---|---|
| `GENTLE_BILLABLE=1` | Enable the report even without a rate (hours only). |
| `GENTLE_BILLABLE=0` | Disable it explicitly; wins over a configured rate. |
| `GENTLE_BILLABLE_RATE=<number>` | Enable it and set the rate. A blank value does not enable it. |

When disabled, `gentle:billable` is not registered and the statistics panel shows no `b` key; the palette row for the command disappears with it (the palette drops a catalog entry whose command is not registered).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GENTLE_BILLABLE_RATE` | `0` | Amount per hour, in `currency`. Zero reports the hours without an amount. |
| `GENTLE_BILLABLE_CURRENCY` | `USD` | Upper-cased currency label. |
| `GENTLE_BILLABLE_ROUNDING` | `none` | `none`, `nearest-6`, `nearest:15`, `up-15` … |

Rounding is applied per session, then the amount is computed per line and rounded to cents, so the total is the sum of what is billed. `up` never exceeds the next step; `nearest` moves by at most half a step; a malformed or non-positive policy fails closed to `none`, so a typo can never inflate an invoice.

## Using it

- Command: `gentle:billable` (default: the last 7 days; `--days N` to widen it).
- Panel: press `b` inside `/statistics`.
- Output: `<agentHome>/gentle-statistics/exports/billable-<timestamp>.{md,csv,json}`.

## Measured, derived and estimated

Every report states the split:

- **measured** — session and subagent wall-clock boundaries. This is the billable basis.
- **derived** — per-tool duration and model latency from timestamp pairing (I5).
- **estimated** — idle, the wall clock the model and tool segments do not cover.

A session whose provider reported no cost still bills its hours; the cost is marked `partial` and the hours are unaffected. Prompt text, response text and filesystem paths never reach an artifact.
