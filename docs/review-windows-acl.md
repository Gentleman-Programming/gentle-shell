# Windows candidate owner observations

Candidate creation, verification and explicit cleanup retain their existing owner, DACL, marker, lock, registration and replacement checks. Each Windows safety boundary obtains a fresh observation. The three parent directories share one read-only PowerShell invocation; file checks remain separate. Observations are not cached across calls, Git callbacks or writable-conversion callbacks.

The trusted system PowerShell reads the current identity and each requested object's owner and Access SDDL. Paths travel through UTF-8 JSON on stdin. The response is bounded and must contain the complete ordered set of observations. Existing owner/DACL policy validators decide whether those observations are authorized. Invalid responses and policy failures are outside the idempotent transport retry.

This reduces process startup work without changing removal sequencing or adding a recursive deletion fallback. Automatic Windows orphan sweeping remains conservative. Non-Windows ownership checks keep their existing behavior.

## Verification

```sh
node --experimental-strip-types --test tests/review-owner-identity.test.ts tests/review-candidate-windows-probe.test.ts tests/review-candidate-owner-retry.test.ts tests/review-candidate-owner-sweep.test.ts
node --experimental-strip-types --test tests/review-candidate-windows-boundary.test.ts
```

The second file uses real Windows ACLs in disposable Git repositories, including quoted/Unicode paths, changes after Git inspection, marker/lock tampering, Git removal failure and parent replacement. It skips on other platforms. The parser/transport tests separately cover incomplete responses and an unauthorized owner through a controlled subprocess response; they do not claim a privileged ownership transfer.

Related work and experimental measurements: [issue #2881](https://github.com/Gentleman-Programming/gentle-shell/issues/2881). The combined redesign measurements include other changes and are not an isolated performance claim for this patch.
