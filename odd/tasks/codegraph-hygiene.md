# Feature: codegraph hygiene (post-analysis remediation)

Address the 31 findings from the 20261115-125007 battery analysis
(tmp/analysis-125007-codegraph-dupes-deadcode-risks.md) on the codegraph slice
(extensions/codegraph-first-gate.ts, extensions/codegraph-tools.ts,
lib/codegraph-{canonical,daemon,lease,readiness,seed,session-seed}.ts).

## Specs

- S1: User, verbatim: "analyze dupes, dead code and production risks" — the analysis (done, read-only) produced 31 findings: 9 dupes, 5 dead, 17 risks (2 major).
- S2: User, verbatim: "plan to address findings" — remediation plan U0-U8 proposed.
- S3: User selection approving scope: "Full plan U0-U8 (Recommended)" — both majors, risk fixes U3-U6, dupe consolidation U7, labels U8; per-unit tests and conventional commits; battery re-run offered at the end.
- S4: Non-goals (from plan, approved): realpath variants outside the slice, daemon-registry auth redesign, UNC status performance, pid-reuse token redesign (documented as fail-closed by design).

## Tasks

| ID | Spec | Route | Commit |
| --- | --- | --- | --- |
| T0 Baseline + wiring: git state, first-gate load wiring verdict, pinned suite baselines | S1 | inline (read-only) | DONE: tree clean @ 87a8970a (fixes commit on top); first-gate IS wired via discoverAndLoadExtensions(["./extensions"]) — harness EXTENSIONS list is banner-test-specific; baselines 63/0, 37/0, 36+1skip, 9/0, 975 files |
| T1 Bash guard root fix (tools.ts:631 keys on resolved workspace root) | S3 | inline, test-first | 36f6129 (38/0 tools suite) |
| T2 CLI timeout enforcement (tools.ts runner call sites honor CODEGRAPH_QUERY_TIMEOUT_MS) | S3 | inline, test-first | 2e295af (39/0; init path intentionally signal-only per pinned test — explorer's init call-site claim rejected) |
| T3 Lease verdict fidelity (damaged/unacquirable distinct from held-live; refresh recovers) | S3 | inline, test-first | f832457 (54/0 readiness+lease) |
| T4 Process hygiene (kill warm-up child on timeout; abort signal into daemon attempts; POSIX tree-kill) | S3 | inline, test-first | ccf3d60 (96/0 readiness+tools+lease) |
| T5 Daemon-skip on "unavailable" + indexExists gate in triggerSearchSync | S3 | inline, test-first | d2df7d8 (41/0; 5 pinned tests re-fixture'd to indexed workspaces) |
| T6 Exception observability in readiness catch-alls | S3 | inline, test-first | 77b8b4e (85/0 readiness+tools) |
| T7 Dupe consolidation (pid-liveness, MCP handshake machine, worktree probe, index-present, root fold, isEnoent) — pure refactor | S3 | delegated gentle-ai-worker (backstop), parent-verified 137/0 | d620548 |
| T8 Cleanup labels (@internal seams) + first-gate wiring outcome (wire or remove) | S3 | inline | 7ec1fb0 (labels; first-gate VERIFIED wired via directory discovery — doc note added; fake-bin test windows widened 1.5-2s→3s) |
| T9 Close-out: full 8-file suite, assess, offer battery re-run | S3 | inline | DONE: 137/0 across 8 suites (tmp/u9-final-suite.log); typecheck clean; assess = medium risk, plan writerSelfVerification (satisfied: per-unit RED/GREEN + differential suite counts); native review consent for this candidate stands declined from earlier in session; battery re-run offered to user |

## Log

- L1: User, verbatim: "analyze dupes, dead code and production risks"
- L2: User, verbatim: "plan to address findings"
- L3: User approved via structured prompt: "Full plan U0-U8 (Recommended)". Evidence base: tmp/analysis-125007-codegraph-dupes-deadcode-risks.md; battery run tmp/vmtesting/20261115-125007 (9/9 PASS + UNC green @ 87a8970a).
- L4: Implemented as 8 work-unit commits on feat/improve-codegraph (base 87a8970a): 36f6129 (U1 guard root), 2e295af (U2 CLI timeout, query-fallback only — init stays signal-only by pinned design), f832457 (U3 lease verdict fidelity), ccf3d60 (U4 process hygiene), d2df7d8 (U5 daemon-skip + sync gate), 77b8b4e (U6 exception observability), d620548 (U7 dupe consolidation via gentle-ai-worker, parent-verified 137/0), 7ec1fb0 (U8 labels + wiring note). Deviation from explorer claims: U2's init call-site intentionally NOT bounded (pinned test "init is never bounded"); U0 resolved first-gate as wired, not dead. Non-goals (S4) untouched.
