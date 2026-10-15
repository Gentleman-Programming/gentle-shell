import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChildSafetyExtension } from "../extensions/child-safety.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

type Handler = (event: { toolName: string; input: { command: string } }, ctx: ExtensionContext) => unknown;
function harness(child: boolean, primary = false) {
	const handlers: Handler[] = [];
	const events: Array<{ name: string; data: unknown }> = [];
	const pi = {
		on: (name: string, handler: Handler) => { if (name === "tool_call") handlers.push(handler); },
		events: { on() {}, emit: (name: string, data: unknown) => events.push({ name, data }) },
		registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
	} as unknown as ExtensionAPI;
	const env = { GENTLE_PI_AGENTS_CHILD: child ? "1" : "0" };
	if (primary) createGentleAiExtension({ processEnv: env, nativeReviewCli: null })(pi);
	else createChildSafetyExtension(env)(pi);
	return { handlers, events };
}
const context = (confirm: (title: string, preview: string) => Promise<boolean>, hasUI = true) => ({ cwd: process.cwd(), hasUI, ui: { confirm } }) as unknown as ExtensionContext;
const event = (command: string) => ({ toolName: "bash", input: { command } });

test("child-only safety is inert in primary auto-discovery", () => {
	assert.equal(harness(false).handlers.length, 0);
});

test("children block recognized data loss and destructive git even with UI", async () => {
	for (const primary of [false, true]) {
		const h = harness(true, primary);
		for (const command of [
			`psql -c 'DROP TABLE users'`, `mysql -e 'TRUNCATE TABLE users'`,
			`sqlite3 app.db 'DELETE FROM users'`, `echo ok && rm -rf ./data`,
			`find ./data -delete`, `sh -c 'git -C /repo reset --hard'`,
			`git restore .`, `git branch -D old`, `git push -f`, `git clean -fd`,
			`git rebase main`, `git checkout -- .`, `git stash clear`,
		]) {
			const result = await h.handlers[0](event(command), context(async () => { throw new Error("child must never prompt"); }));
			assert.equal((result as { block?: boolean })?.block, true, command);
		}
		assert.equal(await h.handlers[0](event("pnpm test"), context(async () => false, false)), undefined);
	}
});

test("headless children reject corrected literal forms without prompting", async () => {
	for (const primary of [false, true]) {
		const h = harness(true, primary);
		const ctx = context(async () => { throw new Error("headless child must never prompt"); }, false);
		for (const command of [
			`git push ';' -f main`, `rm -r ';' /`,
			String.raw`sh -c "psql -c \"DROP TABLE users\""`,
			`psql -c 'DELETE FROM "where"'`,
			String.raw`find cache -exec echo {} \; -exec rm -r {} \;`,
			`sudo -n rm -r ./data`, `command -p psql -c 'DROP TABLE users'`,
		]) {
			assert.equal((await h.handlers[0](event(command), ctx) as { block?: boolean })?.block, true, command);
		}
		assert.equal(await h.handlers[0](event(`printf '%s ' ';' rm -r ./data`), ctx), undefined);
	}
});

test("primary requires fresh confirmation, cancellation and missing UI block", async () => {
	const h = harness(false, true);
	const command = `psql -c 'DROP TABLE users'`;
	let prompts = 0;
	const ctx = context(async (title, preview) => {
		assert.equal(title, "Allow recognized data-loss command?");
		assert.match(preview, /DROP TABLE users/);
		prompts++;
		return true;
	});
	assert.equal(await h.handlers[0](event(command), ctx), undefined);
	assert.equal(await h.handlers[0](event(command), ctx), undefined);
	assert.equal(prompts, 2, "approval is never cached");
	assert.equal((await h.handlers[0](event(command), context(async () => false)) as { block: boolean }).block, true);
	assert.equal((await h.handlers[0](event(command), context(async () => { throw new Error("no UI"); }, false)) as { block: boolean }).block, true);
	await assert.rejects(async () => h.handlers[0](event(command), context(async () => { throw new Error("cancelled dialog"); })), /cancelled dialog/);
	const states = h.events.filter((entry) => entry.name === "pi-permission-system:permission-request").map((entry) => (entry.data as { state: string }).state);
	assert.deepEqual(states, ["waiting", "approved", "waiting", "approved", "waiting", "denied", "waiting", "denied"]);
	const blockers = h.events.filter((entry) => entry.name === "herdr:blocked").map((entry) => (entry.data as { active: boolean }).active);
	assert.deepEqual(blockers, [true, false, true, false, true, false, true, false]);
});

test("children block recognized destructive commands sent to bash_background too", async () => {
	const h = harness(true);
	const result = await h.handlers[0]({ toolName: "bash_background", input: { command: "echo ok && rm -rf ./data" } }, context(async () => { throw new Error("child must never prompt"); }));
	assert.equal((result as { block?: boolean })?.block, true);
});

test("children block recognized destructive commands sent to monitor too", async () => {
	const h = harness(true);
	const result = await h.handlers[0]({ toolName: "monitor", input: { command: "echo ok && rm -rf ./data" } }, context(async () => { throw new Error("child must never prompt"); }));
	assert.equal((result as { block?: boolean })?.block, true);
});
