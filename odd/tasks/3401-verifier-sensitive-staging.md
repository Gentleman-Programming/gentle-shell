# 3401 verifier sensitive staging

Make the sensitive-path policy govern what the independent verifier's preparer stages into scratch (gentle-shell#3401).
Branch `fix/3401-verifier-sensitive-staging` from origin/main 21c73c134.

## Specs

- S1. `auth.json` is sensitive like `.env` and `.pem`/`.key`: add it to `SENSITIVE_PATH_PATTERNS` (`extensions/gentle-ai.ts:2193`), so direct tool calls and bash words naming `auth.json` are denied like `.env`. Issue text: "`auth.json` is treated as sensitive like `.env` and `.pem`/`.key`."
- S2. The preparer (`scripts/prepare-verifier.mjs`) and the guard use ONE list of sensitive patterns (no second hand-copied list that can drift). Choose the existing repo pattern for sharing code between `extensions/*.ts` and plain-node `scripts/*.mjs`.
- S3. Tracked sensitive file → refuse. User decision (verbatim choice): "Rechazar y nombrar la salida (recomendado)": "Termina en setup-failed listando los archivos sensibles trackeados y la salida: sacarlos del índice (git rm --cached) o verificar sin el preparer aislado." No clone/copy happens before the refusal, so history never reaches scratch.
- S4. A directory in `include` does not stage untracked or git-ignored sensitive files (issue: "A directory in `include` does not stage untracked or git-ignored sensitive files"). Skip them; report them in the ready output so the parent sees what was left out.
- S5. Naming a sensitive path directly in `include` is refused with setup-failed naming the path (issue: "naming a sensitive path in `include` is denied or requires the parent's explicit decision").
- S6. Contract coverage pins (issue): "a tracked sensitive file outside `include`, a sensitive file present only in Git history, and the interaction between the preparer and the guard." History-only sensitive file (added then removed in a later commit): decide from evidence and document; minimum is a test pinning current behavior and its rationale.
- S7. Every refusal names a runnable continuation; update the verifier agent docs / `docs/` that describe the preparer and the sensitive-path guard (grep for `prepare-verifier` and `sensitive path`).

## Tasks

- T1 (S1-S7) — worker — commit: b02abaf25 (agent-body prose for S7 pending, see Log)

## Log

- L1 (user): "usemos nuestra skill y quiero que veamos issues y hagamos arreglos de gentle-ai, gentle shell y engram" / "si ya hay un issue con pr revisamos el pr a fondo y si tenemos que hacer camnbios los hacemos sobre el pr de la persona"
- L2: explorer confirmed `scripts/prepare-verifier.mjs:75` stages all tracked files, `:76`+`:62-67` expand include dirs from disk ignoring .gitignore, `:85` clones history with `--no-local`; no sensitive check. Candidate PRs #3346/#3239/#3202 judged unsuitable carriers (widen copy / draft +1317 / conflicts) → new branch.
- L3: `auth.json` absent from `SENSITIVE_PATH_PATTERNS` confirmed at `extensions/gentle-ai.ts:2193-2203`.
- L4 (user decision): tracked sensitive file → refuse with named exit (option 1).

- worker T1 (b02abaf25): RED = 9 new tests failed before implementation (S1 auth.json, shared-list, S3, S4, S5 x4); GREEN = verifier-preparation + sensitive-path-tools 76/77 pass, plus the 12 files that mention prepare-verifier / SENSITIVE_PATH: 384/386. `build-runtime-modules --check` clean. Failures not caused by this change: "#3009: unselected live socket" (macOS `listen EINVAL`, socket path too long, fails before the preparer runs). S6 history-only: pinned as current behavior (clone carries history; rewriting it would break the head/baseline contract). Open: `assets/agents/gentle-ai-verify.md` prose (S7) not updated because package-manifest "agent body history" requires regenerating `assets/migrations/agent-body-history.json` (outside allowed surfaces); docs/delegated-verification.md and docs/yolo-mode.md were updated.
