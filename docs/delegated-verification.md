# Delegated verification

How the Gentle Pi orchestrator decides who verifies a bounded writer's work. The always-on parent prompt renders a `Receipt-driven development: on|off|unknown` line; the verification module (`assets/orchestrator-verification.md`, Verification rule) keys the verification rule on it. Because the line sits in the cached system-prompt prefix, a session keeps the first line it rendered and re-renders it when the off state changes (which also drops or restores the review execution contract); an `unknown` to `on` flip or a deciding-source change keeps the original text. Off is freshly confirmed for each run; a failed read after off renders unknown rather than relying on a stale off status. Review tools always read the live mode. While the pinned line reads `off`, the parent request also carries a lean review loadout: `gentle_review` keeps its schema but its snippet, guidelines, and description cover only `assess`, and the `gentle_review_capture`, `gentle_review_capture_group`, and `gentle_review_scope` declarations are hidden (they stay registered and active). The loadout follows the pinned line, so it changes only at the next run after RDD turns off or back on, together with the review execution contract; `on` and `unknown` keep the full registered text. This page is package-owned; `docs/review-integration.md` mirrors the Gentle AI contract and must stay byte-identical to it.

## Verifier preparation

The independent verifier makes one isolated preparation attempt. At the first inability to prepare a required copy, environment, dependency, or helper, it stops setup and reports one concrete blocker, the exact checks left unrun as unverified, not passed, and any scratch directories created. It does not retry setup or chain helper repairs; the parent stops with one **Needs your decision** result identifying the missing prerequisite and exact unrun checks, without continuing helper repairs or automatically relaunching for the same prerequisite. Setup or infrastructure failure is distinct from a code finding, whose existing correction allowance remains; auxiliary tooling defects remain subject to the existing correction bound, which setup failure does not reset. Successful preparation continues to authorized checks and independent probes within the existing isolation and permission boundaries.

### Explicit recovery after a setup failure

A failed setup is not the same as an unavailable verifier capability. After the missing prerequisite is repaired, the human can explicitly request one new bounded attempt. Preserve the failed attempt and its zero-test result; static inspection and parent tests do not replace the missing independent runtime proof. Before dispatch, confirm the previous child has finished without uncertain status and establish the required payload, dependencies, and scratch capacity (space and inodes where relevant). A smaller system-temp copy is allowed only when it contains every input needed for the authorized probes; workspace symlinks, network access, and dependency installs remain prohibited for the verifier.

This request does not permit automatic retries, reset native budgets, override a denial or terminal native outcome, or bypass consent or an explicit one-run/no-retry limit. If the prerequisite is still missing, report the exact blocker rather than repeating the failed setup.

### Explicit recovery after worker correction exhaustion

A worker-local correction limit ends its automatic cycle, not necessarily the feature. The partial report must preserve the failed commands, output, remaining implementation work, and missing proof. The parent can offer a concrete continuation for explicit human authorization, naming its scope, executor, correction limit, and checks; the human can also stop. A later conversation is not a budget reset, and an active or uncertain child prevents continuation.

Specifically authorized compilation or implementation can continue only when actual native authority and other applicable limits permit it. A read-only inspection with no instantiated native budget does not itself prohibit ordinary edits; it also grants no review approval. Missing required proof still blocks completion and delivery. Native recovery, consent, and terminal-outcome rules remain separate and unchanged.

This is prompt policy, not a runtime-enforced limit; contract tests establish instruction delivery, not agent compliance or a measured speedup.

## Verifier launch admission and post-denial disposition (gentle-shell#2478)

The `gentle-ai-verify` launch is admitted only when its `task` or `context` declares a named high-risk item, names a task of an existing feature document, or the parent's measured context reaches the backstop. The declaration grammar is strict: `Risk: item N (reason)` must start a line (optionally after a list marker like `- `) or start a sentence (after `.`, `!` or `?` and a space). A declaration after another separator such as `; ` or `,` inside a sentence is not recognized. Keep the risk evidence tied to the actual change; never add a Risk line only to gain admission.

Assessment and admission are separate gates. A `gentle_review assess` plan (or its native `review assess` source) may name an independent verifier in the verification plan; it does not grant launch admission. Admission re-validates the actual launch envelope at `tool_call` time and does not receive the assessment result, so a plan that names the verifier can still be rejected when the envelope carries no supported declaration.

After a rejection, no gate-level disposition exists for the same launch: do not retry it, and do not substitute another agent for the verifier. The rejection is launch-scoped, not feature-scoped: it does not make the verifier unavailable for the whole feature, does not mean the change has no risk, and does not by itself keep later required proof unavailable. A new verifier launch requires the user's explicit decision in a new prompt, with a conforming envelope whose risk declaration reflects the actual change. Inline tests, the writer's self-verification, and a user's visual approval never replace the missing independent verification; when it stays unavailable, close with **Needs your decision** naming the missing proof.

## Background capability admission

An explicit agent `tools` declaration containing `bash_background` requires the background-subagents policy to resolve to `on` at dispatch, for both task and background launches. Otherwise the runner fails the task before spawn and reports the policy file, opt-in schema, and `/gentle:background-subagents enable|disable|status`. Fix the deciding policy explicitly; automation must not toggle it. Passing admission forwards the job capability to the child, which registers `bash_background`, `job_list`, and `job_stop` for its own session; the runner then gives a running child job one bounded drain window at settlement instead of killing it immediately. The `monitor` tool stays parent-only, child jobs are never routed through the parent, and no new persisted state is added. Ordinary missing-tool reporting remains the backstop. See the [policy contract](readme-reference.md#capability-reference).

## Receipt-driven development on

The bounded writer runs the exact commands the parent lists under `## Verification`, in the foreground, and reports each as `<command>: <observed result>`. With RDD on or unknown, the parent calls `assess` after it returns and follows the risk tier below. With validated RDD off, assessment is not required: self-verification and a separate verifier for a named high-risk item remain required. The native review is an additional outside view of the change: it never replaces or skips the tier's verification, and the tier's verifier runs before review. A declined consent, a clone-local disable, or a refused START/STATUS therefore changes nothing about required verification.

### How `assess` resolves the review outcome (gentle-pi#1175)

`gentle_review`'s `assess` operation derives `closed` only from the native `candidate.consumed` fact for this exact candidate. Native writes that fact only when the approved review for that candidate is acknowledged. A caller-supplied `closed` is not authority: without that fact it resolves to `unknown`. A declined, unavailable, or unknown outcome falls back to the RDD-off tier table, and `unknown` is never treated as closed.

Rows apply in order; the first match wins.

| Outcome evidence | Resolved `nativeReviewOutcome` | `outcome_source` |
| --- | --- | --- |
| Caller passes `declined`, `unavailable`, or `unknown` | that value | `explicit` |
| This process recorded `declined`/`unavailable` for this exact candidate | that value (wins over closure) | `derived` |
| Native reports `candidate.consumed: true` for this candidate | `closed` | `derived` |
| Anything else, including a bare caller `closed` | `unknown` | `unknown` |

A recorded outcome is keyed by the candidate's own target identity, never by repository alone, so one candidate's outcome never leaks into a different candidate's `assess` call in the same clone.

### How `assess` resolves the writer profile (gentle-pi#1175)

The writer profile comes from the runtime-recorded model and effort of the pending mutations for the root (`writerProfileSource: runtime`). Caller `writerModelId`/`writerEffort` are only a fallback when no runtime evidence exists (`caller`); with neither, the profile is small (`fallback`). The writer profile is reported but never adds a verifier: a `mini` model or `low` effort gets the same plan as any other writer.

### What `assess` projects

When native reports them, `assess` projects `reviewDue`, `reviewDueReason`, `candidate.consumed`, and the native preflight continuation (`nextTransition`) verbatim. Older binaries omit them, and nothing is invented. The continuation is opaque: relay it unchanged, never rebuild it.

## Receipt-driven development off or unknown (gentle-pi#662)

With validated RDD off, a direct `assess` request remains read-only but skips native assessment and assessment-only target status. It returns `nativeRisk: unassessable`, a medium plan unless explicitly escalated, `candidate: null`, and no native review-due or continuation fields. The compatible zero changed-path and changed-line counts mean not measured, not a passive candidate; the skip reason says so. No native approval or candidate evidence is invented.

When RDD is on or unknown, the host exposes one read-only native operation: `gentle-ai review assess --cwd <repo> [--base-ref <ref> --committed-only] --json` (gentle-ai#4295). It is decoded by `lib/review-risk-assessment.ts` and wired through `lib/native-review-cli.ts` exactly like the existing `reviewMode` STATUS reader -- a bounded subprocess with a typed decode, never a mutation. A non-zero exit, a failure envelope, or an older binary without the verb all report native risk `unassessable`, which informs only: the plan is medium and adds no independent verifier unless the agent escalates.

The `gentle_review` tool's `assess` operation (`extensions/gentle-ai.ts`) combines the available assessment with the live `Receipt-driven development:` line to decide whether a delegated writer's change needs a separate `gentle-ai-verify` run, following this tier table. The passive row requires native evidence and therefore cannot be inferred when off:

| Tier | Verification when RDD is `off`/`unknown` |
| --- | --- |
| passive | structural readback by the parent; no separate verifier, no tests |
| medium | writer self-verification stands; no separate verifier, whatever model wrote the change |
| high | only through `escalate` naming a Task Size high-risk item: writer self-verification plus one separate `gentle-ai-verify` run |
| native high, unknown, or assess failed | informs only: writer self-verification stands; escalate when a named high-risk item applies |

The plan risk (`risk`) is high only with an escalation; otherwise a native passive stays passive and every other native tier is medium. The native tier stays visible as `nativeRisk`. The independent verifier is for concrete occasions: the plan adds it only when `escalate` names a Task Size high-risk item, never for size, a native tier alone, a failed assessment, or the model or effort that wrote the change.

With RDD off, do not require ASSESS to run the writer's applicable functional checks or the named-risk independent verifier. A direct plan request does not run native assessment or provide a review continuation; it never enables RDD or authorizes a review lifecycle operation.

This table applies in every RDD state; a closed native review never removes a verifier the tier requires. An unknown RDD line never waives named-risk verification. The parent's own spot check (re-running one reported command before delivery) stays required in every tier.

A native code review is not a substitute for applicable functional checks: tests, builds, and functional verification such as browser checks for UI changes still run when applicable. Review outcomes never authorize delivery; human consent for native review and the user-owned RDD switch are unchanged.

