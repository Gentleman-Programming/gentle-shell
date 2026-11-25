// Gentle Tower startup shared by `/gentle:tower` (inside a session) and
// `gentle-shell tower` (standalone): same hub, same built web app, same
// localhost-only server with a fresh token, same "new floor" launcher.

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { towerHubDir } from "./tower-hub.ts";
import { launchInTerminal } from "./tower-launch.ts";
import { defaultPresenceDirs } from "./tower-presence.ts";
import { startTowerServer, type TowerServer } from "./tower-server.ts";

// lib/ and its generated runtime/ copy both sit one level under the package root.
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TOWER_WEB_DIR = join(PACKAGE_ROOT, "web", "tower", "dist");
const LAUNCHER = join(PACKAGE_ROOT, "bin", "gentle-shell.mjs");

export class TowerNotBuiltError extends Error {
	constructor(webDir: string) {
		super(`Gentle Tower: the web app is not built (${webDir}). Run: pnpm build:tower`);
		this.name = "TowerNotBuiltError";
	}
}

export interface OpenTowerOptions {
	/** Built web app folder (defaults to the package's web/tower/dist). */
	webDir?: string;
	/** Fixed port; still bound to 127.0.0.1. Random when absent. */
	port?: number;
	/** Peer presence registries (defaults to the user's). */
	presenceDirs?: readonly string[];
}

export function openTowerServer(env: NodeJS.ProcessEnv, options: OpenTowerOptions = {}): Promise<TowerServer> {
	const webDir = options.webDir ?? TOWER_WEB_DIR;
	if (!existsSync(join(webDir, "index.html"))) return Promise.reject(new TowerNotBuiltError(webDir));
	return startTowerServer({
		hubDir: towerHubDir(env),
		webDir,
		token: randomBytes(24).toString("base64url"),
		engramUrl: env.ENGRAM_URL || "http://127.0.0.1:7437",
		presenceDirs: options.presenceDirs ?? defaultPresenceDirs(),
		...(options.port === undefined ? {} : { port: options.port }),
		onNewFloor: (cwd, prompt) => launchInTerminal({ cwd, node: process.execPath, launcher: LAUNCHER, ...(prompt ? { prompt } : {}) }),
	});
}

export function openInBrowser(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	try {
		const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
		child.on("error", () => { /* the URL is also shown */ });
		child.unref();
	} catch { /* the URL is also shown */ }
}

function untilSignal(): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			process.off("SIGINT", done);
			process.off("SIGTERM", done);
			resolve();
		};
		process.on("SIGINT", done);
		process.on("SIGTERM", done);
	});
}

export interface RunTowerOptions extends OpenTowerOptions {
	env: NodeJS.ProcessEnv;
	open: boolean;
	/** Print one `gentle-shell.tower/v1` JSON line instead of the text lines. */
	json?: boolean;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	openUrl?: (url: string) => void;
	/** Resolves when the tower should stop (defaults to SIGINT/SIGTERM). */
	untilStopped?: (server: TowerServer) => Promise<void>;
}

/** The schema of `gentle-shell tower --json`'s one stdout line. */
export const TOWER_JSON_SCHEMA = "gentle-shell.tower/v1";

/** `gentle-shell tower`: serve until stopped; returns the exit code. */
export async function runTower(options: RunTowerOptions): Promise<number> {
	let server: TowerServer;
	try {
		server = await openTowerServer(options.env, options);
	} catch (error) {
		const message = error instanceof TowerNotBuiltError ? error.message : `Gentle Tower could not start: ${error instanceof Error ? error.message : String(error)}`;
		options.stderr(`${message}\n`);
		return 1;
	}
	try {
		options.stdout(options.json
			? `${JSON.stringify({ schema: TOWER_JSON_SCHEMA, url: server.url, host: server.host, port: server.port })}\n`
			: `Gentle Tower: ${server.url}\nPress Ctrl+C to stop.\n`);
		if (options.open) (options.openUrl ?? openInBrowser)(server.url);
		await (options.untilStopped ?? untilSignal)(server);
	} finally {
		await server.close();
	}
	return 0;
}
