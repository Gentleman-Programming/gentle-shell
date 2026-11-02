import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isWsl, readClipboardImage, sniffImageMimeType, type ClipboardCommandRunner } from "../lib/clipboard-image.ts";

// A 2×1 PNG header: signature, IHDR length/type, width 2, height 1.
const PNG_2X1 = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00,
]);

type Call = { command: string; args: readonly string[]; env?: Record<string, string> | undefined };
type Reply = Buffer | undefined | ((call: Call) => Buffer | undefined);

// Scripted backends keyed by `command firstArg`; anything unscripted is "not installed".
function runner(replies: Record<string, Reply>): { run: ClipboardCommandRunner; calls: Call[] } {
	const calls: Call[] = [];
	const run: ClipboardCommandRunner = async (command, args, options) => {
		const call = { command, args, env: options?.env };
		calls.push(call);
		const reply = replies[`${command} ${args[0] ?? ""}`.trim()] ?? replies[command];
		return typeof reply === "function" ? reply(call) : reply;
	};
	return { run, calls };
}

const BMP = new Uint8Array([0x42, 0x4d, 0x00, 0x00]);
const noProc = () => undefined;

// Real sockets named like a compositor's, so the reader must both find one and
// hand its name to wl-paste. A terminal started by a service (systemd unit,
// tmux server, or a multiplexer's daemon) inherits no WAYLAND_DISPLAY, and
// wl-paste then guesses wayland-0: on a compositor that took wayland-1 every
// clipboard read fails and images never attach.
async function runtimeDirWithSockets(names: readonly string[]): Promise<{ dir: string; close: () => Promise<void> }> {
	const dir = mkdtempSync(join(tmpdir(), "gentle-clipboard-"));
	const servers: Server[] = [];
	for (const name of names) {
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(join(dir, name), resolve));
		servers.push(server);
	}
	return {
		dir,
		close: async () => {
			for (const server of servers) await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

test("WSL reads a Windows screenshot through PowerShell when the Linux clipboard has none", async () => {
	const { run, calls } = runner({
		"wl-paste --list-types": Buffer.from("text/plain\n"),
		"powershell.exe": Buffer.from(`${Buffer.from(PNG_2X1).toString("base64")}\r\n`),
	});
	const image = await readClipboardImage({ env: { WSL_DISTRO_NAME: "Ubuntu" }, platform: "linux", run, native: () => undefined, procVersion: noProc });
	assert.deepEqual(image && { mimeType: image.mimeType, bytes: [...image.bytes] }, { mimeType: "image/png", bytes: [...PNG_2X1] });
	const powershell = calls.find((call) => call.command === "powershell.exe");
	assert.ok(powershell, "PowerShell was consulted");
	// The image travels on stdout as base64: no temp file path is ever passed.
	const script = powershell.args.at(-1) ?? "";
	assert.match(script, /ToBase64String/);
	assert.doesNotMatch(script, /\$path|Save\('|tmp/i);
});

test("WSL falls back to PowerShell when wl-paste and xclip are not installed", async () => {
	const { run, calls } = runner({ "powershell.exe": Buffer.from(Buffer.from(PNG_2X1).toString("base64")) });
	const image = await readClipboardImage({ env: { WSL_INTEROP: "/run/WSL/1_interop" }, platform: "linux", run, native: () => undefined, procVersion: noProc });
	assert.equal(image?.mimeType, "image/png");
	assert.deepEqual(calls.map((call) => call.command), ["wl-paste", "xclip", "powershell.exe"]);
});

test("Wayland prefers PNG and never asks Windows on a native Linux desktop", async () => {
	const { run, calls } = runner({
		"wl-paste --list-types": Buffer.from("image/jpeg\nimage/png\ntext/plain\n"),
		"wl-paste --type": (call) => call.args[1] === "image/png" ? Buffer.from(PNG_2X1) : undefined,
	});
	const image = await readClipboardImage({ env: { WAYLAND_DISPLAY: "wayland-0" }, platform: "linux", run, native: () => undefined, procVersion: noProc });
	assert.equal(image?.mimeType, "image/png");
	assert.ok(!calls.some((call) => call.command === "powershell.exe"));
});

test("an empty Windows clipboard, an unsupported format, or Termux leave the paste to Pi", async () => {
	const empty = runner({ "powershell.exe": Buffer.from("\r\n") });
	assert.equal(await readClipboardImage({ env: { WSL_DISTRO_NAME: "Ubuntu" }, platform: "linux", run: empty.run, native: () => undefined, procVersion: noProc }), null);
	const bmp = runner({ "xclip -selection": (call) => call.args.includes("TARGETS") ? Buffer.from("image/png\n") : Buffer.from(BMP) });
	assert.equal(await readClipboardImage({ env: {}, platform: "linux", run: bmp.run, native: () => undefined, procVersion: noProc }), null);
	const termux = runner({});
	assert.equal(await readClipboardImage({ env: { TERMUX_VERSION: "0.118" }, platform: "linux", run: termux.run, procVersion: noProc }), null);
	assert.equal(termux.calls.length, 0);
});

test("macOS reads the native clipboard but leaves copied files to Pi", async () => {
	const native = (files: string[] | null) => () => ({
		getText: async () => null,
		getImage: async () => PNG_2X1,
		getFilePaths: async () => files,
	});
	const image = await readClipboardImage({ env: {}, platform: "darwin", native: native(null) });
	assert.equal(image?.mimeType, "image/png");
	assert.equal(await readClipboardImage({ env: {}, platform: "darwin", native: native(["/Users/me/shot.png"]) }), null);
	assert.equal(await readClipboardImage({ env: {}, platform: "win32", native: () => undefined }), null);
});

test("a failed wl-paste read falls through to xclip, as Pi does", async () => {
	const { run, calls } = runner({
		"wl-paste --list-types": Buffer.from("image/png\n"),
		"xclip -selection": (call) => call.args.includes("TARGETS") ? Buffer.from("image/png\n") : Buffer.from(PNG_2X1),
	});
	const image = await readClipboardImage({ env: { WAYLAND_DISPLAY: "wayland-0" }, platform: "linux", run, native: () => undefined, procVersion: noProc });
	assert.equal(image?.mimeType, "image/png");
	assert.deepEqual(calls.map((call) => call.command), ["wl-paste", "wl-paste", "xclip", "xclip"]);
});

test("files copied in a Linux file manager stay Pi's even when an image is offered too", async () => {
	const { run, calls } = runner({ "wl-paste --list-types": Buffer.from("image/png\ntext/uri-list\n") });
	const native = () => ({ getText: async () => null, getImage: async () => PNG_2X1, getFilePaths: async () => ["/home/me/shot.png"] });
	assert.equal(await readClipboardImage({ env: { WAYLAND_DISPLAY: "wayland-0" }, platform: "linux", run, native, procVersion: noProc }), null);
	assert.equal(calls.length, 0);
});

test("a terminal that inherited no WAYLAND_DISPLAY still reads the compositor's socket", async () => {
	const runtime = await runtimeDirWithSockets(["wayland-1"]);
	try {
		// A stale lock file must not be mistaken for a socket.
		writeFileSync(join(runtime.dir, "wayland-0.lock"), "");
		const { run, calls } = runner({
			"wl-paste --list-types": Buffer.from("image/png\n"),
			"wl-paste --type": Buffer.from(PNG_2X1),
		});
		const image = await readClipboardImage({ env: { XDG_RUNTIME_DIR: runtime.dir }, platform: "linux", run, native: () => undefined, procVersion: noProc });
		assert.equal(image?.mimeType, "image/png");
		assert.deepEqual(calls.map((call) => [call.command, call.args[0], call.env]), [
			["wl-paste", "--list-types", { WAYLAND_DISPLAY: "wayland-1" }],
			["wl-paste", "--type", { WAYLAND_DISPLAY: "wayland-1" }],
		]);
	} finally {
		await runtime.close();
	}
});

test("an explicit WAYLAND_DISPLAY wins over a socket found in the runtime directory", async () => {
	const runtime = await runtimeDirWithSockets(["wayland-1"]);
	try {
		const { run, calls } = runner({
			"wl-paste --list-types": Buffer.from("image/png\n"),
			"wl-paste --type": Buffer.from(PNG_2X1),
		});
		const image = await readClipboardImage({ env: { WAYLAND_DISPLAY: "wayland-9", XDG_RUNTIME_DIR: runtime.dir }, platform: "linux", run, native: () => undefined, procVersion: noProc });
		assert.equal(image?.mimeType, "image/png");
		// Either the override or the inherited environment names the explicit
		// display; the discovered socket is never used.
		assert.deepEqual(calls.map((call) => call.command), ["wl-paste", "wl-paste"]);
		assert.ok(calls.every((call) => (call.env?.WAYLAND_DISPLAY ?? "wayland-9") === "wayland-9"));
	} finally {
		await runtime.close();
	}
});

test("no compositor socket and no Wayland session keeps X11 in charge", async () => {
	const runtime = await runtimeDirWithSockets([]);
	try {
		const { run, calls } = runner({
			"xclip -selection": (call) => call.args.includes("TARGETS") ? Buffer.from("image/png\n") : Buffer.from(PNG_2X1),
		});
		const image = await readClipboardImage({ env: { XDG_RUNTIME_DIR: runtime.dir, DISPLAY: ":0" }, platform: "linux", run, native: () => undefined, procVersion: noProc });
		assert.equal(image?.mimeType, "image/png");
		assert.deepEqual(calls.map((call) => call.command), ["xclip", "xclip"]);
	} finally {
		await runtime.close();
	}
});

test("image formats are identified by signature", () => {
	assert.equal(sniffImageMimeType(PNG_2X1), "image/png");
	assert.equal(sniffImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
	assert.equal(sniffImageMimeType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), "image/gif");
	assert.equal(sniffImageMimeType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), "image/webp");
	assert.equal(sniffImageMimeType(BMP), undefined);
});

test("WSL is detected from its environment or the kernel version", () => {
	assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, noProc), true);
	assert.equal(isWsl({}, () => "Linux version 6.6.87.2-microsoft-standard-WSL2"), true);
	assert.equal(isWsl({}, () => "Linux version 6.8.0-generic"), false);
});
