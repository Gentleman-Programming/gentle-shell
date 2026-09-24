---
name: sdd-full
description: Run the full SDD lifecycle for a change in auto mode or explicit full-lifecycle approval.
---

## Parent preflight transport guard

Run only after the interactive parent has resolved SDD preflight and injected its exact rendered `## SDD Session Preflight` block into every child context. A chain and its RPC children must consume that transport, never infer, confirm, originate, or persist defaults. Missing or malformed transport blocks the chain before its first phase.

## Interactive mode guard

This chain is a continuous lifecycle pipeline. Use it only in auto mode or explicit full-lifecycle approval. In interactive mode the parent/orchestrator must stop at each phase boundary, present the current artifact, and ask the user before continuing. Approval to start SDD is not approval of the generated proposal, specs, design, tasks, apply or archive phases.

## sdd-init

output: init.md
outputMode: file-only
progress: true

Initialize SDD context for {task} before any planning or implementation. If the artifact store is `openspec` or `both` and `openspec/config.yaml` is missing, inspect the project and create it automatically. If the artifact store is `engram` or `none`, skip OpenSpec file creation. If `openspec/config.yaml` already exists, read it, refresh only safe derived context when appropriate, and report the current SDD/testing configuration without blocking the chain.

## sdd-explore

reads: init.md
output: exploration.md
outputMode: file-only
progress: true

Explore {task}. Identify scope, risks, dependencies, prior art, and whether the change should proceed into proposal.

## sdd-proposal

reads: exploration.md
output: proposal.md
outputMode: file-only
progress: true

Create or update the OpenSpec proposal for {task} using the exploration notes and the previous step output. If this is an interactive SDD run and the parent has not already supplied proposal-shaping answers, surface the missing questions in the result so the parent can ask before treating the proposal as approved.

## sdd-spec

reads: proposal.md
output: spec.md
outputMode: file-only
progress: true

Write delta specs for {task} from the parent-approved proposal. Preserve RFC 2119 requirements and Given/When/Then scenarios. In interactive mode, do not treat chain execution alone as proposal approval.

## sdd-design

reads: proposal.md+spec.md
output: design.md
outputMode: file-only
progress: true

Design the technical approach for {task} using the proposal, specs, and previous outputs. Call out review and judgment risks.

## sdd-tasks

reads: proposal.md+spec.md+design.md
output: tasks.md
outputMode: file-only
progress: true

Create strict-TDD, reviewable implementation tasks for {task}. Include the required Review Workload Forecast guard lines and PR split recommendation.

## sdd-apply

reads: proposal.md+spec.md+design.md+tasks.md
output: apply-progress.md
outputMode: file-only
progress: true

Implement only approved implementation-owned tasks for {task}; enforce strict TDD when active and stop before writing if workload decisions are unresolved. Update OpenSpec tasks and apply-progress with evidence. When implementation completes, request fresh native status. The classical route is apply -> archive; verification remains explicitly optional, and archive composes applicable delta specs. If the installed provider still requires verify, return that native prerequisite to the parent without skipping or inventing it. No post-SDD RDD authority, receipt, or delivery gate is required.

## sdd-archive

reads: proposal.md+spec.md+design.md+tasks.md+apply-progress.md
output: archive-report.md
outputMode: file-only
progress: true

Archive {task} only when fresh native status admits archive and persisted implementation tasks are complete. Compose applicable file-backed delta specs, preserve collision/destructive-write consent and archive history, then persist the closure report. Read optional verification evidence when present; do not require it or a separate sync report. If native selects another action, return it to the parent and preserve active artifacts.
