# Windows installer CI diagnostic
Run one diagnostic job for the failed installer file, preserving production and the draft tracker.
Branch: `ci/213-windows-diagnostic` from public `823fef42`; delivery: one diagnostic branch, no PR; checks: focused structural test, independent verification, one CI run.

## Specs

- **S1** User approval: "sip, hagamoas eso". Approved proposal: "¿autorizás crear un job diagnóstico en CI que ejecute únicamente ese archivo, con TAP y el entorno original?" The selected file is `tests/installer-windows-bootstrap.test.ts`; the original checkout is `41210ef5d87f6242c507b04b818801ffa9b7f49b`, Node `24.21.0`, Windows Server 2025.
- **S2** Approved boundary: "Sin cambios productivos ni merge a `main`." Preserve the tracker and incident data; do not retry existing CI or execute ordinary suites. Diagnostic publication is limited to a new branch and its single push-triggered job.

## Tasks

- **T1** S1-S2 | inline, independent verify | in_progress | Workflow and structural tests written; RED 2/2 missing-definition failures, GREEN 2/2 with zero skips. Independent configuration verification S1 PASS/S2 PASS and 2/2 structural checks pass; parent spot check and commit pending. Commit: pending.
- **T2** S1-S2 | inline | pending | Publish once, capture the one diagnostic run and its TAP/artifacts, report proved findings and missing proof. Record final evidence in a local journal commit; do not push that journal. Commit: pending.

## Log

- **L1** User request verbatim: "sip, hagamoas eso". The approval refers to the proposal quoted in S1-S2.
- **L2** Public branch point is `823fef4297fcb2d8b5e9f5f408748c0fc24c3279`, not local tracker HEAD `67a3a7054e490a9687e2cd94580992b3a848dc92`; two local tracker journal commits must not be published. Restore `feat/213-status-timing` after this diagnostic. No PR or main merge.
- **L3** Read-only explorer audited all four existing workflow triggers. None matches a push to `ci/213-windows-diagnostic`; workflow files are byte-identical between public branch point and local tracker HEAD. Existing session bootstrap push is limited to `test/windows-session-bootstrap-ci`; other automatic pushes target `main`.
- **L4** Official GitHub event documentation confirms push runs workflows not merged to the default branch; workflow_dispatch has a default-branch restriction. Use a branch-only push, with diagnostic-workflow path filter. Source: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push .
- **L5** Immutable original CI workflow confirms installer tests use only Node built-ins and repository files, so no dependency installation is needed. Its failing step ran eight files; this approved diagnostic intentionally isolates one and is not a replay of that concurrent suite. Original checkout/setup-node action SHAs are retained. Windows image family and Node patch are pinned; hosted image revision may differ and must be reported.
- **L6** Execution plan: checkout workflow code from the diagnostic commit and source separately at pinned CI SHA; capture only selected TAP stdout/stderr plus allowlisted runtime/source/exit/signal metadata. One 180-second test deadline, bounded 8 MiB combined output, finite job deadline, artifact upload on failure. No automatic retry. These are implementation controls, not claimed additional product requirements.
- **L7** Forecast: one cohesive workflow/structural-test unit, approximately 200 authored changed lines including this plan; no oversized PR or delivery chain needed. Risk: item 5 (new hosted CI execution). GitHub trigger/runtime checks require the actual hosted run; local structural test-first validation does not claim runtime equivalence.
- **L8** RED job55: both new structural checks failed on the missing workflow; GREEN job56: 2/2 pass, zero skips, extracted Node program syntax valid. Staged whitespace check passes; initial coherent unit is 194 authored added lines. No installer test was rerun locally and no full suite was run.
- **L9** Native assessment is unavailable: undeclared untracked scope. It returned risk unassessable and mandatory independent verification. Protected diagnostic/incident data are not declared or read to recover assessment; no assessment retry, STATUS, or review-mode change. No native reviewDue continuation was offered. A separate verifier must complete before publication.
- **L10** Pinned upload-artifact action descriptor was checked at its official raw SHA: v4.6.2 supports the configured name/path/error/retention inputs. Official GitHub push documentation plus current Context7 branch/path documentation were consulted; dispatch is intentionally absent.
- **L11** Independent verifier `mv0470se-f-vz2u`: S1 PASS, S2 PASS for configuration; 2/2 structural checks pass, zero skips, whitespace clean, no actionable blocker. Hosted execution/termination/artifact delivery remain T2 proof; image revision and isolation differences remain explicit. Publication ancestry is checked by the parent before delivery.
