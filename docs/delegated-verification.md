# Delegated verification

How the Gentle Pi orchestrator decides who verifies a bounded writer's work. The always-on parent prompt renders a `Receipt-driven development: on|off|unknown` line; the verification module (`assets/orchestrator-verification.md`, Verification rule) keys the verification rule on it. Because the line sits in the cached system-prompt prefix, a session keeps the first line it rendered and re-renders it when the off state changes (which also drops or restores the review execution contract); an `unknown` to `on` flip or a deciding-source change keeps the original text. Off is freshly confirmed for each run; a failed read after off renders unknown rather than relying on a stale off status. Review tools always read the live mode. While the pinned line reads `off`, the parent request also carries a lean review loadout: `gentle_review` keeps its schema but its snippet, guidelines, and description cover only `assess`, and the `gentle_review_capture`, `gentle_review_capture_group`, and `gentle_review_scope` declarations are hidden (they stay registered and active). The loadout follows the pinned line, so it changes only at the next run after RDD turns off or back on, together with the review execution contract; `on` and `unknown` keep the full registered text. This page is package-owned; `docs/review-integration.md` mirrors the Gentle AI contract and must stay byte-identical to it.

## Verifier preparation

The independent verifier makes one isolated preparation attempt. When it fails on a deterministic error in a command or environment the verifier constructed (a wrong flag, conflicting config, a typo, a path it chose), the verifier makes exactly one corrected attempt without asking and reports both. At a second failure, or at any missing or unavailable prerequisite (a tool, network, space, permission), it stops setup and reports one concrete blocker, the exact checks left unrun as unverified, not passed, and any scratch directories created. It does not otherwise retry setup or chain helper repairs. When the verifier returns a self-caused setup error without having used its correction, the parent relaunches it once with the corrected command, without asking a human; otherwise the parent stops with one **Needs your decision** result identifying the blocker and exact unrun checks, without continuing helper repairs or automatically relaunching for the same prerequisite. After the prerequisite is repaired, the human may explicitly request one new bounded verification attempt. Setup or infrastructure failure is distinct from a code finding, whose existing correction allowance remains; auxiliary tooling defects remain subject to the existing correction bound, which setup failure does not reset. Successful preparation continues to authorized checks and independent probes within the existing isolation and permission boundaries.

For Git-dependent checks, the runner exposes the absolute packaged `scripts/prepare-verifier.mjs` path through `GENTLE_PI_VERIFIER_PREPARER`. In one Bash call, invoke `s=$(mktemp -d) && node "$GENTLE_PI_VERIFIER_PREPARER" "$PWD" "$s" '<plan-json>'` to create and use an empty system-temp scratch directory. The plan has `include` (required untracked source and ignored dependency paths), `checks` (exact commands left unrun on failure), optional `baseline` (full commit ID), and optional `runtimeArtifacts` (known socket/FIFO paths to verify and identify as excluded). Git does not enumerate sockets; exclusions are explicitly declared, not discovered by a recursive filesystem scan. It preserves HEAD, the index and current tracked bytes in an independent local Git repository; unselected ignored evidence is excluded. It never runs probes, fetches remote objects or installs dependencies. A successful receipt identifies `work`, elapsed milliseconds, regular-file payload bytes and excluded runtime artifacts; failure exits nonzero with zero probes and exact unrun commands.

This pilot supports ordinary single-root Git repositories and regular-file dependencies inside that root. It rejects links, submodules, worktrees, shallow/shared/sparse/partial history and inputs outside the root; declare unsupported external dependencies as prerequisites. Limits are 20000 files, 256MiB regular-file payload, a 512MiB staged-patch buffer and a 60-second checked preparation budget. Staged patches retain raw bytes and fixed path prefixes regardless of repository diff settings. Scratch may have linked ancestors, but its final directory must not be a link and its real path must remain under system temp, empty and separate from the source. Git subprocesses receive the remaining deadline; filesystem operations check between steps. Git object transfer is not included in the regular-file payload measurement; unavailable baseline/history, capacity or deadline failures leave partial scratch and no probe result. This is deterministic helper behavior, not proof of model adherence or representative large-project performance.

The existing Bash `pipefail` tar copy is retained only for probes independent of Git metadata. A failed archive producer cannot be hidden by a successful extractor. Chain probes with `&&` when they share either setup call; a non-zero preparation result leaves them unrun even if the partial destination contains files. This does not make an oversized copy faster or establish that model-selected alternatives preserve the required payload. The one-attempt rule remains prompt policy, not a runtime-enforced limit.

### Explicit recovery after a setup failure

A failed setup is not the same as an unavailable verifier capability. After the missing prerequisite is repaired, the human can explicitly request one new bounded attempt. Preserve the failed attempt and its zero-test result; static inspection and parent tests do not replace the missing independent runtime proof. Before dispatch, confirm the previous child has finished without uncertain status and establish the required payload, dependencies, and scratch capacity (space and inodes where relevant). A smaller system-temp copy is allowed only when it contains every input needed for the authorized probes; workspace symlinks, network access, and dependency installs remain prohibited for the verifier.

This request does not permit automatic retries, reset native budgets, override a denial or terminal native outcome, or bypass consent or an explicit one-run/no-retry limit. If the prerequisite is still missing, report the exact blocker rather than repeating the failed setup.

### Explicit recovery after worker correction exhaustion

A worker-local correction limit ends its automatic cycle, not necessarily the feature. The partial report must preserve the failed commands, output, remaining implementation work, and missing proof. The parent can offer a concrete continuation for explicit human authorization, naming its scope, executor, correction limit, and checks; the human can also stop. A later conversation is not a budget reset, and an active or uncertain child prevents continuation.

Specifically authorized compilation or implementation can continue only when actual native authority and other applicable limits permit it. A read-only inspection with no instantiated native budget does not itself prohibit ordinary edits; it also grants no review approval. Missing required proof still blocks completion and delivery. Native recovery, consent, and terminal-outcome rules remain separate and unchanged.

This is prompt policy, not a runtime-enforced limit; contract tests establish instruction delivery, not agent compliance or a measured speedup.

## What the independent verifier checks

The change kind decides the verifier's evidence; it never decides whether a verifier runs, which still needs a named high-risk item. The verifier's evidence is what the writer could not see: it does not re-run the suite the writer reported, because the parent's single spot check of one reported command is the check on the writer's own results; the one exception is the user's failing command the parent passes, which it runs even when it is that suite. It runs the commands the parent authorizes as its evidence (the real-case command, the user's failing command, the spec's example commands) and its own probes, including a focused test only when a probe needs it. The parent names the change kind in the verify handoff:

- **External tool or environment** (package managers, CLIs, network services, operating-system behavior): the verifier reproduces the real case with the real tool and the configuration the change will meet, plus its own probes derived from the spec. A fixture that does not match that configuration is not proof.
- **Prompt or other contract text**: the verifier compares every removed or rewritten sentence with the baseline, one by one, for a lost qualifier or a rule turned absolute, and reads each new rule as a literal model would.
- **A fix for a failure the user reported**: the parent passes the user's exact failing command and error text verbatim, with the user's tool versions and configuration; the verifier runs that command against the baseline and against the change. The fix is not verified until that command passes there. The failure counts as reproduced only when that command fails at the baseline with the user's error; when it passes at the baseline or fails there with a different error, the verifier reports the fix unverified and says which, never verified. A handoff without the failing command leaves the fix unverified, with the missing command named; the verifier never guesses one.

When the real case needs the network, an install, or a tool, version, or configuration the verifier's scratch copy does not have, the verifier reports that check unverified with its exact command, and the parent runs that check itself before calling the change verified. Evidence for this split: in one long session the verifier's change-caused findings came only from real-case reproduction, sentence-by-sentence review of prompt text, and its own probes; re-running the writer's suite found none, and the one defect that reached the user escaped because the fixture did not match the user's environment.

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

This table applies in every RDD state; a closed native review never removes a verifier the tier requires. An unknown RDD line never waives named-risk verification. The parent's own spot check (re-running one reported command before delivery) stays required in every tier. A passive change that reports no command needs only its readback.

A native code review is not a substitute for applicable functional checks: tests, builds, and functional verification such as browser checks for UI changes still run when applicable. Review outcomes never authorize delivery; human consent for native review and the user-owned RDD switch are unchanged.

