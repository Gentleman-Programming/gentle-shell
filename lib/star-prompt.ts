import { execFile as nodeExecFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { gentlePiConfigHome } from "./agent-home.ts";

export const STAR_PROMPT_SCHEMA = "gentle-shell.star-prompt/v1";
export const STAR_PROMPT_FILE = "star-prompt.json";
/** Both Gentleman-Programming repos get the star: the one in use and its sibling. */
export const STAR_PROMPT_REPOSITORIES = ["Gentleman-Programming/gentle-shell", "Gentleman-Programming/gentle-ai"] as const;
export const STAR_PROMPT_REPOSITORY_URLS = STAR_PROMPT_REPOSITORIES.map((repository) => `https://github.com/${repository}`);
/** Prompts 1..N stay silent; the offer may appear from N+1 on (t3code parity). */
export const PROMPTS_BEFORE_ASKING = 5;
/** Idle wait before offering, so the nudge never interrupts active typing. */
export const STAR_PROMPT_IDLE_MS = 30_000;
/** How long the footer offer stays visible without an answer. */
export const STAR_PROMPT_VISIBLE_MS = 5 * 60_000;

/** Raw terminal byte for Ctrl+G (the star chord; no editor text collides with a control byte). */
export const STAR_CHORD = "\x07";
/** Raw terminal byte for Alt+D (the dismiss chord). */
export const DISMISS_CHORD = "\x1bd";

export interface StarPromptState {
	schema: string;
	/** Interactive prompts sent across all sessions. */
	sent: number;
	/** Set by any dismissal; once true the prompt never asks again. */
	dismissed: boolean;
	/** Opt-in (default false): the star chord uses stored gh credentials instead of opening the browser. */
	directStar: boolean;
}

export const DEFAULT_STAR_PROMPT_STATE: StarPromptState = {
	schema: STAR_PROMPT_SCHEMA,
	sent: 0,
	dismissed: false,
	directStar: false,
};

export interface StarPromptStateRead {
	state: StarPromptState;
	/** Unreadable or malformed state: fail closed and never ask (a dismissal could not have been saved). */
	unusable: boolean;
	malformed: boolean;
	readError: boolean;
	file: string;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStarPromptState(value: unknown): value is StarPromptState {
	if (!record(value) || value.schema !== STAR_PROMPT_SCHEMA) return false;
	return (
		typeof value.sent === "number" && Number.isInteger(value.sent) && value.sent >= 0 &&
		typeof value.dismissed === "boolean" &&
		typeof value.directStar === "boolean"
	);
}

export function starPromptStateFile(configHome: string): string {
	return join(configHome, STAR_PROMPT_FILE);
}

export function readStarPromptState(configHome: string, readFile: typeof readFileSync = readFileSync): StarPromptStateRead {
	const file = starPromptStateFile(configHome);
	const result: StarPromptStateRead = { state: { ...DEFAULT_STAR_PROMPT_STATE }, unusable: false, malformed: false, readError: false, file };
	let raw: string;
	try {
		raw = readFile(file, "utf8");
	} catch (error) {
		// A missing file is a fresh install, not an error; anything else unreadable is unusable.
		const code = record(error) && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code !== "ENOENT") {
			result.readError = true;
			result.unusable = true;
		}
		return result;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isStarPromptState(parsed)) {
			result.malformed = true;
			result.unusable = true;
			return result;
		}
		result.state = parsed;
		return result;
	} catch {
		result.malformed = true;
		result.unusable = true;
		return result;
	}
}

/** Writes the state atomically enough for a single-user config dir; a failed write must disable asking. */
export function writeStarPromptState(configHome: string, state: StarPromptState, writeFile: typeof writeFileSync = writeFileSync, mkdir: typeof mkdirSync = mkdirSync): void {
	mkdir(configHome, { recursive: true });
	writeFileSync(starPromptStateFile(configHome), `${JSON.stringify(state, null, "\t")}\n`, "utf8");
}

/** Pure gate: the full set of reasons the offer may appear right now. */
export function shouldOfferStarPrompt(input: { sent: number; dismissed: boolean; unusable: boolean; offeredThisSession: boolean; agentRunning: boolean }): boolean {
	if (input.unusable || input.dismissed || input.offeredThisSession || input.agentRunning) return false;
	return input.sent > PROMPTS_BEFORE_ASKING;
}

export function matchesStarPromptChord(data: string, chord: string): boolean {
	return data === chord;
}

export type GhOutcome = "yes" | "no" | "unknown";

export interface GhDeps {
	exec?: typeof nodeExecFile;
	ghPath?: string;
	repositories?: readonly string[];
}

function execGh(deps: GhDeps, args: readonly string[]): Promise<{ code: number; stderr: string }> {
	const exec = deps.exec ?? nodeExecFile;
	return new Promise((resolve) => {
		exec(deps.ghPath ?? "gh", [...args], { timeout: 15_000 }, (error, _stdout, stderr) => {
			// execFile passes null (not undefined) on success; both mean exit 0.
			const rawCode: unknown = error == null ? 0 : (error as NodeJS.ErrnoException).code;
			const code = typeof rawCode === "number" ? rawCode : 1;
			resolve({ code, stderr: typeof stderr === "string" ? stderr : "" });
		});
	});
}

/** Resolves whether the authenticated gh account has starred every repository;
 * unknown on any ambiguity (the PUT is idempotent, so partial knowledge is fine). */
export async function ghStarred(deps: GhDeps = {}): Promise<GhOutcome> {
	let sawUnknown = false;
	for (const repository of deps.repositories ?? STAR_PROMPT_REPOSITORIES) {
		const { code, stderr } = await execGh(deps, ["api", `user/starred/${repository}`]);
		if (code === 0) continue;
		if (stderr.includes("HTTP 404")) return "no";
		sawUnknown = true;
	}
	return sawUnknown ? "unknown" : "yes";
}

/** Stars every repository with the authenticated gh account; each PUT is an
 * idempotent no-op when already starred. */
export async function ghStar(deps: GhDeps = {}): Promise<GhOutcome> {
	for (const repository of deps.repositories ?? STAR_PROMPT_REPOSITORIES) {
		const { code, stderr } = await execGh(deps, ["api", "--method", "PUT", `user/starred/${repository}`]);
		if (code !== 0 && !stderr.includes("HTTP 404")) return "unknown";
	}
	return "yes";
}

type SpawnedChild = {
	once(event: "spawn", listener: () => void): unknown;
	once(event: "error", listener: (error: Error) => void): unknown;
	unref(): void;
};

export interface OpenRepositoryDeps {
	platform?: NodeJS.Platform;
	spawn?: (command: string, args: readonly string[], options: Record<string, unknown>) => SpawnedChild;
	env?: NodeJS.ProcessEnv;
}

export type OpenRepositoryResult = { opened: boolean; error?: string };

/** Fixed per-platform opener, always spawned with shell:false and an absolute path where Windows needs one. */
function openerFor(platform: NodeJS.Platform, url: string, env: NodeJS.ProcessEnv): { command: string; args: string[] } | string {
	if (platform === "darwin") return { command: "/usr/bin/open", args: [url] };
	if (platform === "win32") {
		// Absolute path: Windows would otherwise search the current directory first.
		const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
		if (typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot)) return "SystemRoot is not set to an absolute path";
		return { command: win32.join(systemRoot, "System32", "rundll32.exe"), args: ["url.dll,FileProtocolHandler", url] };
	}
	return { command: "xdg-open", args: [url] };
}

/** Opens the repository URL in the default browser; resolves instead of throwing when that is impossible. */
export function openRepositoryInBrowser(url: string, deps: OpenRepositoryDeps = {}): Promise<OpenRepositoryResult> {
	const opener = openerFor(deps.platform ?? process.platform, url, deps.env ?? process.env);
	if (typeof opener === "string") return Promise.resolve({ opened: false, error: opener });
	const spawn = deps.spawn ?? (nodeSpawn as unknown as NonNullable<OpenRepositoryDeps["spawn"]>);
	return new Promise((resolve) => {
		let child: SpawnedChild;
		try {
			child = spawn(opener.command, opener.args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
		} catch (error) {
			resolve({ opened: false, error: error instanceof Error ? error.message : String(error) });
			return;
		}
		child.once("error", (error) => resolve({ opened: false, error: error.message }));
		child.once("spawn", () => resolve({ opened: true }));
		child.unref();
	});
}
