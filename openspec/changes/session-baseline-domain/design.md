# Design: Pure Session File Baseline Domain

## Decision

`lib/session-file-baseline.ts` is an instantiable, pure TypeScript domain. A caller creates and retains an instance for its chosen session/ancestry boundary; the module exports no shared registry or session lifecycle policy.

## Model

- A key is the ordered three-string tuple `repositoryIdentity`, `worktreeRoot`, and `relativePath`.
- Internal key encoding is length-prefixed (or equivalently injective), never a raw delimiter join.
- A state is `absent`, `available` with an opaque string version, or `unavailable` with a reason.
- `recordFirst(key, state)` clones the supplied key/state into private storage and always returns a fresh snapshot of the original record.
- `compare(key, current)` returns `same`, `different`, or `unavailable`; an unknown key is unavailable rather than implicitly baselined.

The domain stores tokens and reasons only, never file bytes. It does not resolve paths, read Git, capture before a delegate, persist data, or infer ownership.

## Invariants and trade-off

First write wins even when the first value is unavailable. This conservative rule prevents a later observation from rewriting the boundary. Returning copied snapshots protects internal state without `Object.freeze` on caller-owned values. Opaque version tokens keep byte handling and version production outside this unit; callers decide how a token is produced.

## Test seam

Use `node:test` and `node:assert/strict` in `tests/session-file-baseline.test.ts`, run with `node --experimental-strip-types --test`. Cover key separation, first unavailable retention, defensive snapshots, absent/available/unavailable comparison, and restoration to `same`.
