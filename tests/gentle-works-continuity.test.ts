import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile, unlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWork, listWorks, resolveWorkContext, updateWork } from "../lib/gentle-works.ts";

test("S6: three branches survive fresh-process reload with absent sessions and a removed worktree", async t => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "works-continuity-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
	const git = (...args: string[]) => execFileSync("git", args, { env, encoding: "utf8", stdio: "pipe" });
	const source = join(root, "source"), clone = join(root, "clone"), home = join(root, "home");
	git("init", source);
	git("-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
	git("clone", "--no-hardlinks", source, clone);
	git("-C", clone, "checkout", "-b", "acceptance-one");
	const locations = [clone, join(root, "second"), join(root, "third")];
	for (let i = 1; i < locations.length; i++) git("-C", clone, "worktree", "add", "-b", `acceptance-${i + 1}`, locations[i]);
	const branches = ["acceptance-one", "acceptance-2", "acceptance-3"];
	const sessions = locations.map((_, i) => ({ id: `conversation-${i + 1}`, file: join(root, `conversation-${i + 1}.jsonl`) }));
	for (const session of sessions) await writeFile(session.file, "");
	for (let i = 0; i < locations.length; i++) {
		const context = await resolveWorkContext(locations[i], home);
		const work = await createWork(context, {
			title: `Deliverable ${i + 1}`, objective: `Objective ${i + 1}`, status: "pending", summary: "",
			branch: branches[i], worktree: locations[i], session: sessions[i],
		});
		await updateWork(context, work.id, {
			status: (["in_progress", "blocked", "completed"] as const)[i],
			summary: `Explicit handoff ${i + 1}`, odd: `odd/tasks/deliverable-${i + 1}.md`,
		});
	}
	const expected = await listWorks(await resolveWorkContext(clone, home));
	assert.equal(expected.works.length, 3);
	assert.equal(new Set(expected.works.map(work => work.cloneIdentity)).size, 1);
	const api = new URL("../lib/gentle-works.ts", import.meta.url).href;
	const extension = new URL("../extensions/gentle-works.ts", import.meta.url).href;
	// Each call loads both the API and registered command in an independent Node process.
	const reload = (cwd: string) => {
		const code = `
			import assert from 'node:assert/strict';
			import {listWorks, resolveWorkContext} from ${JSON.stringify(api)};
			import {registerWorks} from ${JSON.stringify(extension)};
			const context = await resolveWorkContext(${JSON.stringify(cwd)}, ${JSON.stringify(home)});
			const before = await listWorks(context);
			let handler;
			registerWorks({registerCommand(name, command) { assert.equal(name, 'gentle:works'); handler = command.handler; }}, async () => context);
			const screens = [], notices = [];
			for (let index = 0; index < before.works.length; index++) {
				const actions = [Array(index + 1).fill('j').concat('\\r'), ['\\x1b'], ['\\x1b']];
				await handler('', {
					cwd: ${JSON.stringify(cwd)}, mode: 'tui', hasUI: true,
					isIdle() { throw new Error('Unlinked runtime activity must not be queried'); },
					sessionManager: {getSessionId: () => 'fresh-context', getSessionFile: () => undefined},
					ui: {
						notify: text => notices.push(text),
						custom: async factory => {
							let result;
							const view = factory({requestRender() {}, terminal: {rows: 80}}, undefined, undefined, value => result = value);
							screens.push(view.render(240).join('\\n'));
							for (const key of actions.shift() ?? []) view.handleInput(key);
							assert.notEqual(result, undefined);
							return result;
						}
					}
				});
				assert.equal(actions.length, 0);
			}
			assert.deepEqual(await listWorks(context), before);
			assert.deepEqual(notices, []);
			console.log(JSON.stringify({registry: before, screens}));
		`;
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], {
			env, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL",
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.signal, null);
		assert.equal(result.stderr, "");
		return JSON.parse(result.stdout) as { registry: typeof expected; screens: string[] };
	};
	const initial = reload(locations[1]);
	assert.deepEqual(initial.registry, expected);
	assert.match(initial.screens.join("\n"), /present \(not proof of activity or resumability\)/);
	for (const session of sessions) await unlink(session.file);
	git("-C", clone, "worktree", "remove", locations[2]);
	const worktreesBefore = git("-C", clone, "worktree", "list", "--porcelain");
	for (const cwd of locations.slice(0, 2)) {
		const reloaded = reload(cwd);
		assert.deepEqual(reloaded.registry, expected, "inspection must preserve all explicit fields and public revisions");
		for (let i = 0; i < expected.works.length; i++) {
			const work = expected.works[i];
			const detail = reloaded.screens[i * 3 + 1];
			for (const value of [work.id, work.title, work.objective, work.summary, work.odd!, work.branch!, work.worktree!, work.session!.id, work.session!.file]) assert.ok(detail.includes(value), `Missing detail: ${value}`);
			assert.ok(detail.includes(`Status: ${work.status} (explicit)`));
			assert.ok(detail.includes("Activity: unknown · observation unavailable"));
			assert.ok(detail.includes(`Session file: ${work.session!.file} · missing (record retained)`));
			assert.ok(detail.includes(`Worktree: ${work.worktree} · ${i === 2 ? "missing (record retained)" : "present (not proof of activity or resumability)"}`));
		}
	}
	assert.equal(git("-C", clone, "worktree", "list", "--porcelain"), worktreesBefore, "inspection must not spawn or clean up worktrees");
	await assert.rejects(stat(locations[2]), { code: "ENOENT" });
	for (const session of sessions) await assert.rejects(stat(session.file), { code: "ENOENT" });
});
