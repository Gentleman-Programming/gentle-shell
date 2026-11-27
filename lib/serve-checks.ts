// `GET /api/checks` for `gentle-shell serve` (`sessions:read`): whether this
// server has what its sessions need, the four rows Gentle Shell GPUI's own
// setup checklist shows (crates/app/src/features/setup: `extras.rs`,
// `gentle.rs`), with the same rules, so a device shows the server's setup the
// way it shows its own: Node.js (22.19.0 or newer, with npm), Git (not macOS's
// stub without the Command Line Tools), Engram (3.0.0 or newer; a broken
// `ENGRAM_BIN` override is reported) and the companion setup (the launcher's
// own `setup --check`). Each tool runs with a short timeout, all at once,
// never through a shell; one result is kept for `cacheMs`.

import { execFile } from "node:child_process";
import { constants as fsConstants, realpathSync } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { launcherConfigPath, parseRawLauncherConfig, provisionedEntry } from "./gentle-shell-launcher.ts";
import type { SessionLaunch } from "./serve-session.ts";

export const SERVE_CHECK_LIMITS = {
	/** How long one result answers every request. */
	cacheMs: 10_000,
	/** A tool's `--version` still running then is killed (and counts as not running). */
	toolTimeoutMs: 5_000,
	/** `gentle-shell setup --check` starts Node and reads the home. */
	companionTimeoutMs: 15_000,
	outputBytes: 64 * 1024,
	detail: 300,
};

/** gentle-pi `engines.node`, as the app's `MIN_NODE`. */
export const MIN_NODE: Version = [22, 19, 0];
/** gentle-engram accepts a stable Engram core from 3.0.0 (the app's `MIN_ENGRAM`). */
export const MIN_ENGRAM: Version = [3, 0, 0];

export type CheckId = "companion" | "node" | "git" | "engram";
export type CheckState = "ok" | "missing" | "error";

export interface ServeCheck {
	id: CheckId;
	state: CheckState;
	/** What was found, `X.Y.Z` (no `v`); the companion's is the Gentle AI it was set up with. */
	version: string | null;
	/** Why, in words; an outdated tool is an `error` that says what it needs. */
	detail: string | null;
}

export type Version = [number, number, number];

export interface ServeChecksOptions {
	/** The environment tools are looked up and run with (the server's). */
	env: NodeJS.ProcessEnv;
	/** `gentle-shell [home flags] setup --check --json` for this server's home; without it the companion row is an `error`. */
	companion?: () => SessionLaunch;
	/** The agent home the server serves (a `--link` home's `settings.json`, the setup marker's key). */
	agentHome?: string;
	/** The running Gentle Shell version, named when the setup was made by another one. */
	version?: string;
	platform?: NodeJS.Platform;
	limits?: Partial<typeof SERVE_CHECK_LIMITS>;
	now?: () => number;
}

/** `v22.19.0`, `22.19`, `3.0.0-beta`: the leading numbers, as the app's `parse_version`. */
export function parseVersion(text: string): Version | undefined {
	let rest = text.trim();
	if (rest.startsWith("go")) rest = rest.slice(2);
	if (rest.startsWith("v")) rest = rest.slice(1);
	const parts: Version = [0, 0, 0];
	let found = 0;
	for (const [i, part] of rest.split(".").slice(0, 3).entries()) {
		const digits = /^\d*/.exec(part)![0];
		if (digits === "") break;
		parts[i] = Number(digits);
		found = i + 1;
		if (digits.length !== part.length) break;
	}
	return found > 0 ? parts : undefined;
}

export function showVersion(version: Version): string {
	return version.join(".");
}

function older(a: Version, b: Version): boolean {
	for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
	return false;
}

/** An executable named `name` (a path, or looked up on `env`'s PATH with Windows' extensions), or undefined. */
export async function findProgram(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
	const windows = platform === "win32";
	const extensions = windows ? ["", ...(env.PATHEXT ?? env.Pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
	const runnable = async (path: string) => {
		try {
			if (!(await stat(path)).isFile()) return false;
			if (!windows) await access(path, fsConstants.X_OK);
			return true;
		} catch {
			return false;
		}
	};
	const candidates = (base: string) => extensions.map((ext) => base + ext);
	if (isAbsolute(name) || name.includes("/") || (windows && name.includes("\\"))) {
		for (const path of candidates(name)) if (await runnable(path)) return path;
		return undefined;
	}
	const pathVar = env.PATH ?? env.Path ?? "";
	for (const dir of pathVar.split(windows ? ";" : delimiter)) {
		if (dir === "") continue;
		for (const path of candidates(join(dir, name))) if (await runnable(path)) return path;
	}
	return undefined;
}

interface RunResult {
	/** Exit code 0 within the time limit. */
	ok: boolean;
	/** The exit code, when it exited by itself. */
	code: number | null;
	stdout: string;
}

function run(command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number; outputBytes: number }): Promise<RunResult> {
	const { promise, resolve } = Promise.withResolvers<RunResult>();
	execFile(command, args, { env: options.env, cwd: options.cwd ?? homedir(), timeout: options.timeoutMs, killSignal: "SIGKILL", maxBuffer: options.outputBytes, windowsHide: true, encoding: "utf8" },
		(error, stdout) => {
			const code = error ? (typeof error.code === "number" ? error.code : null) : 0;
			resolve({ ok: !error, code, stdout: typeof stdout === "string" ? stdout : "" });
		}).stdin?.end();
	return promise;
}

/** `settings.json` `packages` lists `name` (string or `{source}` entries, `npm:<name>[@version]`), as the app's `settings_list`. */
export function settingsList(settings: unknown, name: string): boolean {
	const packages = (settings as { packages?: unknown } | null)?.packages;
	if (!Array.isArray(packages)) return false;
	return packages.some((entry) => {
		const source = typeof entry === "string" ? entry : (entry as { source?: unknown } | null)?.source;
		if (typeof source !== "string" || !source.startsWith("npm:")) return false;
		const spec = source.slice(4);
		const at = spec.startsWith("@") ? spec.indexOf("@", 1) : spec.indexOf("@");
		return (at === -1 ? spec : spec.slice(0, at)) === name;
	});
}

export class ServeChecks {
	private readonly env: NodeJS.ProcessEnv;
	private readonly platform: NodeJS.Platform;
	private readonly limits: typeof SERVE_CHECK_LIMITS;
	private readonly now: () => number;
	private readonly companionLaunch?: () => SessionLaunch;
	private readonly agentHome?: string;
	private readonly version?: string;
	private cached?: { at: number; checks: Promise<ServeCheck[]> };

	constructor(options: ServeChecksOptions) {
		this.env = options.env;
		this.platform = options.platform ?? process.platform;
		this.limits = { ...SERVE_CHECK_LIMITS, ...options.limits };
		this.now = options.now ?? Date.now;
		this.companionLaunch = options.companion;
		this.agentHome = options.agentHome;
		this.version = options.version;
	}

	/** Every row, in the app's order; requests within `cacheMs` (and while one runs) share one result. */
	checks(): Promise<ServeCheck[]> {
		const now = this.now();
		if (this.cached && now - this.cached.at < this.limits.cacheMs) return this.cached.checks;
		const checks = Promise.all([this.node(), this.companion(), this.git(), this.engram()]);
		this.cached = { at: now, checks };
		return checks;
	}

	/** The next request runs the checks again (after a setup or upgrade job). */
	forget(): void {
		this.cached = undefined;
	}

	private tool(command: string, args: string[]): Promise<RunResult> {
		return run(command, args, { env: this.env, timeoutMs: this.limits.toolTimeoutMs, outputBytes: this.limits.outputBytes });
	}

	private row(id: CheckId, state: CheckState, version: string | null, detail: string | null): ServeCheck {
		const clip = (text: string | null) => (text === null || text.length <= this.limits.detail ? text : `${text.slice(0, this.limits.detail - 1)}…`);
		return { id, state, version: clip(version), detail: clip(detail) };
	}

	private async node(): Promise<ServeCheck> {
		const node = await findProgram("node", this.env, this.platform);
		if (!node) return this.row("node", "missing", null, "Node.js isn't installed");
		const result = await this.tool(node, ["--version"]);
		const text = result.stdout.trim();
		if (!result.ok) return this.row("node", "error", null, `${node} doesn't run`);
		const parsed = parseVersion(text);
		if (!parsed) return this.row("node", "error", null, `Unexpected \`node --version\`: ${text}`);
		const version = showVersion(parsed);
		if (older(parsed, MIN_NODE)) return this.row("node", "error", version, `Node ${version} — needs ${showVersion(MIN_NODE)} or newer`);
		const npm = await this.npm(node);
		return npm === undefined
			? this.row("node", "missing", version, `Node ${version} found, but not npm`)
			: this.row("node", "ok", version, `npm ${npm}`);
	}

	/** `npm --version`; on Windows npm is a `.cmd`, which only a shell runs, so its `npm-cli.js` runs under `node` instead. */
	private async npm(node: string): Promise<string | undefined> {
		const npm = await findProgram("npm", this.env, this.platform);
		if (!npm) return undefined;
		const result = this.platform === "win32" && /\.(cmd|bat)$/i.test(npm)
			? await this.tool(node, [join(dirname(npm), "node_modules", "npm", "bin", "npm-cli.js"), "--version"])
			: await this.tool(npm, ["--version"]);
		const version = result.stdout.trim();
		return result.ok && version !== "" ? version : undefined;
	}

	private async git(): Promise<ServeCheck> {
		const missing = this.row("git", "missing", null, "Git isn't installed");
		const git = await findProgram("git", this.env, this.platform);
		if (!git) return missing;
		// macOS's /usr/bin/git is a stub that offers the Command Line Tools until they are installed.
		if (this.platform === "darwin" && git === "/usr/bin/git" && !(await this.tool("/usr/bin/xcode-select", ["-p"])).ok) return missing;
		const result = await this.tool(git, ["--version"]);
		if (!result.ok) return missing;
		const version = result.stdout.trim().replace(/^git version /, "").trim();
		return this.row("git", "ok", version || null, null);
	}

	private async engram(): Promise<ServeCheck> {
		const override = this.env.ENGRAM_BIN;
		let engram: string | undefined;
		if (override) {
			engram = await findProgram(override, this.env, this.platform);
			if (!engram) return this.row("engram", "error", null, `ENGRAM_BIN points to ${override}, which can't be run. Fix or remove it.`);
		} else {
			engram = await findProgram("engram", this.env, this.platform);
		}
		const result = engram ? await this.tool(engram, ["version"]) : undefined;
		if (!result?.ok) return this.row("engram", "missing", null, "Not installed");
		// `engram 1.18.0`, then maybe an update notice: the first line's last word.
		const line = result.stdout.trim().split(/\r?\n/, 1)[0].trim() || "installed";
		const word = line.split(/\s+/).at(-1) ?? "";
		const parsed = parseVersion(word);
		if (parsed && older(parsed, MIN_ENGRAM)) {
			return this.row("engram", "error", showVersion(parsed), `Engram ${showVersion(parsed)} — needs ${showVersion(MIN_ENGRAM)} or newer`);
		}
		return this.row("engram", "ok", parsed ? showVersion(parsed) : null, line);
	}

	/** The launcher's own `setup --check --json` for this home; a `--link` home is set up once it lists gentle-engram. */
	private async companion(): Promise<ServeCheck> {
		if (!this.companionLaunch) return this.row("companion", "error", null, "This server can't check its setup");
		const launch = this.companionLaunch();
		const result = await run(launch.command, launch.args, { env: launch.env, cwd: launch.cwd, timeoutMs: this.limits.companionTimeoutMs, outputBytes: this.limits.outputBytes });
		let report: { needsSetup?: unknown; reasons?: unknown; home?: { mode?: unknown }; error?: unknown } | undefined;
		try {
			report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "");
		} catch { /* reported below */ }
		if (!report || typeof report !== "object" || (result.code !== 0 && result.code !== 1)) {
			const why = typeof report?.error === "string" ? report.error : result.code === null ? "it didn't finish" : `it exited with ${result.code}`;
			return this.row("companion", "error", null, `\`gentle-shell setup --check\` failed: ${why}`);
		}
		const home = this.agentHome;
		if (report.home?.mode === "link" && home !== undefined) {
			let settings: unknown;
			try { settings = JSON.parse(await readFile(join(home, "settings.json"), "utf8")); } catch { /* not set up */ }
			return settingsList(settings, "gentle-engram")
				? this.row("companion", "ok", null, `Linked to ${home}`)
				: this.row("companion", "missing", null, `${home} isn't set up yet`);
		}
		const entry = await this.marker();
		if (report.needsSetup === false) return this.row("companion", "ok", entry?.gentleAi ?? null, entry ? `Set up ${entry.at.slice(0, 10)}` : null);
		const reasons = Array.isArray(report.reasons) ? report.reasons : [];
		if (!entry || reasons.includes("never-provisioned")) return this.row("companion", "missing", null, "Not set up yet — the first chat would do it silently");
		if (reasons.includes("gentle-ai-changed")) return this.row("companion", "error", entry.gentleAi, `Set up with Gentle AI ${entry.gentleAi}`);
		return this.row("companion", "error", entry.gentleAi,
			`Set up with gentle-pi ${entry.gentlePi ?? "an older version"}; ${this.version ?? "another version"} is installed`);
	}

	/** This home's setup record in the launcher config (`GENTLE_SHELL_CONFIG`, else `~/.gentle-shell/config.json`). */
	private async marker(): Promise<{ gentleAi: string; gentlePi?: string; at: string } | undefined> {
		if (this.agentHome === undefined) return undefined;
		const path = this.env.GENTLE_SHELL_CONFIG || launcherConfigPath(homedir());
		let text: string | undefined;
		try { text = await readFile(path, "utf8"); } catch { return undefined; }
		let key = this.agentHome;
		try { key = realpathSync(key); } catch { /* as given */ }
		return provisionedEntry(parseRawLauncherConfig(text), key);
	}
}
