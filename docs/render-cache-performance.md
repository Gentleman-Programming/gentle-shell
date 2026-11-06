# Verify render-cache effectiveness without removing animations

Use the diagnostic runner to compare two worktrees based on the same commit. It loads both through Pi's native virtual modules, verifies exact editor class identity, and retains quality animation, the Shell editor/header/sidebar, native messages, native tool components and fullscreen frame rendering.

## Run

```bash
node scripts/render-cache-performance.mjs \
  --baseline-root=<before-worktree> \
  --candidate-root=<fixed-worktree> \
  --pi-root=<installed-pi-package> \
  --output=/tmp/render-cache-performance.json
```

Default matrix: 100/1,000/5,000 tools × 100/160 columns × float/neon × pulse, scroll, typing, streaming, append, resize and theme. Four fresh-process paired replicas alternate before/after order (AB/BA/AB/BA). `--counts`, `--widths`, `--styles`, `--samples`, `--repetitions` and `--live-ms` override these settings; use small counts and samples for a smoke run. Run serially on an otherwise idle machine.

The same entry point is available as `pnpm perf:render-cache -- <args>`, which keeps the harness discoverable without duplicating its arguments.

## Host requirement

`--pi-root` must be a Pi install root, not the installed package directory: it needs `package.json`, `dist/` and a `node_modules/` carrying `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core` and `jiti`. The command validates it before it fingerprints either worktree, and the worker re-checks it before importing the host. Both refuse anything else and name the resolved root, the package and version they actually found, and the audited version, instead of failing on a bare read error.

The audited host version is 1.2.0, the same minimum the package declares (`>=1.2.0`), so the harness fails closed on any other version. Moving the pin requires re-auditing the private frame surface against the newer host and re-running the harness there.

On Windows without Developer Mode symlink creation is unavailable, so the report-path protection test skips with an explicit reason there; it still runs wherever symlinks are permitted.

## Read the evidence

- `runs`: raw action-plus-frame wall/CPU times, cold render, construction time, paint/projection counters, visible-screen hashes, memory snapshots and a separate live quality-timer/typing run.
- `comparisons`: per-replica medians and exploratory p95, speedup and enforced cold/warm output equivalence. All tracked source files, host/native dependency files and instrumentation fingerprints must remain unchanged.
- Stable cases use 50 measured frames after five warmup frames. Resize/theme deliberately invalidate caches and use at most eight frames; do not treat their tail percentile as statistically robust.
- Heap/RSS snapshots use explicit GC outside timing, including a job boundary after teardown. They characterize retention for these fixtures, not all transient allocations or proof of absence of leaks.

## Limits

Reports must use a new path outside the source/harness/host roots; existing files and symlinks are rejected. Read only reports with a `finished` field after successful process exit: progress writes are not atomic.

The transcript is synthetic. Deterministic cases drive the real quality interval callback with controlled time; the separate live run uses real timers and records input-to-frame latency and timer drift. The ANSI sink has no terminal emulator or real terminal-write cost. Model/network latency, other extensions and real session restore/startup are not measured. Private APIs are audited only on Pi and pi-tui 1.2.0 and fail closed on version/editor identity/output mismatches. Preserve raw data and report replicas separately; consecutive frames are correlated, so neither p95 nor a render speedup describes the entire application's latency.
