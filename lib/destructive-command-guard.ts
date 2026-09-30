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

/** Keep quoted arguments intact so harmless prose is never treated as a command. */
function tokenize(command: string): Token[] {
	const tokens: Token[] = [];
	// Literal, named heredocs are data, not executable shell segments.
	command = command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (raw) => {
		const headerLength = raw.indexOf("\n") + 1;
		return raw.slice(0, headerLength) + " ".repeat(raw.length - headerLength);
	});
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
		let cursor = 0;
		// Assignments and familiar executable wrappers preserve command position.
		while (cursor < segment.length) {
			const value = segment[cursor].value;
			if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(value)) {
				cursor++;
				continue;
			}
			const name = executable(value);
			if (!["env", "sudo", "command", "exec", "nohup", "timeout", "xargs"].includes(name)) break;
			const valueOptions: Record<string, readonly string[]> = {
				env: ["-u", "--unset", "-C", "--chdir"],
				sudo: ["-u", "-g", "-h", "-p", "-C", "--user", "--group", "--host", "--prompt", "--chdir"],
				timeout: ["-s", "--signal", "-k", "--kill-after"],
				xargs: ["-n", "-I", "-P", "--max-args", "--replace", "--max-procs"],
			};
			cursor++;
			while (cursor < segment.length && segment[cursor].value.startsWith("-")) {
				const flag = segment[cursor++].value;
				if (flag === "--") break;
				if (valueOptions[name]?.includes(flag)) cursor++;
			}
			if (name === "timeout") cursor++;
		}
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
