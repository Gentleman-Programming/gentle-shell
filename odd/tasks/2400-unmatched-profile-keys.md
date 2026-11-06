# gentle-shell #2400 — surface model_profiles keys with no suggestion

Issue: #2400 (follow-up to #2196 / PR #2397). Branch `fix/2400-silent-unmatched-keys` from main `5694b22c3`.
Decision of record: Juan chose both surfaces ("hacé las dos opciones para el 2400").

## Problem

A `model_profiles` key that matches no discovered agent and has no did-you-mean suggestion (e.g. typo `explor`) is silent:
the launch warning only fires when the suggestion is the agent being launched, and the profiles panel builds
"Current routing (effective)" from discovered agents only, so the key never appears.

## Specs

- **S#1** Launch: once per parent session, the first subagent launch (UI only) warns listing every `model_profiles`
  key that matches no discovered agent and has no suggestion. The existing per-agent near-miss warning is unchanged.
  Later launches in the same session do not repeat it.
- **S#2** Panel: the profiles panel shows the unmatched keys with no suggestion as an "unmatched keys" note/row,
  fitting narrow (32-col) panels without truncating the key names silently. Keys with a suggestion keep their current note.
- **S#3** Resolution stays exact-match: no key is ever routed by these changes.
- **S#4** Tests RED first in `tests/gentle-agents.test.ts` (S#1) and `tests/gentle-ai.test.ts` (S#2).

## Tasks

- T1 [x] S#1, S#4 — once-per-session launch warning. Route: delegated (writer trigger: 2+ non-trivial files across T1/T2). Commit `988a99942`.
- T2 [x] S#2, S#4 — panel unmatched-keys row. Route: delegated (same writer). Commit `44c3e308d`.

## Log

- T1 `988a99942`: launch seam keeps the near-miss warning and adds one warning per parent session id
  (`"explor" did not match any agent and was ignored.`, keys sanitized, joined per key). RED: new test failed with
  `0 !== 1` before the change; GREEN after. Resolution unchanged (test asserts the launch is not profile-routed).
- T2 `44c3e308d`: profiles panel adds an "Unmatched keys (ignored)" section after "Current routing (effective)", one key
  per line, `key  ← no matching agent` inline or `key` / `  ↳ no matching agent` when it does not fit (32-col pane
  checked). Source is `loadAgentsConfig(...).modelProfiles` through `unmatchedProfileKeys`; keys already shown as
  current rows are skipped, and the section is omitted when a session binding or a pin wins (that snapshot's keys
  are already rows). RED: heading regex failed before the change; pin-guard test fails with the guard removed.
- Verification: `node --experimental-strip-types --test tests/gentle-agents.test.ts` 264/264 pass;
  `tests/gentle-ai.test.ts` 126/126 pass; `tests/agents-config.test.ts` 17/17 pass; `pnpm typecheck` 0 diagnostics.
