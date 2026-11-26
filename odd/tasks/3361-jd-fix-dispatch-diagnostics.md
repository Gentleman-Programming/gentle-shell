# 3361 jd-fix-agent dispatch diagnostics

Make a rejected `jd-fix-agent` dispatch self-diagnosing (gentle-shell#3361) without relaxing validation.
Branch `fix/3361-jd-fix-dispatch-diagnostics` from origin/main 21c73c134.

## Specs

- S1. The rejection names the failed conditions. Issue: "**Expected:** the rejection names the failed conditions, and the skill (and/or the message) documents the canonical hash algorithm and the ID grammar — or exposes a way to obtain the digest." Today one generic text covers every clause (`extensions/gentle-ai.ts` ~:695; only severity has an explainer ~:699/:726). Each failing clause (ID grammar, hash mismatch, authorized IDs ≠ severe open rows, unparseable rows, missing sections) gets its own line in the refusal; keep the existing generic first line so current consumers still match it.
- S2. On a hash mismatch where the rows parse, the message states the expected digest (`canonicalHash` of the parsed row array) and the formula: SHA-256 of the canonical JSON of the parsed rows ARRAY (compact, sorted keys), not of the row text. No new tool, command, or verb (rejected: one-way door).
- S3. On an ID that does not match the grammar, the message quotes the grammar `JD-[A-Z][A-Z0-9]*-\d+` and an example (`JD-A-001`); e.g. `JD-001` is rejected naming it.
- S4. Docs: `skills/judgment-day/SKILL.md` and its `references/prompts-and-formats.md` state the hash preimage (JSON array of the dispatched rows, canonical compact sorted-keys JSON) and the ID grammar. Do NOT rename the "Frozen ledger SHA-256" label (consumed contract); clarify in the docs that it covers the dispatched rows only.
- S5. Validation strictness is unchanged: every input rejected before is still rejected, every input admitted before is still admitted (pin with one test of a previously admitted dispatch).

## Tasks

- T1 (S1-S5) — worker — commit: 8d74168e7

## Log

- L1 (user): "agrega a la lista: https://github.com/Gentleman-Programming/gentle-shell/issues/3361, https://github.com/Gentleman-Programming/gentle-shell/issues/3386, https://github.com/Gentleman-Programming/gentle-shell/issues/2909, https://github.com/Gentleman-Programming/gentle-shell/issues/3401"
- L2: explorer confirmed generic message at `extensions/gentle-ai.ts:695`, severity-only explainer `:699`/`:726-727`, `parseCanonicalJudgmentDayFrozenRows` collapses failures to `undefined`; skill docs say only "one lowercase SHA-256". No open PR.
- L3 (agent decision): no label rename, no digest tool (contract / new verb); message + docs only.
- L4 (worker, T1 8d74168e7): RED 4/5 new tests failed (S1-S4), GREEN 5/5 in tests/judgment-day-dispatch-diagnostics.test.ts; 965 related tests: 947 pass, 18 fail in tests/gentle-ai.test.ts (frozen-profile routing, unrelated; baseline copy also failed there); runtime-harness exit 0. `assets/agents/jd-fix-agent.md` mirror not touched (outside allowed surfaces).
