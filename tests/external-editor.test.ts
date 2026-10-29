import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { openInExternalEditor } from "../lib/external-editor.ts";

function fixture(result: Partial<ReturnType<typeof spawnSync>> = { status: 0 }) {
	const events: string[] = [];
	const host = { stop: () => events.push("stop"), start: () => events.push("start"), requestRender: (force?: boolean) => events.push(`render:${force}`) };
	type Options = { cwd?: string; stdio: string; shell: boolean };
	const calls: { command: string; args: string[]; options: Options }[] = [];
	const spawn = ((command: string, args: string[], options: Options) => {
		events.push("spawn");
		calls.push({ command, args, options });
		return result;
	}) as typeof spawnSync;
	return { host, spawn, calls, events };
}

test("editor paths remain single arguments without a shell", () => {
	const f = fixture();
	const path = "a&echo GS_2426_EXECUTED&rem tail.txt";
	assert.equal(openInExternalEditor(f.host, path, { VISUAL: "editor.exe -w", EDITOR: "ignored" }, f.spawn, "/linked"), true);
	assert.deepEqual(f.calls, [{ command: "editor.exe", args: ["-w", path], options: { cwd: "/linked", stdio: "inherit", shell: false } }]);
	assert.deepEqual(f.events, ["stop", "spawn", "start", "render:true"]);
});

test("Windows batch editors are refused before spawning and name a direct executable alternative", { skip: process.platform !== "win32" }, () => {
	for (const editor of ["editor.cmd", "editor.BAT"]) {
		const f = fixture();
		assert.throws(() => openInExternalEditor(f.host, "safe.txt", { EDITOR: editor }, f.spawn), /executable.*\.exe/i);
		assert.deepEqual(f.calls, []);
		assert.deepEqual(f.events, []);
	}
});

test("editor launch failures are reported after restoring the TUI", () => {
	for (const result of [{ error: new Error("ENOENT"), status: null }, { status: 7 }, { status: null, signal: "SIGTERM" as const }]) {
		const f = fixture(result);
		assert.throws(() => openInExternalEditor(f.host, "safe.txt", { EDITOR: "editor.exe" }, f.spawn), /Could not open editor/);
		assert.deepEqual(f.events, ["stop", "spawn", "start", "render:true"]);
	}
});

test("editor retains VISUAL precedence, flags, cwd, and missing-editor behavior", () => {
	const f = fixture();
	assert.equal(openInExternalEditor(f.host, "lib/a.ts", { VISUAL: "nvim -u none", EDITOR: "vi" }, f.spawn, "/linked"), true);
	assert.equal(f.calls[0].command, "nvim");
	assert.deepEqual(f.calls[0].args, ["-u", "none", "lib/a.ts"]);
	assert.equal(f.calls[0].options.cwd, "/linked");
	assert.equal(openInExternalEditor(f.host, "lib/a.ts", {}, f.spawn), false);
	assert.deepEqual(f.events, ["stop", "spawn", "start", "render:true"]);
});

test("a real editor process receives a metacharacter filename unchanged", () => {
	const root = mkdtempSync(join(process.cwd(), ".editor-test-"));
	try {
		const script = join(root, "editor.cjs");
		writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
		const path = join(root, "a&echo GS_2426_EXECUTED&rem tail.txt");
		writeFileSync(path, "unchanged");
		const f = fixture();
		let child: ReturnType<typeof spawnSync> | undefined;
		const spawn = ((command: string, args: string[], options: object) => {
			child = spawnSync(command, args, { ...options, stdio: "pipe", encoding: "utf8", timeout: 3000 });
			return child;
		}) as typeof spawnSync;
		assert.equal(openInExternalEditor(f.host, path, { EDITOR: `node ${relative(process.cwd(), script)}` }, spawn, process.cwd()), true);
		assert.equal(child?.status, 0);
		assert.equal(child?.stdout, JSON.stringify([path]));
		assert.equal(child?.stderr, "");
		assert.deepEqual(f.events, ["stop", "start", "render:true"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("synchronous spawn exceptions restore the TUI before reporting failure", () => {
	const f = fixture();
	const spawn = (() => { throw new Error("spawn failed"); }) as typeof spawnSync;
	assert.throws(() => openInExternalEditor(f.host, "safe.txt", { EDITOR: "editor.exe" }, spawn), { message: "Could not open editor: spawn failed" });
	assert.deepEqual(f.events, ["stop", "start", "render:true"]);
});
