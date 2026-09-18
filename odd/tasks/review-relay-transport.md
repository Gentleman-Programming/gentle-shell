# Review Relay Transport: selectable, authenticated, diagnosable reviewer

Issues: gentle-shell#1140, #1156, #1158, #1136 — one class, four symptoms: the
`pi_host_relay` reviewer child is launched with a frozen argv that (a) runs
`--mode text` where a model that answers with a tool call produces zero bytes
and exit 0 (#1140), (b) reports that silence with no reviewer-side evidence
(#1156), (c) disables extension discovery so provider auth adapters (Claude
OAuth subscription billing header) never load (#1158), and (d) never forwards
the user-owned lens model assignment, so every lens runs the ambient default
(#1136).

## Objective

One reviewer launch path that is diagnosable when it fails, runs the model the
user assigned to the lens, and loads exactly the user-named extensions needed
for provider auth — with the default behavior unchanged (no model flag, no
extensions) for hosts that need nothing.

## Constraints

- The relay contract stands: prompt bytes, schema, admission, and submission
  stay provider-owned; the host never parses findings or rebuilds the form.
  Parsing pi's own JSON event stream in the adapter is a transport boundary,
  not prompt/schema knowledge.
- Isolation flags stay: `--no-tools`, `--no-extensions` (explicit `-e` paths
  still load under it, per pi's CLI), no session, no skills, no context files.
- Model and extension selection is user-owned config only; the relay never
  invents a model and never enables extension discovery.
- Technical artifacts in English.

## Design

1. **JSON event transport (#1140).** The adapter runs the reviewer with
   `--mode json`, parses the newline-delimited pi event stream, and emits the
   final assistant text as its result bytes — the same bytes text mode would
   have printed. A model that spends events on tool calls no longer silences
   the transport; only a run with no assistant text at all fails, and it fails
   typed with evidence (resolved model, tool-call-attempted, stdout kind).
2. **Evidence in the envelope (#1156).** `pi-empty-output` and every `pi`
   transport failure carries reviewer evidence and any stderr, so the operator
   sees why the child was silent instead of a bare kind code.
3. **Lens model forwarding (#1136).** `ReviewHostRelayRequest` gains an
   optional `reviewerModel`; the adapter passes `--model <id>`. The extension
   resolves it from the user-owned model routing config under the lens's agent
   name (`review-<lens>`), never from ambient defaults.
4. **User-owned extension allowlist (#1158).** An optional allowlist of
   absolute extension file paths, resolved from the
   `GENTLE_PI_REVIEW_RELAY_EXTENSIONS` environment variable (path-separator
   separated), is forwarded as explicit `-e <path>` arguments. Missing or
   relative paths fail typed before any process launches.

## Tasks

- [x] RELAY-1 — RED: adapter tests lock the json-event extraction, the
      evidence-carrying empty-output failure, and `--mode json` in the argv.
- [x] RELAY-2 — GREEN: adapter implements json event extraction + evidence.
- [ ] RELAY-3 — RED/GREEN: relay forwards `reviewerModel` and
      `reviewerExtensionPaths` to the adapter; typed validation (model id
      pattern, absolute extension paths) before launch.
- [ ] RELAY-4 — RED/GREEN: the extension resolves the lens model from the
      routing config and the extension allowlist from the environment, and the
      failure report carries reviewer evidence.
- [ ] RELAY-5 — Docs (`docs/review-integration.md`) + full suite + typecheck +
      live relay smoke if a review candidate is available.

## Progress

- 2026-09-18: feature authorized by the maintainer ("fix these four, one fix
  if possible"). Exploration found: pi `--mode json` emits a parseable event
  stream whose final `message_end` carries the assistant text (verified live);
  `--no-extensions` preserves explicit `-e` paths (pi --help); the lens agent
  names in the model routing config are `review-{risk,resilience,readability,
  reliability}`. A pi-side finding was recorded separately: a fresh
  `pi --print --model <catalog-provider>/<id>` can fail model resolution while
  the same model appears in `--list-models` and drives the default selection;
  the relay fix therefore treats a child model-resolution failure (exit 1,
  "not found" stderr) as a first-class diagnosable outcome, and the pi-side
  race gets its own upstream report.

- 2026-09-18 RELAY-1/2: RED first (missing export), then GREEN —
  `node --experimental-strip-types --test tests/opaque-pi-reviewer-adapter.test.ts`
  12 passed, 0 failed. The adapter runs `--mode json`, extracts the assistant
  text from `message_end` events, and reports typed evidence (`stdoutKind`,
  `reviewerModel` from the child's own events, `toolCallAttempted`) on every
  empty-output failure. Caller-owned launch arguments ride the frozen argv
  verbatim and are validated non-empty before spawn. The identifier guard test
  gained one documented exception: pi's quoted wire key for the selection the
  child reports is data, stripped before the scan.
