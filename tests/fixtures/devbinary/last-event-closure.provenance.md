# Last-event closure fixture provenance

Captured 2026-08-23 from `gentle-ai dev` at the maintainer-provided disposable sandbox candidate `gentle-ai-dev`.

Commands were run against disposable Git repositories with isolated `HOME` and `TMPDIR` beneath `.scratch/issue-404-fixtures`:

- `gentle-ai review start ... --contract=gentle-ai.review-integration/v2 --agent=pi --consent=relay`
- `gentle-ai review capture-result ... --input=<reviewer-result>`
- `gentle-ai review capture-correction-plan ... --correction-lines=2`
- `gentle-ai review capture-refuter ... --agent=pi --execute=true`
- `gentle-ai review capture-validation ... --agent=pi --execute=true`

The sandbox was removed after the captures. The JSON fixtures are byte copies of the native stdout responses.
