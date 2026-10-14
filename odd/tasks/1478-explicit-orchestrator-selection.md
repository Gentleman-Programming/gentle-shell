# Explicit orchestrator selection (#1478)
Branch: `feat/1478-orchestrator-selection`, base `f69cf2b80d42fa642410fb4b1a7a4b858945d167`.
Delivery: feature-branch-chain if authored diff exceeds ~400 lines; forecast 300–500 lines. Checks: focused public-command tests, affected suite, typecheck, runtime integrity, applicable independent verification/native review.

## Specs
S1. Approved issue #1478: "Add an explicit orchestrator row in `/gentle-models` (model + thinking effort, plus a "leave untouched" option), so that:"
S2. Approved issue #1478: "Saving (`ctrl+s` / `u`) snapshots the **chosen** value into the profile's `orchestrator` key instead of inferring it silently from `settings.json`." Resolved by the user's choice in S5.
S3. Approved issue #1478: "The profile detail shows whether it carries an orchestrator entry and which one, so applying it never surprises."
S4. Approved issue #1478: "Choosing \"leave untouched\" stores no `orchestrator` key, and applying such a profile preserves the live `/model` (the skip path that already exists)."
S5. User selected "Conservar la separación actual (recomendado)": "ctrl+s sigue guardando routing global, sin aplicar el orquestador elegido; u guarda en el perfil la elección explícita o la ausencia de clave."
S6. User selected "Cadena sobre rama feature/tracker (recomendado)": "Separar unidades verificadas sobre una rama integradora y mantener explícitas sus dependencias. Estrategia: feature-branch-chain."
S7. Current request: "Review the delivered subagent output and continue." Compacted session constraints: approved issues only, no existing solutions. Preserve #1522's live capture as the initial default, not an override of explicit selection; existing disclosure and apply paths are not reimplemented.
S8. Delivery authorization retained from compacted history: local commits, normal push, PR creation and issue explanations. Authorized fork: `github.com/NicolasIppoliti/gentle-pi`; upstream `Gentleman-Programming/gentle-shell:main`. No merge or force-push authorization.

## Tasks
T1 | S1–S8 | inline | done | Clean branch and specification prepared before source writes; commit `0950626ce`; local and Engram readbacks observed.
T2 | S1–S5,S7 | inline | in_progress | Focused GREEN 4/4; affected suite 192/192; typecheck 0 diagnostics; runtime matches; diff check/self-review passed. Implementation commit pending.
T3 | S1–S7 | inline checks + independent verifier | pending | ASSESS native medium escalated high (item3), independentVerifier true, reviewDue false (under_budget). Verify remaining public UI/snapshot/reopen interactions; commit pending.
T4 | S6,S8 | inline delivery | pending | Publish verified work within the selected size policy and explain it in #1478; commit pending.

## Log
L1. Current user request verbatim: "Review the delivered subagent output and continue." Earlier session authorization survives as compacted context, not reconstructed verbatim quotations.
L2. Exhaustive 56-issue documentary triage found #1478's requested selector still absent; merged #1522 implements only automatic live capture for `u`.
L3. Source mapping confirmed absent explicit selector, existing profile disclosure and existing no-key apply skip behavior.
L4. User chose S5 and S6 through the structured questionnaire. Optional `/gentle:profiles` snapshot-selector parity is not in this work; `s`, Enter and global `a` retain their existing contracts.
L5. Route: one coupled panel/snapshot unit, no disjoint parallel writers and no context-backstop trigger; parent implements inline. Tests execute registered commands against isolated homes, never the user's live session. No actual model or session switch in the development host.
L6. Base refreshed with `git fetch origin main` (exit 0); clean new feature branch starts at f69cf2b80, separate from delivered #1917. Source writes not started.
L7. Delivery constraints: upstream access is READ; a feature/tracker branch on upstream would require maintainer support if chaining becomes necessary. Do not silently replace the user's strategy or enlarge a PR beyond policy.
L9. RED: focused public-command runner exited 1: 4 tests, 0 pass, 4 fail because the required orchestrator row is absent. Fixtures isolate homes and profile data.
L10. First post-implementation check failed on strip-only TypeScript parameter property (exit 1); syntax corrected. Next focused check timed out at 30s: failure, no complete test result. Read-only diagnosis corroborated the existing profile-panel reopen loop and applyOnce fixture warning; new callbacks now Enter once then Esc. No automatic retry, restart or background migration performed.
L11. Plan reviewed after timeout: T2 was partial awaiting explicit rerun authorization, T3/T4 pending. Source, new tests and docs drafted; compatibility fixture navigation partly adjusted. No verified implementation commit, review, push or PR. T1 preparation commit 0950626ce. Authored diff below 400; measure again after corrections.
L12. User chose "Autorizar una ejecución corregida": "Ejecutar el check enfocado una vez. Si termina, continuar con la implementación y las verificaciones habituales ya autorizadas; no publicar sin validación." One corrected-fixture check with 30s limit, no blanket retries.
L13. Authorized corrected check finished: 4 tests, 4 pass, 0 fail, exit 0, duration ~1.6s. Source uses ordinary private fields (strip-only compatible).
L14. Affected suite job-12 finished exit 1: 192 tests, 190 pass, 2 fail. One fixture correction batch updated role navigation and counted all assignment rows, preserving 40-row height and review-role save/clear behavior.
L15. Self-checks: job-13 affected suite 192/192, exit0 (~14s); job-14 typecheck 0 recorded diagnostics/no regressions, exit0; job-15 runtime matches 15 modules, exit0. Final readback normalizes command help and copies the agent-name array to preserve previous defensive row-list behavior; no apply-side edits. git diff --check/self-review passed. Native mode status reads global on, clone-local unset.
L16. ASSESS: nativeRisk medium, agent escalation item3 applied (shared bulk/save contracts), risk high, writer profile large/runtime, independentVerifier true, reviewDue false/under_budget, candidate not consumed. No native START route needed. Only this work-unit candidate is relevant, not burned #1917 authority. Verification and delivery pending.
L17. Template read returned ENOENT; read-only .github listing confirms no local PR template at this base. Use skill's required sections without inventing a template. Source/test/doc diff remains well below400; cache conditional feature-chain strategy for any overage, no policy exception inferred.
L8. Issue body/comments/labels refreshed directly with `gh issue view` (exit 0); still `status:approved`. User-selected ctrl+s separation supersedes the proposal's ctrl+s profile-write assumption. Historical user quotations unavailable after compaction are represented as scoped context, not invented verbatim text. T1 commit completed; source writes not started.
