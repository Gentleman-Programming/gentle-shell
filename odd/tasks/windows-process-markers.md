# Windows process-boundary markers
Locate the failing operation in one original-file diagnostic; do not repair production or normal CI.
Branch: `ci/213-windows-markers` from public `5f49c5f2`; isolated diagnostic only.

## Specs
S1. User: "hagamos eso", approving "localizar la llamada que falla dentro del test original usando marcadores, en otro diagnóstico acotado".
S2. Boundary: "Detuve las ejecuciones; #1950 sigue intacto." No main merge, production fix, normal-CI pin or additional hypotheses executed automatically.

## Tasks
T1 | S1-S2 | inline + independent verify | in_progress | Own6/6 GREEN, independent6/6 PASS, no skips; initial matcher blocker reproduced and resolved; ready to commit.
T2 | S1-S2 | inline | pending | Publish one diagnostic commit; one hosted execution, full evidence read and stop; local journal pending.

## Log
L1. User request verbatim: "hagamos eso".
L2. Frozen original source41210ef5d87f6242c507b04b818801ffa9b7f49b, file tests/installer-windows-bootstrap.test.ts. Node24.21.0, Windows imagewin25-vs2026/revision20260925.250.1,180s/8MiBouter limits,alwaysupload7day. Image mismatch means unavailable evidence, not permission to retry. Prior baseline0xC0000409; minimal overflow run37874407946 passed, cause unknown.
L3. Instrument by builtin-only --import preload, not editing frozen installer/test. Wrap spawn/spawnSync with Reflect.apply and syncBuiltinESMExports; return exact result or rethrow exact error. Emit bounded synchronous stderr markers: PID,call ID,method,phase,allowlisted executable name and allowlisted source site. No argv/env/fullpaths/payload/error messages. Do not add child listeners, timers, retries, or alter their options. Allow ESM named imports to observe wrappers. Diagnostic preload changes test-runner argv only; child argv/env/options remain untouched.
L4. At most256 process-boundary markers per Node process, then one limit marker. Marker writes best-effort; failures must not suppress the actual call or replace its result/error. A missing after marker localizes a boundary, not a native crash cause. Async crash after a returned spawn remains ambiguous. Instrumentation may change timing; a passing run does not prove the original failure fixed.
L5. Own test-first public subprocess checks verify exact exit/stdout/stderr markers, return/throw identity, ESM named imports, marker cap and failed writer. Workflow structure/syntax and unchanged guard checks; no local full installer execution. Independent agent before publication. Risk item5CI. Native assessment once; protected .status-213-checks/rawdata remain unread/undeclared; no native STATUS. All local journals/raw artifacts excluded from publication. Original PR1950 stays ready for agent review, no added human gate.
L6. Parentjob85 RED5 absent-file failures; initialGREENjob86 5PASS/0FAIL/0SKIP. Independent mv0cwhmb-j-n5vl ran5tests once and found a blocking site-extraction gap: unanchored basename substring/unbounded coordinates; no production issue claimed. Parentaddedknown-site/prefix/path-component/overlong-coordinate case: job87RED1 exactassertionfailure. Matcher now requires an entire stack frame, basename path separator, at most6 coordinate digits, bounded16KiB stack. No argv/options/result/throw/guard changes. One scoped independent correction recheck before publication; no native assessment retry (already unavailable due protected untracked scope).
L7. Job88 GREEN6PASS/0FAIL/0SKIP plus whitespace PASS. Independent correction mv0d1sbo-k-s9o7 resolved the blocker with6PASS/0FAIL/0SKIP; no extra probes. YAML/action configuration inspected manually, embedded JS syntax checked; no dedicated YAML validator. Git readback shows no prior tracked edits; stage only four new diagnostic files, public5f49 parent, no tracker67 ancestry. Existing workflow push filters do not select ci/213-windows-markers. Hosted evidence remains T2; no local installer run.
