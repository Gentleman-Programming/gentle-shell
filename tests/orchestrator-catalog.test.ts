import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, readdirSync, symlinkSync, unlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PresencePublisher, listPresence, readActivity } from "../lib/orchestrator-presence.ts";
import { discoverOrchestrators } from "../lib/orchestrator-discovery.ts";
import { projectCatalog } from "../lib/orchestrator-catalog.ts";
import { OrchestratorScopeCache } from "../lib/orchestrator-scope.ts";

const peer = { version: 1 as const, sessionId: "peer", endpoint: "/socket", createdAt: 1 };
test("bounded continuation reaches owned children and recorded roots beyond eight", t => {
	t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000 });
	const profile = realpathSync(mkdtempSync(join(tmpdir(), "catalog-")));
	t.after(() => rmSync(profile, { recursive: true, force: true }));
	const publisher = PresencePublisher.start({ profile, sessionId: "peer", label: "Peer", activity: [] });
	t.after(() => publisher.dispose());
	const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, label: `Task ${i}`, status: "running", cwd: `/task/${i}`, prompt: "PRIVATE" }));
	Object.defineProperty(tasks[9], "thread", { get() { throw new Error("private thread accessed"); } });
	const registered = Array.from({ length: 10 }, (_, i) => `/root/${i}`);
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks, registered });
	const query = (cursor?: string, recipientSessionId = "peer") => discoverOrchestrators(profile, [peer], Date.now(), { recipientSessionId, cursor })[0];
	const first = query();
	assert.equal(first.catalog!.tasks.length, 8);
	assert.equal(first.catalog!.registered.length, 8);
	assert.ok(first.catalog!.cursor);
	const next = query(first.catalog!.cursor);
	assert.deepEqual(next.catalog!.tasks.map(t => t.id), ["t8", "t9"]);
	assert.deepEqual(next.catalog!.registered, ["/root/8", "/root/9"]);
	assert.equal(next.catalog!.cursor, undefined);
	assert.doesNotMatch(JSON.stringify(next), /PRIVATE/);
	const cursor = first.catalog!.cursor!;
	assert.equal(query(cursor + "x").catalog, undefined);
	assert.equal(query("x".repeat(1025)).catalog, undefined);
	const altered = JSON.parse(Buffer.from(cursor, "base64url").toString());
	altered[4] = 16;
	assert.equal(query(Buffer.from(JSON.stringify(altered)).toString("base64url")).catalog, undefined);
	assert.equal(query(cursor, "wrong"), undefined);
	assert.equal(discoverOrchestrators(profile, [{ ...peer, endpoint: "/replacement" }])[0].catalog, undefined);
	tasks[8].label = "Changed";
	assert.equal(query(cursor).catalog!.tasks[0].label, "Task 8", "caller mutation cannot alter publication");
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks, registered });
	assert.equal(query(cursor).catalog, undefined, "old page never claims current after summary refresh");
	const activity = tasks.map(task => ({ task: { id: task.id, agent: "worker", label: task.label, status: task.status, model: "local",
		createdAt: 0, startedAt: 0, endedAt: null, lastActivityAt: 0 }, thread: { version: 1, dropped: 0, items: [{ kind: "text", text: "PRIVATE initial" }] } }));
	publisher.update(activity);
	t.mock.timers.tick(400);
	const current = query().catalog!.cursor!;
	t.mock.timers.tick(5000);
	assert.ok(query(current).catalog, "stable heartbeat preserves cursor");
	const generation = listPresence(profile).entries[0].generation;
	publisher.update(activity.map(row => ({ task: { ...row.task, lastActivityAt: 1 },
		thread: { version: 2, dropped: 0, items: [{ kind: "text", text: "PRIVATE busy stream" }] } })));
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks, registered });
	t.mock.timers.tick(400);
	assert.equal(listPresence(profile).entries[0].generation, generation + 1);
	assert.equal(listPresence(profile).entries[0].counts.running, 10);
	const continued = query(current).catalog;
	assert.deepEqual(continued?.tasks.map(task => task.id), ["t8", "t9"], "private-only activity flush preserves public continuation");
	assert.doesNotMatch(JSON.stringify(continued), /PRIVATE/);
	for (const change of [() => { tasks[8].status = "waiting"; }, () => { registered[8] = "/new-root"; }, () => { tasks.pop(); }]) {
		const old = query().catalog!.cursor!;
		change();
		publisher.update(tasks.map((task, i) => ({ task: { ...activity[i].task, label: task.label, status: task.status }, thread: activity[i].thread })));
		publisher.updateDiscovery(peer, { workspace: "/repo", tasks, registered });
		t.mock.timers.tick(400);
		assert.equal(query(old).catalog, undefined, "public status/root/membership changes reject old pages");
	}
	assert.deepEqual(listPresence(profile).entries[0].counts, { running: 8, waiting: 1, queued: 0, finished: 0 });
	const stable = query().catalog!.cursor!;
	publisher.updateDiscovery(peer, { workspace: "/host-metadata-only", tasks, registered });
	publisher.refreshLabel();
	assert.ok(query(stable).catalog, "non-catalog legacy metadata does not change catalog identity");
	const header = listPresence(profile).entries[0];
	const path = join(profile, "gentle-agents", "catalog", `${publisher.target.sessionHash}.${publisher.target.incarnation}.json`);
	const bytes = readFileSync(path);
	const before = statSync(path).ino;
	publisher.updateDiscovery(peer, { workspace: "/host-metadata-only", tasks, registered });
	assert.equal(statSync(path).ino, before, "unchanged source publication is cached");
	for (const bad of ["{broken", "x".repeat(65537), JSON.stringify({ ...JSON.parse(bytes.toString()), catalog: {} }),
		JSON.stringify({ ...JSON.parse(bytes.toString()), generation: header.generation - 1 })]) {
		writeFileSync(path, bad);
		assert.equal(query().catalog, undefined);
		assert.equal(listPresence(profile).entries.length, 1);
		assert.ok(readActivity(profile, header).activity);
	}
	unlinkSync(path);
	assert.equal(query().catalog, undefined, "legacy without catalog remains discoverable");
	assert.equal(query().label, "Peer");
	if (process.platform !== "win32") {
		execFileSync("mkfifo", [path]);
		assert.equal(query().catalog, undefined, "FIFO is rejected before opening");
		unlinkSync(path);
	}
	symlinkSync(join(profile, "absent"), path);
	assert.equal(query().catalog, undefined);
	publisher.dispose();
	assert.equal(readdirSync(join(profile, "gentle-agents", "catalog")).length, 1, "replacement link is not removed");
	const replacement = PresencePublisher.start({ profile, sessionId: "peer", label: "Replacement", activity: [] });
	t.after(() => replacement.dispose());
	replacement.updateDiscovery(peer, { workspace: "/repo", tasks, registered });
	assert.equal(query(cursor).catalog, undefined, "replacement incarnation rejects old cursor");
	const otherPeer = { ...peer, sessionId: "other" };
	const other = PresencePublisher.start({ profile, sessionId: "other", label: "Other", activity: [] });
	t.after(() => other.dispose());
	other.updateDiscovery(otherPeer, { workspace: "/repo", tasks, registered });
	assert.equal(discoverOrchestrators(profile, [otherPeer], Date.now(), { recipientSessionId: "other", cursor })[0].catalog, undefined);
});

test("explicit bounds, literal unknown paths, no new Git resolution, private sibling cleanup", t => {
	const profile = realpathSync(mkdtempSync(join(tmpdir(), "catalog-bounds-")));
	t.after(() => rmSync(profile, { recursive: true, force: true }));
	const publisher = PresencePublisher.start({ profile, sessionId: "peer", label: "Peer", activity: [] });
	t.after(() => publisher.dispose());
	const tasks = Array.from({ length: 70 }, (_, i) => ({ id: `t${i}`, label: "😀".repeat(120), status: "running", cwd: `/task/${i}` }));
	tasks[0].cwd = "/bad\u00a0root";
	tasks[1].cwd = "/" + "x".repeat(256);
	const registered = Array.from({ length: 70 }, (_, i) => `/root/${i}`);
	let probes = 0;
	const cache = new OrchestratorScopeCache(root => { probes++; return { root, commonDir: "/clone" }; });
	const scope = cache.project("/repo", tasks, registered);
	assert.equal(probes, 15, "only existing valid prefix facts resolve");
	publisher.updateDiscovery(peer, { workspace: "/repo", tasks, registered, scope });
	let cursor: string | undefined;
	let pages = 0, taskCount = 0, rootCount = 0;
	do {
		const page = discoverOrchestrators(profile, [peer], Date.now(), { recipientSessionId: "peer", cursor })[0].catalog!;
		if (!pages) assert.deepEqual(page.tasks.slice(0, 2).map(t => t.cwd), [null, null]);
		assert.ok(page.tasks.length <= 8 && page.registered.length <= 8);
		taskCount += page.tasks.length; rootCount += page.registered.length; pages++;
		assert.equal(page.omittedTasks, 6);
		assert.equal(page.omittedRegistered, 6);
		cursor = page.cursor;
	} while (cursor);
	assert.deepEqual([pages, taskCount, rootCount], [8, 64, 64]);
	assert.equal(probes, 15);
	assert.equal(listPresence(profile).scanned, 3, "catalog cannot inflate legacy header directory scan");
	publisher.dispose();
	assert.deepEqual(readdirSync(join(profile, "gentle-agents", "catalog")), []);
	const huge = projectCatalog(tasks.map(t => ({ ...t, id: "😀".repeat(120), cwd: "/" + "x".repeat(255) })), registered);
	assert.ok(huge.tasks.length < 64, "byte budget also omits whole entries");
	assert.equal(huge.tasks.length + huge.omittedTasks, tasks.length);
	assert.equal(huge.registered.length + huge.omittedRegistered, registered.length);
	assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= 65536 - 1024);
});
