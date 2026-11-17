# Desktop RPC: expose a bounded background job output tail over Desktop RPC

Implements #3309 on branch `feat/desktop-rpc-job-output`. Delivery: single PR closing #3309. Test runner: `node --experimental-strip-types --test` (`pnpm test`), plus `pnpm run typecheck`.

## Specs

- S1 (#3309, Proposed outcome, verbatim): A versioned, read-only method on the Desktop RPC jobs slice, for example
  `get_job_output`, that for a requested job id returns:
- S2 (#3309, Proposed outcome, verbatim): a bounded tail of the job's output: the owner's existing in-memory tail
  (the last 20 lines, at most 2 000 characters per line —
  `TAIL_LINES`/`MAX_TAIL_LINE_CHARS` in `lib/background-jobs.ts`);
- S3 (#3309, Proposed outcome, verbatim): only when the registry's `ownerSessionId` for that job matches the calling
  session (same ownership rule `list_jobs` already applies);
- S4 (#3309, Proposed outcome, verbatim): output with the same field discipline as the rest of the channel: the wire
  field is a text field; the method must never additionally expose command
  text, cwd, output path, environment, owner session id, monitor counters, or
  error strings as separate fields, and no parser should *infer* them from the
  label (that is exactly the rule `7f87cb5e8` and the current label docs
  enforce). But this does not — cannot — filter the job's own output content:
  a tail is arbitrary process output and can legitimately contain echoed
  commands, paths or secrets the job printed. That content is the job owner's
  own data; requesting it is the consumer session's standing decision, and
  the docs should say so instead of implying the tail is sanitized.
- S5 (#3309, Proposed outcome, verbatim): a statement (or normalization) for terminal control sequences: the owner
  tail keeps raw job output (it only joins chunks and strips a trailing CR),
  so progress-bar lines may carry ANSI escape sequences; the docs should say
  whether the method strips them or whether the consumer renders them;
- S6 (#3309, Proposed outcome, verbatim): `not_found` / `jobs_unavailable` semantics consistent with the existing
  slice.
  This is the same projection idea `list_jobs` already demonstrates: the owner
  registry stays the single source of truth, the wire method is a bounded,
  owner-verified view, and nothing on the wire identifies machine paths or
  commands. Optionally, a coalesced `job_output` event could carry increments,
  but a pollable bounded read is enough for a first design.

## Tasks

- T1 [S1,S2,S3,S4,S5,S6] Desktop RPC slice: owner seam, method(s)/event, docs in `docs/desktop-rpc.md`, tests. Route: delegated writer (Writer trigger a: parallel independent units in separate worktrees). Status: done. Commit: bab662064.
- T2 [S1,S2,S3,S4,S5,S6] Push, PR closing #3309 with `type:feature`. Route: parent. Status: done — PR #3329.

## Log

- L1 (2026-11-16, user): "no, vamos a hacer los RPCs siempre de la mejor manera posible, vamos a crear los issues, aprobarlos y hacer los pr" — scope chosen: "Set recomendado (Recommended)".
- L2: #3309 approved (`status:approved`). Specs above quote its Proposed outcome.
- L3 (2026-11-16, T1 writer): Implemented `get_job_output {id}` -> `{ job: DesktopJobEntry, output: string, truncated: boolean }` through the existing jobs owner seam (optional `DesktopJobsService.output(id)`, owner answer in `extensions/gentle-agents.ts` with the `ownerSessionId` check; bridge parses params before discovery, re-validates/re-bounds/re-normalizes the owner answer; read emits no event). Decisions: (a) S5: terminal control sequences (CSI 7/8-bit, OSC, DCS/SOS/PM/APC, two-char escapes) are stripped server-side, a CR-redrawn line keeps its last non-empty segment, other controls except tab are dropped; output is documented as plain text. (b) S4: docs state the tail is unsanitized process output that may contain secrets. (c) `truncated` comes from a new sticky `createOutputTail().truncated()` flag mirrored on `JobRecord.tailTruncated` (earlier lines dropped or a line shortened), not inferred. (d) `output` is optional on the adapter and the schema stays `v1`: other suites build v1 fakes without it, and an adapter without it answers `get_job_output` with `jobs_unavailable` while list/cancel keep working. (e) Lone UTF-16 surrogates left by the owner's fixed-length cut are removed. (f) No `job_output` event (optional per S6; polling read only). Surface extension from the coordinator: pinned capability lists in `tests/desktop-rpc-{agents,config,design,permissions,usage}.test.ts` appended with `get_job_output`; `tests/gentle-ai.test.ts` untouched (no new discovery channel).
- L4 (2026-11-16, T1 verification, commit bab662064): RED observed first (missing exports). `tests/desktop-rpc-jobs.test.ts` 35/35; desktop-rpc agents 32/32, config 44/44, design 22/22, usage 23/23, profiles 5/5, safety 5/5, desktop-rpc 8/8; permissions 8/9 (known Windows 0o600 failure on base). Maintainer `tests/maintainer/desktop-rpc.maintest.ts` 8/8. Importers: background-jobs 12/12, background-monitor 12/12, gentle-agents-child-jobs 13/13, jobs-view 17/17 and other importers green; `gentle-agents.test.ts` 344/351 and desktop-feed-actions 21/24, desktop-feed-actions-guards 16/19, desktop-feed 17/20 (`--test-force-exit`): the failing test names match `origin/main` exactly (Windows environmental). `pnpm run typecheck`: 0 diagnostics, no regressions. `check:runtime-modules`: pass. `verify-package-files`: pass.
- L5 (2026-11-16, independent verifier + parent decisions): verifier found no blockers (S1-S6 met, ownership guard held). Parent decisions: (a) `get_job_output` keeps answering for a finished job of the same session after it leaves `list_jobs` (60 s linger) while the owner registry still holds it, like `cancel_job`; a missing list entry is not proof the output is gone. (b) When the owner's 2000-char cut lands inside an escape sequence, a parameter fragment can remain visible; known cosmetic limit, but the answer never carries ESC or a control character other than tab. Both documented in `docs/desktop-rpc.md` Jobs limits (d10fb13a7). Verifier probes P1, P2, P4, P5, P6, P7, plus the linger decision (from P3), pinned as regression tests (c1891a2ed); the real-owner harness gained a changeable session id and a clock tick. Evidence: `tests/desktop-rpc-jobs.test.ts` 43/43; desktop-rpc agents 32/32, config 44/44, design 22/22, profiles 5/5, safety 5/5, usage 23/23, desktop-rpc 8/8, permissions 8/9 (known Windows 0o600 failure); `pnpm run typecheck` 0 diagnostics, no regressions.
- L6 (2026-11-16): Native review (risk, resilience, reliability) approved and acknowledged; one advisory suggestion. PR #3329 opened.
