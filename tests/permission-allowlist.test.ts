import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

const { confirmCommand, evaluateGuardedCommand, loadRuntimeGuardrailsConfig, saveGuardedCommandAllowAlways } = __testing as {
	confirmCommand: (command: string, ctx: unknown, events: unknown, herdrLifecycle: unknown, yoloActive?: boolean, autoGate?: unknown, superActive?: boolean) => Promise<{ block: true; reason: string } | undefined>;
	evaluateGuardedCommand: (command: string, config: { autonomousMode: boolean; guardedCommands: Record<string, string>; guardedCommandVariants?: Record<string, string> }) => { action: string; dataLoss?: boolean; key?: string };
	loadRuntimeGuardrailsConfig: (cwd: string, options?: { gentlePiConfigHome?: string }) => { autonomousMode: boolean; guardedCommands: Record<string, string>; guardedCommandVariants?: Record<string, string> };
	saveGuardedCommandAllowAlways: (key: string, options?: { gentlePiConfigHome?: string }, variant?: string) => boolean;
};

interface StoredConfig {
	autonomousMode?: boolean;
	guardedCommands?: Record<string, string>;
	guardedCommandVariants?: Record<string, string>;
}

interface Harness {
	home: string;
	pendingSelection: string | undefined;
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

function readStoredConfig(home: string): StoredConfig {
	return JSON.parse(readFileSync(join(home, "runtime-guardrails.json"), "utf8")) as StoredConfig;
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

test("a session push approval covers different remote, branch and refspec operands", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		const manager = { id: "s1" };
		harness.selectWith("Allow for this session");
		assert.equal(await harness.run("git push origin main", manager), undefined);
		assert.equal(harness.selectCalls.length, 1);
		for (const command of ["git push origin feature-branch", "git push upstream main:release", "git push origin HEAD"]) {
			assert.equal(await harness.run(command, manager), undefined, command);
		}
		assert.equal(harness.selectCalls.length, 1, "varying push operands never reopen the dialog");
		harness.selectWith("Deny");
		assert.ok((await harness.run("git push origin feature-branch", { id: "s2" }))?.block);
		assert.equal(harness.selectCalls.length, 2, "a different session never inherits the grant");
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("a git -C push shares the plain variant across operands in one session", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		const original = "git -C /home/ricardo/Trabajo/IAI/gentle-companion push origin feat/upstream-v0.4.2-01-integration:refs/heads/feat/upstream-v0.4.2-01-integration";
		const changed = "git -C /home/ricardo/Trabajo/IAI/gentle-companion push origin feat/upstream-v0.4.2-02-next:refs/heads/feat/upstream-v0.4.2-02-next";
		const otherDirectory = "git -C /tmp/other-repo push origin main:release";
		const manager = { id: "wc1" };
		harness.selectWith("Allow for this session");
		assert.equal(await harness.run(original, manager), undefined);
		assert.equal(await harness.run(changed, manager), undefined, "a changed branch and refspec share the -C plain variant");
		assert.equal(await harness.run(otherDirectory, manager), undefined, "the -C directory is not part of the identity");
		assert.equal(harness.selectCalls.length, 1);
		harness.selectWith("Deny");
		assert.ok((await harness.run(changed, { id: "wc2" }))?.block);
		assert.equal(harness.selectCalls.length, 2, "another session does not inherit the grant");
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("a git -C plain Always persists and reloads in a new session", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		const original = "git -C /home/ricardo/Trabajo/IAI/gentle-companion push origin feat/upstream-v0.4.2-01-integration:refs/heads/feat/upstream-v0.4.2-01-integration";
		const changed = "git -C /home/ricardo/Trabajo/IAI/gentle-companion push origin feat/upstream-v0.4.2-02-next:refs/heads/feat/upstream-v0.4.2-02-next";
		harness.selectWith("Always allow git push");
		assert.equal(await harness.run(original, { id: "wp1" }), undefined);
		assert.deepEqual(readStoredConfig(harness.home).guardedCommandVariants, { "gitPush:plain": "allow" });
		assert.equal(loadRuntimeGuardrailsConfig(harness.home).guardedCommandVariants?.["gitPush:plain"], "allow");
		const next = { id: "wp2" };
		assert.equal(await harness.run(changed, next), undefined);
		harness.selectWith("Deny");
		assert.ok((await harness.run("git -C /home/ricardo/Trabajo/IAI/gentle-companion push --delete origin old", next))?.block);
		assert.ok((await harness.run("git -C /home/ricardo/Trabajo/IAI/gentle-companion push --mirror origin", next))?.block);
		assert.equal(harness.selectCalls.length, 3);
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("session push grants are isolated by delete, mirror and force variants", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		const manager = { id: "v1" };
		harness.selectWith("Allow for this session");
		assert.equal(await harness.run("git push origin main", manager), undefined);
		harness.selectWith("Allow for this session");
		assert.equal(await harness.run("git push --delete origin old", manager), undefined);
		assert.equal(await harness.run("git push origin next", manager), undefined, "plain stays covered by its own grant");
		assert.equal(await harness.run("git push -d origin older", manager), undefined, "-d shares the delete variant");
		assert.equal(harness.selectCalls.length, 2);
		harness.selectWith("Allow for this session");
		assert.equal(await harness.run("git push --mirror origin", manager), undefined);
		assert.equal(harness.selectCalls.length, 3);
		harness.selectWith("Deny");
		assert.equal(await harness.run("git push origin main", manager), undefined, "plain is still granted");
		assert.ok((await harness.run("git push origin +main", manager))?.block, "a force refspec does not inherit plain");
		assert.equal(harness.selectCalls.length, 4);
		// Reverse direction: delete never grants plain.
		const reverse = { id: "v2" };
		harness.selectWith("Allow for this session");
		assert.equal(await harness.run("git push --delete origin gone", reverse), undefined);
		harness.selectWith("Allow for this session");
		assert.equal(await harness.run("git push origin main", reverse), undefined);
		assert.equal(harness.selectCalls.length, 6);
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("always allow persists a plain push variant and reloads in a new session", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		harness.selectWith("Always allow git push");
		assert.equal(await harness.run("git push origin main", { id: "p1" }), undefined);
		const saved = readStoredConfig(harness.home);
		assert.equal(saved.guardedCommandVariants?.["gitPush:plain"], "allow");
		assert.equal(saved.guardedCommands?.gitPush, undefined, "a variant decision never writes the broad key");
		const reloaded = loadRuntimeGuardrailsConfig(harness.home);
		assert.equal(evaluateGuardedCommand("git push origin any-branch", reloaded).action, "allow");
		assert.equal(evaluateGuardedCommand("git push --delete origin gone", reloaded).action, "confirm");
		assert.equal(evaluateGuardedCommand("git push --mirror origin", reloaded).action, "confirm");
		// New session after the persistent decision: same variant runs, others ask.
		const next = { id: "p2" };
		assert.equal(await harness.run("git push origin feature-x", next), undefined);
		assert.equal(harness.selectCalls.length, 1);
		harness.selectWith("Deny");
		assert.ok((await harness.run("git push --delete origin old", next))?.block);
		assert.ok((await harness.run("git push --mirror origin", next))?.block);
		assert.equal(harness.selectCalls.length, 3);
		// A compound command does not inherit the persistent plain grant and offers no Always.
		assert.ok((await harness.run("git push origin main && echo ok", next))?.block);
		assert.deepEqual(harness.selectCalls[3].choices, ["Allow once", "Allow for this session", "Deny"]);
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("always allow --delete persists only the delete variant", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		harness.selectWith("Always allow git push --delete");
		assert.equal(await harness.run("git push --delete origin old", { id: "d1" }), undefined);
		const saved = readStoredConfig(harness.home);
		assert.equal(saved.guardedCommandVariants?.["gitPush:--delete"], "allow");
		assert.equal(saved.guardedCommandVariants?.["gitPush:plain"], undefined);
		const next = { id: "d2" };
		assert.equal(await harness.run("git push -d origin older", next), undefined);
		assert.equal(harness.selectCalls.length, 1);
		harness.selectWith("Deny");
		assert.ok((await harness.run("git push origin main", next))?.block);
		assert.ok((await harness.run("git push --mirror origin", next))?.block);
		assert.equal(harness.selectCalls.length, 3);
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("force variants stay hard-blocked and plain grants never cover a force refspec", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		const manager = { id: "f1" };
		for (const command of ["git push -f origin main", "git push --force origin main", "git push --force-with-lease origin main", "git push -uf origin main", "git -C /tmp/repo push -f origin main"]) {
			const result = await harness.run(command, manager);
			assert.ok(result?.block, command);
			assert.match(result.reason, /blocked a destructive/);
		}
		assert.equal(harness.selectCalls.length, 0, "hard denies never open a dialog");
		harness.selectWith("Allow for this session");
		assert.equal(await harness.run("git push origin main", manager), undefined);
		harness.selectWith("Deny");
		assert.ok((await harness.run("git push origin +main", manager))?.block, "force refspec is its own variant");
		assert.equal(harness.selectCalls.length, 2);
		assert.ok((await harness.run("git push -f origin main", manager))?.block);
		assert.equal(harness.selectCalls.length, 2, "plain or force-refspec approval never enables -f");
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("compounds never inherit a simple push grant", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		const manager = { id: "c1" };
		harness.selectWith("Allow for this session");
		assert.equal(await harness.run("git push origin main && echo ok", manager), undefined);
		assert.deepEqual(harness.selectCalls[0].choices, ["Allow once", "Allow for this session", "Deny"], "a compound push offers no Always scope");
		assert.equal(await harness.run("git push origin main && echo ok", manager), undefined);
		assert.equal(harness.selectCalls.length, 1, "the exact compound may be remembered");
		harness.selectWith("Deny");
		assert.ok((await harness.run("git push origin main", manager))?.block, "the compound grant never covers a lone push");
		assert.equal(harness.selectCalls.length, 2);
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
		assert.equal(await harness.run("rm -rf data", manager), undefined);
		assert.equal(harness.selectCalls.length, 1);
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("always allow for a non-push guard keeps its broad persisted key", async () => {
	const harness = makeHarness();
	harness.setConfigHome();
	try {
		harness.selectWith("Always allow npm publish");
		assert.equal(await harness.run("npm publish --tag beta", { id: "n1" }), undefined);
		const saved = readStoredConfig(harness.home);
		assert.equal(saved.guardedCommands?.npmPublish, "allow");
		assert.equal(saved.guardedCommandVariants, undefined);
		assert.equal(await harness.run("npm publish", { id: "n2" }), undefined);
		assert.equal(harness.selectCalls.length, 1);
	} finally { harness.restoreConfigHome(); rmSync(harness.home, { recursive: true, force: true }); }
});

test("invalid variant config entries are ignored", () => {
	const home = mkdtempSync(join(tmpdir(), "permission-allowlist-invalid-"));
	try {
		writeFileSync(join(home, "runtime-guardrails.json"), JSON.stringify({
			autonomousMode: false,
			guardedCommands: {},
			guardedCommandVariants: {
				"gitPush:plain": "yes",
				"gitPush:--tags": "allow",
				"gitPush:--delete": "allow",
				"gitPush:--mirror": "block",
				"gitPush:--force": "confirm",
			},
		}));
		const config = loadRuntimeGuardrailsConfig(home, { gentlePiConfigHome: home });
		assert.deepEqual(config.guardedCommandVariants, { "gitPush:--delete": "allow" }, "only allow entries are honored");
		assert.equal(evaluateGuardedCommand("git push origin main", config).action, "confirm");
		assert.equal(evaluateGuardedCommand("git push --delete origin old", config).action, "allow");
		assert.equal(evaluateGuardedCommand("git push --mirror origin", config).action, "confirm");
		assert.equal(evaluateGuardedCommand("git push origin +main", config).action, "confirm");
	} finally { rmSync(home, { recursive: true, force: true }); }
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
	assert.equal(evaluateGuardedCommand("git push --delete origin old", allowConfig).action, "allow", "an existing broad allow keeps its historical meaning");
	assert.equal(evaluateGuardedCommand("git push --mirror origin", allowConfig).action, "allow");
	const confirmConfig = { autonomousMode: false, guardedCommands: { gitPush: "confirm" } };
	assert.equal(evaluateGuardedCommand("git push origin main", confirmConfig).action, "confirm");
});
