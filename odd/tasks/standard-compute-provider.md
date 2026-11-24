# gentle-shell — provider nativo Standard Compute

Fuente: el humano pidió analizar y crear el código para utilizar el provider de
`https://standardcompute.com/dashboard/sdks` en `gentle-shell` **nativo**, y crear
documentación completa para `gentle-shell`.

## Contexto

- El provider es **Standard Compute**: una API compatible con OpenAI y Anthropic para
  coding agents que enruta cada request al modelo más capaz/capaz según el presupuesto.
- Documentación consultada (fuente primaria): `docs.standardcompute.com/api`,
  `docs.standardcompute.com/quickstart`, `docs.standardcompute.com/models`,
  `docs.standardcompute.com/authentication`, `docs.standardcompute.com/api/errors`.
- Hechos verificados:
  - Base URL OpenAI-compatible: `https://api.stdcmpt.com/v1`; Anthropic: `https://api.stdcmpt.com`.
  - Endpoints: `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`,
    `POST /v1/messages/count_tokens`, `POST /v1/completions`, `GET /v1/models`.
    Embeddings/image/audio no disponibles.
  - Smart routing: enviar `model: "standardcompute"` (o omitir el campo); el router elige
    entre los modelos habilitados por preferencia de calidad. Respuesta `model` = `StandardCompute`.
    Alias Claude: `anthropic/claude-standardcompute`.
  - Pinning: IDs exactos (`anthropic/claude-sonnet-5.5`) o cortos (`claude-sonnet-5.5`); el
    pinning overridea la selección del dashboard; fail-over solo dentro del mismo modelo.
  - Errores: `400 model_not_found`, `400 invalid_model`, `400 unsupported_model_input`,
    `400 data_policy_restriction`, `400 unsupported_parameter`; `401` key inválida; `402 budget_exhausted`/
    `free_quota_exhausted`/`payment_required`; `403 company_access_denied`; `429 rate_limit_exceeded`;
    `503 service_unavailable`. OpenAI-style en endpoints OpenAI, Anthropic-style en Messages.
  - Auth: `Authorization: Bearer $STANDARDCOMPUTE_API_KEY` (Messages también acepta `x-api-key`).
  - Env var: `STANDARDCOMPUTE_API_KEY`.
  - Pricing: planes desde Starter a $19/mes; contexto hasta ~1M tokens.

## Specs

- **S#1** Integración nativa del provider: `lib/standard-compute-provider.ts` expone
  `createStandardComputeProviderConfig()` → `Provider<"openai-completions">` con id
  `standardcompute`, baseUrl `https://api.stdcmpt.com/v1`, modelo smart-routing
  `standardcompute`, auth api_key con fallback a `STANDARDCOMPUTE_API_KEY`, login por prompt,
  resolve (stored → env), stream vía `lazyApi(openAICompletionsApi)`, refresh de catálogo.
- **S#2** Descubrimiento: refresh vía `GET /v1/models` con Bearer key; fallback offline al
  modelo smart-routing; lista vacía exitosa es autoritativa; fallos preservan fallback.
- **S#3** Auth: stored credential tiene precedencia; env fallback; clave vacía rechazada;
  trim; abort; fuente legible (`API key` / `STANDARDCOMPUTE_API_KEY`).
- **S#4** Reasoning: modelo smart-routing declara reasoning; Pi niveles (`off`…`max`);
  `off` omite `reasoning_effort`; efforts pasan por `reasoning_effort`.
- **S#5** Tests: `tests/standard-compute-provider.test.ts` (registro, login, resolve, catálogo,
  refresh, stream) siguiendo el patrón de `tests/nan-provider.test.ts`.
- **S#6** Documentación: sección completa del provider en README y referencia de docs para
  `gentle-shell`.

## Tasks

- T1 [ ] S#1, S#5 — RED/GREEN provider factory + registro nativo.
- T2 [ ] S#2 — catálogo fallback/offline y refresh live.
- T3 [ ] S#3 — auth (login/resolve).
- T4 [ ] S#4 — reasoning/thinking levels y payload de stream.
- T5 [ ] S#6 — documentación completa.

## Log

- Pendiente de implementación.
