# Frozen request intent in Shell

Fresh ordinary `gentle_review` START accepts `input.requestContextPath`, for example:

```json
{"operation":"start","input":"{\"mode\":\"ordinary\",\"requestContextPath\":\"docs/feature-request.md\",\"lenses\":[\"risk\"],\"lensesReason\":\"Changes document authorization\"}"}
```

Relative paths resolve against the selected workspace. Supply an existing UTF-8 file containing the request the candidate was built for; files outside the repository can be explicitly selected too. Gentle AI reads the file through its existing `--request-context` contract, includes it in the native prompt budget, freezes its contents, and binds the hash into authority and reviewer subject identity. Shell forwards the provider-issued START and consent arguments unchanged. Before forwarding the file, Shell queries the selected executable’s advertised capabilities and requires both `start_request_context` and `start_options_preflight`. Unsupported providers fail early with “provider does not support request context”; Shell never retries without its intent.

Use this field when business intent is needed to distinguish a requested behavior change from a regression. `lensesReason` only explains lens selection, and a README does not reach reviewers merely because it exists. Native treats request text as evidence, not reviewer instructions, and excludes its optional `## Verify` section from reviewer context.

Existing lineages retain their frozen intent. START with an explicit request file is blocked when authority already exists; resolve that authority through the ordinary workflow before requesting a fresh review. Editing the source file does not rewrite an old review or retroactively revoke its original scope. Native refuses replaying a lineage under a changed request, and produces different reviewer subject hashes for different intent. Resume with `lineageId` without supplying a request path; the original frozen intent remains in force.
