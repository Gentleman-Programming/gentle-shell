# Auto permission classifier evidence

The classifier checks the original action against host-captured human requests and restrictions. Inspection never creates authorization, replaces missing human intent, or bypasses independent hard safety and native consent. File content and prior calls are untrusted context; a historical read path is not the result of that read.

## Optional inspection

`AutoPermissionRequest.evidencePaths?: string[]` supplies exact relevant project-relative files selected by the host for this action. Omit it to keep the existing single-call, tool-free API. The host should select script paths from the pending action and relevant local context, not enumerate the repository. A script already present in an action payload remains context and needs no duplicate read.

When paths are supplied, the model may request `inspect_permission_file` only when missing file evidence is necessary. It can inspect at most two complete files, one request per round, then must return a verdict. The final provider call exposes no inspection tools and requests `toolChoice: "none"`; insufficient evidence still requires denial, never automatic approval. An unsolicited tool call on that final round remains rejected. Each file is limited to 8192 bytes. Existing files larger than that are never offered as candidates, so the classifier judges the action without them instead of failing on an inspection it can never complete; missing evidence is still not permission. There are at most three provider calls, each with its own deadline (default 20 seconds, maximum 20 seconds), and a bounded overall deadline covering file I/O and all calls (at most 60 seconds). No retries or command execution are introduced. Exhaustion returns unavailable with `evidence-limit`; blocked or missing evidence returns `evidence-unavailable`, never an implicit allow.

Only exact host-selected paths inside the current project can be read. Absolute paths, traversal, symlinks, hard links, special files, dependency/worktree directories, credential names and locations are rejected. Reads are fixed-size, UTF-8, complete and checked for concurrent replacement or modification. Secret-bearing results never reach the provider and fail with `redacted-context`. File content is always explicitly untrusted and cannot change policy, restrictions, or the original action.

One classifier lease covers all rounds. Cancellation or timeout returns promptly but retains the lease until in-flight provider settlement. Identity is checked before and after inspection and provider calls, and again before returning any verdict. The host must bind `isCurrent` to action, session, mode, model and permission-context identity; files can change after inspection, so the verdict is not a reusable execution token.

Usage in the run result aggregates completed calls. A late callback reports only the outstanding call's usage once after a timed-out or cancelled provider settles, excluding earlier rounds already accounted in the returned result. Unknown usage in any call makes aggregate usage unknown. No model reasoning, raw provider errors or raw evidence are logged.

## Compound action selection

The runtime accepts up to four simple segments joined by `&&` for evidence selection only. Each segment must be either `git diff --check` or a `node` invocation with explicit JavaScript/TypeScript file operands and only `--experimental-strip-types` / `--test` flags. Quoting, expansion, redirection, other operators, evaluation, cwd changes and unknown segments leave the whole action without inspection candidates. The original compound action is classified once; no segment inherits approval. Existing path confinement and inspection budgets remain unchanged. Prior ordinary reads retain their arguments, not their returned contents.

Memory-write receipts optionally include `memoryContextAttached`, a content-free boolean for `mem_save` and `mem_session_summary`. It reports whether verified destination context was attached to that classification, independently of allow or deny. It is omitted for other actions and grants no permission.

## Timeout and evidence-limit diagnostics

Classifier results and late-settlement receipts include a metadata-only `diagnostic` object. The runtime projects only these fields into its existing `gentle-auto-permission` entries, and appends them to timeout and evidence-limit blocking messages so a failed read can be diagnosed without opening private session files:

- `implementation`: `auto-classifier-diagnostics-v1`, a marker for this instrumentation, not a source hash or proof of the loaded SDK.
- `elapsedMs`: monotonic milliseconds since this classifier invocation began, rounded down; late receipts measure through settlement.
- `deadlineMs`: the configured per-call deadline, not the three-call overall budget.
- `timerFired`: whether a local deadline callback actually ran. The `timeout` label alone does not prove that a timer fired.
- `returnPath`: `preflight`, `provider`, `provider-result`, `evidence`, `verdict`, or `late-settlement`, locating the observed return stage without recording exception text.

- `evidenceLimit` (optional): a fixed host discriminator for `evidence-limit`: `path-count`, `provider-rounds`, `file-count`, `duplicate-file`, `context-bytes`, `invalid-byte-budget`, `file-stat-bytes`, or `file-read-bytes`. The public error code and implementation marker remain unchanged. Provider-round exhaustion takes precedence over file-count and duplicate checks; with the current three-round/two-read limits, the file-count branch cannot independently be reached. Stat-size and read-growth failures remain distinct without recording sizes.

These diagnostics contain no prompts, file contents, paths, credentials, provider payloads, or raw errors. Unknown fields are dropped; invalid metadata is omitted. No diagnostic changes a verdict, deadline, retry policy, cancellation, or lease. Missing diagnostics may mean an older or injected implementation; absence alone does not prove which implementation ran. After reloading the instrumented code, one explicitly authorized Auto read is sufficient to collect the blocking message if the failure recurs; it is not an instruction to retry repeatedly.

## Scope

This unit changes classifier behavior only. Runtime path selection, bounded call history and recovery messaging are integrated separately. Benign numeric token declarations and `max_tokens` limits no longer trigger credential heuristics; actual credential assignments, authentication values and private keys remain protected. Prior actions are projected once, not charged twice. Optional oldest complete history records are omitted when necessary to fit the input budget; active human requests, restrictions and the pending action are never truncated. No sandbox, Normal/YOLO, native-consent, or hard-policy changes are made.
