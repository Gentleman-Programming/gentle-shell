# Windows installer Node-version control
Run one Node 24.14.0 control against the captured Node 24.21.0 failure; do not change production.
Branch: `ci/213-windows-node-24-14` from public `4680085d`; delivery: one new branch, no PR; checks: structural test, independent verify, one hosted run.

## Specs

- **S1** User: "hagamos eso", approving "Recomiendo **un único control en CI con Node 24.14.0**, manteniendo el mismo código, imagen Windows, archivo y captura TAP. Cambiamos una sola variable; no repetimos el caso 24.21 ya capturado." Source `41210ef5d87f6242c507b04b818801ffa9b7f49b`, Windows image `win25-vs2026` revision `20260925.250.1`, selected file `tests/installer-windows-bootstrap.test.ts`, same reporter, capture, 180-second/8-MiB limits.
- **S2** Approved boundary: "**No tocaría producción, no desactivaría tests ni mergearía el tracker todavía.**" No ordinary suite, retry of existing runs, PR, main merge, protected-data access or publication of local journals.

## Tasks

- **T1** S1-S2 | inline + independent verify | in_progress | Selection/image guard changed; RED 2/2 (job66), GREEN 2/2 with zero skips and syntax/whitespace PASS (job67). Native assessment unavailable; independent S1/S2 PASS and 2/2 checks pass. Parent spot and commit pending. Commit: pending.
- **T2** S1-S2 | inline | pending | Publish one control commit, observe one run, compare metadata/TAP with run `37865560800`, preserve evidence and restore original tracker. Local journal only; commit: pending.

## Log

- **L1** User request verbatim: "hagamos eso". The approved recommendation is quoted in S1-S2.
- **L2** Baseline run `37865560800`, attempt 1, source `41210ef5`, Node `24.21.0`, image `20260925.250.1`: file-worker exit `3221226505` (`0xC0000409`), no case-specific stack; diagnostic deadline did not fire. Its raw artifacts remain local/untracked. Baseline is not rerun.
- **L3** Public branch point `4680085d4fb51a623910960ca5e0145de50ccdd4` excludes local evidence journal `c39a724b` and tracker journal HEAD `67a3a705`. Restore `feat/213-status-timing` at unchanged `67a3a705` after the control. Original baseline diagnostic branch is not updated.
- **L4** Hosted image revisions cannot be selected by an immutable runner label. Retain `windows-2025` and require actual ImageOS/ImageVersion to equal the captured baseline before executing the file. A mismatch is unavailable comparison evidence, not permission to test another image or retry.
- **L5** Existing workflow trigger audit remains applicable at public branch point: ordinary push triggers select main or the dedicated session-bootstrap branch, not this new control branch. This workflow uses exact control-branch/workflow-path push filters. No dependency installation; selected test imports only built-ins/repository files.
- **L6** Checks cover the approved configuration change test-first; they do not execute the installer locally. High risk item 5 (hosted CI). One independent configuration verifier before publication; native assessment only at the code-unit boundary, protected untracked data remain undeclared. Forecast below 150 changed lines relative to the public diagnostic baseline.
- **L7** Remote control branch was absent (job65). Only workflow branch/name/setup-node patch/runtime preflight and image equality preflight changed; capture/spawn/deadline/output/permissions/artifacts remain unchanged. Structural checks now require control Node/branch and exact captured image. RED job66: 0 pass/2 fail; GREEN job67: 2 pass/0 fail/0 skip, extracted Node syntax valid, whitespace clean. RDD remains on/global. No actual installer file was run locally.
- **L8** Native assessment is unavailable because protected untracked scope is undeclared; it returned high-risk verification requirements and no reviewDue continuation. No retries, STATUS, untracked declarations or review-mode changes. Independent verifier `mv09bbq2-g-4tc7` returned S1 PASS/S2 PASS, 2/2 structural checks with zero skips and clean staged whitespace. Only planned workflow/guard/assertion changes; capture behavior unchanged. Hosted execution/image availability/comparison remain T2 proof.
