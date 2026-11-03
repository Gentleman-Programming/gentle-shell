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
| T3 | S3, S5 | inline | done | runner `fallBack` on AGENT_SETTLED (category from AGENT_END), RPC set_model + set_thinking_level + continue prompt, cooled primary skipped at launch; gentle-agents passes the resolved profile's chain and notifies + records `gentle-pi.model-fallback/v1` (`lib/model-fallback-notice.ts`, price note via `computeModelPriceRatio`); RED runner 3 + notice 2 + integration 1 → GREEN; agents 688/688; typecheck 0. Risk: item 4 (runner settle path, async ordering) → independent verifier |
| T4 | S3, S5 | inline | done | `lib/orchestrator-fallback.ts` (episode until a turn succeeds; skips models outside Pi's catalog or refused by `setModel`), wired on gentle-agents `agent_end` (never in children, `GENTLE_PI_AGENTS_CHILD=1`), `pi.setModel` + `setThinkingLevel` + follow-up resume; `assistantErrorCategory` exported from agents-protocol; shared `announceFallback`; RED 4 unit + 1 integration → GREEN |
| T5 | S6 | inline | done | `RoutingTablePanel` fallbacks card (`f` opens; `f` add, `e` effort, shift+↑↓ move, `x` remove, esc back), rows show `↪ first +N`, `*` on the every-agent row, saved at once via `fileRoutingFallbacks` (never overwrites a broken file), rename/delete follow (`followProfileRename`); hint `f fallbacks` takes priority over `n new`/`m menu` at 100 cols (both stay visible as tabs). RED 2 panel → GREEN; `followProfileRename` test written with its code (no RED observed); gentle-ai 166/166; typecheck 0 |
| T6 | S4 | inline | done | `syncUsageCooldown` marks a provider until its earliest full window resets (exhausted wait when no reset), room releases it, a model's own failure stays; `ModelCooldown.markProvider`; `UsageStore(onRecord)` wired in gentle-shell. Applies at subagent launch; the orchestrator still switches on failure. RED 2 → GREEN; gentle-shell 336/336; typecheck 0 |
| T7 | S5 | inline | blocked | agent row `↪ model`: waits for the shell rework chain (#2774–#2790, tracker #2791) to land on main |
| T8 | S1–S6 | inline | done | README profiles section points to `docs/readme-reference.md#model-fallback-chains` (format, triggers, cooldown, usage skip, `/gentle:profiles` keys) |

## Log

- L1 (user, 2026-11-03): "Mientras que se trabaja en eso, podrías ver la posibilidad junto con un diseño de poder hacer fallback en los modelos para los perfiles. La idea principal es que vos puedas elegir tus modelos para cada agente en un perfil. Y que esos mismos, si alguno de ellos se quede sin tokens, pueda automáticamente pasar al siguiente, al fallback"
- L2 (research): profiles already route a model and effort per agent (`profiles.json`, `gentle-pi.agent_model_profiles` v1, `{ model?, thinking? }`, the `orchestrator` key included), and applying one materializes a single model into `models.json`, `subagents.json` and frontmatter.
  - Pi has no quota failover: its `fallbackModel` only covers a saved model it cannot restore at startup.
  - `pi-ai/utils/retry.js` classifies errors in two groups: limit errors (quota, billing, usage limit) are not retried; transient ones (429, rate limit, overloaded, 5xx) are retried on the same model with backoff.
  - The child RPC supports `set_model`, `set_thinking_level` and `prompt`. The extension API has `pi.setModel` and `pi.sendUserMessage`.
  - `lib/agents-protocol.ts` already reduces a child's terminal error to a closed category (`TERMINAL_ERROR_CATEGORY`) without keeping the provider text.
  - Strict readers reject unknown keys, so a key inside `profiles.json` would make older binaries reject the file.
- L3 (user, 2026-11-03): "implementalo" — the recommendations above (separate file, design points 1–6) are accepted.
- L4 (T3): a terminal error reaches the runner only after Pi's own retries, so the decision is the error category alone. The continue prompt keeps the child's conversation; a step without a provider cannot be selected over RPC and is skipped. The chain is the launch's resolved profile (binding, frozen, pin), else `profiles.json` `active`.
- L5 (verifier on 3290bcdd4): no blockers; 688/688; races (cancel, stall, exit, duplicate settle during the switch) end the task once; with no `fallbacks` the runner is byte-identical to c92647da4. Advisories: A1 the launch-time swap was silent; A2 a `set_model` Pi rejects failed the task instead of trying the next step; A6 the notice was not gated to the owning session; A7 a session frozen without a profile takes the active profile's chain; A9 a step without effort leaves `task.thinking` stale; A10 the cooldown is keyed by model only (an auth cooldown outlives a fixed key for 30 min).
- L6 (correction): A1 — the cooldown remembers why (`reason`), a launch on a fallback is announced ("is still cooling down after …; starting on …") and recorded; A2 — a refused `set_model` walks to the next step, and only the model actually switched to is announced and stored; A6 — notice and entry only for the owning session. RED 3 → GREEN; agents + profiles suites green; typecheck 0. A7, A9, A10 stay advisories.
