# Keep Engram available after a Homebrew upgrade

For Linux users who manage Engram with Homebrew. This is a precaution, not a fix: the cause of the reported post-upgrade memory outages is still unknown. It covers only what is specific to Homebrew. How Shell decides whether it may use memory at startup is documented in [Engram startup safety](bundled-install.md#engram-startup-safety).

## Why a Homebrew upgrade may not reach Shell

- `brew upgrade` replaces the `engram` executable on disk. It does not replace an Engram server that is already running.
- Gentle Shell does not run the `engram` on your `PATH`. It reuses whatever server answers on `127.0.0.1:7437`, and when nothing listens it starts its own bundled core from `~/.gentle-shell/runtime/engram-<version>/`, not Homebrew's.

So after an upgrade, Shell can still be talking to the old Homebrew server, or to its bundled core, while `engram version` in your terminal shows the new one.

## 1. Check which Engram server Shell uses

Run these in a terminal outside Shell:

```bash
brew list --versions gentleman-programming/tap/engram
readlink -f "$(brew --prefix gentleman-programming/tap/engram)/bin/engram"
curl --noproxy '*' --fail --silent --show-error --max-time 3 http://127.0.0.1:7437/health
curl --noproxy '*' --fail --silent --show-error --max-time 3 http://127.0.0.1:7437/compatibility
```

The first two show the Homebrew version and the path of its executable. The `version` in the `/health` answer is the version of the server actually running. Shell reuses that server only when its `/compatibility` answer meets the [complete reuse contract](bundled-install.md#compatible-reuse-and-authorization), which includes `"status":"ready"` and `"active_reuse_authorized":true` among other fields; any other answer from a listening server means Shell disables memory for that launch. If the request fails because nothing listens on the port, Shell starts its bundled core on the next launch only when its [startup safety checks](bundled-install.md#decision) pass; a missing or unverified core keeps memory disabled, and so usually does a store migrated by a newer Engram (see the header tripwire limits in step 2).

To see which executable that server runs from, find the process listening on the port:

```bash
ss -ltnpH 'sport = :7437'
```

If several lines appear, use the one whose local address accepts connections to `127.0.0.1`: `127.0.0.1:7437`, `0.0.0.0:7437` or `*:7437`. Ignore listeners on other addresses such as `127.0.0.2:7437`.

- No output: nothing is listening.
- A line with `pid=<number>`: run `readlink /proc/<number>/exe` to print its executable.
- A line without `pid=`: the server belongs to another user, so its PID is hidden from you. Run `sudo ss -ltnpH 'sport = :7437'` and `sudo readlink /proc/<number>/exe` instead.

Use `readlink` without `-f`: if the upgrade removed the old executable, `-f` fails instead of printing the path with `(deleted)`.

| Server executable | Meaning |
|---|---|
| The Homebrew path from above, and `/compatibility` is ready | Shell uses your upgraded Homebrew Engram. |
| The Homebrew path from above, but `/compatibility` is not ready | The upgraded server runs, but Shell does not reuse it and memory stays disabled ([Compatible reuse](bundled-install.md#compatible-reuse-and-authorization)). |
| A different Homebrew `Cellar/engram/<version>` path, or a path ending in `(deleted)` | The server started before the upgrade is still running the old version. |
| `~/.gentle-shell/runtime/engram-<version>/engram` | Shell started its bundled core. The Homebrew upgrade does not affect it. |
| Nothing listening | Shell starts its bundled core on the next launch. |

Also run `env | grep '^ENGRAM_'`. If you set `ENGRAM_BIN`, `ENGRAM_URL`, `ENGRAM_PORT`, `ENGRAM_SOCKET`, `ENGRAM_DATA_DIR`, `ENGRAM_DATABASE_URL` or `ENGRAM_SERVER_MODE` to a non-blank value, or an invalid `ENGRAM_STARTUP_POLICY`, Shell does not probe or reuse the default server, and memory stays disabled ([decision table](bundled-install.md#decision)). Other `ENGRAM_*` settings do not change this decision.

## 2. Upgrade and restart with care

Before the upgrade, close Shell and every other Engram client, and make a verified backup of your Engram data using the procedure your Engram version supports. Backups can contain private memories: keep them out of repositories and bug reports.

Upgrade only the Engram formula, not every formula:

```bash
brew update
brew upgrade --formula gentleman-programming/tap/engram
```

Then restart the server the same way it was started. Call the Homebrew executable by its path, because another `engram` earlier on your `PATH` would run instead:

```bash
brew_engram="$(brew --prefix gentleman-programming/tap/engram)/bin/engram"
```

Use `"$brew_engram" restart` for a daemon (`"$brew_engram" ps` lists it), your service manager for a service, or a new `"$brew_engram" serve` for a server you run by hand. Do not start a second server next to the old one. Run step 1 again: for a Homebrew server, the `/health` version should match the Homebrew version and the executable path should be the new one. If you keep Shell's bundled core instead (below), skip that match; step 1 only confirms which server is in use.

If the server was Shell's bundled core and you want the Homebrew Engram to serve instead, stop that server and start Homebrew's yourself with `"$brew_engram" serve`. Shell reuses it on the next launch only when its `/compatibility` answer is ready and none of the settings listed in step 1 is set; otherwise memory stays disabled for that launch. A newer Engram may migrate the store. Do not go back to an older Engram on a migrated store. Shell's [header tripwire](bundled-install.md#decision) usually stops it from starting its older bundled core on such a store, but it only reads the database header, which can miss a migration (for example before a WAL checkpoint), so do not rely on it.

## 3. Verify memory in a new Shell session

Sessions keep the memory decision made when they started, so open a new interactive Gentle Shell session after the restart.

1. Startup must not show an `Engram memory disabled` notice. If it does, follow [Recovery and setup](bundled-install.md#recovery-and-setup).
2. Ask the agent to run `echo "$ENGRAM_URL"` in its shell. If you did not set `ENGRAM_URL` yourself (step 1), `http://127.0.0.1:7437` means Shell verified the shared server and uses it, and an empty value means memory is disabled for this session. A value you set yourself proves nothing: Shell keeps it even when it disables memory.
3. Ask the agent to search memory for something you know is stored, for example a recent project decision. A result, or an empty result without an error, shows the memory tools reach the server.

If any of these fail, stop. Keep the backup, do not delete the store or bypass the memory guard, and do not run the upgrade again. When you report the problem, include your Linux distribution, the Homebrew version and the `/health` version (not the whole answer), the server executable path from step 1, and the exact startup notice, without tokens, memory contents or environment dumps.
