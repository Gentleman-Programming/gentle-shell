// `POST /api/git` for `gentle-shell serve`: one `git` command in a folder on
// the server (no shell), with its exit code and output, so a client shows
// and drives a repository that lives there. Read-only commands need
// `sessions:read`; anything else `sessions:operate`, which is the server
// user's own authority. Configuration and arguments that make git run another
// program are refused, so a read-only token cannot turn a read into a command.

import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal, ServeScope } from "./serve-auth.ts";
import { HttpError, need, readJsonBody, realDirectory, sendJson } from "./serve-http.ts";

export const SERVE_GIT_LIMITS = {
	/** Default run time, and the most a request may ask for. */
	timeoutMs: 120_000,
	/** The most a fetch, push, clone, pull, ls-remote or submodule may ask for. */
	networkTimeoutMs: 600_000,
	stdoutBytes: 32 * 1024 * 1024,
	stderrBytes: 1024 * 1024,
	stdinBytes: 8 * 1024 * 1024,
	/** The JSON body: base64 stdin plus arguments. */
	bodyBytes: 12 * 1024 * 1024,
	maxArgs: 256,
	argChars: 32 * 1024,
	/** git processes at once, across devices. */
	maxRunning: 16,
	/** After a timeout or truncation, SIGTERM; SIGKILL this much later. */
	killGraceMs: 2_000,
};

/** Global options that take the next argument as their value. */
const GLOBAL_WITH_VALUE: Record<string, true> = { "-C": true, "-c": true, "--git-dir": true, "--work-tree": true, "--namespace": true, "--super-prefix": true, "--config-env": true };

/** Configuration keys (lowercase) that run a program or redirect what git runs. */
const BLOCKED_CONFIG = [/^core\.sshcommand$/, /^core\.fsmonitor$/, /^core\.hookspath$/, /^core\.gitproxy$/, /^uploadpack\./, /^alias\./,
	/^remote\..+\.(uploadpack|receivepack)$/, /^protocol\.ext\.allow$/];

/** Subcommands that only read. */
const READ_SUBCOMMANDS: Record<string, true> = {
	status: true, diff: true, log: true, show: true, "rev-parse": true, "ls-files": true, "for-each-ref": true, "cat-file": true, "ls-tree": true,
	"rev-list": true, "merge-base": true, blame: true, describe: true, shortlog: true, "name-rev": true, "check-ignore": true, "check-attr": true,
	grep: true, "show-ref": true, "diff-tree": true, "diff-files": true, "diff-index": true, "count-objects": true, version: true, "ls-remote": true,
};

/** Subcommands that talk to a remote and may run up to `networkTimeoutMs`. */
const NETWORK_SUBCOMMANDS: Record<string, true> = { fetch: true, push: true, clone: true, pull: true, "ls-remote": true, submodule: true };

/** Variables a request may set; the rest of the environment is the server's. */
const ALLOWED_ENV: Record<string, true> = {
	GIT_AUTHOR_NAME: true, GIT_AUTHOR_EMAIL: true, GIT_AUTHOR_DATE: true, GIT_COMMITTER_NAME: true, GIT_COMMITTER_EMAIL: true, GIT_COMMITTER_DATE: true,
	GIT_DIR: true, GIT_WORK_TREE: true, GIT_INDEX_FILE: true, GIT_NAMESPACE: true, GIT_LITERAL_PATHSPECS: true, GIT_GLOB_PATHSPECS: true,
	GIT_NOGLOB_PATHSPECS: true, GIT_ICASE_PATHSPECS: true, GIT_REFLOG_ACTION: true, GIT_MERGE_AUTOEDIT: true, GIT_MERGE_VERBOSITY: true, GIT_OPTIONAL_LOCKS: true,
};

/** Inherited variables that would point git at another repository than the request's. */
const DROPPED_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_NAMESPACE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_PREFIX"];

export interface GitCommand {
	/** The subcommand (`status`, `commit`, …); undefined for `git --version` and the like. */
	subcommand?: string;
	scope: ServeScope;
	network: boolean;
}

function blockedConfig(entry: string): boolean {
	const key = entry.split("=", 1)[0].trim().toLowerCase();
	return BLOCKED_CONFIG.some((pattern) => pattern.test(key));
}

const refuse = (message: string) => new HttpError(400, "git_refused", message);

/**
 * What a git argument list does: its subcommand, whether it only reads, and
 * whether it is a network command. Throws `400 git_refused` for configuration
 * or options that make git run another program.
 */
export function classifyGitArgs(args: readonly string[]): GitCommand {
	let i = 0;
	let configured = false;
	for (; i < args.length; i += 1) {
		const arg = args[i];
		if (!arg.startsWith("-")) break;
		if (arg.startsWith("--exec-path=")) throw refuse("--exec-path=<dir> is refused: it chooses which programs git runs");
		const config = arg === "-c" || arg === "--config-env" ? args[i + 1] ?? "" : arg.startsWith("--config-env=") ? arg.slice("--config-env=".length) : undefined;
		if (config !== undefined) {
			if (blockedConfig(config)) throw refuse(`-c ${config.split("=", 1)[0]} is refused: it makes git run a program`);
			configured = true;
		}
		if (Object.hasOwn(GLOBAL_WITH_VALUE, arg)) i += 1;
	}
	const subcommand = args[i];
	const rest = args.slice(i + 1);
	const end = rest.indexOf("--");
	const options = end === -1 ? rest : rest.slice(0, end);
	for (let j = 0; j < options.length; j += 1) {
		const arg = options[j];
		if (/^--(upload-pack|receive-pack|exec)(=|$)/.test(arg)) throw refuse(`${arg.split("=", 1)[0]} is refused: it makes git run a program`);
		if ((subcommand === "clone" || subcommand === "ls-remote") && /^-u/.test(arg)) throw refuse("-u (upload-pack) is refused: it makes git run a program");
		if (subcommand === "clone") {
			const value = arg === "-c" || arg === "--config" ? options[j + 1] ?? "" : arg.startsWith("--config=") ? arg.slice("--config=".length) : arg.startsWith("-c") && arg.length > 2 ? arg.slice(2) : undefined;
			if (value !== undefined && blockedConfig(value)) throw refuse(`--config ${value.split("=", 1)[0]} is refused: it makes git run a program`);
		}
	}
	const network = subcommand !== undefined && Object.hasOwn(NETWORK_SUBCOMMANDS, subcommand);
	// A configuration override can change what any command does: only a token that operates may set one.
	const read = !configured && (subcommand === undefined || readOnly(subcommand, options));
	return { ...(subcommand === undefined ? {} : { subcommand }), scope: read ? "sessions:read" : "sessions:operate", network };
}

function readOnly(subcommand: string, options: readonly string[]): boolean {
	const flags = options.filter((a) => a.startsWith("-"));
	const positionals = options.filter((a) => !a.startsWith("-"));
	const has = (...names: string[]) => flags.some((f) => names.includes(f.split("=", 1)[0]));
	if (Object.hasOwn(READ_SUBCOMMANDS, subcommand)) {
		// Reads that would still write a file or start a pager program.
		if (has("--output")) return false;
		if (subcommand === "grep" && flags.some((f) => f === "-O" || f.startsWith("-O") || f.startsWith("--open-files-in-pager"))) return false;
		return true;
	}
	switch (subcommand) {
		case "branch":
			return !has("-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-f", "--force", "--set-upstream-to", "-u", "--unset-upstream",
				"--edit-description", "-t", "--track", "--no-track", "--create-reflog")
				&& (positionals.length === 0 || has("-l", "--list", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"));
		case "tag":
			return !has("-a", "--annotate", "-s", "--sign", "-u", "--local-user", "-f", "--force", "-d", "--delete", "-m", "--message", "-F", "--file", "-e", "--edit", "--create-reflog")
				&& (positionals.length === 0 || has("-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at") || flags.some((f) => /^-n\d*$/.test(f)));
		case "config":
			if (positionals[0] === "get" || positionals[0] === "list") return !has("-e", "--edit");
			return has("--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool", "-l", "--list")
				&& !has("--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "-e", "--edit");
		case "remote":
			return positionals.length === 0 || positionals[0] === "get-url" || positionals[0] === "show";
		case "stash":
			return positionals[0] === "list" || positionals[0] === "show";
		case "worktree":
			return positionals[0] === "list";
		case "symbolic-ref":
			return positionals.length <= 1 && !has("-d", "--delete");
		default:
			return false;
	}
}

export interface GitServiceOptions {
	/** The environment git runs with (the server's). */
	env: NodeJS.ProcessEnv;
	limits?: Partial<typeof SERVE_GIT_LIMITS>;
	log?: (line: string) => void;
}

export class GitService {
	private readonly env: NodeJS.ProcessEnv;
	private readonly limits: typeof SERVE_GIT_LIMITS;
	private readonly log: (line: string) => void;
	private readonly running = new Set<ChildProcess>();

	constructor(options: GitServiceOptions) {
		this.env = options.env;
		this.limits = { ...SERVE_GIT_LIMITS, ...options.limits };
		this.log = options.log ?? (() => {});
	}

	async route(req: IncomingMessage, res: ServerResponse, principal: Principal | undefined): Promise<void> {
		if (!principal) throw new HttpError(401, "unauthorized", "A valid bearer token is required");
		const body = await readJsonBody(req, this.limits.bodyBytes);
		const args = body.args;
		if (!Array.isArray(args) || args.length === 0 || args.length > this.limits.maxArgs
			|| !args.every((a): a is string => typeof a === "string" && a.length <= this.limits.argChars && !a.includes("\0"))) {
			throw new HttpError(400, "invalid_args", `args must be 1-${this.limits.maxArgs} strings without NUL`);
		}
		const command = classifyGitArgs(args);
		need(principal, command.scope);
		const cwd = realDirectory(body.cwd);
		let stdin: Buffer | undefined;
		if (body.stdin !== undefined) {
			if (typeof body.stdin !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.stdin)) throw new HttpError(400, "invalid_stdin", "stdin must be base64");
			stdin = Buffer.from(body.stdin, "base64");
			if (stdin.length > this.limits.stdinBytes) throw new HttpError(413, "too_large", `stdin over ${this.limits.stdinBytes} bytes`);
		}
		const extraEnv: Record<string, string> = {};
		if (body.env !== undefined) {
			if (!body.env || typeof body.env !== "object" || Array.isArray(body.env)) throw new HttpError(400, "invalid_env", "env must be an object of strings");
			for (const [name, value] of Object.entries(body.env)) {
				if (!Object.hasOwn(ALLOWED_ENV, name)) throw new HttpError(400, "env_not_allowed", `${name} may not be set (allowed: ${Object.keys(ALLOWED_ENV).join(", ")})`);
				if (typeof value !== "string" || value.includes("\0") || value.length > 4096) throw new HttpError(400, "invalid_env", `${name} must be a string`);
				extraEnv[name] = value;
			}
		}
		const ceiling = command.network ? this.limits.networkTimeoutMs : this.limits.timeoutMs;
		let timeoutMs = this.limits.timeoutMs;
		if (body.timeoutMs !== undefined) {
			if (typeof body.timeoutMs !== "number" || !Number.isInteger(body.timeoutMs) || body.timeoutMs < 1000 || body.timeoutMs > ceiling) {
				throw new HttpError(400, "invalid_timeout", `timeoutMs must be a whole number from 1000 to ${ceiling} for git ${command.subcommand ?? ""}`.trimEnd());
			}
			timeoutMs = body.timeoutMs;
		}
		if (this.running.size >= this.limits.maxRunning) throw new HttpError(429, "too_many_git", `At most ${this.limits.maxRunning} git commands run at once`);
		const env: NodeJS.ProcessEnv = { ...this.env };
		for (const name of DROPPED_ENV) delete env[name];
		Object.assign(env, {
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "never",
			GIT_PAGER: "cat",
			PAGER: "cat",
			// Nothing can answer an editor: a commit without a message aborts instead of waiting.
			GIT_EDITOR: "true",
			GIT_MERGE_AUTOEDIT: "no",
			...(command.scope === "sessions:read" ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
		}, extraEnv);
		const result = await this.run(args, cwd, env, stdin, timeoutMs);
		sendJson(res, 200, result);
	}

	private run(args: string[], cwd: string, env: NodeJS.ProcessEnv, stdin: Buffer | undefined, timeoutMs: number) {
		const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; signal: string | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }>();
		// Its own process group (POSIX), so a timeout ends git's helpers too, and no controlling terminal for ssh to prompt on.
		const child = spawn("git", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
		this.running.add(child);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outBytes = 0;
		let errBytes = 0;
		let truncated = false;
		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		const stop = () => {
			if (killTimer || child.exitCode !== null) return;
			this.signal(child, "SIGTERM");
			killTimer = setTimeout(() => this.signal(child, "SIGKILL"), this.limits.killGraceMs);
		};
		const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
		child.stdout!.on("data", (chunk: Buffer) => {
			if (truncated) return;
			const room = this.limits.stdoutBytes - outBytes;
			if (chunk.length > room) {
				stdout.push(chunk.subarray(0, room));
				outBytes += room;
				truncated = true;
				return stop();
			}
			stdout.push(chunk);
			outBytes += chunk.length;
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			const room = this.limits.stderrBytes - errBytes;
			if (room <= 0) return;
			stderr.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
			errBytes += Math.min(room, chunk.length);
		});
		child.stdin!.on("error", () => { /* git exited before reading all of stdin */ });
		child.stdin!.end(stdin);
		child.on("error", (error: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			this.running.delete(child);
			reject(error.code === "ENOENT" ? new HttpError(501, "git_missing", "git is not installed on the server (not on its PATH)") : error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			this.running.delete(child);
			if (timedOut) this.log(`git ${args[0]} timed out after ${timeoutMs} ms`);
			resolve({ code, signal, stdout: Buffer.concat(stdout).toString("base64"), stderr: Buffer.concat(stderr).toString("base64"), truncated, timedOut });
		});
		return promise;
	}

	private signal(child: ChildProcess, signal: NodeJS.Signals): void {
		try {
			if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch { /* already gone */ }
	}

	/** Ends every running git command (the server is stopping). */
	closeAll(): void {
		for (const child of this.running) this.signal(child, "SIGKILL");
	}
}
