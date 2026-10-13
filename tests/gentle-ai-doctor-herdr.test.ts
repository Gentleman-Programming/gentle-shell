import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { setGentleAiDevBinaryEnvironmentForTesting } from "../lib/gentle-ai-binary.ts";

// /gentle:doctor surfaces the Herdr sidebar setup only inside Herdr. It is
// read-only guidance: Herdr config is never written.

const ISOLATED = ["GENTLE_PI_CONFIG_HOME", "GENTLE_PI_AGENT_HOME", "GENTLE_PI_AGENTS_CHILD", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH"];
let saved: Record<string, string | undefined> = {};
beforeEach(async () => {
	saved = Object.fromEntries(ISOLATED.map((name) => [name, process.env[name]]));
	for (const name of ISOLATED) delete process.env[name];
	process.env.GENTLE_PI_CONFIG_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-doctor-config-"));
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-doctor-agent-"));
	setGentleAiDevBinaryEnvironmentForTesting({ env: {}, home: await mkdtemp(join(tmpdir(), "gentle-pi-doctor-home-")) });
});
afterEach(() => {
	setGentleAiDevBinaryEnvironmentForTesting(undefined);
	for (const name of ISOLATED) {
		if (saved[name] === undefined) delete process.env[name];
		else process.env[name] = saved[name];
	}
});

async function runDoctor(): Promise<Array<{ message: string; severity: string }>> {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const pi = {
		on() {},
		registerCommand(name: string, registration: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, registration);
		},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	const notifications: Array<{ message: string; severity: string }> = [];
	const ctx = {
		cwd: await mkdtemp(join(tmpdir(), "gentle-pi-doctor-cwd-")),
		mode: "tui",
		hasUI: true,
		ui: { notify(message: string, severity: string) { notifications.push({ message, severity }); } },
	} as unknown as ExtensionContext;
	await commands.get("gentle:doctor")!.handler("", ctx);
	return notifications;
}

async function listen(path: string): Promise<Server> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return server;
}

test("outside Herdr, /gentle:doctor stays silent about Herdr", async () => {
	const notifications = await runDoctor();
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]!.message, /^el Gentleman doctor\n/);
	assert.doesNotMatch(notifications[0]!.message, /herdr|\$summary/i);
});

test("inside Herdr, /gentle:doctor appends the read-only sidebar setup hint", async () => {
	const baseline = await runDoctor();
	const socket = join(await mkdtemp(join(tmpdir(), "gd-")), "h.sock");
	const server = await listen(socket);
	try {
		Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "pane-1", HERDR_SOCKET_PATH: socket });
		const notifications = await runDoctor();
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]!.severity, baseline[0]!.severity, "the hint does not change doctor severity");
		assert.ok(notifications[0]!.message.endsWith([
			"Herdr",
			"pass: Herdr task-summary publishing active",
			"info: Herdr's default sidebar does not show task titles; add these two rows to the Agents sidebar rows in your Herdr config: ['$summary'], ['$summary2']",
			"info: Sidebar rows belong to the config of the Herdr client that displays the session, including when Pi runs over SSH",
			"info: After editing, reload or restart Herdr; Gentle Shell never changes Herdr config",
			"info: Details: https://github.com/Gentleman-Programming/gentle-shell/blob/main/docs/readme-reference.md#herdr-active-work-summary",
		].join("\n")), notifications[0]!.message);
		assert.ok(notifications[0]!.message.startsWith(baseline[0]!.message), "existing doctor lines are unchanged");
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test("inside Herdr without a live socket, /gentle:doctor reports publishing inactive", async () => {
	Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "pane-1", HERDR_SOCKET_PATH: join(tmpdir(), "missing-herdr.sock") });
	const notifications = await runDoctor();
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]!.message, /\nwarn: Herdr task-summary publishing inactive: HERDR_SOCKET_PATH is not a Unix socket\n/);
	assert.match(notifications[0]!.message, /\['\$summary'\], \['\$summary2'\]/);
});
