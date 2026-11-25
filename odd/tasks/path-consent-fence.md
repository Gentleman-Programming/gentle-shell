Minimal path-consent fence for gentle-shell file tools, from community PR #1610 by @danielgap with hardening by @dnlrsls (issues #1659, #1660). Security: risk item 2.
Branch `fix/path-consent-fence` from main `c11318f9d`. The PR diff is at /var/folders/k1/2nnhpdfx0wq8k6w8n2nqx9_h0000gn/T/gp2vOWDb/rdd-rest.wx4G/gentle-shell-1610.diff, with the PR text and issues alongside it (gentle-shell-1610.md, -1659.md, -1660.md).

## Specs

S1. User decision, verbatim choice: "Implementar la barrera mínima". It was described to the user as: "Pedir consentimiento (o denegar en headless) para tools de archivos fuera del worktree, con los arreglos de symlink colgante y raíz malformada (#1659/#1660). Bash queda fuera. Crédito al autor y a @dnlrsls."

S2. Evidence on main (read-only evaluation):
- main has no outside-worktree consent check for path tools;
- the `tool_call` hook applies sensitive-path denies (extensions/gentle-ai.ts:2595-2609) and the other guards;
- non-shell tools then go through `auto.check`, which decides nothing outside Auto mode (extensions/gentle-ai.ts:13348-13358, 13394-13400; lib/auto-permission-runtime.ts:407-416).

S3. Required behavior:
- For `read`, `write`, `edit`, `grep`, `find` and `ls`, a target outside the session's worktree roots asks the human for consent before execution.
  - The roots are the session cwd's worktree plus registered same-clone worktrees (lib/session-worktree-registry.ts).
  - Without an interactive UI (headless), the call is denied with a clear reason.
- A grant covers exactly that target for the rest of the session. This is the existing session contract: "Grants are per-target, per-session, never blanket".
- Exempt with no question:
  - the OS temp directory (session `TMPDIR`, `/tmp`, `/var/tmp`);
  - `read` of the exact resolved skill files the session indexes; `write`, `edit`, and listing still ask outside the session worktree roots unless another exemption applies.

  Both exemptions are already stated in the session safety contract.
- `bash` is out of scope. The change must not claim to be a sandbox.

S4. Hardening required in the same change:
- (#1659) Resolve each target safely before comparing it to the roots, including a dangling symlink whose link target is outside the roots. A write through `repo/alias -> ../outside/notes.txt` must ask.
- (#1660) A malformed or empty registered session root never disarms the fence: it is ignored as a root.

S5. Unchanged:
- sensitive-path denies stay first and keep their current messages;
- every existing permission mode (normal, Auto, Super Yolo, and any other the project defines) keeps its current semantics. The fence asks through the same mechanism the existing ask guards use and respects the modes the same way they do;
- no new mode, flag or config key.

S6. Credit: @danielgap (author of #1610) and @dnlrsls (hardening). Use `Co-authored-by` only for code actually carried from the PR.

S7. Maintainer working rule (verbatim): see `## Controlled Engineering` in the worker handoff; the report closes with the Additions line.

## Tasks

- T1 (S1-S6) Implement the fence, its tests and the docs (docs/permission-modes.md). Route: gentle-ai-worker. Commit: `feat(safety): ask before path tools reach outside the session worktree`.
- T2 (S3-S5) Independent verification (risk item 2), then native review with escalation item 2.

## Log

L1. User decision: "Implementar la barrera mínima".
L2. Context: earlier triage found #1610 unevaluated after two worker failures caused by an unavailable model; the read-only evaluation then established S2.
L3. Parent decision (technical): the skill exemption covers the exact SKILL.md files of both session indexes (Pi-loaded and the effective session index in extensions/skill-registry.ts), because the session contract exempts "the task's exact resolved skill files" and the effective index is what the prompt advertises. Existing mode semantics (lib/yolo-session-policy.ts:17-27) apply to the fence like to other asks.
L4. Verifier finding: Pi indexes single-file skills (a direct <name>.md in a skills directory), not only SKILL.md. Parent ruling: those are legitimate skill files, so the exemption covers the exact files either index lists. The contract exempts READING them only; write/edit of a skill file outside the worktree must still ask (headless: deny). Pending verification.
L5. Native review approved (lineage review-e1633d7f0c71d8b4) after correcting R3-001 (Auto TOCTOU) in 16f8ee2fe. Follow-up commit in this PR: R3-002/R4-001 (deny when the dialog promise rejects), R2-001/R3-003 (registry tests outside temp exemptions), R2-002 (dialog names the tool and the grant scope). Deferred follow-ups: R2-003 (parity test through the real tool executor), R4-002 (synchronous TMPDIR probe can stall on a hung network mount).
