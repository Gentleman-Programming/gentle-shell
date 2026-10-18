# Choose how permission questions are handled

Use **Normal**, **Auto**, or **YOLO** for the current primary session. Optionally save any of them as the user-global default for future sessions. These modes do not redesign Gentle Shell delegation, expand the task you authorized, or replace independent safety and consent.

## Tool context in Auto

For each pending tool, Auto can include the effective registry's name, description and argument schema as **untrusted descriptive evidence**. The same mechanism applies to ordinary tools and plugins; no tool name or description grants permission. These definitions are not added to the reviewer's callable tools, and embedded instructions cannot replace the live user request or restrictions.

The snapshot is limited to 8 KiB, 512 JSON nodes and 12 levels of nesting. It omits metadata whole if it is missing, malformed, contains detectable credential material, or would crowd out the live request/action. Accessors and custom serializers are not invoked; non-JSON symbol and non-enumerable annotations are excluded. This does not change the protection of secrets in actual action arguments. A changed projected definition revokes a pending verdict. When metadata is unavailable, the existing classifier path remains active without inventing tool semantics or an automatic allow.

Definitions describe intended behavior; they do not prove implementation safety. This context improvement does not by itself explain timeouts or unsupported reviewer tool calls. Deterministic tests verify projection, bounds and admission behavior, not a live model's interpretation.

## Long sessions in Auto

Auto sends the classifier your live messages from this session, up to 24 KB. Beyond that it no longer blocks every action. It always keeps your **first** message (the task) and your **latest** message, fills the rest with the most recent messages, and shortens any message over 6 KB in the middle with a `[N bytes omitted by host]` marker. Sizes are measured as the classifier receives them (JSON-escaped), with room reserved for the omission note. The classifier is told how many earlier messages were left out; that extra policy is sent only when something was omitted.

A restriction stated only in an omitted message, or in the shortened middle of a long message, no longer reaches the classifier. A very large action can still exceed the classifier input budget on its own. Silence is not permission, so the classifier still requires clear authorization in the kept messages for destructive, irreversible, external or out-of-scope actions. Restate any restriction that must hold for the whole session. No extra model call is made, and history held in memory still resets on reload.

## Task-linked project memory

Auto still classifies every memory call. It can treat a non-sensitive Engram finding or session summary as auxiliary work within the live authorized task, rather than requiring a separate request for each save. Explicit no-save/no-persistence restrictions always win; this does not permit secrets, deletion, maintenance, personal/global or cross-project writes, or unrelated `topic_key` overwrites.

This contextual treatment requires live host evidence, not a tool name or an assistant claim:

- The effective `mem_current_project` and write registrations must come from the same native `npm:gentle-engram` package source. MCP adapters, namesakes, ambiguous effective registry entries and unavailable provenance do not qualify. Pi resolves duplicate tool names before exposing this registry; the check follows the effective winning registration, not historical registrations.
- An already-authorized `mem_current_project({cwd})` must complete successfully in this session with exactly the current workspace cwd, a nonempty canonical project, `git_remote` or `dir_basename` resolution, and no ambiguity, alternatives or warning/error fields.
- The subsequent native `mem_save` or `mem_session_summary` must explicitly supply that same `cwd` and `project`; saves must use project scope (or its default). Self-asserted project names alone do not qualify.

The evidence is never restored from transcript text. Session/workspace replacement, permission-mode cancellation, removed branch anchors, provider changes or an unsuccessful new resolution invalidate its applicability. No extra resolution call is launched automatically by the admission layer. Without this evidence, calls remain on ordinary contextual classification; they are not automatically allowed or denied by this adapter. Fixture tests prove these boundaries and plumbing, not a live model's interpretation of the policy.

## Quick path

```text
/gentle:mode auto
/gentle:mode status
```

To start future sessions in Auto, save the default separately:

```text
/gentle:mode default auto
```

Changing the default does **not** change the current session. To return this session and future sessions to Normal, run both:

```text
/gentle:mode normal
/gentle:mode default normal
```

| Mode | Behavior |
| --- | --- |
| **Normal** | Existing permission behavior; the default when no valid global preference exists. |
| **Auto** | A separate reviewer using the current session model checks eligible actions against live user intent before execution. Local reads are classified too; locality does not exempt an action from explicit restrictions. |
| **YOLO** | Standing permission for ordinary already-authorized work and delivery; no Auto classifier. Destructive and independent consent boundaries remain, except recursive removal of the session's own [temp scratch](yolo-mode.md#temp-scratch-removal). [Full YOLO details](yolo-mode.md). |

## Commands and menu

| Command | Effect |
| --- | --- |
| `/gentle:mode normal`, `auto`, or `yolo` | Select exactly one mode for the current interactive primary session. |
| `/gentle:mode status` or `/gentle:mode` | Show current mode and saved default. |
| `/gentle:mode default normal`, `auto`, or `yolo` | Save the default for new primary sessions, leaving the current mode unchanged. |
| `/gentle:yolo enable`, `disable`, or `status` | Existing shortcut; enable selects YOLO, disable selects Normal. |

In `/gentle:customize` → **Editor**, use **Session permissions** to change the current mode, or **Default permissions** to save a future-session preference. The original **YOLO: ON/OFF · session only** row still toggles the live mode; it does not save a default. Browsing, previews, and closing the menu do not grant permission.

Current-session selection takes precedence over the global default. Repository settings, visual profiles, and session transcript entries cannot supply a permission-mode default. Package-owned children do not inherit the parent's elevated mode; their existing bounded delegation and safety paths remain in charge.

## What Auto checks

Auto intercepts eligible primary tool calls before their executors run, including `write`/`edit`, shell tools (`bash`, `bash_background`, `monitor`), custom/MCP tools, and nested calls dispatched through Pi's tool-event pipeline, such as codemode's `executeTool` calls. Local `read`, `grep`, `find`, and `ls` calls are classified, as are local edits. Workspace locality is not a safety exemption: explicit read prohibitions and read-only instructions remain part of the decision.

The classifier receives a bounded projection of captured live interactive requests, the proposed action and relevant earlier actions. For simple local script commands it can request bounded read-only inspection of exact host-selected files before deciding. This is evidence gathering, not permission to run a script. Tool output and arbitrary `role: user` transcript entries are not authority. A resumed transcript or RPC/extension message alone cannot establish the live interactive intent Auto requires. If context cannot be safely represented, the action is not run.

A live request with an attached image still counts; its typed text is what the classifier receives. When a live request answers the assistant, the classifier also receives a bounded tail of the assistant message immediately before it, paired with the reply. That prompt is model-authored, untrusted context: it never authorizes anything by itself and only resolves what a short reply such as "yes" refers to. A reply authorizes only what its prompt concretely named, so authorize writes outside the project by naming the location (for example, "yes, write to `/path/.cache`"). Prompts that look secret-bearing are dropped, leaving the bare reply.

Earlier actions are optional evidence, not permission precedent. Auto retains at most 12 complete recent records within 4 KB, omits oversized records rather than truncating script contents, and clears this window on fresh human input. It still retains live human restrictions: a new instruction does not silently erase an earlier prohibition. A large previous write therefore does not consume every later action's classification budget.

Auto deliberately does not cache blanket approval for reads or command names. Files and script effects can change, and an explicit prohibition such as “do not read private-notes.txt” still applies to otherwise routine local work.

Answers submitted through the first-party choice and questionnaire UI are captured directly by the host, not reconstructed from tool results. Auto keeps the actual selected label or free text alongside the complete displayed question/options as **untrusted context**, so a generic “Yes” retains its original scope. Valid answers can recover a paused Auto check. Opaque choice tokens never become permission text. Cancelled, stale, noninteractive, or unrelated-session responses grant nothing; mode/session changes revoke captured UI answers. An answer always stays trusted; its question is kept while it fits the 4 KB question budget, newest first. See [host-answer provenance](auto-permission-answers.md).

An allow verdict only returns control to the original executor and remaining guards. A denial blocks execution and asks the agent to find a materially safer action within the request—not hide the same effect behind a different tool, script, or delegate. If safe progress needs a real human decision, the agent must ask.

### Boundaries that never become Auto approval

- Existing hard denials, recognized destructive-operation confirmations, configured restrictions, sensitive paths, and explicit user constraints remain applicable.
- Auto cannot modify the permission store through the protected model tool paths to grant itself more authority.
- User-question tools, native review/maintenance consent, opaque-token decisions and delegation-control tools retain their independent contracts. The classifier does not answer them.
- The mode does not choose an unknown remote destination, account or credential, or authorize ambient credential discovery.
- Calls that execute outside Pi's intercepted tool pipeline are outside this hook's coverage. A custom tool is inspected by its name and arguments, not by executing or proving its implementation.

## Failure behavior and cost

Auto uses the **current session model and existing model registry/authentication** in an independent request. Ordinary checks remain tool-free; an eligible script check can inspect at most two complete 8 KB files, with at most three provider calls and a 60-second overall limit. Each provider call has a 20-second deadline. Only explicit script operands in simple shell commands, or `package.json` for supported package-script commands, are eligible. Compound commands, cwd-changing options (such as `bun --cwd nested check.ts`), substitutions and globs are not expanded; Auto does not crawl directories or execute a script to assess it. See [inspection limits and accounting](auto-permission-evidence.md). It does not ask the acting conversation to approve itself. Enabling or saving Auto discloses this additional inference; individual actions do not each ask for inference consent. Depending on the provider, these checks add token cost and latency.

Invalid or unavailable verdicts, errors, timeouts, cancellation and stale decisions do not authorize execution. A provider error (for example a transient `503`) is retried twice with a short backoff while the action, mode, model and session stay current; if every attempt fails, the action is not run and the block names the classifier provider as the cause. Changing the action, model, mode or session invalidates a pending decision. Three consecutive denials, twenty total denials since the latest live input, or three counted unavailable checks without a usable verdict pause further eligible actions pending a safer human instruction. Contention (`busy`), cancellation and expired decisions do not count toward the unavailable-check limit. Long sessions keep a bounded window of your messages instead of pausing; see [Long sessions in Auto](#long-sessions-in-auto).

Technical failures are not safety verdicts:

| Failure | What to do |
| --- | --- |
| Timeout | The action did not run; a timeout alone does not mean it is unsafe. Wait for the pending provider request to settle, then retry or use manual permissions. |
| Classifier still settling | Do not launch more checks to route around the pending request. This does not consume the unavailable-check limit. |
| Context over budget | Narrow the current action or use manual permissions. Repeating the same oversized input does not help. |
| Potentially sensitive evidence | Use non-sensitive evidence or manual review; do not reveal credentials to secure approval. |
| No live human request | Provide a specific instruction in the current branch. A transcript alone is not restored authorization. |
| Invalid/truncated verdict | Retry later or use manual permissions. No action is authorized by a malformed reply. |

Changing to manual permissions is always a human decision; Auto never changes mode to recover itself.

The **Auto checks** status and `gentle-auto-permission` session entries account for classifier attempts separately, including denied calls that never produce a normal tool result. Available late usage is recorded when the same live session still owns it. These records are **not included in Pi's native conversation totals**; unavailable usage is not evidence that an attempt was free.

## Persistence and lifetime

The dedicated `permission-mode.json` in Gentle Pi's resolved user config home contains a strict versioned preference. Saving uses a private atomic replacement; malformed or unreadable existing preferences fall back to Normal and refuse an overwrite until repaired. Use the human command/menu path rather than asking model tools to edit this authority file.

Model `write`/`edit` calls keep the config home protected except for the main-channel updater's `dev-binary.json`, `channel.json`, `main/` and `tools/go`. Those destinations select or build executable code, so they still require authorization under the current mode's ordinary checks; Auto classifies them and can deny an update. They are not automatically allowed. Permission preferences, global and project `runtime-guardrails.json`, their parent directories and symlink aliases resolving to them stay blocked even if a classifier would allow the action. Other config-home state, including model routing, persona and privacy preferences, remains protected.

Shell recognition remains deliberately conservative: commands mentioning the config home or policy filenames can still be blocked. This change does not relax shell protection, authorize routing around a denial, or turn the hook into a sandbox.

Live mode selection is bound to the SessionManager, session ID and canonical Git clone identity, or the canonical workspace directory outside Git. Session replacement, shutdown and reload revoke live callbacks and pending actions. A newly initialized primary session may select its saved default; this is a new application of the global preference, not restoration of an old session grant. Disable the saved default as well if future sessions must stay Normal.

## Limits

Auto is contextual permission checking, **not an operating-system sandbox or a guarantee against prompt injection**. The model can misjudge an action; bounded file evidence, lexical guards and secret projection are not comprehensive inspection of scripts, their dependencies or tool implementations. Use constrained credentials and process/container isolation for containment.

The design follows Claude Code's general Auto approach, not a claim of identical proprietary classifier behavior. Offline tests establish gating, cancellation, precedence and SDK integration mechanics—not real-provider classification accuracy.

Reference: [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes) and [Anthropic's Auto mode engineering article](https://www.anthropic.com/engineering/claude-code-auto-mode).
