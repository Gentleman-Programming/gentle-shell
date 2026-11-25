// Gentle Desktop packages bridge: `list_packages` reads the packages Pi's
// settings name, and `install_package` / `remove_package` run the same CLI a
// user would (`gentle-shell install <source> [-l]`, `gentle-shell remove …`),
// so the validation, the project trust check, the npm/git work and the
// settings write are the CLI's own. Its output becomes `package_progress`
// lines and its exit one `package_finished`. After a success the session
// reloads (`/reload`: extensions, skills, prompts and themes), once it is idle,
// so what was installed is there without restarting it.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, getAgentDir, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesktopRpcOutcome } from "./desktop-rpc.ts";
import {
	DESKTOP_PACKAGES_LIMITS,
	INVALID_INSTALL_PACKAGE,
	INVALID_LIST_PACKAGES,
	INVALID_REMOVE_PACKAGE,
	PACKAGE_JOB_RUNNING,
	PACKAGES_UNAVAILABLE,
	parsePackageRequest,
	progressLines,
	type DesktopPackage,
	type PackageAction,
	type PackageScope,
} from "./desktop-rpc-packages.ts";
import { INTERACTIVE_HOST_ENV } from "./rpc-host.ts";

/** The launcher and home of this session, as `bin/gentle-shell.mjs` hands them to Pi: `{ command, args }` (JSON). */
export const GENTLE_SHELL_LAUNCH_ENV = "GENTLE_SHELL_LAUNCH";

export interface PackageJobInput {
	action: PackageAction;
	source: string;
	scope: PackageScope;
	cwd: string;
	signal: AbortSignal;
	onLine: (line: string) => void;
}

/** Runs one install or removal; resolves with its outcome, never rejects. */
export type PackageRunner = (input: PackageJobInput) => Promise<{ ok: true } | { ok: false; error: string }>;
export type PackageLister = (cwd: string) => DesktopPackage[] | Promise<DesktopPackage[]>;
export type DesktopPackagesEmit = (event: string, data: Record<string, unknown>) => void;

export interface DesktopPackagesOptions {
	/** Test seam: the CLI run; production spawns the launcher (`cliPackageRunner`). */
	runner?: PackageRunner;
	/** Test seam: the listing; production reads Pi's settings (`settingsPackages`). */
	lister?: PackageLister;
	timeoutMs?: number;
	newJobId?: () => string;
}

/** The command that runs this Gentle Shell's CLI with this session's home. */
export function packageCli(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
	const raw = env[GENTLE_SHELL_LAUNCH_ENV];
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as { command?: unknown; args?: unknown };
			if (typeof parsed.command === "string" && parsed.command.length > 0 && Array.isArray(parsed.args) && parsed.args.every((arg) => typeof arg === "string")) {
				return { command: parsed.command, args: parsed.args as string[] };
			}
		} catch { /* fall back below */ }
	}
	// Pi started without the launcher: the launcher of this package, on Pi's own agent home.
	return { command: process.execPath, args: [fileURLToPath(new URL("../bin/gentle-shell.mjs", import.meta.url)), "--home", getAgentDir()] };
}

/** The tail of a failed run's output, as its error: the CLI's last word on it. */
function failureText(lines: readonly string[], code: number | null, signal: NodeJS.Signals | null): string {
	const last = lines.at(-1);
	if (last) return last.length > DESKTOP_PACKAGES_LIMITS.error ? `${last.slice(0, DESKTOP_PACKAGES_LIMITS.error - 1)}…` : last;
	return signal ? `Stopped by ${signal}` : `Exited with code ${code}`;
}

/**
 * Production runner: `<cli> install|remove <source> [-l]` in the session's
 * folder, stdin closed (nothing can prompt), color off. A stop (timeout, a
 * session change) sends SIGTERM, then SIGKILL 5 s later.
 */
export function cliPackageRunner(cli: { command: string; args: string[] } = packageCli()): PackageRunner {
	return (input) => {
		const { promise, resolve } = Promise.withResolvers<{ ok: true } | { ok: false; error: string }>();
		const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", GENTLE_SHELL_SKIP_STARTUP_UPDATE: "1" };
		delete env[INTERACTIVE_HOST_ENV];
		const args = [...cli.args, input.action, input.source, ...(input.scope === "project" ? ["-l"] : [])];
		let child: ChildProcess;
		try {
			child = spawn(cli.command, args, { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		} catch (error) {
			resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
			return promise;
		}
		const errors: string[] = [];
		const reader = (stream: NodeJS.ReadableStream | null, isError: boolean) => {
			let rest = "";
			stream?.setEncoding("utf8");
			stream?.on("data", (chunk: string) => {
				const text = rest + chunk;
				const cut = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
				rest = cut === -1 ? text : text.slice(cut + 1);
				for (const line of progressLines(cut === -1 ? "" : text.slice(0, cut + 1))) {
					if (isError) errors.push(line);
					input.onLine(line);
				}
			});
			stream?.on("end", () => {
				for (const line of progressLines(rest)) {
					if (isError) errors.push(line);
					input.onLine(line);
				}
				rest = "";
			});
		};
		reader(child.stdout, false);
		reader(child.stderr, true);
		let kill: NodeJS.Timeout | undefined;
		const stop = () => {
			child.kill("SIGTERM");
			kill = setTimeout(() => child.kill("SIGKILL"), 5000);
			kill.unref();
		};
		input.signal.addEventListener("abort", stop, { once: true });
		child.once("error", (error) => {
			input.signal.removeEventListener("abort", stop);
			resolve({ ok: false, error: error.message });
		});
		child.once("close", (code, signal) => {
			input.signal.removeEventListener("abort", stop);
			clearTimeout(kill);
			if (input.signal.aborted) resolve({ ok: false, error: input.signal.reason instanceof Error ? input.signal.reason.message : "Stopped" });
			else if (code === 0) resolve({ ok: true });
			else resolve({ ok: false, error: failureText(errors, code, signal) });
		});
		return promise;
	};
}

function installedVersion(installedPath: string | undefined): string | undefined {
	if (!installedPath) return undefined;
	try {
		const version = JSON.parse(readFileSync(join(installedPath, "package.json"), "utf8").replace(/^\uFEFF/, ""))?.version;
		return typeof version === "string" && version.length > 0 && version.length <= 64 ? version : undefined;
	} catch {
		return undefined;
	}
}

/** Production listing: the packages Pi's user and project settings name (what `gentle-shell list` prints), with the installed version when there is one. */
export function settingsPackages(cwd: string): DesktopPackage[] {
	const agentDir = getAgentDir();
	const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
	return manager.listConfiguredPackages().slice(0, DESKTOP_PACKAGES_LIMITS.packages).map((entry) => {
		const version = installedVersion(entry.installedPath);
		return { source: entry.source, ...(version === undefined ? {} : { version }), scope: entry.scope };
	});
}

interface Job {
	jobId: string;
	controller: AbortController;
}

export class DesktopPackagesBridge {
	private host: ExtensionContext | undefined;
	private emit: DesktopPackagesEmit | undefined;
	private generation = 0;
	private job: Job | undefined;
	private readonly runner: PackageRunner;
	private readonly lister: PackageLister;
	private readonly timeoutMs: number;
	private readonly newJobId: () => string;

	constructor(options: DesktopPackagesOptions = {}) {
		this.runner = options.runner ?? cliPackageRunner();
		this.lister = options.lister ?? settingsPackages;
		this.timeoutMs = options.timeoutMs ?? DESKTOP_PACKAGES_LIMITS.timeoutMs;
		this.newJobId = options.newJobId ?? (() => `pkg_${randomBytes(8).toString("hex")}`);
	}

	attach(context: ExtensionContext): void {
		this.host = context;
	}

	wire(emit: DesktopPackagesEmit): void {
		this.emit = emit;
	}

	/** A session change stops a running job: its events and its reload would reach no one. */
	reset(): void {
		this.generation += 1;
		this.host = undefined;
		this.emit = undefined;
		this.job?.controller.abort(new Error("The session ended"));
	}

	handle(method: string, params: Record<string, unknown>): DesktopRpcOutcome | Promise<DesktopRpcOutcome> | undefined {
		if (method === "list_packages") return this.list(params);
		if (method === "install_package") return this.start("install", params);
		if (method === "remove_package") return this.start("remove", params);
		return undefined;
	}

	private async list(params: Record<string, unknown>): Promise<DesktopRpcOutcome> {
		if (Object.keys(params).length > 0) return { ok: false, error: INVALID_LIST_PACKAGES };
		const cwd = this.cwd();
		if (cwd === undefined) return { ok: false, error: PACKAGES_UNAVAILABLE };
		try {
			return { ok: true, data: { packages: await this.lister(cwd) } };
		} catch {
			return { ok: false, error: PACKAGES_UNAVAILABLE };
		}
	}

	private cwd(): string | undefined {
		try {
			const cwd = this.host?.cwd;
			return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
		} catch {
			return undefined;
		}
	}

	private start(action: PackageAction, params: Record<string, unknown>): DesktopRpcOutcome {
		const request = parsePackageRequest(params);
		if (!request) return { ok: false, error: action === "install" ? INVALID_INSTALL_PACKAGE : INVALID_REMOVE_PACKAGE };
		const cwd = this.cwd();
		if (cwd === undefined) return { ok: false, error: PACKAGES_UNAVAILABLE };
		if (this.job) return { ok: false, error: PACKAGE_JOB_RUNNING };
		const job: Job = { jobId: this.newJobId(), controller: new AbortController() };
		this.job = job;
		const host = this.host;
		// The job starts after this answer is published, so `{ jobId }` precedes its first `package_progress`.
		setImmediate(() => void this.run(job, action, request.source, request.scope, cwd, host));
		return { ok: true, data: { jobId: job.jobId } };
	}

	private async run(job: Job, action: PackageAction, source: string, scope: PackageScope, cwd: string, host: ExtensionContext | undefined): Promise<void> {
		const generation = this.generation;
		const send = (event: string, data: Record<string, unknown>) => {
			if (generation !== this.generation) return;
			try {
				this.emit?.(event, data);
			} catch {
				/* the transport is gone; the job goes on */
			}
		};
		let sent = 0;
		let dropped = 0;
		const timer = setTimeout(() => job.controller.abort(new Error("Stopped: it ran past the time limit")), this.timeoutMs);
		timer.unref?.();
		let outcome: { ok: true } | { ok: false; error: string };
		try {
			outcome = await this.runner({
				action,
				source,
				scope,
				cwd,
				signal: job.controller.signal,
				onLine: (line) => {
					if (sent >= DESKTOP_PACKAGES_LIMITS.lines) {
						dropped += 1;
						return;
					}
					sent += 1;
					send("package_progress", { jobId: job.jobId, line });
				},
			});
		} catch (error) {
			outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			clearTimeout(timer);
			if (this.job === job) this.job = undefined;
		}
		if (dropped > 0) send("package_progress", { jobId: job.jobId, line: `… ${dropped} more lines` });
		const error = outcome.ok === false ? (outcome.error.slice(0, DESKTOP_PACKAGES_LIMITS.error) || "Failed") : undefined;
		send("package_finished", { jobId: job.jobId, ok: outcome.ok, ...(error === undefined ? {} : { error }) });
		if (outcome.ok && generation === this.generation) await this.reload(host, generation);
	}

	/** `/reload` once the agent is idle, as a user would after `gentle-shell install`: the session loads what changed. */
	private async reload(host: ExtensionContext | undefined, generation: number): Promise<void> {
		const command = host as (ExtensionContext & { waitForIdle?: () => Promise<void>; reload?: () => Promise<void> }) | undefined;
		try {
			if (typeof command?.reload !== "function") return;
			await command.waitForIdle?.();
			if (generation !== this.generation) return;
			await command.reload();
		} catch {
			/* a replaced session reloads on its own start */
		}
	}
}
