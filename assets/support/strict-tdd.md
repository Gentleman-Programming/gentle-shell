# Applicable Test-First Development — ODD Implementation

This legacy filename is retained for package compatibility. It does not represent a Strict TDD switch.

For behavior changes with applicable runnable deterministic tests and a clear expected outcome, use test-first by default:

1. RED — add the smallest behavior-level test before implementation; run it and capture the intended observed failure. A test file merely existing is not proof of applicability or RED.
2. GREEN — implement the minimum behavior and run the focused test to observe it passing.
3. TRIANGULATE — exercise relevant alternate or negative cases that protect the contract; do not require arbitrary case counts.
4. REFACTOR — improve clarity without changing behavior and rerun focused checks.

For passive documentation, non-testable changes, an unavailable runner, or no meaningful RED, record why test-first is inapplicable; run proportionate ordinary functional or structural verification instead. Never fabricate RED or GREEN or skip applicable checks. Use only exact commands authorized by the parent. A missing runner is an evidence limitation, not a reason to request a chat or TUI toggle. Report actual commands, failures, exceptions and outcomes to the parent; only the parent closes the ODD task.
