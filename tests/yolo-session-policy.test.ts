import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YoloSessionPolicy, YOLO_DIRECTIVE, YOLO_STATUS_TEXT, SUPER_YOLO_STATUS_TEXT, AUTO_MODE_NOTICE, updateYoloPrompt, registerYoloSessionPolicy, discoverYoloUiAdapter } from "../lib/yolo-session-policy.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewSessionIdentity } from "../lib/review-session-standing-permission.ts";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

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

const MODE_CHOICES = [
	"normal — standard permission prompts",
	"auto — independent checks; extra model calls",
	"yolo — scoped work; destructive actions ask",
	"super-yolo — no permission prompts; private paths blocked; consent remains",
];
const STALE = "YOLO unchanged — the session changed while the menu was open.";
const INVALID_SELECTION = "YOLO unchanged — invalid menu selection.";

type Selector = (title: string, choices: string[]) => Promise<string | undefined>;
function selectorHost(t: test.TestContext, env: NodeJS.ProcessEnv = {}) {
	const root = mkdtempSync(join(tmpdir(), "yolo-selector-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "config"), workspace = join(root, "workspace"), other = join(root, "other");
	for (const dir of [home, workspace, other]) mkdirSync(dir);
	const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const notices: Array<[string, string | undefined]> = [], prompts: Array<{ title: string; choices: string[] }> = [];
	const statuses = new Map<string, string | undefined>();
	let sessionId = "session", workspaceIdentity = "clone-a", changes = 0, confirms = 0;
	let select: Selector = async () => undefined;
	const context = {
		cwd: workspace, mode: "tui", hasUI: true,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: (message: string, type?: string) => notices.push([message, type]),
			setStatus: (key: string, value?: string) => statuses.set(key, value), setWidget() {},
			confirm: async () => { confirms++; return false; },
			select: async (title: string, choices: string[]) => { prompts.push({ title, choices }); return select(title, choices); },
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, command),
		events: { on() {}, emit() {} },
	} as unknown as ExtensionAPI;
	registerYoloSessionPolicy(pi, { ...env, GENTLE_PI_CONFIG_HOME: home }, {
		onChange: () => { changes++; }, resolveIdentity: async () => workspaceIdentity,
	});
	const files = () => Object.fromEntries(readdirSync(home).sort().map(name => [name, readFileSync(join(home, name), "utf8")]));
	return {
		context, notices, prompts, statuses, files, other,
		changes: () => changes, confirms: () => confirms,
		setSelect: (fn: Selector) => { select = fn; },
		setSession: () => { sessionId = "replacement"; },
		setIdentity: () => { workspaceIdentity = "clone-b"; },
		async run(name: "gentle:yolo" | "gentle:mode", args: string) {
			const command = commands.get(name); assert.ok(command, `${name} is registered`);
			assert.equal(await command.handler(args, context), undefined);
		},
	};
}

test("YOLO selector offers the four existing modes and applies only the selected live mode", async t => {
	const h = selectorHost(t);
	await h.run("gentle:mode", "status");
	await h.run("gentle:mode", "default auto");
	assert.deepEqual(h.notices.splice(0), [
		["Permissions: NORMAL — default: NORMAL", "info"],
		[`Default AUTO saved for next primary sessions. ${AUTO_MODE_NOTICE}`, "info"],
	]);
	const saved = h.files();
	let previous = "NORMAL";
	for (const [index, mode] of ["normal", "auto", "yolo", "super-yolo"].entries()) {
		const before = h.changes();
		h.setSelect(async (title, choices) => {
			assert.equal(title, `Permissions for this session (current: ${previous})`);
			assert.deepEqual(choices, MODE_CHOICES);
			assert.equal(h.changes(), before, "opening the selector grants nothing");
			assert.deepEqual(h.files(), saved);
			return choices[index];
		});
		await h.run("gentle:yolo", "");
		assert.equal(h.changes(), before + 2, "the canonical live-mode transition publishes revocation and selection");
		assert.deepEqual(h.notices.splice(0), mode === "auto"
			? [[AUTO_MODE_NOTICE, "info"], ["Permissions: AUTO", "info"]]
			: [[`Permissions: ${mode.toUpperCase()}`, "info"]]);
		assert.deepEqual(h.files(), saved, "a session selection never saves the default");
		await h.run("gentle:mode", "status");
		assert.deepEqual(h.notices.splice(0), [[`Permissions: ${mode.toUpperCase()} — default: AUTO`, "info"]]);
		previous = mode.toUpperCase();
	}
	assert.equal(h.prompts.length, 4);
	assert.equal(h.confirms(), 0);
});

test("YOLO selector opens and cancels without initializing authority, even with a saved default", async t => {
	for (const savedMode of ["normal", "yolo"]) {
		const h = selectorHost(t);
		if (savedMode === "yolo") await h.run("gentle:mode", "default yolo");
		h.setSession(); h.notices.length = 0;
		const before = h.changes(), saved = h.files();
		h.setSelect(async (title, choices) => {
			assert.equal(title, `Permissions for this session (current: ${savedMode.toUpperCase()})`);
			assert.deepEqual(choices, MODE_CHOICES);
			assert.equal(h.changes(), before, "opening does not initialize or grant a mode");
			return undefined;
		});
		await h.run("gentle:yolo", "");
		assert.equal(h.changes(), before);
		assert.deepEqual(h.files(), saved);
		assert.deepEqual(h.notices, []);
		await h.run("gentle:mode", "status");
		assert.deepEqual(h.notices.splice(0), [[`Permissions: ${savedMode.toUpperCase()} — default: ${savedMode.toUpperCase()}`, "info"]]);
		assert.equal(h.prompts.length, 1);
		assert.equal(h.confirms(), 0);
	}
});

test("YOLO selector waits for the human even in super-yolo; cancel and rejected answers do not change authority", async t => {
	const h = selectorHost(t);
	await h.run("gentle:mode", "super-yolo"); h.notices.length = 0;
	const before = h.changes(), saved = h.files();
	for (const answer of [undefined, "enable", "not an option"]) {
		h.setSelect(async (title, choices) => {
			assert.equal(title, "Permissions for this session (current: SUPER-YOLO)");
			assert.deepEqual(choices, MODE_CHOICES);
			assert.equal(h.changes(), before);
			return answer;
		});
		await h.run("gentle:yolo", "");
		assert.deepEqual(h.notices.splice(0), answer === undefined ? [] : [[INVALID_SELECTION, "warning"]]);
		assert.equal(h.changes(), before);
		assert.deepEqual(h.files(), saved);
		await h.run("gentle:yolo", "status");
		assert.deepEqual(h.notices.splice(0), [[SUPER_YOLO_STATUS_TEXT, "info"]]);
	}
	assert.equal(h.prompts.length, 3);
	assert.equal(h.confirms(), 0);
});

test("YOLO selector rejects a stale session, cwd, clone identity, or superseded mode action", async t => {
	for (const reason of ["session", "cwd", "identity", "superseded"]) {
		const h = selectorHost(t);
		await h.run("gentle:mode", "status"); h.notices.length = 0;
		let choose!: (value: string) => void, opened!: () => void;
		const ready = new Promise<void>(resolve => { opened = resolve; });
		h.setSelect(async () => { opened(); return new Promise<string>(resolve => { choose = resolve; }); });
		const pending = h.run("gentle:yolo", ""); await ready;
		if (reason === "session") h.setSession();
		if (reason === "cwd") h.context.cwd = h.other;
		if (reason === "identity") h.setIdentity();
		if (reason === "superseded") { await h.run("gentle:mode", "auto"); h.notices.length = 0; }
		const before = h.changes(), saved = h.files();
		choose(MODE_CHOICES[3]); await pending;
		assert.equal(h.changes(), before, `${reason}: stale choice cannot publish a transition`);
		assert.deepEqual(h.files(), saved, reason);
		assert.deepEqual(h.notices.splice(0), [[STALE, "warning"]], reason);
		await h.run("gentle:mode", "status");
		assert.deepEqual(h.notices.splice(0), [[`Permissions: ${reason === "superseded" ? "AUTO" : "NORMAL"} — default: NORMAL`, "info"]]);
		assert.equal(h.prompts.length, 1);
		assert.equal(h.confirms(), 0);
	}
});

test("YOLO selector does not prompt or upgrade headless, RPC, or child sessions", async t => {
	for (const variant of ["headless", "rpc", "child"]) {
		const h = selectorHost(t, variant === "child" ? { GENTLE_PI_AGENTS_CHILD: "1" } : {});
		if (variant === "headless") Object.assign(h.context, { hasUI: false, mode: "json" });
		if (variant === "rpc") Object.assign(h.context, { mode: "rpc" });
		await h.run("gentle:mode", "status"); h.notices.length = 0;
		const before = h.changes(), saved = h.files();
		h.setSelect(async () => MODE_CHOICES[3]);
		await h.run("gentle:yolo", "");
		assert.deepEqual(h.notices.splice(0), [["YOLO OFF", "info"]], variant);
		assert.equal(h.prompts.length, 0, variant);
		assert.equal(h.changes(), before, variant);
		assert.deepEqual(h.files(), saved, variant);
		assert.equal(h.confirms(), 0, variant);
	}
});

test("selector-selected super-yolo preserves the private-path gate and human question boundary", async t => {
	const root = mkdtempSync(join(tmpdir(), "yolo-selector-guards-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "config"), workspace = join(root, "workspace");
	mkdirSync(home); mkdirSync(workspace);
	const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const notices: Array<[string, string | undefined]> = [];
	let selects = 0, confirms = 0, nativeCalls = 0;
	const native = new Proxy({}, { get: () => () => { nativeCalls++; throw new Error("native call forbidden in fixture"); } });
	const pi = {
		on(name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
		registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) { commands.set(name, command); },
		registerTool() {}, registerMessageRenderer() {}, registerFlag() {}, getActiveTools: () => [], events: { on() {}, emit() {} },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: workspace, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "guard-fixture" },
		ui: { notify: (message: string, type?: string) => notices.push([message, type]), setStatus() {}, setWidget() {},
			select: async (_title: string, choices: string[]) => { selects++; return choices[3]; },
			confirm: async () => { confirms++; return false; } },
	} as unknown as ExtensionContext;
	createGentleAiExtension({ nativeReviewCli: native as never, candidateViews: null, processEnv: { GENTLE_PI_CONFIG_HOME: home },
		resolveTelemetryTriggerBinary: () => { throw new Error("disabled in fixture"); } })(pi);
	const command = commands.get("gentle:yolo"); assert.ok(command);
	assert.equal(await command.handler("", ctx), undefined);
	assert.deepEqual(notices, [["Permissions: SUPER-YOLO", "info"]]);
	const emit = async (event: unknown) => {
		let result: unknown;
		for (const fn of handlers.get("tool_call") ?? []) { const next = await fn(event, ctx); if (next !== undefined) result = next; }
		return result;
	};
	const deniedPath = "private-fixture/.env"; // A lexical input only; no file is created or read.
	assert.deepEqual(await emit({ toolName: "read", toolCallId: "read-1", input: { path: deniedPath } }), {
		block: true, reason: `Gentle AI safety policy blocked access to sensitive path: ${deniedPath}. Ask the user for an explicit safer plan.`,
	});
	const question = { toolName: "ask_user_choice", toolCallId: "question-1", input: { question: "Approve?", options: ["Yes", "No"] } };
	const original = structuredClone(question);
	assert.equal(await emit(question), undefined);
	assert.deepEqual(question, original);
	assert.equal(selects, 1); assert.equal(confirms, 0); assert.equal(nativeCalls, 0);
	assert.deepEqual(readdirSync(home), []);
});

test("legacy YOLO enable, disable and status remain explicit; super-yolo status is truthful", async t => {
	const h = selectorHost(t);
	await h.run("gentle:yolo", "status");
	await h.run("gentle:yolo", "enable");
	await h.run("gentle:yolo", "status");
	await h.run("gentle:yolo", "disable");
	await h.run("gentle:yolo", "status");
	assert.deepEqual(h.notices.splice(0), [
		["YOLO OFF", "info"], [YOLO_STATUS_TEXT, "info"], [YOLO_STATUS_TEXT, "info"],
		["YOLO OFF", "info"], ["YOLO OFF", "info"],
	]);
	await h.run("gentle:mode", "super-yolo"); h.notices.length = 0;
	const before = h.changes(), saved = h.files();
	await h.run("gentle:yolo", "status");
	assert.deepEqual(h.notices.splice(0), [[SUPER_YOLO_STATUS_TEXT, "info"]]);
	await h.run("gentle:yolo", "invalid");
	assert.deepEqual(h.notices.splice(0), [["Use /gentle:yolo enable|disable|status. State unchanged.", "warning"]]);
	assert.equal(h.changes(), before);
	assert.deepEqual(h.files(), saved);
	assert.equal(h.prompts.length, 0);
	assert.equal(h.confirms(), 0);
});

test("legacy mode and default commands retain their independent session and saved behavior", async t => {
	const h = selectorHost(t);
	for (const mode of ["normal", "auto", "yolo", "super-yolo"]) {
		await h.run("gentle:mode", mode);
		assert.deepEqual(h.notices.splice(0), mode === "auto"
			? [[AUTO_MODE_NOTICE, "info"], ["Permissions: AUTO", "info"]]
			: [[`Permissions: ${mode.toUpperCase()}`, "info"]]);
	}
	await h.run("gentle:mode", "default yolo");
	assert.deepEqual(h.notices.splice(0), [["Default YOLO saved for next primary sessions.", "info"]]);
	const saved = h.files(), before = h.changes();
	await h.run("gentle:mode", "status");
	assert.deepEqual(h.notices.splice(0), [["Permissions: SUPER-YOLO — default: YOLO", "info"]]);
	await h.run("gentle:mode", "bad-input");
	assert.deepEqual(h.notices.splice(0), [["Use /gentle:mode normal|auto|yolo|super-yolo|status or /gentle:mode default normal|auto|yolo|super-yolo. State unchanged.", "warning"]]);
	assert.deepEqual(h.files(), saved);
	assert.equal(h.changes(), before);
	assert.equal(h.prompts.length, 0);
	assert.equal(h.confirms(), 0);
});
