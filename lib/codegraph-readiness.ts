import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** A cold daemon on a network share can need over a minute for its first read. */
const WARMUP_TIMEOUT_MS = 120_000;
export const SYNC_TIMEOUT_MS = 120_000;
export const INIT_TIMEOUT_MS = 600_000;
/** How long a killed command may take to be gone before the timeout is reported anyway. */
const KILL_WAIT_MS = 10_000;
/** The environment variable a subagent child carries; children never start an index operation of their own. */
const CHILD_ENV = "GENTLE_PI_AGENTS_CHILD";
/** One of these next to a `.git` is what makes a directory a project worth indexing automatically. */
const MARKERS = ["composer.json", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", "pom.xml", "build.gradle", "build.gradle.kts"];
/** CodeGraph answers an explore without a project with this plain text, not with an error. */
const NO_PROJECT_TEXT = "No CodeGraph project is loaded";

/** One canonical form for root comparison: the real path on disk, trailing separator removed; on Windows
 * also lowercased, so drive-letter case does not split one project into two daemons. */
function canonical(path: string): string {
	let resolved = path;
	try {
		resolved = realpathSync(path);
	} catch {
		/* keep the spelling we were given */
	}
	return (process.platform === "win32" ? resolved.toLowerCase() : resolved).replace(/[\\/]$/, "");
}

export interface DaemonInfo {
	/** A daemon for this project is running (pid alive, socket present). */
	alive: boolean;
	/** How the newest registered daemon spells this project: passing this spelling keeps the warm-up on
	 * that daemon instead of starting a second one for the same project. Undefined when nothing matches. */
	root?: string;
}

/** The project's newest daemon from CodeGraph's own registry. Reads only; starts nothing. */
export function daemonFor(cwd: string, registryDir: string = join(homedir(), ".codegraph", "daemons")): DaemonInfo {
	let files: string[];
	try {
		files = readdirSync(registryDir).filter((file) => file.endsWith(".json"));
	} catch {
		return { alive: false, root: undefined };
	}
	const wanted = canonical(cwd);
	const entries: { root: string; socketPath: string; startedAt: number; pid?: number }[] = [];
	for (const file of files) {
		try {
			const entry = JSON.parse(readFileSync(join(registryDir, file), "utf8"));
			if (typeof entry.root !== "string" || typeof entry.socketPath !== "string" || canonical(entry.root) !== wanted) continue;
			entries.push({
				root: entry.root,
				socketPath: entry.socketPath,
				startedAt: typeof entry.startedAt === "number" ? entry.startedAt : 0,
				pid: typeof entry.pid === "number" ? entry.pid : undefined,
			});
		} catch {
			/* a damaged record is not a daemon */
		}
	}
	entries.sort((a, b) => b.startedAt - a.startedAt);
	for (const entry of entries) {
		if (entry.pid === undefined) continue;
		try {
			process.kill(entry.pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPERM") continue;
		}
		if (existsSync(entry.socketPath)) return { alive: true, root: entry.root };
	}
	return { alive: false, root: entries[0]?.root };
}

/**
 * Makes the project's CodeGraph daemon open its database and start a read worker, so the next real call
 * is fast: talks MCP to `codegraph serve --mcp -p <project>` started from the temp directory (cmd.exe
 * cannot take a UNC working directory), then destroys the pipes and unrefs the child so the server goes
 * on alone as the daemon — it is shared with the user's other sessions, so it is never killed. Never
 * rejects; `background` unrefs everything so a warm-up still running never keeps its caller alive.
 */
export function warmUpDaemon(cwd: string, background = false, timeoutMs = WARMUP_TIMEOUT_MS): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let child: ReturnType<typeof spawn> | undefined;
		const project = daemonFor(cwd).root ?? realpathSync(cwd);
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// Destroy, not end: an ended pipe still holds the event loop until the server exits.
			try { child?.stdin?.destroy(); } catch { /* already closed */ }
			try { child?.stdout?.destroy(); } catch { /* already gone */ }
			child?.unref();
			resolve(ok);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		if (background) timer.unref?.();
		try {
			if (process.platform === "win32") {
				// Windows needs a shell for the npm `.cmd` shim; the command line is fixed plus the quoted project.
				child = spawn(`codegraph serve --mcp -p ${JSON.stringify(project)}`, { cwd: tmpdir(), env: process.env, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
			} else {
				child = spawn("codegraph", ["serve", "--mcp", "-p", project], { cwd: tmpdir(), env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
			}
			if (child === undefined) {
				finish(false);
				return;
			}
			if (background) {
				child.unref();
				(child.stdin as (NodeJS.WritableStream & { unref?(): void }) | null)?.unref?.();
				(child.stdout as (NodeJS.ReadableStream & { unref?(): void }) | null)?.unref?.();
			}
		} catch {
			finish(false);
			return;
		}
		const send = (message: object) => child?.stdin?.write(JSON.stringify(message) + "\n");
		let stage = 0;
		let buffer = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length === 0) continue;
				let message: { id?: number; error?: unknown; result?: { isError?: boolean; content?: { text?: string }[] } };
				try { message = JSON.parse(line); } catch { continue; }
				if (stage === 0 && message.id === 1) {
					send({ jsonrpc: "2.0", method: "notifications/initialized" });
					stage = 1;
					send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "codegraph_explore", arguments: { query: "main" } } });
				} else if (stage === 1 && message.id === 2) {
					// CodeGraph reports a crashed query worker with isError and a text, not a JSON-RPC error.
					const text = message.result?.content?.[0]?.text;
					const failed = message.error !== undefined || message.result?.isError === true;
					finish(!failed && typeof text === "string" && !text.startsWith(NO_PROJECT_TEXT));
				}
			}
		});
		child.on("error", () => finish(false));
		child.on("close", () => finish(false));
		child.stdin?.on("error", () => { /* the server exited first */ });
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "gentle-shell", version: "0" }, rootUri: pathToFileURL(project).href },
		});
	});
}

/**
 * The index state per the repo's codegraph rules: an access error is unknown, NOT absent, and only a
 * confirmed-missing database file may be initialised. An index is the database file, never the directory.
 */
export type IndexState = "present" | "absent" | "unknown";

export function indexState(cwd: string): IndexState {
	try {
		return statSync(join(cwd, ".codegraph", "codegraph.db")).isFile() ? "present" : "absent";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
	}
}

export type IndexAction = "sync" | "init" | "none";
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

/** An existing index is synced; a fresh git project with a marker file is initialised; anything else is left alone. */
export function planIndexAction(cwd: string, state: IndexState, isProjectRoot: (cwd: string) => boolean): IndexAction {
	if (state === "present") return "sync";
	if (state === "unknown" || !isProjectRoot(cwd)) return "none";
	return MARKERS.some((marker) => existsSync(join(cwd, marker))) ? "init" : "none";
}

/** A /reload is not a new session, and a subagent child shares its parent's project. */
export function skipsSession(env: Record<string, string | undefined>, reason: SessionStartReason): boolean {
	return env[CHILD_ENV] === "1" || reason === "reload";
}

export interface ReadinessInput {
	cwd: string;
	env: Record<string, string | undefined>;
	reason: SessionStartReason;
	/** Whether cwd is a real git project root equal to the workspace (the tool's workspace guard). */
	isProjectRoot(cwd: string): boolean;
	/** Runs `codegraph <args...> <project>` from the temp dir; true when it exited 0. */
	run(args: readonly string[], cwd: string, timeoutMs: number): Promise<boolean>;
	/** Warms the daemon; true when it worked. */
	warm(cwd: string): Promise<boolean>;
	onStart?(action: IndexAction): void;
	onIndexed?(result: { action: IndexAction; ok: boolean }): void;
	onWarmStart?(): void;
}

export interface ReadinessResult {
	action: IndexAction;
	ok: boolean;
	warm: "ok" | "failed" | "skipped";
}

/** One in-flight readiness run per project: sessions that start together never run two of these. */
const inFlight = new Map<string, Promise<ReadinessResult>>();

/**
 * Brings the index of the project Pi started in up to date, then, when an index exists, warms the daemon
 * so the first real call is fast. Background by design: never rejects, and the session never waits.
 */
export function prepareReadiness(input: ReadinessInput): Promise<ReadinessResult> {
	const existing = inFlight.get(input.cwd);
	if (existing) return existing;
	const started = (async (): Promise<ReadinessResult> => {
		try {
			if (skipsSession(input.env, input.reason)) return { action: "none", ok: true, warm: "skipped" };
			const action = planIndexAction(input.cwd, indexState(input.cwd), input.isProjectRoot);
			if (action === "none") return { action, ok: true, warm: "skipped" };
			try { input.onStart?.(action); } catch { /* never worth stopping the index */ }
			const ok = await input.run(
				action === "sync" ? ["sync", "-q"] : ["init", "-y"],
				input.cwd,
				action === "sync" ? SYNC_TIMEOUT_MS : INIT_TIMEOUT_MS,
			);
			try { input.onIndexed?.({ action, ok }); } catch { /* never worth stopping the warm-up */ }
			// A failed sync still leaves an index to warm; a failed init leaves nothing worth warming.
			if (!(action === "sync" || (action === "init" && ok))) return { action, ok, warm: "skipped" };
			try { input.onWarmStart?.(); } catch { /* never worth stopping the warm-up */ }
			try {
				return { action, ok, warm: (await input.warm(input.cwd)) ? "ok" : "failed" };
			} catch {
				return { action, ok, warm: "failed" };
			}
		} catch {
			return { action: "none", ok: false, warm: "skipped" };
		} finally {
			inFlight.delete(input.cwd);
		}
	})();
	inFlight.set(input.cwd, started);
	return started;
}

/**
 * Runs the codegraph CLI with fixed arguments for the project in `cwd`, from the temp directory with the
 * project as the last argument spelled as its daemon registered it (another spelling starts another
 * daemon). On Windows the npm `.cmd` shim needs a shell. A timeout kills the child and only reports the
 * failure once that process is gone: its pid must not outlive the result.
 */
export function runCodegraph(args: readonly string[], cwd: string, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		let grace: ReturnType<typeof setTimeout> | undefined;
		const finish = (ok: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (grace !== undefined) clearTimeout(grace);
			resolve(ok);
		};
		let child: ReturnType<typeof spawn> | undefined;
		try {
			const project = daemonFor(cwd).root ?? realpathSync(cwd);
			if (process.platform === "win32") {
				child = spawn(`codegraph ${[...args, project].map((part) => JSON.stringify(part)).join(" ")}`, { cwd: tmpdir(), env: process.env, shell: true, windowsHide: true, stdio: "ignore" });
			} else {
				child = spawn("codegraph", [...args, project], { cwd: tmpdir(), env: process.env, windowsHide: true, stdio: "ignore" });
			}
		} catch {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => {
			try {
				if (child?.pid !== undefined) process.kill(child.pid);
			} catch { /* already gone */ }
			// A killed command may still be closing; report the failure only once the process is gone.
			grace = setTimeout(() => finish(false), KILL_WAIT_MS);
		}, timeoutMs);
		child?.on("error", () => finish(false));
		child?.on("close", (code: number | null) => finish(code === 0));
	});
}

/**
 * Lazy re-warm for tool calls: when the project's daemon is not alive any more, warm it in the background
 * so the NEXT query is fast again. Never blocks, never throws; a warm-up still running never keeps the
 * caller alive.
 */
export function maybeRewarm(
	cwd: string,
	warm: (cwd: string) => Promise<boolean> = (project) => warmUpDaemon(project, true),
	registryDir?: string,
): void {
	try {
		const daemon = daemonFor(cwd, registryDir);
		if (!daemon.alive) void warm(daemon.root ?? cwd).catch(() => { /* best effort */ });
	} catch { /* never worth failing a query over */ }
}
