import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { captureReviewSessionIdentity, grantReviewSessionPermission, hasReviewSessionPermission, revokeReviewSessionPermission } from "../lib/review-session-standing-permission.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { YOLO_STATUS_TEXT, yoloBannerContent } from "../lib/yolo-session-policy.ts";
import { sidebarState } from "../lib/shell-sidebar.ts";

const ON_TEXT = "🚀 YOLO ON 🔥 — destructive confirmations remain";
const USAGE = "Use /gentle:yolo enable|disable|status. State unchanged.";
const STALE_MENU = "YOLO unchanged — the session changed while the menu was open.";
const MODE_CHOICES = [
	"normal — standard permission prompts",
	"auto — independent checks; extra model calls",
	"yolo — scoped work; destructive actions ask",
	"super-yolo — no permission prompts; private paths blocked; consent remains",
] as const;
const menuTitle = (state: "NORMAL" | "YOLO") => `Permissions for this session (current: ${state})`;

// An empty env would resolve the developer's real ~/.pi/gentle-ai and inherit its persisted mode default.
const isolatedConfigHomes: string[] = [];
process.once("exit", () => { for (const home of isolatedConfigHomes) rmSync(home, { recursive: true, force: true }); });
function isolatedConfigHome(): string {
	const home = mkdtempSync(join(tmpdir(), "yolo-config-"));
	isolatedConfigHomes.push(home);
	return home;
}

export function harness(overrides: NodeJS.ProcessEnv = {}) {
	const env: NodeJS.ProcessEnv = { GENTLE_PI_CONFIG_HOME: isolatedConfigHome(), ...overrides };
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const tools: string[] = [];
	const notices: string[] = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	let confirmations = 0;
	let sessionId = "yolo-test";
	const ctx = {
		cwd: process.cwd(), mode: "tui", hasUI: true,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: (text: string) => notices.push(text),
			setStatus: (key: string, text?: string) => statuses.set(key, text),
			setWidget: (key: string, value: unknown) => widgets.set(key, value),
			confirm: async () => { confirmations++; return false; },
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => {
			const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list);
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerMessageRenderer() {}, registerFlag() {},
		events: { emit() {}, on: () => () => {} },
		getActiveTools: () => [],
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, candidateViews: null, processEnv: env,
		resolveTelemetryTriggerBinary: () => { throw new Error("disabled in test"); },
	})(pi);
	return { ctx, commands, tools, notices, statuses, widgets, confirmations: () => confirmations,
		setSessionId: (id: string) => { sessionId = id; },
		command: async (args: string) => { const cmd = commands.get("gentle:yolo"); assert.ok(cmd, "/gentle:yolo registered"); await cmd.handler(args, ctx); },
		setSelect: (select: (title: string, options: string[]) => Promise<string | undefined>) => { Object.assign(ctx.ui, { select }); },
		emit: async (name: string, event: unknown) => {
			let result: unknown; for (const fn of handlers.get(name) ?? []) { const next = await fn(event, ctx); if (next !== undefined) result = next; } return result;
		},
	};
}

test("only /gentle:yolo is registered and the ON text carries the rocket and fire markers", () => {
	const h = harness();
	assert.equal(h.commands.has("yolo"), false, "bare yolo command is not registered");
	assert.ok(h.commands.has("gentle:yolo"));
	assert.equal(YOLO_STATUS_TEXT, ON_TEXT);
});

test("human command enable/disable/status/invalid and status/widget clearing", async () => {
	const h = harness();
	assert.equal(h.tools.some((name) => name.includes("yolo")), false);
	await h.command("status"); assert.match(h.notices.at(-1)!, /OFF/);
	await h.command("enable");
	assert.equal(h.statuses.get("gentle:yolo"), ON_TEXT);
	// The banner is a component: it paints the notice, and steps aside while
	// the IDE chrome's status bar already shows the permission mode.
	const banner = h.widgets.get("gentle:yolo") as (tui: unknown, theme: unknown) => { render(width: number): string[] };
	const tui = { terminal: { columns: 80, rows: 24 }, requestRender() {} };
	assert.match(banner(tui, {}).render(80).join("\n"), new RegExp(ON_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	sidebarState(tui as never).statusBarShowsMode = () => true;
	assert.deepEqual(banner(tui, {}).render(80), [], "no banner while the status bar shows the mode");
	assert.match(banner({ requestRender() {} }, {}).render(80).join("\n"), /YOLO ON/, "a host without terminal state keeps the banner");
	for (const invalid of ["invalid", "on", "off", "toggle"]) {
		await h.command(invalid);
		assert.equal(h.notices.at(-1), USAGE);
		assert.equal(h.statuses.get("gentle:yolo"), ON_TEXT, `${invalid} leaves state unchanged`);
	}
	await h.command("status"); assert.match(h.notices.at(-1)!, /ON/);
	await h.command("disable"); assert.equal(h.statuses.get("gentle:yolo"), undefined);
	assert.equal(h.widgets.get("gentle:yolo"), undefined);
	await h.command("status"); assert.match(h.notices.at(-1)!, /OFF/);
});

test("no argument without a select-capable UI reports status and never toggles", async () => {
	const h = harness();
	await h.command(""); assert.equal(h.notices.at(-1), "YOLO OFF");
	assert.equal(h.statuses.get("gentle:yolo"), undefined);
	await h.command("enable");
	await h.command(""); assert.equal(h.notices.at(-1), ON_TEXT);
	assert.equal(h.statuses.get("gentle:yolo"), ON_TEXT);
	let prompts = 0;
	h.setSelect(async () => { prompts++; return MODE_CHOICES[0]; });
	Object.assign(h.ctx, { hasUI: false });
	await h.command("");
	assert.equal(prompts, 0, "headless callers never see the menu");
	assert.match(h.notices.at(-1)!, /OFF/, "headless status reflects fail-closed scope, not a menu choice");
});

test("no-argument menu shows the live permission mode; only an explicit selection changes it", async () => {
	const h = harness();
	const prompts: Array<{ title: string; options: string[] }> = [];
	let answer: string | undefined;
	h.setSelect(async (title, options) => { prompts.push({ title, options }); return answer; });
	const notices = h.notices.length;
	await h.command("");
	assert.deepEqual(prompts.at(-1), { title: menuTitle("NORMAL"), options: MODE_CHOICES });
	assert.equal(h.notices.length, notices, "cancel does nothing");
	assert.equal(h.statuses.get("gentle:yolo"), undefined);
	answer = MODE_CHOICES[0]; await h.command("");
	assert.equal(h.notices.at(-1), "Permissions: NORMAL"); assert.equal(h.statuses.get("gentle:yolo"), undefined);
	answer = MODE_CHOICES[2]; await h.command("");
	assert.equal(h.statuses.get("gentle:yolo"), ON_TEXT); assert.equal(h.notices.at(-1), "Permissions: YOLO");
	answer = undefined; await h.command("");
	assert.equal(prompts.at(-1)!.title, menuTitle("YOLO"));
	assert.equal(h.statuses.get("gentle:yolo"), ON_TEXT, "cancel leaves ON unchanged");
	answer = MODE_CHOICES[0]; await h.command("");
	assert.equal(h.statuses.get("gentle:yolo"), undefined); assert.equal(h.notices.at(-1), "Permissions: NORMAL");
	const shown = prompts.length;
	await h.command("status"); await h.command("invalid");
	assert.equal(prompts.length, shown, "explicit arguments bypass the menu");
	assert.equal(h.notices.at(-1), USAGE);
});

test("revocation wins over an activation still awaiting Git identity", async () => {
	for (const reason of ["off", "reload", "new", "resume", "fork", "quit"]) {
		const h = harness();
		const pending = h.command("enable");
		if (reason === "off") await h.command("disable");
		else await h.emit("session_shutdown", { reason });
		await pending;
		await h.command("status"); assert.match(h.notices.at(-1)!, /OFF/);
		assert.equal(h.widgets.get("gentle:yolo"), undefined);
	}
});

test("child, headless, RPC and nonexistent workspace cannot activate", async () => {
	for (const variant of ["child", "headless", "rpc", "no-workspace"]) {
		const h = harness(variant === "child" ? { GENTLE_PI_AGENTS_CHILD: "1" } : {});
		if (variant === "headless") Object.assign(h.ctx, { hasUI: false });
		if (variant === "rpc") Object.assign(h.ctx, { mode: "rpc" });
		if (variant === "no-workspace") Object.assign(h.ctx, { cwd: "/nonexistent-gentle-workspace" });
		await h.command("enable"); assert.notEqual(h.statuses.get("gentle:yolo"), ON_TEXT);
		h.setSelect(async () => MODE_CHOICES[2]);
		await h.command(""); assert.notEqual(h.statuses.get("gentle:yolo"), ON_TEXT, `${variant} menu enable fails closed`);
	}
});

test("structured primary prompt gains and loses directive; named child does not inherit", async () => {
	const h = harness();
	const options = { appendSystemPrompt: "base" };
	const event = { systemPromptOptions: options, prompt: "task", systemPrompt: "base" };
	await h.command("enable"); await h.emit("before_agent_start", event);
	assert.match(options.appendSystemPrompt, /YOLO session standing permission/);
	await h.command("disable"); await h.emit("before_agent_start", event);
	assert.doesNotMatch(options.appendSystemPrompt, /YOLO session standing permission/);
	await h.command("enable");
	await h.emit("before_agent_start", { ...event, agent: { name: "worker" } });
	assert.doesNotMatch(options.appendSystemPrompt, /YOLO session standing permission/);
	assert.ok(await h.emit("tool_call", { toolName: "bash", input: { command: "git push origin main" } }), "named child has no push waiver");
});

test("prompt preparation captures permission mode once per primary turn and never for children", async t => {
	const original = fsPromises.realpath;
	let workspace: string | undefined, captures = 0;
	t.mock.method(fsPromises, "realpath", async (...args: Parameters<typeof original>) => {
		if (args[0] === workspace) captures++;
		return original(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	for (const mode of ["normal", "auto", "yolo", "super-yolo"] as const) {
		const h = harness();
		await h.commands.get("gentle:mode")!.handler(mode, h.ctx);
		workspace = h.ctx.cwd;
		const event = { prompt: "task", systemPromptOptions: { appendSystemPrompt: "base" } };
		for (let turn = 0; turn < 2; turn++) {
			captures = 0;
			await h.emit("before_agent_start", event);
			assert.equal(captures, 1, `${mode}: each primary turn captures once, without cross-turn reuse`);
			const prompt = event.systemPromptOptions.appendSystemPrompt;
			assert.equal(prompt.includes("<gentle-yolo-session>"), mode === "yolo");
			assert.equal(prompt.includes("<gentle-super-yolo-session>"), mode === "super-yolo");
			assert.equal(prompt.includes("<gentle-auto-permissions>"), mode === "auto");
		}
		captures = 0;
		await h.emit("tool_call", { toolName: "bash", toolCallId: `fresh-${mode}`, input: { command: "git status" } });
		assert.ok(captures > 0, "tool admission rechecks identity instead of using the prompt snapshot");
		captures = 0;
		await h.emit("before_agent_start", { ...event, agent: { name: "worker" } });
		assert.equal(captures, 0, "named children do not capture the primary permission mode");
		assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /<gentle-(?:(?:super-yolo|yolo)-session|auto-permissions)>/);
	}
	const child = harness({ GENTLE_PI_AGENTS_CHILD: "1" });
	captures = 0;
	await child.emit("before_agent_start", { prompt: "child task", systemPromptOptions: { appendSystemPrompt: "base" } });
	assert.equal(captures, 0, "child-process sessions do not capture the primary permission mode");
});

test("session loss and shutdown (including reload) revoke visible state", async () => {
	for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
		const h = harness(); await h.command("enable");
		const event = { prompt: "task", systemPromptOptions: { appendSystemPrompt: "base" } };
		await h.emit("before_agent_start", event);
		assert.match(event.systemPromptOptions.appendSystemPrompt, /YOLO session standing permission/);
		await h.emit("session_shutdown", { reason });
		assert.equal(h.widgets.get("gentle:yolo"), undefined);
		assert.equal(h.statuses.get("gentle:yolo"), undefined);
		await h.emit("before_agent_start", event);
		assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /YOLO session standing permission/);
		await h.command("status"); assert.match(h.notices.at(-1)!, /OFF/);
	}
	const h = harness(); await h.command("enable"); h.setSessionId("replacement");
	await h.command("status"); assert.match(h.notices.at(-1)!, /OFF/);
});

test("active YOLO waives only ordinary push after full destructive/guard evaluation", async () => {
	const h = harness();
	const call = (command: string) => h.emit("tool_call", { toolName: "bash", input: { command } });
	assert.deepEqual(await call("git push origin main"), { block: true, reason: "Gentle AI safety policy blocked the command because it was not confirmed." });
	await h.command("enable");
	assert.equal(await call("git push origin main"), undefined);
	assert.equal(h.confirmations(), 1);
	// gentle-shell#2172: reversible compound delivery is waived too.
	for (const command of ["git commit -m 'fix: x' && git push -u origin feature/x", "git push origin main && gh pr create --fill", "git -C /other push origin main", "git rebase origin/main && git push"]) {
		assert.equal(await call(command), undefined, command);
	}
	assert.equal(h.confirmations(), 1, "waived commands never reach the confirmation dialog");
	for (const command of ["git push origin main && rm -rf ./data", `sh -c "psql -c 'DROP TABLE users'"`, "git push origin main && git rebase -i main", "git push --force origin main", "git push origin main && npm publish", "git push origin :main", "sh -c 'git push origin main'"]) {
		assert.ok(await call(command), command);
	}
	await h.command("disable"); assert.ok(await call("git push origin main"));
});

test("active YOLO waives a push with harmless redirections and a read-only filter; Normal and children still ask", async () => {
	const command = "git push -u origin feat/x 2>&1 | tail -5";
	const call = (h: ReturnType<typeof harness>, input: string) => h.emit("tool_call", { toolName: "bash", input: { command: input } });
	const h = harness();
	assert.ok(await call(h, "git push origin main 2>&1"), "Normal mode still confirms");
	assert.equal(h.confirmations(), 1);
	await h.command("enable");
	assert.equal(await call(h, command), undefined);
	assert.equal(await call(h, "git push origin main 2>&1"), undefined);
	assert.equal(h.confirmations(), 1, "waived pushes never reach the confirmation dialog");
	for (const asks of ["git push origin main | sh", "git push origin main > out.txt", "git push origin main 2>&1 | tee out"]) {
		assert.ok(await call(h, asks), asks);
	}
	const child = harness({ GENTLE_PI_AGENTS_CHILD: "1" });
	await child.command("enable");
	assert.ok(await call(child, command), "children never receive the waiver");
});

test("active command path preserves configured push confirmations and blocks, including legacy env override", async () => {
	const configHome = mkdtempSync(join(tmpdir(), "gentle-yolo-config-"));
	const previousHome = process.env.GENTLE_PI_CONFIG_HOME;
	const previousAutonomy = process.env.GENTLE_PI_AUTONOMOUS_MODE;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	try {
		for (const envOverride of [undefined, "1"]) {
			if (envOverride === undefined) delete process.env.GENTLE_PI_AUTONOMOUS_MODE;
			else process.env.GENTLE_PI_AUTONOMOUS_MODE = envOverride;
			for (const action of ["confirm", "block"]) {
				writeFileSync(join(configHome, "runtime-guardrails.json"), JSON.stringify({ autonomousMode: false, guardedCommands: { gitPush: action } }));
				const h = harness(); await h.command("enable");
				assert.ok(await h.emit("tool_call", { toolName: "bash", input: { command: "git push origin main" } }));
				assert.equal(h.confirmations(), action === "confirm" ? 1 : 0);
			}
		}
	} finally {
		if (previousHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME; else process.env.GENTLE_PI_CONFIG_HOME = previousHome;
		if (previousAutonomy === undefined) delete process.env.GENTLE_PI_AUTONOMOUS_MODE; else process.env.GENTLE_PI_AUTONOMOUS_MODE = previousAutonomy;
		rmSync(configHome, { recursive: true, force: true });
	}
});

test("YOLO never grants or revokes separate review standing permission and never answers ask_user", async () => {
	const h = harness();
	const identity = await captureReviewSessionIdentity(h.ctx, {}); assert.ok(identity);
	assert.equal(hasReviewSessionPermission(identity), false);
	await h.command("enable"); assert.equal(hasReviewSessionPermission(identity), false);
	grantReviewSessionPermission(identity);
	await h.command("disable"); assert.equal(hasReviewSessionPermission(identity), true);
	await h.command("enable");
	const question = { toolName: "ask_user", input: { question: "Authorize recovery?", options: ["Approve", "Decline"] } };
	const original = structuredClone(question);
	assert.equal(await h.emit("tool_call", question), undefined);
	assert.deepEqual(question, original);
	assert.equal(h.confirmations(), 0);
	assert.equal(hasReviewSessionPermission(identity), true);
	revokeReviewSessionPermission(identity);
});

test("tool input and task text cannot activate; scope/UI loss removes instruction and widget", async () => {
	const h = harness();
	await h.emit("tool_call", { toolName: "bash", input: { command: "echo harmless", yolo: "on" } });
	const event = { prompt: "/gentle:yolo enable", systemPromptOptions: { appendSystemPrompt: "base" } };
	await h.emit("before_agent_start", event);
	assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /YOLO session standing permission/);
	await h.command("enable");
	Object.assign(h.ctx, { cwd: "/" });
	await h.emit("before_agent_start", event);
	assert.equal(h.widgets.get("gentle:yolo"), undefined);
	assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /YOLO session standing permission/);
	Object.assign(h.ctx, { cwd: process.cwd() });
	await h.command("status"); assert.match(h.notices.at(-1)!, /OFF/);
	await h.command("enable"); Object.assign(h.ctx, { hasUI: false });
	await h.emit("before_agent_start", event);
	assert.equal(h.statuses.get("gentle:yolo"), undefined);
});

test("a session replaced while the menu is open cannot receive the YOLO choice", async () => {
	const h = harness();
	h.setSelect(async () => { h.setSessionId("replacement-session"); return MODE_CHOICES[2]; });
	await h.command("");
	assert.equal(h.statuses.get("gentle:yolo"), undefined, "stale menu choice never activates the new session");
	assert.equal(h.notices.at(-1), STALE_MENU, "the discarded choice is reported, not silent");
	h.setSelect(async () => { h.setSessionId("another-session"); return MODE_CHOICES[0]; });
	await h.command("");
	assert.equal(h.notices.at(-1), STALE_MENU, "a stale Normal choice is reported too");
	await h.command("status");
	assert.equal(h.notices.at(-1), "YOLO OFF");
});

test("bash_background goes through the same command confirmation and YOLO waiver as bash", async () => {
	const h = harness();
	const call = (command: string) => h.emit("tool_call", { toolName: "bash_background", input: { command } });
	assert.deepEqual(await call("git push origin main"), { block: true, reason: "Gentle AI safety policy blocked the command because it was not confirmed." });
	await h.command("enable");
	assert.equal(await call("git push origin main"), undefined);
	assert.ok(await call("git push origin main && rm -rf ./data"), "YOLO never waives a destructive command");
});

test("monitor goes through the same command confirmation and YOLO waiver as bash", async () => {
	const h = harness();
	const call = (command: string) => h.emit("tool_call", { toolName: "monitor", input: { command, timeout_seconds: 60 } });
	assert.deepEqual(await call("git push origin main"), { block: true, reason: "Gentle AI safety policy blocked the command because it was not confirmed." });
	await h.command("enable");
	assert.equal(await call("git push origin main"), undefined);
	assert.ok(await call("git push origin main && rm -rf ./data"), "YOLO never waives a destructive command");
});

test("the YOLO banner stays a plain string widget outside the terminal UI, so RPC hosts still receive it", () => {
	assert.deepEqual(yoloBannerContent("rpc", ON_TEXT), [ON_TEXT], "RPC forwards only string widgets");
	assert.deepEqual(yoloBannerContent(undefined, ON_TEXT), [ON_TEXT]);
	assert.equal(typeof yoloBannerContent("tui", ON_TEXT), "function", "the terminal UI gets the component that can step aside");
});
