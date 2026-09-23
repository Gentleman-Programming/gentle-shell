---
name: sdd-plan
description: Plan an SDD change through proposal, spec, design, and tasks; safe for auto mode or explicit all-planning approval.
---

## Parent preflight transport guard

Run only after the interactive parent has resolved SDD preflight and injected its exact rendered `## SDD Session Preflight` block into every child context. A chain and its RPC children must consume that transport, never infer, confirm, originate, or persist defaults. Missing or malformed transport blocks the chain before its first phase.

## Interactive mode guard

This chain is a continuous planning pipeline. Use it only in auto mode or explicit all-planning approval. In interactive mode the parent/orchestrator must stop after sdd-proposal, present the proposal, and ask the user before continuing to sdd-spec, sdd-design, and sdd-tasks.

## sdd-init

output: init.md
outputMode: file-only
progress: true

Initialize SDD context for {task} before planning. If the artifact store is `openspec` or `both` and `openspec/config.yaml` is missing, inspect the project and create it automatically. If the artifact store is `engram` or `none`, skip OpenSpec file creation. If `openspec/config.yaml` already exists, read it and report the current SDD/testing configuration without blocking the chain.

## sdd-proposal

reads: init.md
output: proposal.md
outputMode: file-only
progress: true

Create or update the OpenSpec proposal for {task}. Use prior exploration if it is available in the project artifacts. If this is an interactive SDD run and the parent has not already supplied proposal-shaping answers, surface the missing questions in the result so the parent can ask before treating the proposal as approved.

## sdd-spec

reads: proposal.md
output: spec.md
outputMode: file-only
progress: true

Write delta specs for {task} using the proposal and previous output. Keep requirements and scenarios acceptance-focused.

## sdd-design

reads: proposal.md+spec.md
output: design.md
outputMode: file-only
progress: true

Design the technical approach for {task}. Preserve native SDD orchestration intent and identify review/judgment risks.

## sdd-tasks

reads: proposal.md+spec.md+design.md
output: tasks.md
outputMode: file-only
progress: true

Create reviewable strict-TDD implementation tasks for {task}. Include workload forecast and any required delivery decision.
