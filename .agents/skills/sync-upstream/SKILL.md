---
name: sync-upstream
description: "Trigger: sync upstream, update fork, actualizar fork, traer cambios de upstream, nuevos commits de main, actualizar gentle shell. Report what upstream main brings, merge it into the fork keeping fork-only work, update Pi, deps, extensions and model catalogs, verify, and push origin."
license: Apache-2.0
metadata:
  author: Yoryoboy
  version: "1.1"
---

## Activation Contract

Use this skill in this repository when the user wants the fork (`origin` = `Yoryoboy/gentle-shell`) brought up to date with `upstream` (`Gentleman-Programming/gentle-shell`) `main`. Invoking it authorizes the whole flow, including the final `git push origin main` and refreshing the local Gentle Shell install (`gsm`): its Pi runtime, installed Pi packages (extensions) and model catalogs. When it finishes, everything is current, not only the Git history.

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
| `origin/main` is ahead of `HEAD` (pushed from another machine) | `git merge --ff-only origin/main` before merging upstream |
| `HEAD..upstream/main` is empty | Report "Git up to date", skip steps 4–7, still run steps 8–12 |
| Conflict whose intent on either side is unclear | Ask one focused question naming the file and both intents |
| `pnpm-lock.yaml` conflicts | Take upstream's lockfile, then let steps 8–9 regenerate it; the fork's lockfile only carries the Pi bump |
| `gentle-shell update --all` refuses Pi with "ownership could not be verified" | Expected for this source checkout: Pi comes from its `node_modules`, so step 9 updates it with pnpm |
| A test fails after the merge | Fix it when the fork/upstream interaction causes it; otherwise stop and report it with its output |
| `origin/main` moved during the sync (push rejected, or `main..origin/main` non-empty after the fetch) | Another session may have pushed the same merge: compare with `git diff --stat <local-merge> origin/main`. Identical tree and parents: `git rebase --onto origin/main <local-merge> main` to keep only the local commits on top, then push. Otherwise stop and report; never force push |
| RDD stop hook flags the merge | Run `gentle_review` assess with `baseRef` = pre-merge `HEAD` and `committedOnly: true`; inspect only if `reviewDue` is true |
| `gsm update --models` fails with an OAuth `invalid_grant` | Report the provider; the user must log in again (`/login` inside `gsm`). It never blocks the sync |

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
8. Dependencies: always run `npx -y pnpm@11.1.1 install`.
9. Pi runtime: `npx -y pnpm@11.1.1 update --no-save '@earendil-works/*'`, then read the version back with `node -p "require('./node_modules/@earendil-works/pi-coding-agent/package.json').version"`. `--no-save` is mandatory: without it pnpm rewrites the `package.json` ranges, a permanent fork drift. pnpm's `minimumReleaseAge` (72 h) may hold back a fresh Pi release; that is policy, not a failure. If `pnpm-lock.yaml` changed, commit it alone: `chore(deps): update Pi runtime to <version>`. The running session loads Pi from this `node_modules`, so after a Pi bump its lazy-loaded tools (codemode) can break: prefer plain tools for the rest of the run and tell the user to restart `gsm`.
10. Verify: `npx -y pnpm@11.1.1 run typecheck` then `npx -y pnpm@11.1.1 test`. Use background execution; the suite takes about three minutes.

Run each of these commands as its own step, with `timeout` and `< /dev/null` (for example `timeout 300 npx -y pnpm@11.1.1 install < /dev/null`): `install` can print `Done` and then never exit, which stalls any chained command behind it. A timeout exit after `Done` is not an install failure; check `git status` for lockfile drift and continue.

Never call bare `pnpm` here: a machine whose global pnpm wrapper lost its `@pnpm/exe` engine fails the whole flow with `the installed pnpm wrapper is missing`. The `npx -y pnpm@<version>` invocation pins the version from `package.json`'s `packageManager` and works regardless of the local wrapper, which is also what `gsm-u` does.
11. `git fetch origin` right before pushing, then `git push origin main`. Delete the backup only when the push succeeded, as its own step after checking the push exit code: never chain it behind a pipe such as `git push ... | tail`, whose exit code hides a rejected push. Then `git branch -D backup/main-pre-upstream-sync`, unless anything needed manual resolution; in that case keep it and say so.
12. Refresh the `gsm` home (`~/.gentle-shell-main/agent`). `gsm` is a fish function, so call it through fish with stdin closed:
    - `fish -c 'gsm update --extensions' </dev/null` updates the installed Pi packages;
    - `fish -c 'gsm update --models' </dev/null` refreshes the model catalogs;
    - `fish -c 'gsm --version' </dev/null` reports the final Shell, Pi and home versions.
    Do not use `gsm update --all` or plain `gsm update`: on this checkout they refuse to change Pi (step 9 covers it).

## Output Contract

Return in this order: what is new upstream (by theme), the conflicts and how each was resolved, whether fork-only commits are intact, dependency changes and the Pi version (old → new, or held back by `minimumReleaseAge`), typecheck and test results (pass/fail counts), the push result (`old..new`), the backup branch status, and the extension and model-catalog refresh results.

## References

- `docs/skill-style-guide.md`: skill structure contract.
