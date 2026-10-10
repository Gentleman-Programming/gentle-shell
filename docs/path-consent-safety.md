# Path-consent safety

The path-tool fence from PR #1610 requires per-target, per-session confirmation for `read`, `write`, `edit`, `grep`, `find`, and `ls` outside the session worktree or registered same-clone worktrees. These follow-ups depend on that PR; they do not add Bash path fencing.

## Resolution and boundary inputs

- Dangling symlinks resolve to their destination before consent is checked. Inaccessible or cyclic links block rather than inventing an internal target (#1659, already corrected in the dependency).
- Durable worktree roots must be canonical, absolute, existing paths. Empty, relative, and malformed roots cannot widen the boundary (#1660, already corrected in the dependency).
- Consent is ephemeral and cannot carry across sessions.

## Confirmation failures

Shell-command and outside-path confirmation have the same failure semantics:

| Outcome | Result |
| --- | --- |
| Confirmation returns `true` | The guarded call is allowed. |
| Confirmation returns anything else, or the UI/confirm capability is absent | The call is denied. |
| Confirmation throws or rejects | The permission lifecycle settles as denied, then the original error propagates. |

Missing confirmation never grants a path target. A subsequent attempt still requires consent. Headless confirmation-required calls remain blocked.

## Tool-schema coverage

`tests/path-consent-fence.test.ts` compares the installed Pi tools' complete input-key shapes, including nested properties, with an explicit snapshot for all six fenced tools. An added field such as `backupPath` fails this assertion instead of silently escaping review. On a Pi upgrade, review which new fields carry paths and update fence collection and its regressions before accepting a new snapshot. The test also injects top-level and nested schema drift to prove the assertion rejects it.

## Focused checks

```sh
node --experimental-strip-types --test tests/path-consent-fence.test.ts tests/session-worktree-registry.test.ts
node --experimental-strip-types --test --test-name-pattern='missing confirmation capability|guarded command confirmation' tests/gentle-ai.test.ts
```

All filesystem witnesses use disposable fixtures, not user files. Existing dependency regressions establish the dangling-link and invalid-root protections; the complementary diff only changes missing-confirmation behavior and adds schema-drift coverage.
