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
- [x] FB-1: Recorded installed SDK routing evidence and constraints in commit `19f2a196`.
- [x] FB-2: Implement and test bounded provider-error eligibility and one-fallback-attempt policy. First source work unit approved and acknowledged; no activation yet.
- [/] FB-3: Integrate and verify in-process reviewer fallback while preserving native bindings and actual model attribution; read-only mapping underway.
- [ ] FB-4: Integrate safe child/parent fallback and activate authorized routes only after same-session/no-replay tests; report unsupported cases.

## SDK evidence and constraints
- Virtual-model retry is supported: installed `agent-session.js:1391` prepares retry, and `:424-453` forwards the failed assistant message to virtual resolution with the existing transcript. Concrete model bindings do not enter that route (`:445-446`).
- The extension API accepts a resolved model object, not `setModel(string)`. A child extension/provider wrapper is a possible integration surface, not yet an implemented or proven stream-interruption solution.
- `lib/inprocess-reviewer.ts` calls the provider directly. Provider result text can follow the existing native submission binding; producing-model attribution must remain accurate. Observation of unchanged tokens is not blanket authorization for another reviewer identity.
- Automatic fallback on arbitrary stream disconnection is not proven by virtual retry alone. Do not implement speculative after-settle task replay or silently claim all routes work.

## Progress and delivery boundaries
- Branch: `feat/model-gemini-fallback`, based on `a6e905e8` from `test/sec-tdd-dispatch`. Do not add fallback code to the SEC-8 slice.
- SEC-8 functional evidence: independent 363/363 tests, package and whitespace PASS; its whole slice is 349 lines. Commits: `b7ace465`, `a6e905e8`. Native review of the second unit remains pending: two consent bindings expired with `lineage_created: false`; neither was a decline or approval. No push, PR, or merge performed.
- FB-2 adds a standalone eligibility/attempt policy; no runtime integration or activation has occurred. Primary settings are unchanged; a manual bounded Gemini writer was used after Terra SSE disconnection.
- FB-2 TDD: Observed assertion RED on initial stub (1 failed, 'stop'!=='fallback'), GREEN (5 passed); hardening round observed 3 RED on numeric code regex, conflicting origin, and missing availability, then 5 GREEN. Package and diff checks clean.
- Independent verifier `musjf3fg-t-ydeh`: fresh 5/5 PASS; package 156 files/69 pinned artifacts; staged/base whitespace clean; complete slice 359 lines before this passive evidence update. Current tests cover every previously named category; the prior uncommitted test formatting cannot be independently reconstructed.
- Native START for hardened policy was blocked by expired consent `2c04688d-2c62-4eae-93e5-9135006a9474`: no lineage, no authority mutation, neither approval nor decline. FB-2 closure remains pending a fresh human consent/disposition.
- Local policy work-unit commit: `ffbf2efb` (`feat(agents): add bounded Gemini fallback policy`). Functional checks pass, but this is not native approval or runtime activation. No push, PR, or merge; FB-3/FB-4 remain unimplemented.
- Subsequent bounded native review `review-01d1697f5a239fc7` approved and exact acknowledgement burned target `sha256:84340f408d26fd5ae361ec6c4f6a7cda5d87a7842581870026e79d1b64b55133` (338 review lines; base `19f2a1965701b600c066d2d8a34987a682a24ec0`). FB-2 is closed; previous expired consent is historical. Runtime integration remains pending. Next reviewer unit must use a new stacked branch, excluding this policy slice.
