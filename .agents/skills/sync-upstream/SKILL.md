---
name: sync-upstream
description: "Trigger: sync upstream, update fork, actualizar fork, traer cambios de upstream, nuevos commits de main. Report what upstream main brings, merge it into the fork keeping fork-only work, update deps, verify, and push origin."
license: Apache-2.0
metadata:
  author: Yoryoboy
  version: "1.0"
---

## Activation Contract

Use this skill in this repository when the user wants the fork (`origin` = `Yoryoboy/gentle-shell`) brought up to date with `upstream` (`Gentleman-Programming/gentle-shell`) `main`. Invoking it authorizes the whole flow, including the final `git push origin main`.

The fork carries fork-only commits (`git log upstream/main..main`) that upstream will never have. They must survive every sync.

## Hard Rules

- Integrate with `git merge --no-ff upstream/main`; never rebase `main` and never force push: `main` is published.
- Never resolve a conflict by taking upstream's side wholesale in a file that a fork-only commit touches. Combine both sides so the fork behavior and the upstream change both remain.
- Create a backup branch before merging.
- Never stage or commit `odd/work/`: stage only explicit paths (`git add <file>`), never `git add -A` or `git add .`.
- Do not push while typecheck or tests fail, or while a conflict is unresolved.
- Report in the user's language; commit messages stay in English.

## Decision Gates

| Situation | Action |
| --- | --- |
| Only untracked `odd/work/` in `git status` | Session runtime artifacts (herdr activity): not dirty, proceed and leave them untouched |
| Working tree dirty (anything besides untracked `odd/work/`) or not on `main` | Stop and ask; do not stash or switch on your own |
| `upstream` remote missing | Add `https://github.com/Gentleman-Programming/gentle-shell.git` as `upstream` |
| `HEAD..upstream/main` is empty | Report "up to date", push only if `origin/main` is behind, stop |
| Conflict whose intent on either side is unclear | Ask one focused question naming the file and both intents |
| `package.json` or `pnpm-lock.yaml` changed in the merge | Run `npx -y pnpm@11.1.1 install`, then commit any lockfile drift |
| A test fails after the merge | Fix it when the fork/upstream interaction causes it; otherwise stop and report it with its output |
| RDD stop hook flags the merge | Run `gentle_review` assess; inspect only if `reviewDue` is true |

## Execution Steps

1. Preflight: `git status --porcelain`, current branch, `git remote -v`.
2. `git fetch upstream --prune && git fetch origin --prune`.
3. Report the news before changing anything:
   - `git log --oneline HEAD..upstream/main` grouped by theme (feat, fix by area, perf, ci, docs), one line per theme with the relevant PR numbers;
   - `git diff --shortstat HEAD...upstream/main`;
   - the fork-only commits: `git log --oneline upstream/main..HEAD --no-merges`;
   - the files both sides touched: intersect `git diff --name-only $(git merge-base HEAD upstream/main) HEAD` with the same diff for `upstream/main`. Flag them as conflict risk.
4. `git branch -f backup/main-pre-upstream-sync HEAD`.
5. `git merge --no-ff upstream/main -m "merge: integrate upstream/main"`.
6. For each conflict: read both sides and the fork commit that introduced the local side (`git log upstream/main..ORIG_HEAD -- <file>`), merge the intents, `git add`, then `git commit --no-edit`.
7. Preservation check: for every file in the fork-only commits, `git diff <fork-commit> HEAD -- <file>` must still show the fork's added lines.
8. Dependencies: if `git diff --name-only ORIG_HEAD HEAD` lists `package.json` or `pnpm-lock.yaml`, run `npx -y pnpm@11.1.1 install`.
9. Verify: `npx -y pnpm@11.1.1 run typecheck` then `npx -y pnpm@11.1.1 test`. Use background execution; the suite takes about three minutes.

Never call bare `pnpm` here: a machine whose global pnpm wrapper lost its `@pnpm/exe` engine fails the whole flow with `the installed pnpm wrapper is missing`. The `npx -y pnpm@<version>` invocation pins the version from `package.json`'s `packageManager` and works regardless of the local wrapper, which is also what `gsm-u` does.
10. `git push origin main`. Then `git branch -D backup/main-pre-upstream-sync`, unless anything needed manual resolution; in that case keep it and say so.

## Output Contract

Return in this order: what is new upstream (by theme), the conflicts and how each was resolved, whether fork-only commits are intact, dependency changes, typecheck and test results (pass/fail counts), the push result (`old..new`), and the backup branch status.

## References

- `docs/skill-style-guide.md`: skill structure contract.
