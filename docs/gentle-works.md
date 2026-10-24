# Durable local works

`lib/gentle-works.ts` stores explicit objectives independently of sessions. This is a registry, not an orchestrator. `/gentle:works` opens its keyboard-driven center in TUI mode; `/gentle:works help` (or `--help`) explains usage safely in any mode. Other arguments show usage without writing. Non-TUI center calls fail explicitly.

## Work center

The Session command palette includes **Durable works** only when `/gentle:works` is registered. Arrows or `j`/`k` select **Create work + link current session** or a persistent work; Enter opens it. Escape/`q` goes back from details and closes at the list. No startup scan, watcher, automatic launch, cleanup, routing change or session switch is involved.

- Create asks for a required title and full objective, then saves once with explicit `pending` status and an empty summary. It captures the canonical current Git worktree and branch when available. Creation explicitly links the current saved session. An unsaved session has no fabricated path: the work is created without a locator and a notice explains why.
- Details show identity, explicit status, branch/worktree, exact session ID/file, objective, summary and ODD reference. Arrows/`j`/`k` and Page Up/Down scroll the complete content at narrow widths too.
- `e` opens native dialogs for explicit status, summary and optional ODD reference. Blank ODD preserves the existing reference (clearing is not supported). Escape at any dialog cancels the entire edit; no partial record or revision is saved.
- `l` explicitly replaces only the linked session locator with the current saved session; an unsaved current session produces a visible no-op. It does not change branch/worktree or switch conversations.

Activity is a separate observation, never a stored work status. Only an exact current session ID **and** file match uses Pi's `ctx.isIdle()` to display `waiting`/`running` with observation time when details open. Other sessions display `unknown`, not disconnected, live or resumable. Reopening details refreshes the observation; there is no background activity feed. Worktree/session existence is checked lazily on inspection. Missing or inaccessible paths remain visible with uncertainty and records are retained. File presence alone proves neither activity nor resumability. Displayed terminal controls are sanitized, not secret-redacted.

## API for the panel

1. `resolveWorkContext(cwd, agentHome?)` resolves the canonical Git clone identity and current worktree. The default home uses `resolveGentlePiAgentHome()`.
2. `listWorks(context)` returns `{ revision, works }`; only a missing registry returns revision zero and an empty list.
3. `createWork(context, input)` returns a work with a random stable ID, clone identity and revision one.
4. `updateWork(context, id, patch)` merges explicit fields against the latest stored work under the lock and returns the revised record. Independent field patches do not replace each other. For conflicting fields, the last serialized accepted update wins. The `e` dialog saves only the fields you changed, so an untouched field keeps a value another Shell saved meanwhile; saving with no changes writes nothing. A lock is never removed automatically: if one is older than 60 seconds, the busy error names the lock file so you can delete it after checking no other Shell is updating works.

Input requires `title`, `objective`, `status` and `summary`. Status is `pending`, `in_progress`, `blocked` or `completed`; an empty summary is allowed. Titles are bounded to 256 characters, objectives to 4096, summaries to 16384. Optional branch and ODD references are nonblank strings up to 4096 characters. Optional worktree and session file paths must be absolute; the session locator is `{ id, file }` (ID up to 512 characters). Unknown fields and null/undefined values are rejected. To unlink optional fields, a future API extension is needed; omission in a patch preserves them.

Session locators are metadata only: they do not establish activity, resumability, permission or routing. Branches, worktrees and ODD references need not still exist. Listing never deletes records because a location disappeared.

## Storage and failures

Storage is `<agentHome>/gentle-works/<canonical-clone-digest>/registry.json`. Newly created directories request mode `0700` and registry/lock/temporary files request `0600` on POSIX (subject to umask); existing parent permissions are never changed. Git linked worktrees share that digest; unrelated clones do not. Nothing is written into the project, Engram or herdr. Canonical Git resolution reuses the read-only permission helpers, not native authority creation.

The version-one registry validates every stored record, clone identity, unique ID and revision before updates. Each accepted update increments both its work revision and the registry revision. Rejected operations do not change either. Invalid JSON/schema produces `Invalid work registry`; invalid input produces `Invalid work data`; unknown IDs produce `Work not found`. Filesystem read/permission errors propagate, never becoming empty results.

Exclusive `registry.json.lock` creation serializes cross-process read/merge/write. Contention retries for about two seconds, then throws `Work registry busy`. Locks protect only the registry, never project files, and confer no writing authority. No stale lock is automatically deleted: a crash can require operator investigation. Writes use a unique same-directory temporary file, flush it, then atomically rename it over the registry. Failed updates clean up their own temporary files and locks. Filesystem permission/rename failures remain errors.

Storage paths are checked for symlinks and nonregular targets, including ancestor directories (`Unsafe work registry path`). The storage home must be absolute. This assumes a trusted local agent home: checks do not defend against a hostile process concurrently replacing ancestor directories, and are not a sandbox. Network filesystems with weaker exclusive-create/rename semantics are not supported guarantees. File flushing is not a promise of directory-entry survival after power loss.

## Verification boundary

The focused Node tests use disposable, realpath-canonicalized system-temp Git repositories, a real linked worktree, a separate clone and child Node processes. They exercise reload, rejected input, corrupt schema, nonregular targets, file symlinks/directory junctions, lock contention and independent concurrent updates. Child successes must have exit zero and empty stdout/stderr. Symlink tests skip only when Windows actually denies link creation; directory tests use junctions on Windows.

The optional final `WorkReadIO` argument on list/create/update injects only the registry read operation. Tests use it to force exact EACCES/EIO failures, then verify unchanged registry bytes and public revisions and successful subsequent lock acquisition. This proves error propagation, not host ACL enforcement. Windows execution is observed; POSIX execution and mode assertions require separate evidence. Fixture roots resolve OS temporary-directory aliases before storage safety checks. The storage API does not change session lifecycle or permissions. Separate command/component harness tests exercise center actions, cancellation, corruption, activity separation, missing paths and bounded rendering; these are not evidence of a live interactive terminal run.

`tests/gentle-works-continuity.test.ts` adds the three-work acceptance journey: a real isolated clone and two linked worktrees on distinct branches, with distinct session locators, explicit statuses, summaries and ODD references. Fresh Node processes reload through the public API and registered command harness, first with locations present and then with all session files absent and one worktree removed. All three records and public revisions remain unchanged; details retain exact locators, report unknown activity and missing locations, and inspection neither recreates session files nor changes the Git worktree list. Fixtures use the system temporary directory and are removed in teardown.

This is functional reload acceptance, not an actual interactive Shell restart or live TUI validation. POSIX execution remains unverified. This acceptance coverage exercises already-working behavior, so no meaningful RED phase was claimed. Delivery history, test-run counts and native-review status are tracked in `odd/tasks/gentle-works.md`, not here.

Still unverified: POSIX execution, real ACL-denial behavior, and conversation resumption across an interactive terminal restart.
