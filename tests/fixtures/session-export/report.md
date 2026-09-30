# Session statistics

## Session

| Metric | Value | Provenance |
| --- | ---: | --- |
| Turns | 3 | measured |
| Cost | $0.003000 + (1 unreported) | partial |
| Tokens | 450 (in 300, out 100, cache r/w 40/10, reasoning 28) | measured |
| Sessions | 1 | measured |
| Subagents | 1 | measured |
| Tool calls | 7 | partial |

Ratios are derived; `n/a` means the denominator is zero (unavailable), never zero.

## Breakdown

| Scope | Key | Turns | Cost | Cost provenance | Tokens | Cache-read share | Reasoning/output | Cost/turn |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| session | session | 3 | $0.003000 + (1 unreported) | partial | 450 | 0.088889 | 0.280000 | 0.001000 |
| model | p1/m1 | 2 | $0.001000 + (1 unreported) | partial | 175 | 0.171429 | 0.200000 | 0.000500 |
| model | p1/m2 | 1 | $0.002000 | measured | 275 | 0.036364 | 0.333333 | 0.002000 |
| agent_class | gentle-ai-worker | 1 | $0.002000 | measured | 275 | 0.036364 | 0.333333 | 0.002000 |
| agent_class | orchestrator | 2 | $0.001000 + (1 unreported) | partial | 175 | 0.171429 | 0.200000 | 0.000500 |
| subagent | S1 | 1 | $0.002000 | measured | 275 | 0.036364 | 0.333333 | 0.002000 |
| project | projA | 3 | $0.003000 + (1 unreported) | partial | 450 | 0.088889 | 0.280000 | 0.001000 |
