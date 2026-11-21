import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import net from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import { canonicalRoot } from "./codegraph-canonical.ts";

/** The hello line a CodeGraph daemon sends carries `protocol`; this is the only one spoken here. */
const DAEMON_PROTOCOL = 1;
/** A daemon sends its hello line as soon as it accepts; one silent this long is hung, and the next one gets the rest of the budget. */
const DAEMON_HELLO_TIMEOUT_MS = 2_000;
/** An explore answer is tens of kilobytes; anything near this size is not one worth keeping in memory. */
export const MAX_REPLY_CHARS = 1_000_000;
/** CodeGraph answers an explore without a project with this plain text, not with an error. */
const NO_PROJECT_TEXT = "No CodeGraph project is loaded";
const PIPE_PREFIX = "\\\\.\\pipe\\";

interface RegisteredDaemon {
	root: string;
	socketPath: string;
	startedAt: number;
	pid?: number;
}

/** One query can trigger several registry scans (daemonFor, liveDaemonSockets, one per daemon attempt), so one read per project per window suffices. */
const REGISTRY_MEMO_MS = 1_000;
let registryMemo: { key: string; at: number; daemons: RegisteredDaemon[] } | undefined;

/** Tests reset the window so fixtures written between calls are seen again. */
export function resetDaemonRegistryMemo(): void {
	registryMemo = undefined;
}

/** Exported for the tests that read the registry directly; daemonFor and liveDaemonSockets call it in production. */
/** Daemons registered for `root` in any spelling, newest first. Reads the registry only; starts nothing.
 * The platform picks the fold: on win32 both spellings compare through the process-lifetime canonical memo.
 * A memoized answer is returned only while every cached record still canonicalizes to `root`: a junction
 * retargeted to another checkout without its registry file changing must stop answering for the old one.
 * An optional deadline — a query budget the socket probes share — stops the scan between records and
 * answers with what was found so far; a deadline-stopped scan is partial and is never memoized. */
export function registeredDaemons(root: string, registryDir: string = join(homedir(), ".codegraph", "daemons"), platform: NodeJS.Platform = process.platform, deadlineAt?: number): RegisteredDaemon[] {
	let files: string[];
	try {
		files = readdirSync(registryDir).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	const wanted = canonicalRoot(root, platform);
	// The listing is fresh on every call: a record that appeared or vanished changes it and busts the memo.
	const key = `${registryDir}|${wanted}|${platform}|${files.join(",")}`;
	// The memo is trusted only while its records still resolve to `root`: a junction that moved to
	// another checkout keeps its registry file name and content, so only this recheck — not the
	// key — can catch that the cached match no longer belongs to this root.
	if (registryMemo !== undefined && registryMemo.key === key && Date.now() - registryMemo.at < REGISTRY_MEMO_MS && registryMemo.daemons.every((entry) => canonicalRoot(entry.root, platform) === wanted)) {
		return registryMemo.daemons;
	}
	const found: RegisteredDaemon[] = [];
	for (const file of files) {
		// The query budget covers discovery too: once the deadline is spent no further record is
		// read or canonicalized, and the partial answer is never memoized — a later undated read
		// still scans every record.
		if (deadlineAt !== undefined && deadlineAt - Date.now() <= 0) return found;
		try {
			const entry = JSON.parse(readFileSync(join(registryDir, file), "utf8"));
			if (typeof entry.root !== "string" || typeof entry.socketPath !== "string" || canonicalRoot(entry.root, platform) !== wanted) continue;
			found.push({
				root: entry.root,
				socketPath: entry.socketPath,
				startedAt: typeof entry.startedAt === "number" ? entry.startedAt : 0,
				pid: recordPid(entry.pid),
			});
		} catch {
			/* a damaged record is not a daemon */
		}
	}
	registryMemo = { key, at: Date.now(), daemons: found };
	return found.sort((a, b) => b.startedAt - a.startedAt);
}

/** The pids a registry record may carry: a positive integer inside the range any supported platform
 * assigns. pid 0 and negative pids are process-group spellings under signal 0 — processAlive(0)
 * answers for the caller's own process group — so a record carrying one must never reach a liveness
 * check or a shutdown signal. */
const MAX_RECORD_PID = 4_194_304; // the highest pid Linux's pid_max can assign; every other platform stays below it.

function recordPid(pid: unknown): number | undefined {
	return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid <= MAX_RECORD_PID ? pid : undefined;
}

/** Whether a process with this pid exists; signal 0 only checks. EPERM means it exists under another user.
 * The one pid-liveness check: the lease module imports it for its token holders. */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** How long one connect probe may take: a daemon that is there answers or refuses fast; anything slower is not liveness. */
const PIPE_PROBE_TIMEOUT_MS = 250;
/** A probe that connected says the pipe is live for this window, so the checks inside one composite
 * operation do not reconnect every time. Nothing else is remembered: a refused or inconclusive
 * answer is probed again on the next check, because a pipe can appear at any moment. */
const PIPE_PROBE_MEMO_MS = 5_000;
const pipeProbeMemo = new Map<string, number>();

/** The outcome of one connect probe of a named pipe: open means the pipe accepted the connection,
 * refused means the pipe is not there, and anything else — a timeout, an odd error — is inconclusive. */
export type PipeProbeOutcome = "open" | "refused" | "inconclusive";

/** One liveness probe of a named pipe: connects with the socket layer ask() speaks and answers within
 * the given budget. Injectable so the tests can fake the net/socket layer. */
export type PipeProbe = (pipePath: string, timeoutMs: number) => PipeProbeOutcome;

/** The probe worker's source as plain JavaScript, so it needs no compiled file: one persistent
 * worker serves every probe by message — each message carries its own pipe path, budget, and
 * shared cell — and the connect runs on the worker's own event loop while the calling thread
 * waits on that cell for the outcome or the deadline. The first outcome lands there (1 open,
 * 2 refused, 3 anything else), and destroying the socket leaves the worker ready for the next
 * message. ECONNREFUSED and ENOENT are the no-listener spellings for a Windows pipe name; a
 * busy or protected pipe stays inconclusive. */
const PROBE_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const net = require("node:net");
parentPort.on("message", ({ pipePath, timeoutMs, state }) => {
	const report = (code) => {
		if (Atomics.compareExchange(state, 0, 0, code) !== 0) return;
		Atomics.notify(state, 0);
	};
	const socket = net.createConnection(pipePath);
	socket.once("connect", () => {
		socket.destroy();
		report(1);
	});
	socket.once("error", (error) => {
		socket.destroy();
		report(error && (error.code === "ECONNREFUSED" || error.code === "ENOENT") ? 2 : 3);
	});
	setTimeout(() => {
		socket.destroy();
		report(3);
	}, timeoutMs).unref();
});
`;

/** The process's one probe worker, built on the first probe and reused for every later one: no
 * thread spawn or terminate per check. Unref'd, so a live worker never keeps the process alive,
 * and cleared by the exit hook when it dies, so the next probe builds a fresh one. Probes are
 * single-flight — every caller of connectProbe is synchronous, so the thread is blocked inside
 * the wait — which is what makes one shared worker safe. */
let probeWorker: Worker | undefined;

function probeWorkerFor(): Worker {
	if (probeWorker === undefined) {
		const worker = new Worker(PROBE_WORKER_SOURCE, { eval: true });
		// An asynchronous worker failure — a thread that never starts, a worker-side throw — arrives
		// as an 'error' event rather than a throw from the constructor, and an unhandled one takes
		// the whole host down. The listener only keeps the event from escaping: the exit hook clears
		// the reference so the next probe builds a fresh worker, and an in-flight probe falls back
		// to its deadline inconclusive through the shared cell staying 0.
		worker.on("error", () => {});
		worker.unref();
		worker.once("exit", () => {
			if (probeWorker === worker) probeWorker = undefined;
		});
		probeWorker = worker;
	}
	return probeWorker;
}

/** One probe of the daemon's own pipe: the shared worker owns the event loop the async connect
 * needs while this thread waits on the shared cell for the outcome or the deadline, so the check
 * answers within the probe budget instead of enumerating every named pipe on the machine. A
 * worker that never starts, dies mid-probe (the cell stays 0 until the deadline), or never
 * reports is inconclusive, never absent. Exported for the real-worker tests, which assert the raw
 * outcome before socketPresent maps it; production reaches it only through pipeProbe. */
export function connectProbe(pipePath: string, timeoutMs: number): PipeProbeOutcome {
	const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
	try {
		probeWorkerFor().postMessage({ pipePath, timeoutMs, state });
		Atomics.wait(state, 0, 0, Math.max(1, timeoutMs));
	} catch {
		// A worker that cannot be built or messaged is inconclusive, never absent; dropping the
		// reference (the exit hook guards identity) makes the next probe build a fresh one.
		probeWorker = undefined;
		return "inconclusive";
	}
	const code = Atomics.load(state, 0);
	return code === 1 ? "open" : code === 2 ? "refused" : "inconclusive";
}

let pipeProbe: PipeProbe = connectProbe;

/** Tests swap in a fake net/socket layer and restore the real probe with undefined; a swap clears
 * the remembered positives so every fake starts from an empty cache, and tears down the shared
 * probe worker so a fake never shares a thread with a real one. Production never calls it. */
export function setPipeProbeForTests(probe: PipeProbe | undefined): void {
	pipeProbe = probe ?? connectProbe;
	pipeProbeMemo.clear();
	const worker = probeWorker;
	probeWorker = undefined;
	if (worker !== undefined) void worker.terminate();
}

/**
 * Whether a daemon socket is still there. Every path outside the Windows pipe namespace is a socket
 * file and keeps its filesystem check. A Windows named pipe is not a file: one short connect probe
 * of the daemon's own pipe replaces enumerating every named pipe on the machine, and a probe that
 * connected is remembered for a short window. A clean refusal — the pipe is not there — is the one
 * answer that counts as absent; every other failure still counts as present rather than risk
 * missing a live daemon, the same fail-safe the pipe listing had. A caller with a deadline — a
 * query budget that discovery also spends — bounds each probe to the leftover and skips probing
 * once it is spent.
 */
export function socketPresent(socketPath: string, platform: NodeJS.Platform = process.platform, deadlineAt?: number): boolean {
	if (platform !== "win32" || !socketPath.toLowerCase().startsWith(PIPE_PREFIX)) return existsSync(socketPath);
	const probedAt = pipeProbeMemo.get(socketPath);
	if (probedAt !== undefined && Date.now() - probedAt < PIPE_PROBE_MEMO_MS) return true;
	// The skipped or shrunken probe never turns into a false absence: inconclusive still counts as
	// present, and only a clean refusal is remembered as proof of anything.
	const budget = deadlineAt === undefined ? PIPE_PROBE_TIMEOUT_MS : Math.min(PIPE_PROBE_TIMEOUT_MS, deadlineAt - Date.now());
	const outcome: PipeProbeOutcome = budget <= 0 ? "inconclusive" : pipeProbe(socketPath, budget);
	if (outcome === "open") pipeProbeMemo.set(socketPath, Date.now());
	return outcome !== "refused";
}

export interface DaemonInfo {
	/** A daemon for this project is running (pid alive, socket present). */
	alive: boolean;
	/** How the newest registered daemon spells this project: passing this spelling keeps a warm-up on
	 * that daemon instead of starting a second one for the same project. Undefined when nothing matches. */
	root?: string;
}

/** One registry record is a live daemon when its holder still runs and its socket is still there. */
function daemonIsLive(entry: RegisteredDaemon, platform: NodeJS.Platform, deadlineAt?: number): boolean {
	return entry.pid !== undefined && processAlive(entry.pid) && socketPresent(entry.socketPath, platform, deadlineAt);
}

/** The project's daemons that are still there — pid alive, socket present — newest first. An
 * optional deadline bounds the pipe probes the presence check may spend. */
export function liveDaemons(cwd: string, registryDir?: string, platform: NodeJS.Platform = process.platform, deadlineAt?: number): RegisteredDaemon[] {
	return registeredDaemons(cwd, registryDir, platform).filter((entry) => daemonIsLive(entry, platform, deadlineAt));
}

/** The project's newest daemon from CodeGraph's own registry. Reads only; starts nothing. */
export function daemonFor(cwd: string, registryDir?: string, platform: NodeJS.Platform = process.platform, deadlineAt?: number): DaemonInfo {
	const alive = liveDaemons(cwd, registryDir, platform, deadlineAt)[0];
	return { alive: alive !== undefined, root: (alive ?? registeredDaemons(cwd, registryDir, platform)[0])?.root };
}

/** The project spelled as its daemon registered it, or the real path of `cwd` when no daemon matches:
 * the one fold every CLI invocation and warm-up uses to stay on a live daemon's spelling. */
export function projectSpelling(daemon: DaemonInfo | undefined, cwd: string): string {
	return daemon?.root ?? realpathSync(cwd);
}

/** The project's live daemon sockets, newest first, discovered one candidate at a time: each pipe
 * probe runs only when the walk reaches that candidate, so a daemon is queried before an older
 * candidate's probe can spend the shared deadline. An optional deadline bounds the registry scan
 * behind the walk and each probe it spends. */
function* liveDaemonSockets(cwd: string, registryDir: string | undefined, deadlineAt?: number): Generator<string> {
	for (const entry of registeredDaemons(cwd, registryDir, process.platform, deadlineAt)) {
		if (daemonIsLive(entry, process.platform, deadlineAt)) yield entry.socketPath;
	}
}

export type DaemonCallResult =
	| { status: "ok"; text: string }
	/** No daemon to ask, or it did not behave as expected: the caller should use another way. */
	| { status: "unavailable" }
	/** A daemon was there but did not answer in time: a second attempt would only be slower. */
	| { status: "timeout" };

/** A socket that accepted but never said hello: the next one gets the rest of the budget. */
type AskOutcome = DaemonCallResult | { status: "silent" };

/** One reply line of an MCP conversation, in the shape both conversations read it. */
export interface McpReply {
	id?: number;
	error?: unknown;
	result?: { isError?: boolean; content?: { text?: string }[] };
}

/** Parses one newline-delimited reply line; undefined when it is not JSON or not a reply object — JSON.parse
 * also returns null, numbers, strings, arrays and booleans, and reading .codegraph or .id on any of those
 * (null throws) must never reach reply dispatch. Each conversation decides what undefined means. */
export function parseMcpReply(line: string): McpReply | undefined {
	try {
		const parsed: unknown = JSON.parse(line);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return parsed as McpReply;
	} catch {
		return undefined;
	}
}

/**
 * The text of a tools/call reply, or undefined when the reply is a failure: a JSON-RPC error, an isError
 * result, a missing text, or the no-project answer CodeGraph gives instead of an error. CodeGraph reports
 * a crashed query worker with isError and a text, not with a JSON-RPC error.
 */
export function mcpCallText(message: McpReply): string | undefined {
	const text = message.result?.content?.[0]?.text;
	if (message.error !== undefined || message.result?.isError === true || typeof text !== "string" || text.startsWith(NO_PROJECT_TEXT)) return undefined;
	return text;
}

/** The MCP protocol version both conversations declare in their initialize request. */
const MCP_PROTOCOL_VERSION = "2024-11-05";

/** The initialize request every conversation opens with; the daemon socket sends it bare, the stdio
 * warm-up adds its project as rootUri (the trailing spread keeps each one's wire bytes unchanged). */
export function mcpInitializeRequest(rootUri?: string): object {
	return {
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "gentle-shell", version: "0" }, ...(rootUri === undefined ? {} : { rootUri }) },
	};
}

/** What goes out once the initialize reply arrives: the initialized notice, then the one tools/call
 * both conversations end on. */
export function mcpCallRequests(tool: string, args: Record<string, unknown>): object[] {
	return [
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } },
	];
}

/** Which request a reply answers, by the id both conversations use: initialize is 1, the tools/call answer 2. */
export type McpReplyKind = "initialize" | "call";

export function mcpReplyKind(message: McpReply): McpReplyKind | undefined {
	if (message.id === 1) return "initialize";
	if (message.id === 2) return "call";
	return undefined;
}

/**
 * The line-buffered reader both MCP conversations share: it accumulates newline-delimited chunks (Buffers
 * from a child's stdout, decoded strings from a socket), splits and trims lines, skips the empty ones, and
 * hands each parsed reply to `onReply` — undefined marks a line `parseMcpReply` rejects; each conversation
 * decides what that means. A truthy return from `onReply` stops the scan for the rest of the chunk, the
 * data handler's `return`. The chunk handler itself answers true when one frame grew past
 * `maxBufferChars` — content past it, or surrounding whitespace alone past it, the same measure for
 * a complete frame and for the unfinished remainder, so a padded reply lives or dies identically
 * whichever chunk its newline arrives in — the runaway guard the socket conversation finishes on;
 * a frame with content and padding each under the cap keeps its reply even when blank lines pad
 * out the chunk that carried it.
 */
export function mcpLineReader(onReply: (message: McpReply | undefined) => boolean | void, maxBufferChars: number = Number.POSITIVE_INFINITY): (chunk: string | Buffer) => boolean {
	let buffer = "";
	// One decoder for the whole conversation: a multibyte UTF-8 character split across Buffer chunks
	// corrupts into replacement characters under a per-chunk toString; the decoder holds the trailing
	// bytes until the next chunk completes them.
	const decoder = new StringDecoder("utf8");
	return (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		// One measure for every frame, complete or pending: content past the cap or surrounding
		// whitespace alone past it — never the two summed, so short padding stays valid — and the
		// same rule whichever chunk the newline arrives in, so a padded reply is accepted or
		// rejected identically in both layouts. The pending remainder's whitespace is not free
		// memory either — the same cap bounds it — and an empty line belongs to no frame, so any
		// run of blank lines dispatches without growing any frame's measure.
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const frame = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			const line = frame.trim();
			if (line.length > maxBufferChars || frame.length - line.length > maxBufferChars) return true;
			if (line.length === 0) continue;
			if (onReply(parseMcpReply(line))) return false;
		}
		const content = buffer.trim();
		return content.length > maxBufferChars || buffer.length - content.length > maxBufferChars;
	};
}

/** One conversation with one daemon: hello, initialize, one tools/call. */
function ask(socketPath: string, tool: string, args: Record<string, unknown>, timeoutMs: number, helloTimeoutMs: number): Promise<AskOutcome> {
	return new Promise((resolveResult) => {
		let settled = false;
		const socket = net.createConnection(socketPath);
		const finish = (result: AskOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadlineTimer);
			clearTimeout(helloTimer);
			socket.destroy();
			resolveResult(result);
		};
		const budget = Math.max(1, timeoutMs);
		const deadlineTimer = setTimeout(() => finish({ status: "timeout" }), budget);
		// Only the hello line waits on this timer; the rest of the conversation keeps the whole budget.
		const helloTimer = setTimeout(() => finish({ status: "silent" }), Math.max(1, Math.min(helloTimeoutMs, budget)));
		const send = (message: object) => socket.write(JSON.stringify(message) + "\n");
		let stage: "hello" | "initialize" | "call" = "hello";
		socket.setEncoding("utf8");
		socket.on("error", () => finish({ status: "unavailable" }));
		socket.on("close", () => finish({ status: "unavailable" }));
		const readLines = mcpLineReader((message) => {
			if (message === undefined) return finish({ status: "unavailable" });
			if (stage === "hello") {
				if (typeof (message as { codegraph?: unknown }).codegraph !== "string" || (message as { protocol?: unknown }).protocol !== DAEMON_PROTOCOL) {
					return finish({ status: "unavailable" });
				}
				clearTimeout(helloTimer);
				stage = "initialize";
				send(mcpInitializeRequest());
			} else if (stage === "initialize" && mcpReplyKind(message) === "initialize") {
				if (message.error !== undefined) return finish({ status: "unavailable" });
				stage = "call";
				for (const request of mcpCallRequests(tool, args)) send(request);
			} else if (stage === "call" && mcpReplyKind(message) === "call") {
				const text = mcpCallText(message);
				if (text === undefined) return finish({ status: "unavailable" });
				return finish({ status: "ok", text });
			}
		}, MAX_REPLY_CHARS);
		socket.on("data", (chunk: string) => {
			if (readLines(chunk)) finish({ status: "unavailable" });
		});
	});
}

/**
 * Runs one CodeGraph MCP tool call through a daemon already serving `root`, the same text the CLI
 * prints but without a process of its own. It only reads the daemon registry and connects: it never
 * starts a daemon, and never throws. Candidates are discovered and queried one at a time, so a
 * daemon is asked before the next candidate's pipe probe can spend the budget; a silent daemon
 * hands the rest of the budget to the next one, and the budget covers discovery too: its pipe
 * probes shrink to the leftover and no socket opens once the deadline is spent.
 */
export async function exploreViaDaemon(
	root: string,
	tool: string,
	args: Record<string, unknown>,
	timeoutMs: number,
	registryDir?: string,
	helloTimeoutMs: number = DAEMON_HELLO_TIMEOUT_MS,
): Promise<DaemonCallResult> {
	try {
		const deadline = Date.now() + timeoutMs;
		let silent = false;
		for (const socketPath of liveDaemonSockets(root, registryDir, deadline)) {
			// Discovery and every earlier attempt already spent part of the budget; a spent deadline
			// opens no socket, because ask's own clamp would otherwise buy one more attempt.
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			const result = await ask(socketPath, tool, args, remaining, helloTimeoutMs);
			if (result.status === "silent") {
				silent = true;
				continue;
			}
			if (result.status !== "unavailable") return result;
		}
		// A silent daemon is there but hung: trying another way is the caller's move.
		return silent ? { status: "timeout" } : { status: "unavailable" };
	} catch {
		return { status: "unavailable" };
	}
}

/** The daemon's health for the warm gate: liveness alone cannot tell a serving daemon from a
 * wedged one — ok answers a real query, wedged is alive but never answers, and unreachable
 * means there is no live daemon to ask. */
export type DaemonHealth = "ok" | "wedged" | "unreachable";

/**
 * The health check for the warm gate: liveness is not serviceability. A daemon can pass every
 * registry check — pid running, socket present, connections accepted — and still never answer,
 * so the gate asks the live daemons one real query each (the same call the stdio warm-up makes),
 * newest first within one probe deadline, and maps the answer: ok serves, silent or timeout is
 * wedged (the daemon holds its lock and cannot serve), unavailable has nothing to talk to. Each
 * candidate is discovered only when its turn comes, so an older daemon's pipe probe cannot spend
 * the budget before the newest daemon is queried. Reads and connects only: it never starts
 * anything, kills nothing, and never throws.
 */
export async function daemonHealth(cwd: string, registryDir?: string, helloTimeoutMs: number = DAEMON_HELLO_TIMEOUT_MS, probeTimeoutMs: number = 5_000): Promise<DaemonHealth> {
	try {
		// The one probe deadline starts before discovery: each uncached or inconclusive pipe probe
		// inside it can spend 250ms, and the gate must not wait for discovery and then the full
		// health budget — the same deadline flow exploreViaDaemon gives its discovery.
		const deadline = Date.now() + probeTimeoutMs;
		// Candidates are discovered one at a time inside the same loop that queries them: the newest
		// daemon is asked before an older candidate's pipe probe can spend the leftover, and an
		// older daemon answers for a silent newest one before the gate calls the project wedged —
		// the same fallback a search gets.
		let wedged = false;
		for (const socketPath of liveDaemonSockets(cwd, registryDir, deadline)) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			const outcome = await ask(socketPath, "codegraph_explore", { query: "main" }, remaining, helloTimeoutMs);
			if (outcome.status === "ok") return "ok";
			if (outcome.status === "silent" || outcome.status === "timeout") wedged = true;
		}
		return wedged ? "wedged" : "unreachable";
	} catch {
		return "unreachable";
	}
}
