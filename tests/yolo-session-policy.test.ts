import assert from "node:assert/strict";
import test from "node:test";
import { YoloSessionPolicy, YOLO_DIRECTIVE, updateYoloPrompt, registerYoloSessionPolicy, discoverYoloUiAdapter } from "../lib/yolo-session-policy.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewSessionIdentity } from "../lib/review-session-standing-permission.ts";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLEET_ROLE_ENV } from "../lib/fleet-role.ts";
import { writePermissionModePolicy } from "../lib/permission-mode-policy.ts";

function identity(): ReviewSessionIdentity {
	return { sessionManager: { getSessionId: () => "live" }, sessionId: "live", repositoryIdentity: "clone-a", worktreeRoot: "/repo" };
}

test("YOLO defaults off; explicit activation is exact-live-session and clone bound", () => {
	const policy = new YoloSessionPolicy();
	const live = identity();
	assert.equal(policy.active(live), false);
	assert.equal(policy.set(true, live), true);
	assert.equal(policy.active({ ...live, worktreeRoot: "/sibling" }), true);
	assert.equal(policy.active({ ...live, repositoryIdentity: "clone-b" }), false);
	assert.equal(policy.active(live), false, "scope loss revokes, not merely hides");
	for (const other of [undefined, { ...live, sessionId: "resumed" }, identity()]) {
		policy.set(true, live);
		assert.equal(policy.active(other), false);
	}
	assert.equal(policy.set(true, undefined), false);
});

test("off/reset/restart revoke and invalidate pending activation", () => {
	const policy = new YoloSessionPolicy();
	const live = identity();
	const epoch = policy.epoch;
	policy.reset();
	assert.equal(policy.set(true, live, epoch), false);
	policy.set(true, live);
	policy.set(false, live);
	assert.equal(policy.active(live), false);
	policy.set(true, live);
	policy.reset();
	assert.equal(policy.active(live), false);
	assert.equal(new YoloSessionPolicy().active(live), false);
});

test("legacy hosts without an event bus retain command registration but no menu adapter", async () => {
	const commands: string[] = [];
	const pi = { registerCommand: (name: string) => commands.push(name) } as unknown as ExtensionAPI;
	assert.ok(registerYoloSessionPolicy(pi, {}));
	assert.deepEqual(commands, ["gentle:mode", "gentle:yolo"], "bare commands are not registered");
	assert.equal(await discoverYoloUiAdapter(pi, {} as ExtensionContext), undefined);
});

test("active-only structured directive qualifies defaults and is removed from reused options", () => {
	const options = { appendSystemPrompt: "existing harness" };
	updateYoloPrompt(options, true);
	updateYoloPrompt(options, true);
	assert.equal(options.appendSystemPrompt.split(YOLO_DIRECTIVE).length, 2);
	assert.match(YOLO_DIRECTIVE, /default.*commit.*push.*PR/i);
	assert.match(YOLO_DIRECTIVE, /ask_user/);
	assert.match(YOLO_DIRECTIVE, /credentials/);
	updateYoloPrompt(options, false);
	assert.equal(options.appendSystemPrompt, "existing harness");
});

// odd/tasks/fleet-orchestrator.md T3 (Risk item 2): a fleet member is a primary
// session but never inherits the human's saved elevated default; its dialogs
// reach the fleet controller instead. Scratch is reported, not removed.
const fleetScratch = realpathSync(mkdtempSync(join(tmpdir(), "yolo-fleet-member-")));

function savedDefaultHarness(role: string | undefined, mode: "super-yolo" | "yolo" | "auto") {
	const home = join(fleetScratch, `${role ?? "normal"}-${mode}`);
	writePermissionModePolicy(mode, { gentlePiConfigHome: home });
	const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const pi = { registerCommand: (name: string, command: never) => commands.set(name, command), events: { on: () => () => {} } } as unknown as ExtensionAPI;
	const env = { GENTLE_PI_CONFIG_HOME: home, ...(role ? { [FLEET_ROLE_ENV]: role } : {}) };
	const controller = registerYoloSessionPolicy(pi, env, { resolveIdentity: async () => undefined });
	const notices: string[] = [];
	const context = (mode: string) => ({
		cwd: fleetScratch, mode, hasUI: true,
		sessionManager: { getSessionId: () => `${role}-${mode}` },
		ui: { notify: (message: string) => notices.push(message), setStatus() {}, setWidget() {}, select: async () => "enable" },
	}) as unknown as ExtensionContext;
	return { controller, commands, notices, context };
}

test("a fleet member always resolves NORMAL whatever elevated default the human saved", async () => {
	for (const mode of ["super-yolo", "yolo", "auto"] as const) {
		const h = savedDefaultHarness("member", mode);
		for (const uiMode of ["rpc", "tui"]) {
			const ctx = h.context(uiMode);
			assert.equal(await h.controller.mode(ctx, { toolCallId: "t1" }), "normal", `${mode} in ${uiMode}`);
			assert.equal(await h.controller.active(ctx), false);
			assert.equal(await h.controller.superActive(ctx), false);
		}
	}
});

test("a fleet member cannot raise its own permission mode, by API or command", async () => {
	const h = savedDefaultHarness("member", "yolo");
	const ctx = h.context("tui");
	assert.equal(await h.controller.setMode("super-yolo", ctx), false);
	assert.equal(await h.controller.saveDefault("super-yolo", ctx), false);
	await h.commands.get("gentle:mode")!.handler("super-yolo", ctx);
	await h.commands.get("gentle:yolo")!.handler("enable", ctx);
	assert.equal(await h.controller.mode(ctx), "normal");
	assert.ok(h.notices.length >= 3 && h.notices.every(notice => /Fleet members always run with NORMAL permissions/.test(notice)), h.notices.join("\n"));
});

test("a normal session and the fleet controller still start in the saved default", async () => {
	for (const role of [undefined, "controller"]) {
		const h = savedDefaultHarness(role, "super-yolo");
		assert.equal(await h.controller.mode(h.context("tui")), "super-yolo", String(role));
	}
});
