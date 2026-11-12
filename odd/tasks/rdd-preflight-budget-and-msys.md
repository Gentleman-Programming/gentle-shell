# RDD pre-delivery preflight: per-phase budget and MSYS path resolution

Branch: `fix/rdd-preflight-delivery-guards` (from `main` @ `ca9993e34`). One PR closing #3200, #3066 and #3138 (already fixed, closed with evidence).
Surface: `lib/review-delivery-preflight.ts`, `tests/review-delivery-preflight.test.ts`.

## Specs

- **S1** (#3200) — The single fixed 10 s bound no longer caps the native assessment. `reviewMode`, the untracked-inventory status read and `targetStatus` keep a 10 s read budget; `assess` gets its own 120 s assessment budget. Reported evidence: "assess ... : **22.3 s** on a clean linked worktree", "The RDD pre-delivery guard denies every `git push` on Windows with 'The bounded preflight was cancelled or timed out.'"
- **S2** (#3200) — `GENTLE_RDD_PREFLIGHT_TIMEOUT_MS` overrides the assessment budget. An invalid or non-positive value is ignored in favour of the default; the read budget keeps its own fixed value.
- **S3** (#3200) — A timeout names the phase that expired and, for the assessment, the knob that changes it. The generic "The bounded preflight was cancelled or timed out." must no longer be the only diagnostic.
- **S4** (#3066) — A delivery directory is normalized to the native path before it is resolved against the base, so `cd /c/Users/ana/repo && git push` and `git -C /c/Users/ana/repo push` reach the real repository instead of a missing directory. Reported: "pre-delivery guard blocks delivery on MSYS absolute paths and reports 'Native preflight is unavailable'".
- **S5** (#3066) — POSIX behaviour is unchanged: a relative directory still resolves against the base and an absolute POSIX directory still wins.
- **S6** — Every rejection that existed before still rejects: a due review denies, a directory-state ambiguity denies, an RDD-`off` repository is still allowed and no other repository's mode is borrowed.
- **S7** (#3138) — Already fixed in `main`: `cd <root> && git push 2>&1 | tail -1` resolves the literal directory and is allowed when RDD is off. Closes with the existing passing tests at `tests/review-delivery-preflight.test.ts:249,270`. No code change.

## Tasks

- [ ] T1 (S1,S2,S3) Per-phase budget + `GENTLE_RDD_PREFLIGHT_TIMEOUT_MS` + phase-named timeout messages. Test-first: knob governs the assessment, default budget exceeds 10 s, expired assessment names the phase.
- [ ] T2 (S4,S5) Normalize the delivery directory with `normalizeNativeReviewCwd` before resolving. Test-first: win32 MSYS input resolves to the native root; POSIX relative and absolute inputs unchanged.
- [ ] T3 (S6,S7) Regression run: the whole existing preflight suite still passes; report #3138 as already fixed with its test evidence.

## Log

- **L1** (user, verbatim): «revisa los ultimos issues los que pueden agruparse en un solo pr ya que por la version o cosas asi fueron resueltos o pueden ser resueltos todos en uno»
- **L2** (user, verbatim): «ok agarra uno y explicame lo que resolveras y como lo resolveras en un solo pr no quiere decir que tomes la direccion mas facil sino que debe resolverse en un pr»
- **L3** (user decision): scope = the whole Engram provisioning cluster (#3193, #3161, #3116, #3032).
- **L4** (user decision): pivot to #3200 + #3138 + #3066 after exploration showed the Engram cluster was already fixed or out of repo.
- **L5** (user decision): budget = per phase, assess 120 s / reads 10 s, with `GENTLE_RDD_PREFLIGHT_TIMEOUT_MS` as the override.
- **L6** (evidence): #3138 is already fixed — `tests/review-delivery-preflight.test.ts:249` covers `git push 2>&1 | tail -1` allowed with RDD off and denies with RDD on under /committed range/, and the suite passes 14/14. Scope narrowed to two real defects; S7 records the close.
- **L7** (evidence): `resolve("C:\\Users\\ana", "/c/Users/ana/repo")` yields `C:\c\Users\ana\repo` on win32; `normalizeNativeReviewCwd` already handles the conversion but the preflight never calls it.
