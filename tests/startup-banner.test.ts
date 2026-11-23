import assert from "node:assert/strict";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs/promises";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import startup, { DRAGON_COMPACT_RAW, DRAGON_LARGE_RAW, isPiCliSubcommandInvocation, readBannerConfig, readGitBranch, rosePulseTicks } from "../extensions/startup-banner.ts";
import { setBundledInstallForTesting } from "../lib/drakonc-shell-bundled.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../lib/terminal-theme.ts";

// The banner reads process.env directly; a suite launched from a delegated
// child must still exercise the parent paths (drakonc-shell#1690).
delete process.env.DRAKONC_PI_AGENTS_CHILD;

// El dragón del banner es arte Braille: un punto Braille visible lo delata en
// la salida renderizada, igual que la rosa anterior se buscaba por su hocico.
const DRAGON_INK = /[\u2801-\u28FF]/;

const rowsWithInk = (art: readonly string[]) => art.filter((line) => DRAGON_INK.test(line));

const leadingSpaces = (line: string) => line.length - line.trimStart().length;

/** Columna inicial del bloque de arte en cada fila con dragón. */
const artIndents = (lines: readonly string[]) => rowsWithInk(lines).map(leadingSpaces);

/** Ancho visible del bloque de arte una vez normalizado y rellenado por el banner. */
const artWidth = (art: readonly string[]) => Math.max(...art.map((line) => visibleWidth(line.trimEnd())));

test("startup artwork uses Drakonc branding and a Braille dragon", () => {
	const source = readFileSync(new URL("../extensions/startup-banner.ts", import.meta.url), "utf8");
	const logo = JSON.parse(source.match(/const TEXT_LOGO = (\[[\s\S]*?\]);/)![1]) as string[];
	assert.equal(logo.length, 5);
	assert.ok(logo.every((line) => line.includes("█")));
	// 3.1: la variante amplia conserva las 17 filas de la rosa original y la
	// compacta reduce la misma silueta a 8 filas para terminales estrechas.
	assert.equal(DRAGON_LARGE_RAW.length, 17);
	assert.equal(DRAGON_COMPACT_RAW.length, 8);
	assert.ok(artWidth(DRAGON_LARGE_RAW) <= 38, "la variante amplia cabe en 38 columnas");
	assert.ok(artWidth(DRAGON_COMPACT_RAW) <= 20, "la variante compacta cabe en 20 columnas");
	for (const art of [DRAGON_LARGE_RAW, DRAGON_COMPACT_RAW]) {
		assert.ok(art.every((line) => /^[\u2800-\u28FF ]*$/.test(line)), "arte limitado a Braille y espacios");
		assert.ok(art.every((line) => !line.includes("\t")), "arte sin tabuladores");
		assert.ok(art.every((line) => line === line.trimEnd()), "arte sin espacios finales");
		assert.ok(!/✿|❀|❁|✾/.test(art.join("")), "arte sin glifos de flor heredados");
		assert.ok(rowsWithInk(art).length >= 6, "arte con detalle suficiente");
	}
	// Silueta de la cabeza de perfil: cuernos y cráneo arriba a la izquierda,
	// hocico a la derecha y cuello bajando por la izquierda.
	assert.ok(DRAGON_LARGE_RAW.slice(0, 6).some((line) => DRAGON_INK.test(line.slice(0, 24))), "cuernos y cráneo arriba a la izquierda");
	assert.ok(DRAGON_LARGE_RAW.slice(6, 13).some((line) => DRAGON_INK.test(line.slice(26))), "hocico a la derecha");
	assert.ok(DRAGON_LARGE_RAW.slice(12).some((line) => DRAGON_INK.test(line.slice(0, 24))), "cuello abajo a la izquierda");
});

test("startup branch lookup uses direct git argv and hides its Windows child", async () => {
	const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
	const run = ((command: string, args: readonly string[], options: Record<string, unknown>, callback: (error: Error | null, stdout: string) => void) => {
		calls.push({ command, args, options });
		callback(null, "main\n");
	}) as typeof import("node:child_process").execFile;
	assert.equal(await readGitBranch("/repo with spaces & metacharacters", run), "On branch main");
	assert.deepEqual(calls, [{
		command: "git",
		args: ["-C", "/repo with spaces & metacharacters", "branch", "--show-current"],
		options: { encoding: "utf8", shell: false, windowsHide: true, timeout: 3000 },
    }]);
});

// S4: a hung `git branch` (for example a repository rooted at HOME) must not
// keep the banner waiting; a timeout reads as the ordinary failure path.
test("startup branch lookup times out into the not-a-repo fallback", { skip: process.platform === "win32" }, async (t) => {
	const bin = mkdtempSync(join(tmpdir(), "gp-banner-slow-git-"));
	writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 3\n", { mode: 0o755 });
	const previousPath = process.env.PATH;
	process.env.PATH = `${bin}:${previousPath ?? ""}`;
	t.after(() => {
		process.env.PATH = previousPath;
		rmSync(bin, { recursive: true, force: true });
	});
	const started = Date.now();
	assert.equal(await readGitBranch(bin, undefined, 200), "Not a git repo");
	assert.ok(Date.now() - started < 2000, "the lookup must stop at its timeout");
});

test("startup banner keeps animating after invalidate and cleans up on dispose", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "gp-banner-quality-"));
	writeFileSync(join(home, "animations.json"), '{"schema":"drakonc-pi.animations/v1","policy":"quality"}');
	const previousHome = process.env.DRAKONC_PI_CONFIG_HOME;
	process.env.DRAKONC_PI_CONFIG_HOME = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.DRAKONC_PI_CONFIG_HOME;
		else process.env.DRAKONC_PI_CONFIG_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.mock.method(fs, "readFile", async () => JSON.stringify({ showRose: true, showTextLogo: true, color: "pink" }));
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const argv = process.argv;
	process.argv = ["node"];
	t.after(() => { process.argv = argv; });
	for (const [key, value] of [["rows", 40], ["columns", 160]] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
		Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
		t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
	}
	let start: Function;
	let shutdown: Function;
	let header: { render(width: number): string[]; invalidate(): void; dispose(): void };
	let renders = 0;
	startup({ on: (name: string, fn: Function) => {
		if (name === "session_start") start = fn;
		if (name === "session_shutdown") shutdown = fn;
	}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
	await start!({}, { hasUI: true, cwd: "/fixture", ui: { setHeader: (factory: Function) => {
		header = factory({ requestRender() { renders++; } }, { fg: (_role: string, text: string) => text });
	} } });
	t.mock.timers.tick(50);
	assert.match(header!.render(200).join("\n"), /\x1b\[38;2;255;140;210m█/, "logo keeps the selected color palette");
	const afterBoot = renders;
	t.mock.timers.tick(25);
	assert.ok(renders > afterBoot, "animation timer requests renders");
	header!.invalidate();
	const afterInvalidate = renders;
	t.mock.timers.tick(25);
	assert.ok(renders > afterInvalidate, "invalidate() must not stop the animation timer");
	header!.dispose();
	const afterDispose = renders;
	t.mock.timers.tick(25);
	assert.equal(renders, afterDispose, "dispose() stops the animation timer");
	shutdown!();
	t.mock.timers.tick(25);
	assert.equal(renders, afterDispose, "session_shutdown cleanup stays idle");
});

test("animation modes retain banner lifetime policy, final artwork and approximate duration", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "gp-banner-animations-"));
	const previousHome = process.env.DRAKONC_PI_CONFIG_HOME;
	process.env.DRAKONC_PI_CONFIG_HOME = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.DRAKONC_PI_CONFIG_HOME;
		else process.env.DRAKONC_PI_CONFIG_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});
	t.mock.method(fs, "readFile", async () => JSON.stringify({ showRose: true, showTextLogo: true, color: "pink" }));
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const argv = process.argv;
	process.argv = ["node"];
	t.after(() => { process.argv = argv; });
	for (const [key, value] of [["rows", 40], ["columns", 200]] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
		Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
		t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
	}
	let boot: () => void;
	let pulse: () => void;
	let active = false;
	let delay = 0;
	let clock = 0;
	let paints = 0;
	t.mock.method(Date, "now", () => clock);
	t.mock.method(globalThis, "setTimeout", (callback: () => void, ms: number) => {
		if (ms === 50) boot = callback; // Never run operational stats/home reads.
		return {};
	});
	t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => {
		pulse = callback; delay = ms; active = true; return {};
	});
	t.mock.method(globalThis, "clearInterval", () => { active = false; });
	let start: (event: unknown, ctx: unknown) => Promise<void>;
	let shutdown: () => void;
	let header: { render(width: number): string[]; dispose(): void };
	// Stroke warmup is module-global; keep duration driving isolated from cold-start tests.
	const { default: isolatedStartup } = await import(new URL("../extensions/startup-banner.ts?animations", import.meta.url).href) as typeof import("../extensions/startup-banner.ts");
	isolatedStartup({ on: (name: string, fn: typeof start) => {
		if (name === "session_start") start = fn;
		if (name === "session_shutdown") shutdown = fn as unknown as () => void;
	}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
	const ctx = { hasUI: true, cwd: "/fixture", ui: { setHeader(factory: (tui: unknown, theme: unknown) => typeof header) {
		header = factory({ requestRender() { paints++; } }, { fg: (_role: string, text: string) => text });
	} } };
	const save = (policy: string) => writeFileSync(join(home, "animations.json"), JSON.stringify({ schema: "drakonc-pi.animations/v1", policy }));
	try {
		save("potato");
		await start!({}, ctx); boot!();
		assert.equal(active, false, "potato starts no animation interval");
		const staticArt = stripAnsi(header!.render(200).join("\n"));
		// La animación debe terminar en el mismo estado final en todos los anchos.
		const staticByWidth = new Map([30, 50, 80, 120, 200].map((width) => [width, stripAnsi(header!.render(width).join("\n"))]));
		// El centrado del bloque del dragón en el último fotograma estático.
		const staticIndents = artIndents(staticArt.split("\n"));
		assert.match(staticArt, /[▄▀█]/);
		assert.match(staticArt, DRAGON_INK);
		header!.dispose();
		let qualityDuration = 0;
		let qualityPaints = 0;
		for (const policy of ["quality", "performance"]) {
			save(policy);
			await start!({}, ctx); boot!();
			for (let i = 0; i < 15; i++) await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(delay, policy === "quality" ? 25 : 250);
			// El centrado no cambia entre fotogramas: el bloque del dragón empieza
			// en la misma columna durante la animación que en el estado final.
			assert.deepEqual(artIndents(header!.render(200).map(stripAnsi)), staticIndents, `${policy} keeps the dragon centered while animating`);
			save("potato"); // Already-created animation keeps its policy.
			const began = clock;
			const before = paints;
			while (active && clock - began <= 5500) { clock += delay; pulse!(); }
			assert.equal(active, false, "finishes and clears the interval");
			for (const [width, expected] of staticByWidth) {
				assert.equal(stripAnsi(header!.render(width).join("\n")), expected, `settles to the static art at width ${width}`);
			}
			if (policy === "quality") { qualityDuration = clock - began; qualityPaints = paints - before; }
			else {
				assert.ok(Math.abs(clock - began - qualityDuration) <= 250);
				assert.ok(paints - before <= Math.ceil(qualityPaints / 10));
			}
			header!.dispose();
		}

		// Slow device: 5s wall-clock cap hits before animation reaches natural finish.
		save("quality");
		await start!({}, ctx); boot!();
		for (let i = 0; i < 15; i++) await new Promise<void>((resolve) => setImmediate(resolve));
		clock += 5100;
		pulse!();
		assert.equal(active, false, "clears interval on 5s timeout");
		assert.equal(stripAnsi(header!.render(200).join("\n")), staticArt, "fast-forwards to complete static artwork on 5s timeout without frozen letters or sparkle");
		header!.dispose();
	} finally { shutdown!(); }
});

// Drive the real header factory; background git/home reads never run.
for (const showRose of [false, true]) for (const showTextLogo of [false, true]) {
	test(`startup art respects rose=${showRose}, logo=${showTextLogo} and cyan palette`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(fs, "readFile", async () => JSON.stringify({ showRose, showTextLogo, color: "cyan" }));
		t.mock.method(fs, "readdir", async () => [
			{ name: "sdd-apply.md", isFile: () => true },
			{ name: "sdd-status.md", isFile: () => true },
			{ name: "drakonc-ai-worker.md", isFile: () => true },
			{ name: "notes.txt", isFile: () => true },
		] as any);
		syncBuiltinESMExports();
		t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
		const argv = process.argv;
		process.argv = ["node"];
		t.after(() => { process.argv = argv; });
		for (const [key, value] of [["rows", 40], ["columns", 160]] as const) {
			const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
			Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
			t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
		}
		let start: Function;
		let shutdown: Function;
		let header: { render(width: number): string[]; dispose(): void };
		const writes: string[] = [];
		const { default: coldStartup } = await import(new URL(`../extensions/startup-banner.ts?art-${showRose}-${showTextLogo}`, import.meta.url).href) as typeof import("../extensions/startup-banner.ts");
		coldStartup({ on: (name: string, fn: Function) => {
			if (name === "session_start") start = fn;
			if (name === "session_shutdown") shutdown = fn;
		}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
		const write = t.mock.method(process.stdout, "write", (text: string) => { writes.push(String(text)); return true; });
		await start!({}, { hasUI: true, cwd: "/fixture", ui: { setHeader: (factory: Function) => {
			header = factory({ requestRender() {} }, { fg: (_role: string, text: string) => text });
		} } });
		t.mock.timers.tick(200);
		for (let i = 0; i < 5; i++) await Promise.resolve();
		try {
			for (const width of [40, 80, 160, 200]) {
				const lines = header!.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				const text = stripAnsi(lines.join("\n"));
				assert.match(text, /GIT:/);
				assert.match(text, /PATH:/);
				assert.doesNotMatch(text, /phases\b/i, "historical SDD files never appear as active phases");
				assert.match(text, /AGENTS:\s+1 agents/, "only the installed background agent is counted");
				if (width >= 160) {
					assert.equal(DRAGON_INK.test(text), showRose);
					assert.equal(/[▒▄▀█]/.test(text), showTextLogo);
				} else if (width === 80 && showTextLogo) {
					assert.match(text, /◆ Drakonc Shell ◆/, "narrow terminal shows graceful fallback branding");
				}
				assert.match(lines.join("\n"), /\x1b\[38;2;85;170;205m/, "startup labels use the saved cyan palette");
			}
			// Cancel pending context reads before advancing the resize clock.
			t.mock.timers.reset();
			t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() + 1000 });
			process.stdout.rows = 10;
			process.stdout.emit("resize");
			t.mock.timers.tick(150);
			assert.deepEqual(header!.render(80), []);
			process.stdout.rows = 25;
			process.stdout.columns = 80;
			process.stdout.emit("resize");
			t.mock.timers.tick(150);
			const minimal = stripAnsi(header!.render(80).join("\n"));
			assert.doesNotMatch(minimal, DRAGON_INK);
			assert.equal(/◆ Drakonc Shell ◆/.test(minimal), showTextLogo);
			if (showTextLogo) {
				const wideMinimal = stripAnsi(header!.render(160).join("\n"));
				assert.equal(/[▒▄▀█]/.test(wideMinimal), true);
			}
			assert.deepEqual(writes, [], "Pi owns stdout during startup and resize");
		} finally {
			shutdown!();
			write.mock.restore();
		}
	});
}

// D4 (3.2/3.3): la rama apilada elige la variante amplia, la compacta o ninguna
// según el ancho disponible, sin desbordar ni descentrar el bloque; con
// `showRose: false` no se dibuja el dragón y banner.json no se reescribe.
test("the banner dragon picks its variant by width and keeps banner.json untouched", async (t) => {
	const previousHome = process.env.DRAKONC_PI_CONFIG_HOME;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	t.after(() => {
		if (previousHome === undefined) delete process.env.DRAKONC_PI_CONFIG_HOME;
		else process.env.DRAKONC_PI_CONFIG_HOME = previousHome;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const argv = process.argv;
	process.argv = ["node"];
	t.after(() => { process.argv = argv; });
	// rows/columns fijan el modo "full": render(width) varía el ancho disponible.
	for (const [key, value] of [["rows", 40], ["columns", 200]] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
		Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
		t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
	}
	const boot = async (tag: string, config: unknown) => {
		const home = mkdtempSync(join(tmpdir(), `gp-banner-dragon-${tag}-`));
		const agentDir = mkdtempSync(join(tmpdir(), `gp-banner-dragon-agent-${tag}-`));
		t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(agentDir, { recursive: true, force: true }); });
		process.env.DRAKONC_PI_CONFIG_HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(home, "animations.json"), JSON.stringify({ schema: "drakonc-pi.animations/v1", policy: "potato" }));
		const bannerPath = join(home, "banner.json");
		writeFileSync(bannerPath, JSON.stringify(config));
		let start: (event: unknown, ctx: unknown) => Promise<void>;
		let header: { render(width: number): string[]; dispose(): void };
		const { default: isolatedStartup } = await import(new URL(`../extensions/startup-banner.ts?dragon-${tag}`, import.meta.url).href) as typeof import("../extensions/startup-banner.ts");
		isolatedStartup({ on: (name: string, fn: unknown) => {
			if (name === "session_start") start = fn as typeof start;
		}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
		await start!({}, { hasUI: true, cwd: "/fixture", ui: { setHeader: (factory: Function) => {
			header = factory({ requestRender() {} }, { fg: (_role: string, text: string) => text });
		} } });
		// El encabezado se instala en un setTimeout(50): deja correr el arranque.
		for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 30));
		return {
			render: (width: number) => header!.render(width).map(stripAnsi),
			bannerPath,
			dispose: () => header!.dispose(),
		};
	};
	const indent = (line: string) => line.length - line.trimStart().length;
	const shown = await boot("on", { showRose: true, showTextLogo: true, color: "red" });
	try {
		const before = readFileSync(shown.bannerPath, "utf8");
		const artRows = (width: number) => rowsWithInk(shown.render(width));
		assert.equal(artRows(30).length, 8, "30 columnas usan la variante compacta");
		assert.equal(artRows(22).length, 8, "22 columnas aún admiten la compacta");
		assert.equal(artRows(21).length, 0, "por debajo de la compacta no se dibuja arte");
		assert.equal(artRows(50).length, 17, "50 columnas usan la variante amplia");
		for (const width of [30, 50, 80, 120, 200]) {
			const lines = shown.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `ninguna línea desborda ${width} columnas`);
			assert.ok(artRows(width).length >= 8, `el dragón aparece a ${width} columnas`);
			// El bloque está rellenado a un ancho uniforme y centrado: el margen
			// izquierdo mínimo y el derecho coinciden (a lo sumo un espacio de
			// diferencia por el redondeo del centrado).
			const art = artRows(width);
			const left = Math.min(...artIndents(art));
			const right = width - Math.max(...art.map((line) => line.trimEnd().length));
			assert.ok(Math.abs(left - right) <= 1, `el bloque del dragón queda centrado en ${width} columnas`);
		}
		assert.equal(readFileSync(shown.bannerPath, "utf8"), before, "arrancar el banner no reescribe banner.json");
	} finally { shown.dispose(); }

	const hidden = await boot("off", { showRose: false, showTextLogo: true, color: "red" });
	try {
		const before = readFileSync(hidden.bannerPath, "utf8");
		for (const width of [30, 50, 80, 120, 200]) {
			assert.equal(rowsWithInk(hidden.render(width)).length, 0, `showRose:false oculta el dragón a ${width} columnas`);
		}
		assert.equal(readFileSync(hidden.bannerPath, "utf8"), before, "showRose:false no reescribe banner.json");
	} finally { hidden.dispose(); }
});

test("startup banner counts MCP servers from the active Pi agent dir", async (t) => {
	const agentDir = join(tmpdir(), "gp-banner-agent-dir");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	// Only the active agent dir's mcp.json declares two servers; any other
	// mcp.json (for example ~/.pi/agent/mcp.json) declares five.
	t.mock.method(fs, "readFile", async (path: string) => {
		if (String(path) === join(agentDir, "mcp.json")) return JSON.stringify({ mcpServers: { one: {}, two: {} } });
		if (String(path).endsWith("mcp.json")) return JSON.stringify({ mcpServers: { a: {}, b: {}, c: {}, d: {}, e: {} } });
		return JSON.stringify({ showRose: false, showTextLogo: false, color: "pink" });
	});
	t.mock.method(fs, "readdir", async () => [] as any);
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const argv = process.argv;
	process.argv = ["node"];
	t.after(() => { process.argv = argv; });
	for (const [key, value] of [["rows", 40], ["columns", 160]] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
		Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
		t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
	}
	let start: Function;
	let shutdown: Function;
	let header: { render(width: number): string[]; dispose(): void };
	const { default: coldStartup } = await import(new URL("../extensions/startup-banner.ts?mcp-agent-dir", import.meta.url).href) as typeof import("../extensions/startup-banner.ts");
	coldStartup({ on: (name: string, fn: Function) => {
		if (name === "session_start") start = fn;
		if (name === "session_shutdown") shutdown = fn;
	}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
	await start!({}, { hasUI: true, cwd: "/fixture", ui: { setHeader: (factory: Function) => {
		header = factory({ requestRender() {} }, { fg: (_role: string, text: string) => text });
	} } });
	t.mock.timers.tick(200);
	for (let i = 0; i < 5; i++) await Promise.resolve();
	try {
		assert.match(stripAnsi(header!.render(160).join("\n")), /MCP:\s+2 server\(s\)/);
	} finally {
		header!.dispose();
		shutdown!();
	}
});

test("startup banner counts packages, extensions and agents from the active Pi agent dir", async (t) => {
	const agentDir = join(tmpdir(), "gp-banner-active-agent-dir");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	// The active agent dir declares one package with two extensions and three
	// agents; any other agent dir (for example ~/.pi/agent) declares more.
	t.mock.method(fs, "readFile", async (path: string) => {
		const file = String(path);
		if (file === join(agentDir, "settings.json")) return JSON.stringify({ packages: ["npm:@acme/pi-kit@1.0.0"] });
		if (file.endsWith("settings.json")) return JSON.stringify({ packages: ["npm:a", "npm:b", "npm:c", "npm:d"] });
		if (file === join(agentDir, "npm", "node_modules", "@acme/pi-kit", "package.json")) {
			return JSON.stringify({ pi: { extensions: ["one.ts", "two.ts"] } });
		}
		if (file.endsWith("package.json")) return JSON.stringify({ pi: { extensions: ["x.ts", "y.ts", "z.ts", "w.ts", "v.ts"] } });
		if (file.endsWith("mcp.json")) return JSON.stringify({ mcpServers: {} });
		return JSON.stringify({ showRose: false, showTextLogo: false, color: "pink" });
	});
	const agentFile = (name: string) => ({ name, isFile: () => true });
	t.mock.method(fs, "readdir", async (path: string) => String(path) === join(agentDir, "agents")
		? [agentFile("one.md"), agentFile("two.md"), agentFile("three.md"), agentFile("sdd-apply.md")] as any
		: [agentFile("a.md"), agentFile("b.md"), agentFile("c.md"), agentFile("d.md"), agentFile("e.md"), agentFile("f.md"), agentFile("g.md")] as any);
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const argv = process.argv;
	process.argv = ["node"];
	t.after(() => { process.argv = argv; });
	for (const [key, value] of [["rows", 40], ["columns", 160]] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
		Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
		t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
	}
	let start: Function;
	let shutdown: Function;
	let header: { render(width: number): string[]; dispose(): void };
	const { default: coldStartup } = await import(new URL("../extensions/startup-banner.ts?active-agent-dir-counts", import.meta.url).href) as typeof import("../extensions/startup-banner.ts");
	coldStartup({ on: (name: string, fn: Function) => {
		if (name === "session_start") start = fn;
		if (name === "session_shutdown") shutdown = fn;
	}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
	await start!({}, { hasUI: true, cwd: "/fixture", ui: { setHeader: (factory: Function) => {
		header = factory({ requestRender() {} }, { fg: (_role: string, text: string) => text });
	} } });
	t.mock.timers.tick(200);
	for (let i = 0; i < 10; i++) await Promise.resolve();
	try {
		const text = stripAnsi(header!.render(160).join("\n"));
		assert.match(text, /PLUGINS:\s+1 package\(s\)/);
		assert.match(text, /EXTENSIONS:\s+2 active/);
		assert.match(text, /AGENTS:\s+3 agents/);
	} finally {
		header!.dispose();
		shutdown!();
	}
});

test("launcher-injected extension directories do not suppress the startup banner", () => {
	// Drakonc Shell launches `pi -e <package-root-dir>`; a directory path is not a subcommand.
	assert.equal(isPiCliSubcommandInvocation(["node", "pi", "-e", "/opt/drakonc-pi"]), false);
	assert.equal(isPiCliSubcommandInvocation(["node", "pi", "--no-extensions", "-e", "/a", "-e", "/b/ext.mjs"]), false);
	assert.equal(isPiCliSubcommandInvocation(["node", "pi"]), false);
	assert.equal(isPiCliSubcommandInvocation(["node", "pi", "-e", "/opt/drakonc-pi", "install"]), false);
	for (const sub of ["install", "remove", "uninstall", "update", "list", "config", "auth"]) {
		assert.equal(isPiCliSubcommandInvocation(["node", "pi", sub, "npm:x"]), true, sub);
	}
});

// drakonc-shell#1690: a delegated rpc child has hasUI=true; only a piped stdout
// without rows/columns kept the banner off before the explicit child guard.
test("delegated children never paint the startup banner", async (t) => {
	const previousChild = process.env.DRAKONC_PI_AGENTS_CHILD;
	process.env.DRAKONC_PI_AGENTS_CHILD = "1";
	t.after(() => {
		if (previousChild === undefined) delete process.env.DRAKONC_PI_AGENTS_CHILD;
		else process.env.DRAKONC_PI_AGENTS_CHILD = previousChild;
	});
	const home = mkdtempSync(join(tmpdir(), "gp-banner-child-"));
	const previousHome = process.env.DRAKONC_PI_CONFIG_HOME;
	process.env.DRAKONC_PI_CONFIG_HOME = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.DRAKONC_PI_CONFIG_HOME;
		else process.env.DRAKONC_PI_CONFIG_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.mock.method(fs, "readFile", async () => JSON.stringify({ showRose: true, showTextLogo: true, color: "pink" }));
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const argv = process.argv;
	process.argv = ["node"];
	t.after(() => { process.argv = argv; });
	for (const [key, value] of [["rows", 40], ["columns", 160]] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
		Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
		t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
	}
	let start: Function;
	let shutdown: Function;
	startup({ on: (name: string, fn: Function) => {
		if (name === "session_start") start = fn;
		if (name === "session_shutdown") shutdown = fn;
	}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
	t.after(() => shutdown?.());
	let headers = 0;
	// #3386: a child registers no hooks at all, so there is no session_start to call.
	await start?.({}, { hasUI: true, cwd: "/fixture", ui: { setHeader: () => { headers++; } } });
	t.mock.timers.tick(50);
	assert.equal(headers, 0);
});

// S9: the config home each of these reads resolves, per case. The OS home is
// a temporary folder in every case, so no case can reach the real one.
// "unset" and "empty" both name ~/.drakonc-shell/drakonc-ai, el hogar propio de
// Drakonc Shell (nunca el ~/.pi compartido): un DRAKONC_PI_CONFIG_HOME vacío
// cuenta como no definido (#2201; antes nombraba la carpeta actual). "bundled" stands in for this package running from
// a bundled install (testing overlay) whose prefix the launcher passed; the
// user's own DRAKONC_PI_CONFIG_HOME is then not this install's.
type ConfigHomeCase = "unset" | "empty" | "bundled";
function configHomeCase(t: { after: (fn: () => void) => void }, kind: ConfigHomeCase): { env: NodeJS.ProcessEnv; dir: string; userConfig: string } {
	const base = realpathSync(mkdtempSync(join(tmpdir(), `config-home-${kind}-`)));
	const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DRAKONC_PI_CONFIG_HOME: process.env.DRAKONC_PI_CONFIG_HOME, DRAKONC_SHELL_PREFIX: process.env.DRAKONC_SHELL_PREFIX, DRAKONC_SHELL_CONFIG_HOME: process.env.DRAKONC_SHELL_CONFIG_HOME };
	const cwd = process.cwd();
	process.env.HOME = join(base, "home");
	process.env.USERPROFILE = join(base, "home");
	delete process.env.DRAKONC_PI_CONFIG_HOME;
	delete process.env.DRAKONC_SHELL_PREFIX;
	delete process.env.DRAKONC_SHELL_CONFIG_HOME;
	t.after(() => {
		process.chdir(cwd);
		setBundledInstallForTesting(undefined);
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(base, { recursive: true, force: true });
	});
	const userConfig = join(base, "user-config");
	if (kind === "unset") return { env: {}, dir: join(base, "home", ".drakonc-shell", "drakonc-ai"), userConfig };
	if (kind === "empty") {
		mkdirSync(join(base, "cwd"));
		process.chdir(join(base, "cwd"));
		return { env: { DRAKONC_PI_CONFIG_HOME: "" }, dir: join(base, "home", ".drakonc-shell", "drakonc-ai"), userConfig };
	}
	const prefix = join(base, "prefix");
	mkdirSync(prefix);
	setBundledInstallForTesting({ root: prefix });
	return { env: { DRAKONC_SHELL_PREFIX: prefix, DRAKONC_PI_CONFIG_HOME: userConfig }, dir: join(prefix, "config", "drakonc-ai"), userConfig };
}

for (const kind of ["unset", "empty", "bundled"] as const) {
	test(`the banner reads its settings from the ${kind} config home`, async (t) => {
		const { env, dir, userConfig } = configHomeCase(t, kind);
		Object.assign(process.env, env);
		const write = (folder: string, color: string) => {
			mkdirSync(folder, { recursive: true });
			writeFileSync(join(folder, "banner.json"), JSON.stringify({ showRose: false, showTextLogo: true, color }));
		};
		write(userConfig, "yellow");
		write(dir, "cyan");
		assert.deepEqual(await readBannerConfig(), { showRose: false, showTextLogo: true, color: "cyan" });
	});
}

test("the banner ends with a /drakonc:guide reminder on every start, only when the command exists", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "gp-banner-guide-"));
	writeFileSync(join(home, "animations.json"), '{"schema":"drakonc-pi.animations/v1","policy":"potato"}');
	const previousHome = process.env.DRAKONC_PI_CONFIG_HOME;
	process.env.DRAKONC_PI_CONFIG_HOME = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.DRAKONC_PI_CONFIG_HOME;
		else process.env.DRAKONC_PI_CONFIG_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.mock.method(fs, "readFile", async () => JSON.stringify({ showRose: true, showTextLogo: true, color: "pink" }));
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const argv = process.argv;
	process.argv = ["node"];
	t.after(() => { process.argv = argv; });
	for (const [key, value] of [["rows", 40], ["columns", 160]] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
		Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
		t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
	}
	const render = async (commands: { name: string }[]) => {
		let start: Function;
		let header: { render(width: number): string[]; dispose(): void };
		startup({ on: (name: string, fn: Function) => { if (name === "session_start") start = fn; }, registerCommand() {}, getCommands: () => commands, getAllTools: () => [] } as unknown as ExtensionAPI);
		await start!({}, { hasUI: true, cwd: "/fixture", ui: { setHeader: (factory: Function) => {
			header = factory({ requestRender() {} }, { fg: (_role: string, text: string) => text });
		} } });
		t.mock.timers.tick(50);
		const lines = header!.render(160).map(stripAnsi);
		header!.dispose();
		return lines;
	};
	const withGuide = await render([{ name: "drakonc:guide" }]);
	assert.equal(withGuide.filter((line) => line.trim() !== "").at(-1)?.trim(), "Consejo: ejecuta /drakonc:guide para un recorrido guiado por Drakonc Shell");
	assert.equal((await render([{ name: "drakonc:guide" }])).filter((line) => line.includes("/drakonc:guide")).length, 1, "shown again on the next start, once");
	assert.equal((await render([])).some((line) => line.includes("/drakonc:guide")), false);
});

// Every rose pulse step repaints every rose cell, which drives the TUI diff to
// redraw the whole header region and teleport the hardware cursor; on fast
// terminals that churn reads as flicker/ghosting (ghostty#12685). The step must
// come from the resolved animation policy so the cadence table in
// docs/readme-reference.md stays authoritative: quality paints every 25ms and
// needs the coarser ~100ms wave, while performance already paints every 250ms.
test("the rose pulse step follows the resolved animation policy", async (t) => {
	assert.deepEqual(["quality", "performance", "potato"].map((policy) => rosePulseTicks(policy as never)), [4, 2, 2],
		"quality quantizes the wave; performance and potato keep the merge-base step");
	const home = mkdtempSync(join(tmpdir(), "gp-banner-pulse-"));
	const previousHome = process.env.DRAKONC_PI_CONFIG_HOME;
	process.env.DRAKONC_PI_CONFIG_HOME = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.DRAKONC_PI_CONFIG_HOME;
		else process.env.DRAKONC_PI_CONFIG_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});
	// Rose only: with the logo off, a rendered header varies with tick solely
	// through the rose pulse once the fade-in and flash phases have settled.
	t.mock.method(fs, "readFile", async () => JSON.stringify({ showRose: true, showTextLogo: false, color: "pink" }));
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const argv = process.argv;
	process.argv = ["node"];
	t.after(() => { process.argv = argv; });
	for (const [key, value] of [["rows", 40], ["columns", 200]] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
		Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
		t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
	}
	let boot: () => void;
	let pulse: () => void;
	let active = false;
	let delay = 0;
	let clock = 0;
	t.mock.method(Date, "now", () => clock);
	t.mock.method(globalThis, "setTimeout", (callback: () => void, ms: number) => {
		if (ms === 50) boot = callback; // Never run operational stats/home reads.
		return {};
	});
	t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => {
		pulse = callback; delay = ms; active = true; return {};
	});
	t.mock.method(globalThis, "clearInterval", () => { active = false; });
	let start: (event: unknown, ctx: unknown) => Promise<void>;
	let shutdown: () => void;
	let header: { render(width: number): string[]; dispose(): void };
	// Stroke warmup is module-global; a dedicated instance keeps the settle count deterministic.
	const { default: isolatedStartup } = await import(new URL("../extensions/startup-banner.ts?pulse", import.meta.url).href) as typeof import("../extensions/startup-banner.ts");
	isolatedStartup({ on: (name: string, fn: typeof start) => {
		if (name === "session_start") start = fn;
		if (name === "session_shutdown") shutdown = fn as unknown as () => void;
	}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
	const ctx = { hasUI: true, cwd: "/fixture", ui: { setHeader(factory: (tui: unknown, theme: unknown) => typeof header) {
		header = factory({ requestRender() {} }, { fg: (_role: string, text: string) => text });
	} } };
	const startBanner = async (policy: string) => {
		writeFileSync(join(home, "animations.json"), JSON.stringify({ schema: "drakonc-pi.animations/v1", policy }));
		await start!({}, ctx); boot!();
		for (let i = 0; i < 15; i++) await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(active, true, `${policy} starts its animation interval`);
	};
	const advance = () => { clock += delay; pulse!(); };
	try {
		await startBanner("quality");
		assert.equal(delay, 25);
		for (let i = 0; i < 32; i++) advance(); // Past the fade-in (10) and flash (22) phases.
		const frames = [header!.render(200).join("\n")];
		for (let i = 0; i < 4; i++) { advance(); frames.push(header!.render(200).join("\n")); }
		const settled = frames[0];
		assert.deepEqual(frames.slice(0, 4), [settled, settled, settled, settled],
			"quality holds one rose pulse step across its 4-tick (~100ms) quantum");
		assert.notEqual(frames[4], settled, "quality advances the pulse on the next quantum");
		header!.dispose();
		await startBanner("performance");
		assert.equal(delay, 250);
		for (let i = 0; i < 4; i++) advance();
		const performanceFrame = header!.render(200).join("\n");
		advance();
		assert.notEqual(header!.render(200).join("\n"), performanceFrame,
			"performance keeps painting a new pulse step on every 250ms paint");
	} finally { header!.dispose(); shutdown!(); }
});

// docs/readme-reference.md: banner changes apply on the next session or
// /reload. session_start disposes the previous header before its guards, so a
// /reload that returned early would leave the editor without a header at all.
test("/reload repaints the complete static banner instead of replaying the intro", async (t) => {
	const home = mkdtempSync(join(tmpdir(), "gp-banner-reload-"));
	const previousHome = process.env.DRAKONC_PI_CONFIG_HOME;
	process.env.DRAKONC_PI_CONFIG_HOME = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.DRAKONC_PI_CONFIG_HOME;
		else process.env.DRAKONC_PI_CONFIG_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	});
	t.mock.method(fs, "readFile", async () => JSON.stringify({ showRose: true, showTextLogo: true, color: "pink" }));
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	const argv = process.argv;
	process.argv = ["node"];
	t.after(() => { process.argv = argv; });
	for (const [key, value] of [["rows", 40], ["columns", 200]] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(process.stdout, key);
		Object.defineProperty(process.stdout, key, { configurable: true, writable: true, value });
		t.after(() => descriptor ? Object.defineProperty(process.stdout, key, descriptor) : Reflect.deleteProperty(process.stdout, key));
	}
	const save = (policy: string) => writeFileSync(join(home, "animations.json"), JSON.stringify({ schema: "drakonc-pi.animations/v1", policy }));
	let boot: () => void;
	let active = false;
	let clock = 0;
	t.mock.method(Date, "now", () => clock);
	t.mock.method(globalThis, "setTimeout", (callback: () => void, ms: number) => {
		if (ms === 50) boot = callback; // Never run operational stats/home reads.
		return {};
	});
	t.mock.method(globalThis, "setInterval", () => { active = true; return {}; });
	t.mock.method(globalThis, "clearInterval", () => { active = false; });
	let start: (event: unknown, ctx: unknown) => Promise<void>;
	let header: { render(width: number): string[]; dispose(): void };
	let headers = 0;
	const { default: isolatedStartup } = await import(new URL("../extensions/startup-banner.ts?reload", import.meta.url).href) as typeof import("../extensions/startup-banner.ts");
	isolatedStartup({ on: (name: string, fn: typeof start) => {
		if (name === "session_start") start = fn;
	}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
	const ctx = { hasUI: true, cwd: "/fixture", ui: { setHeader(factory: (tui: unknown, theme: unknown) => typeof header) {
		headers++;
		header = factory({ requestRender() {} }, { fg: (_role: string, text: string) => text });
	} } };
	try {
		// Potato renders the completed static artwork immediately: its glyphs are
		// the reference for "complete", independent of the pulse phase.
		save("potato");
		await start!({}, ctx); boot!();
		assert.equal(headers, 1);
		assert.equal(active, false, "potato starts no animation interval");
		const staticGlyphs = stripAnsi(header!.render(200).join("\n"));
		header!.dispose();
		save("quality");
		await start!({ reason: "reload" }, ctx);
		boot!();
		assert.equal(headers, 2, "/reload installs a header instead of leaving the editor without one");
		assert.equal(active, false, "/reload starts no intro animation interval");
		const reloaded = header!.render(200).join("\n");
		assert.equal(stripAnsi(reloaded), staticGlyphs,
			"/reload repaints the complete artwork instead of replaying the letter-writing intro");
		assert.match(reloaded, /\x1b\[38;2;255;140;210m/, "/reload paints the settled logo palette");
		assert.match(reloaded, /\x1b\[38;2;255;140;210m█/, "/reload paints the settled logo");
	} finally { header!.dispose(); }
});
