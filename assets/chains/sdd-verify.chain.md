---
name: sdd-verify
description: Apply, verify, and optionally archive an already planned SDD change.
---

## Parent preflight transport guard

Run only after the interactive parent has resolved SDD preflight and injected its exact rendered `## SDD Session Preflight` block into every child context. A chain and its RPC children must consume that transport, never infer, confirm, originate, or persist defaults. Missing or malformed transport blocks the chain before its first phase.

## sdd-init

output: init.md
outputMode: file-only
progress: true

Initialize SDD context for {task} before apply/verify. If the artifact store is `openspec` or `both` and `openspec/config.yaml` is missing, inspect the project and create it automatically. If the artifact store is `engram` or `none`, skip OpenSpec file creation. If `openspec/config.yaml` already exists, read it and report the current SDD/testing configuration without blocking the chain.

## sdd-apply

reads: init.md
output: apply-progress.md
outputMode: file-only
progress: true

Implement pending approved tasks for {task}; update OpenSpec tasks and apply-progress with strict TDD evidence.

## sdd-verify

reads: init.md+apply-progress.md
output: verify-report.md
outputMode: file-only
progress: true

Run focused and full verification for {task} using the apply-progress and project artifacts. Include review/judgment blockers. Persist a practical verification report with actual commands, outcomes, coverage and remaining blockers; do not require a retired verification-attestation command for classical providers. If the installed legacy provider still emits additional requirements, return and follow its exact instructions without overriding readiness or inventing a compatibility procedure.

## sdd-archive

reads: init.md+apply-progress.md+verify-report.md
output: archive-report.md
outputMode: file-only
progress: true

When native status admits archive and verification has no unresolved blockers, compose applicable delta specs inside archive and close {task}. Preserve task completion, collision, destructive-change consent and archive-history guards. This explicitly selected verification chain does not make verification mandatory in the full lifecycle.
