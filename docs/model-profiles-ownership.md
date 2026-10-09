# Model profile ownership

Startup reapplies saved routing without treating a saved inherit entry (`{}`)
as consent to erase user-authored `subagents.json` profiles for discoverable
agents. For those agents, sweep clears require recorded materialization.
Existing cleanup for saved clear entries whose agent names are no longer
discoverable does not apply that ownership guard. Explicit panel/profile clears
continue to clear their named routing and model/thinking frontmatter; unrelated
profiles, fields and concurrency settings remain untouched.

## Crash-safe bookkeeping

Both synchronous and asynchronous apply paths coordinate ownership membership
through a permanent `materialized-model-profiles.json.lock` file. The pinned
`fs-native-extensions@1.5.1` binding uses `tryLock(fd)` on a writable descriptor
and `unlock(fd)` followed by close in `finally`. The kernel releases ownership
on process death. The mutex file is never removed or renamed; its contents,
PID and age have no authority. Do not delete it while sessions are running.

Membership is read after acquisition. The read-modify-write section contains
no asynchronous suspension, including for the asynchronous apply path. Waiters
retry for at most five seconds. Contention or native acquisition failure never
permits an unlocked ownership write. A snapshot published before a release error
remains committed; descriptor close is still attempted in `finally`. There is no
unlocked fallback. This remains best-effort bookkeeping after routing has been
written, not a transaction over routing, frontmatter and ownership together.

The ownership JSON is written to a unique same-directory temporary file and
atomically renamed over the previous snapshot. A crash before rename preserves
the complete prior snapshot. It can leave an inert partial temporary file and
a newly routed profile without committed ownership; a startup sweep must not
invent ownership for that profile. A later explicit clear still works. Temporary
files are not claims and do not block the mutex.

## Runtime and verification boundary

The binding is a production dependency, not a test-only lock implementation.
The package includes `lib/native-file-lock.ts` through its existing `lib/`
publication surface; Pi loads it as TypeScript, with no generated runtime copy.
Installation can use `--ignore-scripts`: the dependency ships prebuilt bindings.
Unsupported native loads fail rather than switch to PID/age recovery.

The recovery tests exercise real held child descriptors, bounded sync waiting,
async exclusion, process-death release without path replacement, cross-process
ownership union and a kill during temporary publication through public apply
APIs. Existing preservation tests cover unowned startup entries, equal-value
routing, interleaved sync/async updates and consented clears. Standalone binding
compatibility evidence is distinct from application integration proof; application
GREEN on one platform does not establish every host or packed-install behavior.
