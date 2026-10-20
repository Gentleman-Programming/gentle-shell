# Named environments (`gentle-shell envs` / `--env`)

## Objective
Let users keep several named agent homes ("envs"), pick one to open a session in (`gentle-shell --env <name>` or the `gentle-shell envs` manager), see which one is active, and choose per env which parts of Gentle's own configuration it shares with the base home, like VS Code profiles.

## Problem and why
A separate home needs `--home <path>` every time, with no names, no overview of what each home holds, and no visible active home. Gentle's own configuration (`~/.pi/gentle-ai`) is always shared, so homes cannot differ in model profiles, persona, appearance or behavior.

## Decisions
- Surface: `gentle-shell envs` (a full-screen manager on a TTY, a list otherwise), `envs list|new|config`, and the `--env <name>` launch flag.
- Storage: managed directories `~/.gentle-shell/envs/<name>/` (`GENTLE_SHELL_ENVS_DIR` overrides the root). The directory is the registry. Names are `[a-z0-9][a-z0-9._-]{0,39}`.
- Compatibility first: the install's own `--isolated` home stays the base home and is listed as `Gentle Shell base`. The default reuses the persisted `home` key (`isolated` or an env path). `--env` never creates an unknown env.
- The session shows the active env: `env <name>` in the header and an `Env` group above `Project` in Status, passed as `GENTLE_SHELL_ENV` only for named envs.
- Per-env Gentle configuration by category (`models` = routing + profiles, `persona`, `appearance`, `behavior`): each one is shared live with the base home, or an own copy in `<env>/gentle-ai/` seeded once (copied from the base home or another env, or empty). Install-level files and repository settings stay shared. Envs without a scope file share everything.
- Out of scope: per-env Engram memory stays shared for now.

## Delivery
Chained PRs on `main`:
1. `feat/named-envs-core`: `--env`, `envs list|new`, the session indicator, and uninstall protection (bundled and non-bundled).
2. `feat/named-envs-gate`: the `envs` manager with Gentle's visual identity, the base home entry, and `(default)` markers.
3. `feat/named-envs-config`: per-category config resolution (every config-home read names its category, enforced by a drift-guard test), `envs config`, and the VS Code-like form.

Separate: `feat/installer-download-progress` (TTY download progress for the package-local Gentle AI binary).

## Evidence
- Test-first for every unit: launcher parsing/resolution, env model, manager reducer/renderer, config scope, bin and bundled-prefix integration.
- Manual checks in a pty: create, default, rename, delete, open, install, the branded gate, the session indicator in a real Pi session, and the config form.
- Real macOS standalone install from the published installer, with these branches overlaid: env CLI, gate, session indicator, uninstall plan ("your named envs"), and an env owning `models` showing its own profile while the base home keeps the shared one.
- No new failures in the touched extension suites compared with `main` (the remaining failures are pre-existing).

## Known gaps
- Windows is untested: the raw-mode manager, the bundled Windows prefix, and the envs root.
- Prompt history still ignores the active home (#1618), so history mixes across envs until that is fixed.
