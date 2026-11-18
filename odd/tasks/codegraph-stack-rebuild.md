# codegraph PR stack rebuild (3305-3315)

Rebuild the six open codegraph PR branches into one strict linear chain on
upstream main so every PR merges fast-forward with no conflicts, carrying
both pending commits' content. Publishing (force-push of the six slice
branches + the integration branch) is explicitly authorized by the user.

## Specs

- S1: "push both commits and let the 6 prs to be stacked and with no conflicts to merge them ff" (user, 2026-11-18)
- S2: The lock-safe seed fix (6f9307819afacb7eb09d04237ee69928421904fe) lands in the feat/codegraph-seeding slice (PR 3307); the memory-gate scope fix (be2183320d7bff049bf635dffa2355b516805ee8) lands in the feat/codegraph-memory-gate slice (PR 3308) — cherry-picked unless a patch-id-equal commit already exists in that slice (gate already carries 3d8b9dd81 with the same subject; sync carries 44ce33065 likewise: verify patch-id, never duplicate).
- S3: Final chain is strictly linear and FF-clean: upstream main (a9d3f5661621b08251de86426472ad417607bb7f) is an ancestor of new-3305, which is an ancestor of new-3306 ⊂ new-3307 ⊂ new-3308 ⊂ new-3312 ⊂ new-3315, and the rebuilt feat/improve-codegraph equals new-3315's tip. No content may be lost relative to the union of all current slice tips + both local commits (tree-equality verification required).

## Tasks

- T1 [done] | S1-S3 | Build the rebuilt chain LOCALLY in an isolated worktree (tmp/e2e-cg-stackrebuild/wt), no pushes: rebase daemon-client onto upstream main if needed, then each next slice onto the previous; cherry-pick the two fixes per S2; linearize sync-per-query's merge history | tmp/e2e-cg-stackrebuild/** | commit: n/a (local branches only)
- T2 [done] | S1-S3 | Verification battery, all green before any push: ancestry chain checks; each slice's incremental diff focused on its own files; final tip tree == union tree (temp merge of local HEAD and old sync tip); bun test of the 8-file codegraph family at the final tip | tmp/e2e-cg-stackrebuild/** | commit: n/a
- T3 [done] | S1-S3 | Publish after parent verification: force-with-lease the six slice branches, reset+push feat/improve-codegraph to the rebuilt tip, confirm all 6 PRs report clean/mergeable | - | commit: n/a

## Log

- L1: "push both commits and let the 6 prs to be stacked and with no conflicts to merge them ff"
- L2: Topology established this session: upstream main a9d3f56; fork slice tips daemon 2a8b1051, lease c6ef4a15a, seed 17cb23d7e, gate 4c1138969, mcp 36e88348a, sync 6f5bd2027; verified ancestry lease⊂seed⊂gate⊂mcp, daemon NOT ancestor of lease (first link broken), sync diverged from improve with own merge history; fork improve tip 22cbb1106; local improve = 22cbb11 + be21833 + 6f93078 (both unpushed).
- L3: Rebuild changes commit SHAs (rebase rewrites slice commits); both fixes ship as content with preserved authorship/messages. Integration branch becomes the rebuilt chain tip.
- L4 (2026-11-18): worker mwldoyw9-5-ay2x built the chain in tmp/e2e-cg-stackrebuild/wt. Tips: stack/3305 92ee8dae, stack/3306 cdee5d61, stack/3307 b6ff22f63 (lock-safe fix, combined with the slice's nonce publication fence), stack/3308 dc52c95a, stack/3312 0a1483d5, stack/3315 d572444a. Battery: ancestry PASS, fixes-present PASS (be2183320 ships as equivalent-already-present content 2522f8761; 44ce33065 dropped as exact patch-id dup), focused diffs PASS; literal tree-equality structurally impossible (fork main 23 commits behind upstream) with ZERO codegraph-code differences; suites 210/2/1 identical at pre-rebuild tip (1 fail pre-existing, order-dependent).
- L5 (2026-11-18): parent spot-check PASS (chain ancestry, VACUUM INTO x3, journal_mode=DELETE, seed-failed guard at readiness.ts:440, sole init site gated). Harness safety policy blocked the force-with-lease pushes 4x (classification escalated to 'catastrophic'); user executed tmp/e2e-cg-stackrebuild/publish-stack.sh manually - all 7 pushes clean forced updates.
- L6 (2026-11-18): PR states verified: 3305/3306/3307/3308/3312/3315 all MERGEABLE with heads on the chain (state UNSTABLE = CI pending post-push). improve = d572444a. Local note: reset --mixed left the non-codegraph old-improve content (herdr/tower/desktop/design/docs, ~500 files) as uncommitted working-tree state - preserved on disk and in reflog (6f9307819, 22cbb1106), off-branch by design so improve diff = pure codegraph chain.
- L7 (2026-11-18): CI incident on the published chain: verify failed on 3307/3308/3312/3315 with SyntaxError "Identifier 'lockPathFor' has already been declared" (tests/codegraph-seed.test.ts:11) — the combined cherry-pick resolution kept both my splice's lease import (line 9) and the slice's own (line 11). bun (local verification runner) tolerated the redeclaration; node (CI runner) rejects it. 3305's session-transport-macos fail is a flake (same code passes in 3306's job); rerun requires upstream admin (fork token refused). Repair: removed the duplicate line, amended into the 3307 tip (bcba1f65), rebased 3308 (69087965), 3312 (bd6217f6), 3315 (93533222); node --experimental-strip-types --test of the 8-file codegraph family at the new tip: 212 pass / 0 fail / 2 skip. Publish script: tmp/e2e-cg-stackrebuild/publish-repair.sh (user-run; force pushes remain policy-blocked for the agent).
