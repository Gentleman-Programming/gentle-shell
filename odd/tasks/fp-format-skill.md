# FP formatting skill for Gentle

Status: FPF-1 and FPF-2 complete with verified outcomes and work-unit commits; live-interface reload/registry refresh remain user next steps.
Repository: release worktree `/home/facundo/projects/gentle-v4.0.0`.
Branch: `feat/fp-format-skill`, based on release `v4.0.0` (`1f35ab1e`).

## Authorization and objective

The user approved the proposal: "apruebo la propuesta, procede".
Deliver the first unit: a reusable `gentle-ai-fp-format` skill, a Spanish narrative template and examples, plus packaged discovery integration. Normalize functional-point documentation inside ODD without creating another source of truth.
The user subsequently selected `commit_and_activate`: commit the verified unit and activate the local 4.0.0 checkout in the user environment. After concrete activation risks were explained, the user selected `skill_only`, narrowing activation to a user skill-directory symlink while retaining the installed Gentle 4.0.0 runtime. No push/publication is authorized. Preserve unrelated settings and distinguish registration/discovery, runtime loading, and registry refresh.

## Problem and rationale

Gentle 4.0.0 provides stable-ID ODD task documents but no universal FP hierarchy or per-subtask explanation convention. A scoped skill can guide consistent drafting; it does not replace structural validation or make the Project Map consume new fields automatically.

## Scope and constraints

- Write skill instructions and repository integration in English; the approved FP narrative, template and example prose are in Spanish.
- Preserve identifiers, states, exact paths/commands/API names, dependencies, and verification evidence.
- Preserve existing technical meaning; report missing information instead of inventing it.
- Preserve the fork-compatible `**Belongs to:**` metadata as a proposed FP document convention, not an existing universal 4.0.0 guarantee.
- Existing-document normalization or translation produces a proposal before applying; do not perform any conversion in this unit.
- Discovery is an intent hint, not guaranteed autorun or runtime enforcement.
- No validator, parser/map changes, automatic refresh, task execution, global language policy, unrelated global installation, version bump, publication, or unrelated fork changes. Only the specifically authorized local checkout activation is permitted.
- The release worktree owns these changes; the session fork remains untouched.

## Allowed edit surfaces

- `skills/fp-format/SKILL.md`
- `skills/fp-format/assets/fp-document-template.md`
- `skills/fp-format/assets/fp-document-example.md`
- `skills/fp-format/references/format-rules.md`
- `assets/orchestrator-skills.md`
- `scripts/verify-package-files.mjs`
- `tests/verify-package-files.test.ts` only if an applicable packaging regression test is needed.

The parent alone maintains this feature document and its memory mirror.

## Work unit

- [x] **FPF-1 — Deliver the packaged FP formatting skill and verify its integration.**
  - Provide a compact, trigger-rich skill with preservation rules and Spanish FP narrative defaults.
  - Provide a reusable template and a clearly illustrative example, including per-subtask explanation, acceptance and evidence without fabricated project facts.
  - Add a scoped FP discovery hint without changing mirrored ODD lifecycle/routing.
  - Enumerate all new shipped assets in the package guard.
  - Observe applicable structural and packaging checks and review the resulting diff.
  - Record the now explicitly authorized work-unit commit after the verified source and staged scope are checked.

- [x] **FPF-2 — Activate only the authorized FP skill and verify discovery.**
  - Map the existing launcher/package-registration behavior and exact settings/generated-index surfaces before changing them.
  - Create only `/home/facundo/.pi/agent/skills/fp-format` as a symlink to the tracked skill directory; do not overwrite an existing conflicting path, edit settings, install dependencies, or replace Gentle.
  - Document `/reload` and `/skill-registry:refresh` as pending live-interface actions; do not manufacture a registry or call private testing hooks.
  - Verify default-root discovery exactly once with no target diagnostics and unchanged settings. Current-session reload is not an acceptance claim for this scoped user-skill link.
  - Record reversible configuration effects and checks in this document; retain pending live-session actions honestly.
  - Commit the repository-facing activation evidence after the outcome is observed; never commit credentials or user configuration.

## Verification

Passive skill/template documentation has no meaningful executable RED; use structural and packaging checks. If executable behavior is introduced, stop and use a focused deterministic RED/GREEN regression instead.

From the release worktree:

- `node --test tests/verify-package-files.test.ts`
- `node --test tests/skill-registry.test.ts`
- `node scripts/verify-package-files.mjs`
- `git diff --check`

Additionally inspect frontmatter, skill name/length, relative links, preservation constraints, Spanish template/example narrative, package path enumeration, and the absence of edits outside the allowed surfaces. Generate the ignored registry only if a documented local refresh is available without global installation or unrelated side effects; otherwise record refresh as pending, not as a completed load or installed skill.

## Progress and evidence

- Read-only mapping completed; feature branch created from the 4.0.0 release.
- Worktree was clean before the feature document was created.
- Writer produced six source files (reported 272 additions) and no commit.
- Writer checks: package guard tests 9/9 passed; skill registry tests 18/18 passed; package resource guard passed (159 resources, 69 byte-pinned artifacts); diff whitespace check passed.
- Parent readback found and the writer corrected the template mismatch: `Belongs to` is now one document-level declaration at line 3 in template/example, before the first checkbox, with a single backticked code. Skill and format rules now require clarification rather than automatic reparenting for malformed/ambiguous declarations.
- Post-correction writer checks: package guard tests 9/9 and skill registry tests 18/18 passed; package guard passed (159 resources, 69 byte-pinned artifacts); diff whitespace check passed.
- Native assessment returned `unassessable` because intended untracked files were undeclared; its plan requires writer self-verification plus an independent verifier. Do not infer a risk tier from the task description or mutate review authority to bypass this.
- Independent verifier: completed with no severe candidate findings; six candidate source paths, 284 added lines, zero deletions (279 lines in the four new skill files; tracking document excluded).
- Independent checks after correction: `node --test tests/verify-package-files.test.ts` 9 passed, 0 failed/skipped; `node --test tests/skill-registry.test.ts` 18 passed, 0 failed/skipped; `node scripts/verify-package-files.mjs` passed (159 resources, 69 byte-pinned artifacts); `git diff --check` passed.
- Parent spot check: corrected template membership at line 3 confirmed; `git diff --check` rerun passed; original session fork `git status --short` empty.
- Full-checkout runtime replacement: not performed and superseded by the user's explicit `skill_only` selection. The user-skill symlink is registered through default discovery; current live session `/reload` and `/skill-registry:refresh` were not performed. In the user's active project, reload resources and invoke the public refresh command if the project registry should be updated. Do not claim this running host is already reloaded or its registry refreshed.
- Preexisting follow-up: `skills/skill-registry/SKILL.md` references absent `skills/_shared/skill-resolver.md`; left untouched, not a candidate blocker.
- Full suite/build/live-session behavior: not run; passive documentation and package enumeration were checked proportionately. RED/GREEN lifecycle not applicable to this documentation unit.
- Native review: clone-local RDD is off in the host; no review authority is created by this document.
- FPF-1 work-unit commit: `efd65ae869ac856e2286cfc6491539fbee08ef89` (`feat(skills): add Spanish functional point documentation format`), seven paths and 375 additions including this tracking document. Commit observed, staged check passed, no push.
- FPF-2 activation map: launcher `--link --package-root` is a per-run takeover, not persistent registration or link-only; it leaves settings unchanged and launches Pi. Registry refresh writes registry/cache/.atl ignore files and has no documented headless CLI. Do not launch a blocking TUI or call private testing hooks as a public API.
- Installed Gentle already declares 4.0.0. Local package registration matches resolved source paths rather than manifest names, so npm and checkout registrations can coexist and duplicate Gentle loading. Local registration does not install the checkout's missing dependency tree. Settings manager preserves unrelated settings, but these are distinct identities.
- FPF-2 work-unit evidence commit: `70359811a374687ba94170edc0cad49780b00040` (`chore(skills): record verified user FP skill activation`), observed with whitespace checks passing and no push.
- User chose the supported narrower option `skill_only`: `/home/facundo/.pi/agent/skills/fp-format` -> `/home/facundo/projects/gentle-v4.0.0/skills/fp-format`. Pi follows directory symlinks for skill discovery. This does not activate the checkout's entire Gentle runtime. Settings, installed npm package, and dependency tree remain untouched.
- External allowed activation surface: only the symlink above (and its parent skills directory if absent); existing conflicting paths must not be overwritten. No private registry-testing hook is authorized.
- Skill-only activation performed: the user symlink was created without overwriting any existing target. `settings.json` SHA-256 remained `0124fe2bce2d7f8f0fe61c23bf3edc8f007be3afe0daac81c9299563889dcf71`; no config/package/runtime/dependency changes. The release source change is only this progress document; original fork remains clean.
- First public-loader verification command failed (exit 1): parent omitted required `skillPaths: []`, causing `TypeError: skillPaths is not iterable` before skill count/diagnostics/settings comparison. No source or configuration defect is inferred from this command/API mismatch.
- Corrected independent verification: `loadSkills({ cwd: '/home/facundo/projects/project-map-preview', agentDir: '/home/facundo/.pi/agent', includeDefaults: true, skillPaths: [] })` returned the target exactly once, exit 0, no target diagnostics. Loaded path `/home/facundo/.pi/agent/skills/fp-format/SKILL.md`; unchanged settings SHA verified. Symlink, source name and all three relative references are readable; installed Gentle remains 4.0.0. `git diff --check` passed; only this progress document changed. No live-session reload or registry refresh claimed.

## Next step

User-interface next steps: `/reload`, then `/skill-registry:refresh` in the project whose registry should include the skill; those live actions were not executed by this task. Implementation, package checks, authorized user-skill registration and default-loader discovery are complete. No push, runtime replacement, or document conversion. Validator and Project Map integration require separate authorization.
