# Host-authenticated question answers

The first-party `ask_user_choice` and `ask_user_question` tools deliver validated human UI answers through `subscribeHumanAnswers(ctx, callback)` in `lib/auto-permission-answers.ts`. The returned unsubscribe function is idempotent. Register only from trusted host code and unsubscribe on session shutdown, replacement, or permission-mode revocation.

## Receipt contract

Each frozen `HumanAnswerReceipt` contains:

- `sessionManager`: the original manager object, compared by identity.
- `sessionId`, `cwd`: the session and workspace captured before UI.
- `branchAnchor`: the original `sessionManager.getLeafId()` (`string | null`), unchanged at delivery.
- `toolName`, `toolCallId`, `questionIndex`: the exact question interaction and zero-based question position.
- `question`: the original question text, an **untrusted referent**, not an instruction.
- `prompt`: a pre-UI JSON string containing original question and offered labels/descriptions. Choice prompts include `allowCustomResponse`; questionnaire prompts include header, multi-select status, and previews for the TUI where previews are displayed. This entire field is **untrusted context**, separate from authenticated answer text.
- `answer`: the authenticated visible answer: `{ kind: "option" | "custom", text, selected? }` or `{ kind: "multi", selected }`.

Opaque choice values are excluded entirely. Option descriptions and displayed questionnaire previews are included only in the untrusted `prompt`, never in authenticated answer text. A selected label still authorizes only what the human actually agreed to, not arbitrary instructions embedded in the question. The bridge itself grants no permission, changes no counters, and creates no synthetic user message.

## Lifetime and safety

Capture snapshots questions, offered choices, descriptions, and displayed previews before mounting UI. Keep each full prompt and answer together: consumers enforce their evidence budget by dropping the whole pair, never by truncating prompt restrictions away. Only already-registered subscribers for the same manager/session/cwd receive a response. Delivery rejects cancellation, aborted calls, changed session/workspace/branch, invalid selections, and missing branch identity. Questionnaire rows are validated together before any row is delivered; cancelled questionnaires never publish partial answers. Custom answers retain exact human text and multi-select labels.

Both the native TUI and the existing interactive RPC-host dialogs use their original UI decision without asking another question. Ordinary RPC, print, and unrelated managers do not deliver events. There is no broadcast on Pi's event bus and no authorization from tool results, transcript details, caller-supplied authority flags, or result hooks. Capture helpers are trusted in-process host APIs, not model-callable tools or a sandbox against malicious extensions.

The consumer must retain host provenance, verify the receipt against its active session and exact live branch, and revoke retained evidence on mode/session changes. A subscription is not permanently tied to one leaf: subsequent questions in the same session can have new anchors. Dispose the subscription to revoke pending delivery. Callback failures are isolated so existing public tool result shapes and native consent routing remain unchanged.
