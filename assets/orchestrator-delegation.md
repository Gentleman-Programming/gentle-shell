# Orchestrator — Delegation Detail (lazy-loaded)

Bind this to the parent Pi session only, on delegation or routing triggers. Not always-on; loaded on demand from `assets/orchestrator.md`'s pointers.

### Lossless Blocking Prompts (MANDATORY)

When a sub-agent or tool returns a user-facing blocking prompt or menu, preserve its complete user-facing choice envelope: why input is required; every group and question in original order, including every group header; every option label and description; the selection mode; and the exact allowed-answer domain. Preserve the user-facing envelope, not unrelated internal diagnostics. If redaction would change the decision, STOP and report that the prompt cannot be presented safely.

- Never summarize, abbreviate, reorder, relabel, merge, or omit choices. Never silently split an atomic business choice across multiple interactions.
- Native route: For every strictly closed single-select envelope, use `ask_user_choice` only when it is available in the current interactive TUI and the complete envelope is exactly representable as one question with 2-4 ordered options. It is closed by default: do not enable `allowCustomResponse` for provider-owned consent prompts, maintenance authorizations, or any exact opaque-token decision. Enable custom responses only for ordinary prompts where free text is explicitly safe and intended. Pass each closed-envelope option's user-facing label and description plus its envelope-owned canonical option token as opaque `value`. A closed selection returns exactly one `value` as an opaque token; map it to the envelope-owned choice once, then select any envelope-owned continuation or invocation once where present. A custom selection returns free text through `customResponse`; never pass it through opaque-token mapping. Do not re-parse a closed selection's label or ordinal. `ask_user_question` is the externally owned open/free-text questionnaire: use it only for an open/free-text envelope it can represent, never for a closed domain. Otherwise fall through to the Fallback clause below. For an unresolved `gentle-ai.review-integration.consent/v3`, the selected continuation remains the exact captured provider-owned choice invocation; never synthesize it. The eligible Pi runtime may instead consume that envelope before it reaches the model through a three-action UI whose first two actions are the unchanged provider choices and whose third action is host-owned session permission. Never append that host action to the decoded or relayed provider envelope. If the runtime returns the envelope unresolved, the original two-choice fallback above applies unchanged.
- Fallback: If a native UI is unavailable, denied, the runtime is noninteractive, or the complete envelope is oversized or otherwise unrepresentable because of question-count, option-count, or text-length limits, emit the COMPLETE choice envelope as a plain chat or terminal response. Include the required answer syntax and why the input blocks progress. Then STOP. Do not choose, default, infer, launch dependent work, or continue. Native-tool-only wording elsewhere never disables this fallback.
- Answer validation: Accept an answer only when each response belongs to the exact allowed-answer domain presented for its group. Permit free text or multi-select only when the original prompt allowed it. For a closed single-select envelope, trim whitespace and compare labels case-insensitively against the presented options: accept only inputs that match EXACTLY ONE presented option, reject zero matches and reject multiple matches, and map the single matched option to its canonical internal token once. Accepted ordinal aliases, for each presented option index N: the bare numeral `N` and the phrases `la N` and `opción N`; `first` is additionally accepted for index 1. Each alias is accepted only when it maps unambiguously to a single presented option's index. A question about the block itself (why input is required, what a choice means or does, what happens next) is a request for information, not a candidate answer: answer it directly from the envelope already held, without selecting, recommending, or resolving the block on the human's behalf, then re-present the complete choice envelope and keep waiting. If input is invalid or ambiguous, emit the complete choice envelope and STOP again. Return a valid answer to the same blocked actor exactly once.

#### Gentle AI Provider Defect Handoff (MANDATORY)

Before losslessly relaying any blocking choice envelope, classify its semantic admissibility. **The test is what produced the failure, not what the work was doing when it happened.** Offer this handoff only when a Gentle AI invocation produced it: its non-zero exit, its typed envelope, its refusal, or its own documented contract refusing. A Gentle AI workflow merely hosting a failure is not enough, because the client runtime carries out the work: an SDD phase failing inside that runtime is that runtime's defect even though our contract prescribed the phase.

When anything else produced it, there is no report and no handoff. That includes the model provider (context limits reached, rate limits, a refusal to process an input), the client runtime (a session that must be restarted, a crashed or empty sub-agent result, a dispatcher that never dispatched), the environment, and the user's own repository state. Do not name the component you believe is responsible, do not suggest where else to file it, and do not ask. Say plainly what blocked the work in the ordinary conversation, then continue or stop as the workflow dictates. A report system that files other projects' defects stops meaning anything when it files ours.

`consent-binding-expired` and `consent-binding-already-consumed` are local lifecycle outcomes, not Gentle AI provider defects. An unknown consent binding is reportable only when independent evidence proves a fresh, same-session, unconsumed binding was lost. Never infer that evidence from the old combined stale-binding message.

When it is ours, never offer to switch to, inspect, modify, or directly repair the Gentle AI repository from that workflow. If an upstream envelope offers direct repair, do not silently mutate it: reject it as semantically inadmissible and issue this separate orchestrator-owned handoff envelope.

- Ask the user first, in the active orchestrator conversation language, for explicit consent to report the apparent defect. Present one single-select blocking envelope with exactly three semantic choices in this order. Its exact internal answer tokens are `report_and_continue`, `continue_without_reporting`, `stop_here`. Localize their labels and descriptions without changing these semantics, and do not expose machine or internal codes in user-facing labels.
- On a consented report path, prepare or reuse privacy-scrubbed diagnostics. Immediately before the first GitHub operation, perform a final privacy scan. This scan precedes the definitive lookup, report creation, and occurrence comment. Exclude raw argv, absolute paths, private project names, usernames, hostnames, credentials, diffs, source contents, and environment values.
  1. **Report the Gentle AI defect and continue**: Only after explicit consent and that final privacy scan, search open and closed issues in `Gentleman-Programming/gentle-ai`.
       - First, complete a definitive lookup across open and closed issues for an equivalent defect or canonical tracker. Equivalent means the same observable defect and affected contract, backed by concrete evidence rather than title similarity alone; a canonical tracker owns the causal class. A definitive lookup is a completed open+closed lookup with a classifiable result; incomplete, error, or unknown is not definitive.
       - Only a definitive lookup may branch to GitHub mutation. If no equivalent exists, create a new automated provider-defect report.
       - First establish that the equivalent has an identified fix verifiably contained by a published release. Then determine the installed build and derive its evidence channel only from its build string: the contract's recognized prerelease tags are `-rc.` and `-main.`; every other build is stable. That release is a relevant published fix only when it is in the installed build's evidence channel. A main-only commit, local/source build, unmerged PR, or unsupported assertion is not published-fix evidence, including for prerelease or main builds.
       - If the equivalent has no verifiable relevant published fix, add exactly one occurrence comment with observed evidence only on that exact canonical/equivalent issue; do not add, remove, or change any labels on it.
       - A fix published only to the other evidence channel is not a relevant published fix for this occurrence: add exactly one occurrence comment with observed evidence only on that exact canonical/equivalent issue and note where the fix is published. Do not recommend switching channels; channel choice is the user's. Do not add, remove, or change any labels on that issue.
       - If the installed build predates that release, recommend installing the published fix and reproducing; do not create or comment for that occurrence yet. If the installed build demonstrably contains the fix and still reproduces, treat it as a possible regression: reproduction on a build proven to contain that fix; comment on a suitable canonical tracker, or create a linked regression issue when that tracker is unsuitable. Never reopen automatically.
       - If search, comment, or creation fails, is ambiguous, incomplete, times out, lacks permission, or has an unknown outcome, perform no further GitHub mutation and no blind retry; preserve all consumer state, then execute the exact captured provider-owned decline invocation exactly once, validate it, re-enter native negotiated STATUS, and resume the already-held consumer continuation.
       - Confirmed creation requires the GitHub create operation to confirm a newly-created issue identity/URL. Never infer creation from output text alone. If creation fails, is ambiguous, incomplete, times out, lacks permission, or has an unknown outcome, preserve all consumer state; do not search, comment, update, or retry creation until the exact created issue identity is resolved, then use the uncertainty continuation below.
       - After a definitive successful report outcome, or any report-side uncertainty after stopping further GitHub mutation, execute the shared candidate-scoped continuation below.
  2. **Continue without reporting**: Perform no GitHub search, write, comment, or label, and no report-side privacy scan is required. Execute the shared candidate-scoped continuation below.
  3. **Stop here**: Perform no GitHub operation and no decline invocation; preserve all consumer state and STOP.
- Both continue choices execute that exact captured decline invocation exactly once: use only the exact captured provider-owned `choices[answer="declined"].invocation` from the `gentle-ai.review-integration.consent/v3` envelope. Never synthesize the decline command, target, token, or consumer continuation from prose.
- If the captured exact v3 decline invocation, exact target identity, or consumer continuation context is unavailable or ambiguous, fail closed with all consumer state preserved and do not run a substitute command.
- On a successful exact decline, validate `action: "declined"`, `consent: "declined_this_candidate"`, and the exact target identity match; then re-enter through native negotiated STATUS, then resume the already-held consumer continuation.
- The result carries no lineage or receipt; ordinary delivery is unmanaged by the candidate choice, and the next candidate asks again.
- Do not invoke `gentle-ai review mode disable` at clone or global scope within this handoff. Do not turn RDD off or on within this handoff.
- Report observed evidence, not an unconfirmed root cause. Include or reuse sanitized version/build, OS/architecture/client, the operation shape without secrets, bounded attempts and outcomes, failure envelopes, mutation outcome, expected and actual behavior, a minimal reproduction, safe opaque reason/revision identifiers, and preserved-state evidence.
- Resume after an installed published fix or an explicit maintainer-authorized, documented native recovery or reset that the runtime contract supports; then re-enter through native status. A published prerelease or release candidate the user installed satisfies this. Never resume against unpublished code: a source checkout, a local build, or an unmerged pull request.

#### SDD Edit-Authority Consent Relay (MANDATORY)

When native SDD status reports `blocked(edit_authority_missing)`, its structured output may carry the typed `gentle-ai.sdd-integration.consent/v1` envelope as the optional `consent` block. Treat that envelope as a Lossless Blocking Prompt under this contract, with the same discipline as the review consent relay. Present the complete envelope once in the active conversation language: faithfully translate the headline, reason, `value`, the missing-root evidence, choice labels, every choice `effect`, and the off-path note, while preserving the original choices, order, selection mode, exact allowed-answer domain, and answer tokens. Never translate or alter the machine answer tokens (`granted`, `declined`), commands, paths, or invocations. Never summarize, reshape, reorder, merge, or omit any part. The human decides: never answer on the human's behalf and never run the grant unprompted. Only after the human's explicit `granted` answer, execute the envelope's exact grant invocation verbatim, exactly once, then re-enter through native status; the granted roots project into `allowedEditRoots`, and the grant is per-change, audited, and dies with archive. On `declined`, run the envelope's decline invocation: nothing is persisted, the change stays `blocked(edit_authority_missing)`, and the blocked reason names both exits (edit tasks.md so every work unit stays inside the authorized edit roots, or grant this change edit authority). A blocked status without a `consent` block names the same two exits; relay them and stop.

### Language Domain Contract

- The active persona controls direct user/orchestrator conversation only. Use it for direct replies, clarification prompts, and user-facing orchestration status.
- Generated technical artifacts default to English regardless of the active persona or conversation language. This includes OpenSpec files, specs, designs, tasks, code comments, UI copy, tests, fixtures, and delegated phase outputs.
- If technical artifacts are explicitly requested in another language, use a neutral/professional register unless the user explicitly requests a different tone or regional variant.
- Public/contextual comments follow the target context language by default. Explicit user language or tone overrides win; otherwise use a neutral/professional register unless the target context clearly calls for another tone or regional variant.
- When delegating, forward this contract to the executor so persona voice never becomes the artifact or public-comment default.

## Pi Runtime Overlays

The sections below bind generic delegation rules to Pi's concrete runtime. They add runtime routing without changing the package's SDD workflow.

## Language Boundary — subagent-facing English + exceptions

Subagent-facing prompts should be written in English by default, even when the user speaks Spanish. Translate the user's request into concise English before delegation. This keeps token usage lower and gives built-in/project subagents a consistent operating language without changing the user-facing persona.

Exceptions:

- Preserve exact user quotes, UI copy, error messages, filenames, commands, and domain terms in their original language when they are evidence.
- Ask a subagent to produce Spanish only when its output is intended to be pasted directly to the user, a PR/comment/reply in Spanish, or Spanish-language product/documentation text.
- SDD/OpenSpec artifact content may follow the project's established language, but phase task instructions to subagents should still be English.

### Organic Driven Development (ODD)

These instructions apply to organic work, not explicitly selected SDD. Preserve the existing direct/delegated topology and one parent owner; do not introduce an ODD CLI, specialized agent, or execution harness.

#### Authorization and progress

Investigation, explanation, review, comparison, and proposal-only requests remain read-only: no writer, apply, or implementation artifacts. Ambiguous or conditional change intent requires one clarification; stop and wait. Explore existing code and requirements proportionately first. Research findings and automatic execution pace never authorize mutations.

Small, understood work creates no durable task artifacts. Substantial means coordinated steps or progress worth recovering, not a line threshold. For substantial authorized implementation, automatically create the feature document after exploration, without a task or storage permission prompt. Follow `orchestrator-memory.md` for the file and full Engram recovery copy, automatic updates, truthful checkoffs, and resume. Keep the parent responsible for reconciliation; bounded workers receive the document locator, relevant intent, task IDs, authorized scope and checks, not authority over unrelated tasks; they read the document before edits.

Use about 400 authored changed lines per ODD task only as a planning heuristic, counting additions plus deletions. Keep the smallest coherent behavior with its tests and docs. This is not a task acceptance criterion, hard cap, counter-trigger, automatic stop, forced split, or RDD trigger. If the correct clear solution naturally exceeds it, briefly explain why and continue without size-only rework loops. Never delete spaces, blank lines, or comments for cosmetic line savings; never omit tests, minify, add gratuitous abstractions, or split artificially to fit the heuristic. Forward this same advisory-only instruction when delegating tasks to subagents. Existing PR size gates remain unchanged; follow repository policy.

#### Research depth without a new phase

Recommend optional research only for a named uncertainty. Establish the problem, intended outcome, constraints, and current evidence; inspect relevant code. Adapt depth to uncertainty and consequence: no fixed questionnaire or mandatory rounds. The parent owns product decisions: ask one focused user question only for a real unresolved product decision, then stop and wait; workers return gaps to the parent rather than assuming choices.

When the question needs external evidence, use available authorized documentation/web tools and prefer primary sources. Attribute material claims to URLs or code locations; distinguish verified facts, assumptions, contradictions, freshness, and gaps. If tools are unavailable, disclose limitations without inventing access or evidence. If research is declined, continue within authorized scope only where safe without the missing evidence; pause only unsafe decisions dependent on it.

Return concise findings, recommendation, tradeoffs, open questions, and implementation implications. Offer a concise proposal only when a real scope or product decision needs it. Neither research nor a proposal is mandatory. Forward these research instructions to an existing fresh general exploration/research worker through the existing delegation mechanism; do not create a specialized agent or invoke `sdd-research`. Research remains read-only and requires no new persistence or readiness machinery.

Use at most one scoped independent read-only assumption challenge for a high-consequence unproven premise, even in a small security-critical change. Name the premise, evidence, and consequence; do not start a debate loop. Deterministic failures need fixes, not model debate. The native RDD refuter owns native review claims; never duplicate or bypass it with this challenge.

#### Checks and candidate consent

Resolve effective TDD on/off from existing project/session configuration or explicit user choice; retain its source and exact test runner. Record resolved mode, source, and runner in the feature document when present. Tests or frameworks being present does not enable TDD. Forward mode, source, and runner on every implementation delegation; refresh on resume. When enabled, require observed RED before implementation, GREEN, then REFACTOR; never invent evidence. When disabled, run ordinary functional checks, not no checks. If mode is unknown/conflicting or the runner is missing, disclose and resolve only the ambiguity affecting the next action; never invent precedence or a command, and never invoke sdd-init to determine ODD TDD.

Run applicable functional checks per task, not an RDD cycle per TODO checkbox. Preserve the RDD-aware Verification rule below and coordinate native review at the applicable deliverable candidate boundary, not every task update. Checklists grant no approval or receipt and never skip an existing delivery gate.

When RDD is enabled, first use native candidate risk assessment through `gentle_review` with `{"operation":"assess"}`. Passive/low uses silent structural checks with no reviewer or consent ceremony. Medium/high relays existing candidate consent and follows the native plan: native review runs only on grant; a decline continues under ordinary policy. Do not substitute model judgment, task size, or defect severity for prospective candidate risk; never infer low risk from a failed assessment. Follow the mirrored provider contract and native continuations; this paragraph introduces no lifecycle route. When RDD is disabled, do not start or prompt for RDD; ordinary checks remain. A checklist or assumption challenge never enables RDD, replaces its refuter, or answers consent.

### Delegation Rules

These rules select execution topology, not the implementation method. Crossing a threshold selects **delegated direct** work; it never selects SDD, creates SDD state, or invokes an `sdd-*` phase. Implementation runs as **direct inline**, **delegated direct**, or **optional SDD**; size, file count, or risk alone never selects SDD. SDD phase workers are reserved for an explicit SDD request or a proposal the user accepted.

Core principle: **does this inflate the parent context without need?** If yes, use one bounded worker. If no, do it inline.

| Action | Direct inline | Delegated direct worker |
|--------|---------------|-------------------------|
| Read to decide/verify (1–3 files) | ✅ | — |
| Read to explore/understand (4+ files) | — | ✅ one narrow mapper |
| Read as preparation for writing | — | ✅ together with the write |
| Write one mechanical, already-understood file | ✅ | — |
| Write 2+ non-trivial files | — | ✅ one writer |
| Bash for state (`git`, `gh`) | ✅ | — |
| Tests, builds, or installs | allowed as a bounded action | ✅ fresh per-action worker without changing route |

Use the platform's native bounded worker for delegated-direct work; reserve `sdd-*` agents for a selected SDD route. Before every shipped SDD `subagent_run` dispatch, the parent runtime—not phrase matching or the child—must resolve interactive preflight, fail closed on cancellation/failure, and prepend the exact rendered `## SDD Session Preflight` block to the existing child `context`. Do not create a second preference channel. An RPC child consumes that context and never originates, confirms, or persists defaults.

Keep one writer and a short synthesized handoff. Delegation is mandatory at the mapping, write, preparation, and broad-research boundaries, but it remains a direct implementation route and must not synthesize SDD artifacts.

#### Mandatory Delegation Triggers

These are parent-orchestrator routing boundaries. Use the smallest useful topology and keep the safety machinery behind the outcome-first interaction. Do not pass these rules to child agents as permission to orchestrate.

1. **Bounded read rule**: read 1–3 files inline to decide or verify.
2. **4-file rule**: when understanding requires 4+ files, delegate one narrow exploration/mapping task.
3. **Write rule**: keep one mechanical, already-understood file inline only when it needs no research or unresolved design work; delegate one writer for 2+ non-trivial files.
4. **Context rule**: delegate reading that prepares a write and broad research/context compression.
5. **Per-action rule**: tests, builds, and installs may use fresh workers without changing the implementation route or creating SDD state.
6. **Optional SDD rule**: retain SDD only after an explicit request or accepted proposal. Resolve organic uncertainty with optional research and a concise proposal only for a real decision; risk alone never forces SDD.

For bounded multi-file writes, prefer the installed package-owned `gentle-ai-worker`, then a user-configured `worker`. If neither worker definition exists, fall back to the native `Agent` even when `subagent_*` tools are available. If no delegation mechanism is available, stop and explain the blocker. Judgment Day phase roles are never generic fallbacks. If the generic writer chain is unavailable, use the documented native generic fallback or stop.

#### Judgment Day fix dispatch

Use `jd-fix-agent` only for an explicitly activated Judgment Day fix batch, never as a lexical or generic-writer fallback. Judgment Day is independent: it neither enables nor replaces ordinary review; a separately requested ordinary review remains independent. A standalone Judgment Day fix requires no graph-v1 or native review lineage. Its dispatch carries this exact runtime-accepted Markdown shape: `## Judgment Day activation` contains only `User explicitly requested Judgment Day.`. Replace the example ID, frozen ledger hash, row data, and surface with controller-authorized values. The correction batch contains only one round (`1 of 2` or `2 of 2`) and one lowercase SHA-256. The exact frozen finding rows are one JSON object per line, use only the canonical row fields, and exactly match the authorized IDs.

```markdown
## Judgment Day activation
User explicitly requested Judgment Day.
## Exact authorized severe IDs
- `JD-A-001`
## Judgment Day correction batch
Round: 1 of 2.
Frozen ledger SHA-256: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
## Exact frozen finding rows
{"id":"JD-A-001","lens":"judgment-day","location":"path/to/authorized-file.ts:1","severity":"CRITICAL","status_at_freeze":"open","evidence_class":"deterministic","evidence_claim":"Concrete user-impact claim supported by the frozen location."}
## Allowed edit surfaces
path/to/authorized-file.ts
```

#### Pi Trigger Runtime Bindings

Once a trigger fires, the parent MUST delegate through the best available subagent runtime. Prefer `subagent_run` when present; otherwise use Pi's native `Agent` or another available delegation mechanism. Do not replace a required delegation with inline execution. Do not inject these as child-agent permission to spawn subagents; children receive concrete role work and must not orchestrate.

The bounded multi-file writer precedence in rule 3 overrides that general runtime preference. If no delegation mechanism is available, stop and explain the blocker.

1. **4-file rule**: launch `scout`, `context-builder`, or the closest read-only mapping subagent with fresh context and a narrow mapping task. Route generic non-SDD exploration to `gentle-ai-explore`; if missing or unusable, use native `Agent` with the same read-only mapping task and report the fallback.
2. **Multi-file write rule**: for bounded multi-file writes, prefer the installed package-owned `gentle-ai-worker`, then a user-configured `worker`. If neither worker definition exists, fall back to the native `Agent` even when `subagent_*` tools are available. If no delegation mechanism is available, stop and explain the blocker.
3. **Incident rule**: after wrong `cwd`, accidental repository/worktree mutation, failed merge recovery, confusing test command, or environment workaround, stop and diagnose the incident separately before resuming.
4. **Long-session rule**: if accumulating work is no longer clearly local — roughly 20 tool calls, 5 exploratory file reads, or 2 non-mechanical edits without delegation — pause and delegate the remaining work instead of silently continuing monolithically.
5. **Verification rule** (gentle-pi#661/#662, RDD-aware; normative -- referenced, not restated, elsewhere in this file): read the rendered `Receipt-driven development:` line next to `Background subagent policy`. The bounded writer always runs the exact parent-authorized commands under the delegated task's `## Verification` heading, synchronously and in the foreground, and reports each as `<command>: <observed result>` -- see `gentle-ai-worker`'s Verification contract for the exact rules, including how `## Known environmental failures` (exact pre-existing base failures) differs from any other failing required command, which still forces `status: partial`. Those foreground commands are live work, not silence: while a tool call is in flight the runner's stall watchdog uses `tool_stall_timeout_ms` (default 30 minutes) instead of the `stall_timeout_ms` idle budget. When the line reads `on`, that writer report is the verification of record, and the native review is the independent check the writer cannot influence: `gentle-ai-verify` (or the native `Agent` fallback, with the same read-only verification task and exact parent-authorized commands) becomes on-demand -- reach for it only when the writer reports `partial`/`blocked`, the check is expensive or external (E2E runs, installs) and the parent wants a cheaper profile, or the parent wants an independent spot check. That `on` branch holds only while the native review actually reaches a terminal outcome for this candidate (gentle-pi#668): a human decline of the consent envelope for this candidate (candidate-scoped, never the RDD kill switch), a clone-local RDD disable discovered mid-flow, or a refused START/STATUS all fall back to the risk-gated path exactly as `off` -- call `gentle_review` with `{"operation":"assess"}` (pass `nativeReviewOutcome` when the parent already knows it; the tool derives it from what it itself observed for the candidate otherwise, failing closed to `unknown` when it cannot) and follow the returned plan. When the line reads `off` or `unknown`, after the writer returns, call `gentle_review` with `{"operation":"assess"}` over the writer's diff and follow the returned plan instead of judging non-triviality from the task description: the operation resolves the native risk tier and states exactly who verifies next. The tier table (stated once, here):

| Native risk tier | Verification when RDD is `off`/`unknown` |
|---|---|
| passive | structural readback by the parent; no separate verifier, no tests |
| medium | writer self-verification stands; a separate `gentle-ai-verify` run is added only when the writer profile is a small model (mini or low effort) |
| high | writer self-verification plus a separate `gentle-ai-verify` run, always |
| unknown / assess failed | treated as high |

The small-model bias raises the tier by one for verification purposes (medium becomes high); an unknown `Receipt-driven development:` line never lowers a tier below `off`. The parent spot check (re-running one reported command before delivery) stays required in every tier. Only truly local read-only checking of 1–3 known files stays inline.

### Work Routing Ladder

Route work through the smallest harness that is safe. "Smallest" means minimal safe coordination, not zero delegation by default.

#### 1. Inline Direct

Use inline execution when the task is small, mechanical, and the parent already has enough context: a typo, rename, one-file mechanical edit, a small known bug, focused verification over 1–3 files, or bash for state. Do not add SDD ceremony. Do not use this exception to avoid delegation after the task stops being small.

#### 2. Simple Delegation

Delegate when work would inflate parent context or requires focused exploration, validation, or multi-file implementation, but does not yet need a full SDD workflow. Examples include understanding an unfamiliar module, inspecting 4+ files, investigating a failing test, implementing a bounded multi-file change, or running focused tests/builds.

Use the configured subagent runtime when available. Prefer the `subagent_*` tools (`subagent_run`, status/result helpers) when the Pi Subagents extension is installed, because they run the user's configured project/global subagent definitions and preserve history/background behavior.

For bounded multi-file writes, prefer the installed package-owned `gentle-ai-worker`, then a user-configured `worker`. If neither worker definition exists, fall back to the native `Agent` even when `subagent_*` tools are available. If no delegation mechanism is available, stop and explain the blocker.

<!-- gentle-pi:background-subagents -->
#### Background Subagent Policy

Background execution is policy-gated: the always-on orchestrator prompt renders one status line, `Background subagent policy: on|off (capability: ready|absent)`. If the policy is off OR the `subagent_run` tool is unavailable, run every delegation in the foreground — `mode: "task"` when `subagent_*` tools exist, otherwise the native `Agent` fallback — always.

When the policy is on and `subagent_run` is available:

- Default to `subagent_run` `mode: "background"`. It returns a task id at once; the terminal stays free and the human keeps typing. Pass a `label` of three to six words naming the work.
- A child `agent_end` retains its latest answer but is not completion: Pi may still retry, compact, or run a queued follow-up. Treat the task as finished only at `agent_settled`; only then release its queue slot, publish its background result, or terminate it. If it exits first, report failure with its retained answer as diagnostics.
- When a background task settles, its result arrives as a message in this session (custom type `gentle-agents.result`, one per task) and starts a new turn if you are idle. Wait for it: end the turn once launches and any non-overlapping work are done. Never poll, sleep, or call `subagent_status`/`subagent_result` for completion.
- Do not claim an implementation ready or RDD-ready while its required verification or correction follow-up remains queued. Run the required focused verification before that claim, and retain legitimate post-correction verification. This does not invent a universal full-suite requirement or make a receipt a delivery gate.
- Use `mode: "task"` only when the subagent must ask the human something mid-flight (task-mode dialogs reach the human; background dialogs are dismissed) or when the human asked to wait.
- Launch as many independent tasks as the work has; the runner queues beyond `max_concurrency`. Do not duplicate launches or work, and do not overlap files or topics. Never run parallel writers in one worktree.
- Finished tasks persist across restarts; running ones are stopped when pi exits and must be relaunched, never claimed as recovered.
<!-- /gentle-pi:background-subagents -->

For generic non-SDD exploration and mapping, first attempt the installed package-owned `gentle-ai-explore`. If that individual role is missing or unusable, fall back to Pi's native `Agent` with the same read-only mapping constraints and report the fallback.

For bounded multi-file writes, prefer the installed package-owned `gentle-ai-worker`, then a user-configured `worker`. If neither worker definition exists, fall back to the native `Agent` even when `subagent_*` tools are available. If no delegation mechanism is available, stop and explain the blocker. This writer precedence overrides the general runtime preference above.

Delegate generic non-SDD verification that executes or delegates commands per the RDD-aware Verification rule (trigger 5 under Mandatory Delegation Triggers, gentle-pi#661) -- the normative on/off/unknown routing lives there, not here: the bounded writer always self-verifies via `## Verification`, and `gentle-ai-verify` (or the native `Agent` fallback, with the same read-only verification constraints, exact parent-authorized commands, and fallback reporting) is on-demand only when the rendered `Receipt-driven development:` line reads `on`; when the line reads `off` or `unknown`, the `gentle_review` `assess` operation's returned plan decides it by native risk tier instead of a blanket non-trivial rule (gentle-pi#662). `## Known environmental failures` follows the same definition as `gentle-ai-worker`'s Verification contract: exact pre-existing base failures reported as evidence, never blockers -- any other failing required command still forces `status: partial`. Truly local read-only checking of 1–3 known files may remain inline. Separate exploration stays reserved for when the parent needs the map to decide or route; reading that prepares a write belongs with the writer making the change, consistent with the Delegation Rules table above.

Use `sdd-explore` and `sdd-verify` only inside SDD.

#### Allowed edit surfaces (MANDATORY)

The bounded writer refuses to write outside the exact allowed edit surfaces and stops with `status: interaction_required` when they are missing. The parent owns that input. Deriving it is part of planning the delegation, not something the writer or the human can be left to supply.

Before launching a bounded writer (`gentle-ai-worker`, a user-configured `worker`, or the native `Agent` fallback), derive the allowed edit surface from the task being delegated — the files the planned change must touch, plus the directories where the task authorizes new files — and pass it in the delegated prompt under an `## Allowed edit surfaces` heading, in the same exact-path form as `## Skills to load before work`:

- exact repository-relative paths or narrow globs, one per line; never `.` and never a bare repository root; paths containing whitespace require whole-entry backticks (for example, `` `Directory With Spaces/note.md` `` or ``- `Directory With Spaces/note.md` ``); a list marker alone does not permit whitespace;
- the section ends only at the next canonical ATX Markdown heading of any level (zero to three leading ASCII spaces, one to six `#`, then an ASCII space); every non-empty line before that heading must be a valid surface entry, so put explanatory prose under a following heading;
- pre-existing untracked targets the writer may write, listed explicitly;
- the directories where new files are authorized, when the task requires new files;
- nothing beyond the delegated task — a surface wider than the task is the same defect as no surface at all.

If the surface genuinely cannot be derived, do not launch the writer, and do not ask the human to author paths. Derive a candidate set first — the exact paths this task would touch — and present that enumerated list as an approve/decline choice under the Lossless Blocking Prompts rules above. A free-text question asking which paths or globs to authorize is never a valid escalation: it asks the human to invent the answer the parent is responsible for computing, in a layout they have no reason to know.

Relay a writer's `interaction_required` payload about edit surfaces the same way: present its derived candidate paths as the choice, and add or drop paths only on the human's explicit instruction.

#### Key Learnings closing block

When delegating to a generic Explore/general worker (`gentle-ai-explore`, `gentle-ai-worker`, `gentle-ai-verify`) or their native `Agent` fallback, include the same `## Key Learnings` closing instruction in the delegated prompt: after the worker returns its normal result envelope or handoff, it closes its final response text with a `## Key Learnings` block of 1–5 numbered items, each a standalone factual sentence of at least 20 characters and at least 4 words, omitting the block when there is genuinely no reusable learning. The block layers on after the structured Return contract and does not alter its fields. This applies to final response text only — not intermediate tool output. The Engram memory provider automatically extracts and persists these items as passive capture; the worker does not parse the block or invoke passive-capture tools itself. This is separate from explicit `mem_save` artifact/decision persistence. Agents that must return strict JSON never receive this closing instruction; their required output shape remains unchanged.

For delegation other than bounded multi-file writes, use the generic fallback: if `subagent_*` tools are unavailable, fall back to Pi's native `Agent` tool or another available delegation mechanism. The delegation trigger remains mandatory; the fallback changes the runtime, not the requirement to delegate. If no delegation mechanism is available, stop the complex work and explain the blocker instead of silently continuing inline.

#### Pi Subagent Model Routing

For generic Pi subagents (`delegate`, `worker`, `scout`, `context-builder`, `oracle`, `planner`, `researcher`, or other non-SDD agents), do not pass the `model` parameter by default. Let `pi-subagents` resolve model and thinking from `.pi/settings.json`, `.pi/subagents.json`, global subagent config, and runtime defaults.

SDD model assignment tables apply only to SDD/Judgment-Day phase agents. They must not be used for generic Pi delegation. Only pass `model` for generic subagents when the user explicitly requests a model override for that launch.

Default balanced pattern for bounded implementation:

```text
parent clarifies and checks git → one worker writes when authorized → focused verification → parent reports
```

Do not make every task SDD. Do make non-trivial tasks multi-agent at the narrowest useful point.

#### 3. SDD (optional)

SDD is never selected by size, file count, or risk alone. Do not recommend SDD merely to resolve ambiguity. Use the organic research guidance above; retain SDD when the user explicitly requests it or accepts a proposal to use it.

Select SDD only when the user explicitly asks to use SDD, invokes `/gentle-sdd-new`, `/gentle-sdd-ff`, or `/gentle-sdd-continue`, or accepts an SDD proposal. Once selected, do not jump directly to implementation. Calibrate context, create artifacts, and ask for approval at the appropriate gates.

## Pi Delegation Bindings

Prefer delegation when fresh context improves correctness more than token savings:

- Use `scout`/`context-builder` to compress broad repository exploration into a short handoff instead of loading many files into the parent.
- Use a single `worker` for one writer thread; do not run parallel writers unless isolated worktrees are explicitly approved.
- Use `outputMode: "file-only"` for large child reports and summarize only decisions, blockers, and paths in the parent thread.

### Canonical Lightweight Workflows

Bugfix with unfamiliar flow:

```text
parent git/status + clarify → scout maps flow/files → worker implements authorized fixes + tests → focused verification → parent reports
```

Conflict or dependency-marker cleanup:

```text
parent reproduces/checks conflict → parent or worker resolves inside the active scope → verify markers, package/lock consistency, and repository cleanliness → parent reports
```

After tooling/worktree incident:

```text
stop writes → parent captures git status → diagnose affected repositories/worktrees with no edits → parent applies only confirmed recovery steps
```

## Delivery strategy

For selected SDD work, use the delivery strategy, chain strategy, workload forecast, and approval gates in `assets/sdd-orchestrator-workflow.md`. Direct and delegated work do not create SDD artifacts.
