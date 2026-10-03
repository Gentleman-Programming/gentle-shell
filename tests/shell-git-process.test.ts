import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { win32 } from "node:path";
import test from "node:test";
import { runShellGit } from "../lib/shell-git-process.ts";
import type { execFile } from "node:child_process";

function fixture(mode = "timeout", pid: number | undefined = 42) {
	const calls: Array<{ command?: string; args?: string[]; options?: any; kill?: boolean }> = [];
	const child = Object.assign(new EventEmitter(), { pid, kill: () => { calls.push({ kill: true }); return true; } });
	let callback: (...args: any[]) => void;
	const run = ((command: string, args: string[], options: any, cb: any) => {
		calls.push({ command, args, options });
		if (command === "git") {
			callback = cb;
			if (options.timeout && mode === "timeout") setTimeout(() => cb({ code: 0, killed: true }, "", ""), options.timeout);
			if (mode === "success") cb(null, "output", "");
			if (mode === "error") cb({ code: "ENOENT" }, "", "");
			if (mode === "throw") throw new Error("spawn failed");
			return child;
		}
		if (mode === "cleanup-throw") throw new Error("cleanup spawn failed");
		if (mode === "late") {
			child.emit("close");
			callback({ code: 0 }, "partial", "");
		}
		if (mode === "exit-cleanup" || mode === "exit-stuck") child.emit("exit", 0, null);
		if (mode !== "stuck" && mode !== "exit-stuck") cb({ code: 1 }, "", "");
		return Object.assign(new EventEmitter(), { kill: () => true });
	}) as typeof execFile;
	return { calls, child, run, finish: (...args: any[]) => callback(...args) };
}

test("Windows timeout starts trusted PID tree cleanup before root termination", async () => {
	const f = fixture();
	const result = await runShellGit("/repo", ["status"], { PATH: "poison", SystemRoot: "evil" }, f.run, "win32", 5);
	assert.equal(f.calls[0].options.timeout, 0);
	assert.equal(f.calls[1].command, win32.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "taskkill.exe"));
	assert.deepEqual(f.calls[1].args, ["/PID", "42", "/T", "/F"]);
	assert.equal(f.calls[1].options.shell, false);
	assert.equal(f.calls[1].options.windowsHide, true);
	assert.equal(f.calls[1].options.env, undefined, "cleanup does not inherit caller Git environment");
	assert.equal(f.calls[1].options.timeout, 1000);
	assert.equal(result.code, 1);
	assert.ok(f.calls.findIndex(c => c.kill) > 1);
});

test("success and spawn errors cancel deadlines without cleanup", async () => {
	for (const mode of ["success", "error", "throw"]) {
		const f = fixture(mode);
		const result = await runShellGit("/repo", [], {}, f.run, "win32", 5);
		assert.equal(result.code, mode === "success" ? 0 : 1);
		await new Promise(resolve => setTimeout(resolve, 15));
		assert.equal(f.calls.length, 1);
	}
});

test("non-Windows retains execFile timeout and uncapped output", async () => {
	const f = fixture("success");
	await runShellGit("/repo", [], { PATH: "safe" }, f.run, "linux", 5);
	assert.equal(f.calls[0].options.timeout, 5);
	assert.equal(f.calls[0].options.maxBuffer, Infinity);
	assert.deepEqual(f.calls[0].options.env, { PATH: "safe" });
	assert.deepEqual(f.calls[0].args, ["-C", "/repo"]);
});

test("cleanup spawn exception settles as a failure", async () => {
	const f = fixture("cleanup-throw");
	assert.equal((await runShellGit("/repo", [], {}, f.run, "win32", 5)).code, 1);
	assert.equal(f.calls.filter(c => c.kill).length, 1);
});

test("stuck cleanup settles within its bounded fallback", async () => {
	const f = fixture("stuck");
	const start = Date.now();
	assert.equal((await runShellGit("/repo", [], {}, f.run, "win32", 5)).code, 1);
	assert.ok(Date.now() - start < 2500);
	assert.equal(f.calls.filter(c => c.kill).length, 1);
	f.finish(null, "too late", "");
	assert.equal(f.calls.filter(c => c.kill).length, 1);
});

test("late zero-code callback cannot succeed or kill a closed root", async () => {
	const f = fixture("late");
	assert.deepEqual(await runShellGit("/repo", [], {}, f.run, "win32", 5), { stdout: "partial", code: 1 });
	assert.equal(f.calls.filter(c => c.kill).length, 0);
	f.finish(null, "later success", "");
	assert.equal(f.calls.filter(c => c.kill).length, 0);
});

test("missing or invalid PID never invokes taskkill", async () => {
	for (const pid of [undefined, 0, -1, NaN, 1.5]) {
		const f = fixture();
		f.child.pid = pid;
		assert.equal((await runShellGit("/repo", [], {}, f.run, "win32", 5)).code, 1);
		assert.equal(f.calls.filter(c => c.command).length, 1);
	}
});

test("close before deadline prevents tree cleanup against a recycled PID", async () => {
	const f = fixture();
	const result = runShellGit("/repo", [], {}, f.run, "win32", 5);
	f.child.emit("close");
	assert.equal((await result).code, 1);
	assert.equal(f.calls.length, 1);
});

test("exit before close prevents all root PID addressing and still settles", async () => {
	const f = fixture();
	const result = runShellGit("/repo", [], {}, f.run, "win32", 5);
	f.child.emit("exit", 0, null);
	assert.deepEqual(await result, { stdout: "", code: 1 });
	assert.equal(f.calls.length, 1, "neither taskkill nor root.kill after exit");
	f.finish(null, "late output", "");
	assert.equal(f.calls.length, 1);
});

test("exit during cleanup prevents root kill on callback and bounded fallback", async () => {
	for (const mode of ["exit-cleanup", "exit-stuck"]) {
		const f = fixture(mode);
		const start = Date.now();
		assert.equal((await runShellGit("/repo", [], {}, f.run, "win32", 5)).code, 1);
		assert.ok(Date.now() - start < 2500);
		assert.equal(f.calls.length, 2, "only Git and tree cleanup started before exit");
		f.finish(null, "late success", "");
		assert.equal(f.calls.length, 2);
	}
});

test("exit before deadline preserves callback stdout and success if received in time", async () => {
	const f = fixture();
	const result = runShellGit("/repo", [], {}, f.run, "win32", 50);
	f.child.emit("exit", 0, null);
	f.finish(null, "complete output", "");
	assert.deepEqual(await result, { stdout: "complete output", code: 0 });
	await new Promise(resolve => setTimeout(resolve, 65));
	assert.equal(f.calls.length, 1);
});

test("exitCode and signalCode guard roots that ended before listeners attached", async () => {
	for (const state of [{ exitCode: 0 }, { signalCode: "SIGTERM" }]) {
		const f = fixture();
		Object.assign(f.child, state);
		assert.equal((await runShellGit("/repo", [], {}, f.run, "win32", 5)).code, 1);
		assert.equal(f.calls.length, 1);
	}
});

test("asynchronous spawn error cancels deadline", async () => {
	const f = fixture();
	const result = runShellGit("/repo", [], {}, f.run, "win32", 5);
	f.child.emit("error", new Error("spawn failed"));
	assert.equal((await result).code, 1);
	await new Promise(resolve => setTimeout(resolve, 15));
	assert.equal(f.calls.length, 1);
});
