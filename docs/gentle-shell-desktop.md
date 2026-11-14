# Gentle Shell Desktop

`gentle-shell desktop` opens Gentle Shell Desktop: [Herdr app](https://herdr.dev), unchanged, with
Gentle Shell's own `gentle-*` mods and its `gentle-shell` layout. Gentle Shell ships Herdr the way it
ships Pi: one pinned version, an exact download it checks, and its own files kept separate.

```
gentle-shell desktop [--yes] [--no-open]
gentle-shell desktop --status
gentle-shell desktop --uninstall
```

## What `gentle-shell desktop` does

1. **Herdr app.** It looks for `herdr-app` on your `PATH`, then in `~/.local/bin`, and reads
   `herdr-app --version`. Version 0.1.15 or newer is used as it is; we built and checked the mods
   against 0.1.15 (`HERDR_APP_VERSION` in `lib/gentle-shell-desktop.ts`). If Herdr app is missing
   or older, Gentle Shell installs exactly 0.1.15 (see below).
2. **Mods and layout.** It copies every `herdr/mods/gentle-*` folder of the running Gentle Shell
   package into `<herdr home>/mods/` and `herdr/layouts/gentle-shell.json` into
   `<herdr home>/layouts/`. The Herdr home is `$HERDR_APP_HOME`, else `$XDG_CONFIG_HOME/herdr-app`,
   else `~/.config/herdr-app` (Herdr's own rule). Herdr's generated `gpui-kit.d.ts`/`jsconfig.json`
   and our design notes are not copied.
   - The files are staged in `~/.gentle-shell/desktop/stage`, and every staged mod must pass
     `herdr-app check <staged mod>` first. If one fails, Gentle Shell prints the check output and
     stops: nothing in the Herdr home changes, so a running window never loads an unchecked mod.
   - Then each folder is swapped in. `~/.gentle-shell/desktop/state.json` records which paths are
     ours. Our own previous copy moves to `~/.gentle-shell/desktop/backup` (replaced each time).
   - Anything at one of those paths that Gentle Shell did not install (for example your own
     `mods/gentle-tabs` or `layouts/gentle-shell.json`) moves to `~/.gentle-shell/desktop/originals`.
     Later installs and upgrades never overwrite or delete it; `--uninstall` puts it back.
   - If a swap fails, every previous copy goes back and folders this install created are removed.
   - Only the mods this package ships and `layouts/gentle-shell.json` are written. Your other mods,
     layouts and settings are never touched.
3. **Window.** Gentle Shell starts Herdr app if its window is not open and runs
   `herdr-app do layout.switch {"name":"gentle-shell"}`. If no Gentle Shell terminal runs in the
   current folder yet, it also runs `space.new` with `{"folder": <cwd>, "argv": ["gentle-shell"]}`.
   `--no-open` installs only.

Before changing anything it prints exactly what it will install and where, then asks
`Install Gentle Shell Desktop as shown above? [y/N]`. `--yes` skips the question. Without a terminal
and without `--yes`, it refuses and writes nothing. When everything is already installed and current,
it opens Herdr without asking.

## How Herdr app is installed

Herdr's documented installer is `curl -fsSL https://releases.herdr.dev/app/install.sh | sh`
(<https://herdr.dev/download/>). That installer always takes the latest release from
`app/latest.json` and runs whatever script the server returns. Gentle Shell follows the same steps,
but for one pinned version, and it does not pipe a script into a shell:

- It downloads `https://releases.herdr.dev/app/0.1.15/herdr-app-<target>.tar.gz` (the versioned file
  the official installer downloads; `HERDR_RELEASES_URL` selects a mirror, as for Herdr itself).
- It refuses the file unless its SHA-256 equals the value pinned in Gentle Shell. The pins come from
  Herdr's immutable release manifest `https://releases.herdr.dev/app/0.1.15/manifest.json`.
- macOS (Apple silicon): the bundle must have a valid Developer ID signature
  (`codesign -dvv`, then `codesign --verify --deep --strict`), as the official installer requires for
  release builds. It becomes `~/Applications/Herdr.app`, with `~/.local/bin/herdr-app` linked to it.
- Linux (x86_64, arm64): it becomes `~/.local/share/herdr-app` (or `$XDG_DATA_HOME/herdr-app`), with
  `~/.local/bin/herdr-app` linked to it and a launcher entry, as the official installer does.
- Windows: Gentle Shell does not install Herdr app itself. It prints Herdr's official PowerShell
  installer command, `powershell -c "irm https://releases.herdr.dev/app/install.ps1 | iex"`; run it,
  then run `gentle-shell desktop` again.
- herdr-core, the terminal runtime, is not installed by Gentle Shell. Herdr app offers to set it up
  when it opens, and keeps it current after that.

Herdr app updates itself in the background after that; newer versions are accepted.

## `--status`, `--uninstall`, upgrades

- `--status` prints the Gentle Shell version, the Herdr app version and path, the Herdr home, whether
  the `gentle-shell` layout and each shipped mod are installed, and whether the window is running
  and which layout it shows.
- `--uninstall` moves only the mods and layout `state.json` records as ours into
  `~/.gentle-shell/desktop/backup`, puts back byte for byte what was at those paths before
  (`~/.gentle-shell/desktop/originals`), then switches Herdr back to the layout it showed before
  Gentle Shell switched it (or `main`) when ours is active. Without `state.json` it removes
  nothing. Herdr app itself stays installed.
- `gentle-shell upgrade` runs the new version's `gentle-shell desktop --refresh` afterwards, only
  when that version ships the `desktop` command and `gentle-shell desktop` installed the mods
  before (`~/.gentle-shell/desktop/state.json`). That reinstalls our mods and layout in the same
  safe way. It never installs Herdr app or opens the window. `upgrade --rollback` only switches the
  version and runs nothing else.

This works the same for every Gentle Shell install, bundled in `~/.gentle-shell` or the npm package.
The mods always come from the `herdr/` folder of the Gentle Shell that is running.
