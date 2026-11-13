// Recognizable executable forms only. This is deliberately not a shell/SQL
// interpreter or a sandbox: no expansion, script loading or remote inspection.
const DESTRUCTION_KIND = { DATABASE: "database", FILESYSTEM: "filesystem", GIT: "git" } as const;
type DestructionKind = (typeof DESTRUCTION_KIND)[keyof typeof DESTRUCTION_KIND];
export interface DestructiveCommandMatch {
	kind: DestructionKind;
	triggerIndex: number;
	hardDeny: boolean;
	/**
	 * Literal targets of a direct, top-level, unwrapped and unquoted recursive
	 * `rm` that runs before every other segment of the command; absent otherwise.
	 */
	removalTargets?: readonly string[];
}
interface Token {
	value: string;
	raw: string;
	operator: boolean;
	index: number;
	redirect?: "target";
}
const separators = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);
// Separators after which the next segment starts only once this one finished.
// Pipes, background jobs and subshell parentheses run segments concurrently or
// out of textual order.
const SEQUENTIAL_SEPARATORS = new Set(["", ";", "&&", "||", "\n"]);

/** Literal, named heredocs are data, not executable shell segments; offsets are preserved. */
function blankHeredocs(command: string, joinBody = false): string {
	return command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (raw) => {
		const headerLength = raw.indexOf("\n") + (joinBody ? 0 : 1);
		return raw.slice(0, headerLength) + " ".repeat(raw.length - headerLength);
	});
}

const deliveryTokenPattern = /(?:\\\n)*#[^\n]*|(?:\d*(?:[<>]&|>\||<>|>>?|<<-?)|&>>?)|(?:"(?:\\[\s\S]|[^"\\])*"|'[^']*'|`(?:\\[\s\S]|[^`\\])*`|\\[\s\S]|[^\s;&|()<>'"\\])+|&&|\|\||[;&|()\n]/g;

/** Keep quoted arguments intact so harmless prose is never treated as a command. */
function tokenize(command: string, blank = true, delivery = false): Token[] {
	const tokens: Token[] = [];
	if (blank) command = blankHeredocs(command, delivery);
	// Delivery routing needs redirections as separate tokens, including attached
	// forms (`push>out`) and descriptor merges whose & is not a shell boundary.
	const pattern = delivery
		? deliveryTokenPattern
		: /(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s;&|()'"\\])+|&&|\|\||[;&|()\n]/g;
	for (const match of command.matchAll(pattern)) {
		const raw = match[0];
		if (delivery && /^(?:\\\n)*#/.test(raw)) continue;
		const wordPattern = delivery
			? /"((?:\\[\s\S]|[^"\\])*)"|'([^']*)'|\\([\s\S])/g
			: /"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/g;
		const value = raw.replace(wordPattern,
			(_raw, double: string | undefined, single: string | undefined, escaped: string | undefined) => {
				if (double !== undefined) return double.replace(/\\(["\\$`\n])/g, (_escape, char: string) => char === "\n" ? "" : char);
				return single ?? (delivery && escaped === "\n" ? "" : escaped) ?? "";
			});
		if (delivery && !value && /^(?:\\\n)+$/.test(raw)) continue;
		// Only raw operators are boundaries; quoted/escaped operators are words.
		// Consume the whole operand as one word: >&1--dry-run is a filename,
		// never descriptor 1 followed by a git option.
		const redirect = delivery && /^(?:\d*(?:[<>]&|>\||<>|>>?|<<-?)|&>>?)$/.test(raw) ? "target" : undefined;
		tokens.push({ value, raw, operator: separators.has(raw), index: match.index, ...(redirect ? { redirect } : {}) });
	}
	return tokens;
}
const executable = (value: string) => value.split("/").at(-1) ?? value;

/** `&` schedules its whole and/or list, including a closed compound command. */
function deliveryCommandScopes(tokens: readonly Token[], substitutions: readonly { index: number; end: number }[]): { background: Array<readonly [number, number]>; subshells: Array<readonly [number, number]> } {
	const ranges: Array<readonly [number, number]> = [];
	const subshells: Array<readonly [number, number]> = [];
	const scopes = [{ start: 0, close: "", opening: -1 }];
	const compoundEnds: Record<string, string> = { if: "fi", while: "done", until: "done", for: "done", select: "done", case: "esac", "{": "}" };
	let commandHead = true;
	let continuation = false;
	for (const token of tokens) {
		if (substitutions.some(body => token.index >= body.index && token.index < body.end)) continue;
		if (token.operator && token.raw === "(") { scopes.push({ start: token.index + 1, close: ")", opening: token.index }); commandHead = true; continue; }
		if ((token.operator && token.raw === ")") || (commandHead && token.raw === token.value && token.raw === scopes.at(-1)!.close)) {
			if (scopes.length > 1 && scopes.at(-1)!.close === token.raw) {
				const closed = scopes.pop()!;
				if (closed.opening >= 0) subshells.push([closed.opening, token.index + 1]);
			}
			commandHead = false;
			continue;
		}
		if (token.operator) {
			const scope = scopes.at(-1)!;
			if (token.raw === "&") ranges.push([scope.start, token.index]);
			if (["&", ";", "\n"].includes(token.raw) && !(token.raw === "\n" && continuation)) scope.start = token.index + token.raw.length;
			if (token.raw !== "\n") continuation = ["&&", "||", "|"].includes(token.raw);
			commandHead = true;
			continue;
		}
		continuation = false;
		if (commandHead && token.raw === token.value) {
			const close = compoundEnds[token.raw];
			if (close) scopes.push({ start: token.index, close, opening: -1 });
			if (["if", "while", "until", "then", "else", "elif", "do", "{", "!"].includes(token.raw)) continue;
		}
		commandHead = false;
	}
	for (const scope of scopes) if (scope.opening >= 0) subshells.push([scope.opening, Number.POSITIVE_INFINITY]);
	return { background: ranges, subshells };
}

/** Delivery and candidate changes share the guard's existing command-position rules. */
export function recognizeReviewDeliveryActions(command: string, depth = 0): Array<{ kind: "change" | "delivery"; directories?: readonly string[]; unresolvedDirectory?: true; background?: true }> {
	return collectReviewDeliveryActions(command, depth);
}

function collectReviewDeliveryActions(command: string, depth: number, onRoutingExport?: () => void): ReturnType<typeof recognizeReviewDeliveryActions> {
	if (depth > 8) return [];
	// Preserve offsets while removing comment data from every delivery scan,
	// including the secondary command-substitution and backtick scans.
	command = blankHeredocs(command, true).replace(deliveryTokenPattern, raw => /^(?:\\\n)*#/.test(raw) ? " ".repeat(raw.length) : raw);
	const matches: ReturnType<typeof recognizeReviewDeliveryActions> = [];
	const tokens = tokenize(command, true, true);
	const backticks = backtickBodies(command);
	const scopes = deliveryCommandScopes(tokens, backticks);
	const isBackground = (index: number) => scopes.background.some(([from, to]) => index >= from && index < to);
	const childScopes = [...scopes.subshells, ...scopes.background, ...backticks.map(body => [body.index, body.end] as const)];
	const exports: Array<{ index: number; children: Array<readonly [number, number]> }> = [];
	const routingUnknown = (index: number) => exports.some(entry => entry.index <= index && entry.children.every(([from, to]) => index >= from && index < to));
	const recordRoutingExport = (index: number) => {
		const children = childScopes.filter(([from, to]) => index >= from && index < to);
		exports.push({ index, children });
		if (!children.length) onRoutingExport?.();
	};
	const directories: string[] = [];
	const contexts: Array<{ from: number; to: number; unresolved: boolean; directories: string[] }> = [];
	let unresolvedDirectory = false;
	let leadingCdChain = true;
	const ambiguousCdScope = tokens.some(token => token.operator && !["&&", "||", "|"].includes(token.raw));
	let start = 0;
	for (let end = 0; end <= tokens.length; end++) {
		if (end < tokens.length && !tokens[end].operator) continue;
		const preceding = tokens[start - 1]?.raw;
		// A fallback may execute after cd itself failed. Never carry its selected
		// directory into a later delivery, even though the earlier push was scoped.
		if (tokens[start - 1]?.raw === "||" && directories.length) unresolvedDirectory = true;
		const words = tokens.slice(start, end);
		const from = tokens[start]?.index ?? command.length;
		const segment = words.filter((token, at) => !token.redirect && words[at - 1]?.redirect !== "target");
		start = end + 1;
		let unresolvedPrefix = false;
		const cursor = headCursor(segment, () => { unresolvedPrefix = true; });
		const name = executable(segment[cursor]?.value ?? "").replace(/\.exe$/i, "");
		const args = segment.slice(cursor + 1).map(token => token.value);
		// A persistent export may change the later Git target; never borrow the cwd's mode.
		if (name === "export" && args.some(arg => /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|NAMESPACE)(?:=|$)/.test(arg))) recordRoutingExport(segment[cursor].index);
		let index = 0;
		const gitDirectories: string[] = [];
		let unresolvedGitDirectory = false;
		if (name === "cd") {
			if (leadingCdChain && !ambiguousCdScope && (preceding === undefined || preceding === "&&") && cursor === 0 && tokens[end]?.raw === "&&" &&
				args.length === 1 && !/[\n\r$`~]/.test(args[0]) && !args[0].startsWith("-")) directories.push(args[0]);
			else unresolvedDirectory = true;
		}
		if (name === "pushd" || name === "popd") unresolvedDirectory = true;
		if (segment.length && name !== "cd") leadingCdChain = false;
		contexts.push({ from, to: tokens[end]?.index ?? command.length, unresolved: unresolvedDirectory || unresolvedPrefix, directories: [...directories] });
		while (name === "git" && index < args.length && args[index].startsWith("-")) {
			if (args[index] === "-C") {
				if (!args[index + 1] || /[\n\r$`~]/.test(args[index + 1])) unresolvedGitDirectory = true;
				else gitDirectories.push(args[index + 1]);
				index += 2;
			}
			else if (args[index].startsWith("-C") && args[index].length > 2) {
				const directory = args[index++].slice(2);
				if (/[\n\r$`~]/.test(directory)) unresolvedGitDirectory = true;
				else gitDirectories.push(directory);
			}
			else if (args[index] === "-c") index += 2;
			else if (["--git-dir", "--work-tree", "--namespace"].includes(args[index])) { unresolvedGitDirectory = true; index += 2; }
			else if (/^--(?:git-dir|work-tree|namespace)=/.test(args[index])) { unresolvedGitDirectory = true; index++; }
			else index++;
		}
		while (name === "gh" && index < args.length && args[index].startsWith("-")) {
			index += ["-R", "--repo"].includes(args[index]) ? 2 : 1;
		}
		if (name === "git" && args[index] === "push" && args.slice(index + 1).some(arg => ["--dry-run", "-n", "--delete", "-d"].includes(arg))) continue;
		if (name === "git" && ["commit", "merge", "rebase", "reset", "checkout", "switch", "cherry-pick", "revert", "am", "pull", "update-ref"].includes(args[index])) matches.push({ kind: "change" });
		if ((name === "git" && args[index] === "push") || (name === "gh" && args[index] === "pr" && ["create", "merge"].includes(args[index + 1]))) {
			matches.push({ kind: "delivery",
				...(isBackground(segment[cursor].index) ? { background: true as const } : {}),
				...(unresolvedDirectory || unresolvedGitDirectory || unresolvedPrefix || routingUnknown(segment[cursor].index) ? { unresolvedDirectory: true as const } : {}),
				...(!directories.length && !gitDirectories.length ? {} : { directories: [...directories, ...gitDirectories] }) });
		}
		if (["sh", "bash", "zsh", "dash", "eval"].includes(name)) {
			const flag = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg));
			const payload = name === "eval" ? (args[0] === "--" ? args.slice(1) : args).join(" ") : flag >= 0 ? args[flag + 1] : undefined;
			if (payload) {
				const inheritedUnknown = unresolvedDirectory || unresolvedPrefix || routingUnknown(segment[cursor].index);
				const nested = collectReviewDeliveryActions(payload, depth + 1, name === "eval" ? () => recordRoutingExport(segment[cursor].index) : undefined);
				matches.push(...nested.map(match => ({ ...match,
					...(match.kind === "delivery" && isBackground(segment[cursor].index) ? { background: true as const } : {}),
					...(inheritedUnknown ? { unresolvedDirectory: true as const } : {}), directories: [...directories, ...(match.directories ?? [])] })));
			}
		}
	}
	const inheritSubstitution = (payload: string, index: number) => {
		const context = contexts.find(scope => index >= scope.from && index < scope.to);
		return collectReviewDeliveryActions(payload, depth + 1).map(match => ({ ...match,
			...(context?.unresolved || routingUnknown(index) ? { unresolvedDirectory: true as const } : {}),
			...(context?.directories.length ? { directories: [...context.directories, ...(match.directories ?? [])] } : {}),
			...(match.kind === "delivery" && isBackground(index) ? { background: true as const } : {}),
		}));
	};
	for (const match of command.matchAll(/\$\(([^()]*)\)/g)) {
		let quote: "'" | '"' | undefined;
		for (let index = 0; index < match.index; index++) {
			const char = command[index];
			if (quote === "'") { if (char === "'") quote = undefined; }
			else if (char === "\\") index++;
			else if (char === "'" && quote === undefined) quote = "'";
			else if (char === '"') quote = quote === '"' ? undefined : '"';
		}
		if (quote !== "'") matches.push(...inheritSubstitution(match[1], match.index));
	}
	for (const { body, index } of backticks) matches.push(...inheritSubstitution(body, index));
	return matches;
}

const WRAPPER_VALUE_OPTIONS: Record<string, readonly string[]> = {
	env: ["-u", "--unset", "-C", "--chdir"],
	sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "--user", "--group", "--host", "--prompt", "--chdir"],
	timeout: ["-s", "--signal", "-k", "--kill-after"],
	xargs: ["-n", "-I", "-P", "--max-args", "--replace", "--max-procs"],
};
const WRAPPERS = ["env", "sudo", "command", "exec", "nohup", "timeout", "xargs"];
// gentle-pi#2285: unquoted reserved words that open a compound body or a
// condition are followed by a command in command position.
const RESERVED_WORDS = new Set(["then", "else", "elif", "do", "{", "!", "if", "while", "until"]);

/** Index of the executable token after reserved words, assignments and familiar wrappers. */
function headCursor(segment: readonly Token[], onTargetRedirect?: () => void): number {
	let cursor = 0;
	while (cursor < segment.length && segment[cursor].raw === segment[cursor].value && RESERVED_WORDS.has(segment[cursor].value)) cursor++;
	while (cursor < segment.length) {
		const value = segment[cursor].value;
		if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(value)) {
			if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|NAMESPACE)=/.test(value)) onTargetRedirect?.();
			cursor++;
			continue;
		}
		const name = executable(value);
		if (!WRAPPERS.includes(name)) break;
		cursor++;
		while (cursor < segment.length && segment[cursor].value.startsWith("-")) {
			const flag = segment[cursor++].value;
			if (flag === "--") break;
			if (name === "env" && /^(?:-C.*|--chdir(?:=|$))/.test(flag)) onTargetRedirect?.();
			if (name === "sudo" && /^(?:-D.*|--chdir(?:=|$))/.test(flag)) onTargetRedirect?.();
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
// gentle-shell#1202: read-only subcommands that neither execute nor re-route
// text. A segment headed by one of these no longer makes the whole line opaque,
// provided nothing is piped into it and nothing precedes the head (assignments,
// wrappers) or follows `git` besides `-C <path>` / `--no-pager`. `push` and
// `rebase` are the guarded operations themselves: they match lexically on their
// own text and run only their own literal arguments. Every such segment must be
// free of `$`: a masked data substitution could smuggle in options such as
// `--receive-pack=` or `-x`.
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "rev-list", "ls-files", "describe"]);
const LITERAL_GIT = new Set(["push", "rebase"]);
const READ_ONLY_GH = new Map([["pr", ["view", "list", "checks", "diff", "status"]], ["issue", ["view", "list", "status"]], ["run", ["view", "list"]]]);

/**
 * True when the segment at `cursor` is a top-level, literal `git` or `gh`
 * command that reads only (or a literal push/rebase the YOLO waiver already
 * judges on its own), so it cannot turn a sibling data argument into an action.
 * Piped-into, nested or `$`-bearing segments are never eligible.
 */
function readOnlyVcsSegment(segment: readonly Token[], cursor: number, pipedInto: boolean, literal: boolean): boolean {
	if (pipedInto || !literal || cursor !== 0) return false;
	const name = segment[0].value;
	if (name !== "git" && name !== "gh") return false;
	if (segment.some((token) => token.value !== token.raw)) return false;
	if (name === "gh") return READ_ONLY_GH.get(segment[1]?.value)?.includes(segment[2]?.value) ?? false;
	let index = 1;
	while (index < segment.length) {
		if (segment[index].value === "--no-pager") index++;
		else if (segment[index].value === "-C" && index + 1 < segment.length) index += 2;
		else break;
	}
	const subcommand = segment[index]?.value;
	return READ_ONLY_GIT.has(subcommand) || LITERAL_GIT.has(subcommand);
}
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g;

type Ranges = Array<readonly [number, number]>;
// A simple `$(...)`: no nested substitution, quoting, expansion or escapes in its body.
const SIMPLE_SUBSTITUTION_RE = /\$\(([^()'"`$\\]*)\)/g;

/**
 * Replace each simple `$(...)` whose body is itself only data and inert
 * commands with a same-length placeholder word, so offsets are preserved.
 * Such a substitution runs nothing guarded; its output is only more words.
 * Returns undefined when any substitution is not provably data, or when a
 * heredoc could expand one in its body.
 */
function maskDataSubstitutions(command: string): { masked: string; ranges: Ranges } | undefined {
	if (!command.includes("$(")) return { masked: command, ranges: [] };
	if (command.includes("<<")) return undefined;
	const ranges: Ranges = [];
	let opaque = false;
	const masked = command.replace(SIMPLE_SUBSTITUTION_RE, (raw: string, body: string, offset: number) => {
		const inner = dataRanges(body, true);
		if (inner === undefined) opaque = true;
		else ranges.push(...inner.map(([from, to]) => [offset + 2 + from, offset + 2 + to] as const));
		return "_".repeat(raw.length);
	});
	return opaque || masked.includes("$(") ? undefined : { masked, ranges };
}

/**
 * Byte ranges of the command that are plain arguments of a known data command
 * (gentle-shell#2174). A guarded or denied pattern matching only inside these
 * ranges is prose, not an operation. Returns no ranges, keeping every lexical
 * match, when the command is opaque: a command substitution that is not
 * itself only data commands, process substitution or backticks, an
 * interpreter or remote shell anywhere, or quoting the tokenizer cannot
 * account for.
 */
export function dataArgumentRanges(command: string): Ranges {
	return dataRanges(command) ?? [];
}

/**
 * Undefined means opaque; an empty list means only inert commands. A nested
 * (substitution) body admits data and inert commands only: its output is text
 * that can run, so an ordinary git or gh segment inside it proves nothing.
 */
function dataRanges(original: string, nested = false): Ranges | undefined {
	const substitutions = maskDataSubstitutions(original);
	if (substitutions === undefined) return undefined;
	const command = substitutions.masked;
	if (/`|[<>]\(/.test(command)) return undefined;
	// A heredoc counts only when its `<<` starts an unquoted token of the raw
	// command; quoted text such as `echo '<<x'` must not blank following lines.
	const rawStarts = new Set(tokenize(command, false).filter((token) => token.raw.startsWith("<<")).map((token) => token.index));
	const heredocs = [...command.matchAll(HEREDOC_RE)];
	if (heredocs.some((heredoc) => !rawStarts.has(heredoc.index))) return undefined;
	const blanked = blankHeredocs(command);
	const tokens = tokenize(command);
	const covered = new Uint8Array(blanked.length);
	for (const token of tokens) covered.fill(1, token.index, token.index + token.raw.length);
	for (let index = 0; index < blanked.length; index++) {
		if (!covered[index] && !/\s/.test(blanked[index])) return undefined;
	}
	const ranges: Ranges = [...substitutions.ranges];
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
		// A segment of plain assignments only (`f=$(ls)`) runs no command.
		if (head === undefined && cursor > 0 && segment[0].value !== "env") continue;
		if (head === undefined || head.value !== head.raw) return undefined;
		const name = head.value;
		if (INERT_COMMANDS.has(name)) continue;
		if (!DATA_COMMANDS.has(name)) {
			// Output of an earlier segment may be piped into this one, also across
			// blank segments (`|` then newline, `|&`).
			let pipedInto = false;
			for (let back = end - segment.length - 1; back >= 0 && tokens[back].operator; back--) pipedInto ||= tokens[back].raw === "|";
			if (!nested && readOnlyVcsSegment(segment, cursor, pipedInto, !original.slice(segment[0].index, segment.at(-1)!.index + segment.at(-1)!.raw.length).includes("$"))) continue;
			return undefined;
		}
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

/** Operands of a plain `rm` invocation, or undefined when any argument is quoted, escaped or disables root protection. */
function removalTargets(args: readonly Token[]): string[] | undefined {
	const targets: string[] = [];
	let options = true;
	for (const arg of args) {
		if (arg.raw !== arg.value || arg.value === "--no-preserve-root") return undefined;
		if (options && arg.value === "--") options = false;
		else if (options && arg.value.startsWith("-")) continue;
		else targets.push(arg.value);
	}
	return targets.length > 0 ? targets : undefined;
}

/**
 * Bodies of backtick command substitutions outside single quotes, with the
 * backslash escapes that backticks remove, and the offset of each opening
 * backtick. An unterminated substitution is a shell syntax error and runs
 * nothing, so it yields no body. Heredoc bodies stay data, as elsewhere.
 */
function backtickBodies(command: string): Array<{ body: string; index: number; end: number }> {
	const bodies: Array<{ body: string; index: number; end: number }> = [];
	const text = blankHeredocs(command);
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote === "'") {
			if (char === "'") quote = undefined;
		} else if (char === "\\") {
			index++;
		} else if (char === "'" && quote === undefined) {
			quote = "'";
		} else if (char === '"') {
			quote = quote === '"' ? undefined : '"';
		} else if (char === "`") {
			let end = index + 1;
			while (end < text.length && text[end] !== "`") end += text[end] === "\\" ? 2 : 1;
			if (end >= text.length) break;
			bodies.push({ body: text.slice(index + 1, end).replace(/\\([\\$`])/g, "$1"), index, end: end + 1 });
			index = end;
		}
	}
	return bodies;
}

export function recognizeDestructiveCommands(command: string, depth = 0): DestructiveCommandMatch[] {
	if (depth > 4) return [];
	const tokens = tokenize(command);
	const matches: DestructiveCommandMatch[] = [];
	let previous: Token[] = [];
	let previousSeparator = "";
	// True while every earlier segment was a leading literal recursive `rm`.
	let leadingRemovals = depth === 0;
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
		// `eval` runs its arguments joined by spaces, like a literal `sh -c` payload.
		if (name === "eval") {
			const payload = (args[0] === "--" ? args.slice(1) : args).join(" ");
			matches.push(...recognizeDestructiveCommands(payload, depth + 1).map((match) => ({ ...match, triggerIndex: head.index })));
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
			const sequential = SEQUENTIAL_SEPARATORS.has(tokens[end]?.raw ?? "");
			const targets = leadingRemovals && sequential && cursor === 0 && head.raw === "rm" ? removalTargets(segment.slice(1)) : undefined;
			if (targets !== undefined) matches[matches.length - 1].removalTargets = targets;
			else leadingRemovals = false;
		} else if (segment.length > 0 || tokens[end]?.raw !== "\n") {
			// Only blank lines may sit between leading removals.
			leadingRemovals = false;
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
	// Backtick substitutions run like `$(...)`, also inside double quotes.
	for (const { body, index } of backtickBodies(command)) {
		matches.push(...recognizeDestructiveCommands(body, depth + 1).map((match) => ({ ...match, triggerIndex: index })));
	}
	return matches;
}
