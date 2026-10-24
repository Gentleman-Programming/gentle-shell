import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtemp, rm, writeFile, mkdir, readFile, realpath, symlink, stat, utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveWorkContext, listWorks, createWork, updateWork } from "../lib/gentle-works.ts";

async function fixture(t: TestContext) {
	// OS aliases such as macOS /var must not look like an attacker-controlled ancestor.
	const root = await realpath(await mkdtemp(join(tmpdir(), "gentle-works-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const git = (...args: string[]) => execFileSync("git", args, {
		encoding: "utf8", stdio: "pipe",
	});
	git("init", repo);
	git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
		"commit", "--allow-empty", "-m", "fixture");
	const linked = join(root, "linked");
	git("-C", repo, "worktree", "add", "-b", "linked", linked);
	const clone = join(root, "clone");
	git("clone", repo, clone);
	const home = join(root, "home");
	return { root, repo, linked, clone, home, context: await resolveWorkContext(repo, home) };
}
const input = {
	title: "Work", objective: "Deliver a result", summary: "", status: "pending" as const,
};
const unsafe = { message: "Unsafe work registry path" };

async function linkOrSkip(
	t: TestContext,
	target: string,
	path: string,
	directory: boolean,
): Promise<boolean> {
	try {
		await symlink(target, path, directory && process.platform === "win32" ? "junction" : directory ? "dir" : "file");
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
			t.skip(`Windows denied ${directory ? "junction" : "symlink"} creation: ${code}`);
			return false;
		}
		throw error;
	}
}

test("S1: linked worktrees share stable works across reload; independent clones do not", async t => {
	const f = await fixture(t);
	assert.deepEqual(await listWorks(f.context), { revision: 0, works: [] });
	const work = await createWork(f.context, {
		...input, branch: "main", worktree: f.linked, odd: "odd/tasks/work.md",
		session: { id: "session", file: join(f.root, "session.jsonl") },
	});
	const linked = await resolveWorkContext(f.linked, f.home);
	assert.deepEqual((await listWorks(linked)).works, [work]);
	assert.equal((await listWorks(await resolveWorkContext(f.clone, f.home))).works.length, 0);
	assert.equal(work.cloneIdentity, f.context.cloneIdentity);
	assert.ok(work.id);
});

test("S1: an aliased agent home canonicalizes to the same registry as the real directory", async t => {
	const f = await fixture(t);
	const alias = join(f.root, "home-alias");
	if (!await linkOrSkip(t, f.home, alias, true)) return;
	const aliased = await resolveWorkContext(f.repo, alias);
	assert.equal(aliased.registryFile, f.context.registryFile);
	assert.equal(aliased.lockFile, f.context.lockFile);
	const work = await createWork(aliased, input);
	assert.deepEqual((await listWorks(f.context)).works, [work]);
});

test("S4: rejected changes preserve bytes, public records and revisions", async t => {
	const { context } = await fixture(t);
	const work = await createWork(context, input);
	const before = await listWorks(context);
	const bytes = await readFile(context.registryFile, "utf8");
	for (const patch of [
		{ title: "" }, { objective: "x".repeat(4097) }, { status: "running" },
		{ summary: null }, { session: { id: "x" } }, { worktree: "../escape" },
		{ id: "replace" }, { activity: "running" },
	]) {
		await assert.rejects(updateWork(context, work.id, patch as any), { message: "Invalid work data" });
		assert.deepEqual(await listWorks(context), before);
		assert.equal(await readFile(context.registryFile, "utf8"), bytes);
	}
	await assert.rejects(createWork(context, { ...input, title: "" }), { message: "Invalid work data" });
	assert.deepEqual(await listWorks(context), before);
	assert.equal(await readFile(context.registryFile, "utf8"), bytes);
	const changed = await updateWork(context, work.id, { status: "completed", summary: "Explicitly done" });
	assert.equal(changed.status, "completed");
	assert.equal(changed.summary, "Explicitly done");
});

test("S4: a stale lock is never removed automatically; the error names it for manual removal", async t => {
	const { context } = await fixture(t);
	const work = await createWork(context, input);
	const before = await readFile(context.registryFile, "utf8");
	await writeFile(context.lockFile, "");
	await assert.rejects(updateWork(context, work.id, { summary: "no" }), { message: "Work registry busy" });
	const old = new Date(Date.now() - 10 * 60_000);
	await utimes(context.lockFile, old, old);
	await assert.rejects(updateWork(context, work.id, { summary: "no" }), error => {
		const { message } = error as Error;
		assert.match(message, /^Work registry lock is \d+s old; if no other Shell is updating works, delete /);
		assert.ok(message.endsWith(context.lockFile));
		return true;
	});
	assert.ok((await stat(context.lockFile)).isFile());
	assert.equal(await readFile(context.registryFile, "utf8"), before);
});

test("S4/S5: corrupt schema, nonregular targets and busy locks are errors, never empty", async t => {
	const { context } = await fixture(t);
	const work = await createWork(context, input);
	const before = await listWorks(context);
	const original = await readFile(context.registryFile, "utf8");
	for (const data of ["{", "{}", JSON.stringify({ version: 1, revision: 0, works: [{}] })]) {
		await writeFile(context.registryFile, data);
		await assert.rejects(listWorks(context), { message: "Invalid work registry" });
		await assert.rejects(createWork(context, input), { message: "Invalid work registry" });
		assert.equal(await readFile(context.registryFile, "utf8"), data);
	}
	await writeFile(context.registryFile, original);
	await mkdir(context.lockFile);
	await assert.rejects(updateWork(context, work.id, { summary: "no" }), { message: "Work registry busy" });
	assert.equal(await readFile(context.registryFile, "utf8"), original);
	assert.deepEqual(await listWorks(context), before);
	await rm(context.lockFile, { recursive: true });
	await rm(context.registryFile);
	await mkdir(context.registryFile);
	await assert.rejects(listWorks(context), unsafe);
	await assert.rejects(updateWork(context, work.id, { summary: "no" }), unsafe);
	await rm(context.registryFile, { recursive: true });
	await writeFile(context.registryFile, original);
	assert.deepEqual(await listWorks(context), before);
});

test("S4: registry file symlinks reject reads and writes without changing the target", async t => {
	const { context, root } = await fixture(t);
	const work = await createWork(context, input);
	const before = await listWorks(context);
	const bytes = await readFile(context.registryFile, "utf8");
	const target = join(root, "registry-target.json");
	await writeFile(target, bytes);
	await rm(context.registryFile);
	if (!await linkOrSkip(t, target, context.registryFile, false)) return;
	await assert.rejects(listWorks(context), unsafe);
	await assert.rejects(updateWork(context, work.id, { summary: "no" }), unsafe);
	assert.equal(await readFile(target, "utf8"), bytes);
	await rm(context.registryFile);
	await writeFile(context.registryFile, bytes);
	assert.deepEqual(await listWorks(context), before);
});

test("S4: directory junctions/symlinks reject reads and writes without changing the registry", async t => {
	const { context, root } = await fixture(t);
	const work = await createWork(context, input);
	const before = await listWorks(context);
	const bytes = await readFile(context.registryFile, "utf8");
	const alias = join(root, "redirected-store");
	if (!await linkOrSkip(t, dirname(context.registryFile), alias, true)) return;
	const registryFile = join(alias, "registry.json");
	const redirected = { ...context, registryFile, lockFile: `${registryFile}.lock` };
	await assert.rejects(listWorks(redirected), unsafe);
	await assert.rejects(createWork(redirected, input), unsafe);
	await assert.rejects(updateWork(redirected, work.id, { summary: "no" }), unsafe);
	assert.equal(await readFile(context.registryFile, "utf8"), bytes);
	assert.deepEqual(await listWorks(context), before);
});

test("S4: read permission and I/O errors propagate unchanged and rejected writes preserve state", async t => {
	const { context } = await fixture(t);
	const work = await createWork(context, input);
	const before = await listWorks(context);
	const bytes = await readFile(context.registryFile, "utf8");
	// Windows ACL changes would require host-specific tooling; inject only the read syscall.
	for (const code of ["EACCES", "EIO"]) {
		const failure = Object.assign(new Error(`Injected registry read failure: ${code}`), { code });
		const io = {
			readRegistry: async (path: string): Promise<string> => {
				assert.equal(path, context.registryFile);
				throw failure;
			},
		};
		const exact = (error: unknown) => {
			assert.equal(error, failure);
			assert.equal((error as NodeJS.ErrnoException).code, code);
			assert.equal((error as Error).message, `Injected registry read failure: ${code}`);
			return true;
		};
		await assert.rejects(listWorks(context, io), exact);
		await assert.rejects(createWork(context, input, io), exact);
		await assert.rejects(updateWork(context, work.id, { summary: "no" }, io), exact);
		assert.equal(await readFile(context.registryFile, "utf8"), bytes);
		assert.deepEqual(await listWorks(context), before);
	}
	// A subsequent write also proves that rejected operations released their locks.
	assert.equal((await updateWork(context, work.id, { summary: "accepted" })).revision, 2);
});

test("S4: POSIX new registry directories/files request private modes", async t => {
	if (process.platform === "win32") {
		t.skip("POSIX permission bits are not enforced by Windows");
		return;
	}
	const { context } = await fixture(t);
	await createWork(context, input);
	for (const path of [dirname(context.registryFile), dirname(dirname(context.registryFile))]) {
		assert.equal((await stat(path)).mode & 0o777, 0o700);
	}
	assert.equal((await stat(context.registryFile)).mode & 0o777, 0o600);
});

test("S4: independent cross-process patches preserve every accepted update with silent success", async t => {
	const { context } = await fixture(t);
	const work = await createWork(context, input);
	const moduleUrl = pathToFileURL(join(process.cwd(), "lib/gentle-works.ts")).href;
	const run = (patch: object) => new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
		const code = `import {updateWork} from ${JSON.stringify(moduleUrl)}; await updateWork(${JSON.stringify(context)}, ${JSON.stringify(work.id)}, ${JSON.stringify(patch)});`;
		const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", chunk => stdout += chunk);
		child.stderr.on("data", chunk => stderr += chunk);
		child.on("error", reject);
		child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
	});
	const outcomes = await Promise.all([
		run({ title: "Renamed" }), run({ summary: "Summary" }), run({ status: "blocked" }),
	]);
	for (const outcome of outcomes) {
		assert.deepEqual(outcome, { code: 0, signal: null, stdout: "", stderr: "" });
	}
	const saved = await listWorks(context);
	assert.equal(saved.revision, 4);
	assert.equal(saved.works[0].revision, 4);
	assert.equal(saved.works[0].title, "Renamed");
	assert.equal(saved.works[0].summary, "Summary");
	assert.equal(saved.works[0].status, "blocked");
});
