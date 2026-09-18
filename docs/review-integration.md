# Gentle AI review integration architecture

← [Back to README](../README.md)

Gentle Pi is a transport consumer, not a review authority. Gentle AI generates the current runtime contract; the package forwards the bounded work it receives and preserves the provider's outcome.

## Ownership boundary

| Component | Responsibility |
| --- | --- |
| Pi reviewer adapter | A pure opaque adapter: `Buffer → Buffer/error`. It accepts a Go-materialized prompt as bytes, invokes Pi in JSON event mode, and returns the event stream's final assistant text or a typed transport error carrying what the child's own stream revealed. |
| Host coordinator | Executes the exact Go-issued materialize/submission tokens, launches the adapter, and submits its result only through the supplied token. It validates and forwards two optional caller-owned launch selections: the lens's reviewer model (`--model`) and an explicit extension allowlist (`-e` paths). |
| Gentle AI (Go) | Go owns worktree, lineage, candidate freeze, lens selection, correction, validator, approval burn, and review semantics. Delivery commands remain ordinary repository-policy operations. |

The adapter does not parse bindings, select work, rebuild prompts, inspect repository state, retry, classify results, or create authority. The coordinator does not infer a command or replace a provider-issued token. The package has no durable receipt or policy authority.

## Transport behavior

1. Gentle AI emits an opaque materialization or submission token for the selected Pi runtime.
2. The host coordinator executes that exact token and gives only the materialized bytes to the adapter.
3. The adapter runs the child with `--mode json`, extracts the final assistant text from the pi event stream, and returns those bytes to the coordinator. A run that produced no assistant text fails typed with evidence: the stream kind, the reviewer selection the child itself reported, and whether a tool call was attempted (a text-mode run used to exit 0 with zero bytes and no diagnosable cause).
4. The coordinator sends those bytes only through the exact Go-issued submission token.

## Reviewer launch selection (user-owned)

The default reviewer launch is selection-free: no model flag, no extensions, no ambient inheritance of the session's model. Two optional, user-owned selections ride the request and are validated before any process launches; a broken value is refused typed as `reviewer-config-invalid`, never a mid-review transport failure:

- **Lens model** — the capture path reads the lens's entry from the agent model routing config (`review-risk`, `review-resilience`, `review-readability`, `review-reliability`) and forwards it as `--model <provider/id>`.
- **Extension allowlist** — `GENTLE_PI_REVIEW_RELAY_EXTENSIONS` holds absolute extension file paths separated by the platform path delimiter. They are loaded through explicit `-e` paths, which pi honors even under `--no-extensions`; this is how a subscription provider's OAuth billing adapter rides along without re-enabling extension discovery.

A typed Pi transport refusal fails closed. The coordinator reports the refusal — including the reviewer evidence and a bounded stderr excerpt on an empty-output failure — without an agentless lifecycle fallback, local retry policy, synthetic result, or alternate approval path.

## Dynamic contract delivery

Package static assets intentionally omit lifecycle instructions, candidate routing, recovery procedures, receipt semantics, and any delivery-gate or delivery-authorization behavior. Since Gentle AI stopped generating Pi APPEND_SYSTEM composition, Gentle Pi mirrors the provider contract bundle's `orchestration/pi.md` review execution contract locally (`contracts/review-provider-contract-mirror/`) and injects that verified, mirrored text into the primary session's system prompt at session start. Gentle AI writes nothing into the Pi system prompt; the host follows only that mirrored contract. When the mirrored contract is absent or unreadable, Gentle Pi does not invent a fallback; delivery remains ordinary repository policy.

## Integration constraints

- Keep Pi transport opaque: raw prompt bytes in, the event stream's assistant text or a typed, evidenced error out.
- Preserve Go-issued materialize and submission tokens exactly; they are the only authority-bearing inputs the host may execute.
- Keep the reviewer launch selection user-owned: the relay never invents a model and never enables extension discovery; it only forwards the validated caller-owned selections.
- Treat a transport failure as unavailable evidence, never as an approval, completion, or permission to substitute a local workflow.
- Keep command safety and user interaction in the host, without interpreting provider authority state.
- Keep durable review state, admissions, correction accounting, and approvals in Gentle AI. Keep delivery decisions in ordinary repository policy.

## Review checklist

- [ ] The adapter surface is still `Buffer → Buffer/error` (the output is the pi event stream's assistant text; failures carry typed evidence).
- [ ] The coordinator executes only exact Go-issued materialize/submission tokens.
- [ ] The reviewer launch stays selection-free unless the caller-owned selection and extension allowlist validate.
- [ ] Typed transport refusal remains fail-closed.
- [ ] No package code or static prompt uses review authority to decide, authorize, rewrite, or block delivery commands.

← [Back to README](../README.md)
