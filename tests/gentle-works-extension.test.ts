import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerWorks } from "../extensions/gentle-works.ts";
import { createWork, listWorks, resolveWorkContext, updateWork } from "../lib/gentle-works.ts";

async function harness(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "works-ui-")));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	execFileSync("git", ["init", repo], { stdio: "pipe" });
	const context = await resolveWorkContext(repo, join(root, "home"));
	let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	registerWorks({ registerCommand(name, command) { assert.equal(name, "gentle:works"); handler = command.handler; } } as ExtensionAPI, async () => context);
	const notices: string[] = [], screens: string[] = [];
	const actions: string[][] = [], answers: (string | undefined)[] = [];
	let idle = true;
	let file: string | undefined = join(root, "current.jsonl");
	const ctx = {
		cwd: repo, mode: "tui", hasUI: true, isIdle: () => idle,
		sessionManager: { getSessionId: () => "current", getSessionFile: () => file },
		ui: {
			notify: (text: string) => notices.push(text),
			input: async () => answers.shift(), editor: async () => answers.shift(), select: async () => answers.shift(),
			custom: async (factory: any) => {
				let result: unknown;
				const view = factory({ requestRender() {}, terminal: { rows: 40 } }, undefined, undefined, (value: unknown) => result = value);
				screens.push(view.render(100).join("\n"));
				for (const key of actions.shift() ?? ["\x1b"]) view.handleInput(key);
				assert.notEqual(result, undefined, "script must finish custom screen");
				return result;
			},
		},
	} as unknown as ExtensionCommandContext;
	return { root, context, ctx, notices, screens, actions, answers, run: (args = "") => handler(args, ctx), setIdle: (v: boolean) => idle = v, unsaved: () => file = undefined };
}
const input = { title: "Existing", objective: "Full objective", summary: "old", status: "completed" as const };
const DOWN = "\x1b[B", ENTER = "\r", ESC = "\x1b";

test("S3,S5: help, invalid and non-TUI calls visibly explain without writes", async t => {
	const h = await harness(t);
	await h.run("help"); assert.match(h.notices.pop() ?? "", /create.*status.*summary.*link/is);
	await h.run("oops"); assert.match(h.notices.pop() ?? "", /Usage/);
	h.ctx.mode = "rpc"; await assert.rejects(h.run(), /requires TUI/);
	assert.deepEqual(await listWorks(h.context), { revision: 0, works: [] });
});
test("S1,S3: create explicitly links current session and captures canonical worktree", async t => {
	const h = await harness(t);
	h.actions.push([ENTER], [ESC]); h.answers.push("New work", "Objective");
	await h.run();
	const { works, revision } = await listWorks(h.context);
	assert.equal(revision, 1); assert.equal(works[0].title, "New work");
	assert.equal(works[0].objective, "Objective"); assert.equal(works[0].status, "pending");
	assert.equal(works[0].worktree, h.context.worktreeRoot);
	assert.equal(works[0].session?.id, "current"); assert.equal(works[0].session?.file, join(h.root, "current.jsonl"));
});
test("S3: cancel at every create/edit step preserves public revisions and bytes; invalid input too", async t => {
	const h = await harness(t); await createWork(h.context, input);
	const before = await listWorks(h.context), bytes = await readFile(h.context.registryFile, "utf8");
	for (const answers of [[undefined], ["Title", undefined], ["", "objective"], ["x".repeat(257), "objective"]]) {
		h.answers.push(...answers); h.actions.push([ENTER], [ESC]); await h.run(); h.answers.length = 0; h.actions.length = 0;
		assert.deepEqual(await listWorks(h.context), before);
	}
	for (const answers of [[undefined], ["blocked", undefined], ["blocked", "new", undefined]]) {
		h.answers.push(...answers); h.actions.push([DOWN, ENTER], ["e"], [ESC], [ESC]); await h.run(); h.answers.length = 0; h.actions.length = 0;
		assert.deepEqual(await listWorks(h.context), before);
	}
	assert.equal(await readFile(h.context.registryFile, "utf8"), bytes);
});
test("edit saves only the fields the user changed, so a concurrent change to another field survives", async t => {
	const h = await harness(t);
	const work = await createWork(h.context, input);
	h.ctx.ui.editor = (async (title: string, prefill?: string) => {
		if (title === "Explicit summary") await updateWork(h.context, work.id, { summary: "Changed elsewhere" });
		return prefill ?? "";
	}) as typeof h.ctx.ui.editor;
	h.actions.push([DOWN, ENTER], ["e"], [ESC], [ESC]); h.answers.push("blocked");
	await h.run();
	const saved = (await listWorks(h.context)).works[0];
	assert.equal(saved.status, "blocked"); assert.equal(saved.summary, "Changed elsewhere");
});
test("S3: saving an edit with no changes writes nothing and says so", async t => {
	const h = await harness(t);
	await createWork(h.context, { ...input, odd: "odd/tasks/kept.md" });
	const before = await listWorks(h.context), bytes = await readFile(h.context.registryFile, "utf8");
	h.actions.push([DOWN, ENTER], ["e"], [ESC], [ESC]); h.answers.push(input.status, input.summary, "");
	await h.run();
	assert.deepEqual(await listWorks(h.context), before);
	assert.equal(await readFile(h.context.registryFile, "utf8"), bytes);
	assert.ok(h.notices.includes("No changes to save"));
});
test("S2,S3,S5: inspect missing locations, explicitly edit/link; runtime activity never writes", async t => {
	const h = await harness(t);
	const work = await createWork(h.context, { ...input, worktree: join(h.root, "gone"), session: { id: "other", file: join(h.root, "absent") } });
	const before = await listWorks(h.context);
	h.actions.push([DOWN, ENTER], [ESC], [ESC]); await h.run();
	assert.match(h.screens.join("\n"), /unknown/); assert.match(h.screens.join("\n"), /missing/);
	assert.deepEqual(await listWorks(h.context), before);
	h.actions.push([DOWN, ENTER], ["e"], [ESC], [ESC]); h.answers.push("blocked", "Explicit summary", "odd/tasks/test.md"); await h.run();
	let saved = (await listWorks(h.context)).works[0];
	assert.equal(saved.status, "blocked"); assert.equal(saved.summary, "Explicit summary"); assert.equal(saved.odd, "odd/tasks/test.md"); assert.deepEqual(saved.session, work.session);
	h.actions.push([DOWN, ENTER], ["l"], [ESC], [ESC]); await h.run();
	saved = (await listWorks(h.context)).works[0]; assert.equal(saved.session?.id, "current");
	const linked = await listWorks(h.context);
	for (const idle of [true, false]) {
		h.setIdle(idle); h.actions.push([DOWN, ENTER], [ESC], [ESC]); await h.run();
		assert.match(h.screens.at(-2) ?? "", idle ? /waiting/ : /running/);
		assert.deepEqual(await listWorks(h.context), linked);
	}
});
test("S3,S5: unsaved session link fails visibly; creation omits locator with notice", async t => {
	const h = await harness(t); await createWork(h.context, input); h.unsaved();
	const before = await listWorks(h.context);
	h.actions.push([DOWN, ENTER], ["l"], [ESC], [ESC]); await h.run();
	assert.deepEqual(await listWorks(h.context), before); assert.match(h.notices.join("\n"), /not saved/);
	h.actions.push([ENTER], [ESC]); h.answers.push("Unsaved", "Objective"); await h.run();
	assert.equal((await listWorks(h.context)).works[1].session, undefined);
	assert.match(h.notices.join("\n"), /without.*session/i);
});
test("S4 boundary: corrupt registry is an error, never an empty list or overwritten", async t => {
	const h = await harness(t); await createWork(h.context, input);
	await writeFile(h.context.registryFile, "corrupt"); await h.run();
	assert.match(h.notices.join("\n"), /Invalid work registry/);
	assert.equal(await readFile(h.context.registryFile, "utf8"), "corrupt"); assert.equal(h.screens.length, 0);
});
