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

/** One query can trigger several registry scans (daemonFor, daemonSockets, one per daemon attempt), so one read per project per window suffices. */
const REGISTRY_MEMO_MS = 1_000;
let registryMemo: { key: string; at: number; daemons: RegisteredDaemon[] } | undefined;

/** Tests reset the window so fixtures written between calls are seen again. */
export function resetDaemonRegistryMemo(): void {
	registryMemo = undefined;
}

/** Exported for the tests that read the registry directly; daemonFor and daemonSockets call it in production. */
/** Daemons registered for `root` in any spelling, newest first. Reads the registry only; starts nothing.
 * The platform picks the fold: on win32 both spellings compare through the process-lifetime canonical memo. */
export function registeredDaemons(root: string, registryDir: string = join(homedir(), ".codegraph", "daemons"), platform: NodeJS.Platform = process.platform): RegisteredDaemon[] {
	let files: string[];
	try {
		files = readdirSync(registryDir).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	const wanted = canonicalRoot(root, platform);
	// The listing is fresh on every call: a record that appeared or vanished changes it and busts the memo.
	const key = `${registryDir}|${wanted}|${platform}|${files.join(",")}`;
	if (registryMemo !== undefined && registryMemo.key === key && Date.now() - registryMemo.at < REGISTRY_MEMO_MS) return registryMemo.daemons;
	const found: RegisteredDaemon[] = [];
	for (const file of files) {
		try {
			const entry = JSON.parse(readFileSync(join(registryDir, file), "utf8"));
			if (typeof entry.root !== "string" || typeof entry.socketPath !== "string" || canonicalRoot(entry.root, platform) !== wanted) continue;
			found.push({
				root: entry.root,
				socketPath: entry.socketPath,
				startedAt: typeof entry.startedAt === "number" ? entry.startedAt : 0,
				pid: typeof entry.pid === "number" ? entry.pid : undefined,
			});
		} catch {
			/* a damaged record is not a daemon */
		}
	}
	registryMemo = { key, at: Date.now(), daemons: found };
	return found.sort((a, b) => b.startedAt - a.startedAt);
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

/** The probe's worker side as plain JavaScript, so it needs no compiled file: the connect runs on the
 * worker's own event loop while the calling thread waits on the shared cell, the first outcome lands
 * there (1 open, 2 refused, 3 anything else), and destroying the socket lets the worker's loop drain.
 * ECONNREFUSED and ENOENT are the no-listener spellings for a Windows pipe name; a busy or protected
 * pipe stays inconclusive. */
const PROBE_WORKER_SOURCE = `
const { workerData } = require("node:worker_threads");
const net = require("node:net");
const state = workerData.state;
const report = (code) => {
	if (Atomics.compareExchange(state, 0, 0, code) !== 0) return;
	Atomics.notify(state, 0);
};
const socket = net.createConnection(workerData.pipePath);
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
}, workerData.timeoutMs).unref();
`;

/** One probe of the daemon's own pipe: a worker owns the event loop the async connect needs while
 * this thread waits on the shared cell for the outcome or the deadline, so the check answers within
 * the probe budget instead of enumerating every named pipe on the machine. A worker that never
 * starts or never reports is inconclusive, never absent. */
function connectProbe(pipePath: string, timeoutMs: number): PipeProbeOutcome {
	const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
	try {
		const worker = new Worker(PROBE_WORKER_SOURCE, { eval: true, workerData: { pipePath, timeoutMs, state } });
		Atomics.wait(state, 0, 0, Math.max(1, timeoutMs));
		void worker.terminate();
	} catch {
		return "inconclusive";
	}
	const code = Atomics.load(state, 0);
	return code === 1 ? "open" : code === 2 ? "refused" : "inconclusive";
}

let pipeProbe: PipeProbe = connectProbe;

/** Tests swap in a fake net/socket layer and restore the real probe with undefined; a swap clears
 * the remembered positives so every fake starts from an empty cache. Production never calls it. */
export function setPipeProbeForTests(probe: PipeProbe | undefined): void {
	pipeProbe = probe ?? connectProbe;
	pipeProbeMemo.clear();
}

/**
 * Whether a daemon socket is still there. Every path outside the Windows pipe namespace is a socket
 * file and keeps its filesystem check. A Windows named pipe is not a file: one short connect probe
 * of the daemon's own pipe replaces enumerating every named pipe on the machine, and a probe that
 * connected is remembered for a short window. A clean refusal — the pipe is not there — is the one
 * answer that counts as absent; every other failure still counts as present rather than risk
 * missing a live daemon, the same fail-safe the pipe listing had.
 */
export function socketPresent(socketPath: string, platform: NodeJS.Platform = process.platform): boolean {
	if (platform !== "win32" || !socketPath.toLowerCase().startsWith(PIPE_PREFIX)) return existsSync(socketPath);
	const probedAt = pipeProbeMemo.get(socketPath);
	if (probedAt !== undefined && Date.now() - probedAt < PIPE_PROBE_MEMO_MS) return true;
	const outcome = pipeProbe(socketPath, PIPE_PROBE_TIMEOUT_MS);
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

/** The project's daemons that are still there — pid alive, socket present — newest first. */
export function liveDaemons(cwd: string, registryDir?: string, platform: NodeJS.Platform = process.platform): RegisteredDaemon[] {
	return registeredDaemons(cwd, registryDir, platform).filter((entry) => entry.pid !== undefined && processAlive(entry.pid) && socketPresent(entry.socketPath, platform));
}

/** The project's newest daemon from CodeGraph's own registry. Reads only; starts nothing. */
export function daemonFor(cwd: string, registryDir?: string, platform: NodeJS.Platform = process.platform): DaemonInfo {
	const alive = liveDaemons(cwd, registryDir, platform)[0];
	return { alive: alive !== undefined, root: (alive ?? registeredDaemons(cwd, registryDir, platform)[0])?.root };
}

/** The project spelled as its daemon registered it, or the real path of `cwd` when no daemon matches:
 * the one fold every CLI invocation and warm-up uses to stay on a live daemon's spelling. */
export function projectSpelling(daemon: DaemonInfo | undefined, cwd: string): string {
	return daemon?.root ?? realpathSync(cwd);
}

/** Sockets of the project's live daemons, newest first. */
function daemonSockets(cwd: string, registryDir?: string): string[] {
	return liveDaemons(cwd, registryDir).map((entry) => entry.socketPath);
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
 * data handler's `return`. The chunk handler itself answers true when the unparsed buffer grew past
 * `maxBufferChars` — the runaway guard the socket conversation finishes on.
 */
export function mcpLineReader(onReply: (message: McpReply | undefined) => boolean | void, maxBufferChars: number = Number.POSITIVE_INFINITY): (chunk: string | Buffer) => boolean {
	let buffer = "";
	// One decoder for the whole conversation: a multibyte UTF-8 character split across Buffer chunks
	// corrupts into replacement characters under a per-chunk toString; the decoder holds the trailing
	// bytes until the next chunk completes them.
	const decoder = new StringDecoder("utf8");
	return (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		if (buffer.length > maxBufferChars) return true;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line.length === 0) continue;
			if (onReply(parseMcpReply(line))) return false;
		}
		return false;
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
 * starts a daemon, and never throws. A silent daemon hands the rest of the budget to the next one.
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
		for (const socketPath of daemonSockets(root, registryDir)) {
			const result = await ask(socketPath, tool, args, deadline - Date.now(), helloTimeoutMs);
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
