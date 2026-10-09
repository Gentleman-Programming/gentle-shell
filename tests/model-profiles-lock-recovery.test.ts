import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyModelConfig, applyModelConfigAsync, applySavedModelConfig } from "../extensions/gentle-ai.ts";
import { tryNativeFileLock, releaseNativeFileLock } from "../lib/native-file-lock.ts";

function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "ownership-recovery-"));
	const home = join(root, "agent");
	const config = join(root, "config");
	mkdirSync(join(home, "agents"), { recursive: true });
	mkdirSync(join(home, "gentle-ai"), { recursive: true });
	mkdirSync(config);
	const previous = [process.env.GENTLE_PI_AGENT_HOME, process.env.GENTLE_PI_CONFIG_HOME];
	process.env.GENTLE_PI_AGENT_HOME = home;
	process.env.GENTLE_PI_CONFIG_HOME = config;
	const children: ReturnType<typeof fork>[] = [];
	t.after(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) {
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
			}
		}
		for (const [index, key] of ["GENTLE_PI_AGENT_HOME", "GENTLE_PI_CONFIG_HOME"].entries()) {
			if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
		}
		rmSync(root, { recursive: true, force: true });
	});
	for (const name of ["worker", "helper"]) writeFileSync(join(home, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Agent\n---\nbody\n`);
	const routes = join(home, "subagents.json");
	writeFileSync(routes, JSON.stringify({ max_concurrency: 3, custom: { retained: true }, model_profiles: { outsider: { model: "openai/user" } } }));
	const tracking = join(home, "gentle-ai", "materialized-model-profiles.json");
	const lock = `${tracking}.lock`;
	function child(mode: string) {
		const child = fork(new URL("./fixtures/model-profile-lock-worker.mjs", import.meta.url), [mode, root, lock], { env: { ...process.env }, execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
		children.push(child);
		return child;
	}
	return { root, home, config, routes, tracking, lock, child };
}

async function clearAndAssert(f: ReturnType<typeof fixture>, names: string[], updated: number, skipped: number) {
	// Each discoverable non-builtin agent counts frontmatter and routing separately.
	assert.deepEqual(applyModelConfig(f.root, Object.fromEntries(names.map(name => [name, {}]))), { updated, skipped });
	const stored = JSON.parse(readFileSync(f.routes, "utf8"));
	for (const name of names) {
		assert.equal(name in stored.model_profiles, false);
		assert.doesNotMatch(readFileSync(join(f.home, "agents", `${name}.md`), "utf8"), /^(model|thinking):/m);
	}
	assert.equal(stored.max_concurrency, 3);
	assert.deepEqual(stored.custom, { retained: true });
	assert.deepEqual(stored.model_profiles.outsider, { model: "openai/user" });
}

test("held child excludes both ownership paths; death releases the same permanent inode and preserves cross-process union", { timeout: 20000 }, async t => {
	const f = fixture(t);
	const owner = f.child("hold");
	assert.equal((await once(owner, "message"))[0], "held");
	const inode = statSync(f.lock).ino;
	assert.equal(tryNativeFileLock(f.lock), undefined, "real held descriptor excludes this process");
	// Sync contention must remain bounded and must not write without a lock.
	applyModelConfig(f.root, { worker: { model: "openai/blocked" } });
	assert.equal(existsSync(f.tracking), false);
	const pending = applyModelConfigAsync(f.root, { worker: { model: "openai/worker", thinking: "high" } });
	await new Promise(resolve => setTimeout(resolve, 100));
	assert.equal(existsSync(f.tracking), false, "async path also waits without an unlocked write");
	const exited = once(owner, "exit");
	owner.kill("SIGKILL");
	await exited;
	await pending;
	assert.equal(statSync(f.lock).ino, inode, "no replacement-lock window");
	const fd = tryNativeFileLock(f.lock);
	assert.notEqual(fd, undefined);
	releaseNativeFileLock(fd!);
	const writer = f.child("apply");
	const writerExit = once(writer, "exit");
	assert.equal((await once(writer, "message"))[0], "applied");
	assert.equal((await writerExit)[0], 0);
	assert.deepEqual(JSON.parse(readFileSync(f.tracking, "utf8")).agents, ["helper", "worker"]);
	writeFileSync(join(f.config, "models.json"), JSON.stringify({ worker: {}, helper: {} }));
	assert.deepEqual(await applySavedModelConfig({ cwd: f.root } as Parameters<typeof applySavedModelConfig>[0]), { updated: 4, skipped: 0 });
	const swept = JSON.parse(readFileSync(f.routes, "utf8"));
	for (const name of ["worker", "helper"]) {
		assert.equal(name in swept.model_profiles, false, "cross-process ownership survives into the startup sweep");
		assert.doesNotMatch(readFileSync(join(f.home, "agents", `${name}.md`), "utf8"), /^(model|thinking):/m);
	}
	assert.equal(swept.max_concurrency, 3);
	assert.deepEqual(swept.custom, { retained: true });
	assert.deepEqual(swept.model_profiles.outsider, { model: "openai/user" });
	await clearAndAssert(f, ["worker", "helper"], 0, 4);
});

test("death during temporary ownership write preserves prior committed ownership", { timeout: 15000 }, async t => {
	const f = fixture(t);
	applyModelConfig(f.root, { worker: { model: "openai/worker", thinking: "high" } });
	const previous = readFileSync(f.tracking, "utf8");
	const inode = statSync(f.lock).ino;
	const child = f.child("fault");
	assert.equal((await once(child, "message"))[0], "partial-temp");
	assert.equal(readFileSync(f.tracking, "utf8"), previous, "old snapshot remains complete before rename");
	const exited = once(child, "exit");
	child.kill("SIGKILL");
	await exited;
	assert.equal(readFileSync(f.tracking, "utf8"), previous);
	assert.equal(statSync(f.lock).ino, inode);
	writeFileSync(join(f.config, "models.json"), JSON.stringify({ worker: {}, helper: {} }));
	// Owned worker: two changed surfaces. Unowned helper: one skipped agent.
	assert.deepEqual(await applySavedModelConfig({ cwd: f.root } as Parameters<typeof applySavedModelConfig>[0]), { updated: 2, skipped: 1 });
	const stored = JSON.parse(readFileSync(f.routes, "utf8"));
	assert.equal("worker" in stored.model_profiles, false, "previous committed owner remains clearable");
	assert.deepEqual(stored.model_profiles.helper, { model: "openai/helper", effort: "high" }, "uncommitted helper is not claimed by the sweep");
	assert.doesNotMatch(readFileSync(join(f.home, "agents", "worker.md"), "utf8"), /^(model|thinking):/m);
	const helperMd = readFileSync(join(f.home, "agents", "helper.md"), "utf8");
	assert.match(helperMd, /^model: openai\/helper$/m);
	assert.match(helperMd, /^thinking: high$/m);
	assert.equal(stored.max_concurrency, 3);
	assert.deepEqual(stored.custom, { retained: true });
	assert.deepEqual(stored.model_profiles.outsider, { model: "openai/user" });
	await clearAndAssert(f, ["worker", "helper"], 2, 2);
});
