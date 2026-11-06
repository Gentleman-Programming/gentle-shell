# Representative Windows Baseline/Candidate Probes

## Scope

This is a new, bounded diagnostic for three historically named Windows failures. It compares only the baseline commit `eff5d24694b21663095a4790b3ef15de21c290c2` with the local WIP candidate commit `141240232af7e15adf824434c6081daa381b9f3a`.

The probe does not attribute all 337 historical unit failures. The historical full log remains unavailable, and no full suite, installation, network action, provider/model harness, source change, or test change was performed.

## Preconditions and Isolation

- Runtime: Node `v24.14.0`; package manager available: pnpm `11.1.1`.
- `package.json` defines the unit runner as Node's TypeScript-stripping test runner. The targeted probes used that runner directly rather than `pnpm test`, which would run the whole suite and additional stages.
- Before extraction, the repository held about 200 MB of files and the workspace volume had about 502 GB free. Each source-only extracted snapshot was about 26 MB. No `node_modules` or Git history was copied.
- The two snapshots were extracted with `git archive` into the project-local, ignored `tmp/work-continuity-windows-diagnostic/` directory. They resolved the existing repository `node_modules` only as an ancestor dependency directory.
- Source inspection found no network, package-manager, provider, or persistent repository mutation in the selected test bodies. The pnpm-environment fixture creates and registers cleanup for a temporary local fixture directory; its selected body only creates a prefix configuration file and invokes the pure environment builder.
- The scratch directory was removed after the probes. This report is the retained durable evidence.

## Selected Cases

| Historical name | Exact test | Source location |
| --- | --- | --- |
| writer-surfaces registry roots expected `/repo` got Windows path | `the registry reports live overlapping writers in the same root only and releases them` | `tests/writer-surfaces.test.ts:171` |
| `commitTargetDirectory` git-C/leading-cd | `commitTargetDirectory follows git -C and a leading cd` | `tests/commit-slice-signal.test.ts:48` |
| `pnpmEnvironment` referenced-variable preservation | `pnpmEnvironment keeps the variables the prefix npmrc references and still drops npm settings` | `tests/bundled-install.test.ts:1181` |

The selected test files are unchanged between the two commits. The commit diff in the relevant set contains only `extensions/gentle-ai.ts`; therefore, these probes can compare the same test definitions and invocations across the two source snapshots.

## Invocation and Results

Each command was run once per version, in the indicated extracted snapshot, in the foreground. The command shape below is repository-relative and omits host paths. Node reported one selected test per invocation; no unrelated filtered test was counted as a pass.

| Case | Command shape, from each `tmp/work-continuity-windows-diagnostic/<version>/` snapshot | Baseline | Candidate |
| --- | --- | --- | --- |
| writer-surfaces registry roots | `node --experimental-strip-types --test --test-name-pattern '^the registry reports live overlapping writers in the same root only and releases them$' tests/writer-surfaces.test.ts` | exit 1; 0 pass, 1 fail | exit 1; 0 pass, 1 fail |
| `commitTargetDirectory` git-C/leading-cd | `node --experimental-strip-types --test --test-name-pattern '^commitTargetDirectory follows git -C and a leading cd$' tests/commit-slice-signal.test.ts` | exit 1; 0 pass, 1 fail | exit 1; 0 pass, 1 fail |
| `pnpmEnvironment` referenced-variable preservation | `node --experimental-strip-types --test --test-name-pattern '^pnpmEnvironment keeps the variables the prefix npmrc references and still drops npm settings$' tests/bundled-install.test.ts` | exit 1; 0 pass, 1 fail | exit 1; 0 pass, 1 fail |

## Sanitized Failure Evidence

1. **writer-surfaces:** Both versions returned the registry root as a Windows-native spelling equivalent to `C:\\repo`, while the fixture expects the POSIX literal `/repo`. The comparison failed at `tests/writer-surfaces.test.ts:177`.
2. **commitTargetDirectory:** Both versions resolved the `git -C ../other` result to a Windows-native spelling equivalent to `C:\\work\\other`, while the fixture expects `/work/other`. The comparison failed at `tests/commit-slice-signal.test.ts:50`.
3. **pnpmEnvironment:** Both versions failed before the referenced-variable assertions because the fixture supplied a native Windows temporary home to `prefixLayout` while simulating Linux. The builder rejected it with `The bundled install needs an absolute home directory` at `scripts/bundled-install.mjs:77`; the selected test call is at `tests/bundled-install.test.ts:1183`.

The Node test runner initialized successfully for all six invocations. The third case is a test-body failure caused by the fixture/platform mismatch, not a runner or snapshot setup failure.

## Conclusion

All three selected Windows failures reproduce identically on the baseline and the WIP candidate under the same Node runtime and exact targeted invocation. This establishes selected-case baseline parity only. It does not establish that every historical failure is pre-existing, unrelated to the candidate, or caused by the same Windows path behavior.

## Limits and Follow-up

- No claim is made for the inaccessible historical full log or all 337 failures.
- These tests exercise deterministic local functions and fixtures, not the reported agent behavior or a provider/model harness.
- The candidate remains unverified for delivery. The focused evidence does not waive full-suite or behavioral verification.
- If separately authorized, a follow-up should decide whether platform-neutral fixtures and path expectations are intended and then make a scoped correction with its own tests. That would be implementation work, outside this diagnostic.
