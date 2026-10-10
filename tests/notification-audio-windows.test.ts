import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	FIXED_WINDOWS_POWERSHELL_EXE,
	NATIVE_WINDOWS_SCHEMA,
	NativeWindowsPlayer,
	WSL_WINDOWS_POWERSHELL_EXE,
	isWindowsAbsolutePath,
	isWslPosixAbsolutePath,
	isWslTarget,
	toWslUncPath,
	type NativeWindowsOptions,
	type NativeWindowsSpawnOptions,
} from "../lib/notification-audio-windows.ts";

const probeOk = () => JSON.stringify({ schema: NATIVE_WINDOWS_SCHEMA, ok: true, available: true, formats: ["wav"] });
const playOk = () => JSON.stringify({ schema: NATIVE_WINDOWS_SCHEMA, ok: true, played: true });
/** The encoded command is the only dynamic argv; decode it to inspect what PowerShell would run. */
const decodeCommand = (encoded: string): string => Buffer.from(encoded, "base64").toString("utf16le");
/** The probe awaits the fixed-host access check before spawning; flush before observing the child. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly kills: string[] = [];
	kill(signal: string): boolean { this.kills.push(signal); return true; }
}

const WSL_ENV: NodeJS.ProcessEnv = { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/4242_interop" };
function wslRecorder(env: NodeJS.ProcessEnv = WSL_ENV) {
	return recorder("linux", { env });
}

function recorder(platform = "win32", overrides: Partial<NativeWindowsOptions> = {}) {
	const spawned: Array<{ executable: string; args: string[]; options: NativeWindowsSpawnOptions }> = [];
	const children: FakeChild[] = [];
	const executableChecks: string[] = [];
	const player = new NativeWindowsPlayer({
		platform,
		executableAvailable: async (path) => { executableChecks.push(path); return true; },
		spawn: (executable, args, options) => { spawned.push({ executable, args, options }); const child = new FakeChild(); children.push(child); return child; },
		env: {
			SystemRoot: "D:\\Hostile", windir: "D:\\Hostile", TEMP: "C:\\Temp", TMP: "C:\\Tmp", USERPROFILE: "C:\\Users\\u",
			OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "x", AWS_SECRET_ACCESS_KEY: "y",
			NODE_OPTIONS: "--inspect", NODE_PATH: "/n", DEBUG: "*", PATH: "C:\\evil", GENTLE_AUDIO_SNAPSHOT: "C:\\leak.wav",
		},
		...overrides,
	});
	return { player, spawned, children, executableChecks };
}

test("windows adapter is lazy, supports only win32 and stays silent elsewhere", async () => {
	const { player, spawned, children, executableChecks } = recorder();
	assert.deepEqual(spawned, []);
	assert.deepEqual(executableChecks, []);
	assert.deepEqual(player.getNativeFormats(), []);
	assert.equal(player.supportsTarget(), true);
	const controller = new AbortController(); controller.abort();
	assert.deepEqual(await player.probe(controller.signal), { available: false, formats: [] });
	assert.deepEqual(executableChecks, []);
	assert.equal(spawned.length, 0);
	assert.equal(children.length, 0);
	for (const platform of ["linux", "darwin", "freebsd"]) {
		const other = recorder(platform);
		assert.equal(other.player.supportsTarget(), false);
		assert.deepEqual(await other.player.probe(), { available: false, formats: [] });
		assert.deepEqual(other.executableChecks, []);
		assert.equal(other.spawned.length, 0);
		await assert.rejects(other.player.play("C:\\Temp\\sound.wav"), /Native Windows/);
		assert.equal(other.spawned.length, 0);
	}
});

test("a successful probe checks the fixed host and caches wav only after real output", async () => {
	const { player, spawned, children, executableChecks } = recorder();
	const probing = player.probe();
	await flush();
	assert.deepEqual(executableChecks, [FIXED_WINDOWS_POWERSHELL_EXE]);
	assert.equal(spawned.length, 1);
	const [call] = spawned;
	assert.equal(call.executable, FIXED_WINDOWS_POWERSHELL_EXE);
	assert.deepEqual(call.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
	assert.match(call.args[4]!, /^[A-Za-z0-9+/=]+$/);
	assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);
	assert.equal(call.options.shell, false);
	assert.equal(call.options.windowsHide, true);
	assert.equal(call.options.detached, false);
	assert.deepEqual(player.getNativeFormats(), []); // never cached before a validated probe
	children[0]!.stdout.emit("data", probeOk());
	children[0]!.emit("close", 0);
	assert.deepEqual(await probing, { available: true, formats: ["wav"] });
	assert.deepEqual(player.getNativeFormats(), ["wav"]);
});

test("probe is unavailable when the fixed host is missing or denied, without spawning", async () => {
	for (const behavior of ["false", "throw"] as const) {
		const spawned: number[] = [];
		const player = new NativeWindowsPlayer({
			platform: "win32",
			executableAvailable: async () => { if (behavior === "throw") throw new Error("denied"); return false; },
			spawn: () => { spawned.push(1); throw new Error("must not spawn"); },
		});
		assert.deepEqual(await player.probe(), { available: false, formats: [] });
		assert.deepEqual(player.getNativeFormats(), []);
		assert.deepEqual(spawned, []);
	}
});

test("probe treats malformed, multiline, oversize and false output as unavailable", async () => {
	const envelope = probeOk();
	const cases: Array<(child: FakeChild) => void> = [
		(child) => child.stdout.emit("data", "not json"),
		(child) => child.stdout.emit("data", JSON.stringify({ schema: "wrong", ok: true, available: true, formats: ["wav"] })),
		(child) => child.stdout.emit("data", `${envelope}\n${envelope}`),
		(child) => child.stdout.emit("data", JSON.stringify({ schema: NATIVE_WINDOWS_SCHEMA, ok: false, available: false, formats: [] })),
		(child) => child.stdout.emit("data", JSON.stringify({ schema: NATIVE_WINDOWS_SCHEMA, ok: true, available: true, formats: ["ogg"] })),
	];
	for (const emit of cases) {
		const { player, children } = recorder();
		const probing = player.probe();
		await flush();
		emit(children[0]!);
		children[0]!.emit("close", 0);
		assert.deepEqual(await probing, { available: false, formats: [] });
		assert.deepEqual(player.getNativeFormats(), []);
	}
	const oversize = recorder();
	const probing = oversize.player.probe();
	await flush();
	oversize.children[0]!.stdout.emit("data", "x".repeat(2048));
	assert.deepEqual(oversize.children[0]!.kills, ["SIGKILL"]);
	oversize.children[0]!.emit("close", 1);
	assert.deepEqual(await probing, { available: false, formats: [] });
});

test("play gates synchronously once, encodes the snapshot and resolves on a clean close", async () => {
	const snapshot = "C:\\Users\\u\\AppData\\Local\\Temp\\gentle-123\\sound.wav";
	const { player, spawned, children } = recorder();
	let calls = 0;
	const playing = player.play(snapshot, undefined, () => { calls += 1; return true; });
	assert.equal(calls, 1); // gate ran synchronously before the spawn
	assert.equal(spawned.length, 1);
	const encoded = spawned[0]!.args[4]!;
	assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
	const script = decodeCommand(encoded);
	const embedded = script.match(/FromBase64String\('([^']*)'\)/)?.[1];
	assert.ok(embedded, "the play script must decode one embedded base64 literal");
	assert.equal(Buffer.from(embedded!, "base64").toString("utf8"), snapshot, "the embedded bytes must round-trip to the exact snapshot");
	assert.ok(!script.includes(snapshot), "the raw snapshot path must never appear in the command");
	children[0]!.stdout.emit("data", playOk());
	children[0]!.emit("close", 0);
	await playing;
});

test("a false permit performs no IO and throws the shared not-permitted error", async () => {
	const { player, spawned, children } = recorder();
	await assert.rejects(player.play("C:\\Temp\\sound.wav", undefined, () => false), (error: Error) => error.name === "NativePulseNotPermittedError");
	assert.equal(spawned.length, 0);
	assert.equal(children.length, 0);
	const second = recorder();
	await assert.rejects(second.player.play("C:\\Temp\\sound.wav", undefined, { permit: () => false }), /permit/);
	assert.equal(second.spawned.length, 0);
});

test("hostile snapshot characters cannot reach PowerShell unencoded", async () => {
	const hostile = "C:\\Temp\\a'; Start-Process calc; $x=`whoami`; #.wav";
	const { player, spawned, children } = recorder();
	const playing = player.play(hostile);
	const encoded = spawned[0]!.args[4]!;
	assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
	const script = decodeCommand(encoded);
	assert.ok(script.includes(Buffer.from(hostile, "utf8").toString("base64")));
	assert.ok(!script.includes("whoami") && !script.includes("Start-Process") && !script.includes(hostile));
	children[0]!.stdout.emit("data", playOk());
	children[0]!.emit("close", 0);
	await playing;
});

test("play rejects non-Windows-absolute snapshots before any spawn", async () => {
	assert.equal(isWindowsAbsolutePath("C:\\Users\\u\\sound.wav"), true);
	assert.equal(isWindowsAbsolutePath("C:\\"), true);
	const invalid: Array<string> = [
		"/tmp/sound.wav", "C:sound.wav", "\\\\server\\share\\sound.wav", "//server/share/sound.wav",
		"C:\\a\\b:sound.wav", "C:\\a\u0000b.wav", "https://example.com/sound.wav", "",
	];
	for (const path of invalid) {
		assert.equal(isWindowsAbsolutePath(path), false, path);
		const { player, spawned, children } = recorder();
		await assert.rejects(player.play(path), /Native Windows/);
		assert.equal(spawned.length, 0);
		assert.equal(children.length, 0);
	}
});

test("play rejects privately on wrong schema, multiline, oversize and nonzero close", async () => {
	const snapshot = "C:\\Users\\u\\AppData\\Local\\Temp\\gentle\\sound.wav";
	const variants: Array<{ emit: (child: FakeChild) => void; code: number }> = [
		{ emit: (child) => child.stdout.emit("data", "not json"), code: 0 },
		{ emit: (child) => child.stdout.emit("data", JSON.stringify({ schema: "wrong", ok: true, played: true })), code: 0 },
		{ emit: (child) => child.stdout.emit("data", `${playOk()}\n${playOk()}`), code: 0 },
		{ emit: (child) => child.stdout.emit("data", playOk()), code: 1 },
		{ emit: (child) => child.stdout.emit("data", "x".repeat(2048)), code: 0 },
	];
	for (const variant of variants) {
		const { player, children } = recorder();
		const playing = player.play(snapshot);
		variant.emit(children[0]!);
		children[0]!.emit("close", variant.code);
		await assert.rejects(playing, (error: Error) => /Native Windows/.test(error.message) && !error.message.includes(snapshot) && !/AppData|sound\.wav/.test(error.message));
	}
});

test("timeout and abort SIGKILL once and settle only on close", async () => {
	const timed = recorder("win32", { probeTimeoutMs: 15 });
	const probing = timed.player.probe();
	await new Promise((resolve) => setTimeout(resolve, 45));
	assert.deepEqual(timed.children[0]!.kills, ["SIGKILL"]);
	let settled = false; void probing.then(() => { settled = true; });
	timed.children[0]!.emit("exit", 0);
	timed.children[0]!.emit("error", new Error("spawn failed")); // Node emits close after error
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(settled, false);
	timed.children[0]!.emit("close", 0);
	assert.deepEqual(await probing, { available: false, formats: [] });

	const aborted = recorder();
	const controller = new AbortController();
	const playing = aborted.player.play("C:\\Temp\\sound.wav", controller.signal);
	controller.abort();
	assert.deepEqual(aborted.children[0]!.kills, ["SIGKILL"]);
	aborted.children[0]!.emit("close", 0);
	await assert.rejects(playing, /aborted|Native Windows/);
});

test("default play deadline is 11000 ms and outlives the accepted 10 s maximum", async () => {
	let scheduledMs = 0; let fire: (() => void) | undefined;
	const { player, children } = recorder("win32", {
		setTimeout: (callback, ms) => { scheduledMs = ms; fire = callback; return 1; },
		clearTimeout: () => {},
	});
	const playing = player.play("C:\\Temp\\sound.wav", undefined, () => true);
	assert.equal(children.length, 1);
	assert.equal(scheduledMs, 11000);
	assert.ok(scheduledMs > 10000, "the Windows adapter must outlive the accepted 10 s file");
	assert.deepEqual(children[0]!.kills, []);
	fire!();
	assert.deepEqual(children[0]!.kills, ["SIGKILL"]);
	children[0]!.emit("close", 0);
	await assert.rejects(playing, /Native Windows/);
});

test("a synchronous spawn failure rejects privately without pending children", async () => {
	const player = new NativeWindowsPlayer({
		platform: "win32",
		executableAvailable: async () => true,
		spawn: () => { throw new Error("boom C:\\private leak"); },
	});
	assert.deepEqual(await player.probe(), { available: false, formats: [] });
	await assert.rejects(player.play("C:\\Temp\\sound.wav"), (error: Error) => /Native Windows/.test(error.message) && !/private|leak/.test(error.message));
});

test("child environment is a fixed Windows allowlist with forced SystemRoot", async () => {
	const captured: NodeJS.ProcessEnv[] = [];
	const player = new NativeWindowsPlayer({
		platform: "win32",
		executableAvailable: async () => true,
		spawn: (_executable, _args, options) => { captured.push(options.env); return new FakeChild(); },
		env: {
			SystemRoot: "D:\\Hostile", windir: "D:\\Hostile", TEMP: "C:\\Temp", TMP: "C:\\Tmp", USERPROFILE: "C:\\Users\\u",
			OPENAI_API_KEY: "sk", ANTHROPIC_API_KEY: "x", AWS_SECRET_ACCESS_KEY: "y",
			NODE_OPTIONS: "--inspect", NODE_PATH: "/n", DEBUG: "*", PATH: "C:\\evil", GENTLE_AUDIO_SNAPSHOT: "C:\\leak.wav",
		},
	});
	void player.probe();
	await flush();
	const env = captured[0]!;
	assert.equal(env.SystemRoot, "C:\\Windows");
	assert.equal(env.windir, "C:\\Windows");
	assert.equal(env.TEMP, "C:\\Temp");
	assert.equal(env.TMP, "C:\\Tmp");
	assert.equal(env.USERPROFILE, "C:\\Users\\u");
	for (const drop of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "NODE_OPTIONS", "NODE_PATH", "DEBUG", "PATH", "GENTLE_AUDIO_SNAPSHOT"])
		assert.equal(env[drop], undefined, drop);
});

test("an aborted play performs no IO and never calls the gate", async () => {
	const { player, spawned, children } = recorder();
	const controller = new AbortController(); controller.abort();
	let calls = 0;
	await assert.rejects(player.play("C:\\Temp\\sound.wav", controller.signal, () => { calls += 1; return true; }), /Native Windows/);
	assert.equal(calls, 0);
	assert.equal(spawned.length, 0);
	assert.equal(children.length, 0);
});

test("an injected timer is installed once and cleared when the child closes", async () => {
	const timers: Array<() => void> = [];
	const cleared: unknown[] = [];
	let handle = 0;
	const { player, children } = recorder("win32", {
		setTimeout: (callback) => { timers.push(callback); return ++handle; },
		clearTimeout: (value) => { cleared.push(value); },
	});
	const probing = player.probe();
	await flush();
	assert.equal(timers.length, 1);
	children[0]!.stdout.emit("data", probeOk());
	children[0]!.emit("close", 0);
	assert.deepEqual(await probing, { available: true, formats: ["wav"] });
	assert.deepEqual(cleared, [1]);
});

test("probe rejects a valid ready envelope when the process closes nonzero", async () => {
	const { player, children } = recorder();
	const probing = player.probe();
	await flush();
	children[0]!.stdout.emit("data", probeOk());
	children[0]!.emit("close", 1);
	assert.deepEqual(await probing, { available: false, formats: [] });
	assert.deepEqual(player.getNativeFormats(), []);
});

test("probe rejects ready output that overflows the byte cap and kills exactly once", async () => {
	const { player, children } = recorder();
	const probing = player.probe();
	await flush();
	children[0]!.stdout.emit("data", probeOk());
	children[0]!.stdout.emit("data", " ".repeat(3000));
	children[0]!.stdout.emit("data", " ".repeat(3000));
	assert.deepEqual(children[0]!.kills, ["SIGKILL"]);
	children[0]!.emit("close", 0);
	assert.deepEqual(await probing, { available: false, formats: [] });
	assert.deepEqual(player.getNativeFormats(), []);
});

test("play rejects played output that overflows the byte cap even on a clean close", async () => {
	const { player, children } = recorder();
	const playing = player.play("C:\\Temp\\sound.wav");
	children[0]!.stdout.emit("data", playOk());
	children[0]!.stdout.emit("data", " ".repeat(3000));
	assert.deepEqual(children[0]!.kills, ["SIGKILL"]);
	children[0]!.emit("close", 0);
	await assert.rejects(playing, (error: Error) => /Native Windows/.test(error.message) && !error.message.includes("sound.wav"));
});

test("the fixed play script disposes the SoundPlayer in a finally block", async () => {
	const { player, spawned, children } = recorder();
	const playing = player.play("C:\\Temp\\sound.wav");
	const script = decodeCommand(spawned[0]!.args[4]!);
	assert.match(script, /\$player = \$null/, "the local player must be pre-initialized to null");
	const finallyIndex = script.indexOf("finally {");
	const disposeIndex = script.indexOf(".Dispose(");
	assert.ok(finallyIndex !== -1, "a finally block must exist");
	assert.ok(disposeIndex > finallyIndex, "the SoundPlayer must be disposed inside the finally block");
	assert.ok(!/AppData|sound\.wav/.test(script), "the raw snapshot path must not appear in the script");
	children[0]!.stdout.emit("data", playOk());
	children[0]!.emit("close", 0);
	await playing;
});

test("the fixed play script plays bounded snapshot bytes from memory, never the file path", async () => {
	const hostile = "C:\\Temp\\a'; Start-Process calc; $x=`whoami`; #.wav";
	const { player, spawned, children } = recorder();
	const playing = player.play(hostile);
	const script = decodeCommand(spawned[0]!.args[4]!);
	// the snapshot is opened read-only/shared-read, never through a file-URI SoundPlayer ctor
	assert.match(script, /\[IO\.File\]::Open\(\$path, \[IO\.FileMode\]::Open, \[IO\.FileAccess\]::Read, \[IO\.FileShare\]::Read\)/);
	assert.match(script, /\$count = \$file\.Length/);
	// the 2 MiB bound must be checked before any byte buffer is allocated or read
	const sizeIndex = script.indexOf("2097152");
	const allocIndex = script.indexOf("[byte[]]::new(");
	const readIndex = script.indexOf("$file.Read(");
	assert.ok(sizeIndex !== -1 && allocIndex !== -1 && readIndex !== -1, "size guard, allocation and read must exist");
	assert.ok(sizeIndex < allocIndex && sizeIndex < readIndex, "the size bound must precede allocation and read");
	// a full-length read loop rejects a short read and detects a file that grew
	assert.match(script, /while \(\$read -lt \$count\)/);
	assert.match(script, /\$file\.ReadByte\(\) -ne -1/);
	// the SoundPlayer is built from the MemoryStream, never the path/string overload
	assert.match(script, /\[IO\.MemoryStream\]::new\(/);
	assert.match(script, /\[System\.Media\.SoundPlayer\]::new\(\$memory\)/);
	assert.ok(!script.includes("New-Object"), "the SoundPlayer must not use the ambiguous file-path New-Object form");
	assert.ok(!/SoundPlayer[ (]+\$path/.test(script), "the path must never reach the SoundPlayer constructor");
	// the file lock is released before playback and every resource is disposed
	const closeIndex = script.indexOf("$file.Close()");
	const loadIndex = script.indexOf("$player.Load()");
	const playIndex = script.indexOf("$player.PlaySync()");
	assert.ok(closeIndex !== -1 && closeIndex < playIndex, "the file must close before PlaySync");
	assert.ok(loadIndex !== -1 && loadIndex < playIndex, "the memory snapshot must be validated with Load before PlaySync");
	assert.match(script, /\$memory\.Dispose\(\)/);
	assert.match(script, /\$file\.Dispose\(\)/);
	// hostile bytes still only reach PowerShell as one opaque base64 literal
	const embedded = script.match(/FromBase64String\('([^']*)'\)/)?.[1];
	assert.equal(Buffer.from(embedded!, "base64").toString("utf8"), hostile);
	assert.ok(!script.includes("whoami") && !script.includes("Start-Process") && !script.includes(hostile));
	children[0]!.stdout.emit("data", playOk());
	children[0]!.emit("close", 0);
	await playing;
});

test("wsl interop target is lazy, supports via linux env, and selects the fixed mounted host", async () => {
	const { player, spawned, children, executableChecks } = wslRecorder();
	assert.deepEqual(player.getNativeFormats(), []);
	assert.equal(player.supportsTarget(), true);
	assert.deepEqual(spawned, []); // construction and support checks stay IO-free
	assert.deepEqual(executableChecks, []);
	const probing = player.probe();
	await flush();
	assert.deepEqual(executableChecks, [WSL_WINDOWS_POWERSHELL_EXE]);
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0]!.executable, WSL_WINDOWS_POWERSHELL_EXE);
	assert.deepEqual(spawned[0]!.options.stdio, ["ignore", "pipe", "pipe"]);
	assert.deepEqual(player.getNativeFormats(), []); // never cached before a validated probe
	children[0]!.stdout.emit("data", probeOk());
	children[0]!.emit("close", 0);
	assert.deepEqual(await probing, { available: true, formats: ["wav"] });
	assert.deepEqual(player.getNativeFormats(), ["wav"]);
});

test("wsl detection fails closed for a missing distro, bad interop path or invalid name", async () => {
	const cases: NodeJS.ProcessEnv[] = [
		{},
		{ WSL_DISTRO_NAME: "Ubuntu" },
		{ WSL_INTEROP: "/run/WSL/1_interop" },
		{ WSL_DISTRO_NAME: "", WSL_INTEROP: "/run/WSL/1_interop" },
		{ WSL_DISTRO_NAME: ".", WSL_INTEROP: "/run/WSL/1_interop" },
		{ WSL_DISTRO_NAME: "..", WSL_INTEROP: "/run/WSL/1_interop" },
		{ WSL_DISTRO_NAME: "a/b", WSL_INTEROP: "/run/WSL/1_interop" },
		{ WSL_DISTRO_NAME: "a:b", WSL_INTEROP: "/run/WSL/1_interop" },
		{ WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "relative_interop" },
		{ WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/tmp/1_interop" },
		{ WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/1" },
		{ WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/../1_interop" },
		{ WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL//1_interop" },
	];
	for (const env of cases) {
		assert.equal(isWslTarget(env), false, JSON.stringify(env));
		const { player, spawned, children, executableChecks } = wslRecorder(env);
		assert.equal(player.supportsTarget(), false);
		assert.deepEqual(await player.probe(), { available: false, formats: [] });
		assert.deepEqual(executableChecks, []);
		assert.equal(spawned.length, 0);
		await assert.rejects(player.play("/tmp/sound.wav"), /Native Windows/);
		assert.equal(spawned.length, 0);
		assert.equal(children.length, 0);
	}
	for (const platform of ["darwin", "freebsd"]) {
		assert.equal(recorder(platform, { env: WSL_ENV }).player.supportsTarget(), false, platform);
	}
	assert.equal(isWslTarget(WSL_ENV), true);
});

test("wsl play maps one POSIX snapshot to a single encoded UNC path without interpolating data", async () => {
	const distro = "Ubuntu 22.04 \u00f1";
	const snapshot = "/tmp/gentle-1/\u00f1 'quote' $x `y`; sound.wav";
	const { player, spawned, children } = wslRecorder({ WSL_DISTRO_NAME: distro, WSL_INTEROP: "/run/WSL/7_interop" });
	const playing = player.play(snapshot);
	assert.equal(spawned.length, 1);
	const encoded = spawned[0]!.args[4]!;
	assert.match(encoded, /^[A-Za-z0-9+/=]+$/);
	const script = decodeCommand(encoded);
	const embedded = script.match(/FromBase64String\('([^']*)'\)/)?.[1];
	assert.ok(embedded, "the play script must decode one embedded base64 literal");
	const decoded = Buffer.from(embedded!, "base64").toString("utf8");
	assert.equal(decoded, toWslUncPath(distro, snapshot));
	assert.equal(decoded, `\\\\wsl.localhost\\${distro}\\tmp\\gentle-1\\\u00f1 'quote' $x \`y\`; sound.wav`);
	assert.ok(!script.includes(snapshot), "the raw POSIX snapshot must never appear in the command");
	assert.ok(!/whoami|Start-Process/.test(script), "no snapshot byte may become command text");
	children[0]!.stdout.emit("data", playOk());
	children[0]!.emit("close", 0);
	await playing;
});

test("wsl snapshot validation rejects relative, traversal, drive, URI and externally supplied UNC paths", async () => {
	const invalid: Array<string> = [
		"tmp/sound.wav", "/tmp/../etc/x.wav", "/tmp/./x.wav", "/tmp//x.wav", "/tmp/x.wav/..",
		"C:\\Temp\\x.wav", "\\\\wsl.localhost\\Ubuntu\\tmp\\x.wav", "//wsl.localhost/Ubuntu/tmp/x.wav",
		"file:///tmp/x.wav", "/tmp/a:b.wav", "/tmp/a\\b.wav", "/tmp/a\u0000b.wav", "https://example.com/x.wav", "",
	];
	for (const path of invalid) {
		assert.equal(isWslPosixAbsolutePath(path), false, path);
		const { player, spawned, children } = wslRecorder();
		await assert.rejects(player.play(path), /Native Windows/);
		assert.equal(spawned.length, 0);
		assert.equal(children.length, 0);
	}
	assert.equal(isWslPosixAbsolutePath("/tmp/sound.wav"), true);
	assert.equal(toWslUncPath("Ubuntu", "/" + "a".repeat(4096)), undefined, "the mapped UNC path must respect the 4096 byte bound");
	const oversized = wslRecorder();
	await assert.rejects(oversized.player.play("/" + "a".repeat(4096)), /Native Windows/);
	assert.equal(oversized.spawned.length, 0);
});

test("native windows drive validation is unchanged and never admits a WSL UNC path", async () => {
	assert.equal(isWindowsAbsolutePath("C:\\"), true);
	assert.equal(isWindowsAbsolutePath("C:\\Users\\u\\x.wav"), true);
	assert.equal(isWindowsAbsolutePath("\\\\wsl.localhost\\Ubuntu\\tmp\\x.wav"), false);
	assert.equal(isWindowsAbsolutePath("\\\\wsl$\\Ubuntu\\tmp\\x.wav"), false);
	assert.equal(isWindowsAbsolutePath("/tmp/x.wav"), false);
	const { player, spawned } = recorder();
	await assert.rejects(player.play("\\\\wsl.localhost\\Ubuntu\\tmp\\x.wav"), /Native Windows/);
	assert.equal(spawned.length, 0);
});

test("a WSL false permit performs no IO and the gate runs once before a close-settled spawn", async () => {
	const denied = wslRecorder();
	await assert.rejects(denied.player.play("/tmp/sound.wav", undefined, () => false), (error: Error) => error.name === "NativePulseNotPermittedError");
	assert.equal(denied.spawned.length, 0);
	const { player, spawned, children } = wslRecorder();
	let calls = 0;
	const playing = player.play("/tmp/sound.wav", undefined, () => { calls += 1; return true; });
	assert.equal(calls, 1);
	assert.equal(spawned.length, 1);
	let settled = false; void playing.then(() => { settled = true; });
	children[0]!.emit("exit", 0);
	await flush();
	assert.equal(settled, false, "play must settle only on close");
	children[0]!.stdout.emit("data", playOk());
	children[0]!.emit("close", 0);
	await playing;
	assert.equal(calls, 1);
});

test("wsl child env keeps only the interop pair and cannot redirect the fixed host", async () => {
	const captured: Array<{ executable: string; env: NodeJS.ProcessEnv }> = [];
	const player = new NativeWindowsPlayer({
		platform: "linux",
		env: {
			WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/9_interop",
			SystemRoot: "D:\\Hostile", windir: "D:\\Hostile", PATH: "/evil", WSLENV: "GENTLE_AUDIO_SNAPSHOT",
			GENTLE_AUDIO_SNAPSHOT: "/tmp/leak.wav", OPENAI_API_KEY: "sk", NODE_OPTIONS: "--inspect",
			TEMP: "/tmp", USERPROFILE: "C:\\Users\\u",
		},
		executableAvailable: async () => true,
		spawn: (executable, _args, options) => { captured.push({ executable, env: options.env }); return new FakeChild(); },
	});
	void player.probe();
	await flush();
	assert.equal(captured[0]!.executable, WSL_WINDOWS_POWERSHELL_EXE);
	const env = captured[0]!.env;
	assert.equal(env.SystemRoot, "C:\\Windows");
	assert.equal(env.windir, "C:\\Windows");
	assert.equal(env.WSL_INTEROP, "/run/WSL/9_interop");
	assert.equal(env.WSL_DISTRO_NAME, "Ubuntu");
	assert.equal(env.TEMP, "/tmp");
	assert.equal(env.USERPROFILE, "C:\\Users\\u");
	for (const drop of ["PATH", "WSLENV", "GENTLE_AUDIO_SNAPSHOT", "OPENAI_API_KEY", "NODE_OPTIONS"])
		assert.equal(env[drop], undefined, drop);
});

test("wsl probe denies and an aborted wsl play is inert without spawning", async () => {
	const deniedSpawned: number[] = [];
	const denied = new NativeWindowsPlayer({
		platform: "linux", env: WSL_ENV,
		executableAvailable: async () => false,
		spawn: () => { deniedSpawned.push(1); throw new Error("must not spawn"); },
	});
	assert.deepEqual(await denied.probe(), { available: false, formats: [] });
	assert.deepEqual(denied.getNativeFormats(), []);
	assert.deepEqual(deniedSpawned, []);
	const { player, spawned, children } = wslRecorder();
	const controller = new AbortController(); controller.abort();
	let calls = 0;
	await assert.rejects(player.play("/tmp/sound.wav", controller.signal, () => { calls += 1; return true; }), /Native Windows/);
	assert.equal(calls, 0);
	assert.equal(spawned.length, 0);
	assert.equal(children.length, 0);
});

test("windows adapter source stays free of SDK, addon, script resource and audio imports", () => {
	const source = readFileSync(join(process.cwd(), "lib", "notification-audio-windows.ts"), "utf8");
	assert.doesNotMatch(source, /@earendil-works/);
	assert.doesNotMatch(source, /\.ps1|ExecutionPolicy/);
	assert.doesNotMatch(source, /\.node["']|native\//);
	assert.doesNotMatch(source, /postinstall|installer|download/i);
	assert.doesNotMatch(source, /wslpath/i, "the fixed host must never be resolved through a WSL path translator");
	assert.doesNotMatch(source, /from\s+["']\.\/notification-audio\.ts["']/, "no production import cycle with the routing module");
});
