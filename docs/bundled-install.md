# Bundled install

Gentle Shell installs as one self-contained product. It carries its own pinned Node (with the npm in the same archive) and pnpm, and Go only when a build needs it. Pi is pinned with each Gentle Shell release. The user's own `node`, `npm`, `pnpm` and `go` are never run, read or changed.

The building blocks live in `scripts/bundled-install.mjs`. The web installer and `gentle-shell upgrade` share them. The web installer uses them for a new installation of the release channel ([bundled installation](install-wizard.md#bundled-installation)); `gentle-shell upgrade` does not yet.

## Layout

| Path (POSIX) | Contents |
|---|---|
| `~/.gentle-shell/agent/` | The isolated agent home. This module never writes it. |
| `~/.gentle-shell/runtime/node-24.21.0/` | Our Node from the verified archive: `bin/node`, the npm bundled with it under `lib/node_modules/npm`, and our own `bin/npm` and `bin/npx` wrappers. |
| `~/.gentle-shell/npm/{prefix,cache}/`, `~/.gentle-shell/npm/npmrc` | npm's global prefix, cache and global config. The global config file is never written. |
| `~/.gentle-shell/runtime/pnpm-11.1.1/package/` | Our pnpm, from the verified registry tarball. |
| `~/.gentle-shell/runtime/go/1.25.14/go/` | Our Go, only when asked (`acquireGo` layout). |
| `~/.gentle-shell/pnpm/{store,cache,state,config}/` | Every folder pnpm writes. |
| `~/.gentle-shell/versions/<shell>-<pi>/` | One frozen install per release. |
| `~/.gentle-shell/current` | Symlink to `versions/<id>`, switched with one rename. |
| `~/.gentle-shell/versions.history` | Activation order, newest first, for `keep 2`. |
| `~/.gentle-shell/bin/gentle-shell` | The launcher. |

On Windows the same layout lives under a private folder. The module tries `%LOCALAPPDATA%\gentle-shell` first. It falls back to `%USERPROFILE%\.gentle-shell-bundle` only when an untrusted owner or ACL rejects the first folder, the same rule the bootstrap uses for its tools. The folder is claimed with the bootstrap's protected DACL and marked with `.gentle-shell-bundle` (`ensureWindowsPrivateFolder`). `current` is a pointer file holding the version id. The launcher is `bin\gentle-shell.cmd`, and `tmp\` holds TEMP and TMP for pnpm's children. The agent home stays at `%USERPROFILE%\.gentle-shell\agent`.

## Ownership rules

- **Runtimes.** Each one is downloaded through `verifiedDownload` (the existing pins and hashes), written to a staging folder and run once to check its version. It is then marked with `.gentle-shell-runtime` and published with one rename. A marked runtime is reused. An unmarked folder is never replaced. Renaming is safe here because the extracted trees hold only regular files and folders, never links. The pnpm tarball's executable bits (`bin/pnpm.mjs`, `dist/node-gyp-bin/node-gyp`) are kept, for the owner only.
- **Versions.** Each version is installed in place, in its final `versions/<shell>-<pi>/` folder, and that folder is never renamed afterwards. On Windows, when symlinks are not allowed, pnpm links packages with junctions to absolute paths, so a renamed folder would leave every link dangling. The folder is claimed with `mkdir`, and its `.gentle-shell-version` marker first reads `installing <id> <pid>`. After pnpm runs, the installed `gentle-pi` and Pi versions must match the manifest exactly. Only then is the marker replaced, with one rename, by `<id>`. Only that final marker makes the version valid.
- **Interrupted installs.** A folder whose marker is `installing <id> <pid>` for this id, and whose process is gone, is removed and installed again. A live process stops the install. Anything else at that path is never replaced. A failed install removes the folder it claimed.
- **Go on Windows.** `installVersion` refuses to run on Windows without the pinned Go under `runtime/go`. gentle-pi's postinstall builds Gentle AI with the first `go.exe` on PATH, which must never be the user's.
- **`current`.** Only our own symlink or pointer file is switched. Anything else at that path stops the switch.
- **Pruning.** `pruneVersions(layout, 2)` keeps the active version and the most recently activated other one. It deletes nothing unless `current` names an installed version. It never deletes the active version, an unfinished install, or a folder without our marker.
- **Launcher.** Only a launcher that carries our generated marker line is refreshed. Any other file there is never replaced. The launcher passes every argument and the exit code through. When no active version exists, it prints `gentle-shell: no active Gentle Shell version; run the Gentle Shell installer again.` and exits 1. The Windows `.cmd` runs with delayed expansion off, so `!`, `%`, `^`, `&`, `(` and `,` in the prefix path stay literal.

## pnpm environment

`pnpmEnvironment(layout)` builds the environment for our pnpm and the scripts it runs. It was checked against the pnpm 11.1.1 sources, where `config/reader` reads `pnpm_config_*` variables, the XDG folders, and `npmrc_auth_file` in place of `~/.npmrc`.

| Setting | Value |
|---|---|
| `PATH` | Our Node's folder first, then our Go's when given. pnpm runs lifecycle scripts with the `node` found on `PATH` (`scripts-prepend-node-path` is false). |
| `PNPM_HOME` | `pnpm/` |
| `pnpm_config_store_dir`, `pnpm_config_cache_dir`, `pnpm_config_state_dir` | `pnpm/store`, `pnpm/cache`, `pnpm/state` |
| `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` | `pnpm/config`, `pnpm/cache`, `pnpm/state`. pnpm reads its global `config.yaml` and `auth.ini` only from the config folder. |
| `pnpm_config_npmrc_auth_file` | `pnpm/config/npmrc`, read in place of the user's `~/.npmrc`. It is empty until the installer copies the user's network, registry and authentication keys into it ([User npm settings](#user-npm-settings)). |
| `pnpm_config_pm_on_fail` | `ignore`. Its default, `download`, makes pnpm switch to the pnpm that a `packageManager` field in a `package.json` above the folder names. Observed: `pnpm --version` under such a folder printed 9.0.0 instead of 11.1.1. |
| `pnpm_config_runtime_on_fail` | `ignore`, so a root manifest never makes pnpm download another Node. |
| `pnpm_config_update_notifier` | `false` |
| `TEMP`, `TMP` (Windows) | `tmp\` |

Every inherited `npm_*`, `pnpm_*` (including `PNPM_HOME`), `COREPACK_*`, `NODE_OPTIONS`, `NODE_PATH` and XDG folder variable is dropped. The exception is a variable the prefix npmrc names as `${NAME}`, such as `NPM_TOKEN`: pnpm expands it, so it is kept. Everything else, such as `HOME`, proxies and `SystemRoot`, is kept.

## Distribution and lockfile

`distributionFiles(manifest)` returns the exact project that the release lockfile is resolved from and installed with:

- `package.json` pins `gentle-pi` and `@earendil-works/pi-coding-agent` exactly.
- `pnpm-workspace.yaml` sets `allowBuilds: { gentle-pi: true }` and `strictDepBuilds: false`.

These settings mean:

- **Only gentle-pi's build scripts run.** This matches today's `--allow-build=gentle-pi`. That flag belongs to `pnpm add` only; for `pnpm install` the allowlist lives in `pnpm-workspace.yaml`.
- **Other build scripts are skipped, not fatal.** Pi's tree has build scripts (`@google/genai`, `koffi`, `protobufjs`), and pnpm 11 fails on ignored builds by default.
- **The parent folders are ignored.** The workspace file also stops pnpm's upward search, so a `pnpm-workspace.yaml` or `.npmrc` in a parent folder never applies.

`installVersion` then runs `node pnpm.mjs install --frozen-lockfile` in the version folder.

After an install that skips build scripts, pnpm 11 rewrites `pnpm-workspace.yaml` in place. It adds each skipped package under `allowBuilds` with the placeholder value `set this to true or false`. The release lockfile is therefore resolved from the unmodified `distributionFiles()` output. It never comes from a `pnpm-workspace.yaml` read back from a folder pnpm already installed into.

## Release distribution assets

Each release publishes two assets with stable names. `scripts/build-distribution.mjs` builds and verifies them.

| Asset | Contents |
|---|---|
| `gentle-shell-distribution.json` | `schema` (1), `shell` (gentle-pi), `pi`, `id` (`<shell>-<pi>`), `generatedWith` (our Node and pnpm pins), `files` (the exact `package.json` and `pnpm-workspace.yaml` that `installVersion` writes) and `lockfile` (`name` and `sha256`). |
| `gentle-shell-distribution-lock.yaml` | The `pnpm-lock.yaml` for those files. |

- **Exact versions.** `shell` is the release version. `pi` is `PI_INSTALL_VERSION` from `scripts/installer-preflight.mjs`, the one Pi pin. A range, a tag such as `latest`, a `v` prefix or build metadata is refused before pnpm runs.
- **Resolution.** `buildDistribution` writes `distributionFiles()` into a fresh folder under the prefix's `tmp/` and runs our pinned pnpm with `install --lockfile-only` in `pnpmEnvironment(layout)`, the environment `installVersion` uses. Only `pnpm-lock.yaml` is read back.
- **Just published.** The registry may not list `gentle-pi@<version>` for a few minutes after `npm publish`. When pnpm reports `ERR_PNPM_NO_MATCHING_VERSION` for exactly that gentle-pi (pnpm prints it on stdout), the resolution is retried in a fresh folder: 10 attempts, 30 seconds apart, about five minutes in all. It then fails with `gentle-pi@<version> is not on the registry after 10 attempts`. Any other failure, including a missing Pi, stops at once.
- **Deterministic.** `distributionAsset(manifest, lockfile)` is plain data in a fixed order, so the same inputs give the same bytes. The lockfile itself records the registry at resolution time, which is why it is built once per release and then only installed.
- **Reading.** `readDistribution(json, lockfile)` returns `{ manifest, lockfile }` only when the versions are exact, the lockfile matches the recorded `sha256`, and `files` equals what this module's `installVersion` writes. `generatedWith` is recorded and not compared.

### One lockfile for every system

pnpm resolves every optional dependency into the lockfile, with its `os`, `cpu` and `libc` fields, whatever system resolves it. Only the install skips the packages for other systems. So no `supportedArchitectures` setting is needed, and none is set.

Observed with pnpm 11.1.1 for gentle-pi 4.0.0 and Pi 1.0.0:

- A lockfile resolved on macOS arm64 lists every `@yuuang/ffi-rs-*`, `@ff-labs/fff-bin-*` and `@esbuild/*` variant for Linux (gnu and musl), Windows and macOS.
- A `--frozen-lockfile` install of that lockfile on macOS with `supportedArchitectures` forced to Linux and Windows installed the Linux and Windows variants. The lockfile was left unchanged.
- The regular frozen install on macOS installed only the darwin-arm64 variants.

### Minimum release age

pnpm 11.1.1 defaults `minimum-release-age` to 1440 minutes (one day), in non-strict mode. The default is kept on purpose, and no value is set:

- **Ranged dependencies.** For a ranged transitive dependency, pnpm picks the highest matching version that is at least one day old. A version published minutes before a release does not enter the lockfile. This is a supply-chain guard.
- **Exact pins.** gentle-pi and Pi are exact. In non-strict mode, when no matching version is old enough, pnpm falls back to the matching version anyway (`pickRespectingMinReleaseAge`). So a gentle-pi published minutes ago still resolves.
- **Never set it explicitly.** pnpm 11.1.1 turns `minimumReleaseAgeStrict` on whenever `minimumReleaseAge` is set explicitly and the strict flag is not. A strict check would refuse the gentle-pi the release just published.

Observed with pnpm 11.1.1:

- `pnpm_config_minimum_release_age=5256000` alone failed.
- The same value with `pnpm_config_minimum_release_age_strict=false` resolved gentle-pi 4.0.0 exactly.
- The default resolved it too.

`pnpmEnvironment` drops every inherited `pnpm_*` variable, so a host setting cannot change this.

### Release workflow

`.github/workflows/publish.yml` runs three jobs after `publish`, because `gentle-pi@<version>` must resolve from npm first:

1. **`distribution`** checks out the verified release commit. It runs `build-distribution.mjs build --shell <tag without v> --out <dir>` with our pinned Node and pnpm in a temporary prefix, and keeps both files as a workflow artifact.
2. **`distribution-verify`** runs on `ubuntu-latest`, `macos-latest` and `windows-latest`. It runs `build-distribution.mjs verify --assets <dir>`, which:
   - downloads our pinned Node and pnpm into a temporary prefix (with Go on Windows);
   - installs the exact pair with `installVersion` (`--frozen-lockfile`);
   - switches `current` and writes the launcher;
   - requires `gentle-shell --version` to report exactly `gentle-shell <shell>` and `pi <pi>`.

   On Windows a fresh temporary folder stands in for the private-folder claim, which has its own native tests. The launcher runs in `pnpmEnvironment`, the environment our pnpm ran in, without any `PI_*` or `GENTLE_*` variable. So no host `NODE_OPTIONS`, `NODE_PATH`, npm or pnpm setting, or Pi override reaches it.
3. **`distribution-assets`** runs only after every verify lane passed. It attaches both files to the release with `gh release upload --clobber`.

Both `build` and `verify` create their temporary prefix (`gsd-*` in the system temporary folder) only after their arguments are accepted. They always remove it, whether the command succeeded or failed.

The release gets the same bytes that the three systems installed.

## npm for Pi

pnpm 11 runs on Node alone: `bin/pnpm.mjs`, with `node-gyp` bundled in its `dist/`. Pi needs npm, though. Pi 1.1.0's package manager runs `npm install <spec> --prefix <agent dir>/npm`, and `gentle-shell setup` runs `pi install npm:<package>` through Gentle AI.

So `nodeRuntimeFiles` takes the npm bundled in the same verified Node archive (npm 11.19.0 for Node 24.21.0):

- **POSIX.** `lib/node_modules/npm/`, plus our own `bin/npm` and `bin/npx`. These are small sh wrappers that run our `node` with npm's entry, in place of the archive's links.
- **Windows.** `node_modules\npm\` with `npm.cmd` and `npx.cmd`. These run the `node.exe` next to them.
- **Skipped.** Links, Corepack and every other member. A member that would leave its folder, or an archive without npm, is rejected.

`ensureRuntime` runs `npm-cli.js --version` with our Node from the staging folder. It must print the version in npm's own `package.json`.

## User npm settings

`userNpmrc` reads the user's npm configuration: `NPM_CONFIG_USERCONFIG` (any case) when it is an absolute path, otherwise `~/.npmrc`. It reads at most 1 MiB.

`filterNpmrc` keeps only these keys (S12):

- `registry` and `@scope:registry`;
- per host: `//host/:_authToken`, `_auth`, `username`, `_password`, `certfile` and `keyfile`;
- `proxy`, `https-proxy`, `noproxy` and `no-proxy`;
- `ca` (and `ca[]`), `cafile` and `strict-ssl`.

Each kept line is copied verbatim, so `${VAR}` references stay for pnpm and npm to expand. Comments, CRLF line ends and quoted keys are handled. Every other key is dropped, and so is everything from the first `[section]` on: an ini section never applies at the top level. The frozen lockfile still pins every version and integrity hash, so these keys cannot change what is installed.

`writeNpmrcAuth` writes the result to `pnpm/config/npmrc` with one rename, mode 0600. On Windows that file is inside the private folder.

## Setup environment

`setupEnvironment(layout, { platform, env, id })` is the environment `gentle-shell setup` runs in. Its PATH, in order:

1. Our Node's folder, which holds npm on POSIX and `npm.cmd` on Windows.
2. `versions/<id>/node_modules/.bin`, which holds the version's `pi`.
3. The user's PATH.

npm gets its settings inside the prefix:

- `npm_config_userconfig` is the filtered prefix npmrc.
- `npm_config_globalconfig`, `npm_config_prefix` and `npm_config_cache` point under `~/.gentle-shell/npm/`.
- `npm_config_update_notifier` is `false`.

The global prefix also keeps Windows' `npm.cmd` on our npm. That shim prefers an npm installed in the global prefix.

Dropped: inherited npm and pnpm settings, `NODE_OPTIONS`, `NODE_PATH`, and the wizard's `GENTLE_BOOTSTRAP_*` and `GENTLE_INSTALL_*` handoff. The user's XDG folders are kept, because Pi and Gentle AI read their own configuration through them.

`pnpmEnvironment` does not set npm's settings, because pnpm never runs npm. The release verification also requires its launcher environment to hold no `npm_config_prefix`.

## PATH

`pathEntryPlan` returns the single PATH change and does not apply it:

- **Symlink.** If `~/.local/bin` is on PATH, the plan is a `~/.local/bin/gentle-shell` symlink, when that name is free.
- **Profile line.** Otherwise the plan is one line ending in `# gentle-shell bundled install`, added to the file the user's shell reads:
  - `$ZDOTDIR/.zshrc` (or `~/.zshrc`) for zsh.
  - For bash on macOS, where terminals start login shells: the first of `~/.bash_profile`, `~/.bash_login` and `~/.profile` that exists. Login bash reads exactly one of them, in that order (`INVOCATION` in bash(1)). `~/.bash_profile` is created only when none exists, because creating it would hide the user's `~/.profile`.
  - For bash elsewhere: `~/.bashrc`, which interactive non-login shells (Linux terminals) read. Distributions' `~/.profile` sources it for login shells.
  - Our own `conf.d/gentle-shell.fish` for fish.
  - `~/.profile` otherwise.
- **Manual.** The installer edits that file only when it is a regular file this user can write and every folder above it under home is real. It may also create the file when it is absent and its folders are real and writable. A symlinked profile (stow, chezmoi, home-manager), a read-only one, anything that is not a file, or a file reached through a linked folder gets a `manual` plan instead. That plan carries the exact line to add, and nothing is written. When the file, even through a link, already holds the line, the plan is `none`, so the user is not asked twice.
- **Registry (Windows).** The plan is the `bin` entry in the HKCU user `Path`.

`applyPathEntry` applies only that change and returns a receipt. The receipt records whether a newline was added before our line and whether the file was created. `removePathEntry(receipt)` uses it to restore the file byte for byte, and deletes a file it created once nothing else is left in it. Self-uninstall (T6) must keep that receipt.

- **Safe appends.** The line goes in with `O_NOFOLLOW`. A profile that turned into a link after planning is refused.
- **Registry.** The registry change goes through an injected adapter.
- **No `pnpm setup`.** It is not used.

## Never touched

- The user's Node, npm, pnpm, Go, `PNPM_HOME`, `~/.npmrc` and npm or pnpm global configuration.
- Anything outside the prefix, except the single PATH change.
- Folders, files, launchers or `current` entries without our marker.
