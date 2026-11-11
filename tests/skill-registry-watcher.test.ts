import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const extensionUrl = pathToFileURL(join(import.meta.dirname, "..", "extensions", "skill-registry.ts")).href;

test("independent extension hosts share disk bytes without sharing runtime captures", { timeout: 15_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-skill-two-hosts-"));
	const cwd = join(root, "project"), home = join(root, "home");
	mkdirSync(join(cwd, "skills", "disk"), { recursive: true });
	mkdirSync(home, { recursive: true });
	writeFileSync(join(cwd, "skills", "disk", "SKILL.md"), "---\nname: disk\ndescription: Disk skill.\n---\n");
	// Pi lists each host's capture itself; a same-name user-root copy shows which capture a host holds.
	const alphaCopy = join(home, ".agents", "skills", "alpha-copy", "SKILL.md"), betaCopy = join(home, ".agents", "skills", "beta-copy", "SKILL.md");
	for (const [path, name] of [[alphaCopy, "alpha"], [betaCopy, "beta"]]) {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `---\nname: ${name}\ndescription: User-root copy.\n---\n`);
	}
	const source = `
		const { default: extension, __testing } = await import(${JSON.stringify(extensionUrl)});
		const events = new Map(), commands = new Map();
		extension({ on: (name, fn) => events.set(name, fn), registerCommand: (name, command) => commands.set(name, command), registerFlag() {}, getFlag: () => false });
		const ctx = { cwd: ${JSON.stringify(cwd)}, hasUI: false, ui: { notify() {} } };
		const options = { skills: [], appendSystemPrompt: 'existing' };
		process.on('message', async message => {
			try {
				if (message.action === 'start') { await events.get('session_start')(undefined, ctx); await __testing.startupSettled(); }
				if (message.action === 'event') { options.skills = message.skills; await events.get('before_agent_start')({ systemPromptOptions: options }, ctx); }
				if (message.action === 'refresh') await commands.get('skill-registry:refresh').handler('', ctx);
				if (message.action === 'shutdown') await events.get('session_shutdown')(undefined, ctx);
				process.send({ prompt: options.appendSystemPrompt });
				if (message.action === 'shutdown') process.disconnect();
			} catch (error) { process.send({ error: String(error && error.stack || error) }); }
		});
		process.on('disconnect', () => process.exit(0));
	`;
	const createHost = () => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source], {
			cwd, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CODEX_HOME: "", GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_NOSYSTEM: "1", SYSTEMROOT: process.env.SYSTEMROOT },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
		const send = (message: Record<string, unknown>) => new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`host failed to reply: ${stderr}`)), 5000);
			child.once("message", (reply: { prompt: string; error?: string }) => {
				clearTimeout(timer);
				if (reply.error) reject(new Error(reply.error)); else resolve(reply.prompt);
			});
			child.send(message);
		});
		return { child, send };
	};
	const a = createHost(), b = createHost();
	t.after(() => {
		for (const host of [a, b]) if (host.child.connected) host.child.disconnect();
		rmSync(root, { recursive: true, force: true });
	});
	await Promise.all([a.send({ action: "start" }), b.send({ action: "start" })]);
	const registry = join(cwd, ".atl", "skill-registry.md");
	const bytes = readFileSync(registry), mtime = statSync(registry).mtimeMs;
	const alpha = join(root, "alpha", "SKILL.md"), beta = join(root, "beta", "SKILL.md");
	const [first, second] = await Promise.all([
		a.send({ action: "event", skills: [{ name: "alpha", description: "Alpha", filePath: alpha }] }),
		b.send({ action: "event", skills: [{ name: "beta", description: "Beta", filePath: beta }] }),
	]);
	assert.ok(!first.includes(alpha) && !first.includes(alphaCopy) && first.includes(betaCopy));
	assert.ok(!second.includes(beta) && !second.includes(betaCopy) && second.includes(alphaCopy));
	await Promise.all([a.send({ action: "refresh" }), b.send({ action: "refresh" })]);
	assert.deepEqual(readFileSync(registry), bytes);
	assert.equal(statSync(registry).mtimeMs, mtime);
	assert.ok((await a.send({ action: "event", skills: [] })).includes(alphaCopy));
	assert.ok(!(await b.send({ action: "event" })).includes(betaCopy));
	await Promise.all([a.send({ action: "shutdown" }), b.send({ action: "shutdown" })]);
});

test("a watcher refresh pending at session shutdown neither regenerates nor touches the stale ctx", (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-skill-watch-stale-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import fs from "node:fs";
		import { syncBuiltinESMExports } from "node:module";
		import { join } from "node:path";
		const root = ${JSON.stringify(root)};
		const cwd = join(root, "workspace");
		const home = join(root, "home");
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		delete process.env.CODEX_HOME;
		delete process.env.GENTLE_PI_AGENTS_CHILD;
		delete process.env.GENTLE_PI_NO_SKILL_REGISTRY;
		const failures = [];
		process.on("unhandledRejection", (error) => { failures.push("unhandledRejection: " + String(error)); process.exitCode = 1; console.error("unhandledRejection", error); });
		process.on("uncaughtException", (error) => { failures.push("uncaughtException: " + String(error)); process.exitCode = 1; console.error("uncaughtException", error); });
		const skill = join(cwd, "skills", "local", "SKILL.md");
		const writeSkill = (description) => fs.writeFileSync(skill, "---\\nname: local\\ndescription: " + description + "\\n---\\n");
		fs.mkdirSync(join(cwd, "skills", "local"), { recursive: true });
		fs.mkdirSync(home, { recursive: true });
		writeSkill("Initial skill.");
		// Capture the watcher listener so the debounce is armed deterministically,
		// independent of whether the OS delivers recursive-watch events in time.
		const nativeWatch = fs.watch;
		let refreshListener;
		fs.watch = function (path, options, listener) {
			refreshListener = listener;
			return nativeWatch(path, options, listener);
		};
		syncBuiltinESMExports();
		const { default: skillRegistry, __testing } = await import(${JSON.stringify(extensionUrl)});
		const events = new Map();
		skillRegistry({ on: (name, handler) => events.set(name, handler), registerCommand() {}, registerFlag() {}, getFlag: () => false });
		// Pi's runner throws on any ctx access once the session is replaced or reloaded.
		const makeCtx = () => {
			const notices = [];
			let stale = false;
			const guard = () => { if (stale) throw new Error("This extension ctx is stale after session replacement or reload"); };
			const ctx = {
				cwd,
				get hasUI() { guard(); return true; },
				get ui() { guard(); return { notify: (message, level) => notices.push({ message, level }) }; },
				get sessionManager() { guard(); return {}; },
			};
			return { ctx, notices, expire() { stale = true; } };
		};
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const registry = join(cwd, ".atl", "skill-registry.md");

		const old = makeCtx();
		await events.get("session_start")(undefined, old.ctx);
		await __testing.startupSettled();
		assert.ok(refreshListener, "fixture must start a recursive watcher");
		assert.match(fs.readFileSync(registry, "utf8"), /Initial skill/);
		const noticesBeforeShutdown = old.notices.length;
		refreshListener("change", "local/SKILL.md"); // Arms the debounced refresh.
		await events.get("session_shutdown")(undefined, old.ctx);
		old.expire();
		writeSkill("Changed after shutdown.");
		await sleep(1500); // Well past the 500 ms debounce and its regeneration.
		assert.deepEqual(failures, [], "a stale ctx must never escape as an unhandled error");
		assert.equal(old.notices.length, noticesBeforeShutdown, "no notify after shutdown");
		assert.doesNotMatch(fs.readFileSync(registry, "utf8"), /Changed after shutdown/, "no regeneration after shutdown");

		refreshListener = undefined;
		const live = makeCtx();
		await events.get("session_start")(undefined, live.ctx);
		await __testing.startupSettled();
		assert.ok(refreshListener, "a later session must rewatch");
		live.notices.length = 0;
		writeSkill("Live session change.");
		refreshListener("change", "local/SKILL.md");
		const deadline = Date.now() + 5000;
		while (!live.notices.some(({ message }) => message.startsWith("Skill registry refreshed")) && Date.now() < deadline) await sleep(25);
		assert.ok(live.notices.some(({ message, level }) => level === "info" && message.startsWith("Skill registry refreshed")), JSON.stringify(live.notices));
		assert.match(fs.readFileSync(registry, "utf8"), /Live session change/);
		await events.get("session_shutdown")(undefined, live.ctx);
		assert.deepEqual(failures, []);
		console.log("STALE CTX SAFE");
	`], {
		encoding: "utf8",
		timeout: 15_000,
		env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
	});
	assert.equal(child.error, undefined, `${child.error?.message}\n${child.stderr}`);
	assert.equal(child.status, 0, child.stderr);
	assert.match(child.stdout, /STALE CTX SAFE/);
});

for (const code of ["ENOENT", "EMFILE"]) {
	test(`registered skill watcher survives asynchronous ${code} and preserves other roots`, (t) => {
		const root = mkdtempSync(join(tmpdir(), "gentle-skill-watch-error-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
			import assert from "node:assert/strict";
			import fs from "node:fs";
			import { syncBuiltinESMExports } from "node:module";
			import { join, sep } from "node:path";
			const root = ${JSON.stringify(root)};
			const cwd = join(root, "workspace");
			const home = join(root, "home");
			process.env.HOME = home;
			process.env.USERPROFILE = home;
			delete process.env.CODEX_HOME;
			delete process.env.GENTLE_PI_AGENTS_CHILD;
			delete process.env.GENTLE_PI_NO_SKILL_REGISTRY;
			const userRoot = join(home, ".codex", "skills");
			const assets = join(userRoot, "imagegen", "assets");
			const projectSkill = join(cwd, "skills", "local", "SKILL.md");
			const userSkill = join(userRoot, "imagegen", "SKILL.md");
			fs.mkdirSync(assets, { recursive: true });
			fs.mkdirSync(join(cwd, "skills", "local"), { recursive: true });
			fs.writeFileSync(projectSkill, "---\\nname: local\\ndescription: Initial project skill.\\n---\\n");
			fs.writeFileSync(userSkill, "---\\nname: imagegen\\ndescription: Initial user skill.\\n---\\n");
			const nativeWatch = fs.watch;
			let userWatcher;
			fs.watch = function (path, options, listener) {
				const watcher = nativeWatch(path, options, listener);
				if (path === userRoot && options?.recursive) userWatcher = watcher;
				return watcher;
			};
			syncBuiltinESMExports();
			const { default: skillRegistry, __testing } = await import(${JSON.stringify(extensionUrl)});
			const events = new Map();
			const commands = new Map();
			const notices = [];
			skillRegistry({
				on: (name, handler) => events.set(name, handler),
				registerCommand: (name, command) => commands.set(name, command),
				registerFlag: () => {},
				getFlag: () => false,
			});
			const ctx = { cwd, hasUI: true, ui: { notify: (message, level) => notices.push({ message, level }) } };
			const waitFor = async (predicate) => {
				// Must stay well below the parent's spawnSync timeout so a missed
				// outcome fails with this assertion instead of an opaque ETIMEDOUT.
				const deadline = Date.now() + 5000;
				while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
				assert.ok(predicate(), "timed out waiting for watcher outcome");
			};
			try {
				await events.get("session_start")(undefined, ctx);
				await __testing.startupSettled(); // Startup regeneration runs after session_start returns.
				assert.ok(userWatcher, "fixture must start the real recursive user watcher");
				const initialWatchers = __testing.activeWatcherCount();
				assert.equal(initialWatchers, 2);
				const code = ${JSON.stringify(code)};
				if (code === "ENOENT" && process.platform !== "darwin" && process.platform !== "win32") {
					// Force the transient missing-directory race at Node's real recursive
					// readdir boundary, after watcher creation, not in our refresh callback.
					// Older Node rescans the parent folder; Node 24.22+ resolves new files
					// via lstat and only readdirs a newly added directory, so trigger with
					// a directory and fail whichever readdir lands under assets.
					const nativeReaddir = fs.readdirSync;
					let reachedRescan = false;
					fs.readdirSync = function (path, options) {
						if (typeof path === "string" && (path === assets || path.startsWith(assets + sep))) {
							fs.readdirSync = nativeReaddir;
							reachedRescan = true;
							throw Object.assign(new Error("ENOENT: transient skill assets disappeared"), { code, syscall: "scandir", path });
						}
						return nativeReaddir(path, options);
					};
					fs.mkdirSync(join(assets, "trigger"));
					// The rescan race needs live recursive-watch events. Where the OS
					// cannot deliver them (an exhausted inotify budget, some WSL2
					// setups), waiting the full waitFor budget is pointless: settle
					// briefly for the natural race, then exercise the public error
					// listener directly, as the manual fallback below always did.
					const raceDeadline = Date.now() + 2000;
					while (!reachedRescan && Date.now() < raceDeadline) await new Promise((resolve) => setTimeout(resolve, 25));
					fs.readdirSync = nativeReaddir;
					// Newer Node versions swallow rescan ENOENT themselves. Still
					// exercise our public error listener without requiring Node's bug.
					if (!notices.some(({ message, level }) => level === "warning" && message.includes(code))) {
						userWatcher.emit("error", Object.assign(new Error("ENOENT: skill watcher failed"), { code }));
					}
				} else {
					// Native Darwin/Windows recursion has no JS readdir boundary;
					// inject its public error event, as for asynchronous resource errors.
					setImmediate(() => userWatcher.emit("error", Object.assign(new Error(code + ": skill watcher failed"), { code })));
				}
				await waitFor(() => notices.some(({ message, level }) => level === "warning" && message.includes(code)));
				assert.equal(__testing.activeWatcherCount(), initialWatchers - 1, "only the failed root must stop");
				assert.ok(notices.some(({ message }) => message.includes("/skill-registry:refresh")));
				fs.writeFileSync(projectSkill, "---\\nname: local\\ndescription: Changed project skill.\\n---\\n");
				const registry = join(cwd, ".atl", "skill-registry.md");
				await waitFor(() => fs.readFileSync(registry, "utf8").includes("Changed project skill"));
				fs.writeFileSync(userSkill, "---\\nname: imagegen\\ndescription: Manually changed user skill.\\n---\\n");
				await commands.get("skill-registry:refresh").handler("", ctx);
				assert.match(fs.readFileSync(registry, "utf8"), /Manually changed user skill/);
			} finally {
				await events.get("session_shutdown")(undefined, ctx);
			}
			assert.equal(__testing.activeWatcherCount(), 0);
			await events.get("session_start")(undefined, ctx);
			await __testing.startupSettled();
			assert.equal(__testing.activeWatcherCount(), 2, "a later session must rewatch the failed root");
			await events.get("session_shutdown")(undefined, ctx);
			assert.equal(__testing.activeWatcherCount(), 0);
			console.log("SURVIVED ${code}");
		`], {
			encoding: "utf8",
			timeout: 15_000,
			env: { ...process.env, GIT_CEILING_DIRECTORIES: root },
		});
		assert.equal(child.error, undefined, `${child.error?.message}\n${child.stderr}`);
		assert.equal(child.status, 0, child.stderr);
		assert.match(child.stdout, new RegExp(`SURVIVED ${code}`));
	});
}
