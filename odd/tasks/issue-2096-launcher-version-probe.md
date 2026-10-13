# Issue #2096: skip the redundant pi --version spawn on every gentle-shell launch

Every `gentle-shell` launch runs a synchronous `spawnSync(... "--version")` against the resolved pi runtime, adding ~1s on Windows. For `kind === "bundled"` the version is already available in memory (package.json / pinned dependency). For `kind === "env"` and `kind === "path"` the probe still needs a real spawn, but repeated unchanged binaries can be cached.

## Specs

- S1 (issue body): "On every launch, `bin/gentle-shell.mjs` `main()` runs a synchronous version probe before starting the real session ... That boots a complete second Node process plus the pi CLI bundle only to print a version string, and blocks startup until it exits."
- S2 (issue body, expected behavior): "for `runtime.kind === 'bundled'`, read `version` from the bundled package's `package.json` (no process needed), and/or cache the probed version keyed by the resolved runtime path plus its file size and mtime, and re-probe only when that key changes. The env and PATH runtimes can keep the spawn as a fallback when no cache entry matches."
- S3 (carlosmoradev comment): "`resolveBundledCli()` actually already reads and parses `package.json` to validate entrypoint metadata ... `metadata.version` is already right there in memory synchronously before the probe runs ... Propagating `version?: string` from `resolveBundledCli()` through `resolvePiRuntime()` allows `main()` to run `checkPiVersion(runtime.version)` directly in memory with 0 spawned processes."
- S4 (carlosmoradev comment): "For `path` and `env` runtimes where spawning is needed, we can adopt the same stat-based caching pattern (`mtimeMs` + `size`) recently added in `lib/gentle-ai-binary.ts` (#2130) to avoid re-probing unchanged binaries across runs."
- S5 (user, this session): wants the comprehensive solution, not only the bundled patch — explicitly chose "bundled + cache for env/PATH" scope over "bundled-only" when offered the choice.

## Tasks

- [x] T1 — S2, S3: propagate `version` through `PiRuntime` for `kind === "bundled"` (both the adjacent-peer `resolveBundledCli()` path and the gentle-shell-managed `bundledPi()` path), and use `checkPiVersion(runtime.version)` in `main()` without spawning when `runtime.version` is defined. Commit: pending.
- [x] T2 — S4: add pure, testable stat-identity cache helpers in `lib/gentle-shell-launcher.ts` (`FileIdentity`, `CachedPiVersion`, `cachedPiVersion`, `matchesFileIdentity`, `recordPiVersion`), reusing the existing `RawLauncherConfig` extension point (same file as the `provisioned` marker, same tolerant-parse / immutable-merge conventions). Commit: pending.
- [x] T3 — S4: wire the cache into `bin/gentle-shell.mjs` `main()` for `kind === "env"` and `kind === "path"`: stat the resolved command, reuse the cached version on an exact `dev+ino+size+mtimeMs` match, otherwise spawn and persist the fresh result atomically. Commit: pending.
- [x] T4 — full verification: unit tests (`tests/gentle-shell-launcher.test.ts`), integration tests (`tests/gentle-shell-bin.test.ts`, `tests/gentle-shell-bundled.test.ts`), `build:runtime-modules`, typecheck, full suite, independent verification given the version-gate correctness risk.

## Log

- L1 (user, verbatim): "hola chato, vamos a retomar este Issue reportado atendiendo lo que indica carlosmoradev https://github.com/Gentleman-Programming/gentle-shell/issues/2096 , tenes el contexto ?"
- L2 (user, verbatim): "con las opciones que me diste como DEV Senior cual propones para dar la mejor solucion integran y no solo un pequeño parche." — resolved as "bundled + cache for env/PATH" (S5).
