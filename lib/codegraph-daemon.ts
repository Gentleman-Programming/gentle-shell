import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import net from "node:net";
import { join } from "node:path";

/** The hello line a CodeGraph daemon sends carries `protocol`; this is the only one spoken here. */
export const DAEMON_PROTOCOL = 1;
/** A daemon sends its hello line as soon as it accepts; one silent this long is hung, and the next one gets the rest of the budget. */
export const DAEMON_HELLO_TIMEOUT_MS = 2_000;
/** An explore answer is tens of kilobytes; anything near this size is not one worth keeping in memory. */
const MAX_REPLY_CHARS = 1_000_000;
/** CodeGraph answers an explore without a project with this plain text, not with an error. */
const NO_PROJECT_TEXT = "No CodeGraph project is loaded";
const PIPE_PREFIX = "\\\\.\\pipe\\";

/**
 * One canonical form for root comparison: the real path on disk, trailing separator removed; on
 * Windows also lowercased, so drive-letter case and letter case do not split one project into two
 * daemons.
 */
function canonical(path: string): string {
	let resolved = path;
	try {
		resolved = realpathSync(path);
	} catch {
		/* keep the spelling we were given */
	}
	return (process.platform === "win32" ? resolved.toLowerCase() : resolved).replace(/[\\/]$/, "");
}

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

/** Daemons registered for `root` in any spelling, newest first. Reads the registry only; starts nothing. */
export function registeredDaemons(root: string, registryDir: string = join(homedir(), ".codegraph", "daemons")): RegisteredDaemon[] {
	let files: string[];
	try {
		files = readdirSync(registryDir).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	const wanted = canonical(root);
	// The listing is fresh on every call: a record that appeared or vanished changes it and busts the memo.
	const key = `${registryDir}|${wanted}|${files.join(",")}`;
	if (registryMemo !== undefined && registryMemo.key === key && Date.now() - registryMemo.at < REGISTRY_MEMO_MS) return registryMemo.daemons;
	const found: RegisteredDaemon[] = [];
	for (const file of files) {
		try {
			const entry = JSON.parse(readFileSync(join(registryDir, file), "utf8"));
			if (typeof entry.root !== "string" || typeof entry.socketPath !== "string" || canonical(entry.root) !== wanted) continue;
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

/** Whether a process with this pid exists; signal 0 only checks. EPERM means it exists under another user. */
function processAlive(pid: number): boolean {
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

/** The project's newest daemon from CodeGraph's own registry. Reads only; starts nothing. */
export function daemonFor(cwd: string, registryDir?: string): DaemonInfo {
	const daemons = registeredDaemons(cwd, registryDir);
	const alive = daemons.find((entry) => entry.pid !== undefined && processAlive(entry.pid) && socketPresent(entry.socketPath));
	return { alive: alive !== undefined, root: (alive ?? daemons[0])?.root };
}

/** Sockets of the project's live daemons, newest first. */
export function daemonSockets(cwd: string, registryDir?: string): string[] {
	return registeredDaemons(cwd, registryDir)
		.filter((entry) => entry.pid !== undefined && processAlive(entry.pid) && socketPresent(entry.socketPath))
		.map((entry) => entry.socketPath);
}

export type DaemonCallResult =
	| { status: "ok"; text: string }
	/** No daemon to ask, or it did not behave as expected: the caller should use another way. */
	| { status: "unavailable" }
	/** A daemon was there but did not answer in time: a second attempt would only be slower. */
	| { status: "timeout" };

/** A socket that accepted but never said hello: the next one gets the rest of the budget. */
type AskOutcome = DaemonCallResult | { status: "silent" };

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
		let buffer = "";
		let stage: "hello" | "initialize" | "call" = "hello";
		socket.setEncoding("utf8");
		socket.on("error", () => finish({ status: "unavailable" }));
		socket.on("close", () => finish({ status: "unavailable" }));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.length > MAX_REPLY_CHARS) return finish({ status: "unavailable" });
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				let message: { id?: number; method?: string; error?: unknown; result?: { isError?: boolean; content?: { text?: string }[] } };
				try {
					message = JSON.parse(line);
				} catch {
					return finish({ status: "unavailable" });
				}
				if (stage === "hello") {
					if (typeof (message as { codegraph?: unknown }).codegraph !== "string" || (message as { protocol?: unknown }).protocol !== DAEMON_PROTOCOL) {
						return finish({ status: "unavailable" });
					}
					clearTimeout(helloTimer);
					stage = "initialize";
					send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gentle-shell", version: "0" } } });
				} else if (stage === "initialize" && message.id === 1) {
					if (message.error !== undefined) return finish({ status: "unavailable" });
					stage = "call";
					send({ jsonrpc: "2.0", method: "notifications/initialized" });
					send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } });
				} else if (stage === "call" && message.id === 2) {
					// CodeGraph reports a crashed query worker with isError and a text, not with a JSON-RPC error.
					const text = message.result?.content?.[0]?.text;
					const failed = message.error !== undefined || message.result?.isError === true;
					if (failed || typeof text !== "string" || text.startsWith(NO_PROJECT_TEXT)) return finish({ status: "unavailable" });
					return finish({ status: "ok", text });
				}
			}
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
