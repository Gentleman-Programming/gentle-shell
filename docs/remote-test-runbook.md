# Runbook: Gentle Shell server on Omarchy for a remote test

You are a coding agent with a shell on the user's Omarchy PC (Arch Linux, x86_64, Hyprland). Your job: run the **server side** of Gentle Shell's remote use from the pull-request branches, so the user can connect from his Mac with Gentle Shell GPUI, and check the server while he tests. Follow the steps in order. Reference: `~/src/gentle-shell/docs/serve.md` (section "Try it from source on Linux") once the checkout exists.

Branches under test:

- Gentle Shell (server): `feat/serve-phase1` of https://github.com/ismaelosuna7824/gentle-shell (PR Gentleman-Programming/gentle-shell#3529)
- Gentle Shell GPUI (terminal host here, app on the Mac): `feat/remote-serve-backend` of https://github.com/Gentleman-Programming/gentle-shell-gpui (PR #255)

## 1. Safety rules

1. **Do not modify the installed Gentle Shell.** Never run `gentle-shell setup`, `gentle-shell upgrade`, `self-uninstall`, `npm install -g gentle-shell` or anything that rewrites `~/.gentle-shell/bin`, `~/.gentle-shell/config.json` or the installed packages. All commands here use the checkout through the `gsdev` function (step 3). The installed `gentle-shell serve` would only send "serve" as a prompt to a model: never run it.
2. **Agent home: reuse the real one** (the user wants his real providers and sign-ins). Use exactly the home selector he uses day to day (none, or `--link`, or `--home <dir>`); ask him if unsure. `gsdev` sets `GENTLE_SHELL_NO_AUTO_SETUP=1`, so the checkout never re-runs setup in that home.
3. **What the server writes:** only `<home>/serve/` (`server.json`, `server-id`, `server.lock`, `devices.json`, `server.log`, `tls/`, `sessions/`, `uploads/`, `term/`, `term.sock`, `terminals.json`, `bin/`, `relay-secret`). Sessions the user starts from the Mac are ordinary Gentle Shell launches in that home: they write its sessions like any launch, and the Mac's Configuration screen (model defaults, `models.json`, MCP servers, packages, setup, sign-in) changes that home **on purpose** — that is what he is testing. You do not edit anything outside `<home>/serve/` yourself, except `~/src/` (checkouts) and, only with `--always`, `~/.config/systemd/user/gentle-shell-serve.service`.
4. **No `sudo` without telling the user first** and getting his OK (firewall rules, pacman, `loginctl enable-linger`). Show the exact command.
5. **Never print secrets:** not the `adminToken` from `server.json`, not device tokens (`gss_…`), not `auth.json`, not `relay-secret`, not the TLS key in `<home>/serve/tls/`. Read the admin token into a shell variable only (step 8), never `cat server.json`. Use `jq 'del(.adminToken)'` to show it.
6. **No model turns:** never send a `prompt` RPC or `POST /api/print` yourself; the user drives agents from the Mac.
7. Do not touch the user's open apps, windows or other projects.

## 2. Prerequisites check

```sh
uname -m                         # x86_64
node --version                   # v22.19+ or v23.6+ (v25+: see below)
corepack --version               # any version; "command not found" on Node 25+: sudo npm install -g corepack (ask first)
git --version
jq --version                     # used below; else: sudo pacman -S --needed jq (ask first)
command -v gentle-shell && gentle-shell --version   # the installed one; note its "home" line
sudo ufw status                  # ask first; "Status: active" on Omarchy
ss -ltnup | grep -E ':(87(8[7-9]|9[0-6])|88[0-9][0-9])\b' || echo "ports free"
```

Expected: Node satisfying `^22.19.0 || >=23.6.0`; ports 8787-8796 and 8800-8899 free (if one is taken, `share` uses the next free one; note which). Missing Node: `sudo pacman -S --needed nodejs npm` (ask first).

## 3. Install the checkout

```sh
mkdir -p ~/src
git clone -b feat/serve-phase1 https://github.com/ismaelosuna7824/gentle-shell.git ~/src/gentle-shell
cd ~/src/gentle-shell && corepack pnpm install
gsdev() { GENTLE_SHELL_NO_AUTO_SETUP=1 node ~/src/gentle-shell/bin/gentle-shell.mjs "$@"; }
gsdev --version
```

`gsdev` lives only in your shell; redefine it in every new shell. If the user uses a home selector, put it right after `gsdev` in **every** command (e.g. `gsdev --link serve share`). Check that the `home` line of `gsdev --version` equals that of `gentle-shell --version` (the installed one). Set it for later steps:

```sh
AGENT_HOME=~/.gentle-shell/agent     # replace with the home line printed by 'gsdev --version'
```

If the user wants to open Gentle Tower from the Mac (optional):

```sh
cd ~/src/gentle-shell && corepack pnpm run build:tower
```

Already cloned? `cd ~/src/gentle-shell && git fetch && git switch feat/serve-phase1 && git pull --ff-only && corepack pnpm install`.

## 4. Build the terminal host

Terminals from the Mac need `gentle-term-host` here.

```sh
command -v cargo || { echo "need rustup"; }      # if missing: sudo pacman -S --needed rustup base-devel (ask), then: rustup default stable
git clone -b feat/remote-serve-backend https://github.com/Gentleman-Programming/gentle-shell-gpui ~/src/gentle-shell-gpui
cd ~/src/gentle-shell-gpui && cargo build --release -p gentle-term-host
install -d -m 700 "$AGENT_HOME/serve" "$AGENT_HOME/serve/bin"
install -m 755 target/release/gentle-term-host "$AGENT_HOME/serve/bin/"
"$AGENT_HOME/serve/bin/gentle-term-host" --version 2>/dev/null || ls -l "$AGENT_HOME/serve/bin/gentle-term-host"
```

`<home>/serve/bin/` is found by the server and by the `--always` unit (`GENTLE_TERM_HOST` also works, but the unit does not carry it).

## 5. Start the server

```sh
gsdev serve share
```

Expected output (port may differ):

```text
Started the Gentle Shell server for your network on port 8787.

  Code: XXXX-XXXX

In Gentle Shell GPUI → Configuration → Where agents run → Gentle Shell server, enter this code. Valid for 5 minutes, once.
If the app can't find this computer, paste this instead:
gsc1.…
It uses HTTPS; the app checks this computer's certificate, fingerprint ….
If the app cannot find or reach this computer, …: sudo ufw allow 8787 && sudo ufw allow 8800:8899/tcp
```

If it says it exits because of running sessions, see Troubleshooting. Optional, only if the user asks for it to survive logout/reboot: `gsdev serve share --always` (systemd user unit `gentle-shell-serve.service`, `KillMode=process`; boot without login needs `sudo loginctl enable-linger $USER`, ask first). Each `serve share` run prints a fresh code; run it again whenever the user needs one (codes last 5 minutes, single use).

## 6. Firewall

Ask the user, then:

```sh
sudo ufw allow 8787              # TCP (HTTPS) + UDP (LAN discovery); use the port share printed
sudo ufw allow 8800:8899/tcp     # forwarded pages (dev servers, design canvas, Tower)
sudo ufw status | grep -E '8787|8800'
```

firewalld instead of ufw: `sudo firewall-cmd --permanent --add-port=8787/tcp --add-port=8787/udp --add-port=8800-8899/tcp && sudo firewall-cmd --reload`.

## 7. What to send the user

- The **short code** (`XXXX-XXXX`) and the time it was minted (valid 5 minutes, once).
- The **long `gsc1.…` code**, as one line, for when the Mac cannot find this PC (different subnet, VPN, relay).
- The certificate fingerprint (from `serve status`), so he can compare if the app shows it.
- This PC's LAN IP (`ip -4 -br addr`) for reference.

Never send: the `adminToken`, device tokens, `relay-secret`, anything from `tls/` or `auth.json`.

## 8. Verify on the server, alone

```sh
gsdev serve status                                        # URL, pid, "HTTPS on the network, certificate fingerprint …", sessions
jq 'del(.adminToken)' "$AGENT_HOME/serve/server.json"     # url http://127.0.0.1:<port>, listen 0.0.0.0:<port>, discovery true, forwardPorts 8800-8899
PORT=$(jq -r '.listen' "$AGENT_HOME/serve/server.json" | sed 's/.*://')
LANIP=$(ip -4 -br addr | awk '$1!="lo"{split($3,a,"/"); print a[1]; exit}')
curl -sk "https://$LANIP:$PORT/.well-known/gentle-shell" | jq .     # identity only (-k is fine here, nothing secret)
# (plain http to the LAN IP from this same PC is answered: a local peer; only other machines get 400 tls_required)
gsdev serve devices                                       # paired devices (after the user pairs: his Mac appears)
URL=$(jq -r .url "$AGENT_HOME/serve/server.json")
ADMIN=$(jq -r .adminToken "$AGENT_HOME/serve/server.json")         # never echo it
curl -s "$URL/api/sessions"  -H "Authorization: Bearer $ADMIN" | jq '.sessions[] | {id, state, cwd}'
curl -s "$URL/api/terminals" -H "Authorization: Bearer $ADMIN" | jq '.terminals[] | {id}'
curl -s "$URL/api/term-host" -H "Authorization: Bearer $ADMIN" | jq '{available, running, path, version}'
tail -n 50 "$AGENT_HOME/serve/server.log"                 # with --always instead: journalctl --user -u gentle-shell-serve -n 100 --no-pager
systemctl --user status gentle-shell-serve --no-pager     # only with --always
```

Expected: `available: true` for the term host (`running` becomes true once the Mac opens a terminal).

## 9. During the user's test on the Mac

Before a restart test, record ids:

```sh
curl -s "$URL/api/sessions"  -H "Authorization: Bearer $ADMIN" | jq -r '.sessions[] | "\(.id) \(.state)"' > /tmp/gs-before.txt
curl -s "$URL/api/terminals" -H "Authorization: Bearer $ADMIN" | jq -r '.terminals[].id' >> /tmp/gs-before.txt
```

Restart the server (sessions and terminals must survive):

```sh
gsdev serve stop && gsdev serve share            # background server; prints a new code (not needed: the Mac stays paired)
# with --always instead:
systemctl --user restart gentle-shell-serve
```

After it, re-read `URL`/`ADMIN` (the admin token changes every run), list again and compare with `diff /tmp/gs-before.txt <(…)` — same session ids (state `running`), same terminal ids. Tell the user when the restart is done so he checks that the Mac reattached. Also watch `server.log`/journal for errors while he tries files, git, uploads, terminals and forwards.

## 10. Relay test (only if the user asks)

Needs a machine both can reach (e.g. a VPS) with the same checkout and `gsdev`:

```sh
# on the relay machine:
gsdev relay --listen 0.0.0.0:7700       # prints where its secret file is (<its home>/relay/secret); open TCP 7700 there
# on this PC (the user passes the secret to you out of band; do not print it):
install -m 600 /dev/stdin "$AGENT_HOME/serve/relay-secret" <<< 'the-relay-secret'
gsdev serve share --relay gsr://<relay-host>:7700
gsdev serve status                      # "Relay gsr://…: connected"
```

Send the user the **long** code (it carries the relay); the short one works on the LAN only. If `share` refuses because sessions run, ask the user before `gsdev serve stop`.

## 11. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `421 bad_host` | Host header is not this server's IP/hostname:port. Use the IP, or restart with `gsdev serve --listen 0.0.0.0:8787 --allow-host <name>` (or keep `share` and use the IP). |
| `400 tls_required` | Something used plain `http://` from the network. Use `https://`; the app does by itself. |
| `401 unauthorized` | Token wrong, revoked, or from another home's server. Mac: re-pair with a fresh code. Your curl: re-read `ADMIN` (it changes each server run). |
| `403 forbidden` / `403 forbidden_origin` | Missing scope / a web page origin. Re-pair; native app sends no Origin. |
| `403 invalid_code` | Expired (5 min), used, mistyped, or minted by another home. Run `gsdev serve share` again. `429 rate_limited` after 10 failures: wait a minute. |
| Mac: "can't find this computer" | Not same subnet / client isolation / VPN, or UDP blocked. Check `sudo ufw status` shows 8787 (no `/tcp`), `jq .discovery server.json` is true. Send the long code. |
| Mac: connection refused / timeout | ufw (step 6), server not running (`serve status`), or listening on loopback only (`jq .listen` → `127.0.0.1:…`: `gsdev serve stop && gsdev serve share`). |
| `ports 8787-8796 are in use` / `EADDRINUSE` | `ss -ltnup 'sport = :8787'`; stop the other program or `gsdev serve share --port <n>` (and open that port). |
| `share` exits 1 about running sessions | It must restart the server (loopback→network, TLS/relay change, `--always`). Ask the user; then `gsdev serve stop` (sessions keep running and are reattached) and retry. |
| `serve status` not running but `server.json` exists | Stale from a kill/reboot; next start takes it over. Only if status reports a dead server: confirm nothing listens (`ss -ltnp`) and remove `$AGENT_HOME/serve/server.json` and `server.lock`. |
| `501 term_host_missing` / `available: false` | Step 4 not done or wrong home: check `ls -l $AGENT_HOME/serve/bin/gentle-term-host`. |
| Forwarded page doesn't load on the Mac | `sudo ufw allow 8800:8899/tcp`; `jq .forwardPorts server.json` must be 8800-8899 (else `serve stop` + `serve share`). `502`: nothing listens on that local port yet. |
| Tower: "web app is not built" | `cd ~/src/gentle-shell && corepack pnpm run build:tower`. |
| `gentle-shell serve` opened a chat | Installed release used by mistake; use `gsdev`. |
| Relay `not connected (retrying)` | Wrong host/port, relay port closed, or `relay-secret` mismatch. |

## 12. Cleanup (when the user says the test is over)

```sh
gsdev serve stop --sessions              # stops the server and its sessions
gsdev serve share --off                  # only if --always was used: disables and removes the unit
systemctl --user daemon-reload
pkill -u "$USER" -x gentle-term-host     # terminals outlive the server; ask the user first (it closes his remote terminals)
sudo ufw delete allow 8787 && sudo ufw delete allow 8800:8899/tcp       # ask first
sudo loginctl disable-linger $USER       # only if you enabled it; ask first
```

Folders: to forget the test completely, remove `$AGENT_HOME/serve/` (paired devices, server identity, certificate, uploads, term host binary) — ask first; keeping it lets the Mac reconnect later without re-pairing. `~/src/gentle-shell` and `~/src/gentle-shell-gpui` can be deleted. Do **not** delete anything else in the agent home (sessions, `auth.json`, settings are the user's).

---

## Mac side (for the user)

Build and run the PR app as a separate copy, next to the installed app, with real Gentle Shell sign-ins but its own window/settings:

```sh
git clone -b feat/remote-serve-backend https://github.com/Gentleman-Programming/gentle-shell-gpui ~/src/gentle-shell-gpui
cd ~/src/gentle-shell-gpui
cargo build --release -p gentle-shell-gpui
sandbox="$(mktemp -d)"
cp "$HOME/Library/Application Support/gentle-shell-gpui/settings.json" "$sandbox/"   # optional: theme, skips the welcome screen
GENTLE_SHELL_GPUI_DATA_DIR="$sandbox" ./target/release/gentle-shell-gpui "$(mktemp -d)"
```

(`cargo run --release -p gentle-shell-gpui` works too with the same variable. A `.app` bundle: `packaging/macos/bundle.sh aarch64-apple-darwin <version>` builds `dist/Gentle Shell.app` — don't copy it over the installed app.) Without `GENTLE_SHELL_GPUI_DATA_DIR` the build would hand off to the running installed app.

Enter the code in **Configuration → Where agents run → Gentle Shell server** (short code first; the long `gsc1.…` code if not found).

Checklist:

- [ ] Pairing with the short code; then with the long code (fresh `serve share`).
- [ ] Files: browse, open, edit, save; Changes view; Branches (switch, create).
- [ ] Upload a file to the server; download one.
- [ ] Agent session: start, follow, stop (a real prompt with a real provider is yours to send).
- [ ] Terminal: open, type, resize, close; reopen app and find it again.
- [ ] Server restart (agent on Omarchy restarts it): agent session and terminal reattach, nothing lost.
- [ ] App relaunch: sessions and terminals reattach.
- [ ] Forwarded page: a dev server / design canvas / Gentle Tower opened from the Mac.
- [ ] Configuration on the server: model defaults; custom models (`models.json`) — the save notice appears only on its own card, not under MCP servers; MCP servers; packages; setup; sign-in with a real provider.
- [ ] Re-pair (pair again: replaces the earlier pairing, one entry in `serve devices`) and unpair (device disappears from `serve devices`).
- [ ] Relay: from another network with the long code.
