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
 * Replaces every quoted span, escape, and comment of a bash command string with a neutral
 * filler character (NUL): quoted text, escapes, and comments are data, never syntax, so no
 * separator, operator, or command word inside them can be read as an execution. Length and
 * every unquoted character's position are preserved, so the command's structure outside
 * quotes stays exactly where it was. A comment starts at an unquoted word-start # and runs
 * to the end of its line.
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
			masked += filler;
			while (i + 1 < command.length && command[i + 1] !== "\n") {
				i++;
				masked += filler;
			}
			wordStart = true;
		} else {
			masked += ch;
			wordStart = isWordBreak(ch);
		}
	}
	return masked;
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
 *   guard that failed would have left its own failure as the result instead.
 * - "never": every other conditional position - after || (a satisfied left side skips the
 *   invocation yet still exits 0), or guarded with commands following (their status, not the
 *   invocation's, becomes the result). Nothing observable separates a skipped invocation from
 *   a failed one, so none credits. */
type CliQueryCredit = "always" | "on-success" | "never";

/**
 * The quote-aware command analysis behind the CLI query workflow AGENTS.md credits: whether a
 * bash command string runs `codegraph query` or `codegraph explore` in an executable command
 * position, and how a completion can prove the invocation ran. Quoted text is masked to
 * filler first, so a separator or command word inside quotes - printf '%s\n' 'note;
 * codegraph query' - is never an execution. At each command position, leading NAME=VALUE
 * assignments are skipped (LC_ALL=C codegraph query ... runs the query, and so does a
 * quoted value - LC_ALL=\"C\" - because only the NAME= prefix must be unquoted), and so is
 * the shell's `command` wrapper (command codegraph query ... runs it, while its lookup form
 * command -v codegraph never credits); init, status, and every other subcommand never match
 * for credit, though runsCodegraph still reports them: every native `codegraph` invocation is
 * an active graph execution, while only query and explore can credit. A separator list (&&,
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
	const subshellGuards: Array<"none" | "and" | "or"> = [];
	const endWord = () => {
		if (word !== "") words.push({ text: word, quoted: word.includes("\u0000") });
		word = "";
	};
	const isListOperator = (ch: string) => ch === ";" || ch === "&" || ch === "|";
	/** Whether the words of one finished simple command put codegraph query or explore in the
	 * executable position, and what the list condition can prove about execution reaching it. */
	const creditSegment = (isFinal: boolean) => {
		if (words.length === 0) return;
		let at = 0;
		while (at < words.length && isLeadingAssignment(words[at]!.text)) at++;
		if (at < words.length && !words[at]!.quoted && words[at]!.text === "command") at++;
		const executable = words[at];
		const subcommand = words[at + 1];
		if (executable !== undefined && !executable.quoted && executable.text === "codegraph") runsCodegraph = true;
		if (
			executable !== undefined && !executable.quoted && executable.text === "codegraph" &&
			subcommand !== undefined && !subcommand.quoted && (subcommand.text === "query" || subcommand.text === "explore")
		) {
			present = true;
			let reach: CliQueryCredit;
			if (listCondition === "or" || subshellGuards.includes("or")) {
				reach = "never";
			} else if (subshellGuards.includes("and")) {
				// The invocation sits inside a subshell an outer && guards: only the whole call's
				// success can prove the guard let the subshell run, and only when this command is
				// the final one whose status the call reports.
				reach = isFinal ? "on-success" : "never";
			} else {
				reach = listCondition === "none" ? "always" : listCondition === "and" && isFinal ? "on-success" : "never";
			}
			if (reach === "always" || (reach === "on-success" && credit === "never")) credit = reach;
		}
		words.length = 0;
	};
	for (let i = 0; i < masked.length; i++) {
		const ch = masked[i]!;
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
			if (operators === "&&") listCondition = "and";
			else if (operators === "||") listCondition = "or";
			else if (operators !== "|" && operators !== "|&") {
				// Only the unconditional separators end the list; a pipeline separator keeps the
				// enclosing list's condition, because every stage of a pipeline runs exactly when
				// the list reached the pipeline.
				listCondition = "none";
			}
		} else if (ch === "\n") {
			// A newline with nothing executable after it - only whitespace or a comment through
			// the end of the string - is the string's terminator, not a separator before another
			// command: the command before it stays the final one. Breaking leaves any pending
			// word for the loop's final flush, which credits the final command position.
			const rest = command.slice(i + 1).replace(/^[\t \r\n]+/, "");
			if (rest === "" || rest.startsWith("#")) break;
			endWord();
			creditSegment(false);
			listCondition = "none";
		} else if (ch === "(" || ch === ")") {
			endWord();
			creditSegment(false);
			if (ch === "(") {
				subshellGuards.push(listCondition);
				listCondition = "none";
			} else {
				listCondition = subshellGuards.pop() ?? "none";
			}
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
 * analysis uses decide command position, so batch admission and execution-start tracking
 * answer from one shared check.
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
		while (at < words.length && isLeadingAssignment(words[at]!.text)) at++;
		if (at < words.length && !words[at]!.quoted && words[at]!.text === "command") at++;
		const executable = words[at];
		if (executable !== undefined && !executable.quoted && SEARCH_COMMANDS.has(executable.text)) runs = true;
		words.length = 0;
	};
	for (let i = 0; i < masked.length; i++) {
		const ch = masked[i]!;
		if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" ||
			ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
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

/**
 * Per-prompt codegraph-first gate (AGENTS.md Memory ordering), scoped to workspace-search
 * prompts: persistent-memory reads (mem_context, mem_search, mem_get_observation) are blocked
 * once the prompt has searched the workspace — a grep, find or ls tool execution, or a bash
 * command running rg, grep, fd, find, ag or ack in an executable command position — until a
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
 * counts however it ended, failure included. Like the prompt's search-activity marker, credit
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
	// Whether this prompt has searched the workspace: a grep, find or ls tool execution, or a
	// bash command running a search tool in an executable command position. The gate bites
	// memory reads only in such prompts.
	let searchActivity = false;
	// The graph executions that started but have not finalized: one call's completion must not
	// credit the prompt while a sibling call is still running, and a graph call that starts after
	// credit was granted re-opens the window until it finalizes.
	const activeGraphExecutions = new Set<string>();
	// The query/explore executions pending their post-execution confirmation, by call id: the
	// result and end events carry no arguments, so the requested operation and the credit its
	// command position can prove are recorded here when the call starts.
	const queryExploreExecutions = new Map<string, CliQueryCredit>();
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
	 * same shared check that arms the gate at execution start, read here from the batch
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
				if (isQueryOrExplore(toolName, (event as { args?: unknown }).args)) queryExploreExecutions.set(toolCallId, "always");
			}
			// A search tool or search-shaped bash command marks the prompt as a workspace search,
			// arming the gate for its memory reads; a hostile or malformed payload never throws.
			if (toolName === "grep" || toolName === "find" || toolName === "ls") {
				searchActivity = true;
			} else if (toolName === "bash") {
				const command = ((event as { args?: { command?: unknown } | undefined | null } | undefined | null)?.args)?.command;
				if (typeof command === "string") {
					if (bashRunsSearchCommand(command)) searchActivity = true;
					// A CLI query or explore through bash is the graph execution AGENTS.md credits for
					// worktree dispatches: active from its start, credited only in the command
					// positions whose completion can prove execution reached the invocation, and
					// never for init, status, or another subcommand.
					if (typeof toolCallId === "string") {
						const analysis = analyzeCliQuery(command);
						// A native codegraph CLI invocation is a graph execution from its start,
						// whatever the subcommand - init and status included; credit still attaches
						// only to a query or explore in the command positions whose completion can
						// prove execution reached the invocation.
						if (analysis.runsCodegraph) activeGraphExecutions.add(toolCallId);
						if (analysis.present && analysis.credit !== "never") queryExploreExecutions.set(toolCallId, analysis.credit);
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
	// non-error result proves execution reached the query.
	pi.on?.("tool_result", (event) => {
		try {
			const toolCallId = (event as { toolCallId?: unknown } | undefined | null)?.toolCallId;
			if (typeof toolCallId !== "string") return;
			const credit = queryExploreExecutions.get(toolCallId);
			if (credit === undefined) return;
			queryExploreExecutions.delete(toolCallId);
			if (credit === "on-success" && (event as { isError?: unknown }).isError === true) return;
			credited = true;
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
