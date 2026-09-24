---
name: gentle-ai-issue-creation
description: "Create and triage GitHub issues from repository evidence. Trigger: issue creation, bug reports, feature requests, or issue approval."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.3"
---

# Issue Creation

## Core Rule

Discover the target repository's contribution workflow before proposing or publishing. YAML Issue Forms are the format authority for the default automated path: materialize reviewed answers into a private `BODY_FILE` and publish with `--body-file`.

## Safe Discovery

Run read-only checks first:

```bash
gh auth status
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
REPO_URL="$(gh repo view --json url -q .url)"
HOST="${REPO_URL#*://}"
HOST="${HOST%%/*}"
TARGET="$HOST/$REPO"
gh repo view --json nameWithOwner,url,hasDiscussionsEnabled,hasIssuesEnabled,isBlankIssuesEnabled
git ls-files README.md CONTRIBUTING.md CONTRIBUTING.* .github/CONTRIBUTING.md .github/ISSUE_TEMPLATE .github/ISSUE_TEMPLATE/config.yml
gh api --hostname "$HOST" --paginate "repos/$REPO/labels?per_page=100" --jq '.[].name'
```

Inspect `README.md`, contribution instructions, `.github/ISSUE_TEMPLATE/config.yml` contact links, forms, labels, and open and closed issues. For questions/support, follow repository-prescribed Discussions/contact routing when available; otherwise ask or stop. Complete target verification for `REPO`, `HOST`, and `TARGET`. Fail closed before mutation when authentication, target verification, issue availability, policy, form selection, or required metadata is missing or ambiguous. A blank fallback is allowed only when `isBlankIssuesEnabled` is explicitly true.

Build `LABEL_ARGS` only from reviewed labels that exist and policy permits the actor to apply:

```bash
LABEL_ARGS=()
LABEL_ARGS+=(--label "$LABEL") # Repeat only for each permitted discovered label.
```

## Duplicate And Form Decision

1. Describe the report in one sentence, derive `QUERY`, then complete one duplicate search across open and closed issues:

   ```bash
   gh issue list --repo "$TARGET" --state all --search "$QUERY" --limit 1000
   ```

   The agent must complete the duplicate search proactively and retain evidence of its result. If results are saturated or completeness is uncertain, narrow the read-only search or stop. Comment on a confirmed duplicate instead of creating one. Before commenting on a confirmed duplicate, perform the same privacy scan/redaction on the exact comment body as for publication.
2. Select one repository-provided form only when its declared purpose matches. If multiple forms match and policy does not distinguish them, stop and request that decision.
3. For a YAML form, read its schema and establish controls in declared order. Support only `input`, `textarea`, `dropdown`, and `checkboxes`. Markdown controls are non-answer guidance: honor their visible instructions when collecting and materializing adjacent answers, but do not render them as response sections. Fail closed before mutation on malformed, unsupported, missing, or ambiguous required structure or answers. A malformed schema, or missing or ambiguous required answers, fail closed: do not open a browser or mutate. A browser handoff is available only when the user explicitly requests browser completion or a syntactically valid selected form cannot safely/faithfully be represented by the automated path; otherwise report why automation is unsafe and stop.

| Control | Required handling |
| --- | --- |
| `input` / `textarea` | Preserve the visible label. Require an answer when `validations.required` is true; otherwise render `_No response_`. |
| `dropdown` | Preserve visible labels and options. Require exact selected option text; single-select has one selection, and multi-select preserves selections in declared options order. A required dropdown needs at least one valid selection; an optional dropdown with no selection renders `_No response_`. |
| `checkboxes` | Preserve the visible label and every option as `- [x]` or `- [ ]` in declared order. Enforce individually required checkboxes. For agent-verifiable operational options, proactively complete the action and mark it only with retained evidence; the agent may explicitly attest only its own evidence-backed work and must not attribute its actions to the user. Personal facts, consent, legal declarations, and other first-person user assertions require explicit user affirmation; require explicit first-person affirmation for such user declarations. Do not blanket-check checkboxes: a request to publish does not affirm any checkbox. |

For each answer, render `### <visible label>` followed by its materialized value. For `textarea.attributes.render`, fence the answer with the declared language and a fence long enough for its content. Never invent answers, selections, confirmations, or labels.

A Markdown template may be completed only from known evidence into the same private `BODY_FILE`. If no matching template exists, use the reviewed structured blank fallback only when blank issues are explicitly enabled; otherwise stop without publishing.

## Review And Publication

Before the single create attempt, review the target, title, selected form or permitted fallback, exact body, and permitted labels. The agent must complete the privacy scan/redaction of the exact body immediately before publication and retain evidence of it: replace private project names, usernames, hostnames, home paths, credentials, and private network addresses with useful placeholders without removing reproduction structure.

Create one owner-only temporary directory outside the repository for both private files; restrict it to the current user and clean up both files on every exit/outcome:

```bash
umask 077
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
REPO_ROOT="$(cd "$REPO_ROOT" && pwd -P)" || exit 1
if [ "$REPO_ROOT" = "/" ]; then
  printf '%s\n' "Temporary directory is inside the repository" >&2; exit 1
fi
TMP_DIR="$(TMPDIR=/tmp mktemp -d /tmp/gentle-ai-issue.XXXXXXXX)" || exit 1
trap 'rm -rf -- "$TMP_DIR"' EXIT
TMP_DIR_REAL="$(cd "$TMP_DIR" && pwd -P)" || exit 1
case "$TMP_DIR_REAL/" in
  "$REPO_ROOT/"*) printf '%s\n' "Temporary directory is inside the repository" >&2; exit 1 ;;
esac
chmod 700 "$TMP_DIR_REAL"
BODY_FILE="$TMP_DIR_REAL/body.md"
READBACK_FILE="$TMP_DIR_REAL/readback.json"
```

Make one mutation attempt through the automated path and publish exactly once:

```bash
gh issue create --repo "$TARGET" --title "$TITLE" --body-file "$BODY_FILE" "${LABEL_ARGS[@]}"
```

When browser completion is available under the form decision above, an optional, separate browser handoff may open the repository form. It is never proof of publication and is never a response to malformed schemas or missing/ambiguous required answers:

```bash
gh issue create --repo "$TARGET" --web
```

Do not retry a timeout, network failure, missing identity, or other uncertain result. Capture the returned issue number, then read it back from the verified target host before reporting success:

```bash
gh issue view "$NUMBER" --repo "$TARGET" --json number,url,title,body,state,labels >"$READBACK_FILE"
```

Confirm that read-back identifies the target-host issue and that title and body match after only CRLF-to-LF and trailing-final-newline normalization. Report `confirmed` only after this target-host read-back. Otherwise report `no_write` when an authoritative rejection proves no issue was created, or `unknown` and stop all later mutations.

## Triage

Before approving or closing an issue, verify it is concrete, non-duplicate, sufficiently evidenced, in scope, and consistent with repository label/status policy. If any point is uncertain, retain the repository review state and request the smallest missing evidence.
