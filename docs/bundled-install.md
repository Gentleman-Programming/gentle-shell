# Bundled install

Gentle Shell installs as one self-contained product. It carries its own pinned Node (with the npm in the same archive) and pnpm, and Go only when a build needs it. Pi is pinned with each Gentle Shell release. The user's own `node`, `npm`, `pnpm` and `go` are never run, read or changed.

The building blocks live in `scripts/bundled-install.mjs`. The web installer and `gentle-shell upgrade` share them. The web installer uses them for a new installation of the release channel ([bundled installation](install-wizard.md#bundled-installation)). The launcher and `gentle-shell upgrade` use them in a bundled install ([Launcher in a bundled install](#launcher-in-a-bundled-install)).

## Layout

| Path (POSIX) | Contents |
|---|---|
| `~/.gentle-shell/agent/` | The isolated agent home. This module never writes it. |
| `~/.gentle-shell/runtime/node-24.21.0/` | Our Node from the verified archive: `bin/node`, the npm bundled with it under `lib/node_modules/npm`, our own `bin/npm` and `bin/npx` wrappers, and `gentle-shell/npm`, the entry Pi's `npmCommand` runs. |
| `~/.gentle-shell/npm/{prefix,cache}/`, `~/.gentle-shell/npm/npmrc` | npm's global prefix, cache and global config. The global config file is never written. |
| `~/.gentle-shell/runtime/pnpm-11.1.1/package/` | Our pnpm, from the verified registry tarball. |
| `~/.gentle-shell/runtime/go/1.25.14/go/` | Our Go, only when asked (`acquireGo` layout). |
| `~/.gentle-shell/runtime/engram-3.3.2/engram` | Our Engram, from the verified GitHub release archive ([Isolation from the user's Gentle AI](#isolation-from-the-users-gentle-ai)). |
| `~/.gentle-shell/gentle-ai/` | Gentle AI's state, managed assets, backups and telemetry state (`GENTLE_AI_HOME`). |
| `~/.gentle-shell/config/gentle-ai/` | gentle-pi's config home in a bundled install (derived, never exported to Pi): profiles, preferences, persona, background subagents. |
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

`ensureNpmShim` then writes `runtime/node-<v>/gentle-shell/npm`, a CommonJS file that loads the npm next to it, and a `package.json` beside it with `"type": "commonjs"`. That `package.json` keeps the entry CommonJS even under a user's `package.json` with `"type": "module"` above the prefix. `ensureRuntime` writes the entry for a new runtime and for a reused one. The launcher also writes it before it sets `npmCommand`, for a runtime installed before the entry existed. Each file is replaced with one rename, and only when its content differs. A link or anything but a regular file in its place stops it. A runtime from before npm was published (T1a) gets no entry, and the launcher then gives Pi no `npmCommand` and says so.

Why the entry exists:

- **The name.** Pi 1.1.0 takes the package manager's name from the basenames in `npmCommand` (`getPackageManagerName`), and only strips `.cmd` and `.exe`. With `npm-cli.js` it read `node`, and gave a git extension's dependencies a plain `npm install`. With an entry named exactly `npm`, it reads `npm` and uses `install --omit=dev --legacy-peer-deps`.
- **No `npm.cmd`.** On Windows, `npm.cmd` prefers an npm in the global prefix, which is the user's under the user's environment. The entry never goes through it.

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

`setupEnvironment(layout, { platform, env, id })` is the environment the web installer runs `gentle-shell setup` in. The launcher itself then gives its children the user's environment ([Launcher in a bundled install](#launcher-in-a-bundled-install)). Its PATH, in order:

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

`applyPathEntry` applies only that change and returns a receipt. The receipt records whether a newline was added before our line and whether the file was created. `removePathEntry(receipt)` uses it to restore the file byte for byte, and deletes a file it created once nothing else is left in it. A receipt with `applied: false` (the line, the link or the Windows `Path` entry was already there) is never reverted.

- **Persisted receipt.** The `bundled-path` step (a new install and a migration alike) writes an applied receipt to `<prefix>/path-entry.json` with `writePathReceipt`: mode 0600, replaced with one rename, and only when something was applied, so an earlier receipt stays. When it cannot be written, the entry is taken back and the step fails. The file holds `schema: 1`, `kind` and that kind's fields: `path` and `target` for a link; `path`, `line`, `create` and `separator` for a profile line; `key`, `name` and `entry` for the user `Path`.
- **Reading it back.** `readPathReceipt(layout, { env, home })` accepts only what this prefix writes: `~/.local/bin/gentle-shell` linked to our launcher; our exact marked line for our `bin` in a startup file `pathEntryPlan` can choose for this user (`profileFiles`: `.zshrc` in `$ZDOTDIR` or home, the macOS bash login files or Linux `~/.bashrc`, the fish `conf.d` file under `$XDG_CONFIG_HOME` or `~/.config`, `~/.profile`), with the fish line only in the fish file; or our `bin` in `HKCU\Environment` `Path`. Anything else, a link or a malformed file is `invalid` and is never acted on: a receipt naming another file, even one that holds our exact line, is named for manual removal.

- **Safe appends.** The line goes in with `O_NOFOLLOW`. A profile that turned into a link after planning is refused.
- **Registry.** The registry change goes through an injected adapter.
- **No `pnpm setup`.** It is not used.

## Launcher in a bundled install

`bin/gentle-shell.mjs` runs in bundled mode only when it runs from a bundled install. Its real package root must be `versions/<id>/node_modules/gentle-pi` of a version whose `.gentle-shell-version` marker reads `<id>`, and `current` must name that version. `resolveBundledInstall` in `lib/gentle-shell-bundled.ts` decides this. Any other installation keeps the launcher's ordinary behavior, including a kept version that `current` does not name.

- **Exact Pi (S8).** The launcher runs only the Pi that the version's `package.json` pins: `versions/<id>/node_modules/@earendil-works/pi-coding-agent`, inside the version folder, with that exact version and Pi's `dist/bundle/cli.js` bin. `GENTLE_SHELL_PI`, an adjacent fallback and `PATH` are never used. A missing or different Pi stops with a message that names the version and the pinned Pi, and says to run `gentle-shell upgrade` or the installer again.
- **Child environment (S9).** Pi's bash tool passes its own environment to every command the agent runs in the user's projects. Pi and its subagents therefore get the user's environment unchanged: `PATH`, `NODE_OPTIONS` and `npm_config_*` stay the user's, so `git`, `gh`, `node` and `npm` there are the user's own. `bundledChildEnv` adds only Gentle Shell's own variables:
  - `GENTLE_SHELL_PI` is removed.
  - `GENTLE_PI_AGENTS_PI` is set to our node and the bundled `cli.js`, so subagents never run a `pi` from `PATH`. The subagent runner splits that variable on whitespace, so a path with a space leaves it unset. The runner then falls back to the running node and `cli.js`, which are the same pair.
  - `PI_SKIP_VERSION_CHECK=1`.
  - `GENTLE_SHELL_PREFIX` and `ENGRAM_BIN` ([Isolation from the user's Gentle AI](#isolation-from-the-users-gentle-ai)).
  - The launcher still sets the agent home variables (`PI_CODING_AGENT_DIR`, `GENTLE_PI_AGENT_HOME`) as always.

  Pi itself needs no `PATH` entry, because it is started as our node with the bundled `cli.js`.
- **Pi's own npm.** Pi runs npm through its `npmCommand` setting (`getNpmCommand` in Pi's `core/package-manager.js`). For a home Gentle Shell owns, the launcher sets that key in its `settings.json` to `bundledNpmCommand(layout)`: our node, our npm entry `runtime/node-<v>/gentle-shell/npm` ([npm for Pi](#npm-for-pi)), `--userconfig=<prefix npmrc>`, `--globalconfig` and `--cache` inside `~/.gentle-shell/npm/`, and `--update-notifier=false`. No other part's basename is `npm`, `pnpm` or `bun`, which Pi would reject as ambiguous. "Owns" means the isolated home, or a `--home` it created or provisioned. It never sets the key for `--link`, a foreign home, or the user's `~/.pi`.
  - Only that key is written, and only when it differs. A file that already holds the command keeps its bytes, and one that is not a JSON object is left alone with a warning. An earlier value (`npm-cli.js` directly, or a `--prefix` flag) is replaced the same way.
  - npm ranks command-line flags above `npm_config_*` variables, so the user's environment cannot redirect these three settings. An `npm_config_*` key that has no flag here (for example `npm_config_registry`) still reaches our npm, as the user's own network setting would.
  - **No `--prefix`.** A `--prefix` flag on the command line also sets npm's local prefix (`loadLocalPrefix` in `@npmcli/config`). Pi installs a git extension's dependencies with `npm install` in the clone and passes no `--prefix` of its own, so that install would land in the prefix and fail. Pi's `npm:` installs and removals pass `--prefix <agent home>/npm` themselves.
  - The only global read is `npm root -g` (Pi's lookup of packages an older Pi installed globally). It then resolves to the user's `npm_config_prefix` or our node folder's `lib/node_modules`. It only prints a path and creates nothing.
- **Setup.** `gentle-shell setup` runs Gentle AI, which finds `pi` on `PATH`. pnpm's `.bin/pi` shim runs the first `node` on `PATH`. So setup alone gets our node's folder, then the version's `node_modules/.bin`, ahead of the user's `PATH` (`bundledSetupEnv`). It also gets Gentle AI's isolation variables. Everything else in its environment is the same as Pi's.
- **Pi updates (S5).** Some `gentle-shell update` forms make Pi update itself: no target, `--self`, `self` or `pi` as the target, `--all`, and `self` or `pi` with `--extensions`. Pi reads the last two as "all" (`package-manager-cli.js`). For these forms the launcher says that Pi ships pinned with Gentle Shell. In a terminal it then runs `gentle-shell upgrade`; otherwise it names the command. For an "all" form, Pi still gets `update --extensions`, even when the upgrade could not complete; the launcher reports that and the extensions still update. Package, `--models`, help, and forms Pi refuses (conflicting or unknown options) go to Pi unchanged.
- **What cannot be intercepted.** A `pi update` that someone runs directly with the bundled `pi` (for example the agent's shell, which finds it through `node_modules/.bin`) is Pi's own command. In Pi 1.1.0, `PI_SKIP_VERSION_CHECK` hides only the startup "Update Available" notice (`utils/version-check.js`). For the update itself, `package-manager-cli.js` detects a pnpm install from the `.pnpm` path, and `config.js` (`getSelfUpdateCommand`) finds no global pnpm root that owns `versions/<id>`. Pi then prints `cannot self-update this installation` and changes nothing.

### Engram startup safety

A bundled Shell decides, before setup and again right before Pi starts, whether memory may open the shared Engram store. When it may not, Shell keeps working without memory and **points `ENGRAM_BIN` at its own guard**, so no provider, whichever Pi route loaded it, can open, create or migrate a store it cannot vouch for. The core pin stays **3.3.2**, acquired through the existing size- and checksum-verified path.

#### Decision

| Evidence (default `~/.engram`, default endpoint `127.0.0.1:7437`) | Memory | `ENGRAM_BIN` / `ENGRAM_URL` |
|---|---|---|
| No data directory, nothing listening, verified bundled core | Allowed; this launch provisions a fresh store | Bundled core |
| Same, but the bundled core is missing or unverified | Disabled | Guard (never an `engram` from `PATH`) |
| Running server answers the exact `GET /compatibility` ready contract | Allowed; reuse that server | Guard + `ENGRAM_URL=http://127.0.0.1:7437` |
| Shell's own store (provenance below), nothing listening | Allowed | Bundled core |
| Shell's own store, server listening with `/health` `instance_id` = recorded id **and** `version` = the exact bundled core version | Allowed | Bundled core |
| Anything else: foreign or unreadable data, provenance mismatch, a different server, timeout, 401/404, malformed answers | Disabled | Guard |
| Explicit `ENGRAM_BIN`, `ENGRAM_URL`, `ENGRAM_PORT`, `ENGRAM_DATA_DIR`, `ENGRAM_DATABASE_URL`, or an invalid `ENGRAM_STARTUP_POLICY` | Disabled, never probed | Explicit `ENGRAM_BIN`/`ENGRAM_URL` kept; `ENGRAM_URL` alone gets the verified core (or the guard) as `ENGRAM_BIN`; otherwise guard |

Classification never runs an Engram executable (`instance-id`, `version`, `serve`), never opens SQLite, and never infers compatibility from a version string. It reads file metadata, the `.instance-id` file, the raw database header, and makes bounded (1 s) read-only `GET /compatibility` and `GET /health` requests to the default endpoint on a direct loopback socket, without proxy, redirects or credentials. `gentle-shell --version` and a Pi version or help flag (`--version`, `-v`, `--help`, `-h` where Pi reads it as a flag: before Pi's own `--` and not as another option's value, so a prompt or option value containing `-v` does not count) never probe, ensure the companion, print memory notices or touch provenance.

#### The guard

`bin/engram-guard` is a POSIX `sh` script, run directly (no shell needed by the caller). It ignores its arguments, prints `ENGRAM_STARTUP_NOTICE` (as data, never executed) to stderr and exits 78. It never runs Engram and never reads or writes Engram data. gentle-engram 0.4.1 reaches local data only by running `ENGRAM_BIN` (`instance-id` first, before any health probe or spawn), so the guard stops it before any store access; 0.4.2 also honors `ENGRAM_STARTUP_POLICY=disabled`. Pi, its subagents and the agent's shell all inherit the same environment.

- **Explicit selections bypass the guard.** An `ENGRAM_BIN` or `ENGRAM_URL` you set is never replaced or removed (with only `ENGRAM_URL`, `ENGRAM_BIN` is still the verified core, or the guard without one, never a `PATH` engram); memory is still marked disabled through the policy, which only 0.4.2+ honors.
- **Windows.** The guard has no `.exe`; spawning it fails (for example `ENOENT` or `EINVAL`), which still fails closed, but no notice is printed.

#### Provenance (Shell's own store)

When the final pre-Pi decision is "fresh" (no data directory, nothing listening, verified bundled core, no explicit selection), Shell provisions the store identity itself **before** Pi starts: it runs the verified bundled core's `instance-id` (15 s timeout) with the environment Pi will use, except that this one invocation gets `ENGRAM_NO_UPDATE_CHECK=1` and no `GH_TOKEN`/`GITHUB_TOKEN`. In Engram 3.3.2 that command only creates the data directory, `.instance-id.lock` and `.instance-id`; it skips orphan migration and opens no database. Shell then reads the `.instance-id` **file** (regular, not a link, a valid id equal to the command's output, in the same default directory it classified as absent) and immediately writes `<prefix>/config/engram-provenance.json` (mode 0600): the canonical data directory, that instance id, and the sha256 of the bundled core. If any step fails (the command fails or times out, the identity is invalid, or the record cannot be written), memory is disabled for that launch behind the guard; Pi never starts with memory allowed without a written record. Shell never records a store it did not provision, so a store that appears later at the default directory is never adopted.

A later launch treats the store as Shell's own only when all hold:

1. The data directory, its `.instance-id` and the current bundled core digest equal the record. A Shell upgrade that changes the core binary therefore disables memory: forward upgrades are not allowed by version.
2. The directory still holds only identity files (the session has not created a database yet), or `engram.db` is a regular, unlinked file whose first 100 bytes are a valid SQLite header (magic, page size, bytes 18/19 each 1 or 2) and whose `user_version` (bytes 60-63) is **not greater** than the bundled core's schema (`1`, verified from `v3.3.2:internal/store/store.go`). A greater value means a newer Engram migrated the shared store. Equal or lower (including a stale `0` before a WAL checkpoint) is no signal either way. A pin without a verified schema entry disables this path.
3. If a server listens, its `/health` reports the recorded instance and exactly the bundled core version.

#### Compatible reuse and authorization

`GET /compatibility` (Engram PR #1792, not in any released core yet; current cores answer 404) must return `status: "ready"`, `active_reuse_authorized: true`, `capability: "startup-verified-store-v1"`, `revision: 1`, `source: "active"`, 32-hex `instance_id` and `runtime_id`, and no `offline_automatic_opening_authorized: true`. The endpoint uses the server's `requireAuth`: open when the **server** has no `ENGRAM_HTTP_TOKEN`, otherwise it needs `Authorization: Bearer <token>`. Shell owns no such secret and sends none, so a token-protected server answers 401 and stays unknown (disabled).

#### Recovery and setup

When disabled, Shell prints: **back up your existing Engram data, update Engram, restart its server and Shell, then recheck memory safety**. It performs no migration, deletion, or process termination.

The memory decision never skips or fails setup: `gentle-shell setup` always publishes the verified core, runs Gentle AI and pins the companion, as before. Gentle AI 4.0.0 `install --agent pi` runs no `engram setup` for Pi, and `pi-engram init` only edits settings, so neither opens a store. Setup reclassifies after publishing the core, and the decision only selects the Engram environment its children and the launched Pi receive. On a new machine the wizard publishes the runtime without Engram, so the first `gentle-shell setup` publishes the core and the following launch is the fresh one that records provenance. Setup and every launch pin `npm:gentle-engram@0.4.2` through Pi's own `install` command (configuration only) and verify the declaration plus `engram.startupPolicy: 1`; a failed check is reported and Shell still starts, protected by the guard. `setup --dry-run` installs nothing.

#### Known limits

- **Shared-store residuals.** Provenance proves Shell's core created the store, not that no other Engram opened it since. A different Engram that changed the store without raising `user_version` (for example same-schema repairs) is not detected without reading the database, and changes still only in the WAL are not visible in the header.
- **Concurrent creation.** Another client that uses Shell's freshly provisioned directory (same `.instance-id`) during or after the session is not distinguishable from Shell's own core, beyond the header check. A held identity lock makes provisioning time out and disables memory for that launch.
- **Failed provisioning.** If the identity was created but the record could not be written, later launches see an unrecorded store and keep memory disabled; the notice explains how to recover.
- **Older or other integrations.** gentle-engram versions before 0.4.1, and integrations that do not reach data through `ENGRAM_BIN` (for example an MCP launcher running `engram` from `PATH`), are not covered by the guard.
- **Non-bundled installs** keep their previous behavior.

### Isolation from the user's Gentle AI

S9. Everything Gentle AI and gentle-pi keep lives in the prefix, except Engram's memory data.

| Process | Gets |
|---|---|
| `gentle-shell setup` (the pinned `gentle-ai install --agent pi`) | `GENTLE_AI_HOME=<prefix>/gentle-ai`, `GENTLE_AI_PI_CONFIG_DIR=<prefix>/config/gentle-ai`, `GENTLE_AI_ENGRAM_BIN=<prefix>/runtime/engram-<v>/engram`, `GENTLE_AI_NO_SELF_UPDATE=1` and `GENTLE_PI_CONFIG_HOME=<prefix>/config`. |
| Pi and its subagents | `GENTLE_SHELL_PREFIX=<prefix>` and the memory startup policy; `ENGRAM_BIN` is the verified `<prefix>/runtime/engram-<v>/engram` when memory is allowed locally, otherwise the Shell guard (plus `ENGRAM_URL` for verified reuse). An explicit `ENGRAM_BIN` or `ENGRAM_URL` is kept as is ([Engram startup safety](#engram-startup-safety)). No `GENTLE_AI_*` variable, and `GENTLE_PI_CONFIG_HOME` is left as the user has it. |
| gentle-pi's own `gentle-ai` runs (review, telemetry trigger, runtime metrics) | The same five variables as setup. |
| The agent's shell | Pi's environment: the user's own plus the Pi row above. |

- **Running bundled.** `runningBundledPrefix` (`lib/gentle-shell-bundled.ts`) decides it for every rule below. `GENTLE_SHELL_PREFIX` must be absolute and name the root of the bundled install that this gentle-pi runs from. `resolveBundledInstall` must find a finished version of that prefix around the package (its version marker). `current` need not name it: a subagent started after `gentle-shell upgrade` moved `current` runs from the previous, kept version and stays bundled. The launcher's own choice of version still requires `current`. A gentle-pi the user installed elsewhere (npm, pnpm, nvm) and started from the agent's shell, which inherits the variable, is not bundled. Outside bundled mode every rule here is off, and everything behaves as in a pnpm or npm install. The answer is remembered per package root and prefix value. So a `gentle-shell upgrade` that moves `current` while Pi runs does not change the running Pi's config home mid-session.
- **gentle-pi's config home.** In bundled mode, `gentlePiConfigHome` (`lib/agent-home.ts`) is `<prefix>/config/gentle-ai`. Three other readers use the same rule: the profile reader and pin resolution in `extensions/gentle-shell.ts`, the banner settings in `extensions/startup-banner.ts`, and the dev-binary registration in `lib/gentle-ai-binary.ts`. It is derived, never exported to Pi: an exported value would redirect a `gentle-ai` the user runs in the agent's shell. Outside bundled mode it stays `GENTLE_PI_CONFIG_HOME`, else `~/.pi/gentle-ai`. The bundled config home starts empty: profiles and preferences in `~/.pi/gentle-ai` are not copied.
  - **In bundled mode a `GENTLE_PI_CONFIG_HOME` the user set is ignored by gentle-pi**: the bundled config home wins. The variable still reaches the agent's shell unchanged, so the user's own `gentle-ai` or gentle-pi runs there are unaffected.
  - **Aligned with Gentle AI 4.0.0.** Gentle AI 4.0.0 reads `GENTLE_PI_CONFIG_HOME` as the parent of its own `gentle-ai` folder: `piBackgroundPolicyPath` in `internal/cli/pi_background.go` writes `<GENTLE_PI_CONFIG_HOME>/gentle-ai/background-subagents.json`, else `~/.pi/gentle-ai/...`. So the config home is `<prefix>/config/gentle-ai`, and only the Gentle AI processes Gentle Shell starts also get `GENTLE_PI_CONFIG_HOME=<prefix>/config`. The policy 4.0.0 writes during setup then lands in the bundled config home, and a release with gentle-ai#5462 writes the same folder through `GENTLE_AI_PI_CONFIG_DIR`. In 4.0.0 only `install`, `sync` and their dry runs read it (the background-policy projection); review and telemetry runs do not, and get it only so every Gentle AI process Gentle Shell starts agrees.
- **Gentle AI's variables never reach Pi.** Pi's bash tool would pass them to a `gentle-ai` the user runs in the agent's shell, and that run would then use the prefix. Instead, `gentleAiIsolationEnv` (`lib/gentle-ai-binary.ts`) adds them to each `gentle-ai` that a bundled gentle-pi starts itself (the central `gentleAiProcessEnvironment`, the review relay, the runtime metrics send and the telemetry trigger), and the launcher adds them to setup. `GENTLE_AI_ENGRAM_BIN` is set only when our Engram is published.
- **Engram.** `ensureEngram` (`scripts/bundled-install.mjs`) publishes the pinned Engram release under `runtime/engram-<v>/`. The archive is checked against its pinned size and sha256 from the release's `checksums.txt`. Only the `engram` (or `engram.exe`) regular file is written. `engram version` must print `engram <v>` from the staging folder before the folder is published. `ensureRuntime({ engram: true })` includes it. `gentle-shell setup` in a bundled install ensures it before it runs Gentle AI, and stops if it cannot, whatever the memory decision ([Engram startup safety](#engram-startup-safety)). `gentle-shell upgrade` and `--rollback` pass `engram: true` to the release's own `ensureRuntime`. With `GENTLE_AI_ENGRAM_BIN`, Gentle AI uses that binary as is: no brew, download, `go install`, `PATH` or registry change, and no `go` or `brew` dependency probes.
- **gentle-engram.** The gentle-engram Pi extension finds Engram only through `ENGRAM_BIN`, read once when it loads, and otherwise runs `engram` from `PATH`. So Pi gets `ENGRAM_BIN` (the core or the guard), and no `PATH` entry is added. An `ENGRAM_BIN` the user set is kept. The agent's shell inherits `ENGRAM_BIN` too, so an Engram MCP launcher started there through `ENGRAM_BIN` uses the same core or guard.
- **Personas.** Setup snapshots and restores the persona Gentle AI may rewrite: the prefix's `config/gentle-ai/persona.json`, and also the user's `~/.pi/gentle-ai/persona.json`. A Gentle AI release without the variables still writes the user's file, and restoring an unchanged file does nothing. The managed-asset record is restored only in the user's `~/.gentle-ai/state.json`; the prefix's record belongs to the pinned Gentle AI.
- **pi-pretty and prompt history.** In bundled mode only, the pi-pretty wrapper passes `deps.sdk` with Pi's five tool factories and `getAgentDir`, so its FFF database lands in `<agent home>/pi-pretty/fff`, and prompt history keeps its store under `<agent home>/history` ([Prompt history](prompt-history.md)). Elsewhere both keep their existing locations: Pi's deps reach pi-pretty unchanged (`$HOME/.pi/agent/pi-pretty/fff`, or no store without `HOME`), and history stays under `~/.pi/agent/history`, also in the isolated home of a pnpm or npm install, so existing histories are not left behind.
- **Effective with a later Gentle AI.** gentle-pi pins Gentle AI 4.1.1 today (`INSTALLER_VERSION`); the following are historical compatibility notes for Gentle AI 4.0.0, which ignores the four `GENTLE_AI_*` variables. Whether 4.1.1 includes gentle-ai#5462 is unverified here. Until gentle-pi pins a Gentle AI release that contains gentle-ai#5462:
  - Setup still writes `~/.gentle-ai` and `~/.pi/gentle-ai`, with the restores above, and still acquires Engram its own way.
  - The persona goes to the user's `~/.pi/gentle-ai/persona.json` (Gentle AI 4.0.0 resolves it from the OS home) and is restored there. The prefix's `config/gentle-ai/persona.json` is not created by setup.
  - The background-subagents policy already lands in `<prefix>/config/gentle-ai/` through `GENTLE_PI_CONFIG_HOME=<prefix>/config` (see above).

What stays the user's:

- `git`, `gh` and `codegraph`, which the agent runs for the user's work, from the user's `PATH`.
- Engram's memory data in `~/.engram`, shared with the user's other agents.
- pi-pretty's reads of `$HOME/.pi/agent/settings.json` (its `index.js` and `render.js` look for its settings there whatever the agent home is). This needs an upstream pi-pretty change; `node_modules` is not patched.
- `GENTLE_SHELL_PREFIX` and `ENGRAM_BIN` reach the agent's shell, like the agent home variables. A gentle-pi the user runs there is not bundled and ignores the prefix (see above).

### Startup update offer

Opening a bundled `gentle-shell` in a terminal checks the npm `gentle-pi/latest` release before Pi starts. The check waits at most 1.5 seconds; offline (`PI_OFFLINE` or `--offline`), unavailable, malformed, same or older releases open normally. Plain startup and `--continue`/`--resume` are supported; commands, other forwarded options, noninteractive/RPC launches, and subagents do not check or prompt. Global npm/pnpm installations are unchanged.

A rose-colored panel shows the current and available Shell versions and a link to that release’s notes. Use arrows or 1–3 to select, then Enter to confirm:

- **Update now (gentle-shell upgrade)** uses the existing verified bundled upgrade. On success, it automatically reopens the newly active Shell with that release’s Node and Pi and the original startup arguments, without showing the prompt again on the handoff. If upgrade fails, its error is shown and the current Shell opens normally; a failed relaunch reports an error rather than silently running the old version.
- **Not now** (the default; also Escape or end of input) opens normally without saving a preference.
- **Skip this version** stores only the offered version as `skippedStartupRelease` in the launcher’s `config.json` (or `GENTLE_SHELL_CONFIG` override), preserving unrelated settings. Another newer release can prompt again. A malformed or unwritable file is not replaced; the launcher warns and continues without saving.

Ctrl+C cancels opening (exit 130). No update runs without explicit confirmation. The startup check does not update additional extensions; use `gentle-shell update --extensions` for those. Restarting does not change the working directory, startup arguments, or agent home. Pi remains pinned to the Shell release.

### `gentle-shell upgrade` in a bundled install

`upgradeBundled` follows the release channel only. `--channel main` is refused until a later task.

1. The latest release comes from the npm registry, as on the ordinary release channel (`latestRelease`). Its two assets come from `fetchDistribution` (identity encoding, size bounds), and `readDistribution` checks the exact versions, the workspace files and the lockfile sha256. A release without assets stops with its version, and nothing changes.
2. When that release is the active version, the command says it is already current and changes nothing.
3. Otherwise `ensureRuntime` runs (with Go on Windows), and `installVersion` installs the release in place beside the active version.
4. The new version's own `scripts/bundled-install.mjs` is loaded, only from that freshly installed folder, and only when its real path stays inside it. Its `prefixLayout`, `ensureRuntime` and `ensureLauncher` must all be functions; otherwise the upgrade stops. Its `ensureRuntime` installs that release's pinned Node and pnpm beside ours when the pins moved, and reuses them otherwise.
5. The new version's launcher must print exactly `gentle-shell <shell>` and `pi <pi>`. It runs with the release's Node, in the pnpm environment, with no `GENTLE_*` or `PI_*` overrides. It runs in bundled mode for that version, with its exact Pi: the only extra variable, `GENTLE_SHELL_VERIFY_VERSION=<id>`, makes `resolveBundledInstall` treat that id as current. The launcher honors it for `--version` only, and never passes it to a child. A `pi` on `PATH` cannot pass this check.
6. Only then does `current` switch (`activateVersion`, one rename), and the release's own `ensureLauncher` writes the launcher for its Node. If the launcher cannot be written, `current` switches back and the command fails.
7. `pruneVersions(layout, 2)` keeps the new version and the previous one. If pruning fails, the upgrade still succeeds and prints a warning.

Any failure before step 7 leaves `current` as it was and removes a version folder this command installed.

`gentle-shell upgrade --rollback` switches `current` to the most recently active other version that is still installed. It uses that version's own `scripts/bundled-install.mjs`, loaded and checked as in step 4. Its `ensureRuntime` makes sure its pinned runtime is present, and its `ensureLauncher` writes the launcher for its Node. Without a usable module, nothing changes. If the launcher cannot be written, `current` switches back. Running `--rollback` twice returns to the first version.

Known limits: a release whose lockfile needs a newer pnpm than ours cannot be installed by this upgrade, because the release's own runtime is installed only after its version folder exists. Older runtimes under `runtime/` are never removed.

## Migration from a global install

An existing Gentle Shell that a global pnpm or npm owns moves to the bundled install (S4). `migrationGate` in `scripts/bundled-wizard.mjs` decides, as a pure function. All of these must hold:

- The channel is `release`, and the target is supported.
- `installOwner` names the owner: `pnpm` or `npm`. An `npm link` or an unknown owner is never moved. `gentle-shell upgrade` names it and keeps its current path.
- The release publishes both distribution assets, and that release is not older than the installed Gentle Shell.

Otherwise both entries keep their current path, unchanged.

**The prefix folder.** The launcher creates the isolated home `~/.gentle-shell/agent` (and `~/.gentle-shell`) with mode 0700, whatever the umask. An existing `~/.gentle-shell` that is a real folder of this user but group- or other-writable (umask 002 before this fix) loses that write access (`go-w`, through a descriptor that does not follow links) when the prefix is claimed. A link, a non-folder or another owner's folder is still refused.

**`gentle-shell upgrade` (`migrateGlobalShell`).** `runUpgrade` offers the migration on the release channel only, through its `migrate` adapter, before its own update. The owner probe (`ownerManager`, which runs the user's `npm root -g`) runs only after the assets read as published and the versions allow a migration; otherwise nothing is probed.

1. A few lines explain the move: the prefix, the exact Pi, the user's Node, npm, pnpm and Pi untouched, and `~/.gentle-shell/agent` staying where it is.
2. `runBundledInstall` runs the bundled steps with a plan whose removal is `ask`: claim, npm settings, runtime, version, activate, launcher, then `verify-launcher` (the launcher's own `--version`, `checkLauncher`), then the PATH entry, so a launcher that fails its check is never put on PATH. There is no setup step: the launcher's automatic setup runs on first use.
3. Then one question: `Remove the old global gentle-pi with <manager> (<command>)? [y/N]`. End of input or Ctrl+C answers No. Without a terminal, nothing is removed and the exact command is printed.
4. A yes runs `pnpm remove -g gentle-pi` or `npm uninstall -g gentle-pi`, through `ownerManager`'s verified invocation (`removeGlobalShell`).

A failed plan or step (including the launcher check) prints the step and its detail, which is the error message with the home shown as `~`, and says the global gentle-pi was left untouched. The upgrade then continues with the global package's own update for this run, and exits with that path's code. A failed removal keeps the bundled install, names the manual command and exits 1. After a successful install, the release channel is recorded and a main override this module made is removed.

When the old package stays, `shadowingCommand` predicts which `gentle-shell` a new terminal runs. It takes this PATH with the planned change applied. If the old one still wins, the command names it and says how to change that. The order it assumes per startup file:

| Planned change | Position | Why |
|---|---|---|
| zsh line in `$ZDOTDIR/.zshrc` | first | zsh reads `.zshrc` after `.zprofile` (and macOS `path_helper` in `/etc/zprofile`); our line is appended after `pnpm setup`'s block. Only `~/.zlogin`, read later, could prepend again. |
| bash line in the macOS login file, or `~/.bashrc` | first | Appended last to the one file bash reads for terminals; `pnpm setup` writes earlier. A Linux `~/.profile` that sources `.bashrc` and then prepends `~/bin` or `~/.local/bin` could precede it. |
| fish line in `conf.d/gentle-shell.fish` | last | fish reads `conf.d` before `config.fish`, so whatever `config.fish` prepends (`pnpm setup`'s `$PNPM_HOME/bin`) comes first. The current PATH already shows those entries, so the bundled `bin` counts after all of them. This may report a shadow for an entry that `config.fish` did not add. |
| Windows user Path entry | last | Appended to the user Path, after the machine Path. |
| `~/.local/bin` link, or no change | where it already is | |


**The web installer.** An existing Gentle Shell that pnpm or npm owns gets the bundled plan with removal `plan`. In that plan, `verify-launcher` runs before `bundled-path`, and a final `remove-global-shell` action follows. A failed step keeps the failed outcome and carries its detail (the error message; for `verify-launcher`, the versions the launcher reported against the expected ones), which the outcome screen shows. Consenting to the plan is the one confirmation. The removal runs only after every step passed. It finds the installed Gentle Shell again, and runs only when the same manager still owns it. A failed removal keeps the outcome and adds `removeGlobal { status: "failed", command }`; the outcome screen shows that command.

Only the PATH entry and the old global gentle-pi change outside the prefix. The user's Pi and `~/.gentle-shell/agent` are never touched.

## Self-uninstall

`gentle-shell self-uninstall [--dry-run] [--yes] [--include-shared]`, run from the bundled launcher, removes the bundled install (S6, S7). It keeps the plan, the confirmation, `--dry-run`, `--yes`, end of input (cancel) and Ctrl-C (abort) of the global-install path, which is unchanged.

- **Ownership.** The prefix must be the real folder the launcher runs from, never reached through a link. On POSIX it must be the real `~/.gentle-shell`; on Windows it must carry the `.gentle-shell-bundle` marker with its exact text. Otherwise nothing is removed. No removal may be, contain or lie inside the home folder, `~/.pi`, the user's Pi home, `~/.gentle-ai` or `~/.engram`.
- **PATH first.** The entry the receipt records is removed first: only our link, our exact line or our `Path` entry. A failure stops before anything else is removed. A line the user edited, or a link that no longer points at our launcher, is kept, and the last message names the file and the marked line it still holds. Without a valid receipt the plan names the entry to remove by hand, once, and nothing is guessed.
- **Removed.** `bin/`, `current` (the link itself), `versions/`, `versions.history`, `runtime/`, `pnpm/`, `npm/`, `gentle-ai/`, `config/` (Gentle Shell's settings, `config/gentle-ai`), `tmp/`, `path-entry.json` and, on Windows, the marker. Each is checked with `lstat`; a link in their place or anything else is kept and named, and no link inside them is followed.
- **Shared.** The Gentle Shell home (`~/.gentle-shell/agent`) and the launcher's `config.json` are kept unless the user accepts a separate question (default No) or passes `--include-shared`.
- **The prefix.** It is removed only when nothing else is left in it, and only when it held nothing the install did not write.
- **Windows.** The running `node.exe`, the `.cmd` launcher and the marker cannot be removed by this process. Everything else goes at once, the `Path` entry included. A hidden Windows PowerShell (`scheduleWindowsRemoval`; a detached `cmd.exe` starts it with `start`, so it outlives the launcher) waits for this process to exit, deletes `node.exe` and the launcher, then the marker only when nothing is left at their paths (so a failed removal can be retried with `self-uninstall`), then each folder above them that is empty, and the prefix when it may go. It never removes recursively. The paths reach it as environment data, never as script text.

## Never touched

- The user's Node, npm, pnpm, Go, `PNPM_HOME`, `~/.npmrc` and npm or pnpm global configuration.
- The user's Engram binary and Homebrew. Gentle AI's `~/.gentle-ai` and `~/.pi/gentle-ai` once gentle-pi pins a Gentle AI release with gentle-ai#5462 ([Isolation from the user's Gentle AI](#isolation-from-the-users-gentle-ai)).
- Anything outside the prefix, except the single PATH change and, after a migration the user confirmed, the old global gentle-pi removed by its own manager.
- Folders, files, launchers or `current` entries without our marker.
