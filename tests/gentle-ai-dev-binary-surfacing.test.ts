import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import {
	GENTLE_AI_DEV_BINARY_ENV,
	gentleAiDevBinaryRegistrationPath,
	setGentleAiDevBinaryEnvironmentForTesting,
} from "../lib/gentle-ai-binary.ts";

// Loud surfacing for the dev-binary override: while an override is active,
// every diagnostic surface must say so, name the exact binary, its live
// version, and its content digest — the maintainer must never wonder which
// gentle-ai actually answered.

interface CommandRegistration {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

function harness(): { pi: ExtensionAPI; commands: Map<string, CommandRegistration> } {
	const commands = new Map<string, CommandRegistration>();
	const pi = {
		on() {},
		registerCommand(name: string, registration: CommandRegistration) {
			commands.set(name, registration);
		},
		registerTool() {},
	} as unknown as ExtensionAPI;
	return { pi, commands };
}

function contextFor(cwd: string, notifications: Array<{ message: string; severity: string }>): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		ui: {
			notify(message: string, severity: string) {
				notifications.push({ message, severity });
			},
		},
	} as unknown as ExtensionContext;
}

async function withDevOverride<T>(callback: (state: { devBinary: string; sha256: string; home: string }) => Promise<T>): Promise<T> {
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	const bin = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-bin-"));
	const devBinary = join(bin, "gentle-ai");
	writeFileSync(devBinary, "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+surface'\n");
	chmodSync(devBinary, 0o755);
	const sha256 = createHash("sha256").update(readFileSync(devBinary)).digest("hex");
	setGentleAiDevBinaryEnvironmentForTesting({ env: { [GENTLE_AI_DEV_BINARY_ENV]: devBinary }, home });
	try {
		return await callback({ devBinary, sha256, home });
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
}

test("gentle:doctor and gentle:status surface the active dev-binary override loudly", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	try {
		await withDevOverride(async ({ devBinary, sha256 }) => {
			const { pi, commands } = harness();
			createGentleAiExtension({ nativeReviewCli: null })(pi);
			const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
			const expected = `Gentle AI dev binary override active (unpinned, field-test only): ${devBinary} 9.9.9-dev+surface sha256:${sha256.slice(0, 16)}`;
			for (const command of ["gentle:doctor", "gentle:status"]) {
				const notifications: Array<{ message: string; severity: string }> = [];
				await commands.get(command)!.handler("", contextFor(cwd, notifications));
				assert.equal(notifications.length, 1, command);
				assert.ok(notifications[0]!.message.includes(expected), `${command}: ${notifications[0]!.message}`);
			}
		});
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

test("without an override the surfaces stay silent about dev binaries", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	setGentleAiDevBinaryEnvironmentForTesting({ env: {}, home });
	try {
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
		for (const command of ["gentle:doctor", "gentle:status"]) {
			const notifications: Array<{ message: string; severity: string }> = [];
			await commands.get(command)!.handler("", contextFor(cwd, notifications));
			assert.equal(notifications.length, 1, command);
			assert.doesNotMatch(notifications[0]!.message, /dev binary/i, command);
		}
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

test("an invalid override is surfaced as a failure, never silently ignored", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	setGentleAiDevBinaryEnvironmentForTesting({ env: { [GENTLE_AI_DEV_BINARY_ENV]: "/nonexistent/gentle-ai" }, home });
	try {
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
		const notifications: Array<{ message: string; severity: string }> = [];
		await commands.get("gentle:doctor")!.handler("", contextFor(cwd, notifications));
		assert.equal(notifications.length, 1);
		assert.match(notifications[0]!.message, /fail: Gentle AI dev binary override/);
		assert.match(notifications[0]!.message, new RegExp(GENTLE_AI_DEV_BINARY_ENV));
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
	}
});

test("gentle:dev-binary registers, reports, and clears the persistent override", async () => {
	const home = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-home-"));
	const bin = await mkdtemp(join(tmpdir(), "gentle-pi-dev-surface-bin-"));
	const devBinary = join(bin, "gentle-ai");
	writeFileSync(devBinary, "#!/bin/sh\necho 'gentle-ai 9.9.9-dev+register'\n");
	chmodSync(devBinary, 0o755);
	setGentleAiDevBinaryEnvironmentForTesting({ env: {}, home });
	try {
		const { pi, commands } = harness();
		createGentleAiExtension({ nativeReviewCli: null })(pi);
		const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
		const command = commands.get("gentle:dev-binary");
		assert.ok(command, "gentle:dev-binary command is registered");
		const registrationPath = gentleAiDevBinaryRegistrationPath({ env: {}, home });

		let notifications: Array<{ message: string; severity: string }> = [];
		await command!.handler("status", contextFor(cwd, notifications));
		assert.match(notifications[0]!.message, /no dev binary override/i);

		notifications = [];
		await command!.handler(devBinary, contextFor(cwd, notifications));
		assert.equal(existsSync(registrationPath), true);
		assert.match(notifications[0]!.message, /dev binary override active \(unpinned, field-test only\)/);
		assert.ok(notifications[0]!.message.includes(devBinary));

		notifications = [];
		await command!.handler("relative/gentle-ai", contextFor(cwd, notifications));
		assert.equal(notifications[0]!.severity, "error");

		notifications = [];
		await command!.handler("off", contextFor(cwd, notifications));
		assert.equal(existsSync(registrationPath), false);
		assert.match(notifications[0]!.message, /removed|cleared/i);
	} finally {
		setGentleAiDevBinaryEnvironmentForTesting(undefined);
	}
});

interface SessionStartHarness {
	sessionStart: (event: unknown, ctx: ExtensionContext) => Promise<void>;
}

async function sessionStartHarness(): Promise<SessionStartHarness> {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) {
			handlers.set(name, handler);
		},
		registerCommand() {},
		registerTool() {},
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null })(pi);
	const sessionStart = handlers.get("session_start");
	assert.equal(typeof sessionStart, "function");
	return { sessionStart: sessionStart! };
}

// The 🌹 dev-binary card (gentle-shell) owns the startup notice when it can
// render; the session-start toast is only the fallback for when the card is
// unavailable (shell disabled, no UI).
test("session start defers the active-override announcement to the shell card", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const previousShell = process.env.GENTLE_PI_SHELL;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	delete process.env.GENTLE_PI_SHELL;
	try {
		await withDevOverride(async ({ devBinary, sha256 }) => {
			const { sessionStart } = await sessionStartHarness();
			const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
			const notifications: Array<{ message: string; severity: string }> = [];
			await sessionStart({}, contextFor(cwd, notifications));
			const expected = `Gentle AI dev binary override active (unpinned, field-test only): ${devBinary} 9.9.9-dev+surface sha256:${sha256.slice(0, 16)}`;
			const announcement = notifications.find((entry) => entry.message.includes(expected));
			assert.equal(announcement, undefined, JSON.stringify(notifications));
		});
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		if (previousShell === undefined) delete process.env.GENTLE_PI_SHELL;
		else process.env.GENTLE_PI_SHELL = previousShell;
	}
});

test("session start stays silent in headless contexts even with an active override", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const previousShell = process.env.GENTLE_PI_SHELL;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	delete process.env.GENTLE_PI_SHELL;
	try {
		await withDevOverride(async () => {
			const { sessionStart } = await sessionStartHarness();
			const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
			const notifications: Array<{ message: string; severity: string }> = [];
			const headless = { ...contextFor(cwd, notifications), hasUI: false } as unknown as ExtensionContext;
			await sessionStart({}, headless);
			assert.equal(notifications.length, 0, JSON.stringify(notifications));
		});
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		if (previousShell === undefined) delete process.env.GENTLE_PI_SHELL;
		else process.env.GENTLE_PI_SHELL = previousShell;
	}
});

test("session start keeps the loud toast as fallback when the shell card is unavailable", async () => {
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const previousShell = process.env.GENTLE_PI_SHELL;
	process.env.GENTLE_PI_AGENT_HOME = await mkdtemp(join(tmpdir(), "gentle-pi-dev-agent-home-"));
	process.env.GENTLE_PI_SHELL = "off";
	try {
		await withDevOverride(async ({ devBinary, sha256 }) => {
			const { sessionStart } = await sessionStartHarness();
			const cwd = await mkdtemp(join(tmpdir(), "gentle-pi-dev-cwd-"));
			const notifications: Array<{ message: string; severity: string }> = [];
			await sessionStart({}, contextFor(cwd, notifications));
			const expected = `Gentle AI dev binary override active (unpinned, field-test only): ${devBinary} 9.9.9-dev+surface sha256:${sha256.slice(0, 16)}`;
			const announcement = notifications.find((entry) => entry.message.includes(expected));
			assert.ok(announcement, JSON.stringify(notifications));
			assert.equal(announcement!.severity, "warning");
		});
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		if (previousShell === undefined) delete process.env.GENTLE_PI_SHELL;
		else process.env.GENTLE_PI_SHELL = previousShell;
	}
});
