// The destructive card identity: what a shell call deletes, so the transcript's
// bash card and the Agents thread pane can say `⚠ destructive` in the theme's
// error role before the output arrives.
//
// This is presentation only. Permission lives in
// `lib/destructive-command-guard.ts`: the guard asks "may this run?", while a card
// asks "what would a reader see?". That module is not edited here and its verdicts
// are never read — only its pure `recognizeDestructiveCommands` is reused as
// evidence for the payloads it already proves (a shell body, an `eval`, a SQL
// client's statements, and `find`'s exec), so there is one definition of what those
// payloads delete and no second SQL or shell vocabulary to drift.
//
// The vocabulary is deliberately small and positional: only a command-position
// word can name a program, so prose a program merely receives — `echo 'rm -rf /'`,
// `git commit -m "rm -rf /tmp"`, a quoted payload — is never a deletion. A
// command this list does not name (`xargs rm`, an alias, a script of its own) stays
// unrecognized, and its call keeps the generic card rather than claiming a warning
// it cannot prove.

import { recognizeDestructiveCommands } from "./destructive-command-guard.ts";

/** Options that take the word after them, so a wrapper's value is not read as its command. */
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
	env: ["-u", "--unset", "-C", "--chdir"],
	sudo: ["-u", "-g", "-h", "-p", "-C", "--user", "--group", "--host", "--prompt", "--chdir"],
	timeout: ["-s", "--signal", "-k", "--kill-after"],
	// `nice -n 5 rm …` only changes the priority of the command it runs.
	nice: ["-n", "--adjustment"],
};

/** Programs that run the command after them, unchanged in what it deletes. */
const WRAPPERS = new Set(["env", "sudo", "doas", "command", "exec", "nohup", "timeout", "nice"]);

/** Programs whose own arguments name what they delete. */
const DELETING_PROGRAMS = new Set(["rm", "shred", "truncate", "dd"]);

/**
 * Programs whose payload the permission guard's recognizer already reads: a shell
 * body, an `eval`, a SQL client's statements, and `find`'s exec. Their reading is
 * reused rather than re-implemented, and the guard's broader git verdicts stay with
 * this module's own exemptions.
 */
const PAYLOAD_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "eval", "psql", "mysql", "mariadb", "sqlite3", "find"]);

/** Git global options that consume the word after them. */
const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z_0-9]*=/;

/**
 * Whether one simple shell segment deletes something irreversible, as far as a
 * reader of the command can tell. A help request, a dry run and a recovery are
 * exempt: they change nothing, so the card keeps the identity the call really
 * has (a query, a remote verb, an unnameable action) instead of warning about a
 * deletion that will not happen.
 */
export function isDestructiveSegment(segment: string): boolean {
	const command = commandArguments(segment);
	if (command === undefined) return false;
	const [head, ...args] = command;
	const program = head.split("/").at(-1) ?? head;
	// A usage page prints and stops. The shell removed any quoting, so a word that
	// reaches the program as `--help` is one, whichever way it was written.
	if (args.includes("--help")) return false;
	// `--dry-run` reports what a command would do; it never does it.
	if (args.some((arg) => arg === "--dry-run" || arg.startsWith("--dry-run="))) return false;
	// The short spelling is not universal: git's own `-n` is the dry run its deleting
	// verbs accept, but another program spells an ordinary option that way —
	// `kubectl delete pod web -n prod` names the namespace and deletes the pod — so
	// the one-letter flag is read only where git itself assigns it that meaning.
	if (program === "git" && args.some((arg) => /^-[^-]*n/.test(arg))) return false;
	if (program === "git") return gitDeletes(args);
	if (program === "docker" || program === "kubectl") return containerDeletes(program, args);
	if (PAYLOAD_PROGRAMS.has(program)) return recognizeDestructiveCommands(segment).length > 0;
	return DELETING_PROGRAMS.has(program) && programDeletes(program, args);
}

/**
 * Whether a whole command carries data-loss evidence its segments cannot show on
 * their own: the SQL a pipeline feeds a client (`echo 'DROP TABLE t' | psql`), or a
 * heredoc body. The permission guard's own pure recognizer reads those already, so
 * it is reused and filtered to its database verdict — the guard's broader git and
 * filesystem forms stay with this module's exemptions — and no permission decision
 * is read or changed.
 */
export function isDestructiveCommand(command: string): boolean {
	return recognizeDestructiveCommands(command).some((match) => match.kind === "database");
}

/** What one non-git, non-payload tool's own arguments say it deletes. */
function programDeletes(program: string, args: readonly string[]): boolean {
	// `dd` only destroys when it writes to a file or a device; a sink is not a target.
	if (program === "dd") return args.some((arg) => arg.startsWith("of=") && !/^of=\/dev\/(null|stdout|stderr|zero)$/.test(arg));
	// `rm`, `shred` and `truncate` need something to act on: without an operand the
	// program prints its usage and exits.
	return hasOperand(args);
}

/**
 * Containers and clusters: a verb that removes, deletes or prunes what it names.
 * `docker rm` without a target prints usage, while `prune` deletes by definition.
 */
function containerDeletes(program: string, args: readonly string[]): boolean {
	if (program === "kubectl") return args[0] === "delete" && hasOperand(args.slice(1));
	const subcommand = args[0];
	if (subcommand === "rm" || subcommand === "rmi") return hasOperand(args.slice(1));
	// `docker system|builder|image|volume|container|network <rm|prune>`.
	if (subcommand === undefined || !DOCKER_OBJECTS.has(subcommand)) return false;
	const action = args[1];
	if (action === "prune") return true;
	return (action === "rm" || action === "rmi") && hasOperand(args.slice(2));
}

/** The docker object groups whose `rm`/`prune` sub-subcommand deletes. */
const DOCKER_OBJECTS = new Set(["system", "builder", "image", "volume", "container", "network"]);

/** Whether the arguments name at least one operand, honouring the `--` terminator. */
function hasOperand(args: readonly string[]): boolean {
	let options = true;
	for (const arg of args) {
		if (options && arg === "--") {
			options = false;
			continue;
		}
		if (options && arg.length > 1 && arg.startsWith("-")) continue;
		return true;
	}
	return false;
}

/** The git verbs that discard work, and the flags that make a gentler verb do it. */
function gitDeletes(args: readonly string[]): boolean {
	let index = 0;
	while (args[index]?.startsWith("-")) {
		const flag = args[index++];
		if (GIT_GLOBAL_VALUE_OPTIONS.has(flag)) index++;
	}
	const action = args[index];
	const flags = args.slice(index + 1);
	const force = flags.some((flag) => /^-[^-]*f/.test(flag) || /^--force(=|$)/.test(flag));
	const dryRun = flags.some((flag) => /^-[^-]*n/.test(flag));
	switch (action) {
		// `--soft` and `--mixed` move the index only; `--hard` throws the worktree away.
		case "reset":
			return flags.includes("--hard");
		// A clean without a force flag refuses to delete anything, and `-n` only lists.
		case "clean":
			return force && !dryRun;
		// A path checkout discards uncommitted work: the working tree after `--`, a
		// forced checkout, or the unambiguous path `.`/`..` (git has no branch with
		// that name). A branch checkout — `git checkout main`, `git checkout -b x` —
		// switches branch and leaves the working tree alone.
		case "checkout":
			return force || namesWorkingTree(flags);
		// Unstaging alone changes no file, so only a worktree restore deletes work.
		case "restore":
			return !onlyStaged(flags);
		// `--cached` drops the entry from the index and keeps the file.
		case "rm":
			return !flags.includes("--cached") && hasOperand(flags);
		case "branch":
			return flags.some((flag) => /^-[^-]*D/.test(flag)) || (force && flags.some((flag) => flag === "--delete" || /^-[^-]*d/.test(flag)));
		case "push":
			// A forced or ref-deleting push removes history on the remote.
			return force
				|| flags.some((flag) => /^--force(-with-lease|-if-includes)?(=|$)/.test(flag))
				|| flags.some((flag) => flag === "--delete" || /^-[^-]*d/.test(flag))
				// `git push origin :feat/x` names the deletion with its refspec.
				|| flags.some((flag) => /^:[^:]/.test(flag));
		case "stash":
			return flags[0] === "drop" || flags[0] === "clear";
		default:
			return false;
	}
}

/** Whether the arguments name working-tree paths, either after `--` or as `.`/`..`. */
function namesWorkingTree(flags: readonly string[]): boolean {
	const separator = flags.indexOf("--");
	if (separator >= 0) return flags.length > separator + 1;
	return flags.some((flag) => WORKING_TREE_PATHS.has(flag));
}

/** Paths git can read as nothing but a working-tree path, never as a branch. */
const WORKING_TREE_PATHS = new Set([".", "./", "..", "../"]);

/** `git restore --staged` leaves every file as it is; anything touching the worktree does not. */
function onlyStaged(flags: readonly string[]): boolean {
	const staged = flags.some((flag) => flag === "--staged" || /^-[^-]*S/.test(flag));
	const worktree = flags.some((flag) => flag === "--worktree" || /^-[^-]*W/.test(flag));
	return staged && !worktree;
}

/**
 * The words the program after the wrappers receives. Assignments — before the
 * command or in the environment a wrapper sets — a familiar wrapper and the
 * duration `timeout` bounds change nothing about what the command deletes, so they
 * are skipped; a segment with no command left has none.
 */
function commandArguments(segment: string): string[] | undefined {
	const words = shellWords(segment);
	let cursor = skipAssignments(words, 0);
	while (cursor < words.length) {
		const name = (words[cursor] ?? "").split("/").at(-1) ?? "";
		if (!WRAPPERS.has(name)) break;
		cursor = skipAssignments(words, cursor + 1);
		while (cursor < words.length && (words[cursor] ?? "").startsWith("-")) {
			const flag = words[cursor++];
			if (flag === "--") break;
			if (WRAPPER_VALUE_OPTIONS[name]?.includes(flag)) cursor++;
		}
		// `env FOO=bar rm …` carries its environment after the wrapper's flags.
		cursor = skipAssignments(words, cursor);
		// `timeout 30 rm …` names the duration it bounds before the command.
		if (name === "timeout") cursor++;
		cursor = skipAssignments(words, cursor);
	}
	return cursor < words.length ? words.slice(cursor) : undefined;
}

/** Advance past plain `NAME=value` words, which set the environment rather than a command. */
function skipAssignments(words: readonly string[], cursor: number): number {
	let next = cursor;
	while (next < words.length && ASSIGNMENT.test(words[next] ?? "")) next++;
	return next;
}

/**
 * One segment as the words the program receives, with the quoting and escaping
 * the shell would remove. Only words matter here: a command is read from its
 * command position, never from a substring of the text.
 */
function shellWords(segment: string): string[] {
	const words: string[] = [];
	let word = "";
	let started = false;
	const push = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	for (let index = 0; index < segment.length; index++) {
		const char = segment[index];
		if (char === "\\") {
			const next = segment[index + 1];
			if (next === undefined) {
				word += char;
				started = true;
				continue;
			}
			index++;
			// An escaped newline is a line continuation, not a character.
			if (next !== "\n") word += next;
			started = true;
			continue;
		}
		if (char === "'") {
			// Nothing escapes inside single quotes.
			const close = segment.indexOf("'", index + 1);
			const end = close < 0 ? segment.length : close;
			word += segment.slice(index + 1, end);
			started = true;
			index = end;
			continue;
		}
		if (char === "\"") {
			// Inside double quotes only `\X` escapes, and an escaped newline is dropped.
			let inner = "";
			let end = index + 1;
			while (end < segment.length && segment[end] !== "\"") {
				const current = segment[end] ?? "";
				if (current !== "\\") {
					inner += current;
					end++;
					continue;
				}
				const next = segment[end + 1];
				if (next === undefined) {
					inner += current;
					end++;
					continue;
				}
				end += 2;
				if (next !== "\n") inner += next;
			}
			word += inner;
			started = true;
			index = end;
			continue;
		}
		if (char !== undefined && /\s/.test(char)) {
			push();
			continue;
		}
		word += char ?? "";
		started = true;
	}
	push();
	return words;
}
