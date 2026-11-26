import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DesktopConfigBridge } from "../lib/desktop-rpc-config.ts";
import { beginDesktopProfileApply, endDesktopProfileApply } from "../lib/desktop-rpc-profiles.ts";
import { DEFAULT_NOTIFICATION_SETTINGS, NOTIFICATION_EVENTS, NOTIFICATION_SCHEMA } from "../lib/notification-policy.ts";

// The persona, banner, and notifications config stores (gentle-shell-gpui
// parity, T3): read and written through the same get_config/set_config
// contract as the profile stores, by their own owners.

function env(t: test.TestContext, context: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), "desktop-config-settings-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	const workspace = join(root, "workspace");
	for (const dir of [configHome, agentHome, workspace]) mkdirSync(dir, { recursive: true });
	const bridge = new DesktopConfigBridge({ configHome, agentHome });
	bridge.attach({ cwd: workspace, ...context } as unknown as ExtensionContext);
	return {
		root,
		configHome,
		agentHome,
		workspace,
		bridge,
		projectPersona: join(workspace, ".pi", "gentle-ai", "persona.json"),
		async read(store: string): Promise<any> {
			const outcome = await bridge.handle("get_config", { store });
			assert.ok(outcome?.ok, JSON.stringify(outcome));
			return outcome.data;
		},
		async revision(store: string): Promise<string> {
			return (await this.read(store)).writeTargets[0].writeRevision;
		},
		async write(store: string, data: unknown, expectedRevision?: string): Promise<any> {
			return bridge.handle("set_config", { store, data, expectedRevision: expectedRevision ?? await this.revision(store) });
		},
	};
}

const FILE_SOUND = process.platform === "win32" ? "file:C:\\sounds\\secret-done.wav" : "file:/home/x/sounds/secret-done.wav";

// ---- persona ----

test("persona reads both layers and the mode in effect", async (t) => {
	const e = env(t);
	const empty = await e.read("persona");
	assert.equal(empty.status, "missing");
	assert.equal(empty.readOnly, false);
	assert.equal(empty.scope, "global+project");
	assert.deepEqual(empty.layers, [{ source: "global", status: "missing" }, { source: "project", status: "missing" }]);
	writeFileSync(join(e.configHome, "persona.json"), JSON.stringify({ mode: "gentleman" }));
	mkdirSync(join(e.workspace, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(e.projectPersona, JSON.stringify({ mode: "neutral" }));
	const both = await e.read("persona");
	assert.equal(both.status, "ok");
	assert.deepEqual(both.value, { mode: "neutral" }, "the project file wins");
});

test("a persona write updates the global file and an existing project file, then answers the new state", async (t) => {
	const e = env(t);
	mkdirSync(join(e.workspace, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(e.projectPersona, JSON.stringify({ mode: "gentleman" }));
	const outcome = await e.write("persona", { mode: "neutral" });
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.equal(outcome.data.changed, true);
	assert.deepEqual(outcome.data.value, { mode: "neutral" });
	assert.equal(outcome.event?.name, "config_changed");
	assert.deepEqual(JSON.parse(readFileSync(join(e.configHome, "persona.json"), "utf8")), { mode: "neutral" });
	assert.deepEqual(JSON.parse(readFileSync(e.projectPersona, "utf8")), { mode: "neutral" }, "a project file never silently outranks the change");
});

test("a persona write never creates a project file", async (t) => {
	const e = env(t);
	assert.equal((await e.write("persona", { mode: "neutral" })).ok, true);
	assert.equal(existsSync(e.projectPersona), false);
});

test("persona rejects bad data and a stale token, writing nothing", async (t) => {
	const e = env(t);
	for (const data of [{ mode: "pirate" }, { mode: "neutral", extra: 1 }, "neutral", {}]) {
		const outcome = await e.write("persona", data);
		assert.equal(outcome.error?.code, "invalid_data", JSON.stringify(data));
	}
	const stale = await e.revision("persona");
	mkdirSync(join(e.workspace, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(e.projectPersona, JSON.stringify({ mode: "gentleman" }));
	assert.equal((await e.write("persona", { mode: "neutral" }, stale)).error?.code, "revision_conflict", "a project change makes the global token stale");
	assert.equal(existsSync(join(e.configHome, "persona.json")), false);
});

// ---- banner ----

test("banner reads and writes exactly the three banner settings", async (t) => {
	const e = env(t);
	assert.equal((await e.read("banner")).status, "missing");
	const config = { showRose: false, showTextLogo: true, color: "cyan" };
	const outcome = await e.write("banner", config);
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.deepEqual(outcome.data.value, config);
	assert.deepEqual(JSON.parse(readFileSync(join(e.configHome, "banner.json"), "utf8")), config);
	for (const data of [{ ...config, color: "red" }, { ...config, extra: true }, { showRose: true }]) {
		assert.equal((await e.write("banner", data)).error?.code, "invalid_data", JSON.stringify(data));
	}
	assert.equal((await e.write("banner", config)).data.changed, false, "the same content is not a change");
});

test("a malformed banner file reads as invalid and is never repaired by a read", async (t) => {
	const e = env(t);
	writeFileSync(join(e.configHome, "banner.json"), "{ nope");
	const read = await e.read("banner");
	assert.equal(read.status, "invalid");
	assert.equal(readFileSync(join(e.configHome, "banner.json"), "utf8"), "{ nope");
});

// ---- notifications ----

function notificationsFile(e: ReturnType<typeof env>, settings: unknown): void {
	writeFileSync(join(e.configHome, "notifications.json"), JSON.stringify({ schema: NOTIFICATION_SCHEMA, ...(settings as object) }));
}

test("notifications hide file sound paths and keep them on a write that sends the marker back", async (t) => {
	const e = env(t);
	const [first, second] = NOTIFICATION_EVENTS;
	const settings = structuredClone(DEFAULT_NOTIFICATION_SETTINGS) as any;
	settings.audio.events[first!] = FILE_SOUND;
	notificationsFile(e, settings);
	const read = await e.read("notifications");
	assert.equal(read.status, "ok");
	assert.equal(read.value.audio.events[first!], "file");
	assert.equal(JSON.stringify(read).includes("secret-done"), false, "no sound path crosses");

	const next = structuredClone(read.value);
	next.enabled = !next.enabled;
	next.audio.events[second!] = null;
	const outcome = await e.write("notifications", next);
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.equal(JSON.stringify(outcome).includes("secret-done"), false);
	const stored = JSON.parse(readFileSync(join(e.configHome, "notifications.json"), "utf8"));
	assert.equal(stored.audio.events[first!], FILE_SOUND, "the file sound is kept");
	assert.equal(stored.audio.events[second!], null);
	assert.equal(stored.enabled, next.enabled);
});

test("notifications reject a new file path, a marker with no file behind it, and invalid settings", async (t) => {
	const e = env(t);
	const [first] = NOTIFICATION_EVENTS;
	const base = structuredClone(DEFAULT_NOTIFICATION_SETTINGS) as any;
	for (const mutate of [
		(s: any) => { s.audio.events[first!] = FILE_SOUND; },
		(s: any) => { s.audio.events[first!] = "file"; },
		(s: any) => { s.audio.minimumIntervalMs = -1; },
		(s: any) => { s.schema = NOTIFICATION_SCHEMA; },
	]) {
		const data = structuredClone(base);
		mutate(data);
		assert.equal((await e.write("notifications", data)).error?.code, "invalid_data");
	}
	assert.equal(existsSync(join(e.configHome, "notifications.json")), false);
});

// ---- shared rules ----

test("settings writes do not wait for a profile apply", async (t) => {
	const e = env(t);
	assert.ok(beginDesktopProfileApply());
	t.after(endDesktopProfileApply);
	assert.equal((await e.write("banner", { showRose: true, showTextLogo: false, color: "green" })).ok, true);
	assert.equal((await e.write("persona", { mode: "neutral" })).ok, true);
});

// ---- Independent verification follow-ups (L30) ----

test("notifications validate data before the revision", async (t) => {
	const e = env(t);
	const stale = await e.revision("notifications");
	notificationsFile(e, { ...structuredClone(DEFAULT_NOTIFICATION_SETTINGS), enabled: true });
	const bad = structuredClone(DEFAULT_NOTIFICATION_SETTINGS) as any;
	bad.audio.minimumIntervalMs = -5;
	assert.equal((await e.write("notifications", bad, stale)).error?.code, "invalid_data");
});

test("only the profile stores wait for an apply", async (t) => {
	const e = env(t);
	assert.ok(beginDesktopProfileApply());
	t.after(endDesktopProfileApply);
	const settings = structuredClone(DEFAULT_NOTIFICATION_SETTINGS) as any;
	settings.enabled = true;
	assert.equal((await e.write("notifications", settings)).ok, true);
	for (const [store, data] of [["profiles", {}], ["profile_fallbacks", {}], ["pins", { source: "repo", profile: null }]] as const) {
		assert.equal(((await e.bridge.handle("set_config", { store, data, expectedRevision: "sha256:x" })) as any).error?.code, "profile_apply_busy");
	}
});

test("a file marker never moves a file sound to another event", async (t) => {
	const e = env(t);
	const [first, second] = NOTIFICATION_EVENTS;
	const settings = structuredClone(DEFAULT_NOTIFICATION_SETTINGS) as any;
	settings.audio.events[first!] = FILE_SOUND;
	notificationsFile(e, settings);
	const path = join(e.configHome, "notifications.json");
	const before = readFileSync(path, "utf8");
	const value = (await e.read("notifications")).value;
	value.audio.events[second!] = "file";
	assert.equal((await e.write("notifications", value)).error?.code, "invalid_data");
	assert.equal(readFileSync(path, "utf8"), before);
});

// ---- Review follow-ups (CodeRabbit on #3471) ----

test("a file sound changed outside Desktop moves the notifications read revision", async (t) => {
	const e = env(t);
	const [first] = NOTIFICATION_EVENTS;
	const settings = structuredClone(DEFAULT_NOTIFICATION_SETTINGS) as any;
	settings.audio.events[first!] = FILE_SOUND;
	notificationsFile(e, settings);
	const before = (await e.read("notifications")).revision;
	settings.audio.events[first!] = FILE_SOUND.replace("secret-done", "other-done");
	notificationsFile(e, settings);
	const after = await e.read("notifications");
	assert.notEqual(after.revision, before);
	assert.equal(JSON.stringify(after).includes("other-done"), false, "the path still never crosses");
});

test("an unknown or prototype event key is rejected, never silently dropped", async (t) => {
	const e = env(t);
	const data = JSON.parse(JSON.stringify(DEFAULT_NOTIFICATION_SETTINGS));
	const withProto = JSON.parse(JSON.stringify(data).replace('"events":{', '"events":{"__proto__":null,'));
	assert.equal((await e.write("notifications", withProto)).error?.code, "invalid_data");
	assert.equal(existsSync(join(e.configHome, "notifications.json")), false);
});

// ---- pi_settings: Pi's settings.json model keys (Configuration › Models) ----

test("pi_settings reads Pi's merged display view and writes the global file's model keys", async (t) => {
	const e = env(t);
	const empty = await e.read("pi_settings");
	assert.deepEqual([empty.status, empty.scope, empty.readOnly, empty.value], ["missing", "global+project", false, undefined]);
	assert.deepEqual(empty.writeTargets.map((entry: any) => [entry.target, entry.status]), [["global", "missing"]]);
	writeFileSync(join(e.agentHome, "settings.json"), JSON.stringify({ packages: ["npm:x"], theme: "dark", defaultProvider: "anthropic", defaultModel: "claude-opus", defaultThinkingLevel: "high", enabledModels: ["anthropic/*", "openai/gpt-5"] }));
	const read = await e.read("pi_settings");
	assert.equal(read.status, "ok");
	assert.deepEqual(read.value, { defaultProvider: "anthropic", defaultModel: "claude-opus", defaultThinkingLevel: "high", enabledModels: ["anthropic/*", "openai/gpt-5"], extensions: [], truncated: false });
});

test("a pi_settings write patches the model keys and keeps every other settings key", async (t) => {
	const e = env(t);
	const path = join(e.agentHome, "settings.json");
	writeFileSync(path, JSON.stringify({ packages: ["npm:x"], defaultProvider: "anthropic", defaultModel: "claude-opus", defaultThinkingLevel: "high" }));
	const patch = { defaultProvider: "openai", defaultModel: "gpt-5", defaultThinkingLevel: null, enabledModels: ["openai/gpt-5", "anthropic/claude-opus"] };
	const outcome = await e.write("pi_settings", patch);
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.equal(outcome.data.changed, true);
	assert.equal(outcome.event?.name, "config_changed");
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { packages: ["npm:x"], defaultProvider: "openai", defaultModel: "gpt-5", enabledModels: ["openai/gpt-5", "anthropic/claude-opus"] }, "null removes a key");
	assert.equal(outcome.data.value.defaultModel, "gpt-5");
	const same = await e.write("pi_settings", patch);
	assert.deepEqual([same.ok, same.data.changed, same.event], [true, false, undefined]);
	assert.equal((await e.write("pi_settings", { defaultModel: "gpt-5-mini" })).ok, true);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { packages: ["npm:x"], defaultProvider: "openai", defaultModel: "gpt-5-mini", enabledModels: ["openai/gpt-5", "anthropic/claude-opus"] }, "a key the patch leaves out keeps its value");
	assert.deepEqual([(await e.write("pi_settings", {})).data.changed], [false]);
	assert.equal((await e.write("pi_settings", { defaultProvider: null, defaultModel: null, enabledModels: null })).ok, true);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { packages: ["npm:x"] });
});

test("a pi_settings write goes to the global file even when a trusted project's file wins the merge", async (t) => {
	const e = env(t, { isProjectTrusted: () => true });
	mkdirSync(join(e.workspace, ".pi"), { recursive: true });
	writeFileSync(join(e.workspace, ".pi", "settings.json"), JSON.stringify({ defaultModel: "project-model" }));
	const outcome = await e.write("pi_settings", { defaultModel: "global-model" });
	assert.equal(outcome.ok, true, JSON.stringify(outcome));
	assert.deepEqual(JSON.parse(readFileSync(join(e.agentHome, "settings.json"), "utf8")), { defaultModel: "global-model" });
	assert.deepEqual(JSON.parse(readFileSync(join(e.workspace, ".pi", "settings.json"), "utf8")), { defaultModel: "project-model" });
	assert.equal(outcome.data.value.defaultModel, "project-model", "the store shows what Pi runs with");
	assert.deepEqual(outcome.data.layers, [{ source: "global", status: "ok" }, { source: "project", status: "ok" }]);
});

test("a pi_settings write validates every key and never replaces an unreadable settings file", async (t) => {
	const e = env(t);
	for (const data of [
		{ theme: "dark" },
		{ extensions: [] },
		{ truncated: false },
		{ defaultProvider: "" },
		{ defaultModel: 3 },
		{ defaultThinkingLevel: "extreme" },
		{ enabledModels: "openai/gpt-5" },
		{ enabledModels: ["a", "a"] },
		{ enabledModels: ["bad\nline"] },
		[],
	]) {
		assert.equal((await e.write("pi_settings", data)).error?.code, "invalid_data", JSON.stringify(data));
	}
	assert.equal(existsSync(join(e.agentHome, "settings.json")), false);
	const stale = await e.revision("pi_settings");
	writeFileSync(join(e.agentHome, "settings.json"), JSON.stringify({ defaultModel: "x" }));
	assert.equal((await e.write("pi_settings", { defaultModel: "y" }, stale)).error?.code, "revision_conflict");
	writeFileSync(join(e.agentHome, "settings.json"), "{ not json");
	const broken = await e.read("pi_settings");
	assert.equal(broken.status, "invalid");
	assert.equal((await e.write("pi_settings", { defaultModel: "y" })).error?.code, "write_failed");
	assert.equal(readFileSync(join(e.agentHome, "settings.json"), "utf8"), "{ not json");
});

test("a pi_settings write waits for a profile apply, which also sets the orchestrator", async (t) => {
	const e = env(t);
	const revision = await e.revision("pi_settings");
	beginDesktopProfileApply();
	try {
		assert.equal((await e.write("pi_settings", { defaultModel: "y" }, revision)).error?.code, "profile_apply_busy");
	} finally {
		endDesktopProfileApply();
	}
});
