# PR426 / issue107: retain native Bash settings

- Goal: resolve the replay onto main without recreating or registering Bash; retain six quiet tool cards, codemode, float rendering, and timing hooks.
- Budget: forecast 250–350 authored added/deleted lines; hard ceiling 400. Actual scope remains below 250 lines including this record and the new SDK test.
- RED: `node --experimental-strip-types --test tests/quiet-bash-runtime.test.ts` failed against main. Native SDK Bash passed; quiet replacement threw `No bash shell found` with Windows default discovery hidden.
- GREEN: `node --experimental-strip-types --test tests/quiet-tool-rendering.test.ts tests/quiet-bash-runtime.test.ts` passed 57 tests, no skips.
- Triangulation: no Bash registration with or without an existing tool; six overrides and codemode retained; environment disable unchanged; non-Bash cards and float tests pass.
- Typecheck: `node scripts/check-types.mjs` reports 187 recorded diagnostics, no regressions.
- Whitespace: `git diff --check` passed.
- Limit: runtime harness not executed by implementation writer because it stages and commits a temporary fixture; parent owns that validation and index resolution.
- UI tradeoff: production Bash uses native Pi UI; standalone renderer fixtures do not assert native UI parity.
- No commit, rebase continuation, push, or GitHub write performed. Pre-existing staged harness exclusion of Bash preserved.
