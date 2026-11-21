import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { indexState } from "../lib/codegraph-lease.ts";

/**
 * The persistent-memory reads the AGENTS.md Memory ordering rule gates: in a prompt that has
 * searched the workspace they may run only after a codegraph query or explore has finalized in
 * the same user prompt, and no read may interleave a graph execution - one in flight, or
 * listed in the read's own turn's batch.
 */
const MEMORY_READ_TOOLS = new Set(["mem_context", "mem_search", "mem_get_observation"]);

/** The exact reason a gated persistent-memory read is blocked with. */
const BLOCK_REASON =
	"codegraph-first gate: persistent-memory reads come after codegraph (AGENTS.md Memory ordering): a read is blocked while a codegraph query or explore is in flight, when the same turn's tool batch also lists one or a not-yet-credited workspace search, and, once the prompt has searched the workspace, until a query or explore finalizes in the same user prompt. Call codegraph first - a failed or unavailable attempt also counts - then retry this memory read; a memory-only prompt is never gated.";

/** The environment override for the gate's workspace scoping: "1" forces it on, "0" off. */
const MEMORY_GATE_OVERRIDE = "GENTLE_CODEGRAPH_MEMORY_GATE";

/**
 * Replaces every quoted span, escape, comment, and here-document body of a bash command
 * string with a neutral filler: a quoted span or escape is data inside a word, so it becomes
 * a NUL byte that keeps the word a word, while comment text and a here-document's delimiter
 * and body are no word at all and become MASKED_NON_WORD, which the word walkers skip.
 * Either way no separator, operator, or command word inside them can be read as an execution.
 * Length and every unquoted character's position are preserved, so the command's structure
 * outside quotes stays exactly where it was. A comment starts at an unquoted word-start #
 * and runs to the end of its line. A quoted here-document (<<'D', <<"D", <<-'D', <<-"D")
 * contributes its body too: the lines from the operator's newline through the line that
 * equals the delimiter are the reading command's stdin, never syntax, so they are all
 * filler. Only the newline ending the final delimiter line stays live, so parsing resumes
 * right after the body at a fresh command position.
 */
function maskQuotedCommandText(command: string): string {
	const filler = "\u0000";
	const isWordBreak = (ch: string) =>
		ch === " " || ch === "\t" || ch === "\r" || ch === "\n" ||
		ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")";
	let masked = "";
	let quote = "";
	// Whether the next unquoted # would start a comment: true at the string start and after
	// any word-breaking character, because bash opens a comment only at the start of a word.
	let wordStart = true;
	// The quoted here-document delimiters whose bodies are still unread, in declaration
	// order: each body starts at its operator's newline and ends at its delimiter line, with
	// `<<-` allowing the terminator line to be tab-indented.
	const heredocs: Array<{ delimiter: string; stripTabs: boolean }> = [];
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote === "'") {
			masked += filler;
			if (ch === "'") {
				quote = "";
				wordStart = false;
			}
		} else if (quote === '"') {
			masked += filler;
			if (ch === "\\") {
				i++;
				masked += filler;
			} else if (ch === '"') {
				quote = "";
				wordStart = false;
			}
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			masked += filler;
			wordStart = false;
		} else if (ch === "\\") {
			i++;
			masked += filler + filler;
			wordStart = false;
		} else if (ch === "#" && wordStart) {
			// The comment's text through end of line never executes, so it is all data. The
			// newline itself stays: the walker still needs it as a command terminator.
			masked += MASKED_NON_WORD;
			while (i + 1 < command.length && command[i + 1] !== "\n") {
				i++;
				masked += MASKED_NON_WORD;
			}
			wordStart = true;
		} else if (ch === "<" && command[i + 1] === "<") {
			// A here-document operator: the operator itself, and anything piped after it on the
			// same line, stay live syntax, while a quoted delimiter word is data. Bash applies
			// quote removal to the whole word and concatenates its segments, so <<'E'OF and
			// <<E'OF' both name EOF; only a word holding a quoted segment keeps its body literal,
			// and an unquoted delimiter is left untouched because bash still expands that body.
			masked += "<<";
			i++;
			let stripTabs = false;
			if (command[i + 1] === "-") {
				masked += "-";
				i++;
				stripTabs = true;
			}
			while (i + 1 < command.length && (command[i + 1] === " " || command[i + 1] === "\t")) {
				masked += command[i + 1]!;
				i++;
			}
			const delimiterWord = readHeredocDelimiterWord(command, i + 1);
			if (delimiterWord !== undefined && delimiterWord.quoted) {
				heredocs.push({ delimiter: delimiterWord.delimiter, stripTabs });
				// The whole word is data, so its masked span runs to where the word ends.
				for (let k = i + 1; k < delimiterWord.end; k++) masked += MASKED_NON_WORD;
				i = delimiterWord.end - 1;
				wordStart = false;
			}
		} else if (ch === "\n" && heredocs.length > 0) {
			// The here-document bodies start after this newline: every line through the one that
			// equals the pending delimiter is stdin data, so the whole region is filler. An input
			// that ends before a terminator has simply consumed its rest as data.
			masked += MASKED_NON_WORD;
			while (heredocs.length > 0 && i + 1 < command.length) {
				let lineEnd = command.indexOf("\n", i + 1);
				const terminated = lineEnd !== -1;
				if (lineEnd === -1) lineEnd = command.length;
				const line = command.slice(i + 1, lineEnd);
				for (let k = i + 1; k < lineEnd; k++) masked += MASKED_NON_WORD;
				const pending = heredocs[0]!;
				const candidate = pending.stripTabs ? line.replace(/^\t+/, "") : line;
				const terminator = candidate === pending.delimiter;
				if (terminator) heredocs.shift();
				if (!terminator || heredocs.length > 0) {
					// Still inside a body, or another declared body follows: the line's newline is
					// data too, unless the input already ended mid-body.
					if (!terminated) {
						i = lineEnd - 1;
						break;
					}
					masked += MASKED_NON_WORD;
					i = lineEnd;
					continue;
				}
				if (terminated) {
					// The last body ended: its newline stays live, resuming parsing at a fresh
					// command position on the line after the delimiter.
					masked += "\n";
					i = lineEnd;
				} else {
					i = lineEnd - 1;
				}
				break;
			}
			wordStart = true;
		} else {
			masked += ch;
			wordStart = isWordBreak(ch);
		}
	}
	return masked;
}

/** The masked byte for text that can never be part of a command word: a comment's text and
 * a here-document's delimiter and body. The command word walkers skip it entirely, which is
 * what keeps a masked quoted word an operand while a comment or a body reads as no word. */
const MASKED_NON_WORD = "\u0001";

/** The characters that end a here-document delimiter word: whitespace and every shell
 * metacharacter that starts a new token. */
const HEREDOC_WORD_BREAK = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "(", ")", "<", ">"]);

/**
 * Reads the here-document delimiter word starting at `from` and applies bash's quote removal
 * to it, returning the delimiter bash will match, the offset just past the word, and whether
 * any segment was quoted. Quoting is per segment - bash concatenates adjacent quoted and
 * unquoted segments into one word - so <<'E'OF, <<E'OF', and <<"E"OF all name EOF. A word
 * with no quoted segment is left undefined, because bash still expands that body and only a
 * literal one is data. An unterminated quote or a trailing escape yields undefined too: the
 * shell rejects such a word, so there is no body it could delimit.
 */
function readHeredocDelimiterWord(
	command: string,
	from: number,
): { delimiter: string; end: number; quoted: boolean } | undefined {
	let delimiter = "";
	let quoted = false;
	let i = from;
	while (i < command.length && !HEREDOC_WORD_BREAK.has(command[i]!)) {
		const ch = command[i]!;
		if (ch === "'") {
			quoted = true;
			i++;
			while (i < command.length && command[i] !== "'" && command[i] !== "\n") delimiter += command[i++]!;
			if (command[i] !== "'") return undefined;
			i++;
		} else if (ch === '"') {
			quoted = true;
			i++;
			while (i < command.length && command[i] !== '"' && command[i] !== "\n") {
				if (command[i] === "\\") {
					i++;
					if (i >= command.length || command[i] === "\n") return undefined;
				}
				delimiter += command[i++]!;
			}
			if (command[i] !== '"') return undefined;
			i++;
		} else if (ch === "\\") {
			// A backslash-escaped character quotes that one character, which is already enough
			// to keep the body literal.
			quoted = true;
			i++;
			if (i >= command.length || command[i] === "\n") return undefined;
			delimiter += command[i++]!;
		} else {
			delimiter += ch;
			i++;
		}
	}
	if (delimiter === "") return undefined;
	return { delimiter, end: i, quoted };
}

/** A word bash accepts as a temporary environment assignment (NAME=VALUE) ahead of the
 * command it applies to; the value side is whatever one unquoted word can hold. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Whether a masked word is a leading environment assignment: the NAME= prefix must be
 * unquoted, while the value may quote freely - LC_ALL=\"C\" masks to LC_ALL=\u0000\u0000 and
 * still prefixes its command, but a quoted name is an argument, never an assignment. */
const isLeadingAssignment = (text: string): boolean => ASSIGNMENT_WORD.test(text.split("\u0000")[0]!);

/** How a bash-run CLI query or explore can be credited at completion, decided by the position
 * bash runs the invocation in:
 * - "always": an unconditional command position - the command's start, or after ;, &, |, (,
 *   ), or a newline. The bash call completing is itself the evidence the invocation ran, so
 *   any result, failure included, credits.
 * - "on-success": the final command of an && list - the one conditional position whose
 *   overall success (a non-error result) proves execution reached the invocation, because a
 *   guard that failed would have left its own failure as the result instead. A subshell's
 *   last command holds the position whenever the subshell ends the list: its status passes
 *   through the closing parenthesis as the status the call reports. A `!` negation over the
 *   invocation's pipeline inverts that reported status, so the position never credits then:
 *   a success is exactly what a skipped or failed invocation produces too.
 * - "never": every other conditional position - after || (a satisfied left side skips the
 *   invocation yet still exits 0), or guarded with commands following (their status, not the
 *   invocation's, becomes the result). Nothing observable separates a skipped invocation from
 *   a failed one, so none credits. */
type CliQueryCredit = "always" | "on-success" | "never";

/** Whether the rest of a command string after an unquoted newline or closing parenthesis
 * holds no executable command: every remaining line is blank or a whole-line comment. A
 * comment runs from its word-start # to its own newline, so a command on any later line
 * still executes and only the full scan, not the first comment line, can declare the rest
 * inert. No open quote can hide inside the scan either: a comment line never opens one, so
 * the first non-comment line starts a real command whenever one follows. */
function restIsInert(rest: string): boolean {
	for (const line of rest.split("\n")) {
		const stripped = line.replace(/^[ \t\r]*/, "");
		if (stripped !== "" && !stripped.startsWith("#")) return false;
	}
	return true;
}

/**
 * The quote-aware command analysis behind the CLI query workflow AGENTS.md credits: whether a
 * bash command string runs `codegraph query` or `codegraph explore` in an executable command
 * position, and how a completion can prove the invocation ran. Quoted text is masked to
 * filler first, so a separator or command word inside quotes - printf '%s\n' 'note;
 * codegraph query' - is never an execution. At each command position the shell's pipeline
 * negation is consumed first: bash reads a leading `!` ahead of the simple command's
 * assignments, so `! codegraph query lease` runs the query and only inverts the status the
 * call reports - which is why a negated on-success position never credits - while
 * `LC_ALL=C ! codegraph query lease` runs a command named `!` and no query at all. Leading
 * NAME=VALUE assignments are skipped next (only the NAME= prefix must be unquoted, so a
 * quoted value is still an assignment), and then the shell's `command` wrapper (command
 * codegraph query ... runs it, while its lookup form command -v codegraph never credits).
 * Init, status, and every other subcommand never match
 * for credit, though runsCodegraph still reports them: every native `codegraph` invocation is
 * an active graph execution, while only query and explore can credit. A top-level `exit`
 * ends the shell before any later position is reached - a subshell's or a forked pipeline
 * piece's exit does not - so nothing after it credits. A separator list (&&,
 * ||) guarding the invocation shrinks the credit to what its position
 * can prove, per {@link CliQueryCredit}.
 */
function analyzeCliQuery(command: string): { present: boolean; credit: CliQueryCredit; runsCodegraph: boolean } {
	const masked = maskQuotedCommandText(command);
	let present = false;
	let credit: CliQueryCredit = "never";
	let runsCodegraph = false;
	const words: Array<{ text: string; quoted: boolean }> = [];
	let word = "";
	// The condition of the AND-OR list the next command runs under: "none" at the start or
	// after an unconditional separator, "and"/"or" after && / ||. A pipeline piece or a
	// subshell boundary keeps the surrounding list's condition - the group runs exactly when
	// the list reached it.
	let listCondition: "none" | "and" | "or" = "none";
	// The list conditions of the subshells the current position is nested in, outermost
	// first: a subshell runs exactly when the enclosing list reached it, so every command
	// inside stays under the outer guards while its own list's condition is tracked separately.
	// Each frame also holds the negation over the pipeline the subshell itself is a stage of
	// (`!` inverts the status the closing parenthesis reports, and inside the subshell that
	// inversion rides every position whose credit depends on that status), and whether the
	// outer shell had already exited when the subshell opened: exit inside a subshell ends
	// only the subshell, so the flag restores at the closing parenthesis.
	const subshellGuards: Array<{ condition: "none" | "and" | "or"; negated: boolean; exited: boolean }> = [];
	// Whether a `!` reserved word negates the current pipeline: negation binds to that pipeline
	// alone, so a separator, an &&, an ||, or a new subshell starts an unnegated one, while
	// repeating the word toggles it as the shell's own double negation does.
	let pipelineNegated = false;
	// Whether the AND-OR list's operator is still waiting for its right-hand command: a
	// newline - blank or comment lines included - between an && or || and the command it
	// guards continues the same list, so the guard survives those lines untouched and only a
	// newline after the list's completed command ends it.
	let pendingOperand = false;
	// Whether the shell already left through a top-level `exit`, and whether the simple
	// command just credited was such an exit: nothing after it is ever reached, so no later
	// position can be credited from the call's result. A pipeline (`|`, `|&`) or background
	// (`&`) separator runs its piece in a forked shell, whose exit cannot end this one.
	let shellExited = false;
	let segmentExitsShell = false;
	const endWord = () => {
		if (word === "") return;
		words.push({ text: word, quoted: word.includes("\u0000") });
		// Every finished word is a real token - a wholly quoted one included, because the mask
		// keeps its span a word - so a pending operator has found the operand it guards and
		// later newlines end completed lists. Comment text and here-document bodies never reach
		// here: they are masked as no word at all.
		pendingOperand = false;
		word = "";
		// A `!` still in the pipeline's leading position is the negation reserved word, never a
		// command: a quoted `!` or one after the executable is an ordinary argument.
		if (words.every((one) => !one.quoted && one.text === "!")) pipelineNegated = !pipelineNegated;
	};
	const isListOperator = (ch: string) => ch === ";" || ch === "&" || ch === "|";
	/** Whether the words of one finished simple command put codegraph query or explore in the
	 * executable position, and what the list condition can prove about execution reaching it. */
	const creditSegment = (isFinal: boolean) => {
		if (words.length === 0) return;
		let at = 0;
		// `!` is a reserved word, never the executable: `! codegraph query lease` runs the query
		// and only inverts the status the call reports. Bash reads the pipeline negation ahead of
		// the simple command's assignments, so a `!` behind one is an ordinary command word -
		// `LC_ALL=C ! codegraph query lease` runs `!`, not CodeGraph.
		while (at < words.length && !words[at]!.quoted && words[at]!.text === "!") at++;
		while (at < words.length && isLeadingAssignment(words[at]!.text)) at++;
		if (at < words.length && !words[at]!.quoted && words[at]!.text === "command") at++;
		const executable = words[at];
		const subcommand = words[at + 1];
		// A top-level exit ends the shell itself; the separator that follows this segment
		// decides whether it really does, because a pipeline or background piece runs forked.
		// An exit a condition guards may never run at all - `false && exit 0` skips it - so
		// only an unconditional one can prove nothing after it is reached.
		segmentExitsShell = executable !== undefined && !executable.quoted && executable.text === "exit" && subshellGuards.length === 0 && listCondition === "none";
		if (executable !== undefined && !executable.quoted && executable.text === "codegraph") runsCodegraph = true;
		if (
			executable !== undefined && !executable.quoted && executable.text === "codegraph" &&
			subcommand !== undefined && !subcommand.quoted && (subcommand.text === "query" || subcommand.text === "explore")
		) {
			present = true;
			let reach: CliQueryCredit;
			if (listCondition === "or" || subshellGuards.some((guard) => guard.condition === "or")) {
				reach = "never";
			} else if (subshellGuards.some((guard) => guard.condition === "and")) {
				// The invocation sits inside a subshell an outer && guards: only the whole call's
				// success can prove the guard let the subshell run, and only when this command is
				// the final one whose status the call reports.
				reach = isFinal ? "on-success" : "never";
			} else {
				reach = listCondition === "none" ? "always" : listCondition === "and" && isFinal ? "on-success" : "never";
			}
			// A `!` over the invocation's pipeline - the enclosing subshell's own pipeline, or the
			// one this command ends - inverts the reported status, so success no longer proves the
			// invocation ran: only positions that never depend on the status keep their credit.
			if (reach === "on-success" && (pipelineNegated || subshellGuards.some((guard) => guard.negated))) reach = "never";
			// A shell that already left through a top-level exit runs nothing after it, so no
			// result can prove this invocation was reached, whatever its position deserves.
			if (shellExited) reach = "never";
			if (reach === "always" || (reach === "on-success" && credit === "never")) credit = reach;
		}
		words.length = 0;
	};
	for (let i = 0; i < masked.length; i++) {
		const ch = masked[i]!;
		if (ch === MASKED_NON_WORD) {
			// Comment text and here-document bodies carry no command word: they neither extend
			// the word being read nor complete a pending operand.
			continue;
		}
		if (ch === "\u0000") {
			word += ch;
		} else if (ch === " " || ch === "\t" || ch === "\r") {
			endWord();
		} else if (isListOperator(ch)) {
			endWord();
			creditSegment(false);
			let operators = ch;
			i++;
			// A newline right after an operator wraps the same list; it never starts a new one.
			while (i < masked.length && (isListOperator(masked[i]!) || masked[i] === "\n")) {
				operators += masked[i]!;
				i++;
			}
			i--;
			operators = operators.replaceAll("\n", "");
			// A pipeline separator keeps the current pipeline alive, negation included; every
			// other separator starts a new one, whose `!` is its own.
			if (operators !== "|" && operators !== "|&") pipelineNegated = false;
			if (operators === "&&") listCondition = "and";
			else if (operators === "||") listCondition = "or";
			else if (operators !== "|" && operators !== "|&") {
				// Only the unconditional separators end the list; a pipeline separator keeps the
				// enclosing list's condition, because every stage of a pipeline runs exactly when
				// the list reached the pipeline.
				listCondition = "none";
			}
			if (operators === "&&" || operators === "||") pendingOperand = true;
			// The separator after an exit segment decides what that exit ends: a pipeline or
			// background piece runs forked, so its exit cannot end this shell.
			if (segmentExitsShell && operators !== "|" && operators !== "|&" && operators !== "&") shellExited = true;
			segmentExitsShell = false;
		} else if (ch === "\n") {
			// A newline with nothing executable after it - only blank or comment lines through
			// the end of the string, on however many lines follow - is the string's terminator,
			// not a separator before another command: a comment ends at its own newline, so any
			// command after it still runs, and only the full remaining scan can leave the
			// command before the newline the final one. Breaking leaves any pending word for
			// the loop's final flush, which credits the final command position.
			if (restIsInert(command.slice(i + 1))) break;
			endWord();
			creditSegment(false);
			if (segmentExitsShell) shellExited = true;
			segmentExitsShell = false;
			// A newline between a pending && or || and the command it guards - across blank or
			// comment lines - continues the same list, because no completed command has ended it
			// yet; every other newline ends the list and starts a fresh pipeline.
			if (!pendingOperand) {
				listCondition = "none";
				// A newline starts another pipeline, exactly as an unconditional separator does: the
				// `!` in front of the pipeline before it never inverts this one.
				pipelineNegated = false;
			}
		} else if (ch === "(" || ch === ")") {
			endWord();
			// The words pending at a closing parenthesis are the subshell's last command, and
			// when nothing executable follows the parenthesis either, that command's status is
			// the one the whole call reports: the flush keeps terminal-command status instead
			// of demoting the invocation to a non-final position.
			creditSegment(ch === ")" && restIsInert(command.slice(i + 1)));
			if (ch === "(") {
				// The subshell is a stage of the pipeline being negated, if it is: the frame carries
				// that inversion into every position inside, and the subshell's own list starts clean.
				subshellGuards.push({ condition: listCondition, negated: pipelineNegated, exited: shellExited });
				listCondition = "none";
				pipelineNegated = false;
				shellExited = false;
			} else {
				const enclosing = subshellGuards.pop();
				listCondition = enclosing?.condition ?? "none";
				pipelineNegated = enclosing?.negated ?? false;
				shellExited = enclosing?.exited ?? false;
			}
			segmentExitsShell = false;
		} else {
			word += ch;
		}
	}
	endWord();
	creditSegment(true);
	return { present, credit, runsCodegraph };
}

/** The workspace-search tool names whose executable command position marks a bash command
 * as a workspace search. */
const SEARCH_COMMANDS = new Set(["rg", "grep", "fd", "find", "ag", "ack"]);

/**
 * Whether a bash command string runs a workspace-search tool - rg, grep, fd, find, ag or
 * ack - as the executable of any of its commands: a search name that appears only in quoted
 * output text (`printf '%s\n' 'find'`) or in a comment names nothing the shell runs, while a
 * plain or assignment-prefixed `find lib` does. The same masking and word walk the CLI query
 * analysis uses decide command position - a leading `!` is the pipeline negation reserved
 * word rather than the executable, while a `!` behind an assignment is a command word that
 * runs no search - so batch admission and execution-start tracking answer from one shared
 * check.
 */
function bashRunsSearchCommand(command: string): boolean {
	const masked = maskQuotedCommandText(command);
	let runs = false;
	const words: Array<{ text: string; quoted: boolean }> = [];
	let word = "";
	const endWord = () => {
		if (word !== "") words.push({ text: word, quoted: word.includes("\u0000") });
		word = "";
	};
	/** Whether one finished simple command puts a search tool in the executable position. */
	const checkSegment = () => {
		if (words.length === 0) return;
		let at = 0;
		// `!` leads the pipeline ahead of the simple command's assignments, exactly as the CLI
		// walker reads it: `! rg lease lib` runs rg, while `LC_ALL=C ! rg lease lib` runs a
		// command named ! and no search at all.
		while (at < words.length && !words[at]!.quoted && words[at]!.text === "!") at++;
		while (at < words.length && isLeadingAssignment(words[at]!.text)) at++;
		if (at < words.length && !words[at]!.quoted && words[at]!.text === "command") at++;
		const executable = words[at];
		if (executable !== undefined && !executable.quoted && SEARCH_COMMANDS.has(executable.text)) runs = true;
		words.length = 0;
	};
	for (let i = 0; i < masked.length; i++) {
		const ch = masked[i]!;
		if (ch === MASKED_NON_WORD) {
			// Comment text and here-document bodies carry no command word.
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			// A blank ends a word, not the simple command: the negation and assignment prefixes
			// ahead of the executable are judgeable only once a separator - or the string's end
			// - finishes the whole command.
			endWord();
		} else if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
			endWord();
			checkSegment();
		} else {
			word += ch;
		}
	}
	endWord();
	checkSegment();
	return runs;
}

/**
 * Whether the Memory ordering gate applies to the workspace a memory read runs in: only a
 * workspace that actually has a codegraph index pays the rule, so an unindexed project's memory
 * reads pass with zero graph involvement — the presence probe is a filesystem stat of
 * .codegraph/codegraph.db, never a codegraph call, so machines without the CLI are never blocked
 * either. GENTLE_CODEGRAPH_MEMORY_GATE wins both ways: "1" forces the gate on without an index,
 * "0" turns it off with one; any other value defers to the index. The probe re-runs per call, so
 * an index created mid-session starts gating at the next read. Any error — or a host ctx without
 * a cwd — fails open like every guard here: the gate can never break a tool call.
 */
function gateApplies(cwd: unknown): boolean {
	const override = process.env[MEMORY_GATE_OVERRIDE];
	if (override === "1") return true;
	if (override === "0") return false;
	try {
		return typeof cwd === "string" && indexState(cwd) === "present";
	} catch {
		return false;
	}
}

/** How pi's Bash tool reports a timeout: it throws the command's output followed by this
 * status line, so the thrown error's message carries the marker the tool itself produces. */
const BASH_TIMEOUT_REPORT = /Command timed out after [\d.]+ seconds/;

/** Whether a bash tool result proves the shell was attempted - it ran, or it started and was
 * killed. The built-in Bash tool reports the spawned shell's exit status as
 * structuredContent.exit_code, nonzero exits included, so a number there is direct proof. A
 * result without it is a call the tool failed by throwing, and only one of those proves a
 * shell had already spawned: the tool's own timeout report, because pi validates its input
 * before spawning anything and reports a timeout only for a shell it started. Every other
 * thrown error - a rejected timeout, a missing working directory, an abort - may have failed
 * before the shell existed, so it proves no attempt. */
function bashResultProvesAttempt(event: unknown): boolean {
	const structured = (event as { structuredContent?: unknown } | undefined | null)?.structuredContent;
	if (typeof (structured as { exit_code?: unknown } | undefined | null)?.exit_code === "number") return true;
	const content = (event as { content?: unknown } | undefined | null)?.content;
	if (!Array.isArray(content)) return false;
	return content.some((block) => {
		const text = (block as { type?: unknown; text?: unknown } | null | undefined)?.text;
		return typeof text === "string" && BASH_TIMEOUT_REPORT.test(text);
	});
}

/**
 * Per-prompt codegraph-first gate (AGENTS.md Memory ordering), scoped to workspace-search
 * prompts: persistent-memory reads (mem_context, mem_search, mem_get_observation) are blocked
 * once the prompt has searched the workspace — a grep, find or ls tool call, or a bash
 * command running rg, grep, fd, find, ag or ack in an executable command position, either
 * confirmed by its own post-execution result — until a
 * codegraph query or explore has
 * finalized in the same user prompt; a graph execution in flight blocks memory reads
 * regardless, so a read never interleaves a live graph call. The CLI query workflow (a
 * bash-run codegraph query or explore) counts as that query or explore, start to end: quoted
 * command text is data, never an execution, while leading shell assignments and the shell's
 * command wrapper still identify the executable, and an invocation whose guard kept execution
 * from reaching it credits nothing. The gate is also batch-aware: an assistant turn whose
 * tool batch mixes a memory read with a native codegraph call - a query, an explore, an
 * init, any operation - never admits the memory read,
 * whichever position lists it — a batch's admitted calls run concurrently, so order inside it
 * cannot satisfy the rule — and a batch that mixes the read with a workspace search is
 * refused the same way until credit settles, because admission precedes every execution. A
 * memory-only prompt — no workspace search, no graph execution in flight or in the turn's
 * own batch — is never gated: its memory reads pass with zero graph involvement. The
 * requested operation is tracked from the call's start — an init completion never credits.
 * Credit is post-execution only: it is granted solely by the tool_result hook, which fires
 * only for calls Pi really executed — start and end events alone never credit, because Pi
 * also emits those for calls it fails without executing — and an executed query or explore
 * counts however it ended, failure included. Prompt-level search activity is confirmed the
 * same way, and a bash-run CLI query or search additionally needs the Bash result's
 * structuredContent.exit_code — the evidence a shell actually spawned — unless the result
 * carries the tool's own timeout report, which only a shell it had already started can
 * produce, so a timed-out foreground attempt still credits while a tool error thrown before
 * any shell ran proves no attempt. Like the prompt's search-activity marker, credit
 * expires with every new user prompt, whether that prompt
 * starts a run or is delivered as steering or a queued follow-up inside a running loop;
 * credit applies only to a fully settled window:
 * while any graph execution is still active, or when a new graph call starts after credit
 * was granted, memory reads stay blocked. The gate is scoped: it applies only to workspaces
 * that have a codegraph index — a filesystem probe of the database file, never a CLI call —
 * with GENTLE_CODEGRAPH_MEMORY_GATE=1 forcing it on and =0 off, so an unindexed workspace's
 * memory reads pass with no graph involvement at all. The guard is total: any internal
 * error allows the call, so the gate can never break a tool call. *
 * Wired through pi's extension-directory discovery (discoverAndLoadExtensions over
 * extensions/); no manifest entry is needed — the runtime-harness EXTENSIONS list is
 * banner-test-specific, not a wiring manifest.
 */
export default function codegraphFirstGate(pi: ExtensionAPI): void {
	// Credit lives in this activation only and expires with every user prompt.
	let credited = false;
	// Whether this prompt has searched the workspace: a grep, find or ls tool call, or a bash
	// command running a search tool in an executable command position, confirmed by its
	// post-execution result. The gate bites memory reads only in such prompts.
	let searchActivity = false;
	// The graph executions that started but have not finalized: one call's completion must not
	// credit the prompt while a sibling call is still running, and a graph call that starts after
	// credit was granted re-opens the window until it finalizes.
	const activeGraphExecutions = new Set<string>();
	// The query/explore executions pending their post-execution confirmation, by call id: the
	// result and end events carry no arguments, so the requested operation, the credit its
	// command position can prove, and whether a bash call sourced it (a bash-sourced result
	// must also prove the shell was attempted) are recorded here when the call starts.
	const queryExploreExecutions = new Map<string, { credit: CliQueryCredit; fromBash: boolean }>();
	// The search calls that started but have not been confirmed attempted, by call id: Pi also
	// emits start (and end) events for calls a truncated response failed without running, so
	// the prompt-level search marker waits for the post-execution result only an attempted
	// call produces. A bash-carried search also needs that result to prove a shell was
	// attempted at all, which is why its surface is recorded here when the call starts.
	const pendingSearchExecutions = new Map<string, { fromBash: boolean }>();
	// Whether the current assistant turn's tool batch mixes a persistent-memory read with a
	// native codegraph call on any surface and operation: such a batch's memory reads are
	// refused at admission, because Pi
	// runs a batch's admitted calls concurrently — order inside the batch cannot satisfy the
	// codegraph-first rule.
	let batchMixesMemoryWithGraph = false;
	// Whether that same batch instead mixes the read with a workspace search: Pi admits a
	// batch's calls before running any of them, so the search cannot arm the gate in time and
	// the batch composition itself must refuse the read until credit settles.
	let batchMixesMemoryWithSearch = false;
	/** codegraph tool calls count for the window: the session tool and the MCP proxy surface. */
	const isGraphToolName = (toolName: unknown): boolean =>
		toolName === "codegraph" || (typeof toolName === "string" && toolName.startsWith("mcp__codegraph__"));
	/** Whether a graph tool call requested a query or an explore: the session tool reports the
	 * operation in its args; the MCP proxy surface encodes it in the tool name. Anything else —
	 * init, a malformed or hostile payload — never credits. */
	const isQueryOrExplore = (toolName: unknown, args: unknown): boolean => {
		if (toolName === "codegraph") {
			const operation = (args as { operation?: unknown } | undefined | null)?.operation;
			return operation === "query" || operation === "explore";
		}
		return typeof toolName === "string" && (toolName.endsWith("_query") || toolName.endsWith("_explore"));
	};
	/** Whether one assistant tool-call block is an active graph execution on any surface -
	 * the same call set the execution-start handler treats as active: the session tool and
	 * the MCP proxy surface whatever the operation (init included), and the bash-run CLI
	 * whatever the subcommand. An unrelated *_query tool is not one, and only query and
	 * explore earn credit - batch mixing tracks every native call because the read may not
	 * run beside any of them. */
	const isGraphExecutionCall = (name: unknown, args: unknown): boolean => {
		if (typeof name !== "string") return false;
		if (isGraphToolName(name)) return true;
		const command = (args as { command?: unknown } | undefined | null)?.command;
		return name === "bash" && typeof command === "string" && analyzeCliQuery(command).runsCodegraph;
	};

	/** Whether one assistant tool-call block is a workspace search: a grep, find or ls tool
	 * call, or a bash command running a search tool in an executable command position — the
	 * same shared check whose post-execution result arms the gate, read here from the batch
	 * before Pi runs any of its calls. */
	const isWorkspaceSearchCall = (name: unknown, args: unknown): boolean => {
		if (name === "grep" || name === "find" || name === "ls") return true;
		const command = (args as { command?: unknown } | undefined | null)?.command;
		return name === "bash" && typeof command === "string" && bashRunsSearchCommand(command);
	};

	/** The whole tool batch of one assistant turn, read from the turn's own message: Pi
	 * prepares and executes the batch's calls only after that message ends, so the batch
	 * composition is known before any tool_call admission. A batch that mixes a memory read
	 * with a native codegraph call can never satisfy the ordering rule — its calls run concurrently —
	 * so the answer marks every memory read of that turn refused, whichever position lists
	 * them. A batch that mixes the read with a workspace search is marked the same way,
	 * because admission runs before any of the batch's calls could arm the gate itself. */
	function scanAssistantBatch(message: unknown): void {
		batchMixesMemoryWithGraph = false;
		batchMixesMemoryWithSearch = false;
		const content = (message as { content?: unknown } | undefined | null)?.content;
		if (!Array.isArray(content)) return;
		let memory = false;
		let graph = false;
		let search = false;
		for (const block of content) {
			const call = block as { type?: unknown; name?: unknown; arguments?: unknown } | undefined | null;
			if (call?.type !== "toolCall" || typeof call.name !== "string") continue;
			if (MEMORY_READ_TOOLS.has(call.name)) memory = true;
			else if (isGraphExecutionCall(call.name, call.arguments)) graph = true;
			else if (isWorkspaceSearchCall(call.name, call.arguments)) search = true;
		}
		batchMixesMemoryWithGraph = memory && graph;
		batchMixesMemoryWithSearch = memory && search;
	}

	// A new user prompt starts the Memory ordering window over: codegraph must come first again.
	// before_agent_start fires once per primary request (a user prompt or sendUserMessage),
	// not per LLM turn, so credit earned in one turn of a request survives into its later turns.
	pi.on?.("before_agent_start", () => {
		credited = false;
		searchActivity = false;
		batchMixesMemoryWithGraph = false;
		batchMixesMemoryWithSearch = false;
		activeGraphExecutions.clear();
		queryExploreExecutions.clear();
		pendingSearchExecutions.clear();
	});

	// A delivered user message starts the window over on its own: Pi (1.2.0+, which the manifest
	// permits) consumes steering and queued follow-up messages inside the running agent loop
	// without another before_agent_start, so the reset must ride the delivery event too.
	// The search-activity marker resets with the credit, so a memory-only follow-up such as
	// "now summarize what changed" is not gated by the searched prompt that came before it.
	// message_end fires for every message; a user role resets, and an assistant turn instead
	// reports its own tool batch (mixed or not) for the batch-aware admission; tool-result and
	// custom deliveries never expire credit.
	pi.on?.("message_end", (event) => {
		try {
			const role = (event as { message?: { role?: unknown } | undefined | null } | undefined | null)?.message?.role;
			if (role === "user") {
				credited = false;
				searchActivity = false;
				batchMixesMemoryWithGraph = false;
				batchMixesMemoryWithSearch = false;
				activeGraphExecutions.clear();
				queryExploreExecutions.clear();
				pendingSearchExecutions.clear();
			} else if (role === "assistant") {
				// The turn's whole tool batch is visible here, before Pi prepares its calls: mark
				// whether it mixes memory reads with graph queries or workspace searches so
				// admission can check the batch.
				scanAssistantBatch((event as { message?: unknown } | undefined | null)?.message);
			}
		} catch {
			/* a hostile payload must never break the host */
		}
	});

	// Start-of-execution: the graph call is now active, so no memory read may pass the gate
	// until its matching end event finalizes it (keyed by toolCallId; nested calls carry their
	// own ids too). A query or explore is also recorded as credit-worthy — the end event
	// carries no arguments, so the requested operation is captured here, hostile payload or not.
	pi.on?.("tool_execution_start", (event) => {
		try {
			const toolName = (event as { toolName?: unknown } | undefined | null)?.toolName;
			const toolCallId = (event as { toolCallId?: unknown } | undefined | null)?.toolCallId;
			if (isGraphToolName(toolName) && typeof toolCallId === "string") {
				activeGraphExecutions.add(toolCallId);
				if (isQueryOrExplore(toolName, (event as { args?: unknown }).args)) queryExploreExecutions.set(toolCallId, { credit: "always", fromBash: false });
			}
			// A search tool or search-shaped bash command is recorded as a pending search: the
			// prompt-level marker is armed only by the call's post-execution result, because Pi
			// also emits start events for calls it never executes; a hostile or malformed payload
			// never throws.
			if (toolName === "grep" || toolName === "find" || toolName === "ls") {
				if (typeof toolCallId === "string") pendingSearchExecutions.set(toolCallId, { fromBash: false });
			} else if (toolName === "bash") {
				const command = ((event as { args?: { command?: unknown } | undefined | null } | undefined | null)?.args)?.command;
				if (typeof command === "string") {
					if (typeof toolCallId === "string") {
						if (bashRunsSearchCommand(command)) pendingSearchExecutions.set(toolCallId, { fromBash: true });
						// A CLI query or explore through bash is the graph execution AGENTS.md credits for
						// worktree dispatches: active from its start, credited only in the command
						// positions whose completion can prove execution reached the invocation, and
						// never for init, status, or another subcommand.
						const analysis = analyzeCliQuery(command);
						// A native codegraph CLI invocation is a graph execution from its start,
						// whatever the subcommand - init and status included; credit still attaches
						// only to a query or explore in the command positions whose completion can
						// prove execution reached the invocation.
						if (analysis.runsCodegraph) activeGraphExecutions.add(toolCallId);
						if (analysis.present && analysis.credit !== "never") queryExploreExecutions.set(toolCallId, { credit: analysis.credit, fromBash: true });
					}
				}
			}
		} catch {
			/* a hostile payload must never break the host */
		}
	});

	// End-of-execution closes liveness only: a payload hostile to one field must not void the
	// other. Granting no credit here is the point — Pi emits this event for calls it never
	// executed too (an assistant response truncated at the output limit has its calls failed
	// without running), so the credit itself waits for the post-execution tool_result
	// confirmation of a call that already ran; an executed call is always credited by then.
	pi.on?.("tool_execution_end", (event) => {
		try {
			const toolCallId = (event as { toolCallId?: unknown } | undefined | null)?.toolCallId;
			if (typeof toolCallId === "string") {
				activeGraphExecutions.delete(toolCallId);
				queryExploreExecutions.delete(toolCallId);
				pendingSearchExecutions.delete(toolCallId);
			}
		} catch {
			/* a hostile payload must never break the host */
		}
	});

	// Post-execution confirmation is the only place credit is granted: the tool_result hook
	// fires solely after a call really executed — a query or explore that ran and errored still
	// credits, because a failed attempt counts — while start and end events alone never do. A
	// bash-run CLI query guarded by an && list additionally needs the list's overall success:
	// an error result is exactly what a skipped invocation and a failed one share, so only the
	// non-error result proves execution reached the query. A bash-run query of any shape also
	// needs the result's structuredContent.exit_code, the evidence a shell spawned at all, and
	// the same event is what confirms a listed search ran, arming the prompt-level marker.
	pi.on?.("tool_result", (event) => {
		try {
			const toolCallId = (event as { toolCallId?: unknown } | undefined | null)?.toolCallId;
			if (typeof toolCallId !== "string") return;
			const pending = queryExploreExecutions.get(toolCallId);
			if (pending !== undefined) {
				queryExploreExecutions.delete(toolCallId);
				// A bash-run query additionally needs the result to prove a shell ran it: the
				// built-in Bash tool reports the spawned shell's exit status as
				// structuredContent.exit_code, while input the tool rejects before spawning errors
				// with no such content - no shell, no attempted query. Nonzero exits carry it too,
				// so a foreground attempt the analysis proves was reached still credits, failure
				// included.
				const ranShell = !pending.fromBash || bashResultProvesAttempt(event);
				if (ranShell && !(pending.credit === "on-success" && (event as { isError?: unknown }).isError === true)) credited = true;
			}
			// The post-execution result is also the only confirmation a listed search was really
			// attempted: it, not the start event, arms the prompt-level search marker, and a
			// bash-carried search needs it to prove a shell was attempted at all. The separate
			// batch check still covers reads admitted beside a sibling search before either
			// call runs.
			const pendingSearch = pendingSearchExecutions.get(toolCallId);
			if (pendingSearch !== undefined) {
				pendingSearchExecutions.delete(toolCallId);
				if (!pendingSearch.fromBash || bashResultProvesAttempt(event)) searchActivity = true;
			}
		} catch {
			/* a hostile payload must never break the host */
		}
	});

	// The gate itself: in a workspace the gate applies to, block persistent-memory reads while
	// a graph execution is still active, when the turn's own batch mixes the read with a graph
	// query or explore, and — once the prompt has searched the workspace, or while a batch of
	// its searches is being admitted — until the codegraph-first window is credited; every
	// guard failure (throwing payload, malformed toolName, missing workspace) allows the call
	// rather than breaking it.
	pi.on?.("tool_call", (event, ctx) => {
		try {
			const toolName = (event as { toolName?: unknown } | undefined | null)?.toolName;
			const cwd = (ctx as { cwd?: unknown } | undefined | null)?.cwd;
			if (typeof toolName === "string" && MEMORY_READ_TOOLS.has(toolName) && gateApplies(cwd) && (activeGraphExecutions.size > 0 || batchMixesMemoryWithGraph || ((batchMixesMemoryWithSearch || searchActivity) && !credited))) {
				return { block: true, reason: BLOCK_REASON };
			}
			return undefined;
		} catch {
			return undefined;
		}
	});
}
