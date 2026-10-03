# Installation wizard groundwork

The preflight planner, real host probes, POSIX bootstrap, Windows prerequisite
foundation, the standard installation runner module (including runtime
persistence), the secure local wizard host with its packaged entry and the
interactive browser wizard UI are implemented. Windows native validation
remains unavailable locally.
**This is not a supported installation path yet:** published bootstrap
artifacts, real browsers and native macOS/Windows clean-machine runs are still
unverified (T7); one Linux clean-container run passed (see
[Clean-machine acceptance](#clean-machine-acceptance-t7)). For ordinary
installation and terminal use, follow the [README](../README.md).

## What is available

`scripts/installer-preflight.mjs` exports four small integration surfaces:

| API | Contract |
| --- | --- |
| `requirements` | Repository-derived Node/Pi minima, pnpm acquisition pin, package version, native installer pin and Windows Go minimum. |
| `collectInventory({ platform, arch, probes })` | Calls injected named read-only probes serially. Missing/failed probes become unknown; error text is not retained. |
| `planPreflight(inventory)` | Pure classification and ordered action intents; no commands, downloads, installation or setup execution. |
| `pnpmGlobalBin({ platform, env })` | Pure pnpm 11 global-bin resolution: `{ pnpmHome, path, onPath }` or `null` when unknowable. |
| `persistencePins` | Fixed runtime persisted under PNPM_HOME: Node 24.21.0, its bundled npm 11.19.0 and the pnpm acquisition pin. |

`scripts/installer-probes.mjs` supplies the real read-only probes for
`collectInventory`; see [Host probes](#host-probes).

Current requirements come from `package.json` and
[`gentle-ai-installer.mjs`](../scripts/gentle-ai-installer.mjs): Node ≥22.19.0,
Pi ≥0.99.1, pnpm acquisition 11.1.1, Gentle Shell package 4.0.0 and package-local
Gentle AI 4.0.0. Windows native source builds require Go ≥1.25.10 when the
required usable native binary is missing. A reusable binary does not require Go.
Pins change with the repository; the API reads the metadata rather than copying
these values into a second installer.

## Probe adapter contract

Supply `platform` as `linux`, `darwin` or `win32`, and `arch` as `x64` or `arm64`.
These are planning targets, **not evidence of native OS/libc support**. Other
pairs produce an unsupported-target blocker and no actions. Native lanes,
minimum OS versions, libc compatibility, artifact trust and elevation handling
remain to be verified in later units.

Probes are named `node`, `pnpm`, `pi`, `shell`, `gentleAi`, `go`, `globalBin`, and
`setup`. `collectInventory` has no default probes; the real implementations live
in [`installer-probes.mjs`](#host-probes). Probes must use bounded read-only
checks, never launcher setup, postinstall, paid model requests, credential
inspection or home writes. The collector cannot enforce purity of
caller-provided functions; adapter implementations require review.

- Tool observations use `{ available: true, version, usable: true }`; absence is
  `{ available: false }`. Unknown availability, usability or unparseable versions
  block planning. Versions are exact stable `major.minor.patch` strings (optional
  `v` prefix); prereleases and raw command output are unknown, not silently reused.
- Node may add `persistent` (resolvable from the user's PATH without bootstrap
  tool directories) and `npm` (a genuine npm resolves there) booleans; pnpm
  may add `persistent` (resolvable from the user's PATH). A `false` value
  yields the runtime persistence intents below; absent or `null` values add
  nothing, and the runner's own npm gate still applies.
- Shell additionally needs `global: true`, proving normal global ownership.
  Compatible newer Node, Pi and Shell versions are reused, never downgraded.
- pnpm additionally needs `compatible: true`, based on its actual Node engine and
  required global-install capabilities. The acquisition pin is not a minimum:
  newer compatible pnpm is reusable. Do not infer compatibility from its version
  alone; the later acquisition adapter must validate the pinned engine too.
- Gentle AI additionally needs `compatible: true`: evidence from the normal
  package-local binary resolution/integrity contract, for the selected Shell
  installation. Its exact installer pin is required; another version blocks
  rather than being overwritten. Do not confuse an unrelated PATH binary with
  the package's reusable native binary. For a newer reusable Shell, the adapter
  must establish native-pin compatibility before presenting this evidence.
- Global-bin observations use `{ available: true, path, writable: true, onPath }`.
  A known missing PATH entry yields an explicit setup intent. Unknown or
  non-writable directories block; no directory is created or permission probed
  by writing. pnpm 11 places global executables in **`$PNPM_HOME/bin`**, not
  `$PNPM_HOME`, and `pnpm root -g`/`bin -g` fail when that directory is not on
  PATH. Probes must report `pnpmGlobalBin().path`, whose `onPath` compares PATH
  entries with that bin directory. PNPM_HOME is the user's existing absolute
  value; otherwise pnpm's documented default (`$XDG_DATA_HOME/pnpm` or
  `~/.local/share/pnpm` on Linux, `~/Library/pnpm` on macOS,
  `%LOCALAPPDATA%\pnpm` on Windows). A relative PNPM_HOME or missing home is
  unknown, not guessed.
- `setup` is a boolean evidence of normal Shell setup readiness. Unknown setup
  on an existing stack blocks; a missing Shell/native binary needs normal setup.

## Reading a plan

Tool statuses distinguish `unavailable`, `unknown`, `incompatible`, `reusable`,
`needs-setup` and `not-required`. Any blocker suppresses all actions: repairing an
existing incompatible or uncertain component requires a later explicit decision,
not automatic replacement. `ready` means no acquisition/setup is indicated by
this inventory, **not that verification has executed**.

A clean target receives these intents in dependency order:

1. Acquire and verify Node, then pnpm; prepare the usable global-bin environment.
   Persist only what is missing. A bootstrap-only reusable Node gets the full
   group, always together: `persist-node` (`persist-runtime`, version
   24.21.0), `persist-package-managers` (`install-global`) and
   `configure-npm-prefix` (`configure`). A persistent Node is never replaced:
   it gets at most one intent, `persist-npm` (npm 11.19.0) when no genuine
   npm resolves, `persist-pnpm` (pnpm 11.1.1) when pnpm is bootstrap-only, or
   `persist-package-managers` when both are missing.
2. On Windows, acquire and verify Go before missing native provisioning.
3. Install Pi globally, then `gentle-pi` globally (its existing postinstall owns
   native installation). For an existing Shell with missing native binary, call
   the existing installer instead.
4. Run normal Shell setup and verify stack readiness. Verification is always
   included, even when all components can be reused.

A recoverable setup (the pinned stack is installed, Gentle AI is verified and
only setup did not finish) plans exactly `setup-global-bin` (only when the
global bin is off PATH), `setup-shell` and `verify-readiness`: never an
acquisition, persistence or installation intent. See
[Setup recovery](#setup-recovery).

Actions are structured `{ id, kind, target, version? }` descriptors, **not shell
commands**. Later runners must re-inventory after changes, verify prerequisite
versions and global-bin readiness before dependent steps, obtain explicit consent
and stop on mandatory failures. They must preserve existing versions/paths and
use normal global package ownership and default `~/.gentle-shell/agent` semantics.
No alternate product root, Engram database/server, credential migration or custom
companion installer belongs in this plan.

## Remaining boundaries

`npm:` registry sources are package references, not npm executable calls. Pi's
`npmCommand` supports pnpm, but independent upstream `npm exec` control remains
unverified. **This preflight does not establish an npm-free installation chain.**

The consent UI is the local wizard host described below. A published
distribution bundle and native acceptance evidence remain future work in the
[feature plan](../odd/tasks/browser-install-wizard.md). Deterministic injected
tests do not prove clean-machine installation on Windows, macOS or Linux.

Focused verification:

```sh
node --experimental-strip-types --test tests/installer-server.test.ts tests/verify-package-files.test.ts tests/installer-probes.test.ts tests/installer-runner.test.ts tests/installer-preflight.test.ts tests/installer-posix-bootstrap.test.ts tests/installer-windows-bootstrap.test.ts
sh -n scripts/bootstrap.sh
```

## Host probes

`scripts/installer-probes.mjs` exports `createProbes({ platform, env, run, fs,
home?, verifyGentleAi? })`, returning the eight named probes for
`collectInventory`. `env` is the wizard's own environment, with bootstrap tools
first on PATH. Every probe returns the documented shape or the unknown shape
`{ available: null }`; adapter errors are caught and never retained.

| Export | Contract |
| --- | --- |
| `bootstrapRoots({ platform, env })` | Bootstrap tool roots: an absolute `GENTLE_BOOTSTRAP_TOOLS` plus every PATH entry segment named `.gentle-shell-bootstrap-tools.*` (case-insensitive on Windows). |
| `userEnvironment({ platform, env })` | A copy of `env` whose PATH omits entries inside those roots: the user's real PATH. |
| `hostAdapters({ maxOutputBytes?, maxTextBytes? })` | Real `run` and read-only `fs` adapters, described below. |

Adapters:

- `run(command, argv, { env, deadlineMs })` is the runner's process contract:
  argv arrays with `shell:false`, SIGKILL at the deadline and stdout bounded
  to `maxOutputBytes` (default 1 MiB, reported as `truncated: true`). stderr
  is discarded because it can hold private paths, unless the caller passes
  `stderrTail: <bytes>` (a positive integer, clamped to 4 KiB): then stderr is
  piped and only its last bytes are kept and returned as `stderrTail`, also on a
  deadline. Only the runner's `shell-setup` and `persist-path` steps ask for it. A spawn failure returns
  `code: null`. The deadline signals the direct child only, not descendants;
  it then destroys the child's pipes and settles as timed out (`code: null`,
  `signal: "SIGKILL"`) without waiting for `close`, which a descendant holding
  stdout could otherwise delay indefinitely.
- `fs` offers `isFile`, `isDirectory`, `exists` (only ENOENT/ENOTDIR are
  absent), `realpath`, `readText` (regular files up to `maxTextBytes`) and
  `writable` (an access check, never a write). No probe creates, deletes or
  writes anything.

Probes run only fixed argv: `node --version`, `pnpm --version`,
`pnpm list -g --depth 0 --json` (once, shared), `go version` and npm's
`npm-cli.js --version`. Deadlines are 10 seconds for versions and 30 seconds for
the listing; truncated, nonzero, signalled or timed-out output is unknown.

| Probe | Evidence |
| --- | --- |
| `node` | The first `node` on the user's real PATH (Go `exec.LookPath` order, PATHEXT on Windows), else the bootstrap one. `persistent` says which. `npm` is the runner's genuine-npm proof in the user's real PATH with `$PNPM_HOME/bin` first, so a bootstrap npm never counts. A Windows `.cmd`/`.bat` cannot run with `shell:false` and is unknown. |
| `pnpm` | The runner's invocation (bootstrap handoff, or a POSIX `pnpm` on PATH). `compatible` requires a successful run (pnpm checks its Node engine at startup) at the pinned major and at least the pin, because the runner's argv is verified for pnpm 11 only. `persistent` is whether any `pnpm` resolves on the real PATH. |
| `pi`, `shell` | pnpm-global entries from the listing. A package that is not pnpm-global but whose command (`pi`, `gentle-shell`) resolves on the real PATH is unknown, never absent, so another installation is not duplicated. Shell is `usable` only when `$PNPM_HOME/bin/gentle-shell` (`.cmd` on Windows) exists. |
| `gentleAi` | Absent without gentle-pi or without its package-native binary. Otherwise compatible only for this package version, a listed path that resolves inside PNPM_HOME and `verifyGentleAi` (default `packageNativeGentleAi`) success; anything else is unknown. |
| `go` | `go version` from the real PATH; `go1.22` normalizes to `1.22.0`; devel and release-candidate builds are unknown. |
| `globalBin` | `pnpmGlobalBin` over the real PATH; `writable` is write access on the nearest existing ancestor of `$PNPM_HOME/bin` (itself included). A non-directory ancestor is not writable. |
| `setup` | `false` when gentle-pi is absent. `{ available: true, recoverable: true }` for the pinned stack this pnpm installed (see [Setup recovery](#setup-recovery)), using the runner's `recoverableStackRoot`. Unknown otherwise, because an existing Shell's setup readiness has no read-only evidence. |

A failed, empty or unparseable listing makes Pi, Shell, Gentle AI and setup
unknown, which blocks planning. A package listed in two projects is ambiguous
and unknown.

## Standard installation runner

`scripts/installer-runner.mjs` exports `runStandardInstall({ plan, consent },
adapters)`, the fixed installation step the local wizard host
(`bin/gentle-shell-install.mjs`, below) calls after bootstrap and a fresh
preflight. It is a pure module: every process, filesystem,
environment, integrity and log effect goes through adapters supplied by trusted
local code, never through the browser.

### Request contract

The request is exactly `{ plan, consent }`. `plan` must be an unmodified
`planPreflight` result: every action must equal a descriptor preflight can emit
(same id, kind, target and repository-derived version, no extra keys). Extra
request keys, commands, URLs, roots, environment or altered versions are
rejected as `invalid-request` before any process runs. `consent` must be the
boolean `true`; anything else returns `consent-required` with no commands. The
consent covers the whole displayed plan, including the PATH profile change and
the runtime persistence and npm prefix actions below, so the wizard must show
those changes before asking.

### Adapters

| Adapter | Contract |
| --- | --- |
| `platform` | `linux`, `darwin` or `win32`. |
| `nodePath` | Absolute Node executable of the trusted host, used for npm proof and `gentle-shell setup`. |
| `env` | The user's environment. Never mutated; child environments are copies. |
| `home` | Optional; defaults to `HOME` (`USERPROFILE` on Windows). |
| `run(command, argv, { env, deadlineMs })` | Argv arrays with `shell:false` semantics and a hard deadline; returns `{ code, signal, timedOut, stdout }` with bounded output. |
| `fs` | Read-only `isFile`, `realpath`, `readText` (also used to read pnpm's npm shim). The runner has no delete or write operation. |
| `verifyGentleAi({ packageRoot, platform, env, home })` | Returns `{ ok: true }` only for package-native integrity. `packageNativeGentleAi` is the default implementation over `runtime/gentle-ai-binary.mjs`. |
| `log({ step, status, reason? })` | Receives step identifiers and statuses only, never raw command output or error text. |

### Fixed sequence

No-process gates, all returning `blocked`:

1. Valid request and explicit consent.
2. Preflight blockers are absent. Two plans are supported. The clean-stack
   plan must contain `install-pi`, `install-shell`, `setup-shell` and
   `verify-readiness`, plus optional `setup-global-bin` and at most one exact
   persistence variant: `persist-node` + `persist-package-managers` +
   `configure-npm-prefix`, or `persist-package-managers` alone, or
   `persist-npm` alone, or `persist-pnpm` alone. The
   [setup recovery](#setup-recovery) plan is exactly `setup-shell` and
   `verify-readiness`, plus optional `setup-global-bin`, and nothing else.
   Prerequisite acquisition intents (Node, pnpm, Go), `provision-native`, any
   other persistence combination, other partial existing stacks and fully
   reused stacks are `unsupported-plan`.
3. On Windows, Go must be `reusable` in a clean-stack plan because gentle-pi's
   postinstall may build Gentle AI from source; the runner never acquires Go
   (`go-required`). A recovery runs no postinstall, so it needs no Go.
4. `pnpmGlobalBin` resolves PNPM_HOME (`pnpm-home-unknown` otherwise) and
   `nodePath` is absolute.
5. pnpm comes from the bootstrap handoff `GENTLE_INSTALL_PNPM_NODE` +
   `GENTLE_INSTALL_PNPM_ENTRY` (both absolute), or on POSIX from a `pnpm`
   executable on PATH. Windows requires the handoff because a `.cmd` shim cannot
   run with `shell:false` (`pnpm-unavailable`).

Every child process receives the user's environment plus `PNPM_HOME` and
`$PNPM_HOME/bin` first on PATH.

Pre-install checks, returning `blocked` on a false result or adapter error:

1. `check-npm`: Gentle AI's normal Pi install always runs an Engram init step
   that can use `npm exec` and stops on failure. The runner resolves `npm` the
   way Go's `exec.LookPath` (used by Gentle AI) does: absolute child PATH
   directories in order and, on Windows, every child PATHEXT extension in
   PATHEXT order (case-insensitive keys; default `.COM;.EXE;.BAT;.CMD`). That
   first candidate must be the npm package's own `bin/npm-cli.js` (symlink
   target on POSIX; on Windows the candidate must be `npm.cmd`, with
   `node_modules/npm` beside it), its `package.json` must name `npm` with a
   stable version, and `node npm-cli.js --version` must print that version.
   A candidate in `$PNPM_HOME/bin` must instead be pnpm's global npm: a POSIX
   symlink, or a shim whose single quoted `npm-cli.js` target (`$basedir/...`
   on POSIX, `%~dp0\...` or `%dp0%\...` on Windows, or absolute), must
   resolve (realpath) to `node_modules/npm/bin/npm-cli.js` inside PNPM_HOME,
   and the package must be exactly `npm@11.19.0`. Two different targets, a
   target outside PNPM_HOME or another version are rejected. When the plan
   adds npm, this check runs after the add and fails as a mutating step. On
   Windows an `npm.com`, `npm.exe` or `npm.bat` that resolves first, in the
   same or an earlier directory, blocks as `npm-shadowed`; any other mismatch
   blocks as `npm-unavailable`. No npm wrapper is created.
2. `check-global-bin`: `pnpm bin -g` must succeed and equal `$PNPM_HOME/bin`
   (`global-bin-mismatch`; case-insensitive on Windows).
3. `check-existing-stack`: `pnpm list -g --depth 0 --json` runs before any
   mutation. If `@earendil-works/pi-coding-agent` or `gentle-pi` appears in the
   dependencies, devDependencies or optionalDependencies of any listed project,
   the runner blocks as `existing-stack` and never overwrites it, whatever the
   caller's plan says. A failed, timed-out or unparseable listing, or an
   unexpected JSON shape, blocks as `global-list-unavailable`. A recovery runs
   `check-recoverable-stack` instead (see [Setup recovery](#setup-recovery)).

Mutating and verification steps, returning `failed` with `failedStep` and the
`completed` step list. When the plan contains a persistence variant, its
[runtime persistence](#runtime-persistence) steps run first, after
`check-global-bin` and `check-existing-stack`:

1. `install-global`: exactly one
   `pnpm add -g @earendil-works/pi-coding-agent@1.0.0 gentle-pi@<package version> --allow-build=gentle-pi`.
   Pi is gentle-pi's optional peer, so both resolve in one command. pnpm 11
   silently skips global postinstall scripts by default; the package-scoped
   approval runs only gentle-pi's postinstall, which provisions Gentle AI. No
   blanket build approval is ever passed.
2. `verify-global-list`: `pnpm list -g --depth 0 --json` must report exactly the
   two pinned versions in the single listed project that owns gentle-pi
   (other projects, such as the persisted npm and pnpm, are ignored), and
   gentle-pi's absolute `path` must resolve inside PNPM_HOME.
3. `verify-shell-bin`: `$PNPM_HOME/bin/gentle-shell` (`gentle-shell.cmd` on
   Windows) exists.
4. `verify-gentle-ai`: package-native integrity of the installed package. A
   declared development override (`GENTLE_PI_GENTLE_AI_DEV_BINARY` or its
   registration file) is never package-native proof and fails.
5. `shell-setup`: the installed public CLI, `node <gentle-pi>/bin/gentle-shell.mjs
   setup`, with the child environment minus every `GENTLE_BOOTSTRAP_*` and
   `GENTLE_INSTALL_*` key (case-insensitive on Windows); pnpm commands keep the
   handoff. Nonzero, signal or deadline fails. The runner neither duplicates
   setup logic nor writes the automatic provisioning marker. It requests the
   last 4 KiB of setup's stderr, where `gentle-shell setup` reports errors, and
   a failure carries `detail`: the last error line (containing `Error:` or a
   pnpm `ERR_` code), else the last non-empty line, without terminal escapes,
   control or bidi characters, with the user's home replaced by `~` and at most
   300 characters (`setupErrorDetail`). The raw output is not kept; only this
   step and `persist-path` have a detail.
6. `persist-path`, only when `$PNPM_HOME/bin` was not on the user's own PATH:
   `pnpm setup`, then the outcome is `terminal-action-required` with
   `action: "open-new-terminal"`. A child environment never proves that a fresh
   terminal resolves `gentle-shell`. On POSIX, `pnpm setup` picks the profile
   to edit from the inherited `SHELL` variable (bash, zsh, fish, ksh, dash, sh
   or nushell); without it pnpm 11.1.1 fails with `ERR_PNPM_UNKNOWN_SHELL`,
   with another shell `ERR_PNPM_UNSUPPORTED_SHELL`. A terminal session always
   exports `SHELL`; a launcher that does not (for example `docker exec`, some
   service managers or IDE tasks) makes this step fail. pnpm prints these
   errors on stdout, so a failure takes `detail` from the same 4-KiB stderr
   tail or, when that has no line, from stdout. Before checking the shell, the
   observed pnpm 11.1.1 also installs the latest `@pnpm/exe` globally ("Installing
   pnpm CLI globally"), which is upstream behavior the runner does not control.

`ready` requires every step above to complete and the global bin to already be
on the user's PATH. Skipped, unverified or failed mandatory steps never yield
`ready`, and no existing installation, home or data is deleted on any outcome.
Deadlines are 30 seconds for probes and npm config commands, and 20 minutes
each for the install, persistence and setup steps, including `pnpm setup`,
which installs `@pnpm/exe` from the registry.

### Setup recovery

`gentle-shell setup` runs after `add -g`, so a setup that stops (for example on
the [GitHub API limit](#github-api-limit-during-setup)) or a failed `pnpm setup`
leaves Pi and gentle-pi installed. Rerunning the installer then completes that
installation instead of blocking as an existing stack.

Detection is the setup probe, with the same rule the runner applies
(`recoverableStackRoot`): the global listing names Pi and gentle-pi exactly
once each, both in the single project that owns gentle-pi, Pi at exactly
1.0.0 and gentle-pi at exactly this package's version, and gentle-pi's path
resolves (realpath) inside PNPM_HOME. Preflight also requires Pi, Shell and
Gentle AI to be `reusable`. Anything else (another version, a second listing,
a path outside PNPM_HOME, Pi missing) keeps the setup probe unknown, so a
foreign or other-version stack stays blocked exactly as before.

The recovery plan is all or nothing: `setup-shell`, `verify-readiness` and
`setup-global-bin` only when the global bin is off PATH. The runner then runs
`check-npm`, `check-global-bin` and `check-recoverable-stack`, which lists the
global packages again and blocks as `existing-stack-unverified` when the stack
no longer matches (or as `global-list-unavailable` when pnpm cannot list).
It skips `install-global` (never `add -g`) and continues with the unchanged
`verify-global-list`, `verify-shell-bin`, `verify-gentle-ai`, `shell-setup`
and, when planned, `persist-path`, with the same outcomes. A recovery never
persists the runtime: the earlier run persisted it before installing the
stack, and `check-npm` still proves a genuine npm in the child environment.

Rerunning `gentle-shell setup` is acceptable because it is the public,
rerunnable command the clean installation already runs; the runner adds no
setup logic of its own. The review screen says "Gentle Shell is already
installed; this completes setup" and offers **Complete setup**.

### Runtime persistence

A bootstrap-acquired Node lives in a temporary tools directory, so a later
terminal would not find `node` or the genuine npm that Gentle AI's Engram step
needs. Every persistence step uses the same pnpm argv prefix and child
environment as the stack install, and the runner persists only what is missing.

For a bootstrap-only Node, the full group runs these fixed steps:

1. `persist-node`: `pnpm runtime set node 24.21.0 -g`, which installs Node under
   PNPM_HOME and links `node` into `$PNPM_HOME/bin`.
2. `persist-package-managers`: `pnpm add -g npm@11.19.0 pnpm@11.1.1`, which
   adds the `npm`, `npx` and `pnpm` shims to `$PNPM_HOME/bin`. No build
   approval of any kind is passed.
3. `verify-persistent-runtime`: in the child environment both `node` and `npm`
   must resolve (`exec.LookPath` order) from `$PNPM_HOME/bin`, the node must be
   spawnable (`.exe`/`.com` on Windows) and print `v24.21.0`.
4. `check-npm`: the genuine-npm gate above, now accepting the pinned shim.
5. `configure-npm-prefix`: with a pnpm-managed node, npm's default prefix is
   derived from a path inside pnpm's store, so `npm install -g` would write
   there. The runner reads `npm config get prefix` with the persisted node.
   Unless an `npm_config_prefix` (any case) or `PREFIX` variable is set, it
   asks pnpm for its store with `pnpm store path` (30-second deadline); a
   failed, non-absolute or unresolvable answer fails this step rather than
   assuming `$PNPM_HOME/store`. Only when the effective prefix resolves inside
   that store does it run
   `npm config set prefix <PNPM_HOME> --location=user`, then require the
   effective prefix to equal PNPM_HOME. An explicit user prefix elsewhere
   makes npm report that prefix, so it is never overwritten. A failed read,
   write or verification fails this step with the completed list.

The outcome then also reports `npmPrefix: "configured"` or `"unchanged"`.

A persistent Node is never replaced or shadowed: there is no `runtime set` and
no prefix change. One fixed add runs, then only the matching checks:

| Intent | Command | Then |
| --- | --- | --- |
| `persist-npm` | `pnpm add -g npm@11.19.0` | `check-npm` |
| `persist-pnpm` | `pnpm add -g pnpm@11.1.1` | `verify-persistent-pnpm` |
| `persist-package-managers` | `pnpm add -g npm@11.19.0 pnpm@11.1.1` | `check-npm`, `verify-persistent-pnpm` |

`check-npm` is the genuine-npm gate above. `verify-persistent-pnpm` requires
the first `pnpm` in the child environment to be in `$PNPM_HOME/bin` (`.cmd`
on Windows), resolving like the npm shim to `node_modules/pnpm/bin/pnpm.mjs`
inside PNPM_HOME, with `package.json` `pnpm@11.1.1`, and `node pnpm.mjs
--version` printing `11.1.1`. When pnpm is not added, `check-npm` stays a
pre-install gate.
`npm config get` ignores `--location`, and `.npmrc` files can hold credentials,
so the runner never reads them: a user-level prefix that itself points into
the store is indistinguishable from the default and would be replaced.

### Remaining T7 real-machine checks

The runner is verified only with deterministic fake adapters. Observed pnpm
11.1.1 facts come from one Linux laboratory run. Before claiming support, T7
must establish on real Windows, macOS and Linux machines:

- `pnpm list -g --json` reports a dependency `path` that resolves inside
  PNPM_HOME for the installed layout, and prints a parseable JSON array (for
  example `[]`) when no global package exists yet; empty output would block
  a clean installation as `global-list-unavailable`;
- Windows npm resolution matches Gentle AI's actual lookup, including its
  current-directory handling;
- the scoped `--allow-build=gentle-pi` postinstall provisions package-native
  Gentle AI, including Windows source builds with the user's Go;
- `gentle-shell setup` completes the Engram init step with genuine npm, and
  whether Gentle AI selects `pnpm dlx` or `npm exec`;
- `pnpm setup` makes `gentle-shell` resolvable in a fresh terminal of each
  supported shell (the Linux lab showed it does not make `pnpm` itself
  resolvable);
- the chosen deadlines suffice on slow networks, and pnpm's registry and
  update-notice traffic is acceptable;
- interrupted installs are recoverable by rerunning the wizard without data loss;
- `pnpm runtime set node -g` on Windows links a spawnable `node.exe` (a `.cmd`
  shim fails `verify-persistent-runtime`), and pnpm's real `npm.cmd`/POSIX
  shim text matches the accepted target forms;
- npm's Windows global layout: it places executables in the prefix itself, so
  a PNPM_HOME prefix may not put `npm install -g` executables on PATH; also
  whether Windows npm's default prefix lands in the store at all;
- `pnpm store path` reports a directory (for example `$PNPM_HOME/store/v11`)
  that actually contains the effective npm prefix of a pnpm-managed node;
- pnpm's real global `pnpm` shim targets `node_modules/pnpm/bin/pnpm.mjs`, and
  a persistent Node missing npm has a prefix outside the store (the variant
  without `runtime set` configures no prefix);
- download integrity of the Node runtime and the npm and pnpm tarballs fetched
  during persistence (the Linux lab saw a lockfile hash matching the Node pin,
  not download-time verification);
- pnpm's update notifier contacting registry.npmjs.org during these commands;
- `pnpm list -g --json` listing persisted npm/pnpm and the stack as separate
  projects with a usable gentle-pi `path`;
- the probes' `access(W_OK)` writability check, which ignores Windows ACLs, and
  process deadlines that kill only the direct child.

## Local wizard host and entry

`bin/gentle-shell-install.mjs` is the entry the bootstrap's `launchWizard`
starts with no argv and inherited stdio. It is not a `package.json` `bin`
command; it ships inside the package's `bin/` directory and is listed in
`scripts/verify-package-files.mjs` with the other installer files
(`installerPaths`).

### Entry wiring

- Probes: `createProbes` over the wizard's own environment with
  `hostAdapters()` (argv spawn with `shell:false`, deadlines, bounded output,
  read-only fs). Each plan request creates fresh probes, then
  `collectInventory` and `planPreflight` run server-side.
- Runner: `runStandardInstall` with `nodePath: process.execPath`, the same
  adapters, `packageNativeGentleAi` and `runnerEnvironment`: the user's real
  PATH from `userEnvironment`, so a temporary bootstrap npm or node never counts
  as persistent and `onPath` stays truthful. A POSIX bootstrap pnpm, which the
  bootstrap passes only through PATH, stays reachable as the **last** PATH
  entry (its directory holds only the `pnpm` wrapper); Windows uses the
  `GENTLE_INSTALL_PNPM_*` handoff, which `userEnvironment` keeps.
- The entry prints the session URL, then opens it through a private redirect
  file so the one-time code never appears in the opener's argv (visible to
  local process listings). `writeRedirect` creates a fresh `mkdtemp` directory
  `gentle-shell-install-*` under the OS temp dir (mode 0700) holding
  `open.html` (mode 0600, exclusive create): a static page with a meta refresh
  and a link to the session URL, no script. `openBrowser` passes only that file
  path to a fixed opener spawned with `shell:false` and detached:
  `/usr/bin/open` on macOS, `xdg-open` on Linux, `%SystemRoot%\System32\rundll32.exe
  url.dll,FileProtocolHandler` on Windows (absolute, so the current directory is
  never searched). Without an opener nothing is written; a failed write opens
  nothing; an opener that fails to start removes the file. The file and its
  directory are removed (file, then directory, best effort) once the code is
  redeemed (`onRedeemed`) or when the host closes. File modes are POSIX only;
  on Windows the per-user `%TEMP%` ACLs apply. The printed URL stays the
  fallback.

| Exit code | When |
| --- | --- |
| 0 | The last installation outcome was `ready` or `terminal-action-required`. Node, npm and pnpm now persist under `$PNPM_HOME` or were already the user's, so the bootstrap removes the tools directory it created. |
| 1 | `blocked`, `failed`, a shutdown or idle close without a completed installation, a signal, or a host start failure. The bootstrap removes its tools. |

SIGINT and SIGTERM close the server and exit with the code above. An
installation that is still running is not cancelled cleanly: Ctrl+C reaches the
runner's children through the terminal's process group, but SIGTERM does not.

Known debt, not fixed yet: on SIGINT or SIGTERM, `close` does not wait for a
running installation to settle, and runner deadlines kill only the direct child
process, not the processes it started (for example, the ones `pnpm` or
`gentle-shell setup` spawn).

### Security model

`scripts/installer-server.mjs` exports `createInstallerServer({ collectPlan,
runInstall, assetsDir, now?, random?, limits?, onRedeemed? })`, a
dependency-free `node:http` host. Every effect is injected; tests use fake
plans and runners. `onRedeemed()` runs once when the one-time code is used; an
exception from it is ignored.

- Binds `127.0.0.1` on port 0 only and asserts the bound IPv4 address; never
  `localhost`, `::` or `0.0.0.0`.
- Every request needs `Host` exactly `127.0.0.1:<port>`, otherwise 421 before
  any authorization (a missing Host included).
- Every response carries `Content-Security-Policy: default-src 'self';
  frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Cross-Origin-Resource-Policy: same-origin` and
  `Cross-Origin-Opener-Policy: same-origin`. No CORS header is ever sent; error
  bodies are generic codes such as `{ "error": "forbidden" }`.
- Session: a 32-byte random secret becomes the cookie
  `gentle_install_session` (`HttpOnly; SameSite=Strict; Path=/`). The printed
  URL `http://127.0.0.1:<port>/session?code=<code>` carries a separate random
  one-time code that expires after 2 minutes; a valid `GET /session` consumes it
  and answers 200 with a minimal HTML page that sets the cookie and refreshes
  to `/` (`<meta http-equiv="refresh" content="0; url=/">`, no script or
  style, same strict headers). It is not a 303: reached from the `file:`
  redirect page, a redirect chain counts as cross-site and the
  `SameSite=Strict` cookie could be withheld on `/`, while a navigation started
  by this same-origin page carries it. Code and cookie comparisons use
  `timingSafeEqual`. Every asset and `/api/*` request needs the cookie (401).
- A request with an `Origin` other than `http://127.0.0.1:<port>` is rejected
  (403), including GET. Every `/api/*` request, GET included, needs the header
  `X-Gentle-Install: 1` (403 otherwise, before any probe or plan rotation), so
  a cross-origin fetch always needs a CORS preflight, which never succeeds.
  POST also requires that exact Origin and `Content-Type: application/json`
  (415 otherwise).
- Bodies are limited to 1 KiB (413, by declared length and while streaming).
  Server `headersTimeout` is 10 s and `requestTimeout` 30 s.
- The host closes after 30 minutes without activity while no installation
  runs (`limits.idleMs`, checked every 15 s with the injected clock). Only a
  request with the right Host and a valid session cookie, a successful code
  redemption or a finished installation counts as activity; wrong-Host,
  unauthenticated or bad-code traffic never extends the timeout.

### Endpoints

Fixed allowlist, matched on the raw request path: anything else is 404, a
known path with another method is 405. Only `/session` and `/api/progress`
take a query string. Assets map to fixed file names in `assetsDir`; no request
path reaches the filesystem, so traversal forms (`/../`, `%2e%2e`, `%2f`) are
simply unknown paths.

| Route | Contract |
| --- | --- |
| `GET /session?code=` | Consumes the one-time code, sets the cookie and returns 200 `text/html` that refreshes to `/`; 401 for a missing, wrong, used or expired code. |
| `GET /`, `/wizard.js`, `/wizard.css` | `index.html`, `wizard.js`, `wizard.css` from `assetsDir`; 404 when absent. |
| `GET /api/plan` | Runs `collectPlan()` server-side, stores the plan under a new opaque `planId` and returns a view model: `actions` (`id` plus a fixed English description), `blockers` (`code`, `tool` — a preflight tool key such as `node` or `gentleAi`, otherwise `unknown` — and guidance), `profileChange` (whether `pnpm setup` edits the shell profile or Windows user PATH, and the bin directory), `persistence` (which of node, npm and pnpm go under `$PNPM_HOME`) and `ready`. 409 while installing. Accepts no input. |
| `POST /api/install` | Body exactly `{ "planId": string, "consent": true }` (400 otherwise, including extra keys or a plan). 409 `install-running` while an installation runs; 409 `already-completed` once an installation has a final outcome (one installation per wizard run; the outcome is never replaced); 409 `plan-changed` for a stale `planId` or when a fresh re-inventory differs from the stored plan. Otherwise 202, and the runner receives the server-stored plan with `consent: true`. |
| `GET /api/progress?after=<seq>` | Entries `{ seq, step, status, reason }` after `seq` from a ring buffer of the last 200; values outside `[a-z][a-z0-9-]*` become `unknown`, and no other runner field is kept. Also `running` and the final `outcome` with fixed guidance. |
| `POST /api/shutdown` | Body empty or `{}`. Closes the host (409 while installing). |

`guidance` (exported) holds fixed English text for every runner blocked
reason, every failed step, every preflight blocker code and both successful
outcomes, plus a generic fallback; a runner exception becomes a `failed`
outcome with the fallback. A failed `shell-setup` or `persist-path` outcome also passes the
runner's `detail` through, bounded again (string only, control and bidi
characters removed, at most 300 characters); the host drops it for any other
step. When that detail names GitHub's rate limit (`rate limit`, or `GitHub API`
together with `403`), the guidance becomes `guidance.setupRateLimit`: GitHub's
anonymous API limit was reached on this network, wait up to an hour and run the
installer again. No token or credential is ever requested. For `persist-path`,
a detail with `ERR_PNPM_UNKNOWN_SHELL` or `ERR_PNPM_UNSUPPORTED_SHELL` selects
`guidance.persistPathShell`: open a regular terminal and run the installer
again, or add `$PNPM_HOME/bin` to PATH manually. `scripts/installer-runner.mjs` exports the frozen
arrays `blockedReasons` and `failedSteps`; a test requires guidance for exactly
those entries, and the runner tests check that every reason and step their
scenarios observe is listed.

### Wizard UI

`assets/install-wizard/index.html`, `wizard.js` (an ES module) and
`wizard.css` are the whole browser side. They load only from the host itself
and follow its CSP: no inline script or style, no external fonts, images or
requests, and server strings are inserted as text nodes only (never parsed as
HTML).

| Screen | What the user sees |
| --- | --- |
| Check | Shown while `GET /api/progress?after=0` and `GET /api/plan` run. A running installation resumes the Install screen; a finished one shows its outcome instead of a new plan. |
| Review | Each fixed action with its description, the `profileChange` and `persistence` disclosures (state as text: "Will change", "No change"), one consent checkbox and **Install Gentle Shell** (for a setup recovery, "Finish setting up Gentle Shell" and **Complete setup**). Without the checkbox no request is sent; the error is announced and focus moves to the checkbox. Preflight blockers replace the plan with their guidance, **Check again** and **Close installer**. |
| Install | Expected runner steps (`expectedSteps`) with a text status (Done, In progress, Pending, Failed, Blocked, Not run), a `<progress>` bar and a terminal-style log of `{ seq, step, status, reason }` entries. |
| Done | `ready`: run `gentle-shell`. `terminal-action-required`: open a new terminal, then run `gentle-shell`. `blocked`/`failed`: the host's guidance, the reason or failed step, the steps that finished and the log. A failed `shell-setup` or `persist-path` with a detail also shows it under **Last error from gentle-shell setup** or **Last error from pnpm setup** as one plain text node (backticks stay literal). Every outcome offers **Close installer** (`POST /api/shutdown`). |

Behavior worth knowing:

- `409 plan-changed` reloads the plan, clears consent and explains why;
  `409 install-running` and `already-completed` resume the current state; 401
  or 403 ends the session with instructions to run the installer again. When
  the install request itself fails on the network, the wizard checks
  `/api/progress` once: a running or finished installation is followed
  instead of an error, and the install request is never re-sent
  automatically.
- Progress polling starts at 500 ms, backs off by 1.5× to 4 s while nothing
  changes, resets when entries arrive and stops on the final outcome. Five
  consecutive errors, or three answers that are neither running nor finished,
  stop polling and offer **Try again**. The client keeps the last 200 log
  entries, like the host.
- Accessibility: landmarks, one `h1` per screen that receives focus on each
  step change (it is not interactive, so it shows no focus ring), a polite
  `role="status"` region for progress and the closed state, an assertive
  `role="alert"` region for errors, labelled controls, native buttons and
  checkbox (keyboard operable), visible `:focus-visible` rings on every
  control, text labels for every color state, `prefers-reduced-motion` and
  `forced-colors` support.
- Visual language: the gentlemanprogramming.com dark palette (accent
  `#f095c8` on `#1a1218`) and its static hero glow behind the panel, with
  local font stacks only and a text wordmark; no logos, brand images or
  favicon are copied.

`wizard.js` exports its pure models (`planModel`, `progressModel`,
`outcomeModel`, `expectedSteps`, `installBody`, `interpretInstall`,
`nextPoll`), its renderers and `createWizard({ document, fetch, setTimeout,
clearTimeout, clipboard? })`; it starts itself only inside a page.
`tests/install-wizard.test.ts` drives the controller with a fake DOM (where
`innerHTML` throws), fake fetch and fake timers, and serves the real assets
through the real host.

### Development preview

`scripts/install-wizard-preview.mjs` starts the **real** host with the real
assets but a fake `collectPlan` and a fake runner, so it never probes the
machine, runs a package manager, downloads or installs anything:

```sh
node scripts/install-wizard-preview.mjs --scenario=terminal --step-ms=600
```

Scenarios: `ready`, `terminal` (`terminal-action-required` with runtime
persistence), `blocked` (`existing-stack`), `failed` (`install-global`),
`plan-changed` (the first plan goes stale, so the host answers 409),
`recovery` (an installed stack whose setup did not finish; ends in
`terminal-action-required`) and `preflight` (blockers, no plan). It prints the one-time session URL; Ctrl+C
or **Close installer** stops it. The preview is a development tool: it is not
listed in `installerPaths` (the entry never imports it), although it ships
with the rest of `scripts/` in the package.

### Remaining T6/T7 checks

- T6 (done): `wizard.js` and `wizard.css` are in `installerPaths`; the preview
  scenarios ran end to end in headless Chromium 1148 at 1440 and 390 px wide,
  including a keyboard-only consent and install, with no CSP violations.
  Screen readers and other browsers were not tested.
- T7: the opener on each desktop (including a missing `xdg-open`); that the
  redirect file opens in the browser rather than another `.html` handler, and
  that sandboxed browsers with a private `/tmp` (for example snap or flatpak
  packages on Linux) can read it; that a meta refresh from a `file:` page
  reaches the session and the session page's same-origin refresh to `/`
  carries the `SameSite=Strict` cookie in each browser; browsers honouring
  `SameSite=Strict` and the cookie on `127.0.0.1`; DNS-rebinding and
  cross-site request rejection in real browsers; the bootstrap's handling of
  exit 1 end to end, and exit 0 outside Linux; SIGTERM during a running
  installation; Windows `rundll32` behavior; real probe and runner execution
  through the host outside Linux.

## POSIX bootstrap: bundle-local tooling only

Run `sh scripts/bootstrap.sh` from a trusted extracted installation bundle or
checkout. There is **no published bundle URL or remote-pipe installer contract**.
The bundle must include `package.json`, both bootstrap modules and the wizard
entry `bin/gentle-shell-install.mjs`. When that entry is missing, the script
reports it before downloads or home writes. T7 owns packaging and distribution
proof.

With that entry available, the fixed sequence is:

1. Probe existing Node against the bundle's repository requirement. Unknown,
   prerelease or incompatible versions block; they are never replaced.
2. If missing, select a fixed native Node archive, download with TLS and bounded
   size/time, verify its hardcoded SHA256 using stock shell utilities, extract
   only its regular `bin/node`, and check the exact executable version before
   publishing it. Neither npm nor Corepack is acquired or invoked.
3. Reuse pnpm only after stable version, package engine and read-only global
   `add`/`bin` help-capability evidence. Engines support only simple `>=x.y` or
   `>=x.y.z` lower bounds; comparison fills an omitted patch with zero. Actual
   Node versions must remain exact stable versions; other ranges block rather
   than guess.
   Missing pnpm is acquired from a fixed registry tarball, SHA512-SRI verified,
   checked for unsafe paths/links, extracted and probed before publication.
4. Start the fixed bundle entry with the refreshed child environment. A mandatory
   acquisition/probe/child failure is an error, never installation success.

### Ownership and failure boundaries

Acquisition uses a mode-0700, uniquely created
`$HOME/.gentle-shell-bootstrap-tools.<random>` directory, with an explicit
`.bootstrap-owned` marker. This is **prerequisite tooling, not a product home**.
HOME must be absolute, owned by the current user, not group/world writable and
free of symlink ancestors. Staging and destinations reject conflicts and
symlinks. Unrelated similarly named directories are not scanned, reused or
removed. Failed attempts clean only their own private directories; successful
acquisition removes its temporary archives/staging and retains verified tools
while the wizard runs. After the wizard exits 0, the script removes the tools
directory it claimed, and the Node helper removes the one it created when only
pnpm was missing. Both removals require the exact
`$HOME/.gentle-shell-bootstrap-tools.*` name, a real directory (not a symlink)
and the `.bootstrap-owned` marker with its exact content; `rm -rf` and
`rmSync` remove links inside without following them. When removal is refused or
fails, the bootstrap still exits 0 and prints
`Bootstrap: installation finished, but temporary tools could not be removed:
<path>` on stderr.
A new attempt reuses tools only if already visible and proven on its PATH; it
does not discover or garbage-collect previous private attempts.

No profile, global PATH, existing executable installation, product agent home,
Engram state or companion installation is changed. Added paths affect only the
bootstrap and its child. T4 must implement standard global installation and the
persistent **ordinary terminal** handoff; these private wrappers are not that
handoff. Existing unverifiable pnpm wrappers/binaries block instead of being
silently replaced. No sudo or security exclusions are requested.

Stock utilities are prerequisites, not silently installed: POSIX sh, awk,
dirname, uname, mkdir, mktemp, chmod, mv, rm, sleep, wc, id and ls; missing Node
also needs curl, tar and sha256sum or shasum. Linux acquisition additionally
requires getconf evidence of glibc >=2.28. Missing pnpm requires tar. Missing
utilities are reported. Shell executable-version probes have a 10-second
watchdog, hash/archive probes 30 seconds; curl has a 10-second connection and
120-second total limit with a 100-MiB artifact cap. A subprocess-only `ulimit -f`
adds a hard disk ceiling (at most 200 MiB depending on shell block units) for
older curl implementations; failure to establish it blocks acquisition.
The JavaScript transport rejects
redirects, caps pnpm at 32 MiB and aborts after 60 seconds; process checks have
15-second/1-MiB bounds. At a prerequisite-process deadline, the shell watchdog
and Node process adapter send SIGKILL to their directly spawned child, rather
than catchable SIGTERM. A killed probe is a failure even if it printed valid
output before hanging. Shell watchdog cancellation also kills and waits for its
owned sleeper. The interactive wizard child intentionally has no total runtime
timeout. Raw downloader/process error text is not logged.

### Artifact trust and shared helper API

| Artifact | Acquisition pin and provenance |
| --- | --- |
| Node native darwin/linux x64/arm64 | 24.21.0; parent-verified SHA256 entries from [official SHASUMS256](https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt), applied to fixed [v24.21.0 archive URLs](https://nodejs.org/dist/v24.21.0/). |
| pnpm JavaScript CLI | 11.1.1; parent-verified raw engine `>=22.13` (comparison minimum `22.13.0`), tarball and SHA512 SRI from [registry version metadata](https://registry.npmjs.org/pnpm/11.1.1); [fixed tarball](https://registry.npmjs.org/pnpm/-/pnpm-11.1.1.tgz). |

POSIX/pnpm integrity values live in `installer-downloads.mjs`; Windows Node
values live in `installer-windows-artifacts.json`. The shell copies
only Node's acquisition pin/hashes because first acquisition cannot depend on
Node. Tests cross-check shell selection against the shared descriptors. Changing
these pins requires renewed primary-source integrity evidence and updating both
Node representations together. There is no live latest resolution. The pnpm pin retains the exact raw upstream
engine string for metadata identity checks; only version comparisons normalize
its supported partial minimum. Product versions/minima remain repository-derived;
the pnpm pin is not a compatibility
minimum. Registry-hosted artifacts do not imply using the npm executable.

`scripts/installer-downloads.mjs` exports `artifactFor(name, platform, arch)`
(frozen allowlisted descriptors), `verifiedDownload(name, adapters, platform,
arch)` (verified bytes), `compatibleEngine(range, version)`,
`ensurePnpm({ tools, env, nodeVersion, adapters })` and
`launchWizard({ bundle, env })`. Only known artifact names are accepted, not
caller URLs/checksums/commands. Trusted local test adapters inject byte download,
digest and process checks; they are not exposed through any browser interface.
The caller owns a private `tools` directory. `ensurePnpm` returns `{ env,
acquired }`, leaving the supplied environment unchanged. The Windows adapter reuses descriptors/integrity verification without changing
POSIX process semantics, defaults or pins.

### Evidence, not platform certification

Native shell execution was exercised on this Linux host with disposable Unicode
and whitespace paths, fake OS/download/hash/archive utilities and injected
JavaScript acquisition/process adapters. No real network or host prerequisite
installation was performed. Darwin selections are simulated, **not native
macOS execution**. Native macOS, Linux clean-machine/loader and minimum macOS
version acceptance remain T7 work. Linux acquisition is native glibc-only:
musl/Alpine and emulation/Rosetta compatibility are not claimed. Node's
[upstream build/platform requirements](https://github.com/nodejs/node/blob/v24.21.0/BUILDING.md)
remain the platform reference; successful descriptor planning alone proves no
OS/kernel/libc support.

### Subprocess deadline evidence

The regression fixtures exercise production process paths without shortened
production timeouts or a mocked process adapter:

| Path | Observed Linux fixture behavior |
| --- | --- |
| Shell acquired-Node version probe | A single Node process prints the expected version, ignores TERM and waits without busy-looping. The real 10-second watchdog kills/reaps it, rejects acquisition and removes owned tooling while preserving an unrelated HOME file. |
| Node helper tar probe | Fake verified bytes feed `ensurePnpm`, but its default process adapter runs a real single-process TERM-ignoring tar stand-in. The real 15-second deadline kills/reaps it, rejects acquisition and removes owned staging while preserving an unrelated file. Ordinary nonzero tar exit also rejects and cleans staging. |

Before correction, both paths exceeded their deadlines and needed the test
harness's independent outer SIGKILL guard (13 seconds for shell, 18 for Node).
The guard kills only each freshly created detached fixture group and also
cleans residual fixture processes on exit. Production does **not** kill groups,
match process names or use an external timeout utility. After correction, both
probe PIDs are reaped before their parents return; neither outer guard fires.
Ordinary success remains covered by the existing reuse/acquisition tests.

These are **direct-child, non-forking probe** guarantees, not process-tree
cancellation evidence. Unknown programs that fork descendants retaining stdio
may keep pipes open; this unit does not claim bounded return or descendant
cleanup for those programs. The fixtures prove neither native macOS behavior
nor live artifact acquisition. Independent verification and native review remain
separate parent-owned gates.

## Windows foundation: fixed commands, no policy repair

Run `scripts\bootstrap.cmd` from a trusted extracted bundle or checkout. Like
POSIX, it stops before acquisition or home writes when the wizard entry
`bin/gentle-shell-install.mjs` or any Windows-dependent helper/metadata file is
missing. There is no published bundle URL or remote-pipe contract, and the
Windows bootstrap end to end still lacks native acceptance evidence.

| Step | Windows contract |
| --- | --- |
| Entry | Small CMD entry invokes fixed stock Windows PowerShell commands with no profile. Paths are environment data, not interpolated PowerShell source. Delayed CMD expansion is disabled. |
| Storage | Claim a new random-named prerequisite directory below LOCALAPPDATA, never reuse an existing destination. Verify each path component's reparse attributes, owner and role-specific ACL rights. Protect the claimed directory's DACL for the invoking SID, SYSTEM and Administrators, and read it back. |
| Node | Reuse a proven stable existing Node ≥24.3.0 and the repository minimum. Otherwise acquire only the fixed official Node 24.21.0 Windows x64/arm64 ZIP, with no redirects and bounded transport, verify SHA256 before opening the archive, validate the whole namespace and extract only regular `node.exe`. |
| pnpm | Reuse only a fully recognized npm CMD shim with package identity, bin target, stable CLI version, compatible engine and global add/bin help evidence. Preserve its sibling-Node preference or prove its inherited cwd/PATH/PATHEXT Node selection. Never execute the shim via cmd.exe. Unknown wrappers block without replacement. |
| Missing pnpm | Shared pnpm 11.1.1 URL/SRI and raw `>=22.13` engine identity are unchanged. Parse bounded gzip/USTAR bytes, reject unsupported extensions, links and unsafe Windows namespaces before no-clobber publication. Return a direct Node + JS-entry invocation; do not fabricate a wrapper. |
| Handoff | Existing Node helper starts the fixed wizard entry `bin/gentle-shell-install.mjs`. Only child PATH is refreshed. No persistent PATH, global installation, product root or companion installation is created here. |

Windows Node SHA256 provenance is the parent's fresh primary-source read of
[24.21.0 SHASUMS256](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt). A narrow
JSON metadata file lets pre-Node PowerShell and the shared Node helper consume
the same Windows pins without mixing the POSIX archive format or copying pnpm
integrity into another runtime. Pin changes still require fresh primary evidence.

### T4/T5 integration contract

`scripts/installer-windows.mjs` exports:

- `ensureWindowsPnpm({ tools, env, node?, adapters? })` → `{ acquired, env,
  command, prefix }`. Invoke `[command, ...prefix, ...args]` with `shell:false`;
  keep the returned environment. `tools` must be a private attempt-owned root.
  Test adapters are trusted local code only, never a browser API.
- `bootstrapWindows({ bundle, tools, env })` validates fixed bundle files and
  requirements, acquires/reuses pnpm, then delegates to shared `launchWizard`.
  CLI entry is `installer-downloads.mjs --bootstrap-windows BUNDLE TOOLS`.
- T5 receives `GENTLE_INSTALL_PNPM_NODE` and `GENTLE_INSTALL_PNPM_ENTRY` as data
  for that proven direct invocation. T4 must re-inventory before installation;
  these values are not an arbitrary command API or persistent terminal repair.
- Storage, namespace, wrapper, tar and bounded process functions are exported
  for focused verification. Production storage verification requires native
  Windows and fixed stock PowerShell ACL commands, never POSIX mode/UID evidence.

Go preparation is deliberately **not implemented or invoked** in this unit.
The standard installation runner blocks on Windows unless preflight reports a
reusable Go ≥1.25.10, because gentle-pi's postinstall may build Gentle AI from
source; it never acquires Go or treats an explicit override as native-package
evidence.

### Policy, bounds and evidence limits

No unsigned `.ps1` file, script-file evaluation, execution-policy relaxation,
file unblocking, certificate/TLS bypass, elevation, security exclusion or profile
change is used. Restricted permits individual commands; it is not every Windows
client's default. [Execution policies](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies)
do not override [AppLocker CMD/BAT rules](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/script-rules-in-applocker)
or [managed App Control constraints](https://learn.microsoft.com/en-us/powershell/scripting/security/app-control/how-app-control-works).
ConstrainedLanguage and any download/execution denial stop with an error. There
is no fallback intended to evade those controls; if CMD itself is denied, the
OS owns the denial diagnostic before our entry can run.

Node transport is capped at 100 MiB with a 60-second request/total elapsed check
and 10-second blocking-read timeout. A blocking read can consume up to that last
read timeout beyond the elapsed check. ZIP metadata caps expanded size at 512 MiB
and the selected executable at 150 MiB. Namespace checks reject traversal,
backslashes, links/reparse attributes, duplicate/case-aliased names, conflicting
file/directory parents, devices, ADS and trailing dots/spaces. Shared pnpm
transport remains 32 MiB/60 seconds; tar expansion is capped at 128 MiB.
Unsupported archive extensions fail closed. **Actual pnpm 11.1.1 TGZ acceptance
is unproved:** it requires an integrity-backed offline copy of the pinned
artifact, not a synthetic USTAR fixture or an injected digest. No such evidence
was supplied and no acquisition is authorized in this correction.

The pre-Node probe drains both pipes with a combined 1-MiB cap and kills only
its direct child at 10 seconds, with a bounded one-second final wait. Node helper
probes use the shared 15-second/1-MiB-style bounds and an unignorable direct-child
kill. Valid output followed by a hang is a failure. Production never kills
process groups or unrelated processes. Forked descendants retaining stdio are
outside the guarantee; the interactive wizard has no total deadline.

### Target-versus-ancestor ACL boundary

For untrusted SIDs, the fixed predicates allow ReadAndExecute plus Synchronize
(`0x1200a9`), with one narrow directory-specific distinction:

| Role | Mutation boundary |
| --- | --- |
| Actual file/executable or owned tooling root (depth 0) | No write, deletion, child-deletion, ACL or ownership rights. |
| Immediate parent (depth 1) | Same strict protection, including no CreateDirectories/AppendData. A new tooling claim starts checking its parent at this depth. |
| Distant **existing directory** (depth ≥2) | May additionally allow CreateDirectories/AppendData (`4`) for sibling-only creation. WriteData/CreateFiles, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, WriteDACL, TakeOwnership, generic/unknown rights still reject. |

Directory CreateDirectories and file AppendData share an enum bit; a distant
ancestor here must actually be an existing directory. This is not permission to
append to an executable. Reparse checks, trusted ownership and every actual path
component remain mandatory. An inheritable ACE is checked again where it becomes
effective on the descendant; InheritOnly does not grant rights on its current
object. Effective unsafe allow ACEs block even when deny ACEs might otherwise
limit them: this is a conservative mutation boundary, not a general Windows
ACL/access-check framework. Trusted SIDs and protected-DACL readback are unchanged.
The portable fixture model checks parity with all three fixed production
predicates; it does not execute Windows ACL APIs or claim prevalence on Windows.

Failure cleanup targets only the directory claimed by the actual attempt;
collisions and unrelated storage are not removed. Prerequisite tools remain
available to children while the wizard runs. After the helper exits 0, a final
stage removes the claimed root only when its full path is a direct child of
`%LOCALAPPDATA%` named `.gentle-shell-bootstrap-tools.*`, neither it nor its
`.bootstrap-owned` marker is a reparse point, and the marker holds the exact
text. It uses `[IO.Directory]::Delete(path, true)`, which does not recurse
through reparse points, instead of Windows PowerShell 5.1 `Remove-Item`. A
refusal or failure prints the same notice with the path and still exits 0. ACL/ancestor checks are conservative and may
reject managed/nonstandard layouts rather than relax security. They do not
claim protection from a malicious process running as the same principal or an
administrator, nor eliminate same-principal time-of-check/time-of-use races.

### Claim reason codes and 8.3 short paths

A rejected storage claim keeps its user-facing message and appends one fixed
code naming the failed check, for example `... policy denied it. Reason: home-owner`.
The code never contains a path, SID or exception text. Intentional rejections
report their own code:

| Code | Rejected check |
|------|----------------|
| `policy` | PowerShell is not in FullLanguage mode. |
| `path-mismatch` | `%LOCALAPPDATA%` is not rooted, the target is UNC, or the target's parent is not exactly `%LOCALAPPDATA%`. |
| `home-owner` | `%LOCALAPPDATA%` is not owned by the invoking SID. |
| `ancestor-reparse` | An ancestor is not a directory or is a reparse point. |
| `ancestor-owner` | An ancestor owner is not the invoking SID, SYSTEM, Administrators or TrustedInstaller. |
| `acl-mask` | An untrusted effective allow ACE exceeds the depth's allowed rights mask. |
| `collision` | The random destination already exists; it is never reused or changed. |
| `protected-dacl` | The readback DACL is not protected from inheritance. |
| `private-owner` | The readback owner is not the invoking SID. |
| `private-ace` | The readback holds a deny ACE or a SID other than the invoking SID, SYSTEM or Administrators. |

Any other exception, such as an unreadable ACL, a denied write or a failed
cmdlet, reports `unexpected-<step>` for the step that was running, so it can
never pose as an intentional rejection:

| Step | Work in progress |
|------|------------------|
| `unexpected-policy` | Language mode and identity lookup. |
| `unexpected-path-mismatch` | Path normalization. |
| `unexpected-home-owner` | Reading the `%LOCALAPPDATA%` owner. |
| `unexpected-ancestor-walk` | Reading an ancestor's attributes or ACL. |
| `unexpected-create` | Creating the new directory, including a destination that appeared after the collision check. |
| `unexpected-private-acl` | Writing or reading back the private DACL. |
| `unexpected-marker` | Writing the ownership marker. |

The Node probe stage follows the same contract. Its message is unchanged and
ends with `Reason: <code>`. Walk codes are prefixed with the role of the path
component that failed: `target` (`node.exe` itself, depth 0), `parent` (its
directory, depth 1) or `ancestor` (depth 2 and above). The role is fixed text,
never the path.

| Code | Rejected check |
|------|----------------|
| `policy` | PowerShell is not in FullLanguage mode. |
| `missing-target` | The `.node-target` record is absent, not a file, or empty. |
| `unsafe-target` | The recorded Node target is a directory or a reparse point. |
| `unsafe-path` | The recorded Node target is not rooted, or is UNC. |
| `<role>-reparse` | A walked component is a reparse point. |
| `<role>-owner` | A walked component's owner is not the invoking SID, SYSTEM, Administrators or TrustedInstaller. |
| `<role>-acl-mask` | An untrusted effective allow ACE on a walked component exceeds its depth's allowed rights mask. |
| `no-start` | The process did not start. |
| `deadline` | Node did not exit and close both pipes within 10 seconds. |
| `output-limit` | Combined stdout and stderr exceeded 1 MiB. |
| `exit-code` | Node exited with a nonzero code. |
| `version-format` | `node --version` did not print exactly `vMAJOR.MINOR.PATCH`. |
| `engine` | The version is below 24.3.0 or the repository `engines.node` floor. |
| `acquired-version` | A Node acquired by this bootstrap is not exactly v24.21.0. |

Any other exception reports `unexpected-<step>`: `unexpected-policy`,
`unexpected-target` (reading the recorded target), `unexpected-acl-walk`
(reading a component's attributes or ACL), `unexpected-start` (for example, an
application-control denial while starting the process), `unexpected-drain`
(reading the pipes) or `unexpected-version` (reading the repository metadata).
A child that cannot be confirmed terminated keeps its separate
`direct-child termination could not be confirmed` message.

The `.node-target` record holds a full path, which may contain non-ASCII text,
for example a user profile such as `C:\Users\José` or the Unicode native
fixture root. Windows PowerShell 5.1 writes `New-Item -Value` content as
BOM-less UTF-8 but reads `Get-Content` without a BOM as the ANSI code page, so
such a path came back corrupted and the probe failed with `unexpected-target`.
The record is now created no-clobber with `[IO.File]::Open(..., CreateNew)` and
explicit BOM-less UTF-8 bytes, and the probe and launch stages read it with
`[IO.File]::ReadAllText(path, [Text.Encoding]::UTF8)`. The other bootstrap
records (`.bootstrap-owned`, `.node-stem`) hold fixed ASCII text and keep their
cmdlets.

The Node helper (`installer-downloads.mjs --bootstrap-windows`) follows the same
contract. Its failure line is unchanged and ends with `Reason: <code> (<step>)`
for an intentional rejection, or `Reason: unexpected-<step>` for any other
error, such as a file-system, JSON or spawn error. A value without that fixed
shape, including a failed module import, prints `Reason: unexpected-helper`.

| Step | Phase |
|------|-------|
| `bundle` | Native platform, bundle files and repository Node/pnpm metadata. |
| `tools-storage` | ACL walk of the claimed tools directory. |
| `pnpm-discovery` | CMD-equivalent search of the current directory, `Path` and `PATHEXT` for `pnpm`. |
| `wrapper-storage`, `wrapper` | ACL walk and exact npm cmd-shim proof of the found `pnpm.cmd`. |
| `node-discovery` | The wrapper's sibling `node.exe`, or `node` on `Path`. |
| `node-storage`, `entry-storage`, `metadata-storage` | ACL walk of the selected Node, the pnpm entry and its `package.json`. |
| `package` | The pnpm `package.json` binary target. |
| `cli-proof` | `node --version`, `pnpm --version` and the `add`/`bin` global capability. |
| `tools-check`, `download`, `archive`, `publish` | Pinned pnpm acquisition when no `pnpm` was found. |
| `launch` | The bundle wizard entry and its exit code. |

Codes: `native-unavailable`, `bundle-missing`, `prerequisite`, `unsafe-path`,
`acl-evidence`, the storage walk codes `policy` and
`<target|parent|ancestor>-<reparse|owner|acl-mask>`, `cwd-search`,
`path-missing`, `pathext`, `path-entry`, `extensionless`, `wrapper-unknown`,
`wrapper-unproven`, `wrapper-node`, `wrapper-target`, `package-target`,
`pnpm-engine`, `pnpm-version`, `pnpm-capability`, `process-failed`,
`interpreter`, `unsafe-tools`, `pnpm-conflict`, `archive`, `pnpm-pin`,
`pnpm-entry`, `acquisition`, `wizard-missing`, `wizard-start` and
`wizard-exit`. For example, `parent-owner (wrapper-storage)` means the
directory holding `pnpm.cmd` has an untrusted owner. The helper's storage check
prints `unsafe:<code>` for a walk rejection and still accepts only exact `safe`;
any other PowerShell exception exits nonzero and reports `unexpected-<step>`.

`.CPL` deserves a note. Windows PowerShell 5.1 appends `.CPL` to `PATHEXT` in
its own environment, so its children see
`.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.CPL` even when CMD did
not. The bootstrap always starts the helper from Windows PowerShell, and native
CI showed the old discovery allowlist rejecting every Windows run with
`pathext (pnpm-discovery)`. `.cpl` is now a known extension, but not an
accepted candidate. Discovery keeps the CMD order (current directory, then each
`Path` entry, then `PATHEXT` order within a directory). A `pnpm.cpl` found
before the real `pnpm.cmd` stops with `wrapper-unknown (wrapper)`, and a
`node.cpl` found before `node.exe` stops with `wrapper-node (node-discovery)`;
neither is skipped or executed. Any other unknown, duplicate or empty
`PATHEXT` extension still fails with `pathext`.

The wizard inherits the same environment. The runner's `lookPath` (Go
`exec.LookPath` order) and the host probes accept any `PATHEXT` extension and
already refuse a `.cpl` result: npm reports `npm-shadowed`, and Node or Go
resolving to a non-`.exe`/`.com` file reports unknown without running it.

ACLs are read and written with .NET Framework APIs
(`[IO.Directory]::GetAccessControl`, `[IO.File]::GetAccessControl`,
`[IO.Directory]::SetAccessControl`) instead of `Get-Acl`/`Set-Acl`. Those
cmdlets live in Microsoft.PowerShell.Security, which Windows PowerShell 5.1
autoloads from `PSModulePath`. Started from a PowerShell 7 terminal (or the
GitHub Actions `pwsh` step shell), the inherited `PSModulePath` lists
PowerShell 7's Core-only copy first, and 5.1 fails with
`CouldNotAutoloadMatchingModule`. The checks themselves are unchanged: the
same owner, mask, protected-DACL, readback and reparse predicates in the same
order. The bootstrap still uses cmdlets from Microsoft.PowerShell.Management
(`Get-Item`, `Get-Content`, `New-Item`, `Remove-Item`, `Test-Path`,
`Join-Path`) and Microsoft.PowerShell.Utility (`New-Object`, `ConvertFrom-Json`,
`Get-FileHash`, `Add-Type`, `Select-Object`, `Start-Sleep`). The native fixtures
observed both modules loading under the same `pwsh` parent, and a module loads
as a unit. `Get-Command` is built into the engine.

The path comparison is insensitive to 8.3 short names by construction: both
sides derive from the same `%LOCALAPPDATA%` string and pass through
`[IO.Path]::GetFullPath`, so a short `%LOCALAPPDATA%` or `%TEMP%` is never
compared with a long canonical form. The host probe adapter's `realpath` is the
native call and returns the long form, for example `C:\Users\runneradmin\...`
for a `%TEMP%` exposed as `C:\Users\RUNNER~1\...`; tests compare it with
`realpathSync.native`, not the JavaScript `realpathSync`, which keeps short
names.

An earlier CI run reported `home-owner` for every native claim. The actual
cause was this module-load failure, reported as the step that was running;
`unexpected-<step>` now separates the two. The `home-owner` check requires
`%LOCALAPPDATA%` to be owned by the invoking SID itself, not by a trusted
group. A real `%LOCALAPPDATA%` created by the User Profile Service is owned by
the user. Elevated members of Administrators on Windows Server may create new
directories owned by BUILTIN\Administrators, depending on the default-owner
policy. The native fixtures therefore set the invoking SID as owner of the
fixture root and of every fixture directory used as `LOCALAPPDATA`, read the
owner back, and fail loudly before any production stage runs. Production is
unchanged: a real user whose `%LOCALAPPDATA%` is owned by Administrators fails
closed with `home-owner` and no storage is claimed.

### Implemented fixtures versus missing execution evidence

The native gates now contain runnable assertions, not empty or always-skipped
callbacks. They run on Windows without a pending-fixture override:

- Actual production claim/check predicates: protected-root creation, collision
  preservation, harmless distant sibling creation, dangerous-right refusal,
  strict target/immediate-parent checks and junction rejection. Junction creation
  alone can be capability-skipped after an actual permission/unsupported error.
  DACL changes are limited to new disposable fixture-owned objects.
- Actual fixed PowerShell ZIP namespace/publication stage: local ZIPs with the
  fixed archive/member identity; valid publication and traversal, aliases,
  symlink/reparse attributes, ADS, devices, trailing names and parent conflicts.
  The valid member contains the available fixture Node's unchanged bytes and is
  never executed. Collision tests preserve unrelated published storage.
- Actual pre-Node process primitive: approved Node executes local fixture JS;
  nonzero exit, both output limits, quiet/stdout/stderr/both-pipe hangs and valid
  output followed by a hang are rejected. Production drain/deadline/validation/
  cleanup lines are unchanged. An independent hard guard checks recorded process
  creation ticks and only kills fresh fixture-owned handles. A guard firing or
  finding a residual recorded child is a test failure, not successful deadline
  evidence; fixture cleanup cannot mask a missing production reap.
- Complete local sentinel composition exercises CMD continuation/quoting,
  bundle checks, claim, existing-Node resolution/probe, real helper pnpm handoff
  and late cleanup with spaces, Unicode and CMD metacharacters. Only the approved
  available Node's unchanged bytes are cloned into the disposable fixture PATH,
  excluding operator npm/Corepack/pnpm shims. A local JS pnpm fixture provides
  read-only identity/help responses. The trusted fixture helper copy has a fixed,
  fail-only fetch guard: accidental acquisition throws before any network call;
  it never supplies bytes/digests or adds a production integrity-bypass switch.
  No network/install occurs.

The fixtures preserve the exact production command lines and insert only
fixture-owned process observations. They compose primitives in a disposable
`.cmd`, not a loaded/evaluated PowerShell script file. Native AppLocker and
ConstrainedLanguage denials still apply, with no policy relaxation. This is
**stage/composition evidence, not uninstrumented whole-entry certification**:
transport/integrity gates and the real pinned artifacts require separate proof.
The original missing-entry test also exercises the unchanged whole entry.

All these native fixtures are **implemented but unrun on this Linux host**:
Windows PowerShell and a Windows runner are unavailable. Portable descriptor,
ACL-predicate model, tar, wrapper and process fixtures are not native Windows
proof. Native OS/ACL/CMD/loader acceptance remains T7 evidence work; the actual
pinned pnpm TGZ offline acceptance remains an explicitly unfinished evidence
item. No live artifact was downloaded/executed, operator-home installation
performed, operator/global ACL or policy changed, or Windows OS minimum/support
claimed. No same-principal-adversary or forked-descendant guarantee is made.
T7 must establish those facts before advertising clean-machine support.

## Clean-machine acceptance (T7)

### Linux clean container

A disposable `debian:bookworm-slim` container without Node, npm, pnpm, Pi or
Gentle Shell, driven as a non-root user, passed end to end:
`sh scripts/bootstrap.sh` exited 0 and the wizard, driven over HTTP exactly as
the page does, reached `terminal-action-required` with all 13 runner steps
`done` in about 27 seconds. A fresh `bash -ic` resolved `node` v24.21.0, `npm`
11.19.0 and `pnpm` 11.1.1 from `$PNPM_HOME/bin`, and `gentle-shell --version`
reported 4.0.0 with Pi 1.0.0 and the isolated home `~/.gentle-shell/agent`.
That run predates the removal of bootstrap tools after success.

The first run of `scripts/test-installer-acceptance.sh --worktree` (with the
tools removal, not yet committed) did **not** pass: the bootstrap acquired its
tools and printed the session URL after 113 seconds, the plan had no blockers,
and 11 runner steps finished `done` before `shell-setup` (`gentle-shell setup`)
failed; the outcome was `failed`, the bootstrap exited 1 and removed its tools
through the failure path, after 146 seconds in total. A separate diagnostic
container proved the cause: `gentle-shell setup` failed with `Error: execute
install pipeline: download engram binary: fetch latest engram version: GitHub
API returned HTTP 403` because the anonymous GitHub API quota of this network
was exhausted. After the quota reset, setup in the same container exited 0
without installing any extra package. It was not caused by the tools removal,
which only runs after the wizard exits. See
[GitHub API limit during setup](#github-api-limit-during-setup).

The second run (with the quota precheck: 43 anonymous requests left) got past
that: `shell-setup` finished `done`, then the last step, `persist-path`
(`pnpm setup`), failed. The installation part took about 34 seconds, so it was
not its 30-second deadline alone. The outcome was `failed`, the bootstrap exited
1 and removed its tools through the failure path; 147 seconds in total. Cause:
the script started the bootstrap with `docker exec ... sh -c`, which exports no
`SHELL`, while the passing lab run had `SHELL=/bin/bash`; `pnpm setup` then
cannot pick a profile (see `persist-path` above). A real terminal exports
`SHELL`, so the script now passes `SHELL=/bin/bash` to the bootstrap, and a
failed `persist-path` now reports pnpm's error line and SHELL guidance.

The third run, with `SHELL=/bin/bash`, **passed**: 23 anonymous GitHub
requests left before it, session URL after 113 seconds, all 13 runner steps
`done` including `shell-setup` and `persist-path`, outcome
`terminal-action-required`, bootstrap exit 0; 142 seconds for bootstrap and
wizard, 147 in total. A fresh `bash -ic` resolved `node` v24.21.0, `npm`
11.19.0, `pnpm` 11.1.1 and `gentle-shell` from `~/.local/share/pnpm/bin`;
`gentle-shell --version` reported 4.0.0, Pi 1.0.0 and the isolated home
`~/.gentle-shell/agent`; no `~/.gentle-shell-bootstrap-tools.*` directory
remained, so the success-path tools removal is proven in a clean container.
`bash -lc` did not resolve `gentle-shell`, as documented below.

To reproduce it, run `sh scripts/test-installer-acceptance.sh` from the
repository. It refuses to start without a working Docker daemon and never runs
the installer on the host or touches the host HOME. It starts a container
(`--pull missing`), installs only `ca-certificates` and `curl`, creates the
user `tester`, then queries `https://api.github.com/rate_limit` from inside the
container (this endpoint does not consume quota) and stops before the
bootstrap, printing the reset time, when fewer than 5 anonymous core requests
remain. It then copies the bundle to `/opt/bundle` (`git archive HEAD`, or the
tracked working-tree files including uncommitted changes with `--worktree`) and
runs the bootstrap. A headless driver inside the container redeems
`/session?code=` with a cookie jar, sends `X-Gentle-Install: 1` on every
`/api/*` request and the same Origin plus `Content-Type: application/json` on
every POST, then requests the plan, consents, polls progress and shuts the host
down. It then checks, in a fresh `bash -ic`, that `node`, `npm`, `pnpm` and
`gentle-shell --version` resolve and that no `~/.gentle-shell-bootstrap-tools.*`
directory remains, and reports whether `bash -lc` resolves `gentle-shell`. The
container is removed on every exit unless `GENTLE_ACCEPTANCE_KEEP=1` keeps a
failed one for inspection; the pulled image stays cached. Network
access happens only inside the container. The installation is bounded by
`GENTLE_ACCEPTANCE_INSTALL_SECONDS` (default 1500). CI does not run it.

### GitHub API limit during setup

`gentle-shell setup` runs upstream Gentle AI's install pipeline, which looks up
the latest Engram version through the GitHub REST API without authentication:
2 anonymous requests per setup. GitHub allows 60 anonymous requests per hour
per public IP address, so machines sharing one address (offices, NAT, VPNs, CI
runners, repeated test runs) can exhaust it; setup then fails with
`GitHub API returned HTTP 403` and the wizard shows the rate-limit guidance and
that error line. Waiting for the hourly reset is enough; nothing has to be
uninstalled first: rerunning the installer finds the installed stack and runs
only its [setup recovery](#setup-recovery).

A missing `git` only produces a warning during setup; it was not the cause.

Upstream advisory for Gentle AI (not changed here): pin the Engram version or
fall back to it when the lookup fails, accept an optional `GITHUB_TOKEN` for
the lookup, and replace the misleading "installed via go install" message that
accompanies this failure.

### Shell profiles after `pnpm setup`

`pnpm setup` writes `PNPM_HOME` and its PATH entry into the interactive shell's
profile only: `~/.bashrc` for bash on Debian. Debian's `~/.bashrc` returns
early for non-interactive shells, and login shells read `~/.profile`, so these
do not find `gentle-shell`, `node`, `npm` or `pnpm`:

- non-interactive login shells such as `bash -lc '...'`, and tools or IDE tasks
  that start one;
- `ssh host command`: bash reads `~/.bashrc` but stops at its non-interactive
  guard, so the lines must sit above that guard (or the command must use an
  absolute path);
- cron jobs, which read neither file: set PATH in the crontab or use absolute
  paths.

For login shells, add the same lines to `~/.profile` manually (the wizard does
not edit it), using the `PNPM_HOME` that `pnpm setup` wrote, for example:

```sh
export PNPM_HOME="$HOME/.local/share/pnpm"
case ":$PATH:" in *":$PNPM_HOME/bin:"*) ;; *) export PATH="$PNPM_HOME/bin:$PATH" ;; esac
```

### Upstream `~/.pi/gentle-ai`

Gentle AI's setup creates an empty `~/.pi/gentle-ai` directory outside the
isolated Gentle Shell home `~/.gentle-shell/agent`. This is upstream behavior;
the installer neither relies on nor removes it.

### CI matrix

The `installer` job in `.github/workflows/ci.yml` runs the installer suites with
Node 24 on `ubuntu-latest`, `macos-latest` and `windows-latest`. The native
Windows tests in `tests/installer-windows-bootstrap.test.ts` are gated on
`process.platform === "win32"`, so they run on the Windows runner and skip
elsewhere; the POSIX shell fixtures in `tests/installer-posix-bootstrap.test.ts`
skip on Windows. CI only runs after a push, which remains a user decision.

### Remaining T7 checks

- real browsers and screen readers (only headless Chromium was used);
- native macOS and Windows clean machines, including the Windows bootstrap
  end to end and its tools removal;
- `pnpm setup` and fresh-terminal resolution in zsh and fish;
- SIGTERM during a running installation;
- reinstalling over an existing stack;
- download-time integrity of the Node runtime and the npm and pnpm packages
  fetched during persistence;
- the earlier T4/T5/T6 items listed above that the Linux run does not cover.
