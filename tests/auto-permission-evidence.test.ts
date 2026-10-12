import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { readAutoPermissionEvidence, resolveAutoPermissionEvidencePath } from "../lib/auto-permission-evidence.ts";

const cwd = process.cwd();
const path = "docs/auto-permission-evidence.md";
test("Auto evidence-limit diagnostics distinguish invalid budgets, stat size and read growth", async t => {
	const path = "fixture.ts";
	const check = (tag: string) => (error: any) => {
		assert.equal(error.message, "evidence-limit");
		assert.equal(error.evidenceLimit, tag);
		assert.deepEqual(Object.keys(error), ["evidenceLimit"]);
		return true;
	};
	for (const maxBytes of [0, -1, NaN, 1.5])
		await assert.rejects(readAutoPermissionEvidence({ cwd, paths: [path], path, maxBytes }), check("invalid-byte-budget"));
	t.mock.method(fs, "realpath", async (path: string) => path);
	const stat = { dev: 1, ino: 1, nlink: 1, size: 11, mtimeMs: 0, ctimeMs: 0,
		isSymbolicLink: () => false, isFile: () => true };
	t.mock.method(fs, "lstat", async () => stat);
	let opened = 0, closed = 0;
	t.mock.method(fs, "open", async () => {
		opened++;
		return { stat: async () => stat, read: async (buffer: Buffer, offset: number, length: number) =>
			({ bytesRead: Buffer.from("x".repeat(11)).copy(buffer, offset, offset, offset + length) }),
			close: async () => { closed++; } };
	});
	await assert.rejects(readAutoPermissionEvidence({ cwd, paths: [path], path, maxBytes: 10 }), check("file-stat-bytes"));
	assert.equal(opened, 0);
	stat.size = 4;
	await assert.rejects(readAutoPermissionEvidence({ cwd, paths: [path], path, maxBytes: 10 }), check("file-read-bytes"));
	assert.equal(opened, 1); assert.equal(closed, 1);
});

test("evidence reads only a complete bounded relevant project file", async () => {
	const result = await readAutoPermissionEvidence({ cwd, paths: [path], path });
	assert.equal(result.path, path);
	assert.match(result.content, /Auto permission classifier evidence/);
});
test("evidence rejects escapes, credentials, unrelated files and special locations", async () => {
	for (const target of ["../outside.ts", "/etc/passwd", ".env", ".env.local", ".git/config", ".ssh/id_rsa",
		"credentials.json", "secrets/config.ts", "auth.json", ".pi/agent/auth.json", "node_modules/a.ts", "file:///etc/passwd", "foo\u0000.ts"]) {
		assert.throws(() => resolveAutoPermissionEvidencePath(cwd, [target], target), /evidence-unavailable/);
	}
	assert.throws(() => resolveAutoPermissionEvidencePath(cwd, [path], "package.json"), /evidence-unavailable/);
	await assert.rejects(readAutoPermissionEvidence({ cwd, paths: ["missing-file.ts"], path: "missing-file.ts" }), /evidence-unavailable/);
});
test("symlink components and hard links are rejected before opening", async t => {
	let opened = false;
	t.mock.method(fs, "realpath", async (path: string) => path);
	t.mock.method(fs, "open", async () => { opened = true; throw Error("must not open"); });
	let patch = { symlink: true, nlink: 1 };
	t.mock.method(fs, "lstat", async () => ({ isSymbolicLink: () => patch.symlink, isFile: () => true, nlink: patch.nlink }));
	for (patch of [{ symlink: true, nlink: 1 }, { symlink: false, nlink: 2 }]) {
		for (const path of ["fixture.ts", "directory/fixture.ts"])
			await assert.rejects(readAutoPermissionEvidence({ cwd, paths: [path], path }), /evidence-unavailable/);
	}
	assert.equal(opened, false);
});

test("replacement, binary content and file growth never yield partial evidence", async t => {
	t.mock.method(fs, "realpath", async (path: string) => path);
	const stat = { dev: 1, ino: 1, nlink: 1, size: 4, mtimeMs: 0, ctimeMs: 0,
		isSymbolicLink: () => false, isFile: () => true };
	t.mock.method(fs, "lstat", async () => stat);
	let closed = 0;
	let mode = "replacement";
	t.mock.method(fs, "open", async () => ({
			stat: async () => ({ ...stat, ino: mode === "replacement" ? 2 : 1 }),
			read: async (buffer: Buffer, offset: number, length: number) => {
				const data = Buffer.from(mode === "binary" ? "a\u0000bc" : "x".repeat(11));
				const copied = data.copy(buffer, offset, offset, offset + length);
				return { bytesRead: copied };
			}, close: async () => { closed++; }
		}));
	for (mode of ["replacement", "binary", "growth"]) {
		await assert.rejects(readAutoPermissionEvidence({ cwd, paths: ["fixture.ts"], path: "fixture.ts", maxBytes: 10 }),
			mode === "growth" ? /evidence-limit/ : /evidence-unavailable/);
	}
	assert.equal(closed, 3);
});

test("evidence cancellation and byte limits fail closed", async () => {
	const controller = new AbortController(); controller.abort();
	await assert.rejects(readAutoPermissionEvidence({ cwd, paths: [path], path, signal: controller.signal }), /cancelled/);
	await assert.rejects(readAutoPermissionEvidence({ cwd, paths: [path], path, maxBytes: 10 }), /evidence-limit/);
});
