# Safe post-merge change closure

`/gentle:close-change` connects a merged GitHub pull request with the worktrees of the exact session that did the work, and previews what a later cleanup would remove. This command changes nothing: the confirmed deletion of worktrees, branches and remote refs is a separate, later step (see `odd/tasks/post-merge-close.md`).

## Quick path

1. After the pull request is actually merged, register it in the session that owns the work: `/gentle:close-change register https://github.com/owner/repo/pull/42`.
2. Preview the outcome: `/gentle:close-change preview` (or `preview <URL>` when several pull requests are registered), and authorize the one read it asks for.
3. Wait for the confirmed cleanup step of this feature; today register and preview never delete or update anything.

## Details

| Topic | Decision |
|-------|----------|
| Registration | One durable session entry pins the session id, the canonical clone directory, the pull request target, the base and head branches, the head commit, and the exact associated worktrees with fingerprints. A registration is immutable: an exact repeat is acknowledged, a different pinning of the same pull request is refused, and no entry is ever rewritten. |
| Association | Only the session's own directory and same-clone session-registered worktrees are candidates, and only when their checked-out local branch is the pull request head branch at the pinned head commit. Other worktrees of the clone are never claimed; a registration with no associated worktree is refused. |
| Remote reads | Every GitHub read shows one confirmation bound to the pull request, the session and the clone. The binding is re-derived from the live context (session manager, session id, and the current directory freshly resolving to the same canonical clone) after the prompt and again after the awaited read; drift discards the answer before anything is stored or shown. The answer must prove the state, the branch names, 40-hex commit ids and the repository identity, and `MERGED` together with a real merge time and merge commit. Approvals, checks and comments are not merge evidence; fork pull requests are refused, and unstorable consent is never recorded in any entry. |
| Squash and rebase | The registration and the preview always pin the pull request's head commit (`headRefOid`), never the merge commit, so squash and rebase merges keep the association intact. |
| Preview | Read-only and precise: for each worktree, the local branch, the remote branch and the destination branch, it reports `removable`, `kept` (with the reason), `already gone`, or `unknown` when only a fetch or a new read could tell. A clean worktree is only `removable` while its checked-out branch still sits at the registered head commit; an extra commit or a branch switch keeps it with the reason. A listed worktree must be the session directory or a same-session worktree registration resolving into the registered clone — a record alone never proves ownership, and a provenance failure refuses the preview before the remote read. The head and base branch names must still match the immutable registration, the destination branch is only ever updated by fast-forward in the future cleanup, and the session's current directory is always kept. The remote branch is never called `removable` from local data: local tracking refs are cached evidence only, so the remote branch stays `unknown` until the future cleanup performs its own fresh authorized read. |
| Fail-closed | Non-GitHub or malformed URLs (credentials, query, fragment, extra paths, forks), headless sessions, subagent child sessions, declined grants, unmerged pull requests, changed head commits, and session or clone drift while the confirmation is open all stop before anything runs. `gh` runs without a shell, with the repository pinned through `--repo`, without ambient Git routing variables, and without the ambient SSH agent. |

## Checklist

- [ ] The registration output lists exactly which worktrees it associated.
- [ ] The preview reports only what was proven, and unknowns stay unknown.
- [ ] Nothing was deleted after `register` or `preview`.

## Next step

The confirmed cleanup with identity and head rechecks, all-or-nothing blocking rules and idempotent reporting lands in a later update of this feature.
