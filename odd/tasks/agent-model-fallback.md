# Automatic Gemini Model Fallback

## Authorization and scope
The user explicitly selected automatic fallback, not replacement of primary models. Preserve every primary model and its configured effort. Use `cli-proxy-api/gemini-3.8-flash-high` with `high` effort as the fallback. Cover child sessions, in-process reviewers, and the parent session where the installed Pi API safely supports it; report unsupported routes explicitly.

## Safety and acceptance
- At most one fallback attempt for eligible model-provider failures: quota/rate limit, transient service unavailability, or interrupted model transport.
- Never activate on cancellation, user refusal, tool/capability denial, malformed review authority, context overflow, or invalid request.
- Preserve the live transcript and completed tool results. Never restart tasks, replay successful writes, or execute incomplete streamed tool calls.
- Preserve provider-owned review bindings and attribute the actual producing model accurately.
- Keep credentials private, primary profiles intact, and unrelated settings unchanged.
- Use deterministic fake-provider tests with observed behavior RED then GREEN; no paid model probes or live quota exhaustion by default.
- Each complete delivery slice is at most 400 changed lines, including tests and documentation.

## Tasks
- [ ] FB-1: Record installed SDK routing evidence and constraints; first documentation work-unit commit is pending.
- [ ] FB-2: Implement and test bounded provider-error eligibility and one-fallback-attempt policy. First source work unit; no activation yet.
- [ ] FB-3: Integrate and verify in-process reviewer fallback while preserving native bindings and actual model attribution.
- [ ] FB-4: Integrate safe child/parent fallback and activate authorized routes only after same-session/no-replay tests; report unsupported cases.

## SDK evidence and constraints
- Virtual-model retry is supported: installed `agent-session.js:1391` prepares retry, and `:424-453` forwards the failed assistant message to virtual resolution with the existing transcript. Concrete model bindings do not enter that route (`:445-446`).
- The extension API accepts a resolved model object, not `setModel(string)`. A child extension/provider wrapper is a possible integration surface, not yet an implemented or proven stream-interruption solution.
- `lib/inprocess-reviewer.ts` calls the provider directly. Provider result text can follow the existing native submission binding; producing-model attribution must remain accurate. Observation of unchanged tokens is not blanket authorization for another reviewer identity.
- Automatic fallback on arbitrary stream disconnection is not proven by virtual retry alone. Do not implement speculative after-settle task replay or silently claim all routes work.

## Progress and delivery boundaries
- Branch: `feat/model-gemini-fallback`, based on `a6e905e8` from `test/sec-tdd-dispatch`. Do not add fallback code to the SEC-8 slice.
- SEC-8 functional evidence: independent 363/363 tests, package and whitespace PASS; its whole slice is 349 lines. Commits: `b7ace465`, `a6e905e8`. Native review of the second unit remains pending: two consent bindings expired with `lineage_created: false`; neither was a decline or approval. No push, PR, or merge performed.
- No automatic fallback source changes or activation have been performed. Primary model settings remain unchanged.
