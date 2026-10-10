# Gentle AI review integration architecture

← [Back to README](../README.md)

Gentle Pi is a transport consumer, not a review authority. Gentle AI generates the current runtime contract; the package forwards the bounded work it receives and preserves the provider's outcome.

## Ownership boundary

| Component | Responsibility |
| --- | --- |
| In-process reviewer completion | A pure completion (`lib/inprocess-reviewer.ts`): resolves the lens's "provider/id" selection through the live model registry, authenticates through the registry's own resolver, and completes the Go-materialized prompt as one frozen user message — no systemPrompt, no tools, no session, no extension hooks, no child process. |
| Host coordinator | Executes the exact Go-issued materialize/submission tokens, runs the completion through the caller-supplied model registry, and submits its result only through the supplied token. |
| Gentle AI (Go) | Go owns worktree, lineage, candidate freeze, lens selection, correction, validator, approval burn, and review semantics. Delivery commands remain ordinary repository-policy operations. |

The completion does not parse bindings, select work, rebuild prompts, inspect repository state, retry, classify results, or create authority. The coordinator does not infer a command or replace a provider-issued token. The package has no durable receipt or policy authority.

## Transport behavior

1. Gentle AI emits an opaque materialization or submission token for the selected Pi runtime.
2. The host coordinator executes that exact token and gives only the materialized bytes to the completion, as the single user message of one frozen prompt.
3. The completion resolves its "provider/id" selection through the live model registry, authenticates, and returns the completion's text to the coordinator. A run that produced no text, attempted a tool call, or exceeded its bound fails typed with evidence (the completion's stop reason, its aborted/timed-out signal, or its reviewer model, depending on the code); a run over the fixed output bound also fails typed.
4. The coordinator sends that text only through the exact Go-issued submission token.

## Reviewer completion selection (user-owned)

There is no model flag, no extension allowlist, and no ambient default model: the in-process completion resolves entirely through the caller-supplied model registry (`ctx.modelRegistry`), and a missing registry or an unconfigured lens is refused typed as `reviewer-config-invalid` before materialize ever runs, never a mid-review transport failure.

- **Lens model and thinking level** — the capture path reads the lens's entry from the agent model routing config (`review-risk`, `review-resilience`, `review-readability`, `review-reliability`) and forwards its `model` and `thinking` fields verbatim to the completion. A routing entry with no configured model is refused typed, naming the routing key — the completion never falls back to another provider or an ambient default.

A typed reviewer refusal fails closed. The coordinator reports the refusal — including the completion's evidence — without an agentless lifecycle fallback, local retry policy, synthetic result, or alternate approval path.

## Refuter and targeted validator

The refuter and targeted-validator roles are host-mediated in-process completions too, on a provider that advertises the v9 role contract: the collect input carries `--materialize=true` and a provider-owned submission descriptor, exactly like a lens capture-result materialize slot — materialize, complete in-process, then submit through the exact `--input` form. Their entries in the agent model routing config, `review-refuter` and `review-validator`, select the model and thinking level the same way `review-<lens>` does for a lens; a missing entry is refused typed, naming that key, before materialize ever runs.

An older provider that has not advertised the v9 role contract still renders each role as a self-contained vector (binding tokens plus `--agent=pi --execute=true`, no submission): executing that exact vector makes Go materialize the role prompt, run its own locked-down pi subprocess, and admit the verdict itself. The host still accepts this compatibility form unchanged.

## Dynamic contract delivery

Package static assets intentionally omit lifecycle instructions, candidate routing, recovery procedures, receipt semantics, and any delivery-gate or delivery-authorization behavior. Since Gentle AI stopped generating Pi APPEND_SYSTEM composition, Gentle Pi mirrors the provider contract bundle's `orchestration/pi.md` review execution contract locally (`contracts/review-provider-contract-mirror/`) and injects that verified, mirrored text into the primary session's system prompt at session start. Gentle AI writes nothing into the Pi system prompt; the host follows only that mirrored contract. When the mirrored contract is absent or unreadable, Gentle Pi does not invent a fallback; delivery remains ordinary repository policy.

## Integration constraints

- Keep the completion frozen: raw prompt bytes in as one user message, the completion's text or a typed, evidenced error out.
- Preserve Go-issued materialize and submission tokens exactly; they are the only authority-bearing inputs the host may execute.
- Keep the reviewer completion selection user-owned: it never invents a model or falls back to another provider or an ambient default; it only forwards the validated caller-owned selection and thinking level, or refuses typed.
- Treat a reviewer refusal as unavailable evidence, never as an approval, completion, or permission to substitute a local workflow.
- Keep command safety and user interaction in the host, without interpreting provider authority state.
- Keep durable review state, admissions, correction accounting, and approvals in Gentle AI. Keep delivery decisions in ordinary repository policy.

## Review checklist

- [ ] The completion still takes raw prompt bytes as one frozen user message and returns text or a typed, evidenced error — no child process, no extension allowlist.
- [ ] The coordinator executes only exact Go-issued materialize/submission tokens.
- [ ] The reviewer completion selection stays refused typed unless the caller-owned model registry and a configured lens selection validate.
- [ ] Typed reviewer refusal remains fail-closed.
- [ ] No package code or static prompt uses review authority to decide, authorize, rewrite, or block delivery commands.

← [Back to README](../README.md)
