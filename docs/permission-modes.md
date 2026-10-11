# Choose how permission questions are handled

Use **Normal**, **Auto**, or **YOLO** for the current primary session. Optionally save any of them as the user-global default for future sessions. These modes do not redesign Gentle Shell delegation, expand the task you authorized, or replace independent safety and consent.

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
| **Auto** | A separate, tool-free inference using the current session model checks eligible actions against live user intent before execution. Local reads are classified too; locality does not exempt an action from explicit restrictions. |
| **YOLO** | Standing permission for ordinary already-authorized work and delivery; no Auto classifier. Destructive and independent consent boundaries remain. [Full YOLO details](yolo-mode.md). |

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

The classifier receives a bounded projection of captured live interactive requests, the proposed action and relevant earlier actions. Tool output and arbitrary `role: user` transcript entries are not authority. A resumed transcript or RPC/extension message alone cannot establish the live interactive intent Auto requires. If context cannot be safely represented, the action is not run.

A live request with an attached image still counts; its typed text is what the classifier receives. When a live request answers the assistant, the classifier also receives a bounded tail of the assistant message immediately before it, paired with the reply. That prompt is model-authored, untrusted context: it never authorizes anything by itself and only resolves what a short reply such as "yes" refers to. A reply authorizes only what its prompt concretely named, so authorize writes outside the project by naming the location (for example, "yes, write to `/path/.cache`"). Prompts that look secret-bearing are dropped, leaving the bare reply.

An allow verdict only returns control to the original executor and remaining guards. A denial blocks execution and asks the agent to find a materially safer action within the request—not hide the same effect behind a different tool, script, or delegate. If safe progress needs a real human decision, the agent must ask.

### Boundaries that never become Auto approval

- Existing hard denials, recognized destructive-operation confirmations, configured restrictions, sensitive paths, and explicit user constraints remain applicable.
- Auto cannot modify the permission store through the protected model tool paths to grant itself more authority.
- User-question tools, native review/maintenance consent, opaque-token decisions and delegation-control tools retain their independent contracts. The classifier does not answer them.
- The mode does not choose an unknown remote destination, account or credential, or authorize ambient credential discovery.
- Calls that execute outside Pi's intercepted tool pipeline are outside this hook's coverage. A custom tool is inspected by its name and arguments, not by executing or proving its implementation.

## Failure behavior and cost

Auto uses the **current session model and existing model registry/authentication** in an independent tool-free request. It does not ask the acting conversation to approve itself. Enabling or saving Auto discloses this additional inference; individual actions do not each ask for inference consent. Depending on the provider, these checks add token cost and latency.

Invalid or unavailable verdicts, errors, timeouts, cancellation and stale decisions do not authorize execution. A provider error (for example a transient `503`) is retried twice with a short backoff while the action, mode, model and session stay current; if every attempt fails, the action is not run and the block names the classifier provider as the cause. Changing the action, model, mode or session invalidates a pending decision. Three consecutive denials, twenty total denials since the latest live input, or three consecutive unavailable checks pause further eligible actions pending a safer human instruction. Oversized retained intent requires manual permissions or a fresh scoped session rather than silently dropping restrictions.

The **Auto checks** status and `gentle-auto-permission` session entries account for classifier attempts separately, including denied calls that never produce a normal tool result. Available late usage is recorded when the same live session still owns it. These records are **not included in Pi's native conversation totals**; unavailable usage is not evidence that an attempt was free.

## Persistence and lifetime

The dedicated `permission-mode.json` in Gentle Pi's resolved user config home contains a strict versioned preference. Saving uses a private atomic replacement; malformed or unreadable existing preferences fall back to Normal and refuse an overwrite until repaired. Use the human command/menu path rather than asking model tools to edit this authority file.

Live mode selection is bound to the SessionManager, session ID and canonical Git clone identity, or the canonical workspace directory outside Git. Session replacement, shutdown and reload revoke live callbacks and pending actions. A newly initialized primary session may select its saved default; this is a new application of the global preference, not restoration of an old session grant. Disable the saved default as well if future sessions must stay Normal.

## Limits

Auto is contextual permission checking, **not an operating-system sandbox or a guarantee against prompt injection**. The model can misjudge an action; lexical guards and secret projection are not comprehensive inspection of scripts or tool implementations. Use constrained credentials and process/container isolation for containment.

The design follows Claude Code's general Auto approach, not a claim of identical proprietary classifier behavior. Offline tests establish gating, cancellation, precedence and SDK integration mechanics—not real-provider classification accuracy.

Reference: [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes) and [Anthropic's Auto mode engineering article](https://www.anthropic.com/engineering/claude-code-auto-mode).
