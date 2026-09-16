# Gentle Shell reference

Gentle Shell is the `gentle-shell` coding-agent workspace built for Pi, not a theme. The `gentle-pi` package integrates the shell bar, workspace changes, provider usage where Pi exposes it, and native agent orchestration views into a Pi session. Start with the [README](../README.md#features) for the product overview.

For everyday development, use [ODD and feature recovery](readme-reference.md#organic-driven-development). Choose SDD explicitly when you want its formal phase artifacts; the workspace supports both. TDD follows configured mode, and native review remains a separate user-owned choice.

Source map: [shell extension](../extensions/gentle-shell.ts), [shell bar](../lib/shell-bar.ts), [changes model](../lib/shell-changes.ts), [changes view](../lib/shell-changes-view.ts), [usage model](../lib/shell-usage.ts), [usage view](../lib/shell-usage-view.ts), [agents extension](../extensions/gentle-agents.ts), and [agent runner](../lib/agents-runner.ts).

## v2.6.0 workspace updates

The [v2.6.0 release](https://github.com/Gentleman-Programming/gentle-pi/releases/tag/v2.6.0) makes the workspace state more durable and inspectable:

- Registered worktrees survive reloads. `/gentle:changes` groups each dirty root and presents status, line counts, and lazy diffs without conflating identical paths from different worktrees.
- Fullscreen pointer navigation and the responsive sidebar keep changes, agents, and TODO usable at changing terminal widths; cached frames avoid redrawing inactive sidebar content while live status still updates.
- The Agents List and Details views preserve the orchestrator/session hierarchy and completion, abort, and lost-exit history. Parent-child queries and notifications have an explicit handoff path, while model, effort, and usage stay observable per task.
- Named `/gentle:profiles` atomically route the orchestrator separately from packaged and review roles; see the [technical reference](readme-reference.md#agent-model-profiles) for the profile model.

The source checkout currently prepares `gentle-pi` `3.1.0` with a package-local Gentle AI `v3.0.1` pin; this is not a claim that `3.1.0` is published.

## Shell interactions and runtime behavior

Gentle Shell is the Pi workspace experience provided by the `gentle-pi` package. It follows the Gentle themes: one border language, champagne titles, rose for whatever is alive.

In fullscreen at 140 columns or wider, the right sidebar scrolls **✿ Gentle-Pi ✿ → Status → Changes → Agents → TODO** together. The one-line heading is horizontally centered within the usable rail width, with pink flowers and normal white text in the Gentleman themes. Colors follow the active theme; no artwork scaling or custom fonts are used. Narrow/mobile terminals and regular mode retain bottom widgets without the sidebar heading. The original rose and text logo remain in the main chat startup intro.

The rail reuses its last frame until something it paints changes, so silent frames stay cheap and live session state still lands on the next frame: a model switch, a new thinking level, context growth, session cost, session name and extension statuses all refresh the Status card without a redraw of the rest of the sidebar.

The sidebar Status card also shows `Profile` in its Model section when the profiles store has a valid active marker. It follows profile changes on the next render. Missing, unreadable, or invalid stores leave the line hidden. The compact bottom bar is unchanged.

The status bar replaces pi's three-line footer with a single line of segments:

```text
✿ gentle-pi ⟡ ~/work/gentle-pi main ⟡ gpt-5.5 · medium ⟡ ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub ⟡ MCP: 3 servers enabled        Release notes
```

- Context is a gauge, not a number. It turns amber at 80% and red at 95%; after compaction it shows `?%` until the next response.
- Cost carries `sub` when the active model runs on a subscription login.
- Statuses other extensions publish through `setStatus` are appended as trailing segments; the session name sits at the right edge.
- On narrow terminals the session name is dropped first, then trailing segments, before the line is truncated.

The prompt wraps pi's editor in a rounded frame with a petal that shows what the agent is doing:

```text
╭─ ✿ working ──────────────────────────────────────────╮
│ type, or / for commands                              │
╰──────────────────────────────────────────────────────╯
```

- The petal is still while pi waits, spins with a `working` label while the agent works, and turns amber with a `queued` label when messages are waiting behind the current turn. pi's own "Working" row above the editor is hidden, since the frame already says it.
- The frame uses the theme's border color over the panel background, so the prompt reads as one panel with the cards around it; the editor's scroll indicators stay inside the frame.
- The hint appears only while the editor is empty.
- If another extension already installed a custom editor, Gentle Shell leaves it alone.

Changes shows **captured write/edit operations from this agent session and its owned subagents**. It does not scan the repository on startup, read all untracked files, or poll live files in the background. Fullscreen, the sidebar, and mouse interaction are unchanged.

```text
✎ 3 files · +42 −7 · extensions/gentle-shell.ts, lib/shell-bar.ts, tests/x.test.ts · /gentle:changes
```

### What appears in Changes

- A worktree appears only after a captured successful mutation. Reading a file, opening a directory, registering a worktree, or launching a child is not mutation evidence.
- Diffs compare the content observed before the agent's first captured operation with its latest captured result, not with HEAD. Consecutive agent edits combine; an agent revert removes its net change.
- Edits from your editor or other sessions do not update these captured diffs. If an external or unobserved edit breaks continuity before the next agent operation on the same file, the file is marked **diff unavailable**, rather than mixing ownership.
- Only worktrees in the coordinating session's Git clone are accepted. Child evidence is accepted only from an owned task with paired successful write/edit events and a matching target.
- **Coverage is deliberately limited to write/edit tools.** Shell commands, custom mutation tools, failed/interrupted outcomes and children without the capture extension provide no attributed diff. A missing row does not mean the repository is clean or that no other changes occurred.

### Bounds and session lifetime

Capture reads only the named target, up to 64 KiB and 2,000 text lines. Binary, oversized, nonregular and unverifiable snapshots show unavailable counts, never fabricated zero-count proof. At most 256 operation identities and 4 MiB of serialized evidence are retained per session; reaching the limit produces a warning.

Snapshots are stored locally in Pi custom entries (`gentle-pi.session-change/v1`), including bounded before/after source text. Exit/resume and reload restore captures only for the exact same session UUID. New sessions and forks do not inherit attribution from another UUID. Ephemeral `--no-session` runs do not persist after exit. Capturing remains active in headless children and when the visual shell is disabled.

The separate `session_worktree_register` tool still registers canonical same-clone roots for coordination, but registration alone never adds files to Changes. Existing `gentle-pi.session-worktree/v1` entries do not establish file-level attribution.

### Browse captured diffs

`/gentle:changes` or `alt+g` opens the two-pane viewer. Worktrees are accordion groups on the left; selecting a file displays its captured diff on the right.

- `j`/`k` or arrows navigate. On a group, Enter, Space or Right expands it; Left returns to its parent or collapses it. `ctrl+j/k` or Page Up/Down scroll the diff; Escape or `q` closes.
- Fullscreen left-click selects files; mouse wheels scroll the file list and diff independently. Hover does not open files.
- Opening, pressing `r`, and the overlay's refresh cadence consult only the captured session model. They never rescan Git or load the current file contents. Same-line-count edits invalidate the diff preview by content revision.
- On a file, `o` or Enter opens the actual current file in `$VISUAL` or `$EDITOR`, with its worktree as cwd. Edits made there are external and are not attributed to the agent.
- `GENTLE_PI_SHELL_CHANGES_KEY` rebinds the shortcut; `off` disables it. `GENTLE_PI_SHELL_CHANGES_POLL_MS` controls only the open overlay's in-memory refresh. `GENTLE_PI_SHELL_CHANGES_WATCH_MS` no longer enables filesystem polling.
- No captured changes means no widget and an informational notice; it does not assert that the working tree is clean.

### Command palette

`/gentle:commands` or `alt+k` opens a curated, grouped command menu, OpenCode-style — not a raw listing of every registered extension command. Entries are grouped under Configuration, Session, Diagnostics, SDD, and Skills, each shown by a human label with its shortcut hint where it has one; a command only appears when it is both in the curated set and actually registered. The Search row filters by label, by the underlying command name, and by description; arrows or `ctrl+j`/`ctrl+k` move, enter runs the highlighted entry exactly as if its command had been typed, escape closes. `GENTLE_PI_COMMANDS_KEY` rebinds the shortcut; `off` disables it. Built-in Pi commands are not listed. The default is `alt+k`, not `ctrl+k`, because Pi reserves `ctrl+k` for the editor's delete-to-line-end action.

To use `ctrl+p` like OpenCode, rebind Pi's `app.model.cycleForward` in `~/.pi/agent/keybindings.json` (Pi reserves that action, so an extension cannot take `ctrl+p` while it holds it) and set `GENTLE_PI_COMMANDS_KEY=ctrl+p`.

Subscription usage shows in the bar after the cost, and `/gentle:usage` opens a panel with every window per provider:

```text
✿ gentle-pi ⟡ … ⟡ $9.49 sub ⟡ codex 5h ▰▰▰▰▰▱▱▱ 62% · week 31%
```

- For Codex, usage comes from the same account usage endpoint the Codex CLI reads, using the OAuth token pi already holds. It is fetched at session start, at most every 5 minutes after a turn, and on `r` in the panel. Rate-limit headers on SSE responses are picked up too.
- For Claude Pro/Max, usage arrives in the rate-limit headers of every response, so the 5h and weekly windows appear after the first turn.
- The bar names the subscription it shows (`codex`, `claude`) and always follows the active model. The panel puts the active provider first, marked with the petal, and says why it has no data when it does not: API-key providers have no subscription windows, Claude reports after the first response, Codex waits for a fetch.
- Only the plan name and the windows are kept; account details in the payload are discarded.
- Gauges turn amber at 80% and red at 95%, like the context gauge.

Gentle notices are drawn as cards: the same rounded frame as the prompt, with the left rail and the title in the tone of the notice and the rest of the frame in the theme's border color.

```text
╭─ ✿ Gentle AI · review preflight ─────────────────────────────────────╮
│ Receipt-driven development is enabled, and this worktree holds an…   │
╰──────────────────────────────────────────────────────────────────────╯
```

- Every call into the gentle-ai binary and every `gentle_review` tool renders as a card under the rose, `🌹︎ Gentle AI`: the rail is amber while it runs, green when it finished, red when it failed; the expand key sits in the top rule once the tool finished, and the collapsed result shows only its line count. Reviewer captures name their lens (`review capture · risk`; the group lists all four).
- The review preflight reminder renders as a card in the transcript with the expand key in its top rule.
- An active dev-binary override shows above the editor at startup, in amber, naming the binary and its digest, and leaves with the first prompt; an invalid override shows in red with the reason.
- Subagents draw their own card; see Gentle Agents below.

### Gentle Agents

The current package requires Pi 0.85.1 or newer (development tests pin 0.85.1). Use the latest Pi release; gentle-pi does not update your installed Pi automatically. Children, including any `GENTLE_PI_AGENTS_PI` override, must emit `agent_settled`: `agent_end` records a run's output but is not completion because retries or queued continuations may follow.

The `subagent_*` tools and the agents card replace the third-party subagents package (remove `npm:pi-subagents-j0k3r` from your pi packages; while it is still installed the tools stay unregistered and a warning says so at startup). Agent definitions and settings are the ones you already have: markdown agents in `~/.pi/agent/agents/`, `~/.pi/agent/subagents/`, `<cwd>/.pi/agents/`, `<cwd>/.pi/subagents/` (project beats global, `subagents/` beats `agents/`), and `subagents.json` at the global and project level (`default_model`, `default_effort`, `default_mode`, `model_profiles`, `stall_timeout_ms`, `tool_stall_timeout_ms`, `max_concurrency`, `history_max_tasks`).

Agent paths follow `GENTLE_PI_AGENT_HOME`, then `PI_CODING_AGENT_DIR`, then `~/.pi/agent` for definitions, config, history, child sessions, and transcripts. These overrides select the agent profile; they do not sandbox project or shared global resources.

```text
╭─ ❀ Agents · 1 active · 1 done ─────────────────────────────── 1m24s ╮
│ ✓  sdd-explore  map footer data sources    gpt-5.6-terra · 34k · $0.27 · 25s │
│ ◐  sdd-apply    write gentle-shell footer  gpt-5.6-terra · 12k · $0.09 · 41s │
╰──────────────────────────────────────────────────────────────────────────────╯
```

Every subagent is its own `pi --mode rpc` child process, so the terminal never runs subagent work: the host reads JSON lines, applies each one as a small delta to a bounded per-task thread, and notifies only the listeners of that task. A task-mode child's question (`ctx.ui.select`, `confirm`, `input`, `editor`) reaches you as an ordinary pi dialog; a background child's question is dismissed. Subagents have no automatic total execution timeout: a long-running child remains live while it continues emitting RPC events. A silent child still times out through the configurable `stall_timeout_ms` watchdog (default four minutes). An announced tool call that is still running is live work, not silence, so it is bounded by `tool_stall_timeout_ms` instead (default 30 minutes, never below `stall_timeout_ms`). Closing pi stops the children that are still running.

- `subagent_list_agents`, `subagent_run` (`agent`, `task`, `label?`, `context?`, `workspace_root?`, `mode?` task or background), `subagent_status`, `subagent_result`, `subagent_list_tasks`, `subagent_reply` (one current-session reply to a live child query), `subagent_cancel`, `subagent_send_message` (steer a running child), `subagent_continue` (resume a finished task in its own session).
- `orchestrator_session_id`, `orchestrator_list`, and `orchestrator_send_message` provide local-profile session notifications. List results advertise IDs only and reachability remains unknown. Sending selects the sole advertised peer or asks the user to choose; a successful ACK means the peer accepted the notification for delivery, not that it read or completed work. This is notification-and-ACK transport only: it has no cross-session queries, offline queue, retries, broadcasts, or read/completion guarantees. On Unix, presence records remain in the profile's private transport directory while socket endpoints use a private, profile-hashed directory below the canonical system temporary directory, keeping endpoint length independent of the profile path and at most 100 encoded bytes. The shared system temporary parent is only validated (current-user-owned without group/other write, or root/current-user-owned, world-writable, and sticky); it is never claimed, permissioned, or cleaned up by gentle-pi. On POSIX, the transport uses private Unix-domain sockets; on Windows, it uses private named pipes scoped by the current account SID. Notification and ACK limits remain bounded across platforms.
 - `subagent_run.workspace_root` selects an existing worktree in the session's Git clone. Validation happens before queueing; the child runs at that canonical root. Successful OS spawn registers the root in the originating parent session, including delayed queued launches, even without an active shell listener. Failed spawns do not register. `subagent_continue` retains the previous task's cwd; status and task details expose it.
- Background work requires a live interactive/RPC parent. Both `subagent_run` and `subagent_continue` reject background mode in `pi -p` before creating or spawning a task: the parent exits before it can receive a later result. Use task mode for bounded print-mode work.
- A background task's result comes back to the model as a `gentle-agents.result` message, drawn as a rose card, and starts a new turn when the agent is idle; the model never polls.
- A configured child can call `subagent_parent_message` with bounded, well-formed Unicode text. Notifications retain their existing admission semantics. A `kind: "query"` waits for one strictly correlated `subagent_reply` for at most 30 seconds; each child has at most four pending queries, and disconnect, timeout, stop, and send failure settle each request once. The current parent session alone can reply. The first admitted task-mode query ends the original tool response while its child keeps running; its eventual non-cancelled completion returns once as a follow-up only if that same session is still active. Channel closure prevents later sends and automatic retry is not provided. Peer transport, offline delivery, retries, and broadcasts are unsupported.
- The card shows the active session's tasks only: after `/new` or `/resume` the earlier session's tasks leave it and come back with their session. Finished rows stay for one minute (three at most), and the card spends at most a quarter of the terminal (three to eight rows) on tasks; beyond that the rest fold into one `… N more · alt+a to view` line so the editor never leaves the screen. Questions and running work keep their rows first.
- `/gentle:agents` or `alt+a` opens a full-terminal overlay. At 60+ columns, the split view shows groups/tasks beside the retained semantic thread; uppercase `F` or **Fullscreen** expands that thread. At 12–59 columns, click a current subagent directly to inspect its thread; in All sessions, first select its orchestrator. `Enter`/`Tab` also enter a narrow selection. **Back** or `Escape` returns one level, closing only at the root; **Close** or `q` closes globally without cancelling children. Selection and manual thread scrolling survive Back and resize.
- Mouse controls take priority over keyboard hints: **Follow** (`f`), **Open session** (`o`), **Stop** (`s`, legacy `c`, owned active tasks only), and **Scope** (`a`). A compact footer's `>` cycles through actions. Scope switches between this session's direct active children and all open orchestrators, including idle ones. Open writes a markdown transcript for `$EDITOR`, not a resumed child session. `j`/`k` move through lists or scroll an expanded thread; `ctrl+j`/`ctrl+k` and Page Down/Up page the thread. In Pi fullscreen mode, the wheel scrolls the viewport under the pointer; regular terminal mode does not capture mouse input. Below 12 columns or three rows, only a bounded Close cell remains; zero-sized terminals render nothing.
- The thread displays all retained Text, Thinking, Note, and Tool content without an additional presentation cap; existing store limits and truncation markers still apply. Only the selected task is subscribed while the overlay is open.
- Thread entries are presented as labeled Text, Thinking, Note, or Tool blocks; tool blocks show their status and nonempty output.
- Current scope has no orchestrator wrapper and excludes every terminal task. All sessions discovers open Pi instances sharing the same agent profile, even across repositories; it does not infer open sessions from retained tasks. Directory headings support left/right and mouse expansion, and cannot stop or open a task. Peer children and their retained threads are read-only: no local stop, editor-open, or continuation routing, and no import into the local task store.
- Presence refresh is paged while the overlay is open. Graceful shutdown withdraws an instance; after abrupt closure its last heartbeat may remain visible for up to 15 seconds plus the time to complete the next directory refresh. A recent heartbeat is a heuristic, not proof that a process is alive. Same-profile, same-user processes share retained activity text; this is not an authorization channel.
- `alt+s` confirms stopping the current active or queued subagents owned by the current process. `GENTLE_PI_AGENTS_STOP_KEY` rebinds it; `off` disables it.
- Finished tasks are written to `~/.pi/agent/gentle-agents/tasks/` (one JSON per task, newest `history_max_tasks` kept, default 200) and come back on demand for `subagent_result` and `subagent_continue`, never as overlay history. Child sessions live under `~/.pi/agent/gentle-agents/sessions/`.
- `ctrl+shift+a` collapses the card to its first row (`GENTLE_PI_AGENTS_KEY`), `GENTLE_PI_AGENTS_VIEW_KEY` rebinds the overlay, `GENTLE_PI_AGENTS_PI` overrides the pi command used for children, and `GENTLE_PI_AGENTS=0` disables the tools and the card.

### Gentle Todo

The `todo` tool and its card replace the third-party todo extension (remove `npm:@juicesharp/rpiv-todo` from your pi packages; sessions written by it replay into the new card).

```text
╭─ ❀ Todos · 1 of 3 ──────────────────────────────────────╮
│ ✓ Add quiet tool rendering                              │
│ ◐ Fix quiet tools conflict · fixing conflict            │
│ ○ Show git bash tails                                   │
╰─────────────────────────────────────────────────────────╯
```

Three things keep the list current, which a static tool description cannot:

- `write` replaces the whole list in one call, so the model rewrites the plan instead of patching it; `add`, `update`, `clear`, and `list` remain for single moves.
- Every turn's system prompt carries the open tasks and the rules: in_progress before starting, done right after finishing, update before ending the turn.
- A list that goes two turns untouched while tasks stay open turns amber with `stale · N turns`, and the prompt says so, so the model brings it up to date.

A finished list stays on screen for the turn it finished in and clears at the next. `ctrl+shift+t` collapses the card to the task in progress (`GENTLE_PI_TODO_KEY` rebinds it, `off` disables it); `GENTLE_PI_TODO=0` disables the tool and the card.

Set `GENTLE_PI_SHELL=0` to keep pi's built-in footer and editor.

