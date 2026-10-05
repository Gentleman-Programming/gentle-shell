import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { historyDir, saveTask } from "../lib/agents-history.ts";
import { TASK_STATUS, TaskStore, type TaskRecord } from "../lib/agents-protocol.ts";
import * as presence from "../lib/orchestrator-presence.ts";
import {
	ACTIVITY_LIMIT, PresencePublisher, listPresence, projectActivity, readActivity,
} from "../lib/orchestrator-presence.ts";

function fixture(t: test.TestContext) {
	const profile = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "presence-test-"));
	// Each fixture owns precisely these files; never traverse a linked directory.
	t.after(() => {
		const root = join(profile, "gentle-agents");
		if (fs.existsSync(root) && !fs.lstatSync(root).isSymbolicLink()) {
			for (const name of fs.readdirSync(root)) {
				const path = join(root, name);
				if (["tasks", "presence"].includes(name) && fs.lstatSync(path).isDirectory()) {
					for (const file of fs.readdirSync(path)) fs.unlinkSync(join(path, file));
					fs.rmdirSync(path);
				} else fs.unlinkSync(path);
			}
			fs.rmdirSync(root);
		} else if (fs.existsSync(root)) fs.unlinkSync(root);
		for (const name of fs.readdirSync(profile)) fs.unlinkSync(join(profile, name));
		fs.rmdirSync(profile);
	});
	return profile;
}

test("heartbeat refreshes a bounded canonical label and stops an invalid source", (t) => {
	const profile = fixture(t);
	let heartbeat: (() => void) | undefined;
	const interval = globalThis.setInterval;
	t.mock.method(globalThis, "setInterval", (callback: () => void, ms: number) => {
		if (ms === 5000) heartbeat = callback;
		return interval(callback, ms);
	});
	let current = "Initial";
	let valid = true;
	const p = PresencePublisher.start({ profile, sessionId: "label-session", label: "Fallback", activity: [],
		labelSource: () => { if (!valid) throw new Error("stale-session"); return current; } });
	t.after(() => p.dispose());
	current = "\u001b[31m Human\n rename\u202e ";
	heartbeat!();
	assert.equal(listPresence(profile).entries[0].label, "Human rename");
	assert.equal(listPresence(profile).entries[0].generation, 1);
	valid = false;
	heartbeat!();
	assert.equal(p.error, "stale-session");
	assert.deepEqual(listPresence(profile).entries, []);
});

function rows(text = "full retained output") {
	return [{ task: { id: "t", agent: "worker", label: "summary", status: "running", model: "model",
		createdAt: 1000, startedAt: 1100, endedAt: null, lastActivityAt: 1200,
		prompt: "PRIVATE_PROMPT", sessionPath: "/private/session", cwd: "/private/cwd", cancel: "CAPABILITY" },
		thread: { version: 1, dropped: 2, items: [
			{ kind: "text", text }, { kind: "thinking", text: "reasoning" }, { kind: "note", text: "note" },
			{ kind: "tool", callId: "c", name: "read", output: "complete tool output", running: false,
				isError: false, args: { prompt: "PRIVATE_PROMPT" }, sessionPath: "/private/session" },
		] } }];
}

function realTask(): TaskRecord {
	return { ...rows()[0].task, status: TASK_STATUS.RUNNING, mode: "task", parentSessionId: "same session",
		thinking: undefined, error: null, result: null, lastStep: "read", turns: 0, toolCalls: 0, tokens: 0, cost: 0 };
}

function publisher(t: test.TestContext, profile: string, activity = rows()) {
	const value = PresencePublisher.start({ profile, sessionId: "same session", label: "Workspace", activity });
	t.after(() => value.dispose());
	return value;
}

function paths(profile: string, header: { sessionHash: string; incarnation: string }) {
	const stem = `${header.sessionHash}.${header.incarnation}`;
	return { header: join(profile, "gentle-agents", "presence", `${stem}.header.json`),
		activity: join(profile, "gentle-agents", "presence", `${stem}.activity.json`) };
}

function header(profile: string) {
	const result = listPresence(profile);
	assert.equal(result.unavailable, undefined);
	assert.equal(result.entries.length, 1);
	return result.entries[0];
}

if (process.env.PRESENCE_TEST_CHILD !== "1") {
test("projection whitelists summaries and all retained text, excluding invocation payloads", () => {
	const input = rows();
	const projected = projectActivity(input);
	const json = JSON.stringify(projected);
	assert.doesNotMatch(json, /PRIVATE_PROMPT|private\/|CAPABILITY|sessionPath|cancel|args/);
	assert.equal(projected.tasks[0].thread.items.length, 4);
	assert.equal(projected.tasks[0].thread.dropped, 2);
	input[0].thread.items[0].text = "mutated";
	assert.equal(projected.tasks[0].thread.items[0].text, "full retained output");
});

test("headers are private, lightweight, sanitized and recent at the inclusive TTL boundary", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000 });
	const profile = fixture(t);
	const pub = PresencePublisher.start({ profile, sessionId: "/private/session", label: "\x1b[31mWork\nspace", activity: rows() });
	t.after(() => pub.dispose());
	const h = header(profile);
	assert.equal(h.label, "Work space");
	assert.equal(h.sessionHash, createHash("sha256").update("/private/session").digest("hex"));
	assert.equal(h.counts.running, 1);
	assert.doesNotMatch(fs.readFileSync(paths(profile, h).header, "utf8"), /private\/|full retained/);
	assert.equal(listPresence(profile, 115_000).entries[0].recent, true);
	assert.equal(listPresence(profile, 115_001).entries[0].recent, false);
	assert.equal(listPresence(profile, 99_999).entries[0].recent, false);
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(join(profile, "gentle-agents", "presence")).mode & 0o777, 0o700);
		assert.equal(fs.statSync(paths(profile, h).header).mode & 0o777, 0o600);
	}
});

test("long display labels remain schema-valid when clipping lands on whitespace or Unicode", (t) => {
	const profile = fixture(t);
	const pub = PresencePublisher.start({ profile, sessionId: "s", label: `${"a".repeat(119)} tail`, activity: [] });
	assert.equal(header(profile).label, "a".repeat(119));
	pub.dispose();
	const unicode = PresencePublisher.start({ profile, sessionId: "s", label: "🟢".repeat(121), activity: [] });
	t.after(() => unicode.dispose());
	assert.equal(header(profile).label, "🟢".repeat(120));
});

test("updates coalesce, snapshot caller data, and heartbeat never serializes or replaces activity", (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100_000 });
	const profile = fixture(t);
	const pub = publisher(t, profile);
	const first = header(profile);
	const path = paths(profile, first).activity;
	const original = fs.readFileSync(path, "utf8");
	const inode = fs.statSync(path).ino;
	pub.update(rows());
	const stringify = JSON.stringify;
	const serialization = t.mock.method(JSON, "stringify", (value: any) => {
		assert.equal(value?.activity ?? value?.tasks, undefined, "heartbeat must not serialize activity");
		return stringify(value);
	});
	t.mock.timers.tick(5000);
	serialization.mock.restore();
	assert.equal(header(profile).heartbeat, 105_000);
	assert.equal(header(profile).generation, first.generation);
	assert.equal(fs.statSync(path).ino, inode);
	assert.equal(fs.readFileSync(path, "utf8"), original);
	pub.update(rows("older"));
	const latest = rows("latest");
	pub.update(latest);
	latest[0].thread.items[0].text = "caller mutation";
	t.mock.timers.tick(399);
	assert.equal(header(profile).generation, first.generation);
	t.mock.timers.tick(1);
	const next = header(profile);
	assert.equal(next.generation, first.generation + 1);
	assert.equal(readActivity(profile, next).activity?.tasks[0].thread.items[0].text, "latest");
	assert.equal(readActivity(profile, first).unavailable, "generation-mismatch");
	pub.update(rows("transient"));
	pub.update(rows("latest"));
	t.mock.timers.tick(400);
	assert.equal(header(profile).generation, next.generation, "reverting a pending change publishes nothing");
	pub.update(rows("discarded"));
	pub.dispose();
	t.mock.timers.tick(10_000);
	assert.deepEqual(listPresence(profile).entries, []);
	assert.throws(() => pub.update(rows()), /disposed/);
});

test("full under-limit payload is admitted; oversize is explicit and never truncated", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const profile = fixture(t);
	const text = "x".repeat(ACTIVITY_LIMIT - 2048);
	const pub = publisher(t, profile, rows(text));
	assert.equal(readActivity(profile, header(profile)).activity?.tasks[0].thread.items[0].text, text);
	pub.update(rows("x".repeat(ACTIVITY_LIMIT)));
	t.mock.timers.tick(400);
	assert.equal(header(profile).unavailable, "activity-too-large");
	assert.equal(readActivity(profile, header(profile)).unavailable, "activity-too-large");
	pub.update(rows("recovered"));
	t.mock.timers.tick(400);
	assert.equal(readActivity(profile, header(profile)).activity?.tasks[0].thread.items[0].text, "recovered");
});

test("reader rejects malformed, oversized, wrong digest/schema and unsafe exact targets", (t) => {
	const profile = fixture(t);
	publisher(t, profile);
	const h = header(profile);
	const p = paths(profile, h);
	const original = fs.readFileSync(p.activity);
	fs.writeFileSync(p.activity, "{}");
	assert.equal(readActivity(profile, h).unavailable, "digest-mismatch");
	const malformed = Buffer.from('{"schema":1,"generation":1,"activity":{"tasks":[{}]}}');
	fs.writeFileSync(p.activity, malformed);
	assert.equal(readActivity(profile, { ...h, digest: createHash("sha256").update(malformed).digest("hex") }).unavailable, "malformed");
	fs.writeFileSync(p.activity, Buffer.alloc(ACTIVITY_LIMIT + 1));
	assert.equal(readActivity(profile, h).unavailable, "oversized");
	assert.equal(readActivity(profile, { ...h, incarnation: "../../escape" }).unavailable, "malformed");
	fs.writeFileSync(p.activity, original);
	fs.writeFileSync(p.header, "{");
	assert.equal(listPresence(profile).rejected, 1);
	fs.writeFileSync(p.header, " ".repeat(16 * 1024 + 1));
	assert.equal(listPresence(profile).rejected, 1);
	const { recent: _recent, ...storedHeader } = h;
	fs.writeFileSync(p.header, JSON.stringify({ ...storedHeader, sessionPath: "/private" }));
	assert.equal(listPresence(profile).rejected, 1);
	fs.writeFileSync(p.header, JSON.stringify({ ...storedHeader, sessionHash: "0".repeat(64) }));
	assert.equal(listPresence(profile).rejected, 1, "header identity must match its basename");
	const invalid = JSON.parse(original.toString("utf8"));
	invalid.activity.tasks[0].thread.items[0].sessionPath = "/private";
	const injected = JSON.stringify(invalid);
	fs.writeFileSync(p.activity, injected);
	assert.equal(readActivity(profile, { ...h, digest: createHash("sha256").update(injected).digest("hex") }).unavailable, "malformed");
});

test("bounded directory scan reports overflow and ignores partial/temp files", (t) => {
	const profile = fixture(t);
	publisher(t, profile);
	const root = join(profile, "gentle-agents", "presence");
	fs.writeFileSync(join(root, ".partial.tmp"), "{");
	assert.equal(listPresence(profile).rejected, 0);
	for (let i = 0; i < 130; i++) fs.writeFileSync(join(root, `junk-${i}`), "{}");
	const result = listPresence(profile);
	assert.equal(result.scanned, 128);
	assert.equal(result.overflow, true);
});

test("symlinks, hardlinks, directories and non-private managed roots fail closed", { skip: process.platform === "win32" }, (t) => {
	const profile = fixture(t);
	const pub = publisher(t, profile);
	const h = header(profile);
	const p = paths(profile, h);
	const outside = join(profile, "outside");
	fs.writeFileSync(outside, "untouched");
	fs.unlinkSync(p.activity);
	fs.symlinkSync(outside, p.activity);
	assert.equal(readActivity(profile, h).unavailable, "unsafe-file");
	fs.unlinkSync(p.activity);
	fs.linkSync(outside, p.activity);
	assert.equal(readActivity(profile, h).unavailable, "unsafe-file");
	pub.dispose();
	assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
	assert.ok(fs.existsSync(p.activity), "cleanup refuses a replaced unsafe file");
	fs.unlinkSync(p.activity);
	fs.symlinkSync(outside, p.header);
	assert.equal(listPresence(profile).rejected, 1);
	fs.unlinkSync(p.header);
	fs.linkSync(outside, p.header);
	assert.equal(listPresence(profile).rejected, 1);
	fs.unlinkSync(p.header);
	fs.mkdirSync(p.activity);
	assert.equal(readActivity(profile, h).unavailable, "unsafe-file");
	fs.rmdirSync(p.activity);
	fs.chmodSync(join(profile, "gentle-agents", "presence"), 0o755);
	assert.equal(listPresence(profile).unavailable, "unsafe-directory");
	fs.rmdirSync(join(profile, "gentle-agents", "presence"));
	fs.symlinkSync(profile, join(profile, "gentle-agents", "presence"));
	assert.equal(listPresence(profile).unavailable, "unsafe-directory");
	assert.throws(() => publisher(t, profile), /unsafe-directory/);
	fs.unlinkSync(join(profile, "gentle-agents", "presence"));
	fs.chmodSync(join(profile, "gentle-agents"), 0o777);
	assert.equal(listPresence(profile).unavailable, "unsafe-directory", "shared root cannot be writable by other users");
	fs.chmodSync(join(profile, "gentle-agents"), 0o700);
	fs.rmdirSync(join(profile, "gentle-agents"));
	fs.symlinkSync(profile, join(profile, "gentle-agents"));
	assert.throws(() => publisher(t, profile), /unsafe-directory/, "shared root cannot be a symlink");
});

test("publication failure stops timers without overwriting linked files or another activation", { skip: process.platform === "win32" }, (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const profile = fixture(t);
	const pub = publisher(t, profile);
	const selected = header(profile);
	const sibling = publisher(t, profile);
	const target = paths(profile, selected).activity;
	const outside = join(profile, "replacement");
	fs.writeFileSync(outside, "untouched");
	fs.unlinkSync(target);
	fs.linkSync(outside, target);
	pub.update(rows("must not publish"));
	t.mock.timers.tick(400);
	assert.equal(pub.error, "unsafe-file");
	t.mock.timers.tick(10_000);
	assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
	assert.deepEqual(listPresence(profile).entries.map((h) => h.incarnation), [sibling.target.incarnation]);
	assert.equal(readActivity(profile, selected).unavailable, "unsafe-file");
});

test("history created under umask 022 coexists with a dedicated private presence namespace", async (t) => {
	const profile = fixture(t);
	const store = new TaskStore();
	const task = realTask();
	store.add(task);
	const mask = process.umask(0o022);
	try { await saveTask(historyDir(profile, profile), task, store.thread(task.id)); }
	finally { process.umask(mask); }
	const shared = join(profile, "gentle-agents");
	const before = fs.statSync(shared).mode;
	if (process.platform !== "win32") assert.equal(before & 0o777, 0o755);
	const pub = publisher(t, profile);
	assert.equal(fs.statSync(shared).mode, before, "must not chmod the shared history directory");
	const privateRoot = join(shared, "presence");
	assert.ok(fs.statSync(privateRoot).isDirectory());
	if (process.platform !== "win32") assert.equal(fs.statSync(privateRoot).mode & 0o777, 0o700);
	pub.dispose();
	assert.ok(fs.existsSync(join(historyDir(profile, profile), `${task.id}.json`)));
});

test("real TaskStore projection preserves remote sorting/retention timestamps and header identity", (t) => {
	const profile = fixture(t);
	const store = new TaskStore();
	const task = realTask();
	store.add(task);
	store.apply(task.id, { type: "text", text: "retained" }, 2000);
	store.update(task.id, { status: TASK_STATUS.COMPLETED, endedAt: 2500 });
	const activity = store.list(task.parentSessionId).map((task) => ({ task, thread: store.thread(task.id) }));
	const projected = projectActivity(activity);
	assert.throws(() => projectActivity([{ ...activity[0], task: { ...activity[0].task, endedAt: NaN } }]), /malformed-activity/);
	assert.deepEqual(projected.tasks[0].summary, { id: "t", agent: "worker", label: "summary", model: "model",
		status: TASK_STATUS.COMPLETED, createdAt: 1000, startedAt: 1100, endedAt: 2500, lastActivityAt: 2000 });
	const pub = PresencePublisher.start({ profile, sessionId: task.parentSessionId, label: "Work", activity });
	t.after(() => pub.dispose());
	const h = header(profile);
	assert.equal(h.sessionHash, createHash("sha256").update(task.parentSessionId).digest("hex"));
	assert.deepEqual(readActivity(profile, h).activity, projected);
	assert.doesNotMatch(JSON.stringify(projected), /parentSessionId|PRIVATE_PROMPT|sessionPath|cwd|cancel|args/);
});

test("bounded continuation reaches a live peer beyond 128 stale headers without deleting them", (t) => {
	const profile = fixture(t);
	const pub = publisher(t, profile);
	const { recent: _recent, ...base } = header(profile);
	pub.dispose();
	const root = join(profile, "gentle-agents", "presence");
	fs.mkdirSync(root, { recursive: true, mode: 0o700 });
	for (let i = 0; i < 140; i++) {
		const h = { ...base, incarnation: randomUUID(), heartbeat: 0 };
		fs.writeFileSync(join(root, `${h.sessionHash}.${h.incarnation}.header.json`), JSON.stringify(h));
	}
	// Choose the late peer from actual filesystem order, not lexical/insertion assumptions.
	const fixtureDir = fs.opendirSync(root);
	let late = "";
	try {
		for (let i = 0; i < 141; i++) {
			const entry = fixtureDir.readSync();
			if (!entry) break;
			late = entry.name;
		}
	} finally { fixtureDir.closeSync(); }
	const live = { ...JSON.parse(fs.readFileSync(join(root, late), "utf8")), heartbeat: Date.now() };
	fs.writeFileSync(join(root, late), JSON.stringify(live));
	const cursor = new presence.PresenceCursor(profile);
	t.after(() => cursor.close());
	const first = cursor.next();
	assert.equal(first.scanned, 128);
	assert.equal(first.overflow, true);
	assert.equal(first.entries.some((h) => h.recent), false);
	const second = cursor.next();
	assert.equal(second.scanned, 12);
	assert.equal(second.overflow, false);
	assert.deepEqual(second.entries.filter((h) => h.recent).map((h) => h.incarnation), [live.incarnation]);
	assert.equal(cursor.next().unavailable, "closed");
	assert.equal(fs.readdirSync(root).length, 140, "stale entries are not deleted");
	const abandoned = new presence.PresenceCursor(profile);
	abandoned.close();
	abandoned.close();
	assert.equal(abandoned.next().unavailable, "closed");
	if (process.platform !== "win32") {
		const unsafe = new presence.PresenceCursor(profile);
		fs.chmodSync(root, 0o755);
		assert.equal(unsafe.next().unavailable, "unsafe-directory");
		assert.equal(unsafe.next().unavailable, "closed", "a failed cursor closes its handle");
	}
});
}

// Execute this same module in isolated Node processes, without an extra fixture file.
if (process.env.PRESENCE_TEST_CHILD === "1") {
	const pub = PresencePublisher.start({ profile: process.argv[2], sessionId: "shared", label: "Child", activity: rows() });
	process.send?.(pub.target);
	process.on("message", () => { pub.dispose(); process.exit(0); });
} else {
	test("two real processes with the same session ID stay distinct and clean up only their incarnation", async (t) => {
		const profile = fixture(t);
		const children = [0, 1].map(() => fork(new URL(import.meta.url), [profile], {
			execArgv: ["--experimental-strip-types"], env: { PRESENCE_TEST_CHILD: "1" }, silent: true,
		}));
		t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
		const targets = await Promise.all(children.map((child) => new Promise<any>((resolve, reject) => {
			child.once("message", resolve);
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`child exited before readiness: ${code}`)));
		})));
		assert.equal(targets[0].sessionHash, targets[1].sessionHash);
		assert.notEqual(targets[0].incarnation, targets[1].incarnation);
		assert.equal(listPresence(profile).entries.length, 2);
		const survivor = listPresence(profile).entries.find((h) => h.incarnation === targets[1].incarnation)!;
		assert.ok(readActivity(profile, survivor).activity);
		await new Promise<void>((resolve) => { children[0].once("exit", () => resolve()); children[0].send("dispose"); });
		assert.deepEqual(listPresence(profile).entries.map((h) => h.incarnation), [survivor.incarnation]);
		assert.ok(readActivity(profile, survivor).activity);
		await new Promise<void>((resolve) => { children[1].once("exit", () => resolve()); children[1].send("dispose"); });
		assert.deepEqual(fs.readdirSync(join(profile, "gentle-agents", "presence")), []);
	});
}
