import assert from "node:assert/strict";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import startup, { readGitBranch } from "../extensions/startup-banner.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../lib/terminal-theme.ts";

test("startup artwork spells Gentle Shell with aligned animation spans", () => {
	const source = readFileSync(new URL("../extensions/startup-banner.ts", import.meta.url), "utf8");
	const logo = JSON.parse(source.match(/const TEXT_LOGO = (\[[\s\S]*?\]);/)![1].replace(/,\s*]/, "]")) as string[];
	const weights = JSON.parse(source.match(/const LETTER_WEIGHTS = (\[[^;]+\]);/)![1]) as number[];
	// Preserve the original script, including its descending G and dark shadow.
	const gentle = [
		"                  ▄▄▄▀▀▀▀▀██                                ▄▄▀▄▄",
		"              ▄▄█▀▀▒▒▒▒▒▄▄█▀▒                   ▄██     ▄▄█▀█▄█▀▒▒",
		"          ▄▄██▀▒▒▒▒▒▄▄▄▀▀▒▒▒▒        ▄▄▄  ▀▀▀▀██▀▀▀▀▀███▀█▄▀▀▒▒▒▒",
		"        ▄██▀▒▒▒▒     ▒▒▄▄█ ▄▄▄▀██ ▄▄▄▀▀▀▄  ▄██▀▒▒▒▒▄██▀▀▀▒▄▄███",
		"       ██▀▒▒▒     ▄▄▄███▀▄██▀▀▀▄▄██▀▀▄█▀▄▄██▀▒▒▒▄▄██▀▒▒▄██▀▀▀▄▄",
		"       ▀█▄▄▄▄▄▀▀▀█▄▄███▄▒▀▀▀▀▀▀▒▀▀▒▒▀▀▀▀▒██▄▄▀▀▀ ▀█▄▀▀▀ ▀▀▀▀▀▒▒",
		"        ▒▄▄▄█▀▀▀█▄█▀▀▒▒▒▒ ▒▒▒▒▒▒ ▒▒  ▒▒▒▒ ▒▒▒▒▒▒▒ ▒▒▒▒▒▒ ▒▒▒▒▒",
		"     ▄▄▀▀ ▒▒▒▒▄██▀▒▒▒▒",
		"   ▄█ ▒▒▒▄▄██▀▀▒▒▒▒",
		"    ▀▀▀▀▀▀▒▒▒▒▒▒",
		"     ▒▒▒▒▒▒",
	];
	assert.equal(logo.length, 11, "retain the full-height script silhouette");
	for (const [row, prefix] of gentle.entries()) {
		assert.ok(logo[row].startsWith(prefix), `original Gentle script row ${row}`);
		assert.ok(logo[row].includes("▒") || row === 0, "retain dark shadow");
	}
	assert.equal(weights.length, 11, "one variable-width span per GENTLESHELL letter");
	assert.ok(new Set(weights).size > 2, "script spans must not use fixed block-font widths");
	assert.ok(logo.slice(0, 7).every((line) => /[▄▀█]/.test(line.slice(68))), "Shell has tall slanted strokes");
	assert.ok(logo.slice(1, 7).every((line) => /▒/.test(line.slice(68))), "Shell retains the dark shadow");
	const shell = logo.map((line) => line.slice(68));
	assert.match(shell[0], /▄▄█▀▀▀██/, "S has its upper bowl");
	assert.match(shell[3], /▀▀▀██▄▄/, "S curves into its lower bowl");
	assert.match(shell[5], /▀█▄▄▄▄█▀▀▒▒/, "S closes with a shadowed exit stroke");
	assert.match(shell[4], /▄██▀▄██▀██▒/, "h has a rising stem and connected arch");
	assert.deepEqual(logo.slice(3, 6).map((line) => line.slice(93, 101)), [
		" ▄▄▀▀██ ",
		"▄██▄▄▀▒ ",
		"▀█▄▄▄▄▀▀",
	], "e has an upper loop/counter, a crossbar, and a curved lower exit rather than a wedge");
	assert.equal(logo[3][100], " ", "e loop stays distinct from the following l");
	assert.equal(logo[4][100], " ", "e counter opens before the l stem without moving it");
	assert.equal(shell[0].split("▄▄▀▄▄").length - 1, 2, "both l ascenders retain looped tops");
	assert.match(shell[5], /█▄▄▀▀▀▄▄▀█▄▄▀▀▀$/, "both l exits connect with an ascending script stroke");
	assert.equal(Math.max(...logo.map((line) => line.length)), 120, "connected script retains glyph scale while tightening letter placement");
	// Like Gentle, adjacent baseline strokes must meet, not merely have smaller gaps.
	assert.match(shell[4], /▀██▄▄██▀▄██▀██▒/, "S exit meets the h entry");
	assert.match(shell[5], /▀█▄▄▄▄▀▀█▄▄▀▀▀/, "e lower exit still meets the unchanged l stem");
	assert.match(shell[5], /██▄▄▀▀█▄▄▄▄▀▀/, "h exit remains connected to e");
	assert.deepEqual(weights, [22, 9, 8, 9, 8, 9, 10, 13, 8, 8, 13]);
	assert.equal(weights.reduce((sum, width) => sum + width, 0), Math.max(...logo.map((line) => line.length)) - 3,
		"span widths exactly cover the ink bounds from the G descender to the final l shadow");
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
		options: { encoding: "utf8", shell: false, windowsHide: true },
    }]);
});

test("startup banner keeps animating after invalidate and cleans up on dispose", async (t) => {
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
	assert.match(header!.render(200).join("\n"), /\x1b\[38;2;95;30;60m▒/, "script shadow keeps the dark pink palette");
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

// Drive the real header factory; background git/home reads never run.
for (const showRose of [false, true]) for (const showTextLogo of [false, true]) {
	test(`startup art respects rose=${showRose}, logo=${showTextLogo} and cyan palette`, async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		t.mock.method(fs, "readFile", async () => JSON.stringify({ showRose, showTextLogo, color: "cyan" }));
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
		startup({ on: (name: string, fn: Function) => {
			if (name === "session_start") start = fn;
			if (name === "session_shutdown") shutdown = fn;
		}, registerCommand() {}, getCommands: () => [], getAllTools: () => [] } as unknown as ExtensionAPI);
		const write = t.mock.method(process.stdout, "write", (text: string) => { writes.push(String(text)); return true; });
		await start!({}, { hasUI: true, cwd: "/fixture", ui: { setHeader: (factory: Function) => {
			header = factory({ requestRender() {} }, { fg: (_role: string, text: string) => text });
		} } });
		t.mock.timers.tick(50);
		try {
			for (const width of [40, 80, 160, 200]) {
				const lines = header!.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				const text = stripAnsi(lines.join("\n"));
				assert.match(text, /GIT:/);
				assert.match(text, /PATH:/);
				if (width >= 160) {
					assert.equal(/[\u2800-\u28ff]/.test(text), showRose);
					assert.equal(/[▒▄▀█]/.test(text), showTextLogo);
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
			assert.doesNotMatch(minimal, /[\u2800-\u28ff]/);
			assert.equal(/[▒▄▀█]/.test(minimal), showTextLogo);
			assert.deepEqual(writes, [], "Pi owns stdout during startup and resize");
		} finally {
			shutdown!();
			write.mock.restore();
		}
	});
}
