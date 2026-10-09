# Node 24.21 minimal Windows reproduction
Prepare one isolated overflow probe and run it once in hosted CI; preserve the original PR ready for agent review.
Branch: `ci/213-node21-minimal`, based on public `5f49c5f2`; no production edits.

## Specs
S1. User: "hagamos eso". Approved action: "Escribir el repro mínimo de **2 MiB de salida / 1 MiB de límite**."
S2. Approved action: "Verificarlo y publicar **un único job aislado con Node 24.21**." Use Windows image `win25-vs2026` / `20260925.250.1`; an unavailable image is not permission to retry.
S3. Approved boundary: "Capturar el resultado y detenernos, reproduzca o no el crash." "Sin tocar el PR original ni el CI normal."

## Tasks
T1 | S1-S3 | inline + independent verify | in_progress | RED2/2, GREEN2/2, local Node24.14 smoke1/1, independent2/2 PASS, zero skips; ready to commit.
T2 | S2-S3 | inline | pending | Publish one diagnostic commit, observe one run, preserve evidence and stop; commit pending.

## Log
L1. User request: "hagamos eso". Prior explicit selection: "Preparar y ejecutar el repro mínimo": "En una rama diagnóstica separada: preparar y publicar un job acotado, ejecutar una vez Node 24.21 en CI y capturar el resultado. Sin suite completa, cambios al CI normal ni merge."
L2. Source evidence: frozen `41210ef5` test lines307-313 invokes a Node child emitting 2 MiB; installer helper lines77-81 uses spawnSync with shell:false, UTF-8, 15000ms timeout, SIGKILL, maxBuffer1MiB, windowsHide:true, environment and default pipes. This is a candidate, not a confirmed cause. Reduce to builtins only; retain the test-runner process boundary. Print markers and result lengths, never the synthetic payload.
L3. Node24.21 original file worker fast-failed 0xC0000409; Node24.14 controlled full file passed. No case-specific Node21 evidence or native subcode. Original tracker is OPEN/READY_FOR_REVIEW head823 (user approved removal of draft); local tracker67 is not publication ancestry. Protected .status-213-checks remains unread/undeclared. Raw artifacts remain untracked. No original full-file execution, ordinary suite or retry.
L4. Hosted deadline180s/output8MiB, scoped taskkill and always-upload7day evidence retain the existing diagnostic guard. Workflow source is the new diagnostic commit, not frozen installer412; record baseline reference separately. Risk item5(CI). Focused structural RED/GREEN, one local Node14 probe smoke, independent verification before publication. Native assessment once; no protected scope declaration or native STATUS.
L5. Own job80 RED: two absent-file failures. Job81 GREEN: 2/2 structural checks and one local Node24.14 probe PASS, zero skips; error ENOBUFS/status null/SIGKILL/stdout1114112/stderr0. Independent mv0c08qp-i-t4kk: 2/2 structural PASS, no probe rerun or blocking finding; hosted proof remains T2. Embedded JavaScript syntax checked; YAML manually inspected, no dedicated action validator. Native assessment unavailable because protected untracked scope remains undeclared; no retry/STATUS/scope declaration. Git readback: only four intended new files, no tracked production/normal-CI modifications, parent public5f49; tracker67 and baseline localjournalc39 are not ancestors. Other workflow push triggers do not match this branch. One-run boundary is operational, not a lifetime workflow limit.
