import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATION_EVENTS, NOTIFICATION_SCHEMA, NOTIFICATION_PRIORITY,
	isNotificationSettings, isNotificationSound, parseNotificationSettingsFile,
	resolveNotificationSettings, restoreNotificationPreset, notificationSoundFor,
	writeNotificationSettings, type NotificationIO,
} from "../lib/notification-policy.ts";

const document = (settings: unknown) => JSON.stringify({ schema: NOTIFICATION_SCHEMA, ...(settings as object) });
function memoryIO() {
	const files = new Map<string, string>();
	const calls: Array<{ operation: string; path: string; options?: unknown }> = [];
	let readFailure: string | undefined;
	let renameFailure = false;
	const io: NotificationIO = {
		readFile(path) {
			calls.push({ operation: "read", path });
			if (readFailure || !files.has(path)) throw Object.assign(new Error("read"), { code: readFailure ?? "ENOENT" });
			return files.get(path)!;
		},
		mkdir(path) { calls.push({ operation: "mkdir", path }); },
		writeFile(path, content, options) {
			calls.push({ operation: "write", path, options });
			assert.equal(files.has(path), false);
			files.set(path, content);
		},
		rename(from, to) {
			calls.push({ operation: "rename", path: from });
			if (renameFailure) throw new Error("rename failed");
			files.set(to, files.get(from)!); files.delete(from);
		},
		unlink(path) { calls.push({ operation: "unlink", path }); files.delete(path); },
	};
	return { files, calls, io, setReadFailure: (code: string) => { readFailure = code; }, failRename: () => { renameFailure = true; } };
}
const options = (io: NotificationIO) => ({ gentlePiConfigHome: "/config", io });

test("preset cannot be mutated globally at any depth", () => {
	assert.throws(() => { DEFAULT_NOTIFICATION_SETTINGS.enabled = true; }, TypeError);
	assert.throws(() => { DEFAULT_NOTIFICATION_SETTINGS.audio.minimumIntervalMs = 42; }, TypeError);
	assert.throws(() => { DEFAULT_NOTIFICATION_SETTINGS.audio.events["agent.completed"] = null; }, TypeError);
	assert.equal(restoreNotificationPreset(DEFAULT_NOTIFICATION_SETTINGS).audio.events["agent.completed"], "builtin:success");
});

test("empty explicit home falls back to official global home for reads and writes", () => {
	const previous = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = "/official";
	try {
		const fs = memoryIO();
		assert.equal(resolveNotificationSettings({ gentlePiConfigHome: "", io: fs.io }).globalFile, "/official/notifications.json");
		assert.equal(writeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS, { gentlePiConfigHome: "", io: fs.io }), "/official/notifications.json");
	} finally {
		if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous;
	}
});

test("missing configuration is off, independent and has no write side effects", () => {
	const fs = memoryIO();
	const result = resolveNotificationSettings(options(fs.io));
	assert.equal(result.globalFile, "/config/notifications.json");
	assert.equal(result.source, "default");
	assert.equal(result.malformed, false); assert.equal(result.readError, false);
	assert.equal(result.settings.enabled, false);
	assert.equal(result.settings.audio.minimumIntervalMs, 1000);
	assert.equal(result.settings.audio.coalesceWindowMs, 300);
	assert.deepEqual(result.settings, DEFAULT_NOTIFICATION_SETTINGS);
	result.settings.audio.events["agent.completed"] = null;
	assert.equal(resolveNotificationSettings(options(fs.io)).settings.audio.events["agent.completed"], "builtin:success");
	assert.deepEqual(fs.calls.map(call => call.operation), ["read", "read"]);
});

test("strict schema rejects unknown keys, bad values and bounded noninteger timings", () => {
	const valid = structuredClone(DEFAULT_NOTIFICATION_SETTINGS);
	assert.equal(isNotificationSettings(valid), true);
	assert.deepEqual(parseNotificationSettingsFile(document(valid)), valid);
	const invalid = [null, [], { ...valid, extra: 1 }, { ...valid, enabled: "true" },
		{ ...valid, audio: { ...valid.audio, backend: "shell" } },
		{ ...valid, audio: { ...valid.audio, events: { "agent.unknown": null } } },
		{ ...valid, audio: { ...valid.audio, events: { "agent.started": undefined } } },
	];
	for (const value of invalid) assert.equal(isNotificationSettings(value), false);
	for (const key of ["minimumIntervalMs", "coalesceWindowMs"]) {
		for (const value of [-1, 0.5, Infinity, 60001, "300"])
			assert.equal(isNotificationSettings({ ...valid, audio: { ...valid.audio, [key]: value } }), false);
	}
	for (const raw of ["{", "null", "[]", document({ ...valid, schema: "future" })])
		assert.equal(parseNotificationSettingsFile(raw), undefined);
});

test("omission and null are silence, never preset merging or cross-event fallback", () => {
	const settings = parseNotificationSettingsFile(document({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: true,
		audio: { ...DEFAULT_NOTIFICATION_SETTINGS.audio, events: { "agent.failed": "builtin:success", "subagent.failed": null } } }))!;
	assert.equal(notificationSoundFor(settings, "agent.failed"), "builtin:success");
	for (const event of NOTIFICATION_EVENTS.filter(event => event !== "agent.failed"))
		assert.equal(notificationSoundFor(settings, event), null);
	assert.equal(NOTIFICATION_PRIORITY["agent.failed"], 3);
	assert.equal(NOTIFICATION_PRIORITY["agent.attention"], 2);
	assert.equal(NOTIFICATION_PRIORITY["agent.completed"], 1);
	assert.equal(NOTIFICATION_PRIORITY["subagent.waiting"], 0);
	assert.equal(NOTIFICATION_PRIORITY["session.started"], 0);
});

test("every contractual event is independent and both inclusive timing boundaries round trip", () => {
	for (const event of NOTIFICATION_EVENTS) {
		const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, audio: { ...DEFAULT_NOTIFICATION_SETTINGS.audio, events: { [event]: "builtin:attention" } } };
		const parsed = parseNotificationSettingsFile(document(settings))!;
		for (const other of NOTIFICATION_EVENTS)
			assert.equal(notificationSoundFor(parsed, other), other === event ? "builtin:attention" : null);
	}
	for (const [minimumIntervalMs, coalesceWindowMs] of [[0, 0], [60000, 2000]]) {
		const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, audio: { ...DEFAULT_NOTIFICATION_SETTINGS.audio, minimumIntervalMs, coalesceWindowMs } };
		assert.deepEqual(parseNotificationSettingsFile(document(settings)), settings);
	}
	assert.equal(isNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, audio: { ...DEFAULT_NOTIFICATION_SETTINGS.audio, coalesceWindowMs: 2001 } }), false);
});

test("global environment home is respected and a saved off file only reads", () => {
	const previous = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = "/override";
	try {
		const fs = memoryIO();
		fs.files.set("/override/notifications.json", document(DEFAULT_NOTIFICATION_SETTINGS));
		const result = resolveNotificationSettings({ io: fs.io });
		assert.equal(result.globalFile, "/override/notifications.json");
		assert.equal(result.source, "global_file"); assert.equal(result.settings.enabled, false);
		assert.deepEqual(fs.calls, [{ operation: "read", path: result.globalFile }]);
	} finally {
		if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous;
	}
});

test("sound references accept only known builtins or literal platform-absolute local paths", () => {
	for (const value of [null, "builtin:success", "builtin:error", "builtin:attention", "file:/audio/a b;[x].wav"])
		assert.equal(isNotificationSound(value, "posix"), true);
	for (const value of ["builtin:other", "file:", "file:relative.wav", "file:~/a.wav", "file:/a/$HOME.wav", "file:/a/${HOME}.wav", "file:/a/`whoami`.wav", "file:/a/\u0000.wav", "https://a.wav", "file:https://a.wav", "file://server/a.wav", "file:C:\\audio\\a.wav", 1, {}])
		assert.equal(isNotificationSound(value, "posix"), false);
	assert.equal(isNotificationSound("file:C:\\audio\\a b.wav", "win32"), true);
	for (const value of ["file:C:a.wav", "file:\\audio\\a.wav", "file:\\\\server\\share\\a.wav", "file:C:\\a\\%HOME%.wav"])
		assert.equal(isNotificationSound(value, "win32"), false);
});

test("malformed and unreadable configuration disable without overwriting", () => {
	const fs = memoryIO(); const path = "/config/notifications.json";
	fs.files.set(path, "broken");
	const malformed = resolveNotificationSettings(options(fs.io));
	assert.equal(malformed.malformed, true); assert.equal(malformed.readError, false);
	assert.equal(malformed.source, "global_file"); assert.equal(malformed.settings.enabled, false);
	assert.equal(fs.files.get(path), "broken");
	fs.setReadFailure("EACCES");
	const unreadable = resolveNotificationSettings(options(fs.io));
	assert.equal(unreadable.readError, true); assert.equal(unreadable.malformed, false);
	assert.equal(unreadable.settings.enabled, false);
	assert.deepEqual(fs.calls.map(call => call.operation), ["read", "read"]);
});

test("atomic writer uses same-directory exclusive 0600 temp, rejects invalid without IO", () => {
	const fs = memoryIO();
	const path = writeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS, options(fs.io));
	assert.equal(path, "/config/notifications.json");
	const write = fs.calls.find(call => call.operation === "write")!;
	assert.match(write.path, /^\/config\/notifications\.json\..+\.tmp$/);
	assert.deepEqual(write.options, { flag: "wx", mode: 0o600 });
	assert.deepEqual([...fs.files.keys()], [path]);
	assert.deepEqual(resolveNotificationSettings(options(fs.io)).settings, DEFAULT_NOTIFICATION_SETTINGS);
	const before = fs.calls.length;
	assert.throws(() => writeNotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, enabled: "bad" } as never, options(fs.io)), /Invalid notification settings/);
	assert.equal(fs.calls.length, before);
});

test("failed rename preserves old bytes, propagates failure and cleans temporary", () => {
	const fs = memoryIO(); const path = "/config/notifications.json";
	fs.files.set(path, "old bytes"); fs.failRename();
	assert.throws(() => writeNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS, options(fs.io)), /rename failed/);
	assert.deepEqual([...fs.files.entries()], [[path, "old bytes"]]);
	assert.equal(fs.calls.at(-1)?.operation, "unlink");
});

test("explicit preset restore preserves enabled both ways and returns independent settings", () => {
	for (const enabled of [false, true]) {
		const current = { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS), enabled };
		current.audio.events["agent.completed"] = null;
		const restored = restoreNotificationPreset(current);
		assert.deepEqual(restored, { ...DEFAULT_NOTIFICATION_SETTINGS, enabled });
		restored.audio.events["agent.failed"] = null;
		assert.equal(DEFAULT_NOTIFICATION_SETTINGS.audio.events["agent.failed"], "builtin:error");
		assert.equal(current.audio.events["agent.completed"], null);
	}
});
