# Gentle Shell reference

Gentle Shell is the `gentle-shell` coding-agent workspace built for Pi, not a theme. The `gentle-pi` package integrates the shell bar, workspace changes, provider usage where Pi exposes it, and native agent orchestration views into a Pi session. Start with the [README](../README.md#features) for the product overview.

For development, use [ODD and feature recovery](readme-reference.md#organic-driven-development). TDD follows configured mode, and native review remains a separate user-owned choice.

Source map: [shell extension](../extensions/gentle-shell.ts), [shell bar](../lib/shell-bar.ts), [changes model](../lib/shell-changes.ts), [changes view](../lib/shell-changes-view.ts), [usage model](../lib/shell-usage.ts), [usage view](../lib/shell-usage-view.ts), [agents extension](../extensions/gentle-agents.ts), and [agent runner](../lib/agents-runner.ts).

## v2.6.0 workspace updates

The [v2.6.0 release](https://github.com/Gentleman-Programming/gentle-pi/releases/tag/v2.6.0) makes the workspace state more durable and inspectable:

- Registered worktrees survive reloads. `/gentle:changes` groups each dirty root and presents status, line counts, and lazy diffs without conflating identical paths from different worktrees.
- Fullscreen pointer navigation and the responsive sidebar keep changes, agents, and TODO usable at changing terminal widths; cached frames avoid redrawing inactive sidebar content while live status still updates.
- The Agents List and Details views preserve the orchestrator/session hierarchy and completion, abort, and lost-exit history. Parent-child queries and notifications have an explicit handoff path, while model, effort, and usage stay observable per task.
- Named `/gentle:profiles` atomically route the orchestrator separately from packaged and review roles; see the [technical reference](readme-reference.md#agent-model-profiles) for the profile model.

The source checkout prepares `gentle-pi` `3.7.0` with a package-local Gentle AI `v3.7.0` pin; this does not imply that the package release has been published.

## Shell interactions and runtime behavior

Gentle Shell is the Pi workspace experience provided by the `gentle-pi` package. It follows the Gentle themes: one border language, rose for whatever is alive.

### Fullscreen layout

At 140 columns or wider, fullscreen splits into a live header row over a transcript-and-rail split, both driven by [`lib/shell-sidebar-layout.ts`](../lib/shell-sidebar-layout.ts):

```text
✿ Gentle Shell ⟡ ~/work/gentle-pi main ⟡ gpt-5.5 · medium · team              ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub
```

- The header is one row, always visible, and carries only what changes every frame: session identity on the left (brand, cwd, branch, dirty count, model · effort · profile) and the two live counters right-aligned (the context gauge and session cost). It never shows the working/thinking state or extension statuses — those stay in the prompt title and the compact bar. When the terminal is too narrow for everything, segments give way in a fixed order — profile, then effort, then the whole cwd/branch/dirty group — before the counters are touched; below that, only the brand survives, and below that the header renders nothing.
- The right rail scrolls **Status → Changes → TODO**, each an event-driven card that only repaints when its own state changes: a model switch or a cost tick refreshes the header, not the rail. Every card (sidebar or not) paints the same rose frame — the rounded border in the theme's plain border role, the title in the accent role — the look every `CARD_TONE.INFO` card in Gentle Shell uses (warning/error/success cards keep their own tone colors).
- The Status card carries only what an explicit event refreshes: Project (cwd, branch, session name, active profile), Changes, and Integrations (other extensions' statuses). Model, effort, context, cost, and the per-model usage table live in the header instead — the header ticks every frame, so duplicating them in a card would just make that card repaint every frame too.
- Gentle Agents is not part of the rail in any mode: its one card stays above the editor, where it already lived, with fixed right-aligned columns for `model · effort`, tokens, cost, and elapsed, each sized to the widest value among the shown tasks — so the numbers line up vertically even when one row's values are much shorter than another's. A queued task fills only the elapsed column with the word `queued`, leaving the other columns blank rather than overwriting the row.
- The sidebar reuses its last frame until something it paints changes, so silent frames stay cheap; a per-section cache means one card's changing digest (or the header's) never forces an unrelated card to redraw.
- Narrow terminals and regular mode keep the compact bottom bar and the above-editor Agents widget, with no header row and no sidebar.

Below 140 columns, or in regular mode, the compact bottom bar replaces pi's three-line footer with a single line of segments instead:

```text
✿ gentle shell ⟡ ~/work/gentle-pi main ⟡ gpt-5.5 · medium ⟡ ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub ⟡ MCP: 3 servers enabled        Release notes
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
- Ordinary attribution accepts only worktrees in the coordinating session's Git clone. A separately authorized foreign child can contribute target-bound Changes without registering its repository as a same-clone worktree. Child evidence requires an owned, successfully spawned task, paired successful write/edit events, and matching canonical target and live grant; model claims alone are not evidence.
- A changed file's worktree is resolved from its own directory upward (`git rev-parse --show-toplevel` starting there, never from an ancestor's cwd), so a repository nested inside another — a project scaffolded inside a personal workspace clone, say — is always attributed to its own, inner repository, never the outer one.
- When changes span more than one worktree, each tree header shows that root's own branch name, `no commits yet` for an unborn branch, or `detached` only for a real detached HEAD. The label is read from Git's HEAD once per root while the overlay is open (`symbolic-ref` and `rev-parse --verify`); the overlay still never runs `status`, `diff` or a worktree scan on your behalf.
- **Coverage is deliberately limited to write/edit tools.** Shell commands, custom mutation tools, failed/interrupted outcomes and children without the capture extension provide no attributed diff. A missing row does not mean the repository is clean or that no other changes occurred.

### Bounds and session lifetime

Capture reads only the named target, up to 64 KiB and 2,000 text lines. Binary, oversized, nonregular and unverifiable snapshots show unavailable counts, never fabricated zero-count proof. At most 256 operation identities and 4 MiB of serialized evidence are retained per session; reaching the limit produces a warning.

Snapshots are stored locally in Pi custom entries (`gentle-pi.session-change/v1`), including bounded before/after source text. Exit/resume and reload restore captures only for the exact same session UUID. New sessions and forks do not inherit attribution from another UUID. Ephemeral `--no-session` runs do not persist after exit. Capturing remains active in headless children and when the visual shell is disabled.

The separate `session_worktree_register` tool still registers canonical same-clone roots for coordination, but registration alone never adds files to Changes. Existing `gentle-pi.session-worktree/v1` entries do not establish file-level attribution.

### Browse captured diffs

`/gentle:changes` or `alt+g` opens the two-pane viewer. Worktrees are accordion groups on the left; selecting a file displays its captured diff on the right.

- `j`/`k` or arrows navigate. On a group, Enter, Space or Right expands it; Left returns to its parent or collapses it. `ctrl+j/k` or Page Up/Down scroll the diff; Escape or `q` closes.
- Fullscreen left-click selects files; mouse wheels scroll the file list and diff independently. Hovering an unselected row (worktree or file, in either pane's list) paints it in the same shared hover role every clickable surface in the shell uses; it never opens or selects the file, and never overrides the already-selected row's own role.
- Opening, pressing `r`, and the overlay's refresh cadence consult only the captured session model. They never rescan Git or load the current file contents. Same-line-count edits invalidate the diff preview by content revision.
- On a file, `o` or Enter opens the actual current file in `$VISUAL` or `$EDITOR`, with its worktree as cwd. Edits made there are external and are not attributed to the agent.
- `GENTLE_PI_SHELL_CHANGES_KEY` rebinds the shortcut; `off` disables it. `GENTLE_PI_SHELL_CHANGES_POLL_MS` controls only the open overlay's in-memory refresh. `GENTLE_PI_SHELL_CHANGES_WATCH_MS` no longer enables filesystem polling.
- No captured changes means no widget and an informational notice; it does not assert that the working tree is clean.

### Command palette

`/gentle:commands` or `alt+k` opens a curated, grouped command menu, OpenCode-style — not a raw listing of every registered extension command. Entries are grouped under Configuration, Session, Diagnostics, and Skills, each shown by a human label with its shortcut hint where it has one; a command only appears when it is both in the curated set and actually registered. The Search row filters by label, by the underlying command name, and by description; arrows or `ctrl+j`/`ctrl+k` move, enter runs the highlighted entry exactly as if its command had been typed, escape closes. `GENTLE_PI_COMMANDS_KEY` rebinds the shortcut; `off` disables it. Built-in Pi commands are not listed. The default is `alt+k`, not `ctrl+k`, because Pi reserves `ctrl+k` for the editor's delete-to-line-end action.

To use `ctrl+p` like OpenCode, rebind Pi's `app.model.cycleForward` in `~/.pi/agent/keybindings.json` (Pi reserves that action, so an extension cannot take `ctrl+p` while it holds it) and set `GENTLE_PI_COMMANDS_KEY=ctrl+p`.

Subscription usage shows in the bar after the cost, and `/gentle:usage` opens a panel with one row per window of every provider: the limit name, its meter, its percentage and, when that window reports one, its reset, all on one line. Codex, Claude and NaN all read the same way. In fullscreen mode, clicking the header's `usage` segment opens this same panel. The panel's own footer hints (`r refresh`, `esc close`) are clickable too, not just keyboard shortcuts, and hovering either one paints it in the shell's shared hover role while a refresh already in flight ignores a repeated click.

```text
✿ gentle shell ⟡ … ⟡ $9.49 sub ⟡ codex 5h ▰▰▰▰▰▱▱▱ 62% · week 31%
```

The panel rows a provider reports its windows with:

```text
✿ nan · updated just now
  deepseek-v4-flash ▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱  26% · resets in 12d 17h
  glm5.3-flash      ▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱  11% · resets in 12d 17h
```

- For Codex, usage comes from the same account usage endpoint the Codex CLI reads, using the OAuth token pi already holds. It is fetched at session start, at most every 5 minutes after a turn, and on `r` in the panel. Rate-limit headers on SSE responses are picked up too.
- For Claude Pro/Max, usage arrives in the rate-limit headers of every response, so the 5h and weekly windows appear after the first turn.
- For NaN Cloud, usage comes from the quota endpoint the official dashboard reads, with the same API key pi already holds. Each metered model reports one allowance for the billing period, and that window carries no label: the model id names it in the bar and the reset text says what it is in the panel. A model that also reports a rolling window shows that one labeled next to it (`4h`), which today's payload does not send; percentages are tokens used over the allowance, exactly as the dashboard draws them, and the allowance is the full-period cap (`fullCap`) whenever the model reports a positive one, because `cap` alone is the prorated allowance of the period in progress. It is fetched under the same 5-minute rule as Codex, counted per provider so a switch fetches the provider it switched to, refuses redirects so the bearer cannot be replayed to another origin, and keeps no cached copy. The endpoint sits outside NaN's published OpenAPI, so the parser reads it defensively: a model that reports no allowance is skipped, as the dashboard skips it, while a metered model whose usage cannot be read fails the whole read, so a partial payload never replaces a complete snapshot with a cheaper-looking one. A session that already has a snapshot keeps the last valid one through a malformed payload or a failed fetch, and the pending note appears only while there is nothing to draw.
- Extensions can register a usage source for their own provider: gentle-shell has no built-in knowledge of it, but treats it exactly like Codex or NaN once registered. Emit `gentle-pi:usage-source/v1` on `pi.events` with `{ schema: "gentle-pi.usage-source/v1", provider, pendingNote?, fetch(apiKey, fetchFn, now) }`, where `fetch` resolves a `ProviderUsage` the same shape the built-in providers produce, or `undefined` when there is nothing to show yet. A malformed payload, a `fetch` that isn't a function, a provider id outside the safe id pattern, or a `fetch` call that throws or rejects is ignored rather than crashing the shell. Re-registering the same provider replaces its source, so emitting again at every `session_start` is safe and keeps load order irrelevant. Once registered, the provider shows `pendingNote` (or the same "no usage yet · r to fetch" default the built-ins use) until its first fetch, and a registration that arrives after the session already started, for the provider currently active, triggers one immediate refresh instead of waiting for the next turn or the 5-minute window. Example, using a neutral provider id:

  ```ts
  pi.events.emit("gentle-pi:usage-source/v1", {
    schema: "gentle-pi.usage-source/v1",
    provider: "acme-cloud",
    fetch: async (apiKey, fetchFn, now) => {
      if (!apiKey) return undefined;
      const response = await fetchFn("https://acme.example/usage", { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!response.ok) return undefined;
      return { provider: "acme-cloud", plan: "Acme · 42 credits", limits: [], fetchedAt: now };
    },
  });
  ```
- The bar names the subscription it shows (`codex`, `claude`, a NaN model) and always follows the active model. A provider with per-model allowances draws the session model's own meter, falling back to its family and then to the account total, never to whichever model the payload happens to list first — and that holds for a payload that reports a single metered model too, because one allowance is still per-model data rather than a reason to echo the first entry. The panel puts the active provider first, marked with the petal, and says why it has no data when it does not: API-key providers have no subscription windows, Claude reports after the first response, Codex and NaN wait for a fetch. A provider without per-model allowances keeps its single aggregate line in the sidebar, unchanged.
- A provider with per-model allowances is ordered by family on both surfaces: a family stays together, the family that consumes most comes first, and the models inside it follow the same rule, most used first. There are no `total` rows anywhere — an aggregate nobody can act on only costs space — so the account and family totals survive only as the bar's fallback name when the session model holds no allowance of its own (`nan total`). An allowance row leaves the window label empty and prints `name meter percent`, while a labeled sub-window (`4h`) keeps its column, and the reset a window reports rides that same line after a `·`; a window without one ends at its percentage, never on a dangling separator. The sidebar's Usage group prints those same rows in that same order, so the breakdown does not require opening the panel, and stops at the percentage: the reset dates stay in the panel. A row whose windows all round to `0%` is dropped from that group — an allowance nobody has touched yet tells the reader nothing the missing row does not — and the same rule retires the aggregate line of a provider without raw allowances once every window it shows sits at `0%`; the bar and the panel keep printing it, so a zeroed subscription is still verifiable there.
- Only the plan name and the windows are kept; account details in the payload are discarded.
- Gauges turn amber at 80% and red at 95%, like the context gauge.

Gentle notices are drawn as cards: the same rounded frame as the prompt. An informational card paints the rounded frame in the theme's plain border role and its title in the accent role — the rose look every sidebar card, the review preflight reminder, and a quiet Agents card share. A warning, error, or success card paints its frame and title in its own tone color instead.

```text
╭─ ✿ Gentle AI · review preflight ─────────────────────────────────────╮
│ Receipt-driven development is enabled, and this worktree holds an…   │
╰──────────────────────────────────────────────────────────────────────╯
```

- Every call into the gentle-ai binary and every `gentle_review` tool renders as a card under the rose, `🌹︎ Gentle AI`: the rail is amber while it runs, green when it finished, red when it failed; the expand key sits in the top rule once the tool finished, and the collapsed result shows only its line count. Reviewer captures name their lens (`review capture · risk`; the group lists all four).
- The review preflight reminder renders as a card in the transcript with the expand key in its top rule.
- An active dev-binary override shows above the editor at startup, in amber, naming the binary and its digest, and leaves with the first prompt; an invalid override shows in red with the reason.
- Subagents draw their own card; see Gentle Agents below.

### Native interactive tools

Gentle Shell ships its own interactive tools instead of depending on third-party extensions; the built-ins replace `npm:pi-subagents-j0k3r` and `npm:@juicesharp/rpiv-todo` (see Gentle Agents and Gentle Todo below for the removal steps).

- **`ask_user_question`** — one to four structured questions in a single questionnaire, each with two to four options, multi-select, per-option descriptions and previews — rendered as real TUI dialogs, usable in the live session.
- **`ask_user_choice`** — one exactly representable single-select question, with an opt-in free-text response.
- **`todo`** — plan tracking with the Gentle Todo card (see Gentle Todo below).
- **`gentle_review` / capture tools** — the native review surface for receipt-driven development.
- **Optional companions** (separately installed, never bundled): `gentle-engram` for persistent memory, `pi-web-access` for web access when a task needs it and your policy allows it, `pi-lens` for additional inspection surfaces, `pi-intercom` for cross-session communication where your Pi setup supports it, and `@juicesharp/rpiv-ask-user-question` for interactive choice support where a separately installed extension fits your setup. These are companions, not hidden prerequisites or a claim that every Pi installation has every capability; persistent memory is **not** bundled with `gentle-pi`.

### Gentle Agents

The current package requires Pi 0.85.1 or newer (development tests pin 0.87.1). Use the latest Pi release; gentle-pi does not update your installed Pi automatically. Children, including any `GENTLE_PI_AGENTS_PI` override, must emit `agent_settled`: `agent_end` records a run's output but is not completion because retries or queued continuations may follow.

The `subagent_*` tools and the agents card replace the third-party subagents package (remove `npm:pi-subagents-j0k3r` from your pi packages; while it is still installed the tools stay unregistered and a warning says so at startup). Agent definitions and settings are the ones you already have: markdown agents in `~/.pi/agent/agents/`, `~/.pi/agent/subagents/`, `<cwd>/.pi/agents/`, `<cwd>/.pi/subagents/` (project beats global, `subagents/` beats `agents/`), and `subagents.json` at the global and project level (`default_model`, `default_effort`, `default_mode`, `model_profiles`, `stall_timeout_ms`, `tool_stall_timeout_ms`, `max_concurrency`, `history_max_tasks`).

Agent paths follow `GENTLE_PI_AGENT_HOME`, then `PI_CODING_AGENT_DIR`, then `~/.pi/agent` for definitions, config, history, child sessions, and transcripts. These overrides select the agent profile; they do not sandbox project or shared global resources.

```text
╭─ ❀ Agents · 1 active · 1 done ─────────────────────────────── 1m24s ╮
│ ✓  gentle-ai-explore  map footer sources   gpt-5.6-terra ·  34k ·  $0.27 · 25s │
│ ◐  gentle-ai-worker   write shell footer   gpt-5.6-terra · 120k · $12.50 · 41s │
╰──────────────────────────────────────────────────────────────────────────────────╯
```

The card is above the editor in every mode, including fullscreen — it is not one of the sidebar's cards. Each metadata field (`model · effort`, tokens, cost, elapsed) gets its own fixed, right-aligned column sized to the widest value among the shown tasks, so the numbers line up vertically even when one row's values are much shorter than another's; a queued task fills only the elapsed column with the word `queued`, leaving the rest of the row blank rather than overwriting it. When the card is too narrow for every column, it degrades one column at a time and the same way for every row: the task text goes first, then the `model · effort` label, then tokens, then cost; elapsed is the last column standing, since it is the one value the reader cannot rebuild from anything else on screen.

Every subagent is its own `pi --mode rpc` child process, so the terminal never runs subagent work: the host reads JSON lines, applies each one as a small delta to a bounded per-task thread, and notifies only the listeners of that task. A task-mode child's question (`ctx.ui.select`, `confirm`, `input`, `editor`) reaches you as an ordinary pi dialog; a background child's question is dismissed. Subagents have no automatic total execution timeout: a long-running child remains live while it continues emitting RPC events. A silent child still times out through the configurable `stall_timeout_ms` watchdog (default four minutes). An announced tool call that is still running is live work, not silence, so it is bounded by `tool_stall_timeout_ms` instead (default 30 minutes, never below `stall_timeout_ms`). Closing pi stops the children that are still running.

- `subagent_list_agents`, `subagent_run` (`agent`, `task`, `label?`, `context?`, `workspace_root?` or `repository_root?`, `mode?` task or background), `subagent_status`, `subagent_result`, `subagent_list_tasks`, `subagent_reply` (one current-session reply to a live child query), `subagent_cancel`, `subagent_send_message` (steer a running child), `subagent_continue` (resume a finished task in its own session).
- `orchestrator_session_id`, `orchestrator_list`, and `orchestrator_send_message` provide local-profile session notifications. List results advertise IDs only and reachability remains unknown. Sending selects the sole advertised peer or asks the user to choose; outbound messages require explicit interactive human consent before dispatch (Allow once, Allow for this session, or Deny), and fail closed if interactive UI or its selector is unavailable, even after a session grant. Each send requires a caller-supplied reason with at least 8 characters after trimming and at most 512 UTF-8 bytes. The consent preview visibly escapes controls and Unicode line separators; the delivered message remains unchanged. A successful ACK means the peer accepted the notification for delivery, not that it read or completed work. This is notification-and-ACK transport only: it has no cross-session queries, offline queue, retries, broadcasts, or read/completion guarantees. On Unix, presence records remain in the profile's private transport directory while socket endpoints use a private, profile-hashed directory below the canonical system temporary directory, keeping endpoint length independent of the profile path and at most 100 encoded bytes. The shared system temporary parent is only validated (current-user-owned without group/other write, or root/current-user-owned, world-writable, and sticky); it is never claimed, permissioned, or cleaned up by gentle-pi. On POSIX, the transport uses private Unix-domain sockets; on Windows, it uses private named pipes scoped by the current account SID, served by a package-local PowerShell helper (`runtime/windows-session-transport.ps1`): the transport selects that fixed helper, and availability and delivery depend on the helper's bounded startup and pipe checks. Notification and ACK limits remain bounded across platforms.
- `subagent_run.workspace_root` selects the parent's main worktree or an existing linked worktree in the parent's Git clone only. Validation happens before queueing; the child runs at that canonical root. Successful OS spawn registers it in the originating parent's same-clone registry, including delayed queued launches; failed spawns do not register.
- Alternatively, `subagent_run.repository_root` selects an explicit canonical root of an independent Git repository; the two root selectors cannot be combined. A direct interactive parent must grant that clone before queue or child session-directory writes. The grant belongs to the live parent session and canonical Git common directory: subsequent launches there can reuse it, but denial, cancellation, lost UI, reload, or changed session/repository identity fails closed. Print, RPC, and child callers cannot request a foreign target; foreign remediation launches are unsupported. Task and background launches still obey their ordinary mode restrictions. Queued tasks revalidate immediately before spawn; `subagent_continue` retains the target cwd and revalidates the grant rather than prompting to restore a lost one. Status and task details expose the cwd. Foreign children never enter the same-clone registry or its footer/widget counts. A delegation grant is not permission to review, commit, push, or deliver in the target repository.
- Background work requires a live interactive/RPC parent. Both `subagent_run` and `subagent_continue` reject background mode in `pi -p` before creating or spawning a task: the parent exits before it can receive a later result. Use task mode for bounded print-mode work.
- A background task's result comes back to the model as a `gentle-agents.result` message, drawn as a rose card, and starts a new turn when the agent is idle; the model never polls.
- A configured child can call `subagent_parent_message` with bounded, well-formed Unicode text. Notifications retain their existing admission semantics. A `kind: "query"` waits for one strictly correlated `subagent_reply` for at most 30 seconds; each child has at most four pending queries, and disconnect, timeout, stop, and send failure settle each request once. The current parent session alone can reply. The first admitted task-mode query ends the original tool response while its child keeps running; its eventual non-cancelled completion returns once as a follow-up only if that same session is still active. Channel closure prevents later sends and automatic retry is not provided. Peer transport, offline delivery, retries, and broadcasts are unsupported.
- The card shows the active session's tasks only: after `/new` or `/resume` the earlier session's tasks leave it and come back with their session. Finished rows stay for one minute (three at most), and the card spends at most a quarter of the terminal (three to eight rows) on tasks; beyond that the rest fold into one `… N more · alt+a to view` line so the editor never leaves the screen. Questions and running work keep their rows first.
- `/gentle:agents` or `alt+a` opens a full-terminal overlay. At 60+ columns, the split view shows groups/tasks beside the retained semantic thread; uppercase `F` or **Fullscreen** expands that thread. At 12–59 columns, click a current subagent directly to inspect its thread; in All sessions, first select its orchestrator. `Enter`/`Tab` also enter a narrow selection. **Back** or `Escape` returns one level, closing only at the root; **Close** or `q` closes globally without cancelling children. Selection and manual thread scrolling survive Back and resize.
- Mouse controls take priority over keyboard hints: **Follow** (`f`), **Open session** (`o`), **Stop** (`s`, legacy `c`, owned active tasks only), and **Scope** (`a`). A compact footer's `>` cycles through actions. Scope switches between this session's direct active children and all open orchestrators, including idle ones. Open writes a markdown transcript for `$EDITOR`, not a resumed child session. `j`/`k` move through lists or scroll an expanded thread; `ctrl+j`/`ctrl+k` and Page Down/Up page the thread. In Pi fullscreen mode, the wheel scrolls the viewport under the pointer; regular terminal mode does not capture mouse input. Below 12 columns or three rows, only a bounded Close cell remains; zero-sized terminals render nothing.
- The thread displays all retained Text, Thinking, Note, and Tool content without an additional presentation cap; existing store limits and truncation markers still apply. Only the selected task is subscribed while the overlay is open.
- Thread entries are presented as labeled Text, Thinking, Note, or Tool blocks; tool blocks show their status and nonempty output.
- Current scope has no orchestrator wrapper. Its own session's finished subagents stay listed as history after the active ones — newest ended first — with their terminal glyph, elapsed frozen at completion, and their thread inspectable; a finished row is never cancellable. The header reads `N active · M finished`. History is capped at 200 finished tasks per session (oldest dropped); resuming a session (`session_start` with reason `resume`) restores that session's own finished tasks from disk automatically, a brand-new session starts empty, and All sessions discovers open Pi instances sharing the same agent profile, even across repositories — it does not infer open sessions from retained tasks and stays presence-only (no cross-session history browsing). Directory headings support left/right and mouse expansion, and cannot stop or open a task. Peer children and their retained threads are read-only: no local stop, editor-open, or continuation routing, and no import into the local task store.
- Presence refresh is paged while the overlay is open. Graceful shutdown withdraws an instance; after abrupt closure its last heartbeat may remain visible for up to 15 seconds plus the time to complete the next directory refresh. A recent heartbeat is a heuristic, not proof that a process is alive. Same-profile, same-user processes share retained activity text; this is not an authorization channel.
- `alt+s` confirms stopping the current active or queued subagents owned by the current process. `GENTLE_PI_AGENTS_STOP_KEY` rebinds it; `off` disables it.
- Finished tasks are written to `~/.pi/agent/gentle-agents/tasks/` (one JSON per task, newest `history_max_tasks` kept, default 200) and come back on demand for `subagent_result` and `subagent_continue`; an id looked up this way from an unrelated session never enters the overlay or becomes cancellable. Child sessions live under `~/.pi/agent/gentle-agents/sessions/`.
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

