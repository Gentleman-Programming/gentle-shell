# Session-only YOLO permission

> 🚀 **Full speed, destructive actions still ask.** YOLO lets the agent implement, commit, push and open PRs within the already authorized task without asking each time, which suits long autonomous runs. Destructive operations still require fresh confirmation.

Use `/gentle:yolo enable` in the interactive primary Pi TUI to stop repeated permission questions for ordinary work **within your already authorized task**. YOLO defaults **OFF**. The active status and a separate editor widget both say **🚀 YOLO ON 🔥 — destructive confirmations remain**, even when Gentle Shell hides its status layout.

| Command | Effect |
| --- | --- |
| `/gentle:yolo enable` | Activate for this live session and Git clone. |
| `/gentle:yolo disable` | Revoke immediately and clear the indicators. |
| `/gentle:yolo status` | Show the current state without activating. |
| `/gentle:yolo` | Open a menu titled **🚀 Gentle YOLO 🔥 — full speed, destructive actions still ask (current: ON\|OFF)** with `enable`, `disable` and `status`. Cancelling changes nothing. Without an interactive menu UI it behaves like `status`. |

Invalid arguments leave state unchanged.

The Session command palette also includes YOLO. Activation fails closed without an identifiable Git clone, interactive TUI or live session identity. There is no YOLO environment variable, persisted configuration or model-callable activation tool.

## Configuration menu path

1. Open `/gentle:customize` → **Editor**.
2. Select **YOLO: OFF · session only**, immediately after the Vim enable/disable rows.
3. Press **Enter** or **Space** to toggle the same permission as `/gentle:yolo`. The row updates to **YOLO: ON · session only**; slash changes and revocation also update an open menu.

Navigation, the read-only preview and Escape never grant permission. The preview reminds you that ordinary scoped commits/push/PR are covered, destructive confirmations remain, review consent is unchanged and reload resets the grant. **UNAVAILABLE** means the live primary owner or eligible session/clone cannot be used; selecting it cannot activate YOLO.

Unlike Vim, this control does not write a global/repository preference, visual profile, prompt-history preference or guardrail setting. Closing the menu removes its observers and cancels unfinished menu activation; it does not revoke an already completed activation. Reload or session replacement invalidates old menu callbacks and resets the permission.

## What activation authorizes

YOLO supplies standing human permission for ordinary already-scoped implementation, checks, commits, non-force pushes and PR creation. Its active-only system instruction qualifies the default commit/push/PR confirmation clauses; it also tells the primary agent to make ordinary reversible implementation choices without needless interviews.

Only a single plain `git push` can skip the shell guard's routine default confirmation. Simple remote/ref arguments and `-u`/`--set-upstream` are eligible. Compound commands, wrappers, repository-changing options and other push options conservatively retain normal guard behavior. Full command evaluation, including the recognized data-loss guards, runs first. Explicit push confirmations or blocks in either configuration layer remain restrictions, including when legacy persistent autonomy or its environment override would ignore them. YOLO never changes persistent `autonomousMode`.

## What still requires a decision

- Destructive operations retain fresh confirmations or hard denial: recognized SQL DROP/TRUNCATE and broad deletion, recursive removal, destructive Git and other guarded operations are not waived. Explicit configured confirmations/blocks and sensitive-path protection remain.
- Current explicit human restrictions, repository policy, project trust and authorized scope still apply. Scope expansion, privacy-sensitive disclosure and genuinely unresolved consequential product choices require a human decision.
- Ambiguous destinations or credentials remain unresolved. YOLO does not invent a remote, deployment destination, account or credential, nor authorize discovery or reuse of ambient credentials.
- `ask_user` tools, provider consent, maintenance/recovery authorization and opaque-token choices are never automatically answered. Native review, RDD and review standing permission remain separate and unchanged.

Children retain only their bounded delegated scope. They cannot activate or inherit YOLO, and receive no independent delivery permission.

## Lifetime and limits

Permission is in memory in the extension instance, bound to the exact live SessionManager, session ID and canonical Git common-directory identity. Sibling worktrees in one clone may retain it; an unrelated clone or session identity cannot. Scope loss revokes rather than hiding permission until you return.

New, resumed, forked or replaced sessions, shutdown/quit, **reload** and process restart reset YOLO to OFF. Re-activate explicitly after reload. No session entry restores a grant.

This is permission guidance and shell-guard defense in depth, **not a sandbox or an all-tools safety guarantee**. Detection only covers recognized command forms; scripts, custom tools and prompt injection can bypass semantic guidance. Tools and extensions retain the operating-system permissions of the process. Trusted SDK callers can invoke command handlers and supply interactive contexts; the human command path is not an OS security boundary against those callers. Use OS/container isolation and narrowly scoped credentials when you need an actual containment boundary.

## Recognized data-loss boundary

Recognized destructive database and broad filesystem commands require **fresh primary confirmation** and are **blocked in package-owned children**, independently of YOLO and existing autonomous-mode configuration.

| Recognized executable form | Primary session | Delegated child |
|---|---|---|
| SQL `DROP TABLE/DATABASE/SCHEMA/INDEX/VIEW`, `TRUNCATE [TABLE]` | Fresh confirmation | Block |
| SQL `DELETE FROM` without `WHERE`, or a trailing literal `WHERE 1=1` / `WHERE TRUE` | Fresh confirmation | Block |
| Recursive `rm` (`-r`, `-R`, combined short flags, `--recursive`), `find -delete`, recognized destructive `find -exec/-execdir` and `xargs` invocations | Fresh confirmation | Block |
| Recursive `rm` targeting `/`, `/*`, `.`, `..`, home or home descendants | Hard block | Block |
| Git force push, hard reset, forced clean | Hard block | Block |
| Git forced branch deletion, reset/clean/restore/rebase, checkout with `--` or force, stash drop/clear | Existing primary policy remains | Block |

SQL recognition is limited to literal arguments passed to `psql`, `mysql`, `mariadb`, or `sqlite3`, literal `echo`/`printf` pipelines into those clients, and simple named heredocs. SQL string literals and comments are excluded from the new SQL recognition; printing or searching destructive prose alone does not trigger it.

Command recognition follows simple shell separators, pipelines and parenthesized command groups. It handles executable paths, leading assignments, common `env`, `sudo`, `command`, `exec`, `nohup`, `timeout` and `xargs` wrappers, and literal `sh/bash/zsh/dash -c` payloads (up to five recognition levels). Every recognized operation in a compound command participates; an earlier allowed delivery action cannot hide later data loss.

Ordinary builds, tests, read-only SQL, predicate-bounded literal deletes, Git status/log and plain pushes are unchanged by the shared data-loss classifier. A build command that explicitly includes recursive deletion is still guarded.

### Approval and precedence

1. Existing hard denies and newly recognized hard-deny forms win across the command.
2. Explicit configured blocks retain their existing semantics and win before data-loss confirmation. Active YOLO additionally honors explicit push restrictions in either configuration layer.
3. Recognized database/filesystem data loss always requires fresh confirmation, even when autonomous mode or a matched delivery action is configured to allow.
4. No UI, cancellation, a non-true answer or a dialog error cannot authorize execution. Approval is not cached; permission and Herdr blocker lifecycle events remain balanced.

Children receive the lightweight `child-safety.ts` entry alongside `child-context.ts`; they do not need the full primary extension. The safety entry registers nothing outside `GENTLE_PI_AGENTS_CHILD=1`, preventing duplicate primary prompts during package auto-discovery. If the full primary extension is explicitly loaded in a child, its destructive-command path also blocks instead of prompting.

### Detection limitations

- This is deterministic lexical recognition, **not** shell or SQL evaluation. Aliases, functions, dynamically assembled commands, variable/command expansion inside quoted payloads, unusual wrapper flags, complex heredocs and deeply nested wrappers can evade recognition. Simple recursive removal of a variable target is guarded, but its expanded target cannot reliably be identified as a hard-deny path.
- Scripts, migration files, redirected SQL files, arbitrary interpreter programs (Python/Node/etc.), encoded payloads and remote execution are not inspected. Non-recursive wildcard deletion, file truncation, other database clients and nontrivial tautological SQL predicates are not comprehensively classified. A `WHERE` clause is not proof of bounded impact.
- Only `bash` tool calls reach this data-loss boundary, including nested calls dispatched through Pi's tool-event pipeline. Direct process execution, user shell commands, MCP tools and other tools are not covered by these hooks.
- The older primary regex safeguards remain authoritative and may be more conservative about text than the shared recognizer. Missing or explicitly overridden child extension paths remove the lightweight boundary; a valid package installation must include the safety entry.

Keep task authorization, explicit user restrictions, sensitive-path protection and safer execution plans in force. The destructive guard itself does not grant delivery or remote-operation authority, activate YOLO, change RDD, or auto-answer any modal.
