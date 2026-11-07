---
name: gentle-ai-branch-pr
description: "Prepare pull requests using the target repository's contribution policy. Trigger: creating, opening, or preparing PRs for review."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "2.1"
---

## When to Use

Use this skill when:
- Creating a pull request for any change
- Preparing a branch for submission
- Helping a contributor open a PR

---

## Critical Rules

1. **Issue linkage and approval follow the target repository's documented policy or explicit user instruction.** Without such a requirement, continue without an issue or approval label. Reuse the user's stated approval convention; do not require `status:approved` unless the target uses it.
2. **Labels follow target policy.** Exactly one `type:*` label is required only where that convention applies.
3. **REQUIRED CI must pass according to target policy** before merge; CodeRabbit is optional unless required by that policy
4. **Use the target's actual template and checks.** Never infer a GitHub Actions issue gate from this skill alone.

---

## Target and Authorization

- Inspect `origin` locally (`git remote get-url origin`) and establish one unambiguous target host and `owner/repo`. Do not infer the target from the cwd or assume `main`. Stop if ambiguous.
- Establish explicit remote destination, operation and credential/session authorization before target-host reads, including `gh auth status` or repository metadata. Reuse authorization already supplied in this session; an authorized PR request includes the necessary target-bound metadata reads through the connected account. Ask only for a missing target or grant. Do not inspect or reuse an ambient SSH agent. Permission for a read does not authorize a write; confirm each remote operation is within the grant.
- Once authorized, reuse fresh target-bound issue, default branch, type labels and checks evidence from this session instead of repeating discovery. Refresh stale or mismatched evidence; do not substitute another host's data. Resolve the base from the authorized target's default branch or a human-selected base.
- Do not automatically commit, push, open a PR or merge beyond the user's authorization. Prepare and report a candidate; perform each authorized action without asking again. Local preparation alone is not permission for remote delivery.

## Workflow

1. Identify the authorized target and its contribution policy. Verify issue approval only when required, using that target's approval convention. Reuse the user's closing/nonclosing intent; if unspecified, use nonclosing `Refs #N` for a supplied issue rather than blocking preparation on a question.
2. Select the base from target metadata and prepare a `type/description` branch only when requested.
3. Implement in work units with conventional commits when authorized; follow the merged ODD applicable test-first policy, run applicable tests, shellcheck on modified scripts, and test changed skills in at least one agent when relevant. The per-task advisory 400 authored-line heuristic is not an automatic split or a reason to omit tests or docs.
4. Prepare the PR body from the target template and evidence. When authorized, open the PR and apply target-required labels; reuse an existing grant rather than requesting separate confirmation again.
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

### 1. Linked Issue (when required or supplied)

Use the human-selected closing (`Closes #N`, `Fixes #N`, or `Resolves #N`) or nonclosing `Refs #N` reference. Do not turn `Refs` into an automatic close. Check `status:approved` only if the target policy requires that label; reuse fresh target-bound verification. Omit issue linkage when no issue is supplied or required.

### 2. PR Type (target policy)

Where the target uses this type convention, check exactly ONE in the template and add the matching available label:

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

Do not mark an unverified `[x]` checkbox. Check each applicable item only after evidence supports it; leave pending items unchecked. Issue approval and exactly one `type:*` label apply only under target policy; other examples include applicable shellcheck, skills tested in at least one agent, docs updated if behavior changed, conventional commit format, and no `Co-Authored-By` trailers. If a template demands every box checked, resolve outstanding items before submission rather than falsely attesting.

---

## Labels and Automated Checks

- Apply exactly one `type:*` label only when required by target policy, from the authorized target's available labels. Do not create missing labels to satisfy this skill. A commit-type mapping below is a suggestion, not proof of label availability or permission.
- Protected labels require an exact direct instruction naming the label and an actor with MAINTAIN/ADMIN permission. Do not infer authorization from a general request to prepare or open a PR.
- For a PR above the advisory 400 authored-line review budget, follow the destination repository's documented contribution/size policy. `size:exception` is a Gentle-owned repository policy, not a universal label requirement. Never request, create, or add the label for generic users unless their destination policy uses it. Only when that policy uses `size:exception`, record the human-selected `size:exception` rationale if that route was selected; no separate instructor proof is required. Preserve actual policy acceptance gates and apply the protected label only under the same direct-instruction and actor rule. Choosing `single-pr` does not waive policy gates or label authorization, nor automatically select `exception-ok`. Do not code-golf or omit tests to meet the budget.
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

Local target inspection may use `git remote get-url origin`. Within established target-host read authorization, verify target metadata and the default branch with target-bound `gh` calls; never use implicit cwd targeting. Run applicable local checks before proposing delivery. Only with authorization for the verified destination, operation and credential/session may you push, create or edit a PR; reuse the existing grant. Pass the verified `--repo` and `--base` explicitly, and use the human-selected issue-reference form in the body. Do not execute a command block as an automatic workflow.
