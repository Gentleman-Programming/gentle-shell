# Engram 3.4.0 integration
Objective: finish the authorized published-core integration for issue #2137; branch `fix/2137-engram-340-pin`, base `39281800858b44d7810319f5fbce2b6b02565924`.
Delivery: one focused PR, nonclosing issue reference; Node strip-types tests, runtime generator, independent verification and repository CI.

## Specs
S1. User authorization: "Go" in response to publishing Engram compatibility support and completing Shell integration. Use published Engram 3.4.0 archives with verified sizes and checksums; keep existing admission rules and authentication unchanged.
S2. User instruction: "Termina please basta de trabarte, quien te dice que te trabes ? Que pasa ? Es por culpa del harness?" Complete tests, documentation and delivery; report genuine blockers rather than repeatedly stopping at progress updates.

## Tasks
T1 | S1 | inline | done | Engram tag and stable release published at green upstream commit `5c4171845958f046968c14d7d57a325eb4a83b7e`; six archives rehashed; schema 1 proven; isolated native instance-id smoke passed. No Shell source commit for this release-only work.
T2 | S1-S2 | inline | verified | Pin, independent expectations, schema entry, runtime and docs updated. RED observed; GREEN 215/215 after SDK resolution. Commit pending.
T3 | S1-S2 | independent verify + parent delivery | in_progress | Independent PASS: 215/215, six archive hashes/sizes and native payload match, runtime/diff clean. Parent spot check passed. Commit, native review when due, PR/CI/merge pending. No merge bypass.

## Log
L1. User: "Go". Authorized Engram release after explicit cross-repository publication question.
L2. User: "y porque no lo haces?"
L3. User: "Termina please basta de trabarte, quien te dice que te trabes ? Que pasa ? Es por culpa del harness?"
L4. Tracking document created late, after first source edits; this records the actual continuity state rather than claiming tracking preceded implementation. Earlier state is recorded in Engram session summaries.
L5. Release workflow 38271361140 passed; release stable, non-draft. Six archive SHA-256 values match published checksums; observed byte sizes. Native darwin-arm64 binary reports 3.4.0 and instance-id creates identity/lock only under isolated HOME, no database.
L6. RED schema returned undefined instead of 1. Installer expectation initially corrupted by a truncated read/write, restored only that self-edited file from HEAD and reapplied exact replacements. Corrected RED pin returned 3.3.2 instead of 3.4.0. No unrelated changes restored.
L7. Source updates limited to pins and schema proof; no classifier, probe, provenance or authentication algorithm changes. Documentation explains global server must itself update/restart and tokens are not bypassed.
L8. First scoped suite passed 214/215; one test could not resolve the Pi SDK from the isolated worktree. Linked existing same-clone node_modules without installing/updating dependencies. One recheck passed 215/215, runtime/diff checks passed. Independent verifier repeated all checks and rehashed six archives successfully; parent runtime/diff spot check passed. Optional real-endpoint smoke omitted because loopback bind confinement lacked inspected evidence. No full suite executed locally.
