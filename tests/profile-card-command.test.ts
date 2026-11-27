import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { PROFILE_CARD_SETTINGS_CHANGED } from "../lib/profile-card-policy.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

const USAGE = "Usage: /gentle:profiles [export <name> | import | publish <name> | export-routing | restore-routing | clear | card on|off]";

function fixture(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "profile-card-command-"));
	const config = join(root, "config");
	const project = join(root, "project");
	mkdirSync(config);
	mkdirSync(project);
	const keys = ["HOME", "USERPROFILE", "GENTLE_PI_CONFIG_HOME", "GENTLE_PI_AGENT_HOME", "PI_CODING_AGENT_DIR"];
	const previous = new Map(keys.map((key) => [key, process.env[key]]));
	process.env.HOME = root;
	process.env.USERPROFILE = root;
	process.env.GENTLE_PI_CONFIG_HOME = config;
	process.env.GENTLE_PI_AGENT_HOME = join(root, "agent");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	t.after(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});
	const commands = new Map<string, CommandHandler>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const pi = {
		on() {},
		events: { emit: (channel: string, data: unknown) => { emitted.push({ channel, data }); }, on() { return () => {}; } },
		registerCommand: (name: string, options: { handler: CommandHandler }) => { commands.set(name, options.handler); },
		registerTool() {},
		registerShortcut() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, processEnv: { ...process.env, GENTLE_PI_AGENTS_CHILD: "0", GENTLE_AI_TELEMETRY: "0" } })(pi);
	const notices: Array<{ message: string; level: unknown }> = [];
	const ctx = {
		cwd: project,
		hasUI: true,
		ui: { notify: (message: string, level?: unknown) => { notices.push({ message, level }); } },
		sessionManager: { getSessionId: () => "card-session", getBranch: () => [] },
	} as unknown as ExtensionContext;
	const run = async (args: string) => { await commands.get("gentle:profiles")!(args, ctx); };
	return { file: join(config, "profile-card.json"), notices, emitted, run, commands };
}

test("card on persists visible true, confirms, and emits the change event", async (t) => {
	const f = fixture(t);
	await f.run("card on");
	assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { schema: "gentle-pi.profile-card/v1", visible: true });
	assert.deepEqual(f.notices, [{ message: "Profile card shown. Turn it off with /gentle:profiles card off.", level: "info" }]);
	assert.equal(f.emitted.filter((e) => e.channel === PROFILE_CARD_SETTINGS_CHANGED).length, 1);
});

test("card off persists visible false, confirms, and emits the change event", async (t) => {
	const f = fixture(t);
	await f.run("card on");
	f.notices.length = 0;
	f.emitted.length = 0;
	await f.run("  card   off ");
	assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")), { schema: "gentle-pi.profile-card/v1", visible: false });
	assert.deepEqual(f.notices, [{ message: "Profile card hidden. Turn it on with /gentle:profiles card on.", level: "info" }]);
	assert.equal(f.emitted.filter((e) => e.channel === PROFILE_CARD_SETTINGS_CHANGED).length, 1);
});

test("a missing, unknown or extra argument shows the usage and writes and emits nothing", async (t) => {
	const f = fixture(t);
	for (const args of ["card", "card maybe", "card on extra", "card off now", "card ON"]) {
		await f.run(args);
		assert.deepEqual(f.notices.at(-1), { message: USAGE, level: "warning" }, args);
		assert.equal(existsSync(f.file), false, args);
	}
	assert.equal(f.emitted.filter((e) => e.channel === PROFILE_CARD_SETTINGS_CHANGED).length, 0);
	writeFileSync(f.file, '{"schema":"gentle-pi.profile-card/v1","visible":true}\n');
	await f.run("card nope");
	assert.equal(readFileSync(f.file, "utf8"), '{"schema":"gentle-pi.profile-card/v1","visible":true}\n');
	assert.equal(f.emitted.length, 0);
});

test("existing verbs still route: clear with extra tokens shows the usage", async (t) => {
	const f = fixture(t);
	await f.run("clear extra");
	assert.deepEqual(f.notices, [{ message: USAGE, level: "warning" }]);
	assert.equal(existsSync(f.file), false);
});
