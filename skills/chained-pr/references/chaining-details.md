# Chained PR Details

## Strategy Notes

Before creating branches or PRs, verify the target repository's default branch and use it as `<default branch>` throughout these examples. Do not infer it from the current local branch. The historical strategy token `stacked-to-main` means stacking onto that verified default branch, even when its name is not `main`.

| | Stacked PRs to default branch | Feature Branch Chain |
|---|---|---|
| Speed | Each slice can ship in order | Full feature waits for tracker merge |
| Rollback | Revert individual PRs merged into the default branch | Revert/hold the whole feature branch |
| Risk | Partial behavior may land | Nothing lands until the chain completes |
| Complexity | Simpler retarget/rebase flow | Requires tracker and strict diff hygiene |

## Feature Branch Chain

Use when the feature branch accumulates the final integration while child PRs are reviewed as focused slices.

```text
<default branch>
 └── feat/my-feature              ← tracker/final integration branch
      ↑ PR #1 base: feat/my-feature
      └── feat/my-feature-01-core
           ↑ PR #2 base: feat/my-feature-01-core
           └── feat/my-feature-02-shared
                ↑ PR #3 base: feat/my-feature-02-shared
                └── feat/my-feature-03-slice
```

Steps:

1. Create the feature/tracker branch from the verified `<default branch>`.
2. Open the tracker PR to `<default branch>`; mark it draft/no-merge.
3. Create PR #1 from a child branch and target it to the tracker branch.
4. Create each later child branch from the previous PR branch and target it to that parent branch.
5. Merge/integrate children in order; merge the tracker only after the chain is complete.

## Stacked PRs to Default Branch

Use when each slice can land on the verified `<default branch>` in order.

```text
<default branch> <- PR 1: foundation
          └── PR 2: feature slice built on PR 1
                └── PR 3: docs/tests built on PR 2
```

Base PR #1 on the verified `<default branch>`; base each subsequent PR on its immediate parent until that parent merges. After a parent PR merges, rebase/retarget the next PR so GitHub shows only the current slice.

## Chain Context Section

Append this section to the repo PR template; do not replace required issue/checklist sections.

```markdown
## Chain Context

| Field | Value |
|-------|-------|
| Chain | <feature or stack name> |
| Tracker PR | <#NNN or "Not needed"> |
| Position | <N of total> |
| Base | `<target branch>` |
| Depends on | <PR/issue/link or "None"> |
| Follow-up | <next PR or "None"> |
| Review budget | <changed lines> / 400 |
| Starts at | <branch, PR, or state this builds on> |
| Ends with | <standalone result delivered by this PR> |

### Chain Overview

```text
<default branch>
 └── #NNN Previous PR
      └── 📍 #NNN This PR
           └── #NNN Next PR
```

### Scope
- Includes: <focused unit>
- Excludes: <deferred work>

### Autonomy
- [ ] CI is expected to pass for this PR branch
- [ ] This PR has one deliverable scope
- [ ] This PR can be rolled back without unrelated changes
- [ ] Tests, docs, or manual verification cover this unit
```

## Commands

Before any remote read or PR creation, require explicit human authorization for the destination (exact host/repository), operation (PR read or creation), and credential/session. Do not probe credentials or remote targets to resolve ambiguity. Verify the target repository and its default branch using only the authorized session and destination; set `TARGET` to that verified host/repository. Stop if authorization or verification is missing. Each command below binds to that same verified target; the base branches must belong to it.

```bash
gh pr view <PR_NUMBER> --repo "$TARGET" --json additions,deletions,changedFiles,title,url
gh pr create --repo "$TARGET" --base feat/my-feature --title "feat(scope): focused slice" --body-file pr-body.md
gh pr create --repo "$TARGET" --base feat/my-feature-01-core --title "feat(scope): next focused slice" --body-file pr-body.md
```

## Reviewer Guidance

- Ask for a split when a PR exceeds 400 changed lines without `size:exception`.
- Recommend Feature Branch Chain when work must integrate before the verified `<default branch>`.
- Recommend stacked PRs when each slice can merge independently.
- Review child PRs against immediate parent branches; a polluted diff is a branching bug.
