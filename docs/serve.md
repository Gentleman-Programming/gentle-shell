# `gentle-shell serve`

`gentle-shell serve` runs one long-lived server per agent home. The server owns Gentle Shell sessions — one `gentle-shell --mode rpc` child each — so they keep running when the client that started them disconnects, and any paired device can follow and drive them over HTTP and Server-Sent Events (SSE).

This is Phase 1 of [RFC #3527](https://github.com/Gentleman-Programming/gentle-shell/issues/3527), plus the `/.well-known/gentle-shell` identity, LAN discovery and `serve share` codes. Persistent terminals (Phase 2), SSH bootstrap and TLS (Phase 3) and a mobile web client (Phase 4) are not part of it; see [Not done yet](#not-done-yet). To run it from a source checkout on a Linux machine and reach it from another one, see [Try it](#try-it-from-source-on-linux).

## Quick start: connect from Gentle Shell GPUI

On the computer where the agents should run (for example a Linux PC on your home network), run one command:

```sh
gentle-shell serve share
```

It prints a short code, and a long one under it:

```text
Started the Gentle Shell server for your network on port 8787.

  Code: 7PH3-DM9V

In Gentle Shell GPUI → Configuration → Where agents run → Gentle Shell server, enter this code. Valid for 5 minutes, once.
If the app can't find this computer, paste this instead:
gsc1.eyJ2IjoxLCJpZCI6InNydl8…

It uses plain HTTP on your network: share only on a network you trust, such as your home network.
```

Type the 8-character code in Gentle Shell GPUI on the other computer, in **Configuration → Where agents run → Gentle Shell server**: the app finds this computer on your network by itself ([LAN discovery](#lan-discovery)) and pairs. That is all: no SSH, IP addresses, ports or tunnels. When the app cannot find it — the computers are on different subnets, on a tailnet, or the Wi-Fi isolates clients — paste the long `gsc1.…` line in the same field instead. On Linux with a firewall, `share` also prints the command that opens the port (for example `sudo ufw allow 8787`, which covers both the HTTP connection and discovery). For another device, or when the code expired, run `serve share` again. `gentle-shell serve share --always` also starts the server at every login; `serve share --off` turns that off. Details: [Share on your network](#share-on-your-network). From a source checkout, run the checkout's launcher instead (`gsdev serve share`, see [Try it](#try-it-from-source-on-linux)).

## Quick start by hand

```sh
gentle-shell serve                 # start in the background; prints the URL
gentle-shell serve pair            # one-time code for a device (5 minutes, single use)
curl -X POST http://127.0.0.1:PORT/api/pair \
  -H 'Content-Type: application/json' -d '{"code":"ABCD-EFGH","name":"laptop"}'
# → {"id":"dev_…","name":"laptop","scopes":[…],"token":"gss_…"}   (the token is shown once)

curl -X POST http://127.0.0.1:PORT/api/sessions -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"cwd":"/path/to/project"}'
curl -X POST http://127.0.0.1:PORT/api/sessions/$SID/rpc -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"type":"get_state"}'
curl -N "http://127.0.0.1:PORT/api/sessions/$SID/events?after=0" -H "Authorization: Bearer $TOKEN"

gentle-shell serve status
gentle-shell serve stop            # stops the server and every session it owns
```

## Commands

| Command | Does |
| --- | --- |
| `gentle-shell serve share [--port <n>] [--always] [--json]` | Open the server to the local network (with [LAN discovery](#lan-discovery)) and print the short pairing code plus a [connection code](#connection-code) for Gentle Shell GPUI. See [Share on your network](#share-on-your-network). `--json` prints `{ code, pairingCode, port, addresses, expiresAt, serverId, discovery }` (`code` is the `gsc1.…` connection code, `pairingCode` the short one, `discovery` whether the server answers LAN discovery). |
| `gentle-shell serve share --off` | Remove the login autostart that `--always` installed (this stops the server it runs). |
| `gentle-shell serve [--listen <host>:<port>] [--allow-host <name>]... [--foreground] [--json]` | Start the server. In the background by default (log in `serve/server.log`); `--foreground` keeps it in the terminal until Ctrl+C. `--listen` defaults to `127.0.0.1:0` (a random port); `:8787`, `8787` and `[::1]:8787` are accepted. `--allow-host` adds one DNS name clients may use in the `Host` header (repeatable; see [Security model](#security-model)). |
| `gentle-shell serve status [--json]` | URL, pid, start time, protocol and the session list. Exit 1 when no server runs. |
| `gentle-shell serve stop` | Asks the server to stop (it stops every session first) and waits for it to exit. |
| `gentle-shell serve pair [--scope <scope,…>] [--json]` | Mint a pairing code. Scopes default to `sessions:read,sessions:operate`. |
| `gentle-shell serve devices [--revoke <id>] [--json]` | List paired devices or revoke one. Works without a running server too (on the devices file). |

The home selectors work ahead of `serve` as they do for `setup`: `gentle-shell --home ~/work-agent serve` runs a separate server for that home, and its sessions run against that home.

## Share on your network

`serve share` is the one command a person runs to connect Gentle Shell GPUI on another computer of the same network:

- **No server yet:** it starts one in the background on every interface (`--listen 0.0.0.0:8787 --allow-host <hostname> --allow-host <hostname>.local`). When the port is taken it tries the next nine; `--port <n>` starts the search elsewhere.
- **A server on this computer only (loopback):** with no running sessions it is stopped and started again on the network, transparently. With running sessions it is left alone: `share` explains in one line and exits 1 (stop them or run `serve stop` first).
- **A server already on the network:** reused as it is (on its own port).

Then it mints a pairing code (as `serve pair` does: default scopes, 5 minutes, single use) and prints it, followed by the [connection code](#connection-code) that carries it. The app takes either in the same field: the short code when it can [find the server on the network](#lan-discovery) by itself, the long one where discovery does not reach (another subnet, a tailnet, a Wi-Fi with client isolation). When the server could not open its UDP port, `share` says so in one line (discovery is off; the long code still works). On Linux, when `ufw` or `firewall-cmd` is installed, it also prints the exact command that opens the port for TCP and UDP (it never runs `sudo` itself), for example `sudo ufw allow 8787`.

The network server is plain HTTP, exactly as `--listen 0.0.0.0` (see [Security model](#security-model)): the pairing code, the device token and session traffic cross the network unencrypted. Share only on a network you trust; over the internet use the [SSH tunnel](#4-reach-it-from-the-mac) instead.

### LAN discovery

A server listening on a non-loopback address (`share`, or any `--listen` other than loopback) also binds UDP on `0.0.0.0:<its HTTP port>` and answers discovery queries. When that bind fails (the port is taken) the server logs `discovery off: …` and runs without it.

- **Query** (client → broadcast): `{"t":"gentle-shell/discover","v":1}`, sent from one ephemeral UDP socket to `255.255.255.255` and to each interface's directed broadcast address, on ports 8787-8796 (the ports `share` tries).
- **Reply** (server → unicast to the query's source address and port): `{"t":"gentle-shell/here","v":1,"id":"<serverId>","n":"<hostname>","p":<HTTP port>}`.

Anything else is ignored: datagrams over 512 bytes, other JSON, other `t` or `v`. Replies are rate-limited (20 per second overall, 4 per second per source address). They carry no secrets.

The client collects replies for about 1.5 s and, for each distinct one, checks `GET http://<reply source IP>:<p>/.well-known/gentle-shell` names the same `serverId`. With a short code it then pairs with `POST /api/pair { code, name }` at the only server verified, lets the person pick one (name and IP) when several answered, and when none did asks them to check that both computers are on the same Wi-Fi and the firewall allows the port (`sudo ufw allow 8787` opens TCP and UDP), or to paste the long code instead. The pairing code is never sent to an address whose identity did not match.

### Connection code

The fallback for when discovery cannot reach the server: `gsc1.` followed by the base64url (no padding) of one JSON object:

```json
{"v":1,"id":"srv_…","n":"linux-box","p":8787,"a":["192.168.1.20","100.101.102.103","linux-box","linux-box.local"],"c":"ABCD-EFGH"}
```

| Key | Value |
| --- | --- |
| `v` | `1` |
| `id` | The server's `serverId`. |
| `n` | The server machine's hostname, for display. |
| `p` | The port. |
| `a` | Addresses to try, best first, at most 8: the machine's IPv4 addresses except loopback and link-local (`169.254.x.x`) — private LAN ranges first, then others such as a tailnet's, then container and VM bridges (`docker0`, `virbr0`, …) — then its hostname and `<hostname>.local`. |
| `c` | The pairing code. |

The client probes `GET http://<address>:<p>/.well-known/gentle-shell` at every address in parallel (about 1.5 s each), keeps the first whose `serverId` equals `id`, pairs there with `POST /api/pair { code: c, name }`, and keeps that address as the server URL. It never sends the pairing code to an address whose identity did not match. The code is a secret while its pairing code is valid (5 minutes, single use); afterwards it only names the server and its addresses.

### Start at login

`serve share --always` hands the network server to the login service manager, so it starts at every login and restarts after a crash. The service runs the same launcher, the same home flags and the same `--listen`/`--allow-host` as `share` would, with `PATH` and the `GENTLE_SHELL_NO_AUTO_SETUP`, `GENTLE_SHELL_HOME`, `GENTLE_SHELL_CONFIG`, `GENTLE_PI_CONFIG_HOME`, `GENTLE_SHELL_PI` and `PI_CODING_AGENT_DIR` values of the invocation (when set), so a source checkout works too.

| System | What it writes and runs |
| --- | --- |
| Linux | `~/.config/systemd/user/gentle-shell-serve.service` (`$XDG_CONFIG_HOME` when set), then `systemctl --user daemon-reload` and `systemctl --user enable --now gentle-shell-serve.service`. Output goes to the journal (`journalctl --user -u gentle-shell-serve`). A user unit runs while you are logged in; `sudo loginctl enable-linger $USER` starts it at boot and keeps it after logout (`share` prints this). |
| macOS | `~/Library/LaunchAgents/com.gentle-shell.serve.plist`, then `launchctl bootstrap gui/$UID` on it. Output goes to `<home>/serve/server.log`. |
| Windows | Not supported yet: `--always` exits 1 before starting anything. |

A server already running is replaced by the service only when it has no running sessions (otherwise `--always` exits 1 and leaves it alone); one the service already runs is reused. `serve share --off` disables and removes the unit (`systemctl --user disable --now`) or boots out and removes the agent, which stops the server it ran. One autostart per user: `--always` from another home replaces it.

## Files

Everything lives in `<agent home>/serve/`, a `0700` folder:

| File | Content |
| --- | --- |
| `server.json` (`0600`) | `{ schema: "gentle-shell.serve.server/v1", protocol, serverId, url, listen, pid, startedAt, version, adminToken, discovery }`. Local clients discover the server here (`discovery`: whether it answers [LAN discovery](#lan-discovery)). Removed when the server stops. |
| `server.lock` (`0600`) | The pid holding the single-instance lock. A lock whose pid is gone is taken over. |
| `devices.json` (`0600`) | Paired devices: id, name, scopes, created and last-used times, and the **sha256 of the token** — never the token. |
| `server.log` (`0600`) | Background server log: lifecycle lines and each session's stderr, prefixed by session id. |

`adminToken` is a fresh random token per server run. It is how `serve status`, `pair`, `devices` and `stop` talk to the server, so anyone who can read `server.json` (the owner) administers it.

## Process model

Each session is a child process: this same launcher (`node bin/gentle-shell.mjs <home flags> --mode rpc [--session-id <id>]`, in the requested folder), so Pi is resolved exactly as a plain launch resolves it, with `GENTLE_SHELL_INTERACTIVE_HOST=1` (Desktop RPC and RPC dialogs on, as for Gentle Desktop) and `GENTLE_DESIGN_OPEN_BROWSER=0` (never a browser on the server machine).

- The server reads every child's stdout continuously, whoever is listening, and keeps the child's stdin open for its whole life (closing it is Pi's shutdown request).
- A session ends only when it is deleted (`DELETE /api/sessions/:id`), when the server stops, or when the child exits on its own. Its exit is a record in its stream (`serve_session_exited`) and a state in the list. Up to 16 exited sessions stay listed (with their replay ring) until deleted.
- Stopping closes stdin and sends SIGTERM together (Pi treats them as one orderly shutdown request), then SIGKILL after 5 s.
- At most 16 sessions run at once.

## Protocol

`gentle-shell.serve/v1`, protocol `1`. JSON over HTTP for requests; SSE for each session's output. All errors are `{ "error": { "code", "message" } }`.

### Endpoints

| Method and path | Scope | Body → answer |
| --- | --- | --- |
| `GET /.well-known/gentle-shell` | none | `{ schema: "gentle-shell.serve.identity/v1", serverId, name, protocol, version }`: who answers at this address (`name` is the machine's hostname). No secrets; `Host` and `Origin` rules still apply. A client holding a [connection code](#connection-code) probes it before pairing. |
| `POST /api/pair` | none (the code) | `{ code, name? }` → `201 { id, name, scopes, createdAt, token }`. `403 invalid_code`, `429 rate_limited`, `409 too_many_devices`. |
| `GET /api/server` | `sessions:read` | `{ schema, protocol, serverId, version, startedAt, capabilities, device }` |
| `POST /api/server/stop` | `admin` | `202`; the server stops its sessions and exits. |
| `POST /api/pairing-codes` | `admin` | `{ scopes? }` → `201 { code, scopes, expiresAt }` |
| `GET /api/devices` | `admin` | `{ devices: [{ id, name, scopes, createdAt, lastUsedAt? }] }` |
| `DELETE /api/devices/:id` | `admin` | `{ revoked }`. Immediate: the token stops working, its tickets die, its open streams close. |
| `POST /api/tickets` | `sessions:read` | `{ sessionId }` → `201 { ticket, expiresAt }` (see [Stream tickets](#stream-tickets)). |
| `GET /api/sessions` | `sessions:read` | `{ sessions: [Session] }` |
| `POST /api/sessions` | `sessions:operate` | `{ cwd, sessionId? }` → `201 { session }`. `cwd` must be an absolute path to an existing folder; `sessionId` is a Pi session id (`--session-id <id>`: the folder's session with that exact id, or a new one with it when Pi never wrote it, as for a conversation with no messages yet), never a path. |
| `GET /api/sessions/:id` | `sessions:read` | `{ session }` |
| `DELETE /api/sessions/:id` | `sessions:operate` | Stops the session (waits for its exit) and forgets it: `{ session }`. |
| `POST /api/sessions/:id/rpc` | per command | One Pi RPC command object → its Pi `response`. |
| `POST /api/sessions/:id/desktop` | per method | `{ method, params? }` → the Desktop RPC response object. |
| `GET /api/sessions/:id/events?after=<seq>` | `sessions:read` | SSE stream (bearer header, or `?ticket=`). |

`Session` is `{ id, name, cwd?, state: "running"|"exited", startedAt, exitedAt?, exitCode?, exitSignal?, seq, subscribers, pendingDialogs, lastActiveDevice }`. `name` is the folder's basename; the absolute `cwd` is included only for a token with `sessions:operate` (which can start sessions in any folder anyway). `lastActiveDevice` is the id of the device that most recently drove the session (started it, or sent any request that needs `sessions:operate`: a prompt, a steer, a follow-up, a dialog answer, a host message, a Desktop write), or `null`.

### Pi RPC: `POST /api/sessions/:id/rpc`

The body is one [Pi RPC command](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc-commands.md) (`{ "type": "get_state" }`, `{ "type": "prompt", "message": "…" }`, …). Several clients can share a session, so the server sends it under its own id (`serve-rpc-N`) and puts the client's `id` back on the response it returns. The same response also appears in the event stream, under the server's id.

- The server waits up to 30 s for the response. A command that takes longer (a long `bash`, `compact`) answers `202 { pending: true, id }`, and its response arrives in the stream under that `id`.
- `extension_ui_response` is the answer to a dialog: see [Dialogs](#dialogs). It answers `202 { accepted: true }`.
- Bodies are limited to 8 MiB (prompts can carry images).
- A `/gentle:desktop` prompt whose request is `set_host_tools`, `host_tool_result`, `host_message` or `set_host_context` is refused with `400 use_desktop_endpoint`: those go through `/desktop` only (see [Host tools](#host-tools)).

### Desktop RPC: `POST /api/sessions/:id/desktop`

A convenience over the existing [Desktop RPC](desktop-rpc.md) transport: the server sends the `/gentle:desktop` prompt with its own `requestId`, waits for the matching `gentle-desktop-rpc` widget answer, and returns it (`{ schema, kind: "response", requestId, ok, data | error }`; `requestId` is the server's, and any `schema` or `requestId` in the body is ignored). `504 desktop_timeout` after 30 s; `502 desktop_refused` (with Pi's prompt response) when the session refused the prompt. Bodies are limited to 80 KiB (Desktop RPC requests are limited to 64 KiB), except `set_host_tools`, `host_tool_result`, `host_message` and `set_host_context`, which may be up to 10 MiB less 1 KiB (a result can carry 8 MiB of screenshots and 1 MiB of details; the session caps each method at its own limit). Desktop RPC events keep arriving in the event stream as `setWidget` records, exactly as Desktop sees them. Sending `/gentle:desktop` prompts through `/rpc` also works for every other method; this endpoint only adds the correlation.

### Host tools

A client can provide [host tools](desktop-rpc.md#set_host_tools): tools the agent calls like any other but that run on the client's own device (a screenshot of the Mac, a photo from the phone). The agent runs here; the tool runs there. The server routes the calls:

- **The provider is the device.** `set_host_tools` and `set_host_context` through `/desktop` always register under the calling device's id (`provider` in the body is replaced), and need `sessions:operate`. The same requests through `/rpc` are refused, so no client can register tools or context as another device.
- **Messages.** [`host_message`](desktop-rpc.md#host_message) (a client's custom message into the conversation) goes through `/desktop` only too, with `sessions:operate`. [`set_host_context`](desktop-rpc.md#set_host_context) keeps one hidden context per device, added before each agent run until the device clears it or the session changes.
- **Only the provider answers.** A `host_tool_result` for a call whose `provider` is another device is refused with `403 forbidden`. The server remembers each call it saw in the session's output until a result settles it, a `host_tool_cancel` ends it, or 11 minutes pass.
- **One tool, several devices.** Devices may offer the same tool name (the Mac and the phone both offer `device_screenshot`). A call goes to the device that most recently drove the session (`lastActiveDevice`) if it offers the tool and has an open event stream; otherwise to the next most recently active one that does; when none does, it is answered at once as not connected. The server keeps the session told with [`set_host_activity`](desktop-rpc.md#set_host_activity) (connected providers, most recently active first) whenever that order changes; clients cannot send it (`403` through `/desktop`, `use_desktop_endpoint` through `/rpc`).
- **Delivery.** The `host_tool_call` event reaches every subscriber like any Desktop RPC event (`data.provider` says which device runs it; the others ignore it). A device that opens a stream while one of its calls is still waiting, and whose replay does not carry it, also gets it as an SSE event `event: host_tool_call` whose `data` is the original `setWidget` record.
- **Offline device: an answer at once.** If the call's device has no open event stream when the call appears, the server answers for it right away with an error result the model reads — `<tool> runs in <device name>, which isn't connected right now.` — instead of letting the turn wait. If a device's last stream closes while it owes results, the server waits 10 s for it to reconnect, then answers its waiting calls the same way. Revoking a device answers its calls at once.
- **Time limit.** The session itself ends a call after 10 minutes without a result, with an error result and a `host_tool_cancel`.

The server never runs client code: a host tool's work happens on the client, with the client's authority, and only its result comes back into the conversation.

### Event stream: `GET /api/sessions/:id/events`

Every record the child prints — Pi responses, session events, extension UI requests (including Desktop RPC answers and events) — gets the session's next `seq`, starting at 1. Each one is an SSE message with `id: <seq>` and the record, unchanged, as `data`:

```text
retry: 3000

event: hello
data: {"session":"ses_…","state":"running","seq":13,"oldest":1}

id: 1
data: {"type":"extension_ui_request","id":"…","method":"setStatus",…}

id: 2
data: {"type":"response","id":"serve-rpc-1","command":"get_state","success":true,"data":{…}}

: ping
```

Other SSE events, which carry no `id` (so they never move a client's cursor):

| Event | When |
| --- | --- |
| `hello` | First, on every connection: the session's state, current `seq` and oldest replayable `seq`. |
| `snapshot-required` | `after` is older than the replay ring (records the client never saw were evicted) or newer than the stream (a cursor from another server run). `{ after, oldest, seq }`. The client recovers state with Pi `get_state` / `get_messages` and Desktop RPC `get_snapshot`, then follows the live stream that continues on the same connection. |
| `dialog` | A dialog still waiting for an answer that this connection's replay did not carry. `data` is the original `extension_ui_request`. |
| `host_tool_call` | To the device that provides it only: a host tool call still waiting for that device's result that this connection's replay did not carry. `data` is the original `setWidget` record. |
| `resync` | Sent as the stream is closed for falling behind: `{ reason: "slow_client", seq }`. Reconnect with the last `id` seen. |

The server also adds its own records to the stream (they have a `seq` like any other):

| Record | Meaning |
| --- | --- |
| `{"type":"serve_dialog_resolved","id"}` | A client answered this dialog; other clients can close it. |
| `{"type":"serve_session_exited","code","signal","error"?}` | The child exited. The stream ends after it. |
| `{"type":"serve_record_dropped","reason":"too_large","maxBytes"}` | A stdout record over 16 MiB was dropped. |

`after` comes from the query, or from the `Last-Event-ID` header that `EventSource` sends on reconnect. Without it the stream starts live (plus the pending dialogs and the device's waiting host tool calls). An exited session replays and then ends the stream.

A comment line (`: ping`) is sent every 20 s so proxies do not close idle streams.

#### Replay and resume

Each session keeps a replay ring of its newest records: 2000 records or 8 MiB, whichever is reached first (the newest record is always kept). `after` inside the ring replays exactly what was missed; outside it the client gets `snapshot-required`. Sequence numbers belong to one session in one server run: a restarted server has new session ids, so an old id answers `404`.

#### Dialogs

`select`, `confirm`, `input` and `editor` requests stay pending until answered, until their own `timeout` passes, or until the session exits. A subscriber that connects later gets them as `dialog` events. Answer one with `POST /rpc` `{ "type": "extension_ui_response", "id": "<request id>", … }`: only the first answer reaches Pi; a later one gets `409 dialog_answered`, an unknown id `404 unknown_dialog`. The server then adds `serve_dialog_resolved` to the stream.

#### Backpressure

A slow client never slows a session. The child's stdout is always read; each subscriber's unsent bytes are bounded (4 MiB). A subscriber over that bound is dropped: its stream ends with a `resync` event (and is cut 5 s later if it still is not reading), and it reconnects with its last `id`. Commands are refused with `503 session_busy` if a child stops reading its stdin and 16 MiB pile up there.

#### Framing

Child stdout is split on LF only, with an optional CR before it stripped, never on U+2028/U+2029 (which are valid inside JSON strings, and which Node's `readline` would split on). A line that is not a JSON object is not forwarded. Commands are written as one JSON object plus LF.

## Authentication

There is no unauthenticated mode: every endpoint except `GET /.well-known/gentle-shell` (public identity, no secrets) and `POST /api/pair` needs a token.

- **Pairing.** `gentle-shell serve pair` mints a code like `ABCD-EFGH` (40 random bits, Crockford base32; case, dashes and `O`/`I`/`L` look-alikes are forgiven). It is single use — the first attempt that names it consumes it — and expires after 5 minutes; at most 16 are live. Ten failed attempts in a minute, from anyone, pause pairing for the rest of that minute.
- **Device tokens.** `gss_` plus 32 random bytes (base64url). Shown once, in the pairing answer. Stored only as a sha256 hash; compared in constant time. Sent as `Authorization: Bearer <token>`. At most 64 devices.
- **Scopes.**
  - `sessions:read` — list and read sessions, follow their streams, mint stream tickets, read-only Pi RPC commands (`get_state`, `get_messages`, `get_available_models`, `get_available_thinking_levels`, `get_session_stats`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `get_commands`) and read-only Desktop RPC methods (`capabilities`, `get_*`, `list_*`).
  - `sessions:operate` — start and stop sessions, every other Pi RPC command (prompts, steering, aborts, bash, model changes, `extension_ui_response`), and every other Desktop RPC method.
  - `admin` — pairing codes, devices, stopping the server.

  Authorization is checked per request (per command or method for `/rpc` and `/desktop`), never per connection.
- **Revocation** (`serve devices --revoke`, or `DELETE /api/devices/:id`) takes effect at once: the token stops working, its stream tickets are discarded and its open streams are closed.
- **Local admin token.** The CLI uses the per-run token in the owner-only `server.json`; it has every scope.

### Stream tickets

Browsers' `EventSource` cannot send headers, and long-lived tokens never go in URLs. A client with a token calls `POST /api/tickets { sessionId }` and opens `GET /api/sessions/:id/events?ticket=<ticket>`. A ticket is valid for 60 s, for one connection, to that one session, with the scopes of the device that minted it. The events endpoint is the only one that accepts `?ticket=`.

## Security model

- **Loopback by default.** Without `--listen` the server binds `127.0.0.1` on a random port. Remote use goes through `ssh -L` (or a tunnel) to that port.
- **Plain HTTP on a network is an explicit choice.** A non-loopback `--listen` (for example `0.0.0.0:8787`) starts only because device auth is always on, and prints a warning: tokens and session traffic then cross the network unencrypted. Use it on a network you trust (a home LAN, a tailnet).
- **LAN discovery reveals presence only.** A network server answers the UDP [discovery query](#lan-discovery) of anyone on the network with its `serverId`, hostname and port — what `/.well-known/gentle-shell` already tells — and nothing else; replies are rate-limited and go only to the sender (a reply is about the size of the query, so it cannot amplify traffic). A loopback server does not listen for discovery.
- **Origin and Host.** A request whose `Origin` is not this server's own origin (`http://<Host>`) is refused (`403 forbidden_origin`), before authentication, including `POST /api/pair`. Requests without `Origin` (curl, native clients) are accepted; tokens are never cookies, so a browser cannot attach them on another page's behalf. The `Host` header must name this server and its port (`421 bad_host`): loopback names for a loopback bind, the bound address otherwise, and for `0.0.0.0`/`::` any IP literal or this machine's own hostname (also as `<hostname>.local`) — never another DNS name (DNS rebinding). A name the operator trusts, such as a tailnet MagicDNS name (`box.tail1234.ts.net`), is added with `--allow-host <name>`; it is an exact name, never a pattern. No CORS headers are sent.
- **Headers.** `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- **Bounded input.** 16 KiB for small JSON bodies, 80 KiB for Desktop RPC (10 MiB for host tool registrations, results, messages and context), 8 MiB for Pi RPC commands; 20 s to send headers.
- **Host tools run on the client.** A device's host tools run on that device with its own authority; the server and the agent only see the call's arguments and the result. A device can only register tools as itself and answer its own calls.
- **Remote authority never exceeds the terminal's.** `sessions:operate` is the same authority as typing into the session's terminal or writing the Desktop app's RPC stdin — including `/gentle:mode`, `set_permission_mode` and the rest of the [Desktop RPC trust boundary](desktop-rpc.md#trust-boundary). The server forwards to Pi unchanged and bypasses none of the existing rules: remote prompts are not interactive consent, provider consent stays terminal-only, and Desktop RPC's own checks apply inside the child. Pair `sessions:operate` only with devices you would hand your terminal; `sessions:read` follows without driving.

## Limits

| Limit | Value |
| --- | --- |
| Running sessions | 16 (`429 too_many_sessions`) |
| Exited sessions kept | 16 |
| Replay ring per session | 2000 records or 8 MiB |
| Unsent bytes per subscriber | 4 MiB, then `resync` |
| One stdout record | 16 MiB, then `serve_record_dropped` |
| Pending stdin per session | 16 MiB, then `503 session_busy` |
| `/rpc` and `/desktop` wait | 30 s (`202 pending` / `504 desktop_timeout`) |
| Host tool call, device offline | answered at once; 10 s grace after its last stream closes |
| Host tool call, no result | 10 minutes |
| Heartbeat | 20 s |
| Pairing code | 5 minutes, single use, 16 live, 10 failures per minute |
| Stream ticket | 60 s, single use, 256 live |
| Devices | 64 |
| LAN discovery replies | 20 per second overall, 4 per second per source address; queries over 512 bytes dropped |

## Try it from source on Linux

A walkthrough for running this branch on a Linux machine (written for Arch / Omarchy; other distributions differ only in package names) and reaching it from another machine, for example a Mac. No released Gentle Shell has `serve` yet: the installed `gentle-shell` takes `serve` as a prompt for the model, so every command below runs the checkout's launcher.

### 1. Install the checkout

Requirements: `git`, Node `^22.19.0 || >=23.6.0` (`package.json` `engines`), and corepack to get the pinned pnpm (`packageManager`: `pnpm@11.1.1`). Node 22 and 24 ship corepack; Node 25 and later do not, so install it with `npm install -g corepack` (with `sudo` for a system Node from pacman; not with mise).

```sh
sudo pacman -S --needed git nodejs npm      # or: mise use -g node@22
git clone -b feat/serve-phase1 https://github.com/ismaelosuna7824/gentle-shell.git ~/src/gentle-shell
cd ~/src/gentle-shell
corepack pnpm install
```

`pnpm install` installs the dependencies (Pi included, in `node_modules`) and its `postinstall` downloads the pinned Gentle AI release binary, verified against its signed checksums, into `.gentle-ai/v<version>/` inside the checkout. It writes nothing in your home (a git checkout is not a Pi-managed install, so the global Pi settings are not touched).

A shell function keeps the commands short:

```sh
gsdev() { GENTLE_SHELL_NO_AUTO_SETUP=1 node ~/src/gentle-shell/bin/gentle-shell.mjs "$@"; }
```

### 2. Choose the agent home

The checkout resolves its home exactly as the installed `gentle-shell` does: `--link`, `--isolated` or `--home <dir>` when given, otherwise the home saved in `~/.gentle-shell/config.json`, otherwise `~/.gentle-shell/agent` (or `$GENTLE_SHELL_HOME`). So with no flags it uses the same home as your installed Gentle Shell, with its sign-ins (`auth.json`), providers and settings. Compare the `home` line of both:

```sh
gentle-shell --version     # the installed one
gsdev --version            # the checkout; prints nothing new on disk
```

- **Reuse your providers (recommended):** run `gsdev serve …` with the same home selector you use day to day (none, or `--link` if you launch `gentle-shell --link`). `serve` itself writes only `<home>/serve/`. Its sessions are ordinary launches of the checkout in that home, so they also read and write the home's sessions and settings, as any Gentle Shell launch does. `GENTLE_SHELL_NO_AUTO_SETUP=1` (in `gsdev`) keeps those launches from re-running setup in the home when the checkout's version differs from the one that set the home up, so the companion packages stay as your installed Gentle Shell left them. The installed Gentle Shell keeps working alongside; the two never share a process.
- **Fully separate:** `gsdev --home ~/.gentle-shell-serve serve …` uses a new home. Copy your sign-ins into it if you want them (`install -m 600 ~/.gentle-shell/agent/auth.json ~/.gentle-shell-serve/`); without `GENTLE_SHELL_NO_AUTO_SETUP=1` its first session installs the companion packages there.

Sessions use the checkout's Pi (`node_modules`), not the installed one's.

### 3. Start, check, stop

```sh
gsdev serve --listen 127.0.0.1:8787   # starts in the background, prints the URL and the log path
gsdev serve status                    # URL, pid, sessions
gsdev serve pair                      # one-time code (5 minutes, single use)
gsdev serve devices                   # paired devices; --revoke <id> removes one
gsdev serve stop                      # stops the server and every session it owns
```

The log is `<home>/serve/server.log` (rewritten on each start). Gentle Shell never launches the server on its own: once started it runs until `serve stop`, a reboot, or its process is killed. Sessions run on the Linux machine, so their `cwd` is a path there.

`gsdev serve share --always` writes and enables a systemd user unit for the network server ([Start at login](#start-at-login)). To keep a loopback-only server for the SSH tunnel instead, write the unit by hand (same file name, so use one or the other); it runs the server in the foreground and its output goes to the journal instead of `server.log`:

```sh
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/gentle-shell-serve.service <<EOF
[Unit]
Description=Gentle Shell serve (source checkout)

[Service]
Type=simple
Environment=PATH=$PATH
Environment=GENTLE_SHELL_NO_AUTO_SETUP=1
ExecStart=$(command -v node) %h/src/gentle-shell/bin/gentle-shell.mjs serve --foreground --listen 127.0.0.1:8787
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now gentle-shell-serve
journalctl --user -u gentle-shell-serve -f
```

The heredoc writes your current `PATH` and `node` into the unit (a user service does not read your shell profile; sessions' tools need the `PATH`). Add your home selector before `serve` if you use one. `systemctl --user stop gentle-shell-serve` stops it in order (SIGTERM); `gsdev serve stop` also works and is not restarted. A user unit runs while you are logged in; `sudo loginctl enable-linger $USER` starts it at boot and keeps it running after you log out.

### 4. Reach it from the Mac

**Easiest: `serve share`.** `gsdev serve share` on the Linux machine, then enter the short code it prints in Gentle Shell GPUI on the Mac, or paste the long `gsc1.…` code when the app cannot find the Linux machine ([Quick start](#quick-start-connect-from-gentle-shell-gpui)). It is option (b) below, plain HTTP on your network, without typing addresses. The rest of this step is the manual way.

**(a) SSH tunnel (recommended).** The server stays on loopback and SSH encrypts everything. It needs `sshd` on the Linux machine (`sudo systemctl enable --now sshd`). On the Mac:

```sh
ssh -N -L 8787:127.0.0.1:8787 you@linux-box
```

The client then uses `http://127.0.0.1:8787`. Keep the **same port on both ends**: the client's `Host` header carries the Mac's local port, and the server accepts only its own (`-L 9000:127.0.0.1:8787` is refused with `421 bad_host`). The tunnel works over a LAN or a tailnet (`you@linux-box` can be a Tailscale name).

**(b) LAN or Tailscale, plain HTTP.** Bind every interface:

```sh
gsdev serve --listen 0.0.0.0:8787
```

It prints a warning: device tokens and session traffic cross the network unencrypted, so use it only on a network you trust (a tailnet encrypts at its own layer). Clients may use, in the URL:

- an IP literal: `http://192.168.1.20:8787`, or the Tailscale IP `http://100.x.y.z:8787` (`tailscale ip -4`);
- the machine's own hostname (`uname -n`), alone or with `.local`: `http://linux-box:8787` — also a tailnet's short MagicDNS name when it equals the hostname;
- any other DNS name only when allowed by name. A full MagicDNS name such as `linux-box.tail1234.ts.net` is refused (`421 bad_host`) unless the server is started with it:

  ```sh
  gsdev serve --listen 0.0.0.0:8787 --allow-host linux-box.tail1234.ts.net
  ```

Binding a single address (`--listen 100.x.y.z:8787`) accepts only that address in `Host`. If `ufw` is enabled (Omarchy enables it; check `sudo ufw status`), open the port to the network you use, for example `sudo ufw allow in on tailscale0 to any port 8787 proto tcp` or `sudo ufw allow from 192.168.1.0/24 to any port 8787` (TCP and UDP: UDP carries [LAN discovery](#lan-discovery)). The SSH tunnel needs no rule beyond SSH's.

### 5. Pair a client and drive a session

On the Linux machine, mint a code (`gsdev serve pair`). On the Mac, with `URL` the address from step 4:

```sh
URL=http://127.0.0.1:8787
curl -sX POST $URL/api/pair -H 'Content-Type: application/json' -d '{"code":"ABCD-EFGH","name":"mac"}'
# → {"id":"dev_…","name":"mac","scopes":["sessions:read","sessions:operate"],"createdAt":"…","token":"gss_…"}
TOKEN=gss_…                                           # shown once: keep it
curl -s $URL/api/server -H "Authorization: Bearer $TOKEN"
curl -sX POST $URL/api/sessions -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"cwd":"/home/you/project"}'
SID=ses_…                                             # session.id from the answer
curl -N "$URL/api/sessions/$SID/events?after=0" -H "Authorization: Bearer $TOKEN"   # in a second terminal
curl -sX POST $URL/api/sessions/$SID/rpc -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"type":"get_state"}'
curl -sX DELETE $URL/api/sessions/$SID -H "Authorization: Bearer $TOKEN"
```

A `{"type":"prompt","message":"…"}` command starts a model turn with the home's provider, exactly as typing in the session would. The device stays paired across server restarts (`<home>/serve/devices.json`) until revoked.

The Gentle Shell GPUI desktop app is getting a client for this server: [gentle-shell-gpui#247](https://github.com/Gentleman-Programming/gentle-shell-gpui/issues/247).

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `421 bad_host` | The `Host` header does not name this server and port. A tunnel with a different local port (use the same port on both ends); a DNS name other than the hostname on `0.0.0.0` (use the IP, or `--allow-host <name>`); a loopback server addressed by another name. |
| `403 forbidden_origin` | The request carries an `Origin` other than `http://<Host>` (a web page on another origin, or a client adding one). Native clients and curl send no `Origin`. |
| `401 unauthorized` | No `Authorization: Bearer <token>`, a mistyped token, a revoked device, or a token paired with another home's server (devices are per home). Pair again. |
| `403 forbidden` | The token lacks the scope (for example `sessions:read` only, or an `admin` endpoint). Pair with `serve pair --scope …`. |
| `403 invalid_code` | The code is mistyped, expired (5 minutes), already used (the first attempt consumes it), or was minted by another home's server. Mint a new one. After 10 failures in a minute pairing answers `429 rate_limited` until the minute ends. |
| `could not start: listen EADDRINUSE` | Something else listens on the port: `ss -ltnp 'sport = :8787'`. Pick another port or stop it. `already running at …` means this home's server already runs (`serve status`). |
| `serve status` says not running but `<home>/serve/server.json` exists | A server that was killed (or a reboot) left it; it is ignored and the next start takes it over. Only if a reused pid makes `status` report a server that does not answer, confirm nothing listens (`ss -ltnp`) and remove `<home>/serve/server.json` and `server.lock`. |
| `Connection refused` from the Mac | The server listens on loopback (use the tunnel, or `--listen 0.0.0.0:8787`), the firewall drops the port, or the server is not running. |
| The app does not find the computer from the short code | The two computers are not on the same network segment (another subnet or VLAN, a guest Wi-Fi with client isolation, a VPN or tailnet), or the firewall drops UDP on the port (`sudo ufw allow 8787` opens TCP and UDP). Paste the long `gsc1.…` code instead, which `share` prints under the short one. `share` notes when the server could not open its UDP port at all. |
| `gentle-shell serve` opens a chat | That is the installed release, which has no `serve`; use the checkout (`gsdev serve`). |

## Not done yet

- **WebSocket.** The RFC proposes one WebSocket per client with `hello`/`welcome` negotiation and `session/subscribe`. This phase uses HTTP + SSE instead, which needs no dependency (Gentle Shell ships one runtime dependency) and works from browsers, phones and curl. The contract — per-session `seq`, replay window, `snapshot-required`, dialog replay, per-request scopes, tickets for streams — is transport-independent, so a WebSocket transport can be added later behind it.
- **Native Desktop RPC frames.** Desktop RPC still travels as `/gentle:desktop` prompts and `setWidget` records inside each session; `/desktop` only correlates them.
- **Idle unload and crash resume.** Sessions run until stopped; a restarted server does not resume the previous run's sessions (start them again with `sessionId`).
- **`message_update` coalescing.** Slow clients are dropped into a resync instead.
- **Files** (`fs/list`, `fs/read`, `fs/stat`) and the `terminal`, `fs:read`, `fs:write` scopes.
- **Persistent terminals** (Phase 2), **SSH bootstrap and TLS** (Phase 3), **the mobile web client, QR codes and a relay** (Phase 4).
