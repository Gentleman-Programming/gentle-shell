# Delegated verification

How the Gentle Pi orchestrator decides who verifies a bounded writer's work. The always-on parent prompt renders a `Receipt-driven development: on|off|unknown` line; the delegation overlay (`assets/orchestrator-delegation.md`, trigger 5) keys the verification rule on it. This page is package-owned; `docs/review-integration.md` mirrors the Gentle AI contract and must stay byte-identical to it.

## Receipt-driven development on

The bounded writer runs the exact commands the parent lists under `## Verification`, in the foreground, and reports each as `<command>: <observed result>`. That report is the verification of record and the native review is the independent check. `gentle-ai-verify` is on-demand: a `partial` or `blocked` writer, an expensive or external check the parent wants on a cheaper profile, or a parent spot check.

This `on` path holds only while the native review actually reaches a terminal outcome for the current candidate (gentle-pi#668). A human decline of the consent envelope for this candidate (candidate-scoped, never the RDD kill switch), a clone-local RDD disable discovered mid-flow, or a refused START/STATUS all mean the review never ran, so the parent falls back to the exact risk-gated path below, as if RDD were `off` -- declining a review never lowers the bar below the RDD-off path.

### How `assess` resolves the review outcome (gentle-pi#1175)

`gentle_review`'s `assess` operation derives `closed` only from the native `candidate.consumed` fact for this exact candidate. Native writes that fact only when the approved review for that candidate is acknowledged. A caller-supplied `closed` is not authority: without that fact it resolves to `unknown`. A declined, unavailable, or unknown outcome falls back to the RDD-off tier table, and `unknown` is never treated as closed.

Rows apply in order; the first match wins.

| Outcome evidence | Resolved `nativeReviewOutcome` | `outcome_source` |
| --- | --- | --- |
| Caller passes `declined`, `unavailable`, or `unknown` | that value | `explicit` |
| This process recorded `declined`/`unavailable` for this exact candidate | that value (wins over closure) | `derived` |
| Native reports `candidate.consumed: true` for this candidate | `closed` | `derived` |
| Anything else, including a bare caller `closed` | `unknown` | `unknown` |

A recorded outcome is keyed by the candidate's own target identity, never by repository alone, so one candidate's outcome never leaks into a different candidate's `assess` call in the same clone.

### How `assess` resolves the writer profile (gentle-pi#1175)

The writer profile comes from the runtime-recorded model and effort of the pending mutations for the root (`writerProfileSource: runtime`). Caller `writerModelId`/`writerEffort` are only a fallback when no runtime evidence exists (`caller`); with neither, the profile is small (`fallback`). A missing model, a `mini` model token (`gemini` is not mini), or `low` effort keeps the conservative small-model bias.

### What `assess` projects

When native reports them, `assess` projects `reviewDue`, `reviewDueReason`, `candidate.consumed`, and the native preflight continuation (`nextTransition`) verbatim. Older binaries omit them, and nothing is invented. The continuation is opaque: relay it unchanged, never rebuild it.

## Receipt-driven development off or unknown (gentle-pi#662)

The host exposes one read-only native operation: `gentle-ai review assess --cwd <repo> [--base-ref <ref> --committed-only] --json` (gentle-ai#4295). It is decoded by `lib/review-risk-assessment.ts` and wired through `lib/native-review-cli.ts` exactly like the existing `reviewMode` STATUS reader -- a bounded subprocess with a typed decode, never a mutation. A non-zero exit, a failure envelope, or an older binary without the verb all fail closed to `high` risk.

The `gentle_review` tool's `assess` operation (`extensions/gentle-ai.ts`) combines that assessment with the rendered `Receipt-driven development:` line to decide whether a delegated writer's change needs a separate `gentle-ai-verify` run, following this tier table:

| Native risk tier | Verification when RDD is `off`/`unknown` |
| --- | --- |
| passive | structural readback by the parent; no separate verifier, no tests |
| medium | writer self-verification stands; a separate `gentle-ai-verify` run is added only when the writer profile is a small model (mini or low effort) |
| high | writer self-verification plus a separate `gentle-ai-verify` run, always |
| unknown / assess failed | treated as high |

When RDD is `on` and the native review closed for this candidate, the writer's own self-verification is the record and the closed native review is the independent check, except a passive-risk change, which still gets a structural readback instead; any other `nativeReviewOutcome` under `on` follows this same tier table instead (gentle-pi#668). The small-model bias raises the medium tier to high for verification purposes only; an unknown RDD line never lowers a tier below `off`. The parent's own spot check (re-running one reported command before delivery) stays required in every tier.

A native code review is not a substitute for applicable functional checks: tests, builds, and functional verification such as browser checks for UI changes still run when applicable. Review outcomes never authorize delivery; human consent for native review and the user-owned RDD switch are unchanged.

