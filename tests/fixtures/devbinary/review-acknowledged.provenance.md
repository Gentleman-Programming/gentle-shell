# review-acknowledged/v1 fixture provenance

`review-acknowledged-v1.captured.json` is a byte copy of the stdout that
`gentle-ai review acknowledge-approved` printed when it burned one approved
compact authority. gentle-ai #3947 (main commit bc9f74d2) made that command
print this `gentle-ai.review-acknowledged/v1` envelope; every published
release up to and including v2.5.0-rc.3 burns the same authority with EMPTY
stdout (verified below).

- Captured 2026-08-31T08:51:50Z with the installed `gentle-ai 2.5.0-main.bc9f74d2`
  (`gentle-ai --version` banner) in a disposable Git repository under an isolated
  `HOME`; RDD was enabled only in that isolated HOME
  (`gentle-ai review mode enable --scope global`).
- Candidate: one uncommitted line appended to a committed `README.md`
  (`non_executable_only`, zero-lens, START closed `approved`).
- Commands, each the exact vector the previous envelope returned
  (`GENTLE_PI_REVIEW_RELAY_CONTRACT=gentle-pi.review-relay/v1` set for the Pi
  transport handshake):
  1. `gentle-ai review status --cwd <repo> --contract gentle-ai.review-integration/v2 --agent pi --next-transition`
  2. `gentle-ai review start --cwd=<repo> --contract=gentle-ai.review-integration/v2 --target=sha256:b505dcd8… --projection=workspace --lineage=review-3ec95251db75f626 --agent=pi --consent=relay`
  3. `gentle-ai review status … --lineage review-3ec95251db75f626 --next-transition` (offered `review.acknowledge-approved`)
  4. `gentle-ai review acknowledge-approved --cwd=<repo> --lineage=review-3ec95251db75f626 --target=sha256:b505dcd8… --expected-revision=sha256:9732b1c3… --token=<provider-issued>` (exit 0, empty stderr; stdout is the fixture)
- Replaying step 4 refused with exit 1, empty stdout, and the stderr line
  `approved acknowledgement names no live compact authority; it was already acknowledged and burned, …` (unchanged refusal shape).
- Pinned control: the same four steps against the pinned published
  `gentle-ai 2.5.0-rc.3` binary (sha256 b69da0a51b03f326147498ae465fc1ec52eff8427d579964eefad714c3f9bd87,
  the recorded asset digest) burned the authority with exit 0 and ZERO bytes on
  stdout and stderr, which is the silent path `acknowledgeApproved` keeps
  accepting byte-for-byte.

The disposable repositories and HOME were removed after the captures.
