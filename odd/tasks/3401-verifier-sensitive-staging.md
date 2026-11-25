# 3401 verifier sensitive staging

Make the sensitive-path policy govern what the independent verifier's preparer stages into scratch (gentle-shell#3401).
Branch `fix/3401-verifier-sensitive-staging` from origin/main 21c73c134.

## Specs

- S1. `auth.json` is sensitive like `.env` and `.pem`/`.key`: add it to `SENSITIVE_PATH_PATTERNS` (`extensions/gentle-ai.ts:2193`), so direct tool calls and bash words naming `auth.json` are denied like `.env`. Issue text: "`auth.json` is treated as sensitive like `.env` and `.pem`/`.key`."
- S2. The preparer (`scripts/prepare-verifier.mjs`) and the guard use ONE list of sensitive patterns (no second hand-copied list that can drift). Choose the existing repo pattern for sharing code between `extensions/*.ts` and plain-node `scripts/*.mjs`.
- S3 (revised, see L6). Tracked sensitive file → skip and report, never block. User decision (verbatim choice): "Omitir y reportar, sin bloquear (recomendado)": "No lo copia al working tree del scratch y lo quita del índice del clone (commit de scratch). Lo lista en skippedSensitive. Sigue alcanzable en el historial git del clone, igual que S6, pero ningún test ni lectura casual lo toma. Nadie queda bloqueado." Keep the receipt's `head`/`baseline` contract: do not create a new HEAD commit if that changes `head`; prefer leaving HEAD intact and hiding the path from the scratch working tree and index view (e.g. `git update-index --skip-worktree` or removing it from the index without a commit) so `git status` in scratch stays clean and the file is absent from `work/`. Document in the receipt docs that the blob stays reachable through Git objects, like S6. gentle-pi's own tracked `tests/fixtures/proxy-tls/proxy.key` must now prepare `ready` with it in `skippedSensitive`.
- S4. A directory in `include` does not stage untracked or git-ignored sensitive files (issue: "A directory in `include` does not stage untracked or git-ignored sensitive files"). Skip them; report them in the ready output so the parent sees what was left out.
- S5. Naming a sensitive path directly in `include` is refused with setup-failed naming the path (issue: "naming a sensitive path in `include` is denied or requires the parent's explicit decision").
- S6. Contract coverage pins (issue): "a tracked sensitive file outside `include`, a sensitive file present only in Git history, and the interaction between the preparer and the guard." History-only sensitive file (added then removed in a later commit): decide from evidence and document; minimum is a test pinning current behavior and its rationale.
- S7. Every refusal names a runnable continuation; update the verifier agent docs / `docs/` that describe the preparer and the sensitive-path guard (grep for `prepare-verifier` and `sensitive path`).

## Tasks

- T2 (S3 revised, A2-A4, verifier's proposed tests) — worker — commit: a92ff44bb
- T1 (S1-S7) — worker — commit: b02abaf25 (S7 agent prose landed in 0cbbdd448; its tracked-file refusal was superseded by T2)

## Log

- L5: independent verify (mwp6s46z-a-4yrb) S1-S7 met but A1: refusing on tracked sensitive files makes the preparer unusable for gentle-pi itself (`tests/fixtures/proxy-tls/proxy.key`, baseline `ready`, candidate `setup-failed`) and for any repo tracking `.env.example`; A2: printed `git rm --cached` exit is unquoted and insufficient without a commit (HEAD keeps the blob); A3: `docs/permission-modes.md:56` and `lib/yolo-session-policy.ts:19` list the guard without `auth.json`; A4: T1 log line stale.
- L6 (user decision, replaces L4): "Omitir y reportar, sin bloquear (recomendado)".

- L1 (user): "usemos nuestra skill y quiero que veamos issues y hagamos arreglos de gentle-ai, gentle shell y engram" / "si ya hay un issue con pr revisamos el pr a fondo y si tenemos que hacer camnbios los hacemos sobre el pr de la persona"
- L2: explorer confirmed `scripts/prepare-verifier.mjs:75` stages all tracked files, `:76`+`:62-67` expand include dirs from disk ignoring .gitignore, `:85` clones history with `--no-local`; no sensitive check. Candidate PRs #3346/#3239/#3202 judged unsuitable carriers (widen copy / draft +1317 / conflicts) → new branch.
- L3: `auth.json` absent from `SENSITIVE_PATH_PATTERNS` confirmed at `extensions/gentle-ai.ts:2193-2203`.
- L4 (user decision): tracked sensitive file → refuse with named exit (option 1).

- worker T1 (b02abaf25): RED = 9 new tests failed before implementation (S1 auth.json, shared-list, S3, S4, S5 x4); GREEN = verifier-preparation + sensitive-path-tools 76/77 pass, plus the 12 files that mention prepare-verifier / SENSITIVE_PATH: 384/386. `build-runtime-modules --check` clean. Failures not caused by this change: "#3009: unselected live socket" (macOS `listen EINVAL`, socket path too long, fails before the preparer runs). S6 history-only: pinned as current behavior (clone carries history; rewriting it would break the head/baseline contract). S7 agent prose was later done by the parent in 0cbbdd448; docs/delegated-verification.md and docs/yolo-mode.md updated.

- worker T2 (a92ff44bb): RED = S3 revised test, fixture-key test and 4 S5 message tests failed before the change; GREEN = tests/verifier-preparation + sensitive-path-tools 79/80 (only the macOS socket `listen EINVAL` test fails). Wider run over every test file mentioning prepare-verifier/SENSITIVE_PATH/isSensitivePath/sensitive-paths/agent-body-history/gentle-ai-verify/permission-modes/yolo-session-policy: 1455/1476 pass; the 21 failures are the 2 socket tests plus 18 profile-routing tests in tests/gentle-ai.test.ts that also fail on 0cbbdd448 (checked in a git-archive copy), plus a markdown fixture the grep swept in as a test file. Tracked sensitive files: skip-worktree in the clone, absent from work/, `git status` equal to the source's, head/baseline unchanged. A4 fixed. Agent body history regenerated.
