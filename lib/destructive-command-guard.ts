// Recognizable executable forms only. This is deliberately not a shell/SQL
// interpreter or a sandbox: no expansion, script loading or remote inspection.
const DESTRUCTION_KIND = { DATABASE: "database", FILESYSTEM: "filesystem", GIT: "git" } as const;
type DestructionKind = (typeof DESTRUCTION_KIND)[keyof typeof DESTRUCTION_KIND];
export interface DestructiveCommandMatch {
	kind: DestructionKind;
	triggerIndex: number;
	hardDeny: boolean;
}
interface Token {
	value: string;
	raw: string;
	operator: boolean;
	index: number;
}
const separators = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);

/** Literal, named heredocs are data, not executable shell segments; offsets are preserved. */
function blankHeredocs(command: string): string {
	return command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (raw) => {
		const headerLength = raw.indexOf("\n") + 1;
		return raw.slice(0, headerLength) + " ".repeat(raw.length - headerLength);
	});
}

/** Keep quoted arguments intact so harmless prose is never treated as a command. */
function tokenize(command: string, blank = true): Token[] {
	const tokens: Token[] = [];
	if (blank) command = blankHeredocs(command);
	const pattern = /(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s;&|()'"\\])+|&&|\|\||[;&|()\n]/g;
	for (const match of command.matchAll(pattern)) {
		const raw = match[0];
		const value = raw.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/g,
			(_raw, double: string | undefined, single: string | undefined, escaped: string | undefined) => {
				if (double !== undefined) return double.replace(/\\(["\\$`\n])/g, (_escape, char: string) => char === "\n" ? "" : char);
				return single ?? escaped ?? "";
			});
		// Only raw operators are boundaries; quoted/escaped operators are words.
		tokens.push({ value, raw, operator: separators.has(raw), index: match.index });
	}
	return tokens;
}
const executable = (value: string) => value.split("/").at(-1) ?? value;

const WRAPPER_VALUE_OPTIONS: Record<string, readonly string[]> = {
	env: ["-u", "--unset", "-C", "--chdir"],
	sudo: ["-u", "-g", "-h", "-p", "-C", "--user", "--group", "--host", "--prompt", "--chdir"],
	timeout: ["-s", "--signal", "-k", "--kill-after"],
	xargs: ["-n", "-I", "-P", "--max-args", "--replace", "--max-procs"],
};
const WRAPPERS = ["env", "sudo", "command", "exec", "nohup", "timeout", "xargs"];

/** Index of the executable token after assignments and familiar wrappers. */
function headCursor(segment: readonly Token[]): number {
	let cursor = 0;
	while (cursor < segment.length) {
		const value = segment[cursor].value;
		if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(value)) {
			cursor++;
			continue;
		}
		const name = executable(value);
		if (!WRAPPERS.includes(name)) break;
		cursor++;
		while (cursor < segment.length && segment[cursor].value.startsWith("-")) {
			const flag = segment[cursor++].value;
			if (flag === "--") break;
			if (WRAPPER_VALUE_OPTIONS[name]?.includes(flag)) cursor++;
		}
		if (name === "timeout") cursor++;
	}
	return cursor;
}

// gentle-shell#2174: commands whose arguments are searched, printed or viewed
// text, never executed and never fed to an executor. `sed` is absent on
// purpose: GNU sed executes scripts through `e` with any delimiter or address.
// The exemption applies only when EVERY segment head is in DATA_COMMANDS or
// INERT_COMMANDS, so an unknown consumer (`| at now`, `&& ./x.sh`) keeps the
// lexical guard: a missing entry costs a dialog, never a bypass.
const DATA_COMMANDS = new Set([
	"grep", "egrep", "fgrep", "rg", "ag", "ack", "echo", "printf", "cat", "head", "tail", "less", "more",
	"wc", "sort", "uniq", "cut", "tr", "jq", "diff", "ls", "file", "stat",
]);
const INERT_COMMANDS = new Set(["cd", "pwd", "true", "false", "test", "[", "mkdir", "touch"]);
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g;

/**
 * Byte ranges of the command that are plain arguments of a known data command
 * (gentle-shell#2174). A guarded or denied pattern matching only inside these
 * ranges is prose, not an operation. Returns no ranges, keeping every lexical
 * match, when the command is opaque: command or process substitution, an
 * interpreter or remote shell anywhere, or quoting the tokenizer cannot
 * account for.
 */
export function dataArgumentRanges(command: string): Array<readonly [number, number]> {
	if (/\$\(|`|[<>]\(/.test(command)) return [];
	// A heredoc counts only when its `<<` starts an unquoted token of the raw
	// command; quoted text such as `echo '<<x'` must not blank following lines.
	const rawStarts = new Set(tokenize(command, false).filter((token) => token.raw.startsWith("<<")).map((token) => token.index));
	const heredocs = [...command.matchAll(HEREDOC_RE)];
	if (heredocs.some((heredoc) => !rawStarts.has(heredoc.index))) return [];
	const blanked = blankHeredocs(command);
	const tokens = tokenize(command);
	const covered = new Uint8Array(blanked.length);
	for (const token of tokens) covered.fill(1, token.index, token.index + token.raw.length);
	for (let index = 0; index < blanked.length; index++) {
		if (!covered[index] && !/\s/.test(blanked[index])) return [];
	}
	const ranges: Array<readonly [number, number]> = [];
	let start = 0;
	for (let end = 0; end <= tokens.length; end++) {
		if (end < tokens.length && !tokens[end].operator) continue;
		const segment = tokens.slice(start, end);
		start = end + 1;
		if (segment.length === 0) continue;
		// Only plain assignments, optionally after a flagless `env`, may precede
		// the head; every other wrapper or wrapper flag can change what runs.
		let cursor = 0;
		if (segment[0].value === "env") cursor++;
		while (cursor < segment.length && /^[A-Za-z_][A-Za-z_0-9]*=/.test(segment[cursor].value)) cursor++;
		const head = segment[cursor];
		if (head === undefined || head.value !== head.raw) return [];
		const name = head.value;
		if (INERT_COMMANDS.has(name)) continue;
		if (!DATA_COMMANDS.has(name)) return [];
		ranges.push([head.index + head.raw.length, tokens[end]?.index ?? command.length]);
	}
	// A heredoc body belongs to the segment of its `<<` header, which the
	// header's trailing newline would otherwise split off. Only the body is
	// covered: the rest of the header line can hold further commands.
	for (const heredoc of heredocs) {
		const bodyStart = heredoc.index + heredoc[0].indexOf("\n") + 1;
		if (ranges.some(([from, to]) => heredoc.index >= from && heredoc.index < to)) ranges.push([bodyStart, heredoc.index + heredoc[0].length]);
	}
	return ranges;
}

function sqlDestroys(sql: string): boolean {
	// Mask quoted identifiers as non-keyword atoms, and remove comments and
	// strings. A table named "where" is not a predicate or a statement boundary.
	const code = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]/g,
		(raw) => /^["`\[]/.test(raw) ? "identifier" : " ");
	return code.split(";").some((statement) => {
		if (/^\s*(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW)\b|TRUNCATE\s+(?:TABLE\s+)?\S)/i.test(statement)) return true;
		if (!/^\s*DELETE\s+FROM\s+\S/i.test(statement)) return false;
		return !/\bWHERE\b/i.test(statement) || /\bWHERE\s+(?:1\s*=\s*1|TRUE)\s*$/i.test(statement.trim());
	});
}

export function recognizeDestructiveCommands(command: string, depth = 0): DestructiveCommandMatch[] {
	if (depth > 4) return [];
	const tokens = tokenize(command);
	const matches: DestructiveCommandMatch[] = [];
	let previous: Token[] = [];
	let previousSeparator = "";
	let start = 0;
	for (let end = 0; end <= tokens.length; end++) {
		if (end < tokens.length && !tokens[end].operator) continue;
		const segment = tokens.slice(start, end);
		// Assignments and familiar executable wrappers preserve command position.
		const cursor = headCursor(segment);
		const head = segment[cursor];
		const name = executable(head?.value ?? "");
		const args = segment.slice(cursor + 1).map((token) => token.value);
		const add = (kind: DestructionKind, hardDeny = false) => matches.push({ kind, hardDeny, triggerIndex: head.index });
		if (["sh", "bash", "zsh", "dash"].includes(name)) {
			const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
			if (flag >= 0 && args[flag + 1]) {
				// Nested offsets use the enclosing executable, which is stable even
				// when quote removal changes the payload's byte positions.
				matches.push(...recognizeDestructiveCommands(args[flag + 1], depth + 1).map((match) => ({ ...match, triggerIndex: head.index })));
			}
		}
		if (["psql", "mysql", "mariadb", "sqlite3"].includes(name)) {
			const payloads = args.map((arg) => arg.replace(/^(?:--command|--execute)=/, ""));
			const heredoc = command.slice(head.index).match(/^[^\n]*<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n([\s\S]*?)\n\2(?=\n|$)/);
			if (heredoc) payloads.push(heredoc[3]);
			if (previousSeparator === "|" && ["echo", "printf"].includes(executable(previous[0]?.value ?? ""))) {
				payloads.push(previous.slice(1).map((token) => token.value).join(" ").replace(/^%s\s*/, ""));
			}
			if (payloads.some(sqlDestroys)) add(DESTRUCTION_KIND.DATABASE);
		}
		if (name === "rm" && args.some((arg) => /^-[^-]*[rR]/.test(arg) || arg === "--recursive")) {
			const rootTarget = args.some((arg) => /^(?:\/(?:\*+)?$|\.{1,2}\/?$|~(?:\/|$)|\$\{?HOME\}?(?:\/|$))/.test(arg));
			add(DESTRUCTION_KIND.FILESYSTEM, rootTarget);
		}
		if (name === "find") {
			if (args.includes("-delete")) add(DESTRUCTION_KIND.FILESYSTEM);
			for (let execIndex = 0; execIndex < args.length; execIndex++) {
				if (!["-exec", "-execdir"].includes(args[execIndex])) continue;
				const invocation = segment.slice(cursor + execIndex + 2);
				const terminator = invocation.findIndex((arg) => arg.value === ";" || arg.value === "+");
				const nested = (terminator < 0 ? invocation : invocation.slice(0, terminator)).map((arg) => arg.raw).join(" ");
				matches.push(...recognizeDestructiveCommands(nested, depth + 1).map((match) => ({ ...match, triggerIndex: head.index })));
				if (terminator < 0) break;
				execIndex += terminator + 1;
			}
		}
		if (name === "git") {
			let index = 0;
			while (args[index]?.startsWith("-")) {
				const flag = args[index++];
				if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(flag)) index++;
			}
			const action = args[index];
			const flags = args.slice(index + 1);
			const force = flags.some((arg) => /^--force(?:-with-lease|=|$)/.test(arg) || /^-[^-]*f/.test(arg));
			const hard = (action === "reset" && flags.includes("--hard")) || (action === "clean" && force) || (action === "push" && force);
			const branchDelete = action === "branch" && (flags.some((arg) => /^-[^-]*D/.test(arg)) || (force && flags.some((arg) => arg === "--delete" || /^-[^-]*d/.test(arg))));
			if (hard || branchDelete || ["reset", "clean", "restore", "rebase"].includes(action) ||
				(action === "checkout" && (force || flags.includes("--"))) ||
				(action === "stash" && ["drop", "clear"].includes(flags[0]))) add(DESTRUCTION_KIND.GIT, hard);
		}
		previous = segment;
		previousSeparator = tokens[end]?.value ?? "";
		start = end + 1;
	}
	return matches;
}
