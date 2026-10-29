import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { runningBundledPrefix } from "../lib/gentle-shell-bundled.ts";

// Gentle Music: /gentle:music hands the whole terminal to gentle-stream's own
// TUI, the way Pi's external editor (ctrl+g) does: stop Pi's TUI, run the
// child with inherited stdio, then restart Pi and force a full repaint.
// gentle-stream's `b` returns to Pi with the music still playing (a background
// player owns the audio); `q` stops it. Single control words run
// `gentle-stream ctl …` with captured output and never take the terminal.
//
// Runtime imports stay node-only so the command loads without Pi's packages.
//
// A bundled Gentle Shell without any player offers to install one inside its
// own folder (scripts/bundled-install.mjs installMusicPlayer): the pinned uv,
// a uv-managed Python 3.13 and gentle-stream, all under the prefix. Other
// installs keep the manual hint.

export const MUSIC_COMMAND_NAME = "gentle:music";
export const GENTLE_STREAM_SPEC = "gentle-stream[samples] @ git+https://github.com/Gentleman-Programming/gentle-stream";
export const MUSIC_CONTROL_COMMANDS = ["next", "pause", "play", "stop", "status"] as const;
export type MusicControlCommand = (typeof MUSIC_CONTROL_COMMANDS)[number];

export const MUSIC_INSTALL_TITLE = "Install the music player?";
export const MUSIC_INSTALL_OFFER = "Install the gentle-stream music player inside Gentle Shell? It downloads uv, Python 3.13 and the player (about 150 MB) into the Gentle Shell folder.";
// gentle-stream needs POSIX (fcntl locks, an AF_UNIX control socket, process
// groups), so a native Windows Pi can neither install nor run it; WSL is Linux.
export const MUSIC_WINDOWS_UNSUPPORTED = "/gentle:music is not available on Windows yet: the gentle-stream player runs on macOS and Linux. It works when Gentle Shell runs inside WSL.";
const UV_INSTALL_URL = "https://docs.astral.sh/uv/getting-started/installation/";
const CTL_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const CTL_STDIO = ["ignore", "pipe", "pipe"] as const;
const CTL_DONE: Record<Exclude<MusicControlCommand, "status">, string> = {
	next: "♪ next track",
	pause: "♪ paused",
	play: "♪ playing",
	stop: "♪ music stopped",
};

/** How to run gentle-stream: the executable plus the arguments that precede gentle-stream's own. */
export interface GentleStreamCommand {
	command: string;
	prefix: string[];
}

export type MusicWhich = (name: string) => string | undefined;

/** The slice of a spawned child /gentle:music reads; `node:child_process` satisfies it. */
export interface MusicChild {
	on(event: "error", listener: (error: Error) => void): unknown;
	on(event: "close", listener: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
	stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
	stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
	kill(signal?: NodeJS.Signals): boolean;
}

export type MusicSpawn = (command: string, args: readonly string[], options: { stdio: "inherit" | typeof CTL_STDIO }) => MusicChild;

export interface MusicSignals {
	on(signal: "SIGINT", listener: () => void): unknown;
	off(signal: "SIGINT", listener: () => void): unknown;
}

/** Whether this Pi process used /gentle:music; shared across reloads so quitting still stops the music. */
export interface MusicUsage {
	used: boolean;
}

/** The slice of Pi's TUI the handover drives. */
interface TerminalOwner {
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
}

/** The player a bundled Gentle Shell installs inside its prefix on request. */
export interface BundledMusicPlayer {
	gentleStream: string;
	installed(): boolean;
	install(progress: (line: string) => void): Promise<{ gentleStream: string; samples: boolean }>;
}

export interface GentleMusicDeps {
	which?: MusicWhich;
	/** The bundled install's player, or undefined outside a bundled install. */
	bundled?: () => Promise<BundledMusicPlayer | undefined>;
	/** The platform Pi runs on; gentle-stream does not run on native Windows. */
	platform?: NodeJS.Platform;
	spawn?: MusicSpawn;
	signals?: MusicSignals;
	usage?: MusicUsage;
	shutdownTimeoutMs?: number;
}

/** First executable named `name` on PATH, honoring PATHEXT on Windows. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
	const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((entry) => entry.length > 0);
	// Without a shell only real executables start on Windows: .cmd/.bat shims would fail to spawn.
	const extensions = platform === "win32"
		? (env.PATHEXT || ".COM;.EXE").split(";").filter((extension) => /^\.(com|exe)$/i.test(extension))
		: [""];
	for (const dir of dirs) {
		for (const extension of extensions) {
			const candidate = join(dir, name + extension);
			try {
				if (!statSync(candidate).isFile()) continue;
				if (platform !== "win32") accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Missing or not executable: keep looking.
			}
		}
	}
	return undefined;
}

/** gentle-stream on PATH, else the one installed inside the bundled prefix, else the published spec through uvx, else through `uv tool run`. */
export function resolveGentleStream(which: MusicWhich, bundledPlayer?: string): GentleStreamCommand | undefined {
	const installed = which("gentle-stream");
	if (installed) return { command: installed, prefix: [] };
	if (bundledPlayer) return { command: bundledPlayer, prefix: [] };
	const uvx = which("uvx");
	if (uvx) return { command: uvx, prefix: ["--from", GENTLE_STREAM_SPEC, "gentle-stream"] };
	const uv = which("uv");
	if (uv) return { command: uv, prefix: ["tool", "run", "--from", GENTLE_STREAM_SPEC, "gentle-stream"] };
	return undefined;
}

export function installHint(): string {
	return `/gentle:music needs gentle-stream, and neither gentle-stream nor uv is on PATH. Install uv (${UV_INSTALL_URL}) and run /gentle:music again, or install gentle-stream with: uv tool install '${GENTLE_STREAM_SPEC}'`;
}

export type MusicRequest = { kind: "tui"; mood?: string } | { kind: "ctl"; command: MusicControlCommand };

/** Only an exact single control word is a subcommand; any other text is a mood. */
export function parseMusicArgs(args: string): MusicRequest {
	const text = args.trim();
	if (!text) return { kind: "tui" };
	if ((MUSIC_CONTROL_COMMANDS as readonly string[]).includes(text)) return { kind: "ctl", command: text as MusicControlCommand };
	return { kind: "tui", mood: text };
}

/** gentle-stream's own flags: the session model as `provider/id` and the mood as one argument. */
export function musicTuiArgs(input: { model: { provider?: unknown; id?: unknown } | undefined; mood?: string }): string[] {
	const args: string[] = [];
	const { provider, id } = input.model ?? {};
	if (typeof provider === "string" && provider && typeof id === "string" && id) args.push("--model", `${provider}/${id}`);
	if (input.mood) args.push("--mood", input.mood);
	return args;
}

/** One line from `gentle-stream ctl status` JSON; undefined when it is not that JSON. */
export function formatMusicStatus(stdout: string): string | undefined {
	let status: unknown;
	try {
		status = JSON.parse(stdout.trim());
	} catch {
		return undefined;
	}
	if (!status || typeof status !== "object" || Array.isArray(status)) return undefined;
	const { running, playing, name, genre } = status as Record<string, unknown>;
	if (running !== true) return "nothing is playing";
	const parts = [name, genre].filter((part): part is string => typeof part === "string" && part.length > 0);
	return `♪ ${[...parts, playing === true ? "playing" : "paused"].join(" · ")}`;
}

/** The running bundled install's player (GENTLE_SHELL_PREFIX, checked by runningBundledPrefix). */
async function defaultBundled(): Promise<BundledMusicPlayer | undefined> {
	const prefix = runningBundledPrefix(process.env);
	if (prefix === undefined) return undefined;
	const { installMusicPlayer, installedMusicPlayer, prefixLayout } = await import("../scripts/bundled-install.mjs");
	const layout = prefixLayout({ platform: process.platform, env: process.env, home: homedir(), root: prefix });
	return {
		gentleStream: layout.gentleStream,
		installed: () => installedMusicPlayer(layout),
		install: async (progress) => {
			const result = await installMusicPlayer({ layout, platform: process.platform, arch: process.arch, env: process.env, out: progress });
			return { gentleStream: result.gentleStream, samples: result.samples };
		},
	};
}

const defaultSpawn: MusicSpawn = (command, args, options) => nodeSpawn(command, [...args], { stdio: options.stdio === "inherit" ? "inherit" : [...options.stdio] });
const defaultSignals: MusicSignals = { on: (signal, listener) => process.on(signal, listener), off: (signal, listener) => process.off(signal, listener) };
const USAGE_KEY = Symbol.for("gentle-pi.gentle-music.usage");

function processUsage(): MusicUsage {
	const holder = globalThis as { [USAGE_KEY]?: MusicUsage };
	return (holder[USAGE_KEY] ??= { used: false });
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type InheritResult = { code: number | null; signal?: NodeJS.Signals | null } | { error: unknown };

function runInherit(spawn: MusicSpawn, command: string, args: readonly string[]): Promise<InheritResult> {
	return new Promise((resolve) => {
		try {
			const child = spawn(command, args, { stdio: "inherit" });
			child.on("error", (error) => resolve({ error }));
			child.on("close", (code, signal) => resolve({ code, signal }));
		} catch (error) {
			resolve({ error });
		}
	});
}

type CapturedResult = { code: number | null; stdout: string; stderr: string } | { error: unknown };

function runCaptured(spawn: MusicSpawn, command: string, args: readonly string[], timeoutMs: number): Promise<CapturedResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: CapturedResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		let child: MusicChild;
		try {
			child = spawn(command, args, { stdio: CTL_STDIO });
		} catch (error) {
			resolve({ error });
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
			finish({ error: new Error(`timed out after ${timeoutMs} ms`) });
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", (error) => finish({ error }));
		child.on("close", (code) => finish({ code, stdout, stderr }));
	});
}

/** Pi's external-editor handover: stop the TUI, run the child, and always restart with a full repaint. */
async function handOverTerminal<T>(tui: TerminalOwner, signals: MusicSignals, run: () => Promise<T>): Promise<T> {
	// Ctrl+C belongs to the child while it owns the terminal (Pi's ctrl+z suspend does the same).
	const ignoreSigint = () => {};
	signals.on("SIGINT", ignoreSigint);
	try {
		tui.stop();
		return await run();
	} finally {
		signals.off("SIGINT", ignoreSigint);
		tui.start();
		tui.requestRender(true);
	}
}

export default function gentleMusic(pi: ExtensionAPI, deps: GentleMusicDeps = {}): void {
	const which = deps.which ?? ((name: string) => findOnPath(name));
	const spawn = deps.spawn ?? defaultSpawn;
	const signals = deps.signals ?? defaultSignals;
	const usage = deps.usage ?? processUsage();
	const shutdownTimeoutMs = deps.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
	const bundled = deps.bundled ?? defaultBundled;
	const platform = deps.platform ?? process.platform;

	const findPlayer = async (): Promise<{ stream?: GentleStreamCommand; offer?: BundledMusicPlayer }> => {
		let player: BundledMusicPlayer | undefined;
		try {
			player = await bundled();
		} catch {
			player = undefined;
		}
		const stream = resolveGentleStream(which, player?.installed() ? player.gentleStream : undefined);
		return stream ? { stream } : { offer: player };
	};

	/** The bundled offer: undefined when declined or failed (after telling the user). */
	const offerInstall = async (ctx: ExtensionContext, player: BundledMusicPlayer): Promise<GentleStreamCommand | undefined> => {
		if ((await ctx.ui.confirm(MUSIC_INSTALL_TITLE, MUSIC_INSTALL_OFFER)) !== true) {
			ctx.ui.notify(installHint(), "warning");
			return undefined;
		}
		try {
			const result = await player.install((line) => ctx.ui.notify(line, "info"));
			ctx.ui.notify(result.samples
				? "♪ gentle-stream installed inside Gentle Shell."
				: "♪ gentle-stream installed inside Gentle Shell without the sample voices (they need the system FluidSynth library).", "info");
			return { command: result.gentleStream, prefix: [] };
		} catch (error) {
			ctx.ui.notify(`/gentle:music could not install gentle-stream: ${errorMessage(error)}`, "error");
			return undefined;
		}
	};

	const openTui = async (ctx: ExtensionContext, stream: GentleStreamCommand, mood: string | undefined) => {
		const args = [...stream.prefix, ...musicTuiArgs({ model: ctx.model, mood })];
		const result = await ctx.ui.custom<InheritResult>((tui, _theme, _keybindings, done) => {
			// A failing handover must still settle the custom UI, or Pi would wait for it forever.
			void handOverTerminal(tui, signals, () => runInherit(spawn, stream.command, args)).then(done, (error: unknown) => done({ error }));
			// The editor slot stays empty while the child owns the terminal.
			const placeholder: Component = { render: () => [], invalidate: () => {} };
			return placeholder;
		});
		if ("error" in result) ctx.ui.notify(`/gentle:music could not start gentle-stream: ${errorMessage(result.error)}`, "error");
		else if (result.code !== 0) ctx.ui.notify(result.code === null ? `gentle-stream was stopped by ${result.signal ?? "a signal"}.` : `gentle-stream exited with code ${result.code}.`, "error");
	};

	const control = async (ctx: ExtensionContext, stream: GentleStreamCommand, command: MusicControlCommand) => {
		const result = await runCaptured(spawn, stream.command, [...stream.prefix, "ctl", command], CTL_TIMEOUT_MS);
		if ("error" in result) {
			ctx.ui.notify(`gentle-stream ctl ${command} failed: ${errorMessage(result.error)}`, "error");
			return;
		}
		if (result.code !== 0) {
			const reason = result.stderr.trim().split("\n")[0] || `gentle-stream ctl ${command} exited with code ${result.code}`;
			ctx.ui.notify(reason, "warning");
			return;
		}
		if (command !== "status") {
			ctx.ui.notify(CTL_DONE[command], "info");
			return;
		}
		const summary = formatMusicStatus(result.stdout);
		if (summary) ctx.ui.notify(summary, "info");
		else ctx.ui.notify(`gentle-stream status was not readable: ${result.stdout.trim().split("\n")[0] ?? ""}`, "warning");
	};

	pi.registerCommand(MUSIC_COMMAND_NAME, {
		description: "Open gentle-stream full screen (optional mood text); b returns with the music playing, q stops it. next, pause, play, stop, status control the music without leaving Pi.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (platform === "win32") {
				ctx.ui.notify(MUSIC_WINDOWS_UNSUPPORTED, "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/gentle:music needs the interactive terminal.", "warning");
				return;
			}
			const found = await findPlayer();
			let stream = found.stream;
			if (!stream && found.offer) stream = await offerInstall(ctx, found.offer);
			else if (!stream) ctx.ui.notify(installHint(), "warning");
			if (!stream) return;
			usage.used = true;
			const request = parseMusicArgs(args);
			if (request.kind === "ctl") await control(ctx, stream, request.command);
			else await openTui(ctx, stream, request.mood);
		},
	});

	// Quitting Pi stops music it started, so no audio outlives the shell.
	// Switching or reloading sessions keeps the same process, so the music plays on.
	pi.on("session_shutdown", async (event) => {
		if ((event as { reason?: string }).reason !== "quit" || !usage.used) return;
		const { stream } = await findPlayer();
		if (!stream) return;
		usage.used = false;
		await runCaptured(spawn, stream.command, [...stream.prefix, "ctl", "stop"], shutdownTimeoutMs);
	});
}
