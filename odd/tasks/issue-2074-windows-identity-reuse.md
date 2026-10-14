# Issue #2074 — Windows owner creation repeats SID identity probes

`createCandidateOwner` acquires Windows user/administrator SID identity twice within one synchronous creation (parent-boundary validation, then marker private-file validation). Reuse the identity acquired for parent validation through the rest of that same creation, including rollback, without caching it across operations.

## Specs

- S1: "acquire Windows user/administrator identity once within one module-controlled synchronous owner creation, reuse only that identity through creation-local validation/rollback, and reacquire identity on the next operation."
- S2: "do not cache filesystem owner or DACL facts, add a process-wide SID cache, weaken private-owner checks, change public signatures, or pass retained identity into callback-based cleanup/sweeping operations."
- S3: "Preparation already acquires once and must remain unchanged." (`prepareCandidateOwnerParent` / `assertCandidateOwnerParent` keep acquiring identity exactly once per call, as today.)
- S4: "Identity failures must fail closed, and rollback must preserve a marker whose current owner cannot be re-proven."
- S5: Reference implementation to study and adapt: baseline commit `2d7ab4ba3ad09b652d0fa1de56842e02b5db4669`, preserved candidate commit `1efccb5a01445d84ca554e0dea9f733362c4a8c8` (extracted out of PR #2068 to keep that PR scoped to an unrelated subagent Git-cache issue). Candidate reported: focused checks 12/12 no skips, typecheck zero diagnostics, independent security verification PASS, Windows bounded sample mean 986.2ms baseline vs 817.9ms candidate (~17.1%), user/administrator SID probes 2→1 per creation, owner/DACL observations unchanged at 4 each.

## Tasks

- [x] T1 (S1-S5): Adapt the preserved candidate diff onto current `main` — `lib/review-candidate-view-owner.ts`, `tests/review-owner-identity.test.ts`. Candidate diff applied byte-identical, no rebase conflicts.
- [x] T2 (S1-S4): Run focused tests + typecheck locally on Windows; confirm fail-closed/rollback behavior. `node --test tests/review-owner-identity.test.ts`: 5/5 pass. `pnpm run typecheck`: 0 diagnostics.
- [x] T3 (risk item 2 — security/identity): Independent `gentle-ai-verify` pass before closing. PASS on S1-S5 with file:line evidence; 3 extra regression tests it proposed were added to `tests/review-owner-identity.test.ts` (8/8 pass). One pre-existing, unrelated advisory: `tests/review-candidate-view.test.ts` times out identically on baseline and candidate (environment issue, not caused by this change).
- [ ] T4: Open PR against `Gentleman-Programming/gentle-shell`, `Closes #2074`.

## Log

- L1 (verbatim issue body): "On Windows, one module-controlled synchronous `createCandidateOwner` operation acquires the same user/local-administrator SID identity twice: once for parent-boundary validation and again for the new owner marker's private-file validation. The identity subprocesses add avoidable latency even though the parent and marker checks belong to the same synchronous creation. [...] This is distinct from #990 and #1446 (probe timeouts), #1023 (trusted-helper resolution), #775 (Windows permission validation) and #1809 (identity-precision fixture failure). The proposed identity lifetime remains restricted to creation; preparation already acquires identity once and is unchanged."
