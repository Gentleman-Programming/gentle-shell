import assert from "node:assert/strict";
import test from "node:test";
import { YoloSessionPolicy, YOLO_DIRECTIVE, updateYoloPrompt, registerYoloSessionPolicy, discoverYoloUiAdapter } from "../lib/yolo-session-policy.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewSessionIdentity } from "../lib/review-session-standing-permission.ts";

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
	assert.deepEqual(commands, ["gentle:yolo"], "bare yolo command is not registered");
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
