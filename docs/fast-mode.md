# Request Fast mode

Use `/gentle:profiles` to save **Standard** or **Fast** per compatible model route. Select a row and press `t` (or click the tier) to switch it, then save and choose **Use in this session**. The profile's session snapshot restores the selection when the session is resumed. **Make default** applies the choice now and supplies the orchestrator tier for new sessions; already-running sessions keep their frozen startup default unless they apply a profile themselves. Child and direct routes use their own configured tiers.

After installing or updating the extension, run `/reload` to load it. The footer distinguishes the requested tier from the last server response's `service_tier`. A fresh or reloaded session has no observation until a matching response arrives.

- Older profiles without a tier keep existing request behavior and clear a previous profile selection when applied. An explicit profile session snapshot restores its tier on reload or resume. Changing the model or selected tier clears the observation.
- A last terminal response tier of `priority` or `fast` confirms the server reported Fast for that response; `default` reports Standard. This includes incomplete responses. If the tier is missing or unrecognized, Fast cannot be confirmed. A missing tier is reported as unknown, never inferred from the requested tier. This is a response observation, not confirmation of billing, future requests, or account eligibility. Some transports may not expose the event at all.

## Availability and cost

OpenAI documents that Codex Fast uses **2.5x included subscription usage** or **2x purchased credits**. API use follows its own pricing, not those subscription multipliers. Check your account, plan, model availability, and current [Codex Fast documentation](https://developers.openai.com/codex/speed) and [API pricing](https://openai.com/api/pricing/) before use. Pi's local cost estimates may not reflect actual tier, subscription quota, or billed charges; consult OpenAI for authoritative usage and billing.

The selector applies only to `openai` / `openai-responses` (including native ChatGPT sign-in) and `openai-codex` / `openai-codex-responses` (legacy sign-in), for these model IDs: `gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-6.1-sol`, and `gpt-6.1-terra`. This conservative list reflects the installed model catalog and OpenAI's documented Codex Fast family; it is not an entitlement check. Other providers, APIs, and models are untouched. A profile tier belongs only to its selected model and clears when you switch to a different model.

Fast sends `service_tier: priority`; Standard sends `service_tier: default`, clearing a previous Fast request on supported models. Other payload fields are preserved. The server may reject or handle a request differently; the extension does not retry or automatically fall back. It reads only the tier from the raw terminal response event without storing or logging the response. Native response-tier accounting remains unchanged and may depend on the provider's response. Other extensions can also alter a request later in the chain.
