# Gentle Shell Desktop — parity inventory (T2, S2)
What the TUI shows, where it comes from, and how the desktop gets it. "RPC" = `gentle:desktop` (`lib/desktop-rpc.ts:166`, only in `mode:"rpc"`); "snapshot" = the new per-session publisher (T4); "session" = the pi session file read by the chat mod (T1/T5). Rows marked (?) were located by name only.

| Area | Element | Source of truth | Desktop gets it from |
|---|---|---|---|
| Header | Project (cwd), branch, dirty count | `lib/shell-bar.ts:31-33` | snapshot (cwd also in `agent-status/<sha>.json`) |
| Header | Model, effort, profile tier, active profile | `shell-bar.ts:35-38`, `gentle-shell.ts:2651` | snapshot (config via RPC is not the live model) |
| Header | Persona | `/gentle:persona` `gentle-ai.ts:13322` (?) | snapshot |
| Header | Session name | `shell-bar.ts:34` | snapshot / Herdr `report_agent_session` |
| Bar | Context % + window | `shell-bar.ts:39-40`, `lib/shell-gauge.ts` | snapshot |
| Bar | Cost total / subscription flag | `shell-bar.ts:41-42` | snapshot |
| Bar | Plan usage gauge (5h / 7d) | `lib/shell-usage*.ts`, `gentle-shell.ts:2711` | snapshot (RPC `get_subscription_usage` equivalent) |
| Bar | Permission mode badge (incl. YOLO / super-yolo) | `shell-bar.ts:46`, `gentle-shell.ts:2880` | snapshot; set via action (T7) |
| Bar | Jobs counter | `gentle-shell.ts:2655`, `gentle-agents.ts:1807` | snapshot |
| Bar | Opaque extension statuses | `shell-bar.ts:44` | snapshot |
| Sidebar | Changes: files, +/-, summary, worktrees; diff viewer | `lib/shell-changes.ts:17-34,186,221`, `lib/shell-changes-view.ts` | snapshot (list); diff via `exec git` in mod or Herdr's own changes panel |
| Sidebar | Todo: tasks, states, progress, stale hints | `lib/shell-todo.ts:36-107`, `gentle-todo.ts:269-292` | snapshot (also replayable from session) |
| Sidebar | Agents: subagents, state, spend; view/stop | `gentle-agents.ts:2345-2348,3374-3380` | snapshot; stop via action |
| Sidebar | Jobs: running + finished queue, elapsed; cancel | `gentle-shell.ts:2777`, `lib/jobs-sidebar-state.ts:12` | snapshot; cancel via action |
| Sidebar | Review / RDD state + scope | `lib/review-sidebar-state.ts:27-45,161` | snapshot; switch via action |
| Sidebar | Stats: turns, tool calls, cost, duration, per model, subagent spend | `lib/shell-stats.ts:17-104` | snapshot |
| Sidebar | Integrations (Engram, MCP) | `shell-bar.ts:48` (?) | snapshot |
| Prompt | Image attachments | `gentle-shell.ts:3001,3090` | chat mod (paste) — later |
| Prompt | Vim mode, voice, double-Esc cancel | `/gentle:vim` `:3644`, `gentle-voice.ts`, `:855,3702` | TUI-only; desktop has native editing + Stop button |
| Prompt | Thinking / phase labels, TPS, ODD phase | `gentle-tps.ts`, `runtime-metrics.ts` (?) | snapshot (phase + streaming state) |
| Chat | Messages, tool calls, results, thinking | pi session entries | session (T1) |
| Questions | ask_user_question / ask_user_choice / subagent select/confirm/input | `ask-user-question.ts:244`, `ask-user-choice.ts:218`, `gentle-agents.ts:733-744` | snapshot (pending question payload); answer via action (T7) — gap today: Herdr only sees `blocked` |
| Consent | Review consent prompt | `gentle-ai.ts:13424` | same path as questions |
| Modals | /gentle:profiles, models, fallbacks | `gentle-ai.ts:4704-7042` | RPC config stores / `exec gentle-shell` command |
| Modals | /gentle:customize, theme, layout, density | `gentle-shell.ts:3172` | theme sync only (as in community gentle-herdr); layout options are TUI-only |
| Modals | Command palette, guide, stats, history, scratch, music, design, animations, doctor, status | various (`gentle-shell.ts:3116`, `gentle-guide.ts`, `history/index.ts`, `gentle-ai.ts:13389-13718`) | send the slash command into the session (T7); native views later |
| Global | Notifications / sounds | `gentle-notifications.ts` (?) | Herdr native notifications on `blocked`/done |
| Global | Activity working/blocked/idle + task title | `gentle-herdr-agent.ts:91-100`, `lib/agent-status.ts:5-25` | already exposed (Herdr reporter + agent-status file) |

## Gaps the publisher (T4) must close
1. Live session state: model/effort, active profile, persona, context %, cost, statuses, integrations.
2. Git: branch, dirty count, changes list.
3. Todo list and progress.
4. Review/RDD snapshot.
5. Session stats and subagent spend.
6. Pending question/consent payload, plus a way to answer it.
7. ODD phase / streaming state.
