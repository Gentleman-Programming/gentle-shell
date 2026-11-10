# Read per-session agent status

Any terminal tool can read Gentle Shell's status without Herdr or a socket.
Interactive top-level Pi sessions publish JSON under
`<gentlePiConfigHome()>/agent-status/<sha256-of-session-id>.json`.
Use the active Gentle Shell profile's config home; no `XDG_RUNTIME_DIR` is needed.
The packaged `gentle-agent-status` extension loads automatically.

## Format: `gentle-shell.agent-status/v1`

```json
{
  "schema": "gentle-shell.agent-status/v1",
  "agent": "gentle-shell",
  "session": "session-123",
  "pid": 12345,
  "cwd": "/work/project",
  "state": "working",
  "task": { "title": "Implement status adapter" },
  "updatedAt": "2026-07-17T12:34:56.000Z"
}
```

- `schema`: version identifier; readers should ignore unsupported versions.
- `agent`: `gentle-shell` when the launcher owns agent reporting, otherwise `pi`.
- `session`: stable Pi session ID; `pid`: publisher process ID; `cwd`: session workspace.
- `state`: `working`, `blocked` (attention takes precedence), or `idle`.
- `task`: sanitized first `in_progress` Todo title, or `null` when absent, inactive,
  invalid, or task summaries are disabled. Live preference changes apply immediately.
  Titles are bounded to a 4096 UTF-16-unit sample, preserve whole graphemes,
  and strip terminal/control/bidi sequences; no icon, row layout or added ellipsis.
- `updatedAt`: ISO 8601 UTC heartbeat, refreshed at least every 10 seconds.

## Minimal adapter

Set `STATUS_DIR` to the active config home's `agent-status` directory. For example,
this `jq` reader prints fresh sessions and tolerates missing files during shutdown:

```sh
jq -r 'select(.schema == "gentle-shell.agent-status/v1") |
  select((now - (.updatedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)) <= 30) |
  [.agent, .session, .state, (.task.title // "")] | @tsv' "$STATUS_DIR"/*.json 2>/dev/null
```

Treat timestamps older than 30 seconds as stale, even if the PID exists. Files
are replaced atomically on coalesced status changes and heartbeats, then removed
on shutdown. Crashes may leave stale files. Failed writes/removals never interrupt
Pi. Children and noninteractive sessions do not publish. Herdr remains unchanged.

## Privacy

A symlinked config home, status directory, or status file is refused (nothing is
written). Directories above the config home are trusted and may be symlinks.
On POSIX the status directory is created 0700 and files 0600; an existing status
directory with any group/other permissions, or a config home owned by another
account or writable by group or others, is refused. Windows has no extra ACL
check: the files inherit the config home's
permissions, which are private under the default user profile. The files contain workspace paths,
session IDs and Todo titles: do not put secrets in titles or expose this directory
through a public server. Prompts, tool arguments/results and Todo notes are not
published. Disabling task summaries hides titles, not the remaining status fields.
