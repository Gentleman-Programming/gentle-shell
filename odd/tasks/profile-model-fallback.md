# Profile model fallback

Objective: each agent in a profile gets an ordered list of fallback models, and a run that hits an exhausted or failing model moves on to the next one by itself.
Branch: `feat/profile-model-fallback` (from `origin/main` 813ec1106). Delivery: feature-branch chain of work-unit slices, then one PR to main (the user asked for PR and merge: "pr y merge cuando termines todo"). Test runner: `node --experimental-strip-types --test`, typecheck `node scripts/check-types.mjs`.

## Specs

- **S1 Chains per agent.** "La idea principal es que vos puedas elegir tus modelos para cada agente en un perfil." Each profile can give every agent (the `orchestrator` included) an ordered fallback chain, plus a `*` chain for the agents without one. Chains live in their own file, `profile-fallbacks.json`, next to `profiles.json`. Accepted recommendation: older versions keep reading `profiles.json` untouched and simply do not fall back.
- **S2 When to move on.** "si alguno de ellos se quede sin tokens, pueda automáticamente pasar al siguiente, al fallback". Error categories decide:
  - `quota`: move on at once.
  - `rate_limit`, `provider_unavailable`, `timeout`, `network`: move on once Pi's own retries are spent.
  - `auth`: move on, because that model cannot be used.
  - Never move on for `context_length`, `invalid_request`, an unknown error, or an abort.
  - Only models the user put in the chain are used.
- **S3 Continue in place.** Accepted recommendation: switch the model and continue the same conversation instead of restarting.
  - Subagents: RPC `set_model` (+ `set_thinking_level`) and a continue prompt in the same child.
  - Orchestrator: `pi.setModel` and a continue message.
- **S4 Shared cooldown.** Accepted recommendation: a model that ran out is skipped by every agent of the session for a while. Accepted extra: when `/gentle:usage` shows its window full, skip it before it fails.
- **S5 Visible and recorded.** Accepted recommendation:
  - Each switch notifies, saying when the next model costs more.
  - Each switch is appended to the session as `gentle-pi.model-fallback/v1`.
  - The agent's row shows `↪ <model>`.
- **S6 Editing in `/gentle:profiles`.** Accepted recommendation: each agent shows its chain on one line; `f` adds a model, shift+↑/↓ reorder, `x` removes one.

## Tasks

| ID | Specs | Route | Status | Evidence |
|----|-------|-------|--------|----------|
| T1 | S1 | inline | done | `lib/model-fallback-store.ts`: own file `profile-fallbacks.json`, strict reader (kind/version, safe ids, effort, unique models, ≤8), `chainFor` with `*`, `setChain`, `renameProfileFallbacks`; RED module missing → GREEN 5/5; typecheck 0 |
| T2 | S2, S4 | inline | done | `lib/model-fallback-policy.ts`: `shouldFallBack` by category (terminal errors arrive after Pi retries), `ModelCooldown` (exhausted 30 min, transient 2 min) shared per process, `pickModel`; RED → GREEN 3/3; typecheck 0 |
| T3 | S3, S5 | inline | pending | subagents: runner switches the child in place; session entry + notice |
| T4 | S3, S5 | inline | pending | orchestrator: main session switches and continues |
| T5 | S6 | inline | pending | `/gentle:profiles` chain editing |
| T6 | S4 | inline | pending | proactive skip from `/gentle:usage` windows |
| T7 | S5 | inline | pending | agent row `↪ model` (after the shell rework lands on main) |
| T8 | S1–S6 | inline | pending | README and docs |

## Log

- L1 (user, 2026-11-03): "Mientras que se trabaja en eso, podrías ver la posibilidad junto con un diseño de poder hacer fallback en los modelos para los perfiles. La idea principal es que vos puedas elegir tus modelos para cada agente en un perfil. Y que esos mismos, si alguno de ellos se quede sin tokens, pueda automáticamente pasar al siguiente, al fallback"
- L2 (research): profiles already route a model and effort per agent (`profiles.json`, `gentle-pi.agent_model_profiles` v1, `{ model?, thinking? }`, the `orchestrator` key included), and applying one materializes a single model into `models.json`, `subagents.json` and frontmatter.
  - Pi has no quota failover: its `fallbackModel` only covers a saved model it cannot restore at startup.
  - `pi-ai/utils/retry.js` classifies errors in two groups: limit errors (quota, billing, usage limit) are not retried; transient ones (429, rate limit, overloaded, 5xx) are retried on the same model with backoff.
  - The child RPC supports `set_model`, `set_thinking_level` and `prompt`. The extension API has `pi.setModel` and `pi.sendUserMessage`.
  - `lib/agents-protocol.ts` already reduces a child's terminal error to a closed category (`TERMINAL_ERROR_CATEGORY`) without keeping the provider text.
  - Strict readers reject unknown keys, so a key inside `profiles.json` would make older binaries reject the file.
- L3 (user, 2026-11-03): "implementalo" — the recommendations above (separate file, design points 1–6) are accepted.
