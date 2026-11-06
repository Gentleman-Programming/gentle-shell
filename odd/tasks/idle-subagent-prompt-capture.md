# Idle subagent prompt capture

## Objective
Wake idle parents through Pi's normal prompt lifecycle without losing structured child output. Preserve active-run steering, compaction safety and stale-session suppression.

## Authorized scope
extensions/gentle-agents.ts; tests/gentle-agents.test.ts. User additionally authorized fixing five baseline permission lifecycle tests in tests/gentle-ai.test.ts. No production safety changes, bridge changes, cross-session transport changes or review-preflight changes. Single writer throughout. Branch: fix/idle-subagent-prompt-capture; inherited float-chrome history excluded from intended review. Base boundary: a287bdbba5fe3f65069c5803af8161b887971c05.

## Tasks
- [x] T1: implement lifecycle-safe child delivery and regression tests. Delegated writer (two non-trivial files / API lifecycle). Commit: b4c03ea253427bf70057bdda3ed84df39f0cb17b. Independent verification found no remaining candidate-caused blockers after one bounded correction.
- [x] T2: native review of isolated committed fix slice completed. Lineage review-75f8046642f4a6f8 approved; exact acknowledgement consumed revision sha256:87d99ed4946e357372847eabb6a04b3e84d831c3c1014660d479a9290fe2f422 with authority=burned. Functional checks complete. Review evidence below.
- [x] T3: isolate five parent permission tests from inherited child environment. Delegated bounded writer, one test file only. Commit: 86463b4598677b75752fd33e82085ba184480467. Assertions and production child safety unchanged.

## Implementation and checks
Idle custom output is stored durably, then a short automated user wake runs prompt hooks. Active runs retain steer. Compaction with no run holds content until supported lifecycle boundary. Microtask coalescing and a bounded one-shot grace prevent permanent suppression after rejected/handled wakes; no unconditional retry loop.
T1 RED: first regression run 9 failures; correction RED 4 failures. Final independent focused tests:172/172.
T3 RED with GENTLE_PI_AGENTS_CHILD=1:85/90 pass, exact5fail; GREEN90/90. Child safety4/4; parent spot check4/4.
Final independent npm test:4564 tests,4530pass,34skip,0fail; unit-tests/provider-contract/runtime-harness all pass.
Typecheck:187 recorded baseline diagnostics, no regressions;11 file/code pairs improved.
No live Claude bridge / real-host reproduction. Residual pre-run race predates fix; missing compact event can delay held content until next boundary. No generated runtime mirror for gentle-agents.

## Delivery
User selected exception-ok ('PR size exception'). One eventual PR, distinct work-unit commits; no forced split. Source/test authored changes:523 lines (488 additions,35 deletions). Protected-label/repository exception policy still applies. No push or PR authorized or performed.

## Review evidence
Initial retained-selection mismatch and accumulated-branch lens context budget stop created no authority. After user authorized scoped continuation and the task document was committed, fresh INSPECT followed by explicit committed START from a287bdbba5fe3f65069c5803af8161b887971c05 succeeded. Scope exactly four fix paths;552 changed lines including task document;medium tier;one review-reliability lens. Target sha256:e25079b74b9602a0bfe53cb3d6e1120eea8fdad472b7dcbbff1d9713f8ae1837, lineage review-75f8046642f4a6f8. Capture approved with four non-blocking informational findings R3-001/R3-002 warnings and R3-003/R3-004 suggestions. Native statement: none opens correction or reopens review. Exact acknowledgement completed and burned authority; no STATUS issued after burn. Subsequent update to this task document is passive bookkeeping only.

## Next step
Optional live Claude bridge reproduction and user delivery decision. No push or PR performed; size exception retained. Scratch cleanup pending: /tmp/gp-base-jWTy, /tmp/gp-verify-qgob, /tmp/gp-final-ilyF and /tmp/red.txt; delegates could not delete under child safety; no bypass attempted.
