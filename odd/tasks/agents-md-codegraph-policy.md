# agents-md-codegraph-policy

Move the codegraph-first policy out of the hand-maintained user-level `~/.pi/agent/AGENTS.md` into committed, managed homes shared by gentle-shell and gentle-ai, so pi and non-pi agents receive the same instruction.

## Specs

- S1: "create a new branch and gime a plan for adding current agents.md to both projects" — add the current global AGENTS.md's codegraph section to both gentle-shell and gentle-ai, on new branches (`feature/agents-md-codegraph-policy`).
- S2: "the same instruction is for all agents pi or not" — the canonical policy text must be the same for every agent; the user confirmed uniform scope.
- S3: Channel decision (structured question, 2026-11-13): pi sessions receive the policy via repo-root `AGENTS.md` committed in both projects (cross-agent: pi + codex/opencode inside each repo); keep the gentle-ai `CodeGraphGuidanceMarkdown()` rewrite in scope (non-pi agents + pi children); remove the duplicate codegraph section from global `~/.pi/agent/AGENTS.md`. The earlier gentle-shell `assets/orchestrator.md` + byte-budget-raise variant was dropped in favor of this channel.

## Tasks

- T1 — S1, S3 — gentle-shell: create repo-root `AGENTS.md` with the canonical "Codegraph comes first" section (inline; markdownlint MD033 fixed, MD013 matches pre-existing repo-doc baseline) — commit: `docs(agents): add codegraph-first policy as repo-root AGENTS.md`
- T2 — S1, S3 — gentle-ai: append the same canonical section to the existing repo-root `AGENTS.md` (inline) — commit: `docs(agents): add codegraph-first policy section to AGENTS.md`
- T3 — S2, S3 — gentle-ai: test-first rewrite of `CodeGraphGuidanceMarkdown()` (`internal/components/communitytool/codegraph_guidance.go`), canonical policy + retained safety rules, RED test `codegraph_guidance_policy_test.go` (delegated writer, background) — commit: same as T2 (one work unit)
- T4 — S3 — remove the codegraph section from global `~/.pi/agent/AGENTS.md` (backup `tmp/AGENTS.md.pre-repo-move`; scripted splice, assertions on 1 parent + 13 sub-bullets) — no commit (user file outside repos)

## Log

- L1: "investigate in gentle shell and gentle-ai main where AGENTS.md are installed and configured"
- L2: "condiderating this findings where in the code must go the codegraph instruction in global agents.md"
- L3: "report GS and gentle-ai separated"
- L4: "the same instruction is for all agents pi or not"
- L5: "create a new branch and gime a plan for adding current agents.md to both projects" — branches created in both repos off `main`
- L6: approved scope "Codegraph section only" + "Continue with this plan"
- L7: "the gentle shell modification is really needed. is copying to APPEND_SYSTEM.md be enough for pi load at session start" — verified pi loads `<agentDir>/APPEND_SYSTEM.md` (resource-loader.js:970-980); channel matrix presented; user chose "Repo AGENTS.md in both projects" + "Yes, rewrite it"
- L8: "go" — implementation start
- L9: evidence — markdownlint: gentle-shell `AGENTS.md` 14×MD013-only (default rule; 252 pre-existing in `assets/orchestrator.md`+`docs/bundled-install.md`; no repo config); gentle-ai `AGENTS.md` MD013 + pre-existing MD060 on original table separator; MD033 `<path>` backticked in both
- L10: global AGENTS.md post-removal check: no "Codegraph comes first"; only the Bash compound-command exception still names `codegraph unlock && codegraph sync` (bash rule, retained deliberately)
