# SDD Orchestrator Workflow

This is the lazy-loaded SDD workflow surface for el Gentleman on Pi. Read this file before handling `/sdd-*`, natural-language SDD requests, SDD continuation/routing, apply/verify/archive work, or SDD/Judgment-Day phase delegation.

## SDD Workflow

SDD phases:

```text
init → explore → research (optional) → proposal → spec → design → tasks → apply → archive (verification optional)
```

Dependency graph:

```text
explore → research (optional) → proposal
proposal → spec ─┬→ tasks → apply → archive (verification optional)
proposal → design ┘
```

`/gentle-sdd-status [change]` is the read-only status action for resolving the active change, artifact paths, task progress, dependency readiness, and action context before apply/verify/archive.

## Native SDD Dispatcher

`gentle-ai sdd-status --contract gentle-ai.sdd-status/v2` is the sole, read-only status authority for every store. The orchestrator carries its projection unchanged; it never reconstructs readiness, selects a replacement action, uses an Engram bypass, or launches a recommendation merely because status displayed it.

`/gentle-sdd-status` only inspects and renders that projection. Only explicitly authorized `/gentle-sdd-continue` may call native `sdd-continue` to prepare a missing change-instance marker; this is not a status fallback and grants no source roots. If native status is unavailable, malformed, or mismatched, stop and report the failure.

## Bounded Planning Routing

For authoritative native status, route only by the bounded `nextRecommended` token and dependency states; never infer a route from prose. Keep genuine blockers in `blockedReasons` and non-blocking diagnostics in `notes`, never in `nextRecommended`, and report them without discarding them to enable a route.

| `nextRecommended` | Planning route |
| --- | --- |
| `propose` | `sdd-proposal` |
| `spec` | `sdd-spec` |
| `design` | `sdd-design` |
| `tasks` | `sdd-tasks` |

Native unprefixed tokens are the only automatic planning routes. Prefixed or locally derived status tokens never authorize a phase.

These planning routes remain runnable when missing planning artifacts leave `dependencies.apply: blocked`; do not require apply readiness to produce those artifacts. This is a planning-only exception, not permission to run apply or another blocked non-planning phase.

Before any planning launch, stop for ambiguous change selection, unresolved session preflight, or unsafe action context. Carry `actionContext` and prove planned writes are within the authoritative workspace or allowed edit roots; workspace-planning without allowed edit roots remains read-only. Planning does not bypass the init guard, optional research guidance, or phase approval requirements.

## Bounded Execution Routing

| Native `nextRecommended` | Pi executor |
| --- | --- |
| `apply` | `sdd-apply` |
| `verify` | `sdd-verify` |
| `remediate` | `sdd-remediate` |
| `archive` | `sdd-archive` |

For automatic continuation, execute only the selected native action when its dependency and `actionContext` permit it. Unknown, malformed, blocked, or unsupported values stop before work; prose and local routing cannot replace them. `notes` is separate from `blockedReasons` and never gates: report a non-empty `notes` value as informational and proceed when the dependency and `blockedReasons` gates allow.

## SDD Status Contract

Before `/gentle-sdd-continue`, `sdd-apply`, `sdd-verify`, or `sdd-archive`, resolve and carry structured status. Lookup order: parent-provided status, then project override `.pi/gentle-ai/support/sdd-status-contract.md`, then globally installed `~/.pi/agent/gentle-ai/support/sdd-status-contract.md`, then the embedded `sdd-status` prompt contract. Do not use `assets/support/...` as a runtime path; that is only the package source path before installation.

Status must include:

- active change selection and how it was resolved;
- artifact store and paths/topics for proposal, specs, design, tasks, apply-progress and optional verify-report;
- task progress with exact unchecked `- [ ]` implementation task lines;
- dependency states for apply, verify, and archive;
- `actionContext` with mode, workspace root, allowed edit roots, and warnings;
- next recommended action.

Do not guess the active change. If change selection is ambiguous, ask the user and stop. If `actionContext.mode: workspace-planning` and no allowed edit roots are provided, stop before apply/verify/archive and ask for an explicit implementation/edit scope.

## Lazy SDD Preflight

Do not ask SDD setup questions on session start. The first time the user initiates an SDD process in a Pi session, run the SDD preflight once and keep those choices for the rest of that session. Runtime trigger detection is intentionally deterministic: slash SDD flows and `/gentle-sdd-init` run preflight automatically; for natural-language requests, the parent/orchestrator decides semantically whether SDD is needed and must run/reuse `/gentle:sdd-preflight` before continuing.

**Hard gate:** `openspec/config.yaml`, existing SDD changes, installed `.pi`/global SDD assets, or a todo named "preflight" are not session preflight. They are project context only. Do not mark SDD preflight complete, start `sdd-init`, launch SDD subagents/chains, or move to explore/proposal/spec/design/tasks until this session has an injected `## SDD Session Preflight` block or an equivalent resolution from the canonical authority order below.

On the first SDD invocation of EACH new interactive session, confirm the preflight choices even when valid preferences are saved. Persisted preferences and canonical defaults are preselected suggestions, not current-session consent. Offer confirmation of the grouped suggestions or changes; cancellation leaves preflight unresolved. Explicit current-session choices take precedence and, once resolved, are reused throughout that session. If `/gentle:sdd-preflight` is unavailable, perform the same confirmation inline. The parent `subagent_run` dispatch boundary resolves this gate for every shipped SDD agent, prepends the exact rendered `## SDD Session Preflight` block to the existing child `context`, and blocks launch on cancellation or failure. An RPC child consumes that transport but never originates or persists defaults; missing or malformed transport fails closed before process spawn. Only a safely distinguishable standalone headless parent may retain canonical/persisted defaults without UI. Missing Engram constrains the artifact store to `openspec` unless an incompatible explicit request needs a human decision.

Preflight canonical defaults are execution `auto`, artifact store `openspec`, delivery strategy `ask-on-risk`, and review budget `400`; capability and already-selected constraints may narrow them.

The grouped session confirmation includes defaulted and capability-constrained suggestions. If changes are requested, preselect saved values and omit redundant one-option selectors. Never reinitialize project context merely because a new session needs confirmation. `chain_strategy` remains deferred, and `exception-ok` requires explicit `size:exception` acceptance and is never inferred.

The exact `delivery_strategy` domain accepted by `sdd-tasks` and `sdd-apply` is `ask-on-risk`, `auto-chain`, `single-pr`, or `exception-ok`; above the review threshold, `auto-chain` resolves without asking again.

The package should ensure SDD assets are present as global Pi runtime assets without the user needing to remember per-project setup commands. If assets are missing, install them non-destructively into:

```text
~/.pi/agent/agents/sdd-*.md
~/.pi/agent/chains/sdd-*.chain.md
```

Manual install commands are recovery/debug paths, not the happy path. `/gentle:sdd-preflight` is the explicit preflight command for agent/orchestrator use. If the user explicitly changes SDD preferences later in the same session, follow the new instruction.

## Init Guard

Before any SDD flow, make sure project context exists. Where that context lives depends on the session's artifact store, so qualify the check by store before acting on it.

When the store is `openspec` or `both`, the local artifact is:

```text
openspec/config.yaml
```

If it is missing, ask the user for the minimal information needed or run `/gentle-sdd-init` if available.

When the store is `engram` or `none`, `/gentle-sdd-init` never writes that file, so its absence is expected and is not a missing init. Never re-trigger `/gentle-sdd-init` over it. Resolve project context from the Engram `sdd-init/{project}` topic for `engram`, or inline from the session for `none`, and ask the user only when that context is genuinely absent.

This init guard runs after the session preflight gate above; project config presence or absence never substitutes for session preflight choices. Do not proceed with a substantial SDD flow while pretending project context, testing capability, or session preflight choices are known.

## Artifact Store Policy

This package does not provide persistent memory by itself.

- Default: `openspec` artifacts in the repo.
- If a separate memory package is installed and callable, memory/hybrid flows may be used.
- Never claim memory exists because Gentle AI is installed.

## Execution Mode

Use the session's SDD preflight choice:

- `auto`: phases run back-to-back without pausing, but the orchestrator gatekeeper validates after each phase before launching the next.
- `interactive`: after each phase, show a concise summary and ask whether to adjust or continue.

If the user doesn't specify, default to `auto`. After scope approval, expect zero further prompts on the happy path and at most one actionable prompt per recoverable failure; the gatekeeper summarizes phase progress instead of interrupting except on a second consecutive gate failure or a genuine scope/product decision.

In interactive mode, between phases:

1. show concise phase result;
2. state next phase;
3. ask whether to continue or adjust.

Interactive approval is phase-scoped. A user response such as "continue", "dale", or "go on" approves only the immediate next phase, not the rest of the SDD pipeline. Do not treat a generated artifact as approved until the user has had a chance to review or explicitly delegate that review.

Before `sdd-proposal` in interactive mode, offer the user a proposal question round instead of silently deciding whether the proposal is clear enough. Explain that the questions are meant to improve the PRD/proposal by uncovering business understanding, business rules, implications, impact, edge cases, and product tradeoffs. Prefer 3–5 concrete product questions per round, then summarize the resulting assumptions and ask whether the user wants to correct anything or run a second question round. Cover business/product/PRD decisions: business problem, target users and situations, business rules, product outcome, current-state gap, implications and impact, edge cases, decision gaps, first-slice scope boundaries, non-goals, product constraints, and business tradeoffs. Do not ask about test commands, PR shape, changed-line budget, or other harness mechanics at proposal time unless the user explicitly asks to discuss delivery.

## Optional Research

Recommend research when complexity, consequential uncertainty, or external facts warrant it, before or after exploration as useful. Research is not a prerequisite for questions, proposal, spec, design, or tasks; selection does not turn it into a completion gate. Supply concrete questions, requested depth, relevant local context and skill instructions, and source restrictions to the output-only `sdd-research` child; do not pass local paths as child read obligations.

The parent owns local reads, product choices, and any authorized persistence/readback. Do not make the research child fetch local artifacts or write files/Engram. Use the existing parent tools and selected store when findings merit persistence: exact change-local paths or project/topic keys, with actual readback before claiming success. First artifacts and in-memory sessions require no prior identity or checkpoint. For hybrid storage, report each actual write/readback result and resolve genuine divergence before overwriting; do not create another authority or claim a failed save succeeded. Preserve historical artifacts without requiring them for new research.

Use individually authorized tools from the injected `## SDD Research Capabilities`. Documentation uses `fetch_content`; open-web uses any authorized available subset of `web_search`, `source_check`, `fetch_content`, and `get_search_content`. Forward exact observed class-specific tools and existing extension provenance in `research_selection`; never broaden source restrictions, invent online access, or treat generic MCP gateways as narrow grants. The child rechecks actual availability and provenance. Inventory is not evidence: require source-backed claims, original sources, publisher/version/date, and honest limits.

Useful partial findings, unavailable sources, or an unpersisted inline result do not automatically block proposal or trigger a retry. Retain unanswered questions and explain their implications. Only a genuine unresolved product choice, unsafe dependent action, or actual permission denial blocks the work that depends on it. The parent relays product choices without inferring consent; no persisted pre-proposal readiness certificate is required. Native `gentle-ai.sdd-status` remains the sole SDD status authority; research adds no native phase or state.

## Delivery Strategy

On the first SDD chain request in a session, resolve the delivery strategy from preflight (or ask once) and cache it:

- `ask-on-risk` — default; ask only when the tasks forecast detects review-budget risk.
- `auto-chain` — automatically split into chained/stacked PR slices when needed.
- `single-pr` — proceed as one PR only if the size is within budget.
- `exception-ok` — user accepts `size:exception` when over budget. The preflight menu cannot select this; it is reached only when the user explicitly accepts `size:exception`, either up front or when `ask-on-risk` stops to ask.

These four are the whole domain. Pass `delivery_strategy` to `sdd-tasks` and `sdd-apply`.

## Chain Strategy

When delivery planning yields chained PRs, ask once for chain strategy and cache it:

- `stacked-to-main` — each PR targets the previous PR branch or main in sequence.
- `feature-branch-chain` — PR #1 targets the tracker branch; child PRs target the immediate previous PR branch; only the tracker merges to main.

When chained PRs are selected, treat the registry skill `gentle-ai-chained-pr` as a required skill match. Resolve and forward it by registry path to `sdd-tasks` and `sdd-apply`; do not hardcode its path.

Pass it as `chain_strategy` to `sdd-tasks` and `sdd-apply` prompts alongside `delivery_strategy`.

## Result Contract

Every phase result should include:

```text
status
executive_summary
artifacts
next_recommended
risks
skill_resolution
```

The parent should synthesize these envelopes, not paste long raw reports unless needed.

### Key Learnings closing block (routing)

Every installed SDD phase executor agent (`assets/agents/sdd-*.md`) carries the effective `## Key Learnings Closing` contract in its own loaded prompt; this workflow file documents routing only and is not the executor authority. Each phase executor closes its final report text with a `## Key Learnings` block that the Engram memory provider passively extracts. Generic delegated workers receive the same closing instruction via `assets/orchestrator-delegation.md`.

## Automatic Mode Gatekeeper

In `auto` execution mode, the parent/orchestrator is the quality gate between SDD phases. After a delegated phase returns and before launching the next phase, validate that the phase actually reached its objective. This validation is autonomous: do not ask the user on the happy path, but stop and report if the gate catches a real problem.

**Optional research takes precedence over the success-only checks below:** accept honest partial, unavailable, or inline findings without requiring an artifact or retry. Check only claimed persistence through parent-owned readback; never force a research/pre-proposal certificate. Genuine product decisions, unsafe dependencies, and actual permission denials still constrain their dependent actions.

Check every phase result against the Result Contract:

- **Contract conformance:** the phase returned `status`, `executive_summary`, `artifacts`, `next_recommended`, `risks`, and `skill_resolution`, and `status` indicates success rather than partial, failed, or blocked.
- **Artifact existence:** every declared artifact exists and is readable in the active backend. For memory-backed flows, retrieve the topic with the available memory tools; for OpenSpec/file-backed flows, read the declared path. A successful phase with no retrievable artifact fails the gate.
- **No hallucinated references:** spot-check concrete file paths, symbols, commands, and artifacts the phase claims it created or used. Referenced paths or artifacts that do not resolve fail the gate.
- **No scope drift:** the output must stay consistent with its inputs and the dependency graph: spec stays within proposal scope, design answers the proposal, tasks cover spec and design, apply implements the tasks, verify checks the implementation against the spec, and archive composes applicable specs while preserving task truth and safety.
- **Routing coherence:** `next_recommended` must follow the SDD dependency graph, and no unaddressed critical risk may be carried silently into the next phase.

Use cost-aware validation:

- For lower-risk phases (`sdd-explore`, `sdd-research`, `sdd-spec`, `sdd-tasks`, `sdd-archive`), the parent may validate inline by reading artifacts back and checking claims.
- For higher-risk phases (`sdd-design`, `sdd-apply`), validate the artifact, declared paths, task state, and focused test evidence directly before continuing because errors there compound downstream.
- If a gate finds any smell — missing artifact, status mismatch, unresolved path, likely drift, or critical risk — rerun the same SDD phase once with corrective feedback. SDD phase validation does not start ordinary review or Judgment Day.

On gate pass, continue automatically to the next phase. On gate fail, rerun the same phase exactly once with corrective feedback naming the specific failures. Validate the rerun. If it fails again, stop the automatic chain and report the phase, failures from both attempts, and the recommended fix. Never advance to dependent phases on a failed gate.

The gatekeeper is additive: it does not relax the Review Workload Guard, Strict TDD Forwarding, native status dependency checks, or mandatory delegation rules. It never creates a post-SDD review pass.

## SDD Phase Delegation Mode

Launch SDD phase subagents with `subagent_run` `mode: "task"` when the parent needs the phase result to route the next step. SDD phases, writers, dependent verify evidence, and archive are foreground-mandatory under the background subagent policy block in the delegation contract; background completion is a notification/history mechanism, not an orchestration resume guarantee.

## Model Assignments

Read this table before the first SDD/Judgment-Day phase delegation in a session, cache it, and use it only for SDD/Judgment-Day phase agents. If a phase is missing, use the `default` row. If the assigned tier is unavailable, use the runtime's default model and continue.

On Pi, phase model routing is user-owned and persisted, not prompt-passed: `/gentle:models` writes `.pi/gentle-ai/models.json`, and the package applies each saved assignment to the installed phase agent definitions (frontmatter `model:`/`thinking:`) or `.pi/settings.json` overrides. The table below is the default capability tier per phase when the user has saved no assignment.

**Mandatory phase model gate:** before launching an SDD/Judgment-Day phase agent, confirm the phase resolves through the saved model config or these defaults. Never pass an ad-hoc `model` parameter for SDD/Judgment-Day phases, and never apply this table to generic Pi delegation — generic subagents resolve model/thinking through `pi-subagents` config, and `model` is passed there only on an explicit user override.

| Phase        | Default tier   | Reason                                     |
| ------------ | -------------- | ------------------------------------------ |
| sdd-explore  | balanced       | Reads code, structural - not architectural |
| sdd-research | balanced       | Optional source-backed investigation        |
| sdd-proposal | deep-reasoning | Architectural decisions                    |
| sdd-spec     | balanced       | Structured writing                         |
| sdd-design   | deep-reasoning | Architecture decisions                     |
| sdd-tasks    | balanced       | Mechanical breakdown                       |
| sdd-apply    | balanced       | Implementation                             |
| sdd-verify   | balanced       | Validation against spec                    |
| sdd-archive  | fast           | Copy and close                             |
| jd-judge-a   | deep-reasoning | Adversarial review                         |
| jd-judge-b   | deep-reasoning | Adversarial review                         |
| jd-fix-agent | balanced       | Surgical confirmed fixes                   |
| default      | balanced       | SDD phase fallback; never a Judgment Day role |

## Judgment Day fix routing

Judgment Day phase roles are never generic fallbacks. If the generic writer chain is unavailable, use the documented native generic fallback or stop. Judgment Day is independent: it neither enables nor replaces ordinary review; a separately requested ordinary review remains independent. A standalone Judgment Day fix requires no graph-v1 or native review lineage. Launch `jd-fix-agent` only for an explicit Judgment Day fix batch with this exact runtime-accepted Markdown shape: `## Judgment Day activation` contains only `User explicitly requested Judgment Day.`. Replace the example ID, frozen ledger hash, row data, and surface with controller-authorized values. The correction batch contains only one round (`1 of 2` or `2 of 2`) and one lowercase SHA-256. The exact frozen finding rows are one JSON object per line, use only the canonical row fields, and exactly match the authorized IDs.

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

## Sub-Agent Launch Deduplication

Maintain a session-scoped launch log of `(phase, task-fingerprint)` pairs. If the same pair already exists, do NOT launch again. Emit exactly one launch per distinct task and append the pair after launch.

## Sub-Agent Launch Protocol

Pre-flight before every SDD/Judgment-Day phase launch:

1. Identify the phase key (`sdd-apply`, `sdd-verify`, `jd-judge-a`, etc.).
2. Confirm its model routing per the Model Assignments gate above.
3. Resolve matching skill paths once per session from the registry and pass exact `SKILL.md` paths under `## Skills to load before work`.
4. If a delegated result reports `skill_resolution` as `fallback-registry`, `fallback-path`, or `none`, re-read the registry before subsequent delegations.

**Key Learnings closing (generic delegations):** when delegating to generic agents (`gentle-ai-explore`, `gentle-ai-worker`, `gentle-ai-verify`, scout/worker roles, or the native `Agent` fallback), apply the rule exactly as stated under "Key Learnings closing block" in `assets/orchestrator-delegation.md`. That file is the single statement of the rule; do not restate or paraphrase it here. SDD phase launch prompts need no such injection: every installed SDD phase executor already carries the effective contract in its own prompt (see "Key Learnings closing block (routing)" above).

## Strict TDD Forwarding

For `sdd-apply` and `sdd-verify`, read `openspec/config.yaml` when present.

If it declares strict TDD and a test command, include a non-negotiable instruction in the phase prompt:

```text
STRICT TDD MODE IS ACTIVE. Test runner: <command>. Follow RED, GREEN, TRIANGULATE, REFACTOR. Record evidence.
```

Do not rely on the child agent to discover this independently.

## Archive Final-State Handoff

When launching `sdd-archive`, forward explicit final-state facts for any work completed after `apply-progress`, `verify-report`, or `sync-report` were persisted — verify warnings fixed in later commits, blockers resolved, tasks finished, updated test or issue counts — with commit or evidence references where available. Those artifacts are intermediate snapshots, valid at the time they were written; the archive report records the state at close, and explicit final-state facts in the `sdd-archive` launch prompt outrank stale snapshot claims.

## Review Workload Guard

After `sdd-tasks` completes and before launching `sdd-apply`, inspect the task output's `Review Workload Forecast`.

If it says `Chained PRs recommended: Yes`, `400-line budget risk: High`, estimated changed lines exceed 400, or `Decision needed before apply: Yes`, apply the cached `delivery_strategy`:

- `ask-on-risk`: stop and ask whether to split or proceed with `size:exception`.
- `auto-chain`: split automatically; ask for `chain_strategy` only if missing.
- `single-pr`: stop and require/record `size:exception` before apply.
- `exception-ok`: continue and tell `sdd-apply` this run uses `size:exception`.

Any other `delivery_strategy` value is invalid. Do NOT pick the nearest branch and do NOT proceed: STOP, report the unrecognised value, and re-collect the delivery strategy before launching `sdd-apply`.

Always pass the resolved `delivery_strategy`, `chain_strategy`, and any chosen PR boundary/exception to `sdd-apply` in the launch prompt.

Any review transaction explicitly started outside SDD persists through its own artifact-store branch and budget. SDD completion itself launches no review actors and mints no review authority.

Automatic mode does not override reviewer burnout protection.

## Recovery

For every store, request a fresh native v2 status projection. Artifact reads may supply phase inputs only after native selection; they never re-derive readiness, replace status, or bypass native refusal.

## Provider Defect Handoff

When an SDD task encounters a possible Gentle AI provider defect, the full contract lives in `assets/orchestrator-delegation.md` under `#### Gentle AI Provider Defect Handoff (MANDATORY)`. This workflow intentionally provides no summary, alternate report route, or RDD lifecycle instruction.

## Classical completion

After completed apply, follow fresh native status to archive; verification is optional and explicitly invokable when its native dependency is ready and the provider recommends apply or archive. Never rewrite a pinned provider that still selects verify. Archive owns applicable delta-spec composition and retains task truth, dependsOn, real edit authority, confinement, collision/destructive-change consent, archive history and recovery. There is no standalone sync phase or post-SDD RDD prerequisite.
