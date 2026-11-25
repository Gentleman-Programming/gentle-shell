// `POST /api/print` for `gentle-shell serve`: one one-shot prompt (a commit
// message, a title) answered by this machine's Gentle Shell, the way the app
// runs it locally: `gentle-shell --print --no-session --no-tools` in a folder,
// no session written, no tools, no interactive host. The prompt goes on stdin
// (Pi reads piped stdin as the message), so its size is not bound by the
// command line and it never shows in the process list.

import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Principal } from "./serve-auth.ts";
import { HttpError, need, readJsonBody, realDirectory, sendJson } from "./serve-http.ts";
import type { SessionLaunch } from "./serve-session.ts";

export const SERVE_PRINT_LIMITS = {
	timeoutMs: 120_000,
	promptBytes: 256 * 1024,
	bodyBytes: 512 * 1024,
	stdoutBytes: 1024 * 1024,
	/** The end of stderr a failure reports. */
	stderrChars: 2000,
	/** One-shot runs at once, across devices. */
	maxRunning: 4,
	/** After a timeout, an oversize answer or a client that left: SIGTERM, then SIGKILL this much later. */
	killGraceMs: 2_000,
};

/** Pi's `--model` pattern: `provider/id` or `id`, optionally `:thinking`; never an option. */
const MODEL = /^(?!-)[^\s\0-\x1f\x7f]{1,200}$/;

export interface PrintServiceOptions {
	/** The one-shot run for a folder; absent where the server has no launcher (it answers `not_supported`). */
	launchPrint?: (input: { cwd: string; model?: string }) => SessionLaunch;
	limits?: Partial<typeof SERVE_PRINT_LIMITS>;
	log: (line: string) => void;
}

type Outcome = { text: string } | { error: HttpError; exitCode?: number | null };

export class PrintService {
	private readonly options: PrintServiceOptions;
	private readonly limits: typeof SERVE_PRINT_LIMITS;
	private readonly running = new Set<ChildProcess>();

	constructor(options: PrintServiceOptions) {
		this.options = options;
		this.limits = { ...SERVE_PRINT_LIMITS, ...options.limits };
	}

	get available(): boolean {
		return this.options.launchPrint !== undefined;
	}

	async route(req: IncomingMessage, res: ServerResponse, principal: Principal | undefined): Promise<void> {
		need(principal, "sessions:operate");
		const launchPrint = this.options.launchPrint;
		if (!launchPrint) throw new HttpError(501, "not_supported", "This server cannot run one-shot prompts");
		const body = await readJsonBody(req, this.limits.bodyBytes);
		const cwd = realDirectory(body.cwd);
		const prompt = body.prompt;
		if (typeof prompt !== "string" || prompt.trim() === "") throw new HttpError(400, "invalid_prompt", "prompt must be a non-empty string");
		if (Buffer.byteLength(prompt, "utf8") > this.limits.promptBytes) throw new HttpError(400, "invalid_prompt", `prompt over ${this.limits.promptBytes} bytes`);
		const model = body.model;
		if (model !== undefined && (typeof model !== "string" || !MODEL.test(model))) throw new HttpError(400, "invalid_model", "model must be a model name such as provider/id");
		if (this.running.size >= this.limits.maxRunning) throw new HttpError(429, "too_many_prints", `At most ${this.limits.maxRunning} one-shot prompts run at once`);
		const launch = launchPrint({ cwd, ...(typeof model === "string" ? { model } : {}) });
		const outcome = await this.run(launch, prompt, res);
		if ("text" in outcome) return sendJson(res, 200, { text: outcome.text });
		const { error, exitCode } = outcome;
		return sendJson(res, error.status, { error: { code: error.code, message: error.message }, ...(exitCode === undefined ? {} : { exitCode }) });
	}

	private run(launch: SessionLaunch, prompt: string, res: ServerResponse): Promise<Outcome> {
		const { promise, resolve } = Promise.withResolvers<Outcome>();
		// Its own process group (POSIX): the launcher starts Pi as its child, and a stop must end both.
		const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
		this.running.add(child);
		const stdout: Buffer[] = [];
		let outBytes = 0;
		let stderr = "";
		let ended: "timeout" | "too_large" | "client_left" | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		const stop = (why: NonNullable<typeof ended>) => {
			ended ??= why;
			// The group, even when the launcher already exited: Pi may still hold stdout.
			if (killTimer) return;
			this.signal(child, "SIGTERM");
			killTimer = setTimeout(() => this.signal(child, "SIGKILL"), this.limits.killGraceMs);
			killTimer.unref?.();
		};
		const timer = setTimeout(() => stop("timeout"), this.limits.timeoutMs);
		// A client that hangs up does not keep the model running.
		const left = () => { if (!res.writableEnded) stop("client_left"); };
		res.once("close", left);
		child.stdout!.on("data", (chunk: Buffer) => {
			if (ended) return;
			outBytes += chunk.length;
			if (outBytes > this.limits.stdoutBytes) return stop("too_large");
			stdout.push(chunk);
		});
		child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-this.limits.stderrChars); });
		child.stdin!.on("error", () => { /* it exited before reading the prompt */ });
		child.stdin!.end(prompt);
		let settled = false;
		const finish = (outcome: Outcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(killTimer);
			res.off("close", left);
			this.running.delete(child);
			resolve(outcome);
		};
		child.once("error", (error) => finish({ error: new HttpError(502, "print_failed", `Could not start gentle-shell: ${error.message}`) }));
		child.once("close", (code, signal) => {
			if (ended === "timeout") {
				this.options.log(`print timed out after ${this.limits.timeoutMs} ms`);
				return finish({ error: new HttpError(504, "print_timeout", `No answer within ${this.limits.timeoutMs / 1000} s`) });
			}
			if (ended === "too_large") return finish({ error: new HttpError(502, "output_too_large", `The answer is over ${this.limits.stdoutBytes} bytes`) });
			if (ended === "client_left") return finish({ error: new HttpError(499, "client_left", "The client closed the request") });
			if (code !== 0) {
				const detail = stderr.trim() || Buffer.concat(stdout).toString("utf8").trim().slice(-this.limits.stderrChars);
				return finish({ error: new HttpError(502, "print_failed", detail || `gentle-shell exited with ${signal ?? `code ${code}`}`), exitCode: code });
			}
			finish({ text: Buffer.concat(stdout).toString("utf8") });
		});
		return promise;
	}

	private signal(child: ChildProcess, signal: NodeJS.Signals): void {
		if (child.pid === undefined) return;
		try {
			if (process.platform !== "win32") process.kill(-child.pid, signal);
			// Windows has no process groups: end the launcher and the Pi it started.
			else spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill());
		} catch { /* already gone */ }
	}

	/** Ends every one-shot run (the server is stopping). */
	closeAll(): void {
		for (const child of this.running) this.signal(child, "SIGKILL");
	}
}
