import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import net from "node:net";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
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
/** Daemons registered for `root` in any spelling, newest first. Reads the registry only; starts nothing. */
export function registeredDaemons(root: string, registryDir: string = join(homedir(), ".codegraph", "daemons")): RegisteredDaemon[] {
	let files: string[];
	try {
		files = readdirSync(registryDir).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	const wanted = canonicalRoot(root);
	// The listing is fresh on every call: a record that appeared or vanished changes it and busts the memo.
	const key = `${registryDir}|${wanted}|${files.join(",")}`;
	if (registryMemo !== undefined && registryMemo.key === key && Date.now() - registryMemo.at < REGISTRY_MEMO_MS) return registryMemo.daemons;
	const found: RegisteredDaemon[] = [];
	for (const file of files) {
		try {
			const entry = JSON.parse(readFileSync(join(registryDir, file), "utf8"));
			if (typeof entry.root !== "string" || typeof entry.socketPath !== "string" || canonicalRoot(entry.root) !== wanted) continue;
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

/**
 * Whether a daemon socket is still there. A Windows named pipe is not a file: listing the pipe
 * directory shows the live ones without connecting to them, and a listing that fails counts as
 * present rather than risk missing a live daemon. Every other socket path is a socket file.
 */
function socketPresent(socketPath: string): boolean {
	if (process.platform !== "win32" || !socketPath.toLowerCase().startsWith(PIPE_PREFIX)) return existsSync(socketPath);
	const name = socketPath.slice(PIPE_PREFIX.length).toLowerCase();
	try {
		return readdirSync(PIPE_PREFIX).some((entry) => entry.toLowerCase() === name);
	} catch {
		return true;
	}
}

export interface DaemonInfo {
	/** A daemon for this project is running (pid alive, socket present). */
	alive: boolean;
	/** How the newest registered daemon spells this project: passing this spelling keeps a warm-up on
	 * that daemon instead of starting a second one for the same project. Undefined when nothing matches. */
	root?: string;
}

/** The project's daemons that are still there — pid alive, socket present — newest first. */
export function liveDaemons(cwd: string, registryDir?: string): RegisteredDaemon[] {
	return registeredDaemons(cwd, registryDir).filter((entry) => entry.pid !== undefined && processAlive(entry.pid) && socketPresent(entry.socketPath));
}

/** The project's newest daemon from CodeGraph's own registry. Reads only; starts nothing. */
export function daemonFor(cwd: string, registryDir?: string): DaemonInfo {
	const alive = liveDaemons(cwd, registryDir)[0];
	return { alive: alive !== undefined, root: (alive ?? registeredDaemons(cwd, registryDir)[0])?.root };
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
 * starts a daemon, and never throws. A silent daemon hands the rest of the budget to the next one,
 * and a spent budget opens no socket at all.
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
