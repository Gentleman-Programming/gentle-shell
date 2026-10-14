# Explicit orchestrator selection (#1478)
Branch: `feat/1478-orchestrator-selection`, base `f69cf2b80d42fa642410fb4b1a7a4b858945d167`.
Delivery: feature-branch-chain if authored diff exceeds ~400 lines; forecast 300–500 lines. Checks: focused public-command tests, affected suite, typecheck, runtime integrity, applicable independent verification/native review.

## Specs
S1. Approved issue #1478: "Add an explicit orchestrator row in `/gentle-models` (model + thinking effort, plus a \"leave untouched\" option)".
S2. Approved issue #1478: "Saving (`ctrl+s` / `u`) snapshots the **chosen** value into the profile's `orchestrator` key instead of inferring it silently from `settings.json`." Resolved by the user's choice in S5.
S3. Approved issue #1478: "The profile detail shows whether it carries an orchestrator entry and which one, so applying it never surprises."
S4. Approved issue #1478: "Choosing \"leave untouched\" stores no `orchestrator` key, and applying such a profile preserves the live `/model` (the skip path that already exists)."
S5. User selected "Conservar la separación actual (recomendado)": "ctrl+s sigue guardando routing global, sin aplicar el orquestador elegido; u guarda en el perfil la elección explícita o la ausencia de clave."
S6. User selected "Cadena sobre rama feature/tracker (recomendado)": "Separar unidades verificadas sobre una rama integradora y mantener explícitas sus dependencias. Estrategia: feature-branch-chain."
S7. Session scope: "no tienen que tener soluciones ya eh, los issues". Preserve #1522's live capture as the initial default, not an override of explicit selection; existing disclosure and apply paths are not reimplemented.
S8. Authorized delivery: "cuando termines los issues, automaticamente hace push y PR y explicalos dentro del issue". Fork destination approved separately: `github.com/NicolasIppoliti/gentle-pi`; upstream `Gentleman-Programming/gentle-shell:main`. No merge or force-push authorization.

## Tasks
T1 | S1–S8 | inline | in_progress | Prepare clean feature branch and reconciled specification before source writes; commit pending.
T2 | S1–S5,S7 | inline | pending | Implement the explicit panel choice and faithful snapshot/omission with RED/GREEN public-command tests and documentation; commit pending.
T3 | S1–S7 | inline checks + risk-gated independent verifier | pending | Verify shared routing, panel reopen/custom/restore, apply compatibility, docs and native assessment; commit pending.
T4 | S6,S8 | inline delivery | pending | Publish verified work within the selected size policy and explain it in #1478; commit pending.

## Log
L1. Original session request: "esta sesion se va a basar unicamente en solucionar issues de gentle-shell, asique vamos con todos los que se puedan solucionar y esten approved".
L2. Scope correction: "no tienen que tener soluciones ya eh, los issues". Exhaustive 56-issue documentary triage found #1478's requested selector still absent; merged #1522 implements only automatic live capture for `u`.
L3. User continuation: "dale segui de forma constante"; "dale depura". Source mapping confirmed absent explicit selector, existing profile disclosure and existing no-key apply skip behavior.
L4. User chose S5 and S6 through the structured questionnaire. Optional `/gentle:profiles` snapshot-selector parity is not in this work; `s`, Enter and global `a` retain their existing contracts.
L5. Route: one coupled panel/snapshot unit, no disjoint parallel writers and no context-backstop trigger; parent implements inline. Tests execute registered commands against isolated homes, never the user's live session. No actual model or session switch in the development host.
L6. Base refreshed with `git fetch origin main` (exit 0); clean new feature branch starts at f69cf2b80, separate from delivered #1917. Source writes not started.
L7. Delivery constraints: upstream access is READ; a feature/tracker branch on upstream would require maintainer support if chaining becomes necessary. Do not silently replace the user's strategy or enlarge a PR beyond policy.
