# Applicable Test-First Development — ODD Verification

This legacy filename is retained for package compatibility. It does not represent a Strict TDD switch.

Assess applicability for each changed behavior: is there a runnable deterministic test with a clear expected outcome? Test existence alone does not establish applicability. For applicable behavior, inspect the reported observed RED (the intended failure before implementation), observed GREEN (focused passing execution after implementation), relevant alternate cases, and post-refactor checks. Do not infer RED from a test file existing or GREEN from a claim without execution. Report missing or contradictory evidence honestly; do not manufacture a lifecycle from the final diff.

For passive documentation, non-testable changes, an unavailable runner, or no meaningful RED, assess the stated exception and the proportionate ordinary functional or structural verification. Never demand a chat/TUI activation choice, and never skip all checks merely because test-first is inapplicable. Execute only exact commands authorized by the parent; report actual results, limitations and remaining uncertainty without editing code or overriding parent-owned RDD review.
