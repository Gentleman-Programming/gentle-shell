import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

const { confirmCommand, evaluateGuardedCommand, loadRuntimeGuardrailsConfig, saveGuardedCommandAllowAlways } = __testing as {
	confirmCommand: (command: string, ctx: unknown, events: unknown, herdrLifecycle: unknown, yoloActive?: boolean, autoGate?: unknown, superActive?: boolean) => Promise<{ block: true; reason: string } | undefined>;
	evaluateGuardedCommand: (command: string, config: { autonomousMode: boolean; guardedCommands: Record<string, string> }) => { action: string; dataLoss?: boolean; key?: string };
	loadRuntimeGuardrailsConfig: (cwd: string, options?: { gentlePiConfigHome?: string }) => { autonomousMode: boolean; guardedCommands: Record<string, string> };
	saveGuardedCommandAllowAlways: (key: string, options?: { gentlePiConfigHome?: string }) => boolean;
};

interface Harness {
	home: string;
	selectCalls: Array<{ prompt: string; choices: string[] }>;
	confirmCalls: string[];
	selectWith(value: string | undefined): void;
	setConfigHome(): void;
	restoreConfigHome(): void;
	ctx(sessionManager?: object): Record<string, unknown>;
	events: { emitted: Array<{ state: string }>; emit(_name: string, payload: { state: string }): void };
	lifecycle: { began: number; settled: number; begin(): void; settle(): void };
	run(command: string, sessionManager?: object): Promise<{ block: true; reason: string } | undefined>;
}

function makeHarness(): Harness {
	const home = mkdtempSync(join(tmpdir(), "permission-allowlist-"));
	const previousConfigHome = process.env.GENTLE_PI_CONFIG_HOME;
	const harness: Harness = {
		home,
		selectCalls: [],
		confirmCalls: [],
		pendingSelection: undefined as string | undefined,
		selectWith(value: string | undefined) { harness.pendingSelection = value; },
		setConfigHome() { process.env.GENTLE_PI_CONFIG_HOME = home; },
		restoreConfigHome() {
			if (previousConfigHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
			else process.env.GENTLE_PI_CONFIG_HOME = previousConfigHome;
		},
		ctx(sessionManager: object = { id: "manager" }) {
			return {
				cwd: home,
				sessionManager,
				hasUI: true,
				ui: {
					select: async (prompt: string, choices: string[]) => {
						harness.selectCalls.push({ prompt, choices });
						return harness.pendingSelection;
					},
					confirm: async (title: string, _message: string) => {
						harness.confirmCalls.push(title);
						return harness.pendingSelection === "Allow once";
					},
					notify: () => {},
				},
			};
		},
		events: {
			emitted: [],
			emit(_name: string, payload: { state: string }) { harness.events.emitted.push(payload); },
		},
		lifecycle: {
			began: 0, settled: 0,
			begin() { harness.lifecycle.began += 1; },
			settle() { harness.lifecycle.settled += 1; },
		},
		async run(command: string, sessionManager?: object) {
			return await confirmCommand(command, harness.ctx(sessionManager), harness.events, harness.lifecycle);
		},
	};
	return harness;
}

test("normal-mode confirmation dialog offers once, session and always scopes", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		harness.selectWith("Allow once");
		const result = await harness.run("git push origin main", { id: "m1" });
		assert.equal(result, undefined);
		assert.equal(harness.selectCalls.length, 1);
		const { prompt, choices } = harness.selectCalls[0];
		assert.match(prompt, /git push origin main/);
		assert.deepEqual(choices, ["Allow once", "Allow for this session", "Always allow git push", "Deny"]);
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("allow once asks again; allow for this session remembers the exact command", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		const manager = { id: "m2" };
		harness.selectWith("Allow once");
		assert.equal(await harness.run("git push origin main", manager), undefined);
		assert.equal(await harness.run("git push origin main", manager), undefined);
		assert.equal(harness.selectCalls.length, 2);

		const manager2 = { id: "m3" };
		harness.selectWith("Allow for this session");
		assert.equal(await harness.run("git push origin main", manager2), undefined);
		assert.equal(await harness.run("git push origin main", manager2), undefined);
		assert.equal(harness.selectCalls.length, 3);
		// A different exact command asks again.
		harness.selectWith("Allow for this session");
		assert.equal(await harness.run("git push origin feature-branch", manager2), undefined);
		assert.equal(harness.selectCalls.length, 4);
		// A different session never inherits the grant.
		harness.selectWith("Allow for this session");
		assert.equal(await harness.run("git push origin main", { id: "m4" }), undefined);
		assert.equal(harness.selectCalls.length, 5);
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("deny keeps blocking with the existing reason and permission events", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		harness.selectWith("Deny");
		const result = await harness.run("git push origin main", { id: "m5" });
		assert.ok(result?.block);
		assert.match(result.reason, /not confirmed/);
		assert.deepEqual(harness.events.emitted.map(event => event.state), ["waiting", "denied"]);
		assert.equal(harness.lifecycle.began, 1);
		assert.equal(harness.lifecycle.settled, 1);
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("data-loss commands never offer an always-allow scope", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		harness.selectWith("Allow for this session");
		const manager = { id: "m6" };
		assert.equal(await harness.run("rm -rf data", manager), undefined);
		assert.equal(harness.selectCalls.length, 1);
		const { choices } = harness.selectCalls[0];
		assert.ok(choices.includes("Allow for this session"));
		assert.ok(!choices.some(choice => choice.startsWith("Always allow")));
		// The exact approved command asks no more this session.
		assert.equal(await harness.run("rm -rf data", manager), undefined);
		assert.equal(harness.selectCalls.length, 1);
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("always allow persists the guarded key in the user config and future calls skip the dialog", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		const manager = { id: "m7" };
		harness.selectWith("Always allow git push");
		assert.equal(await harness.run("git push origin main", manager), undefined);
		const configPath = join(harness.home, "runtime-guardrails.json");
		assert.ok(existsSync(configPath));
		const saved = JSON.parse(readFileSync(configPath, "utf8"));
		assert.equal(saved.guardedCommands.gitPush, "allow");
		// The persisted allow short-circuits evaluation in normal mode.
		const evaluation = evaluateGuardedCommand("git push origin main", loadRuntimeGuardrailsConfig(harness.home));
		assert.equal(evaluation.action, "allow");
		// A brand-new session with the same command runs without any dialog.
		assert.equal(await harness.run("git push origin main", { id: "m8" }), undefined);
		assert.equal(harness.selectCalls.length, 1);
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("saveGuardedCommandAllowAlways refuses to rewrite a malformed config", () => {
	const home = mkdtempSync(join(tmpdir(), "permission-allowlist-malformed-"));
	try {
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "runtime-guardrails.json"), "{ not json");
		assert.equal(saveGuardedCommandAllowAlways("gitPush", { gentlePiConfigHome: home }), false);
		assert.equal(readFileSync(join(home, "runtime-guardrails.json"), "utf8"), "{ not json");
	} finally { rmSync(home, { recursive: true, force: true }); }
});

test("host without ui.select keeps the plain confirm dialog", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		const manager = { id: "m9" };
		const ctx = harness.ctx(manager) as { ui: Record<string, unknown> };
		delete ctx.ui.select;
		harness.pendingSelection = "Allow once";
		const result = await confirmCommand("git push origin main", ctx, harness.events, harness.lifecycle);
		assert.equal(result, undefined);
		assert.equal(harness.confirmCalls.length, 1);
		assert.equal(harness.selectCalls.length, 0);
		assert.deepEqual(harness.events.emitted.map(event => event.state), ["waiting", "approved"]);
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("normal mode keeps confirm default and honors explicit allow from user config", () => {
	const config = { autonomousMode: false, guardedCommands: {} };
	assert.equal(evaluateGuardedCommand("git push origin main", config).action, "confirm");
	assert.equal(evaluateGuardedCommand("git rebase main", config).action, "confirm");
	const allowConfig = { autonomousMode: false, guardedCommands: { gitPush: "allow" } };
	assert.equal(evaluateGuardedCommand("git push origin main", allowConfig).action, "allow");
	const confirmConfig = { autonomousMode: false, guardedCommands: { gitPush: "confirm" } };
	assert.equal(evaluateGuardedCommand("git push origin main", confirmConfig).action, "confirm");
});
