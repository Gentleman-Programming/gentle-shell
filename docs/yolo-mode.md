# YOLO permission

> 🚀 **Full speed, destructive actions still ask.** YOLO lets the agent implement, commit, push and open PRs within the already authorized task without asking each time, which suits long autonomous runs. Destructive operations still require fresh confirmation; the one exception is recursive removal of the session's own temp scratch (see [Temp scratch removal](#temp-scratch-removal)).

Use `/gentle:yolo enable` in the interactive primary Pi TUI to stop repeated permission questions for ordinary work **within your already authorized task**. YOLO is **OFF** unless you select it or save YOLO as the user-global default. [Normal, Auto and global defaults](permission-modes.md) are managed separately from the live-session toggle. The active status and a separate editor widget both say **🚀 YOLO ON 🔥 — destructive confirmations remain**, even when Gentle Shell hides its status layout.

| Command | Effect |
| --- | --- |
| `/gentle:yolo enable` | Select YOLO for this live session and workspace/clone. |
| `/gentle:yolo disable` | Select Normal immediately and clear the YOLO indicators; saved defaults stay unchanged. |
| `/gentle:yolo status` | Show the current state without activating. |
| `/gentle:yolo` | Open a menu titled **🚀 Gentle YOLO 🔥 — full speed, destructive actions still ask (current: ON\|OFF)** with `enable`, `disable` and `status`. Cancelling changes nothing. Without an interactive menu UI it behaves like `status`. |

Invalid arguments leave state unchanged.

The Session command palette also includes YOLO. Interactive selection requires an eligible primary TUI, live session identity and identifiable workspace. Outside Git, the canonical workspace directory supplies identity. There is no model-callable activation tool. `/gentle:mode default yolo` optionally saves a trusted user-global default for new primary sessions; `/gentle:mode default normal` removes that elevated default. Neither command changes the current mode.

## Configuration menu path

1. Open `/gentle:customize` → **Editor**.
2. Select **YOLO: OFF · session only**, immediately after the Vim enable/disable rows.
3. Press **Enter** or **Space** to toggle the same permission as `/gentle:yolo`. The row updates to **YOLO: ON · session only**; slash changes and revocation also update an open menu.

Navigation, the read-only preview and Escape never grant permission. The preview reminds you that ordinary scoped commits/push/PR are covered, destructive confirmations remain, review consent is unchanged and reload resets the live grant. **UNAVAILABLE** means the live primary owner or eligible session/workspace cannot be used; selecting it cannot activate YOLO.

The live YOLO toggle does not save preferences. The separate **Default permissions** rows can save Normal, Auto or YOLO in the dedicated user-global permission store, never a repository preference or visual profile. **Session permissions** selects the current mode without changing that default. Closing the menu removes its observers and cancels unfinished menu activation; it does not revoke an already completed activation. Reload or session replacement invalidates old menu callbacks and resets the live permission.

## What activation authorizes

YOLO supplies standing human permission for ordinary already-scoped implementation, checks, commits, non-force pushes and PR creation. Its active-only system instruction qualifies the default commit/push/PR confirmation clauses; it also tells the primary agent to make ordinary reversible implementation choices without needless interviews.

The shell guard's routine default confirmation is skipped for reversible delivery only. Every guarded segment of the command is judged on its own, so `git commit -m "..." && git push -u origin feature`, `git push && gh pr create --fill`, `git -C <dir> push origin main` and `git fetch && git rebase origin/main && git push` run without a prompt, while the other segments keep their ordinary guard (`git push && rm -rf data` still asks for the `rm`). A push segment is eligible with plain remote/ref arguments, `src:dst` refspecs with both sides present, and the options `-u`/`--set-upstream`, `-q`/`--quiet`, `-v`/`--verbose`, `--tags`, `--follow-tags`, `--no-verify` and `--porcelain`. A rebase segment is eligible with plain refs, `--onto`, `--continue`, `--abort`, `--skip` and `--autostash`; it is recoverable from the reflog. Either segment may also carry output redirections that write nothing (`2>&1`, `>&2`, `>/dev/null`, `2>/dev/null`, `&>/dev/null`) and may be piped into the read-only filters `tail`, `head`, `cat`, `grep` and `wc` with plain or literally quoted arguments, so `git push -u origin feature 2>&1 | tail -5` runs without a prompt. Redirection to a file, a pipe into any other command (`| sh`, `| tee file`, `| xargs`) and a trailing background `&` still ask: Git output carries text the remote controls. Anything that deletes or rewrites a remote ref, publishes, or runs arbitrary commands never qualifies: `--delete`/`-d`, `:branch` and `+branch` refspecs, `--mirror`, `--prune`, `--all`, every force spelling (hard-blocked), `--receive-pack`/`--exec`, `--repo`, `-o`, `sudo`, shell wrappers such as `sh -c`, interactive or `--exec` rebases, `git branch -D`, `pi remove` and `npm publish`. Full command evaluation, including the recognized data-loss guards, runs first. Explicit push or rebase confirmations or blocks in either configuration layer remain restrictions, including when legacy persistent autonomy or its environment override would ignore them. YOLO never changes persistent `autonomousMode`.

## What still requires a decision

- Destructive operations retain fresh confirmations or hard denial: recognized SQL DROP/TRUNCATE and broad deletion, recursive removal, destructive Git and other guarded operations are not waived. The only exception is [temp scratch removal](#temp-scratch-removal). Explicit configured confirmations/blocks and sensitive-path protection remain.
- Current explicit human restrictions, repository policy, project trust and authorized scope still apply. Scope expansion, privacy-sensitive disclosure and genuinely unresolved consequential product choices require a human decision.
- Ambiguous destinations or credentials remain unresolved. YOLO does not invent a remote, deployment destination, account or credential, nor authorize discovery or reuse of ambient credentials.
- `ask_user` tools, provider consent, maintenance/recovery authorization and opaque-token choices are never automatically answered. Native review, RDD and review standing permission remain separate and unchanged.

Children retain only their bounded delegated scope. They cannot activate or inherit YOLO, and receive no independent delivery permission.

### Temp scratch removal

In the primary session with YOLO active, a recursive `rm` whose every target is the session's own temp scratch runs without the data-loss confirmation. For example, `rm -rf /tmp/tmp.8phya1BpFr /tmp/build.log; git log --oneline -1` runs directly when both targets qualify. A target qualifies only when all of these hold:

- The segment is a plain `rm` with no wrapper (`sudo`, `env`, `xargs`, assignments), not inside `sh -c` or `find -exec`, and without `--no-preserve-root`.
- The removal runs before anything else in the command. The command must start with one or more such `rm` segments joined by `;`, `&&`, `||` or newlines. Nothing may precede them: no `mv`, `cp`, `ln`, redirection, subshell or other command. They also may not be backgrounded with `&` or piped with `|`. Otherwise an earlier step could put other data into a target that looked like scratch when the command was checked, so `mv ~/data /tmp/tmp.abcdef1234 && rm -rf /tmp/tmp.abcdef1234` still asks. Commands after the removals, such as `cd … && git log`, are allowed.
- The target is an unquoted literal absolute path made only of letters, digits, `/` and `._-+@%=:,`. It has no `$`, backtick, `~`, glob, brace or redirection characters, no `.`/`..` components and no trailing `/`.
- The target is exactly one path component under `/tmp`, `/var/tmp` or the resolved `os.tmpdir()`. The temp root itself never qualifies, and a temp root that is `/`, your home directory, one of its ancestors or a directory inside your home is ignored.
- When the command is checked, the target is missing, a symlink, a regular file you own, or a directory you own named like `mktemp` output (`tmp.` followed by six or more letters or digits).

Anything else keeps asking, including another user's directory, a directory not named like `mktemp` output, an unreadable path and `$TMPDIR/...`. Every other effect in the same command keeps its ordinary guard: `rm -rf /tmp/tmp.abcdef1234 && rm -rf data` still asks, and `rm -rf /tmp/tmp.abcdef1234 ~/foo` is still hard-blocked. Normal and Auto modes still ask, and children still block. The check runs when the command is admitted; it does not lock the path until `rm` runs.

## Lifetime and limits

Live permission is held in the extension instance, bound to the exact live SessionManager, session ID and canonical Git common-directory identity, or canonical workspace directory outside Git. Sibling worktrees in one clone may retain it; an unrelated workspace or session identity cannot. Scope loss revokes rather than hiding permission until you return.

Shutdown, **reload** and session replacement revoke live grants and callbacks. New primary session instances may apply a saved global YOLO default; they never restore a grant from transcript entries. An explicit Normal selection wins over that default in the current session. To keep both this session and future sessions in Normal, use `/gentle:yolo disable` and `/gentle:mode default normal`.

This is permission guidance and shell-guard defense in depth, **not a sandbox or an all-tools safety guarantee**. Detection only covers recognized command forms; scripts, custom tools and prompt injection can bypass semantic guidance. Tools and extensions retain the operating-system permissions of the process. Trusted SDK callers can invoke command handlers and supply interactive contexts; the human command path is not an OS security boundary against those callers. Use OS/container isolation and narrowly scoped credentials when you need an actual containment boundary.

## Recognized data-loss boundary

Recognized destructive database and broad filesystem commands require **fresh primary confirmation** and are **blocked in package-owned children**, independently of YOLO and existing autonomous-mode configuration. The only YOLO exception is [temp scratch removal](#temp-scratch-removal).

| Recognized executable form | Primary session | Delegated child |
|---|---|---|
| SQL `DROP TABLE/DATABASE/SCHEMA/INDEX/VIEW`, `TRUNCATE [TABLE]` | Fresh confirmation | Block |
| SQL `DELETE FROM` without `WHERE`, or a trailing literal `WHERE 1=1` / `WHERE TRUE` | Fresh confirmation | Block |
| Recursive `rm` (`-r`, `-R`, combined short flags, `--recursive`), `find -delete`, recognized destructive `find -exec/-execdir` and `xargs` invocations | Fresh confirmation | Block |
| Recursive `rm` targeting `/`, `/*`, `.`, `..`, home or home descendants | Hard block | Block |
| Temp scratch recursive removal ([conditions](#temp-scratch-removal)) | Waived under YOLO (primary only); fresh confirmation otherwise | Block |
| Git force push, hard reset, forced clean | Hard block | Block |
| Git forced branch deletion, reset/clean/restore/rebase, checkout with `--` or force, stash drop/clear | Existing primary policy remains | Block |

SQL recognition is limited to literal arguments passed to `psql`, `mysql`, `mariadb`, or `sqlite3`, literal `echo`/`printf` pipelines into those clients, and simple named heredocs. SQL string literals and comments are excluded from the new SQL recognition; printing or searching destructive prose alone does not trigger it.

Command recognition follows simple shell separators, pipelines and parenthesized command groups. It handles executable paths, leading assignments, common `env`, `sudo`, `command`, `exec`, `nohup`, `timeout` and `xargs` wrappers, and literal `sh/bash/zsh/dash -c` payloads (up to five recognition levels). A command after the unquoted reserved words `then`, `else`, `elif`, `do`, `{`, `!`, `if`, `while` and `until` is recognized like a command at the start of a segment, so `if true; then rm -rf data; fi` and `for d in a b; do rm -rf "$d"; done` are guarded like `rm -rf data`, and a root or home target behind them is still hard-blocked. Backtick substitutions outside single quotes (also inside double quotes) and literal `eval` payloads, quoted or bare words, are recognized like literal `sh -c` payloads within the same recognition levels; `eval "$x"` and other expanded payloads are not resolved. A recursive `rm` behind a reserved word, in backticks or in `eval` never qualifies for [temp scratch removal](#temp-scratch-removal). Every recognized operation in a compound command participates; an earlier allowed delivery action cannot hide later data loss.

Ordinary builds, tests, read-only SQL, predicate-bounded literal deletes, Git status/log and plain pushes are unchanged by the shared data-loss classifier. A build command that explicitly includes recursive deletion is still guarded.

### Approval and precedence

1. Existing hard denies and newly recognized hard-deny forms win across the command.
2. Explicit configured blocks retain their existing semantics and win before data-loss confirmation. Active YOLO additionally honors explicit push restrictions in either configuration layer.
3. Recognized database/filesystem data loss always requires fresh confirmation, even when autonomous mode or a matched delivery action is configured to allow. The only exception is [temp scratch removal](#temp-scratch-removal) under active YOLO in the primary session.
4. No UI, cancellation, a non-true answer or a dialog error cannot authorize execution. Approval is not cached; permission and Herdr blocker lifecycle events remain balanced.

Children receive the lightweight `child-safety.ts` entry alongside `child-context.ts`; they do not need the full primary extension. The safety entry registers nothing outside `GENTLE_PI_AGENTS_CHILD=1`, preventing duplicate primary prompts during package auto-discovery. If the full primary extension is explicitly loaded in a child, its destructive-command path also blocks instead of prompting.

### Detection limitations

- This is deterministic lexical recognition, **not** shell or SQL evaluation. Aliases, functions, other reserved words (`time`, `function`, `coproc`), commands inside double-quoted `$(...)`, dynamically assembled commands, variable/command expansion inside quoted payloads, unusual wrapper flags, complex heredocs and deeply nested wrappers can evade recognition. Simple recursive removal of a variable target is guarded, but its expanded target cannot reliably be identified as a hard-deny path.
- Guarded-command confirmations and hard-denied patterns ignore text that only appears as an argument of a known data command (`grep`, `rg`, `cat`, `echo`, `printf`, `head`, `tail`, `jq`, `sort`, `uniq`, `wc` and similar), including the body of a real heredoc fed to one. Searching a file for a push or printing a reset command does not open a dialog. The exemption applies only when every command in the line is such a data command or an inert one (`cd`, `pwd`, `test`, `mkdir`, `touch`), optionally after plain `VAR=value` assignments or a flagless `env`. Plain assignment segments (`f=x;`) and simple command substitutions whose body is itself only data or inert commands (`f=$(ls -t *.jsonl | head -40); grep -l "git push" $f`) keep the exemption. Anything else anywhere in the line keeps the full lexical match: any other command or wrapper (`sed`, `sh`, `python`, `awk`, `xargs`, `sudo`, `exec`, `at`, `./script`), a command substitution that runs anything else or nests quotes, expansions or another substitution, a command substitution together with a heredoc, process substitution, backticks, a `<<` that is not an unquoted heredoc, and quoting the tokenizer cannot account for. `sed` is excluded because GNU sed can execute its script.
- Scripts, migration files, redirected SQL files, arbitrary interpreter programs (Python/Node/etc.), encoded payloads and remote execution are not inspected. Non-recursive wildcard deletion, file truncation, other database clients and nontrivial tautological SQL predicates are not comprehensively classified. A `WHERE` clause is not proof of bounded impact.
- Only `bash` tool calls reach this data-loss boundary, including nested calls dispatched through Pi's tool-event pipeline. Direct process execution, user shell commands, MCP tools and other tools are not covered by these hooks.
- The older primary regex safeguards remain authoritative and may be more conservative about text than the shared recognizer. Missing or explicitly overridden child extension paths remove the lightweight boundary; a valid package installation must include the safety entry.

Keep task authorization, explicit user restrictions, sensitive-path protection and safer execution plans in force. The destructive guard itself does not grant delivery or remote-operation authority, activate YOLO, change RDD, or auto-answer any modal.
