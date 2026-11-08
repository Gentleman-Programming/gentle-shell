# Safe post-merge change closure

`/gentle:close-change` connects a merged GitHub pull request with the worktrees of the exact session that did the work, previews what a cleanup would remove, and runs that cleanup after one explicit confirmation. Every read and every deletion shows its own consent, and a declined consent changes nothing (see `odd/tasks/post-merge-close.md`).

## Quick path

1. After the pull request is actually merged, register it in the session that owns the work: `/gentle:close-change register https://github.com/owner/repo/pull/42`.
2. Preview the outcome: `/gentle:close-change preview` (or `preview <URL>` when several pull requests are registered), and authorize the one read it asks for.
3. When the preview shows what you expect, run `/gentle:close-change clean [URL]`: authorize the fresh remote-branch read, review the one confirmation that lists the exact actions, and confirm. Declining at any point changes nothing.

## Details

| Topic | Decision |
|-------|----------|
| Registration | One durable session entry pins the session id, the canonical clone directory, the pull request target, the base and head branches, the head commit, and the exact associated worktrees with fingerprints. A registration is immutable: an exact repeat is acknowledged, a different pinning of the same pull request is refused, and no entry is ever rewritten. |
| Association | Only the session's own directory and same-clone session-registered worktrees are candidates, and only when their checked-out local branch is the pull request head branch at the pinned head commit. Other worktrees of the clone are never claimed; a registration with no associated worktree is refused. |
| Remote reads | Every GitHub read shows one confirmation bound to the pull request, the session and the clone. The binding is re-derived from the live context (session manager, session id, and the current directory freshly resolving to the same canonical clone) after the prompt and again after the awaited read; drift discards the answer before anything is stored or shown. The answer must prove the state, the branch names, 40-hex commit ids and the repository identity, and `MERGED` together with a real merge time and merge commit. Approvals, checks and comments are not merge evidence; fork pull requests are refused, and unstorable consent is never recorded in any entry. |
| Squash and rebase | The registration and the preview always pin the pull request's head commit (`headRefOid`), never the merge commit, so squash and rebase merges keep the association intact. |
| Preview | Read-only and precise: for each worktree, the local branch, the remote branch and the destination branch, it reports `removable`, `kept` (with the reason), `already gone`, or `unknown` when only a fetch or a new read could tell. A clean worktree is only `removable` while its checked-out branch still sits at the registered head commit; an extra commit or a branch switch keeps it with the reason. A listed worktree must be the session directory or a same-session worktree registration resolving into the registered clone — a record alone never proves ownership, and a provenance failure refuses the preview before the remote read. The head and base branch names must still match the immutable registration, the destination branch is only ever updated by fast-forward in the future cleanup, and the session's current directory is always kept. The remote branch is never called `removable` from local data: local tracking refs are cached evidence only, so the remote branch stays `unknown` until `clean` performs its own fresh authorized read. |
| Fail-closed | Non-GitHub or malformed URLs (credentials, query, fragment, extra paths, forks), headless sessions, subagent child sessions, declined grants, unmerged pull requests, changed head commits, and session or clone drift while the confirmation is open all stop before anything runs. `gh` runs without a shell, with the repository pinned through `--repo`, without ambient Git routing variables, and without the ambient SSH agent. |

## Checklist

- [ ] The registration output lists exactly which worktrees it associated.
- [ ] The preview reports only what was proven, and unknowns stay unknown.
- [ ] After `clean`, the report lists one line per action; anything not proven is `kept` with its reason and absent resources are `already gone`.

## Cleanup

`/gentle:close-change clean [URL]` performs the confirmed cleanup after three grants in one pass: re-read the pull request exactly like `preview`, authorize one fresh `git ls-remote` read of the remote branch (the only evidence that can authorize its deletion), and confirm one plan that lists the exact actions. Nothing runs before that confirmation, and declining it leaves every ref, worktree and file untouched. The plan contains only proven actions:

- remove a registered worktree whose fingerprint is unchanged, whose state is clean, and whose checked-out branch still sits at the pinned head, always through `git worktree remove` and never `--force`;
- delete the local branch only when its tip is the pinned head and its commit is proven elsewhere — the fresh remote branch at that commit, or the destination branch that contains it;
- delete the remote branch only when the fresh read still shows the pinned head;
- fast-forward the destination branch only through `git merge --ff-only` in a clean retained worktree that holds it checked out.

Every action rechecks its own precondition immediately before it mutates anything, so a resource that moved during the confirmation window is reported `kept — <reason>` instead of being touched. Nothing is ever forced, the destination branch is never deleted or reset, nothing is deleted without proof, the session's current directory is never removed, and the registration itself never changes. Absent resources are reported `already gone`; the run always answers with one line per attempted action.
