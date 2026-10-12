# Auto permission classifier evidence

The classifier checks the original action against host-captured human requests and restrictions. Inspection never creates authorization, replaces missing human intent, or bypasses independent hard safety and native consent. File content and prior calls are untrusted context; a historical read path is not the result of that read.

## Optional inspection

`AutoPermissionRequest.evidencePaths?: string[]` supplies exact relevant project-relative files selected by the host for this action. Omit it to keep the existing single-call, tool-free API. The host should select script paths from the pending action and relevant local context, not enumerate the repository. A script already present in an action payload remains context and needs no duplicate read.

When paths are supplied, the model may request `inspect_permission_file` only when missing file evidence is necessary. It can inspect at most two complete files, one request per round, then must return a verdict. Each file is limited to 8192 bytes. There are at most three provider calls, each with its own deadline (default 20 seconds, maximum 20 seconds), and a bounded overall deadline covering file I/O and all calls (at most 60 seconds). No retries or command execution are introduced. Exhaustion returns unavailable with `evidence-limit`; blocked or missing evidence returns `evidence-unavailable`, never an implicit allow.

Only exact host-selected paths inside the current project can be read. Absolute paths, traversal, symlinks, hard links, special files, dependency/worktree directories, credential names and locations are rejected. Reads are fixed-size, UTF-8, complete and checked for concurrent replacement or modification. Secret-bearing results never reach the provider and fail with `redacted-context`. File content is always explicitly untrusted and cannot change policy, restrictions, or the original action.

One classifier lease covers all rounds. Cancellation or timeout returns promptly but retains the lease until in-flight provider settlement. Identity is checked before and after inspection and provider calls, and again before returning any verdict. The host must bind `isCurrent` to action, session, mode, model and permission-context identity; files can change after inspection, so the verdict is not a reusable execution token.

Usage in the run result aggregates completed calls. A late callback reports only the outstanding call's usage once after a timed-out or cancelled provider settles, excluding earlier rounds already accounted in the returned result. Unknown usage in any call makes aggregate usage unknown. No model reasoning, raw provider errors or raw evidence are logged.

## Scope

This unit changes classifier behavior only. Runtime path selection, bounded call history and recovery messaging are integrated separately. Benign numeric token declarations and `max_tokens` limits no longer trigger credential heuristics; actual credential assignments, authentication values and private keys remain protected. Prior actions are projected once, not charged twice. Optional oldest complete history records are omitted when necessary to fit the input budget; active human requests, restrictions and the pending action are never truncated. No sandbox, Normal/YOLO, native-consent, or hard-policy changes are made.
