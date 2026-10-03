# External provisioning contract — review tracker

**Status:** Draft for a feature-branch review chain. The external owner, not Gentle Shell, controls readiness and provisioning approval.

**Canonical issue:** [Gentleman-Programming/gentle-shell#1383](https://github.com/Gentleman-Programming/gentle-shell/issues/1383)

## Goal

Allow Gentle AI to use `setup --external-ready` as an advisory marker only, after its external owner independently verifies Ready. The marker is not authorization, attestation, or proof that provisioning succeeded.

## Contract

- Before external effects, the Gentle AI owner obtains explicit approval and binds review and Apply to the exact Gentle Shell source/package root, version and source SHA, resolved home, and Pi runtime. Reject mismatches; do not silently retarget.
- No nested Gentle Shell setup, package removal, or Pi removal may run before approval. The marker handshake performs none of those effects.
- The external Gentle AI owner owns approval, Ready verification, effect inventory, and rollback for external effects. Gentle Shell owns only recording its advisory marker after the owner requests it.
- The marker neither authenticates the caller nor verifies Ready, approval, source, home, runtime, or Apply outcome.
- Marker config handling rejects symlinked config/temp paths and missing, symlinked, or non-directory existing path components before mutation; it merges the selected home entry while preserving other config keys.
- Write and fsync a temporary file, rename it into place, then fsync existing directory ancestors leaf-to-root before reporting success.

## Limits

- Same-version source-SHA drift is not detected; the external owner must verify the exact reviewed source.
- Concurrent plain launches during external Apply are not coordinated by this marker.
- Deleting config loses the marker; wholly corrupt config cannot be trusted or used as marker state.
- A post-rename directory-fsync failure may report failure while leaving the marker visible.

## Review plan and authority

- Keep this tracker as a draft and use two child review slices, each at most 400 changed lines: (1) post-Ready marker authoring, durable/nofollow config handling, and tests; (2) malformed/version-drift refusal, edge safety, and tests.
- Scoped feature-branch commits, pushes, and PR creation are authorized. No child or tracker PR merge or auto-merge is authorized.
- Not authorized: npm publication, preview, user Pi configuration changes, real Apply, or global npm installation.

## Rollback boundary

Revert this tracker draft only. Implementation files, tests, and unrelated working-tree state are outside this document.
