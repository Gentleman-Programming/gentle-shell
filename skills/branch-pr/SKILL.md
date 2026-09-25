---
name: gentle-ai-branch-pr
description: "Create Gentle AI pull requests with issue-first checks. Trigger: creating, opening, or preparing PRs for review."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "2.0"
---

## When to Use

Use this skill when:
- Creating a pull request for any change
- Preparing a branch for submission
- Helping a contributor open a PR

---

## Critical Rules

1. **Every PR MUST link an approved issue** — no exceptions
2. **Every PR MUST have exactly one `type:*` label**
3. **REQUIRED CI must pass according to target policy** before merge; CodeRabbit is optional unless required by that policy
4. **Blank PRs without issue linkage will be blocked** by GitHub Actions

---

## Target and Authorization

- Inspect `origin` locally (`git remote get-url origin`) and establish one unambiguous target host and `owner/repo`. Do not infer the target from the cwd or assume `main`. Stop if ambiguous.
- Obtain explicit remote destination, operation and credential/session authorization before any target-host reads, including `gh auth status` or repository metadata. Do not inspect or reuse an ambient SSH agent. Permission for a read does not authorize a write; confirm each remote operation is within the grant.
- Once authorized, reuse fresh target-bound issue, default branch, type labels and checks evidence from this session instead of repeating discovery. Refresh stale or mismatched evidence; do not substitute another host's data. Resolve the base from the authorized target's default branch or a human-selected base.
- Do not automatically commit, push, open a PR or merge. Prepare and report a candidate; perform each action only with its own authorization. Local preparation is not permission for remote delivery.

## Workflow

1. Identify the authorized target and verify that the linked issue is approved; choose with the human whether the reference closes it or is nonclosing.
2. Select the base from target metadata and prepare a `type/description` branch only when requested.
3. Implement in work units with conventional commits when authorized; follow the merged ODD applicable test-first policy, run applicable tests, shellcheck on modified scripts, and test changed skills in at least one agent when relevant. The per-task advisory 400 authored-line heuristic is not an automatic split or a reason to omit tests or docs.
4. Prepare the PR body from the target template and evidence. On separate authorization, open the PR and add exactly one `type:*` label.
5. Check target-policy required CI and report pending/failing checks rather than declaring merge-ready.

---

## Branch Naming

Branch names MUST match this regex:

```
^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\/[a-z0-9._-]+$
```

**Format:** `type/description` — lowercase, no spaces, only `a-z0-9._-` in description.

| Type | Branch pattern | Example |
|------|---------------|---------|
| Feature | `feat/<description>` | `feat/user-login` |
| Bug fix | `fix/<description>` | `fix/zsh-glob-error` |
| Chore | `chore/<description>` | `chore/update-ci-actions` |
| Docs | `docs/<description>` | `docs/installation-guide` |
| Style | `style/<description>` | `style/format-scripts` |
| Refactor | `refactor/<description>` | `refactor/extract-shared-logic` |
| Performance | `perf/<description>` | `perf/reduce-startup-time` |
| Test | `test/<description>` | `test/add-setup-coverage` |
| Build | `build/<description>` | `build/update-shellcheck` |
| CI | `ci/<description>` | `ci/add-branch-validation` |
| Revert | `revert/<description>` | `revert/broken-setup-change` |

---

## PR Body Format

Use the authorized target's `.github/PULL_REQUEST_TEMPLATE.md`. Fill it from observed evidence, retaining its required sections.

### 1. Linked Issue (REQUIRED)

Use the human-selected closing (`Closes #N`, `Fixes #N`, or `Resolves #N`) or nonclosing `Refs #N` reference. Do not turn `Refs` into an automatic close. The linked issue MUST have the `status:approved` label; reuse fresh target-bound verification.

### 2. PR Type (REQUIRED)

Check exactly ONE in the template and add the matching label:

| Checkbox | Label to add |
|----------|-------------|
| Bug fix | `type:bug` |
| New feature | `type:feature` |
| Documentation only | `type:docs` |
| Code refactoring | `type:refactor` |
| Maintenance/tooling | `type:chore` |
| Breaking change | `type:breaking-change` |

### 3. Summary

1-3 bullet points of what the PR does.

### 4. Changes Table

```markdown
| File | Change |
|------|--------|
| `path/to/file` | What changed |
```

### 5. Test Plan

Record actual commands and outcomes, including shellcheck on modified scripts, manual testing of affected functionality, and whether changed skills load in at least one agent. Mark inapplicable checks as such; do not invent successful runs.

### 6. Contributor Checklist

Do not mark an unverified `[x]` checkbox. Check each item only after evidence supports it; leave pending items unchecked, including approved issue, exactly one `type:*` label, applicable shellcheck, skills tested in at least one agent, docs updated if behavior changed, conventional commit format, and no `Co-Authored-By` trailers. If a template demands every box checked, resolve outstanding items before submission rather than falsely attesting.

---

## Labels and Automated Checks

- Apply exactly one `type:*` label from the authorized target's available labels. A commit-type mapping below is a suggestion, not proof of label availability or permission.
- Protected labels require an exact direct instruction naming the label and an actor with MAINTAIN/ADMIN permission. Do not infer authorization from a general request to prepare or open a PR.
- For a PR above the advisory 400 authored-line review budget, record the human-selected `size:exception` rationale if that route was selected; no separate instructor proof is required. Apply the protected label only under the same direct-instruction and actor rule. Do not code-golf or omit tests to meet the budget.
- REQUIRED CI is determined by target policy, not a fixed list of job names. Check issue-reference validation (including target-supported `Refs`), issue approval, exactly one type label and shellcheck where the target requires them. CodeRabbit is optional unless required by target policy. Report required pending or failing checks; never merge on an unverified green claim.

---

## Conventional Commits

Commit messages MUST match this regex:

```
^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9\._-]+\))?!?: .+
```

**Format:** `type(scope): description` or `type: description`

- `type` — required, one of: `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`
- `(scope)` — optional, lowercase with `a-z0-9._-`
- `!` — optional, indicates breaking change
- `description` — required, starts after `: `

Type-to-label mapping:

| Commit type | PR label |
|-------------|----------|
| `feat` | `type:feature` |
| `fix` | `type:bug` |
| `docs` | `type:docs` |
| `refactor` | `type:refactor` |
| `chore` | `type:chore` |
| `style` | `type:chore` |
| `perf` | `type:feature` |
| `test` | `type:chore` |
| `build` | `type:chore` |
| `ci` | `type:chore` |
| `revert` | `type:bug` |
| `feat!` / `fix!` | `type:breaking-change` |

Examples:
```
feat(scripts): add Codex support to setup.sh
fix(skills): correct branch name guidance
docs(readme): update multi-model configuration guide
refactor(skills): extract shared persistence logic
chore(ci): add shellcheck to PR validation workflow
perf(scripts): reduce setup.sh execution time
style(skills): fix markdown formatting
test(scripts): add setup.sh integration tests
ci(workflows): add branch name validation
revert: undo broken setup change
feat!: redesign skill loading system
```

---

## Commands

Local target inspection may use `git remote get-url origin`. After explicit target-host read authorization, verify target metadata and the default branch with target-bound `gh` calls; never use implicit cwd targeting. Run applicable local checks before proposing delivery. Only with separate authorization for the verified destination, operation and credential/session may you push, create or edit a PR. Pass the verified `--repo` and `--base` explicitly, and use the human-selected issue-reference form in the body. Do not execute a command block as an automatic workflow.
