# Guard: recognize destructive commands in compound bodies, backticks and eval (#2285)

Objective: the destructive-command recognizer sees `rm` and the other recognized destructive forms after shell reserved words, inside backtick substitutions and inside literal `eval` payloads.
Branch: `fix/guard-compound-rm` (worktree `/home/gentleman/work/gentle-pi-worktrees/guard-compound`, base `origin/main` 0c45b6f62). Delivery: single PR closing #2285. Runner: `node --experimental-strip-types --test <file>`; suite `pnpm test`.

## Specs

- **S1** Issue #2285 examples (verbatim) must be recognized as recursive filesystem data loss (primary: fresh confirmation, children: block), exactly like `rm -rf data` alone:
  ```text
  if true; then rm -rf data; fi        # `then` is taken as the segment head
  for d in a b; do rm -rf "$d"; done   # same for `do`
  echo `rm -rf data`                   # backtick substitution is not parsed
  eval 'rm -rf data'                   # eval payload is not parsed
  ```
- **S2** Reserved words that start a compound body are skipped when finding a segment head: `then`, `else`, `elif`, `do`, `{`, `!`, plus `if`, `while`, `until` (the condition command is a command). Root/home recursive rm behind them keeps its hard block (e.g. `if true; then rm -rf ~; fi` → block).
- **S3** Backtick substitutions and literal `eval` payloads (single- or double-quoted literal, or bare words) participate in recognition like `$(...)` and literal `sh -c` payloads, within the existing recursion depth limit. A non-literal eval payload (`eval "$x"`) or an unparseable backtick makes the command opaque only if the existing design already treats such cases conservatively; do not invent new blocking for ordinary commands.
- **S4** Unchanged: ordinary commands (`if [ -f x ]; then echo ok; fi`, `for f in *; do cat "$f"; done`, `echo \`date\``, `eval "$(ssh-agent -s)"` style is out of scope but must not newly hard-block), quoted data arguments of data commands (`grep "then rm -rf" x` stays not-guarded), the YOLO temp-scratch waiver and push/rebase waivers from #2284 (the scratch waiver must not apply to an `rm` behind `then`/`do`/backticks/eval — it only covers leading direct `rm` segments).
- **S5** Tests (RED first) in `tests/destructive-command-guard.test.ts` and `tests/child-safety.test.ts` for each S1 example and the S2 hard-block case; preservation tests for S4. Update `docs/yolo-mode.md` "Detection limitations"/recognition paragraph to list the newly covered forms.

## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S1-S5 | delegated (Writer trigger: parallel units with gentle-ai #5533) | done, verified (L3) | 6b8acd37f |

Risk: item 2 (security guard) → independent verifier after T1.

## Log

- **L1** (2026-10-15, user, verbatim): "dale approve y merge si puedes" — approving issue #2285 (filed from the #2284 verifier finding) and implementing it.
- **L2** (2026-10-15, writer, T1): `headCursor` skips unquoted reserved words (`then else elif do { ! if while until`) before assignments/wrappers; `eval` payloads (args joined, leading `--` dropped) and backtick bodies outside single quotes (backslash escapes removed, heredoc bodies stay data, unterminated backticks yield nothing) recurse within the depth limit with the enclosing `eval`/backtick offset as trigger. Scratch waiver unchanged: those `rm` have `cursor > 0` or `depth > 0`, so no `removalTargets`. RED (base code, new tests): 24 failing of 163 across destructive-command-guard/child-safety/autonomous-guard, all "not recognized" (`[]`, `not-guarded`, child result `undefined`, e.g. `if true; then rm -rf data; fi` → `+ 'not-guarded' - 'confirm'`). GREEN: the five guard/YOLO suites 183/183; `pnpm test` all stages passed (6884 tests, 6812 pass, 72 skipped, 0 fail). Differential vs 0c45b6f62 over 37 probe commands: the 28 ordinary/push/rebase/scratch commands are identical; only the 9 target forms change (7 rm forms → confirm/dataLoss or block for `~`; 2 `git reset --hard` forms gain a recognized hard-deny match, action already `block`). Not covered (documented): `time`/`function`/`coproc`, commands inside double-quoted `$(...)`.
- **L3** (2026-10-15) Independent verifier on 6b8acd37f: S1-S5 PASS, no blockers. 394 baseline test literals unchanged; 76 targeted probes differ only on target forms or improvements (baseline waived YOLO for `rm -rf /tmp/tmp.X && if true; then rm -rf data; fi`; now asks); stress inputs (10k backticks, 2k eval, 200 KB) under 50 ms. Advisories: backticks inside `#` comments are now scanned (rare false positive); an unclosed `'` earlier in the command hides later backticks, `"$(...)"` with a destructive body, and `time`/`function`/`coproc` remain unrecognized (pre-existing, documented).
