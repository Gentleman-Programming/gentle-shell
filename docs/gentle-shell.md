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

The source checkout prepares `gentle-pi` `4.0.0` with a package-local Gentle AI `v4.0.0` pin; this does not imply that the package release has been published.

## Shell interactions and runtime behavior

Gentle Shell is the Pi workspace experience provided by the `gentle-pi` package. It follows the Gentle themes: one border language, rose for whatever is alive.

### Fullscreen layout

At 140 columns or wider, fullscreen defaults to a live header over a transcript-and-rail split, both driven by [`lib/shell-sidebar-layout.ts`](../lib/shell-sidebar-layout.ts):

```text
✿ Gentle Shell ⟡ ~/work/gentle-pi main ⟡ gpt-5.5 · medium · team              ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub
```

- The header carries live session data: session identity on the left (brand, cwd, branch, dirty count, model · effort · profile) and the two live counters right-aligned (the context gauge and session cost). It never shows the working/thinking state or extension statuses — those stay in the prompt indicator and the Status surface. When the terminal is too narrow for everything, segments give way in a fixed order — profile, then effort, then the whole cwd/branch/dirty group — before the counters are touched; below that, only the brand survives, and below that the header renders nothing.
- The right rail scrolls **Status → Changes → TODO**. Cards cache their rendered content until their own digest or an explicit invalidation changes. `neon` keeps the rounded border and accent title; `float` uses a tone background, a full-height `▎` accent, one-column transparent margins, painted padding above and below, and a blank painted separator between heading and body. Warning/error/success panels retain their tone colors.
- The Status card carries Project (cwd, branch, session name, active profile), Changes, and Integrations (other extensions' statuses); its live digest detects changes without requiring an event. Model, effort, context, cost, and the per-model usage table live in the header instead — the header ticks every frame, so duplicating them in a card would just make that card repaint every frame too.
- Gentle Agents is not part of the rail in any mode: its one card stays above the editor, where it already lived, with fixed right-aligned columns for `model · effort`, tokens, cost, and elapsed, each sized to the widest value among the shown tasks — so the numbers line up vertically even when one row's values are much shorter than another's. A queued task fills only the elapsed column with the word `queued`, leaving the other columns blank rather than overwriting the row.
- The sidebar reuses its last frame until something it paints changes, so silent frames stay cheap; a per-section cache means one card's changing digest (or the header's) never forces an unrelated card to redraw.
- Header placement is configurable. Above input, the float header has a full-width background, painted padding above and below its content, and a transparent `▔` bottom edge. Below input, the float footer groups captured Changes (when present), header data, and locally owned integration statuses under one upper edge; it never duplicates statuses owned by the rail.
- Below 140 columns, fullscreen has no sidebar. A configured top header owns the narrow status surface; otherwise the bottom bar owns it, unless Status is hidden. Regular mode keeps the compact one-line bottom bar and the above-editor Agents widget, without a fullscreen header or sidebar.

The regular-mode compact bar replaces pi's three-line footer with a single line of segments:

```text
✿ gentle shell ⟡ ~/work/gentle-pi main ⟡ gpt-5.5 · medium ⟡ ctx ▰▰▰▰▱▱▱▱ 45% ⟡ $9.49 sub ⟡ MCP: 3 servers enabled        Release notes
```

- Context is a gauge, not a number. It turns amber at 80% and red at 95%; after compaction it shows `?%` until the next response.
- Cost carries `sub` when the active model runs on a subscription login.
- Statuses other extensions publish through `setStatus` are appended as trailing segments; the session name sits at the right edge.
- On narrow terminals the session name is dropped first, then trailing segments, before the line is truncated.

The prompt follows the selected card style. `neon` keeps pi's editor in its rounded frame:

```text
╭─ ✿ working ──────────────────────────────────────────╮
│ type, or / for commands                              │
╰──────────────────────────────────────────────────────╯
```

- `float` paints the prompt with the card's quieter `toolSuccessBg`, one-column transparent margins and a full-height `▎` accent in the editor's current frame/mode color. The painted top row contains the petal and working state; editable rows have an interior inset and painted bottom padding replaces the bottom rule. Cursor, selection, autocomplete and mouse geometry remain native.
- The petal is still with a `waiting for input` label in float while pi waits, spins with a `working` label while the agent works, and turns amber with a `queued` label when messages are waiting behind the current turn. In float it lives inside the painted top row; in neon it lives in the top rule. Pi's own "Working" row above the editor is hidden.
- The empty-editor typing hint appears only while the editor is empty; Esc/queued hints remain inside the painted top row even with a nonempty float draft. Widths below 10 columns or a missing/unusable background keep the complete neon prompt path.
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

Subscription usage shows in the bar after the cost, and `/gentle:usage` opens a panel with one row per window of every provider: the limit name, its meter, its percentage and, when that window reports one, its reset, all on one line. Codex, Claude and NaN all read the same way. In fullscreen mode, clicking the header's `usage` segment opens this same panel. The panel's own footer hints (`r refresh`, `esc close`) are clickable too, not just keyboard shortcuts, and hovering either one paints it in the shell's shared hover role while a refresh already in flight ignores a repeated click. The panel opens immediately: it draws whatever snapshots the store already holds and says `refreshing…` while the open refresh runs underneath it, repainting as answers land.

```text
✿ gentle shell ⟡ … ⟡ $9.49 sub ⟡ codex 5h ▰▰▰▰▰▱▱▱ 62% · week 31%
```

The panel rows a provider reports its windows with:

```text
✿ nan · updated just now
  deepseek-v4-flash ▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱  26% · resets in 12d 17h
  glm5.3-flash      ▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱  11% · resets in 12d 17h
```

- For Codex, usage comes from the same account usage endpoint the Codex CLI reads, using the OAuth token pi already holds. It is fetched at session start, at most every 5 minutes after a turn, and on `r` in the panel. Rate-limit headers on SSE responses are picked up too. Codex windows require a finite positive duration reported by the provider; missing or invalid durations are ignored, never shown as `0m` or replaced with an assumed `5h` quota. A real `0%` remains visible when its window is valid, and a response with no valid header windows leaves the previous snapshot untouched. The same refresh covers every provider the session targets: the active model's own provider plus every provider the active profile's subagent routing names — a repository pin decides which profile that is, falling back to the global active profile when no pin applies. Each provider keeps its own 5-minute window, its own stale-source guard, and its own last good snapshot. Providers refresh concurrently, each inside its own bounded window (default 10s, `GENTLE_PI_SHELL_USAGE_TIMEOUT_MS`): the abort signal reaches the underlying fetch — composed with the caller's own signal when it carries one, never replacing it — a provider that outlives its window wears the generic failure note, and whatever it answers afterwards is discarded — a late answer never replaces what the timeout settled, exactly like the stale-source guard above.
- A routing entry names its provider with a qualified ref (`provider/model`); a bare model id is resolved through the model registry only when exactly one provider carries that id, and is left untargeted rather than guessed when none or several do. The targeted scope is resolved when a refresh runs — at session start, on each turn's throttled refresh, on `r` or reopening the panel, and when a usage source registers — so a profile switch is picked up by the next refresh rather than live per render.
- For Claude Pro/Max, usage arrives in the rate-limit headers of every response, so the 5h and weekly windows appear after the first turn.
- For NaN Cloud, usage comes from the quota endpoint the official dashboard reads, with the same API key pi already holds. Each metered model reports one allowance for the billing period, and that window carries no label: the model id names it in the bar and the reset text says what it is in the panel. A model that also reports a rolling window shows that one labeled next to it (`4h`), which today's payload does not send; percentages are tokens used over the allowance, exactly as the dashboard draws them, and the allowance is the full-period cap (`fullCap`) whenever the model reports a positive one, because `cap` alone is the prorated allowance of the period in progress. It is fetched under the same 5-minute rule as Codex, counted per provider so a switch fetches the provider it switched to, refuses redirects so the bearer cannot be replayed to another origin, and keeps no cached copy. The endpoint sits outside NaN's published OpenAPI, so the parser reads it defensively: a model that reports no allowance is skipped, as the dashboard skips it, while a metered model whose usage cannot be read fails the whole read, so a partial payload never replaces a complete snapshot with a cheaper-looking one. A session that already has a snapshot keeps the last valid one through a malformed payload or a failed fetch, and the pending note appears only while there is nothing to draw.
- Extensions can register a usage source for their own provider: gentle-shell has no built-in knowledge of it, but treats it exactly like Codex or NaN once registered. Emit `gentle-pi:usage-source/v1` on `pi.events` with `{ schema: "gentle-pi.usage-source/v1", provider, pendingNote?, fetch(apiKey, fetchFn, now) }`, where `fetch` resolves a `ProviderUsage` the same shape the built-in providers produce, or `undefined` when there is nothing to show yet. A malformed payload, a `fetch` that isn't a function, a provider id outside the safe id pattern, or a `fetch` call that throws or rejects is ignored rather than crashing the shell. The `fetchFn` a source receives is bounded the same way: once the provider's window expires it aborts, and a later resolution is discarded. Re-registering the same provider replaces its source, so emitting again at every `session_start` is safe and keeps load order irrelevant. Once registered, the provider shows `pendingNote` (or the same "no usage yet · r to fetch" default the built-ins use) until its first fetch, and a registration that arrives after the session already started, for any targeted provider (the session's own or a subagent route of the active profile), triggers one immediate refresh of that provider instead of waiting for the next turn or the 5-minute window. Example, using a neutral provider id:

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
- The bar names the subscription it shows (`codex`, `claude`, a NaN model) and always follows the active model. A provider with per-model allowances draws the session model's own meter, falling back to its family and then to the account total, never to whichever model the payload happens to list first — and that holds for a payload that reports a single metered model too, because one allowance is still per-model data rather than a reason to echo the first entry. The panel puts the active provider first, marked with the petal, and says why it has no data when it does not: API-key providers have no subscription windows, Claude reports after the first response, Codex and NaN wait for a fetch. It draws exactly the targeted providers, in scope order — a targeted provider with no snapshot explains itself, and one whose latest refresh settled without a snapshot wears a generic nonsecret "fetch failed · r to retry" note: beside its retained snapshot when it has one, or in place of the pending note when it has none. The note tracks actual failures only — a refresh still in flight never reads as failed, Claude (headers-only) is never dressed up as one, and the next successful refresh clears it. A provider recorded under a previous profile's routing is not current scope after a profile switch. A provider without per-model allowances keeps its single aggregate line in the sidebar, unchanged.
- A provider with per-model allowances is ordered by family on both surfaces: a family stays together, the family that consumes most comes first, and the models inside it follow the same rule, most used first. There are no `total` rows anywhere — an aggregate nobody can act on only costs space — so the account and family totals survive only as the bar's fallback name when the session model holds no allowance of its own (`nan total`). An allowance row leaves the window label empty and prints `name meter percent`, while a labeled sub-window (`4h`) keeps its column, and the reset a window reports rides that same line after a `·`; a window without one ends at its percentage, never on a dangling separator. The sidebar's Usage group prints those same rows in that same order, so the breakdown does not require opening the panel, and stops at the percentage: the reset dates stay in the panel. A row whose windows all round to `0%` is dropped from that group — an allowance nobody has touched yet tells the reader nothing the missing row does not — and the same rule retires the aggregate line of a provider without raw allowances once every window it shows sits at `0%`; the bar and the panel keep printing it, so a zeroed subscription is still verifiable there.
- Only the plan name and the windows are kept; account details in the payload are discarded.
- Gauges turn amber at 80% and red at 95%, like the context gauge.

Gentle notices follow the selected card style. In `neon`, informational cards use the rounded frame in the theme's border role and an accent title; warning, error, and success cards use their own tone colors. In `float`, notices use the tone-background panel described below. The following example shows `neon`:

```text
╭─ ✿ Gentle AI · review preflight ─────────────────────────────────────╮
│ Receipt-driven development is enabled, and this worktree holds an    │
│ unreviewed candidate (target sha256:…). First determine whether the  │
│ user explicitly left this exact target unreviewed. If yes, do not    │
╰──────────────────────────────────────────────────────────────────────╯
```

- Quiet tools use the selected card style with their actual name in the heading (`read`, `bash`, `grep`, `find`, `ls`, `edit`, `write`); bash keeps its command visible. Collapsed results show up to three physical preview rows, including search/list entries or changed diff lines alongside useful totals. Expand with the configured key shown in the top rule for complete available output and image handling. Expanded successful `write` cards show the complete written content; collapsed cards keep their concise confirmation. Failed writes show the error instead.
- Every call into the gentle-ai binary and every `gentle_review` tool draws a rose card titled like the quiet `read` card: the colored 🌹 emoji, a short name, then the operation (`🌹 rdd inspect`, `🌹 gentle-ai version`), with `running`/`preparing`/`failed` shown until the call completes (`🌹 rdd running · start`). The rail uses the existing theme roles: warning while running/partial, success on completion, error on failure. Collapsed results show up to three useful physical rows, not just a line count. A JSON envelope instead collapses to one summary line of its key fields (status, outcome, risk, action, reason code, diagnostic message, e.g. `blocked · start · fresh_target_ready`) and expands as pretty-printed JSON. The expand key sits in the top rule once finished, and elapsed timing stays on the closing rule. Reviewer captures name their lens (`rdd capture · risk`; the group lists all four).
- The review preflight reminder renders as a card in the transcript with the expand key in its top rule. Collapsed, it previews up to three non-blank physical rows of the reminder; expanded, it shows the full text.
- An active dev-binary override shows above the editor at startup as a 🌹 gentle-ai card, in amber, naming the binary and its digest, and leaves with the first prompt; an invalid override shows in red with the reason.
- Subagents draw their own card; see Gentle Agents below.

### Card style

Pick the conversation-card and shell-chrome style in `/gentle:customize` → **Cards**. A successful save immediately redraws conversation cards, Agents, TODO, Status, header/footer and prompt — no other state change or reload is needed. The choice is saved in `card-style.json` in the Gentle Pi config home; it is not part of visual profiles or visual reset. If saving fails, the live style stays unchanged.

| Style | Look |
|-------|------|
| `neon` | The outlined rounded card shown above. |
| `float` (default) | A borderless panel on the tone's tool background (success/info, pending, error), with a tone-colored `▎` accent bar, a one-column margin on each side, a blank row above the heading and at the bottom, and a blank row between the heading and the body. |

```text
 ▎
 ▎ ⌖ find *.md in .                                  ctrl+o to expand
 ▎
 ▎ README.md
 ▎
```

- `float` applies to tool, Code and 🌹 cards, Agent result and stale cards, the review preflight reminder, the dev-binary notice, and the Agents, Todos and Status panels. The prompt and fullscreen header/footer use their specialized float chrome described above. The regular-mode one-line Status bar is unchanged.
- A theme without a tool background, or a card narrower than 10 columns, falls back to `neon`. A malformed `card-style.json` reads as `float` and the panel refuses to overwrite it.

### Compact Code card

With quiet tools enabled, `codemode` uses the same rounded **Code** card. The collapsed view shows up to eight observed child calls in their original order, including repeats, with Pi's actual status and available nonnegative duration. Additional calls and failures are counted. Error payloads have a separate two-row preview even when their child falls outside the first eight; final output has a three-row physical budget, and a full-output locator remains visible when available.

- JavaScript and child arguments stay out of the collapsed preview. Expand with the configured key shown in the top rule for the actual script, all observed children, complete available error/output text, image fallback and full-output locator.
- Host failure/partial flags and observed child failures retain their existing semantic colors; no generic `finished` heading, inferred children, progress percentage, or aggregate duration is added. Pi's final status/wall-time header stays in expanded output rather than displacing useful collapsed content. Child success does not promise rollback or overall success.
- Missing metadata is reported honestly. Terminal controls are stripped from displayed text; this is terminal-spoofing protection, **not secret redaction**. Both collapsed previews and expanded content can contain sensitive data.
- Only presentation changes: upstream execution, schema, loadout, exposure and inactive-by-default behavior stay intact. `GENTLE_PI_QUIET_TOOLS=0` leaves the upstream presentation alone and does not change tool activation.

### Native interactive tools

Gentle Shell ships its own interactive tools instead of depending on third-party extensions; the built-ins replace `npm:pi-subagents-j0k3r` and `npm:@juicesharp/rpiv-todo` (see Gentle Agents and Gentle Todo below for the removal steps).

- **`ask_user_question`** — one to four structured questions in a single questionnaire, each with two to four options, multi-select, per-option descriptions and previews — rendered as real TUI dialogs, usable in the live session.
- **`ask_user_choice`** — one exactly representable single-select question, with an opt-in free-text response.
- **`todo`** — plan tracking with the Gentle Todo card (see Gentle Todo below).
- **`bash_background`**, **`monitor`**, **`job_stop`**, **`job_list`** — background shell jobs that notify the agent when they exit, or on every output line (see Background jobs below).
- **`gentle_review` / capture tools** — the native review surface for receipt-driven development.
- **Optional companions** (separately installed, never bundled): `gentle-engram` for persistent memory, `pi-web-access` for web access when a task needs it and your policy allows it, `pi-lens` for additional inspection surfaces, `pi-intercom` for cross-session communication where your Pi setup supports it, and `@juicesharp/rpiv-ask-user-question` for interactive choice support where a separately installed extension fits your setup. These are companions, not hidden prerequisites or a claim that every Pi installation has every capability; persistent memory is **not** bundled with `gentle-pi`.

### Gentle Agents

The current package requires Pi 0.99.1 or newer and Node >=22.19.0. Development tests resolve Pi through the open `>=1.0.0` development range. The private Vim editor adapter admits only the audited Pi `0.99.1`, `0.99.2`, and `1.0.0` releases; any other release keeps ordinary prompt editing until its editor is audited. Use the latest Pi release; gentle-pi does not update your installed Pi automatically. Children, including any `GENTLE_PI_AGENTS_PI` override, must emit `agent_settled`: `agent_end` records a run's output but is not completion because retries or queued continuations may follow.

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

Delegated children (`GENTLE_PI_AGENTS_CHILD=1`) load the same context files as their parent, minus the gentle-ai managed blocks that bind themselves to the orchestrator, such as `orchestrator` and `agent-routing` (the full list lives in [`lib/child-context-files.ts`](../lib/child-context-files.ts)). Every other managed block (for example `codegraph-guidance`, `engram-protocol`, or `remote-authorization` nested inside `agent-routing`) and all unmanaged project text reach the child unchanged. A marker counts only when it is alone on its line outside fenced code; if a file's markers are unbalanced, mismatched, or ambiguous, that file is passed through unfiltered. The filtering lives in the packaged `extensions/child-context.ts`, which every child loads (see below); if that file is missing, the child starts without it and keeps today's unfiltered context. The extension registers only a `before_agent_start` hook and does nothing outside a child session, so primary sessions always receive their context files as-is.

In the isolated Gentle Shell home, `settings.json` does not declare gentle-pi; the launcher injects it with `-e`. So that children load the same package as the parent, the launcher also exports `GENTLE_SHELL_CHILD_PACKAGE_INJECTION` with that exact `-e` set, and Gentle Agents forwards the same set to every child as `--extension` arguments, plus `--no-extensions` when the launch replaced the configured extensions (a takeover). A child then has the same package commands, tools, guardrails, skills, and prompts as a regular gentle-pi child, where `settings.json` declares the package:

- Children skip parent-only startup work: package asset install, model configuration, the skill registry, and history capture.
- A guardrails command classed `confirm` becomes a child question like any other above: a task-mode child asks the parent user and waits for the answer; a background child's question is dismissed.
- A tool the agent requests in `--tools` that does not exist in the child when its first prompt starts adds a task note, for example `gentle-agents: requested tools missing in child: codegraph`. MCP tools (`mcp__*`) are not checked because they register later.
- Without the signal, for example after a manual `pi -e <package>` launch, children fall back to `extensions/child-context.ts`, `extensions/child-safety.ts`, and `extensions/nan-provider.ts` only, with no missing-tool note. That fallback list is frozen; new child behavior ships in the package.
- A takeover forwards every package the parent loaded, so a settings package with no extensions (for example a skills-only package with only a `package.json`), which already makes the takeover parent fail with `Failed to load extension`, makes the child fail the same way; this limitation predates forwarding.

- `subagent_list_agents`, `subagent_run` (`agent`, `task`, `label?`, `context?`, `workspace_root?` or `repository_root?`, `mode?` task or background), `subagent_status`, `subagent_result`, `subagent_list_tasks`, `subagent_reply` (one current-session reply to a live child query), `subagent_cancel`, `subagent_send_message` (steer a running child), `subagent_continue` (resume a finished task in its own session).
- `orchestrator_session_id`, `orchestrator_list`, and `orchestrator_send_message` provide local-profile session notifications. List results advertise IDs only and reachability remains unknown. Sending selects the sole advertised peer or asks the user to choose; outbound messages require explicit interactive human consent before dispatch (Allow once, Allow for this session, or Deny), and fail closed if interactive UI or its selector is unavailable, even after a session grant. Each send requires a caller-supplied reason with at least 8 characters after trimming and at most 512 UTF-8 bytes. The consent preview visibly escapes controls and Unicode line separators; the delivered message remains unchanged. A successful ACK means the peer accepted the notification for delivery, not that it read or completed work. This is notification-and-ACK transport only: it has no cross-session queries, offline queue, retries, broadcasts, or read/completion guarantees. On Unix, presence records remain in the profile's private transport directory while socket endpoints use a private, profile-hashed directory below the canonical system temporary directory, keeping endpoint length independent of the profile path and at most 100 encoded bytes. The shared system temporary parent is only validated (current-user-owned without group/other write, or root/current-user-owned, world-writable, and sticky); it is never claimed, permissioned, or cleaned up by gentle-pi. On POSIX, the transport uses private Unix-domain sockets; on Windows, it uses private named pipes scoped by the current account SID, served by a package-local PowerShell helper (`runtime/windows-session-transport.ps1`): the transport selects that fixed helper, and availability and delivery depend on the helper's bounded startup and pipe checks. Notification and ACK limits remain bounded across platforms.
- `subagent_run.workspace_root` selects the parent's main worktree or an existing linked worktree in the parent's Git clone only. Validation happens before queueing; the child runs at that canonical root. Successful OS spawn registers it in the originating parent's same-clone registry, including delayed queued launches; failed spawns do not register.
- Alternatively, `subagent_run.repository_root` selects an explicit canonical root of an independent Git repository; the two root selectors cannot be combined. A direct interactive parent must grant that clone before queue or child session-directory writes. The grant belongs to the live parent session and canonical Git common directory: subsequent launches there can reuse it, but denial, cancellation, lost UI, reload, or changed session/repository identity fails closed. Print, RPC, and child callers cannot request a foreign target; foreign remediation launches are unsupported. Task and background launches still obey their ordinary mode restrictions. Queued tasks revalidate immediately before spawn; `subagent_continue` retains the target cwd and revalidates the grant rather than prompting to restore a lost one. Status and task details expose the cwd. Foreign children never enter the same-clone registry or its footer/widget counts. A delegation grant is not permission to review, commit, push, or deliver in the target repository.
- Background work requires a live interactive/RPC parent. Both `subagent_run` and `subagent_continue` reject background mode in `pi -p` before creating or spawning a task: the parent exits before it can receive a later result. Use task mode for bounded print-mode work.
- A background task's result comes back to the model as a `gentle-agents.result` message and starts a new turn when the agent is idle; the model never polls. Its **Agent result** card uses the success color when the task completed and the error color otherwise. Collapsed, it previews up to three non-blank rows of the answer or error, leaving out the `Subagent … (task …) <outcome>.` bookkeeping line the model reads; older results without that line preview their full text. Expanded, it shows the complete message, header included. A result held past the stale window does not replay its report: the model gets a compact `gentle-agents.stale-notice` naming the task and telling it to call `subagent_result` (an idle parent is woken for it), and the human gets a **Stale agent result** card in the warning color that previews up to three rows of its warning and never shows an answer it does not have. A completion whose forwarding fails stays queued for the next turn boundary instead of being lost. An idle parent has no boundary coming, so a failed delivery or a wake the host rejects there is retried after the wake grace, at most three times in a row.
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

### Background jobs

Waiting on CI, a build, or a server should cost neither a `sleep` loop nor a subagent, and neither should reacting to a log or a CI run while it progresses. `bash_background` runs a shell command in the background and returns a job id at once; the agent ends its turn or keeps working, and when the command exits the agent gets one message with the exit code, the last output lines, and the output file path. The wait condition lives inside the command, so its exit is the event:

```bash
gh run watch 12345 --exit-status                           # CI finished
until curl -sf localhost:3000/health; do sleep 1; done     # server is up
```

- Jobs run through Pi's own Bash execution: your configured `shellPath` and `shellCommandPrefix`, a process group per job, and process-tree kill. `bash_background` is a separate tool; native `bash` is unchanged.
- The exit notice uses the same delivery as background subagent results: it is steered into a running turn at the next turn boundary, or stored and wakes an idle session. A job the agent stops with `job_stop` sends no notice; one you stop from `/gentle:jobs` is reported to the agent as stopped by the user.
- stdout and stderr go to a temp file (`gentle-jobs-*/job-N.log`), never into the context; the agent reads it with `read` when it needs more than the tail. The tail keeps the last 20 lines, each capped at its newest 2,000 characters, and the log directory is removed when the session shuts down.
- `bash_background` passes through the same command confirmation, YOLO waiver, and child safety guards as `bash`.
- Jobs live in memory, belong to the session that started them, and are stopped when the session shuts down. At most 25 run at once.
- `monitor` is a background job whose every output line is an event, delivered while the command keeps running — for example `tail -f app.log | grep --line-buffered ERROR`, or a loop that prints each CI check as it finishes. Lines within 200 ms share one notice of at most 20 lines (the rest are counted, and stay in the log); notices waiting for a busy agent coalesce. `timeout_seconds` is mandatory (1–1800): the monitor is stopped when it expires and reports its event count. One that prints more than 120 lines within 60 seconds is stopped as a flood, so filter its output. When the command exits, a final notice reports the exit code and event count. It goes through the same command guards as `bash`.
- `/gentle:jobs` opens a full-terminal overlay with this session's jobs beside the selected job's command, status, output file, and live output tail; `↑`/`↓` or `j`/`k` move, `s` stops the selected running job, `q` closes (narrow terminals: `Tab` toggles details, `Escape` goes back). The footer shows `⧗ N jobs` while any run.

### Gentle Todo

The `todo` tool and its card replace the third-party todo extension (remove `npm:@juicesharp/rpiv-todo` from your pi packages; sessions written by it replay into the new card).

```text
╭─ ❀ Todos · 1 of 3 ──────────────────────────────────────╮
│ ✓ Add quiet tool rendering                              │
│ ◐ Fix quiet tools conflict · fixing conflict            │
│ ○ Show git bash tails                                   │
╰─────────────────────────────────────────────────────────╯
```

The runtime helps keep the list current beyond a static tool description:

- `write` replaces the whole list in one call, so the model rewrites the plan instead of patching it; `add`, `update`, `clear`, and `list` remain for single moves.
- Each agent run's system prompt carries the open tasks and the rules: in_progress before starting, done right after finishing, update before ending the run.
- A list that goes two agent runs untouched while pending or in-progress tasks remain turns amber with `stale · N turns`, and the prompt reports that age.
- Within a long run, after four tool-use model turns without a successful todo write, the next model request receives one hidden, request-local reminder to review the plan. A successful `write`, `add`, `update`, or `clear` resets and rearms it; `list` and rejected writes do not. The turn containing the write does not count toward the threshold. Empty, finished and blocked-only plans receive no reminder. Reminder tracking restarts when the session loads; it does not change the existing card freshness, persist a message, start an extra model turn, change task statuses, or connect to subagents.

Tasks are `pending` (`○`), `in_progress` (`◐`), `blocked` (`⊘`), `done` (`✓`), or `dropped` (`✕`):

- `blocked` is open work that waits on something outside the list, such as an admin, another team, or an authorization. It requires a note naming what it waits for, shown next to the title (`⊘ Deploy the cleanup job · waiting for an admin`). Blocked tasks keep the list open, but they never make it stale, and the collapsed card skips them for the next task.
- `dropped` marks a task a change of plan made obsolete. It renders dim without strikethrough, leaves the `done of total` count, and does not count as open, so a list whose remaining tasks are all `done` or `dropped` is finished. `cancelled`, `canceled`, and `abandoned` are accepted as aliases.

A finished list stays on screen for the turn it finished in and clears at the next. `ctrl+shift+t` collapses the card to the task in progress (`GENTLE_PI_TODO_KEY` rebinds it, `off` disables it); `GENTLE_PI_TODO=0` disables the tool and the card.

### Gentle Stats

`/gentle:stats` opens a full-terminal panel over your local usage history, read from the session files Pi already writes. It combines the active home's `sessions` directory with your regular Pi home's (`~/.pi/agent/sessions`, or the custom `PI_CODING_AGENT_DIR` that `gentle-shell` recorded as `GENTLE_SHELL_USER_PI_HOME` before isolating). The same directory reached twice counts once, and a session present in both homes counts once (the copy with more usage records, then the most recent one). Nothing new is stored. Subscription limits stay in `/gentle:usage`.

```text
╭─ ✿ Stats ─────────────────────────────────────── [×] ─╮
│ [Overview]  Models   Session                 │
│     May Jun       Jul     Aug       Sep      │
│ Mon · · · · · · · · · · · · · · · · · · · █  │
│     · · · · · · · · · · · · · · · ▓ · · · ░  │
│     Less · ░ ▒ ▓ █ More                      │
│ Favorite model  claude-opus-5-5              │
│ Total tokens    2.8k                         │
│ ✿ That's ~0.5% of the tokens in Don Quixote. │
```

- **Overview**: a weekday-by-week heatmap (up to 52 weeks for all time), favorite model, total tokens, sessions, longest session, active days, longest and current streak, most active day, the input/output/cache breakdown, and cost.
- **Models**: tokens, cost, messages, and share per model, with a share bar.
- **Session**: the live session's model, cost, wall time since its first entry, tokens, and the lines added and removed that Gentle Changes captured.
- `Tab`/`shift+Tab`, `←`/`→`, or `1`/`2`/`3` switch tabs; `r` cycles all time, last 7 days, and last 30 days; `s` toggles all projects and the current project (sessions started in this cwd); `q` or `esc` closes. Header tabs, `[× Close]`, and the footer hints are clickable.
- The heatmap shades come from the active theme's `accent` and `borderMuted` roles, so every Gentle theme recolors it.
- Only top-level session files are read: subagent runs are not included, and the panel says so. The first opening scans every file; later openings reread only files that changed.
- There is no default shortcut. Set `GENTLE_PI_STATS_VIEW_KEY` (for example `alt+t`) to bind one; `off` or empty leaves it unbound.

### Bridge providers

Idle Claude Bridge continuation uses the normal user-prompt lifecycle so prompt preparation and tool declarations are retained. Gentle Agents hides only its exact, uniquely generated reserved wake in Pi's interactive transcript; child result and query cards remain visible. Native providers keep their hidden `display: false` custom wake.

The reserved identity is stored once per session as a non-context custom entry and reconstructed on reload/resume, including identities on abandoned branches. It is session-owned: switching sessions releases the previous identity. Ordinary text quoting the old notification, prefixes, substrings, and whitespace variations is not hidden. Pi's transformer exposes no author/message ID, so an exact copy of the current reserved identity is indistinguishable from its generated wake.

This is **TUI-only suppression**: the generated user-role message remains in session history, model context, and RPC. It does not fix the SDK's idle custom-message lifecycle. Older runtimes without the Markdown transformer API, or failed identity persistence, retain visible continuation and emit a warning rather than dropping the wake. Existing unreserved wakes are not retroactively hidden.

The Gentle AI harness (ODD workflow, identity, review contract) and the open-tasks block are appended to `before_agent_start`'s `systemPromptOptions.appendSystemPrompt` instead of being returned as a replacement `systemPrompt` (gentle-shell#1485). Provider bridges such as `pi-claude-bridge` forward only those structured sections after their own preset and drop a returned `systemPrompt`, so this route reaches every provider, bridged or not.

Set `GENTLE_PI_SHELL=0` to keep pi's built-in footer and editor.

