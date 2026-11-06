#!/usr/bin/env node
// Launches the real Gentle Shell TUI in a headless terminal on a FORK of an
// existing session and saves PNG screenshots, so an agent can look at what the
// shell actually renders.
//
//   node scripts/shell-snapshot.mjs --session <session.jsonl> [--cols 180] [--rows 50]
//     [--out <dir>] [--wait <seconds>] [--cwd <dir>]
//   node scripts/shell-snapshot.mjs --latest-rich [--from <project-dir>] [...same options]
//
// --latest-rich picks the newest session of <project-dir> (default: --cwd) that
// has both todo and subagent_run calls, from ~/.gentle-shell/agent/sessions.
//
// The terminal is ttyd (xterm.js) rendered by headless Chrome, driven over the
// DevTools protocol with Node's built-in WebSocket. vhs uses the same stack but
// vhs 0.12.0 silently skips rendering (no PNG, no GIF) on this setup, so the
// script drives ttyd and Chrome itself. Requires `ttyd` and Google Chrome
// (override with CHROME_BIN).
//
// The source session is never resumed or written: the shell is started with
// `--fork <session> --session-dir <scratch>/sessions`, so the fork lands in a
// fresh /tmp/gentle-eyes.* scratch directory.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(repoRoot, "bin", "gentle-shell.mjs");
// Pi stores a project's sessions under `--<absolute path with / as ->--`.
const sessionsDirFor = (projectDir) => join(homedir(), ".gentle-shell", "agent", "sessions", `--${resolve(projectDir).replace(/^\//, "").replaceAll("/", "-")}--`);
const chromeCandidates = [
	process.env.CHROME_BIN,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
].filter(Boolean);

const FONT_SIZE = 15;
// Menlo first, then fonts that carry the Braille logo and Nerd Font icons.
const FONT_FAMILY = "Menlo, 'Apple Braille', 'Apple Symbols', 'IosevkaTerm Nerd Font', monospace";
// Dark palette close to the Gentleman terminal theme (xterm.js ITheme keys).
const THEME = {
	background: "#06080f",
	foreground: "#f3f6f9",
	cursor: "#e0c15a",
	selectionBackground: "#263356",
	black: "#06080f",
	red: "#cb7c94",
	green: "#b7cc85",
	yellow: "#ffe066",
	blue: "#7fb4ca",
	magenta: "#ff8dd7",
	cyan: "#7aa89f",
	white: "#f3f6f9",
	brightBlack: "#8a8fa3",
	brightRed: "#de8fa8",
	brightGreen: "#d1e8a9",
	brightYellow: "#fff7b1",
	brightBlue: "#a3d4d5",
	brightMagenta: "#ffaeeb",
	brightCyan: "#a3d4d5",
	brightWhite: "#ffffff",
};

function usage(message) {
	if (message) console.error(`error: ${message}`);
	console.error("usage: node scripts/shell-snapshot.mjs (--session <file.jsonl> | --latest-rich [--from <project-dir>]) [--cols 180] [--rows 50] [--out <dir>] [--wait <seconds>] [--cwd <dir>]");
	process.exit(2);
}

function parseArgs(argv) {
	const options = { session: undefined, latestRich: false, from: undefined, cols: 180, rows: 50, out: undefined, wait: 12, cwd: repoRoot };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = () => {
			const next = argv[i + 1];
			if (next === undefined) usage(`${arg} requires a value`);
			i += 1;
			return next;
		};
		const number = () => {
			const parsed = Number(value());
			if (!Number.isFinite(parsed) || parsed <= 0) usage(`${arg} requires a positive number`);
			return parsed;
		};
		if (arg === "--session") options.session = resolve(value());
		else if (arg === "--latest-rich") options.latestRich = true;
		else if (arg === "--from") options.from = resolve(value());
		else if (arg === "--cols") options.cols = Math.floor(number());
		else if (arg === "--rows") options.rows = Math.floor(number());
		else if (arg === "--out") options.out = resolve(value());
		else if (arg === "--wait") options.wait = number();
		else if (arg === "--cwd") options.cwd = resolve(value());
		else if (arg === "--help" || arg === "-h") usage();
		else usage(`unknown argument ${arg}`);
	}
	if (options.session && options.latestRich) usage("use either --session or --latest-rich, not both");
	if (!options.session && !options.latestRich) usage("--session or --latest-rich is required");
	if (options.from && !options.latestRich) usage("--from only applies to --latest-rich");
	return options;
}

// Most recently modified session that has both todo and subagent_run tool calls.
function findLatestRichSession(projectDir) {
	const richSessionsDir = sessionsDirFor(projectDir);
	if (!existsSync(richSessionsDir)) usage(`sessions directory not found: ${richSessionsDir}`);
	const candidates = readdirSync(richSessionsDir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(richSessionsDir, name))
		.map((path) => ({ path, mtime: statSync(path).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	for (const { path } of candidates) {
		const text = readFileSync(path, "utf8");
		if (text.includes('"name":"todo"') && text.includes('"name":"subagent_run"')) return path;
	}
	usage(`no session with both todo and subagent_run calls under ${richSessionsDir}`);
}

const shellQuote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;

// When this runs inside a Pi/Gentle Shell session (e.g. from an agent), the
// inherited PI_*, GENTLE_*, and HERDR_* variables would make the snapshot shell
// act as a subagent child (no sidebar rail) and report into the caller's pane.
// Start it like a fresh user terminal instead.
const INHERITED_SESSION_ENV = /^(PI_|GENTLE_PI_|GENTLE_SHELL_|HERDR_|TERM_PROGRAM|CLAUDE_AGENT_SDK|AI_AGENT$)/;
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !INHERITED_SESSION_ENV.test(key)));

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolvePort(port));
		});
	});
}

async function waitFor(check, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await check();
		if (result) return result;
		await sleep(200);
	}
	throw new Error(`timed out waiting for ${label}`);
}

function runningPids(marker) {
	const result = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
	return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

// Minimal DevTools protocol client over one browser-level WebSocket.
async function connectCdp(url) {
	const socket = new WebSocket(url);
	await new Promise((resolveOpen, reject) => {
		socket.addEventListener("open", resolveOpen, { once: true });
		socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
	});
	let nextId = 0;
	const pending = new Map();
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const waiter = message.id === undefined ? undefined : pending.get(message.id);
		if (!waiter) return;
		pending.delete(message.id);
		if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
		else waiter.resolve(message.result);
	});
	const send = (method, params = {}, sessionId) => new Promise((resolveSend, reject) => {
		nextId += 1;
		pending.set(nextId, { resolve: resolveSend, reject, method });
		socket.send(JSON.stringify({ id: nextId, method, params, ...(sessionId ? { sessionId } : {}) }));
	});
	return { send, close: () => socket.close() };
}

const options = parseArgs(process.argv.slice(2));
const session = options.session ?? findLatestRichSession(options.from ?? options.cwd);
if (!existsSync(session)) usage(`session not found: ${session}`);
if (!existsSync(options.cwd)) usage(`cwd not found: ${options.cwd}`);
const chrome = chromeCandidates.find((path) => existsSync(path));
if (!chrome) usage("Google Chrome not found; set CHROME_BIN");
if (spawnSync("ttyd", ["--version"], { encoding: "utf8" }).status !== 0) usage("ttyd is not installed or not on PATH");

const scratch = mkdtempSync("/tmp/gentle-eyes.");
const sessionDir = join(scratch, "sessions");
const outDir = options.out ?? join(scratch, "shots");
const chromeProfile = join(scratch, "chrome-profile");
for (const dir of [sessionDir, outDir, chromeProfile]) mkdirSync(dir, { recursive: true });
const sourceBefore = statSync(session);

// run.sh waits for the browser to size the terminal before starting the shell,
// so the TUI starts at the final size instead of reflowing after a resize.
const runScript = join(scratch, "run.sh");
const goFile = join(scratch, "go");
const sizeFile = join(scratch, "size.txt");
writeFileSync(runScript, [
	"#!/usr/bin/env bash",
	`for _ in $(seq 1 600); do [ -f ${shellQuote(goFile)} ] && break; sleep 0.1; done`,
	`cd ${shellQuote(options.cwd)} || exit 1`,
	`stty size > ${shellQuote(sizeFile)}`,
	"export COLORTERM=truecolor",
	`exec node ${shellQuote(launcher)} --tui-mode fullscreen --fork ${shellQuote(session)} --session-dir ${shellQuote(sessionDir)}`,
	"",
].join("\n"));

const shots = {
	loaded: join(outDir, "01-loaded.png"),
	sidebar: join(outDir, "02-sidebar.png"),
	exited: join(outDir, "03-exited.png"),
};
const written = [];
const notes = [];
let ttyd;
let browser;
let cdp;
let exitCode = 0;

try {
	const ttydPort = await freePort();
	ttyd = spawn("ttyd", [
		"--port", String(ttydPort), "--interface", "127.0.0.1", "--writable", "--once",
		"-t", "rendererType=canvas", "-t", "disableLeaveAlert=true", "-t", "disableResizeOverlay=true",
		"-t", `fontSize=${FONT_SIZE}`, "-t", `fontFamily=${FONT_FAMILY}`, "-t", `theme=${JSON.stringify(THEME)}`,
		"bash", runScript,
	], { stdio: "ignore", env: cleanEnv() });

	browser = spawn(chrome, [
		"--headless=new", "--remote-debugging-port=0", `--user-data-dir=${chromeProfile}`,
		"--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", "about:blank",
	], { stdio: "ignore" });
	const activePort = join(chromeProfile, "DevToolsActivePort");
	const [debugPort, browserPath] = await waitFor(() => existsSync(activePort) && readFileSync(activePort, "utf8").trim().split("\n").length >= 2 && readFileSync(activePort, "utf8").trim().split("\n"), 20_000, "Chrome DevTools");
	cdp = await connectCdp(`ws://127.0.0.1:${debugPort}${browserPath}`);
	const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
	const page = (method, params) => cdp.send(method, params, sessionId);
	const evaluate = async (expression) => (await page("Runtime.evaluate", { expression, returnByValue: true })).result.value;
	const setViewport = (width, height) => page("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
	const screenshot = async (path) => {
		const { data } = await page("Page.captureScreenshot", { format: "png" });
		writeFileSync(path, Buffer.from(data, "base64"));
		written.push(path);
	};
	const pressCtrl = async (key) => {
		await evaluate("window.term && window.term.focus()");
		const code = `Key${key.toUpperCase()}`;
		const keyCode = key.toUpperCase().charCodeAt(0);
		for (const type of ["rawKeyDown", "keyUp"]) {
			await page("Input.dispatchKeyEvent", { type, modifiers: 2, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
		}
	};

	await setViewport(1600, 900);
	await waitFor(async () => {
		try {
			await page("Page.navigate", { url: `http://127.0.0.1:${ttydPort}/` });
			return true;
		} catch {
			return false;
		}
	}, 10_000, "ttyd page");
	await waitFor(() => evaluate("Boolean(window.term && window.term.cols > 0)"), 15_000, "xterm.js terminal");

	// Fit the viewport so xterm.js ends up exactly cols x rows; ttyd's fit addon
	// resizes the pty on every viewport change.
	let size = await evaluate("({ cols: term.cols, rows: term.rows, width: innerWidth, height: innerHeight })");
	for (let attempt = 0; attempt < 8 && (size.cols !== options.cols || size.rows !== options.rows); attempt += 1) {
		const width = Math.round(size.width + (options.cols - size.cols) * (size.width / size.cols)) + (size.cols > options.cols ? 0 : 1);
		const height = Math.round(size.height + (options.rows - size.rows) * (size.height / size.rows)) + (size.rows > options.rows ? 0 : 1);
		await setViewport(width, height);
		await sleep(400);
		size = await evaluate("({ cols: term.cols, rows: term.rows, width: innerWidth, height: innerHeight })");
	}
	if (size.cols !== options.cols || size.rows !== options.rows) notes.push(`terminal is ${size.cols}x${size.rows}, wanted ${options.cols}x${options.rows}`);
	writeFileSync(goFile, "");

	// tuiMode defaults to "fullscreen" in Pi, and the sidebar rail paints in
	// fullscreen at >= 140 columns, so no key is needed to enter it.
	await sleep(options.wait * 1000);
	await screenshot(shots.loaded);
	await sleep(3000);
	await screenshot(shots.sidebar);
	// Fullscreen mode runs on the alternate screen; "normal" means regular mode.
	console.log(`screen buffer: ${await evaluate("term.buffer.active.type")}`);

	// Ctrl+D quits on an empty editor; Ctrl+C twice is the fallback.
	await pressCtrl("d");
	const exited = async (ms) => {
		try {
			await waitFor(() => runningPids(sessionDir).length === 0, ms, "shell exit");
			return true;
		} catch {
			return false;
		}
	};
	if (!(await exited(5000))) {
		await pressCtrl("c");
		await sleep(500);
		await pressCtrl("c");
		if (!(await exited(5000))) notes.push("shell did not exit on Ctrl+D / Ctrl+C");
	}
	await sleep(500);
	await screenshot(shots.exited);
	await cdp.send("Browser.close").catch(() => {});
} catch (error) {
	exitCode = 1;
	console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
	cdp?.close();
	for (const child of [browser, ttyd]) if (child && child.exitCode === null) child.kill("SIGTERM");
}

// Anything still running from this run carries the unique scratch path in argv.
let leftovers = runningPids(sessionDir);
if (leftovers.length > 0) {
	for (const pid of leftovers) spawnSync("kill", ["-TERM", pid]);
	await sleep(1000);
	leftovers = runningPids(sessionDir);
}

const sourceAfter = statSync(session);
const forks = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"));
console.log(`session: ${session}`);
console.log(`fork: ${forks.length > 0 ? join(sessionDir, forks[0]) : "(none created)"}`);
console.log(`scratch: ${scratch}`);
console.log(`pty size at launch (rows cols): ${existsSync(sizeFile) ? readFileSync(sizeFile, "utf8").trim() : "unknown"}`);
if (sourceAfter.size !== sourceBefore.size || sourceAfter.mtimeMs !== sourceBefore.mtimeMs) {
	notes.push("the source session changed during the run (another live writer?); this script only reads it");
}
if (leftovers.length > 0) notes.push(`gentle-shell processes still running: ${leftovers.join(", ")}`);
for (const note of notes) console.log(`note: ${note}`);
for (const path of written) console.log(`png: ${path}`);
process.exit(written.length > 0 ? exitCode : 1);
