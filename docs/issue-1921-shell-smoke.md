# One hosted Windows real-Shell memory smoke

This temporary push-only workflow targets `test/1921-real-shell-smoke-c161`.
The parent alone publishes it after review and observes ONE run; no reruns.
It tests exact candidate `c1617e90b81bac5a897a10211797bc30169794bf`, not a
registry/public upgrade. Old acquisition failures remain unchanged.

## Local checks — never execute the candidate

```sh
NODE_OPTIONS= NODE_PATH= NODE_V8_COVERAGE= node --test .github/scripts/issue-1921-shell-smoke.test.mjs
NODE_OPTIONS= NODE_PATH= NODE_V8_COVERAGE= node .github/scripts/issue-1921-shell-smoke.mjs --help
```

Pure tests cover admission, closed environment, installed-launcher argv and native
memory result validation. The real local CLI refuses before creating runtime
files or importing product code. Positive fixtures are models, NOT runtime proof.

## The single hosted attempt

The runner claims an owned private prefix/profile using the unchanged installer
ACL checks, acquires verified Node/pnpm/Core3.5.2 and pinned Go, packs the candidate
without prepack, normally resolves its local-tar/Pi1.2.0 pair, then performs the
real frozen installation with lifecycle hooks and the supported distribution
adapter. GentleAI4.2.0's unchanged Windows Go/SumDB source build is hosted-only.
The real installer, not this script, writes installation markers and provenance.

The installed `bin/gentle-shell.mjs` runs real `setup` (NOT dry-run), verifies
companion0.5.0 and Shell's own real provisioning record, then launches two
separate JSON-print Shell processes. Only the
loopback OpenAI-compatible LLM is synthetic. It requests actual native memory
tools; save id/status, full search and get-observation results must establish
synthetic content/project/scope and unchanged original attribution after restart.
Companion effective session attribution is not assumed equal to Pi's raw ID.
An exact owned-Core executable-path PID query checks live ownership and natural
shutdown after each Shell. Query errors terminate PowerShell; validation requires
exit0, confirmed command close, empty stderr and a nonempty JSON PID-array reply.
Only that successful query may establish an empty array, never missing output.
No service is killed by name/port; timeout cleanup addresses only a still-owned
spawned process tree, never an exited root PID even when descendants hold pipes.
Local host7437 is never used;
unchanged product startup checks run only inside the disposable hosted runner.

`evidence.json` starts FAILED with all claims false. Exact outer command argv,
closed env, exit and raw stdout/stderr files survive failure. Product-internal
subcommands are not independently instrumented. Only owned artifact streams,
pair/lock and receipts upload, never profiles/auth/store files. Capture retains
at most32MiB combined raw stdout/stderr bytes per command, including the accepted
prefix of an overflowing chunk; it stops writes/accumulation independently of
termination success. The first failure is latched. Deadline/failure or root exit
starts a two-second close/pipe grace period; a termination request itself has a
separate15-second bound. Missing close or failed termination is explicit cleanup
failure, never shutdown proof. Stuck local pipes/handles are detached so partial
evidence and bounded listener cleanup can finish; any surviving process is left
to disposable-runner teardown with FAILED status and ownedShutdown=false. One
final bounded cleanup remains eligible only for a still-live owned root handle.
Failure stops; no offline closure, published upgrade or complete runtime compatibility is inferred.
Actual setup/model/native-tool compatibility remains UNVERIFIED until that run.

## Pinned native result contracts (source, not execution)

- [companion0.5 source](https://raw.githubusercontent.com/Gentleman-Programming/engram/fe897f66e964c58284bdc83e6e5447f9ba8364c0/plugin/pi/index.ts):
  2283–2294/2308–2334 HTTP routes; 2636–2665 success `details.data` versus error.
- [Core3.5.2 HTTP](https://raw.githubusercontent.com/Gentleman-Programming/engram/v3.5.2/internal/server/server.go):
  716–818 save `{id,status:"saved"}`; 851–910 noncompact search RAW ARRAY;
  913–929 get returns direct Observation (history omitted).
- [Core DTOs](https://raw.githubusercontent.com/Gentleman-Programming/engram/v3.5.2/internal/store/store.go):
  162–182 Observation fields; 221–224 SearchResult embeds Observation plus rank.
  Missing/null project is rejected, not synthesized. MCP wrappers are not used.
