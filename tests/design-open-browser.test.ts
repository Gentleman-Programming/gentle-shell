import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { openInBrowser } from "../lib/design-open-browser.ts";

type Call = { command: string; args: readonly string[]; options: Record<string, unknown> };
const URL_ = "http://127.0.0.1:4321/abc/";

function fakeSpawn(outcome: "spawn" | "error" | "throw") {
	const calls: Call[] = [];
	let unrefs = 0;
	const spawn = (command: string, args: readonly string[], options: Record<string, unknown>) => {
		calls.push({ command, args, options });
		if (outcome === "throw") throw new Error("spawn exploded");
		const child = Object.assign(new EventEmitter(), { unref: () => { unrefs++; } });
		queueMicrotask(() => outcome === "spawn" ? child.emit("spawn") : child.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })));
		return child;
	};
	return { spawn: spawn as never, calls, unrefs: () => unrefs };
}

const OPTIONS = { detached: true, stdio: "ignore", windowsHide: true, shell: false };

test("darwin opens the URL with /usr/bin/open, detached and hidden", async () => {
	const fake = fakeSpawn("spawn");
	assert.deepEqual(await openInBrowser(URL_, { platform: "darwin", spawn: fake.spawn }), { opened: true });
	assert.deepEqual(fake.calls, [{ command: "/usr/bin/open", args: [URL_], options: OPTIONS }]);
	assert.equal(fake.unrefs(), 1);
});

test("win32 uses the absolute rundll32 FileProtocolHandler", async () => {
	const fake = fakeSpawn("spawn");
	assert.deepEqual(await openInBrowser(URL_, { platform: "win32", spawn: fake.spawn, env: { SystemRoot: "C:\\Windows" } }), { opened: true });
	assert.deepEqual(fake.calls, [{ command: "C:\\Windows\\System32\\rundll32.exe", args: ["url.dll,FileProtocolHandler", URL_], options: OPTIONS }]);
	const missing = fakeSpawn("spawn");
	const result = await openInBrowser(URL_, { platform: "win32", spawn: missing.spawn, env: {} });
	assert.equal(result.opened, false);
	assert.match(String(result.error), /SystemRoot/);
	assert.deepEqual(missing.calls, []);
});

test("other platforms use xdg-open", async () => {
	for (const platform of ["linux", "freebsd"] as const) {
		const fake = fakeSpawn("spawn");
		assert.deepEqual(await openInBrowser(URL_, { platform, spawn: fake.spawn }), { opened: true });
		assert.deepEqual(fake.calls, [{ command: "xdg-open", args: [URL_], options: OPTIONS }]);
	}
});

test("spawn failures resolve opened:false and never throw", async () => {
	const failing = fakeSpawn("error");
	const result = await openInBrowser(URL_, { platform: "linux", spawn: failing.spawn });
	assert.equal(result.opened, false);
	assert.match(String(result.error), /ENOENT/);
	const throwing = fakeSpawn("throw");
	const thrown = await openInBrowser(URL_, { platform: "darwin", spawn: throwing.spawn });
	assert.equal(thrown.opened, false);
	assert.match(String(thrown.error), /spawn exploded/);
});

test("only loopback http URLs are opened", async () => {
	for (const url of ["https://example.com/", "file:///etc/passwd", "-flag", "http://evil.example:1/", "javascript:alert(1)"]) {
		const fake = fakeSpawn("spawn");
		const result = await openInBrowser(url, { platform: "linux", spawn: fake.spawn });
		assert.equal(result.opened, false, url);
		assert.deepEqual(fake.calls, [], url);
	}
	const localhost = fakeSpawn("spawn");
	assert.equal((await openInBrowser("http://localhost:4321/t/", { platform: "linux", spawn: localhost.spawn })).opened, true);
});
