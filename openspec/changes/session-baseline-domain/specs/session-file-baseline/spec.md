# Session File Baseline Specification

## ADDED Requirements

### Requirement: Canonical baseline keys are collision-safe

The domain MUST accept caller-supplied `repositoryIdentity`, `worktreeRoot`, and `relativePath` strings and make their ordered tuple the canonical key. Its internal encoding MUST be injective, not delimiter concatenation, so distinct tuples cannot collide.

#### Scenario: adjacent values remain separate

- GIVEN keys with differently partitioned component strings
- WHEN their components would collide under a delimiter-based encoding
- THEN the domain keeps independent records

### Requirement: First baseline is immutable and defensive

The domain MUST retain the first supplied state for a key, including an unavailable state, and return snapshots rather than internal references. It MUST copy key/state data rather than freezing or retaining a caller object.

#### Scenario: later registration cannot replace unavailable

- GIVEN a key whose first state is unavailable with a reason
- WHEN the caller records an available state for that key
- THEN the original unavailable snapshot remains the baseline

### Requirement: Baselines compare supplied opaque versions

A baseline state MUST be exactly `absent`, `available` with an opaque version token, or `unavailable` with a reason. Comparison MUST return `same`, `different`, or `unavailable`; unavailable on either side produces `unavailable`.

#### Scenario: a restored state has no net change

- GIVEN an available baseline version
- WHEN a later available version differs and then the baseline version is supplied again
- THEN comparison changes from `different` to `same`

#### Scenario: absence compares without file access

- GIVEN an absent baseline
- WHEN absent is supplied again
- THEN comparison returns `same` without reading a file
