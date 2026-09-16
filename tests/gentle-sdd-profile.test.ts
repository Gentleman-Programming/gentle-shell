import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import installGentleSddProfile, {
	GENTLE_SDD_PROFILE_COMMAND,
	GENTLE_SDD_PROFILE_DELETE_COMMAND,
	GENTLE_SDD_PROFILE_LIST_COMMAND,
	GENTLE_SDD_PROFILE_RENAME_COMMAND,
	GENTLE_SDD_PROFILE_SAVE_COMMAND,
	SDD_PROFILE_TOOL_DELETE,
	SDD_PROFILE_TOOL_LIST,
	SDD_PROFILE_TOOL_RENAME,
	SDD_PROFILE_TOOL_USE,
	sddProfileShortcut,
} from "../extensions/gentle-sdd-profile.ts";
import { SddProfileManager } from "../lib/sdd-profiles-manager.ts";

type Handler = (args: string, ctx: any) => Promise<string | void>;

interface Setup {
	handler: Handler;
	commands: Map<string, { handler: Handler }>;
	ctx: any;
	manager: SddProfileManager;
	notices: Array<{ message: string; level?: string }>;
	shortcuts: Map<string, { handler: (ctx: any) => Promise<unknown> }>;
	tools: Map<string, { execute: (...args: any[]) => Promise<any> }>;
	events: Map<string, (...args: any[]) => unknown>;
	pi: any;
}

function setup(env: NodeJS.ProcessEnv = {}): Setup {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gentle-sdd-profile-"));
	const cwd = path.join(root, "work");
	const globalDir = path.join(root, "global-profiles");
	fs.mkdirSync(cwd, { recursive: true });
	const notices: Setup["notices"] = [];
	const commands = new Map<string, { handler: Handler }>();
	const shortcuts: Setup["shortcuts"] = new Map();
	const tools: Setup["tools"] = new Map();
	const events: Setup["events"] = new Map();
	const pi: any = {
		registerCommand(name: string, registration: { handler: Handler }) {
			commands.set(name, registration);
		},
		registerShortcut(name: string, registration: { handler: (ctx: any) => Promise<unknown> }) {
			shortcuts.set(name, registration);
		},
		registerTool(definition: { name: string; execute: (...args: any[]) => Promise<any> }) {
			tools.set(definition.name, definition);
		},
		on(event: string, handler: (...args: any[]) => unknown) {
			events.set(event, handler);
		},
	};
	(installGentleSddProfile as (pi: unknown, env?: unknown) => void)(pi, env);
	assert.ok(commands.has(GENTLE_SDD_PROFILE_COMMAND), "command registered");
	const handler = commands.get(GENTLE_SDD_PROFILE_COMMAND)!.handler;
	const ctx = {
		cwd,
		globalDir,
		activeStatePath: path.join(globalDir, ".active"),
		globalSubagentsPath: path.join(root, "subagents.json"),
		sessionManager: { getCwd: () => cwd },
		ui: {
			notify: (message: string, level?: string) => {
				notices.push({ message, level });
			},
		},
	};
	const manager = new SddProfileManager({
		globalDir,
		projectDir: path.join(cwd, ".pi", "profiles"),
		projectSubagentsPath: path.join(cwd, ".pi", "subagents.json"),
		activeStatePath: path.join(globalDir, ".active"),
		globalSubagentsPath: path.join(root, "subagents.json"),
	});
	return { handler, ctx, manager, notices, shortcuts, tools, events, pi, commands };
}

function saveForTest(manager: SddProfileManager, name: string): void {
	manager.saveProfile(
		{ name, description: `${name} fixture`, model_profiles: {} },
		"global",
	);
}

test("list names profiles and marks the active one", async () => {
	const { handler, ctx, manager } = setup();
	saveForTest(manager, "alpha");
	saveForTest(manager, "beta");
	manager.activateProfile("alpha");

	const out = (await handler("list", ctx)) as string;
	assert.match(out, /alpha/);
	assert.match(out, /beta/);
	assert.match(out, /gentle-default/);
	assert.match(out, /\* alpha/);
	assert.doesNotMatch(out, /\* beta/);
});

test("use activates a profile and reports", async () => {
	const { handler, ctx, manager, notices } = setup();
	const out = (await handler("use gentle-economy", ctx)) as string;
	assert.match(out, /gentle-economy/);
	assert.equal(manager.getActiveProfileName(), "gentle-economy");
	assert.ok(notices.some((n) => n.message === out && n.level === "info"));
});

test("use of a missing profile reports not-found", async () => {
	const { handler, ctx, notices } = setup();
	const out = (await handler("use nope", ctx)) as string;
	assert.match(out, /not found/i);
	assert.ok(notices.some((n) => n.message === out && n.level === "error"));
});

test("save persists so loadProfile finds it", async () => {
	const { handler, ctx, manager } = setup();
	const out = (await handler("save snap snap description", ctx)) as string;
	assert.match(out, /snap/);
	const loaded = manager.loadProfile("snap");
	assert.ok(loaded, "saved profile loads back");
	assert.equal(loaded.description, "snap description");
});

test("rename moves the profile", async () => {
	const { handler, ctx, manager } = setup();
	saveForTest(manager, "old");
	const out = (await handler("rename old new", ctx)) as string;
	assert.match(out, /new/);
	assert.ok(manager.loadProfile("new"), "renamed profile loads");
	assert.equal(manager.loadProfile("old"), null);
});

test("delete of the active profile refuses", async () => {
	const { handler, ctx, manager } = setup();
	saveForTest(manager, "live");
	manager.activateProfile("live");
	const out = (await handler("delete live", ctx)) as string;
	assert.match(out, /active/i);
	assert.ok(manager.loadProfile("live"), "active profile kept");
});

test("delete of a missing profile reports not-found", async () => {
	const { handler, ctx, notices } = setup();
	const out = (await handler("delete ghost", ctx)) as string;
	assert.match(out, /not found/i);
	assert.ok(notices.some((n) => n.message === out && n.level === "warning"));
});

test("bare profile name activates it, unknown token prints usage", async () => {
	const { handler, ctx, manager } = setup();
	const activated = (await handler("gentle-economy", ctx)) as string;
	assert.match(activated, /gentle-economy/);
	assert.equal(manager.getActiveProfileName(), "gentle-economy");
	const usage = (await handler("frobnicate", ctx)) as string;
	assert.match(usage, /Usage:/);
});