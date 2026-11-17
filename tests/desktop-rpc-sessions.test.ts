import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET } from "../lib/desktop-rpc.ts";
import {
	DESKTOP_SESSIONS_EVENTS,
	DESKTOP_SESSIONS_FIRST_MESSAGE_MAX,
	DESKTOP_SESSIONS_METHODS,
	INVALID_SESSIONS_PARAMS,
	SESSION_NOT_FOUND,
	SESSION_SWITCHING,
	projectDesktopSession,
	SESSIONS_UNAVAILABLE,
	parseListSessionsParams,
	parseSwitchSessionParams,
	sessionProjectName,
} from "../lib/desktop-rpc-sessions.ts";
import { DesktopSessionsBridge } from "../lib/desktop-sessions-service.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

type WidgetCall = { key: string; lines: string[] };

// ---- Fixtures: real Pi session files in an isolated root ----

interface SeedSession {
	id: string;
	cwd: string;
	/** Header timestamp; message timestamps follow it by one second each. */
	at: number;
	messages?: Array<{ role: "user" | "assistant"; text: string }>;
	name?: string;
}

/** Write one session file in Pi's own on-disk shape (header, optional name, messages). */
function writeSession(dir: string, seed: SeedSession): string {
	mkdirSync(dir, { recursive: true });
	const stamp = new Date(seed.at).toISOString();
	const lines: unknown[] = [{ type: "session", version: 3, id: seed.id, timestamp: stamp, cwd: seed.cwd }];
	let parentId: string | null = null;
	(seed.messages ?? []).forEach((message, index) => {
		const id = `${seed.id}-m${index}`;
		const at = seed.at + (index + 1) * 1000;
		lines.push({
			type: "message",
			id,
			parentId,
			timestamp: new Date(at).toISOString(),
			message: { role: message.role, content: [{ type: "text", text: message.text }], timestamp: at },
		});
		parentId = id;
	});
	if (seed.name !== undefined) {
		lines.push({ type: "session_info", id: `${seed.id}-info`, parentId, timestamp: stamp, name: seed.name });
	}
	const file = join(dir, `${stamp.replace(/[:.]/g, "-")}_${seed.id}.jsonl`);
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

interface Root {
	root: string;
	projectCwd: string;
	otherCwd: string;
	customDir: string;
	agentDir: string;
}

function makeRoot(t: test.TestContext): Root {
	const root = mkdtempSync(join(tmpdir(), "desktop-rpc-sessions-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const projectCwd = join(root, "work", "gentle-shell");
	const otherCwd = join(root, "work", "other-app");
	mkdirSync(projectCwd, { recursive: true });
	mkdirSync(otherCwd, { recursive: true });
	return { root, projectCwd, otherCwd, customDir: join(root, "custom-sessions"), agentDir: join(root, "agent") };
}

function interactiveHost(t: test.TestContext): void {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
}

/** Point Pi's default agent directory (and so its default sessions root) at the isolated root. */
function isolatedAgentDir(t: test.TestContext, dir: string): void {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});
}

interface SessionLocation {
	cwd: string;
	sessionDir: string;
	usesDefault: boolean;
	currentId: string;
}

type SwitchBehavior = "replace" | "cancel" | "throw";

/**
 * Loads the real Desktop extension with a fake `pi`. The command context's
 * `sessionManager` exposes Pi's own session-location getters over real files,
 * so listing and lookup run through Pi's real `SessionManager`. `switchSession`
 * reproduces Pi's replacement order: the old instance gets `session_shutdown`,
 * the replacement gets `session_start`, then `withSession` runs with a fresh
 * command context bound to the new session.
 *
 * `holdSwitch` keeps the switch in flight (before teardown) until it resolves.
 * `newInstance` models Pi loading a fresh extension instance for the
 * replacement: this instance is shut down and never restarted.
 */
function harness(t: test.TestContext, location: SessionLocation, options: { switchBehavior?: SwitchBehavior; withSwitch?: boolean; withSessionManager?: boolean; holdSwitch?: Promise<void>; newInstance?: boolean } = {}) {
	interactiveHost(t);
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const events = new Map<string, Array<(event: unknown, ctx: any) => void>>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { events.set(name, [...(events.get(name) ?? []), handler]); },
		events: { emit() {}, on() { return () => {}; } },
	};
	desktopRpc(pi as any);
	const widgets: WidgetCall[] = [];
	const switches: string[] = [];
	const state = { ...location };
	const fire = (name: string, ctx: unknown) => { for (const handler of events.get(name) ?? []) handler({}, ctx); };
	const makeCtx = (): any => {
		const ctx: any = {
			mode: "rpc",
			cwd: state.cwd,
			ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } },
		};
		if (options.withSessionManager !== false) {
			ctx.sessionManager = {
				getCwd: () => state.cwd,
				getSessionDir: () => state.sessionDir,
				usesDefaultSessionDir: () => state.usesDefault,
				getSessionId: () => state.currentId,
			};
		}
		if (options.withSwitch !== false) {
			ctx.switchSession = async (sessionPath: string, switchOptions?: { withSession?: (next: unknown) => Promise<void> }) => {
				switches.push(sessionPath);
				await options.holdSwitch;
				const behavior = options.switchBehavior ?? "replace";
				if (behavior === "cancel") return { cancelled: true };
				if (behavior === "throw") throw new Error(`Session cwd missing: ${sessionPath}`);
				fire("session_shutdown", ctx);
				state.currentId = sessionPath;
				const next = makeCtx();
				if (!options.newInstance) fire("session_start", next);
				await switchOptions?.withSession?.(next);
				return { cancelled: false };
			};
		}
		return ctx;
	};
	const ctx = makeCtx();
	return {
		ctx,
		widgets,
		switches,
		state,
		start() { fire("session_start", ctx); },
		async invoke(request: unknown, targetCtx: any = ctx) {
			const raw = typeof request === "string" ? request : JSON.stringify(request);
			await commands.get("gentle:desktop")!.handler(raw, targetCtx);
		},
		payloads(): any[] {
			return widgets.map((call) => {
				assert.equal(call.key, DESKTOP_RPC_WIDGET);
				assert.equal(call.lines.length, 1);
				return JSON.parse(call.lines[0]!);
			});
		},
	};
}

function request(requestId: string, method: string, params: Record<string, unknown> = {}) {
	return { schema: DESKTOP_RPC_SCHEMA, requestId, method, params };
}

function responseFor(payloads: any[], requestId: string): any {
	const matches = payloads.filter((payload) => payload.kind === "response" && payload.requestId === requestId);
	assert.equal(matches.length, 1, `exactly one response for ${requestId}`);
	return matches[0];
}

/** Three sessions for the project and one for another project, all in one custom directory. */
function seedCustom(root: Root) {
	const base = Date.UTC(2026, 10, 1);
	const oldest = writeSession(root.customDir, { id: "s-old", cwd: root.projectCwd, at: base, messages: [{ role: "user", text: "first question" }] });
	const middle = writeSession(root.customDir, {
		id: "s-mid",
		cwd: root.projectCwd,
		at: base + 60_000,
		name: "Release prep",
		messages: [{ role: "user", text: `secret-ish   long\n${"x".repeat(400)}` }, { role: "assistant", text: "assistant body text" }],
	});
	const newest = writeSession(root.customDir, { id: "s-new", cwd: root.projectCwd, at: base + 120_000, messages: [{ role: "user", text: "newest" }, { role: "assistant", text: "ok" }] });
	const foreign = writeSession(root.customDir, { id: "s-foreign", cwd: root.otherCwd, at: base + 180_000, messages: [{ role: "user", text: "other project" }] });
	return { oldest, middle, newest, foreign, base };
}

function customLocation(root: Root, currentId = "s-new"): SessionLocation {
	return { cwd: root.projectCwd, sessionDir: root.customDir, usesDefault: false, currentId };
}

function assertNoPrivateFields(value: unknown, root: Root): void {
	const text = JSON.stringify(value);
	assert.equal(text.includes(root.root), false, "no absolute path crosses the wire");
	assert.equal(text.includes(root.root.replace(/\\/g, "\\\\")), false, "no escaped absolute path crosses the wire");
	assert.equal(text.includes(".jsonl"), false, "no session file crosses the wire");
	assert.equal(text.includes("assistant body text"), false, "no full message text crosses the wire");
	for (const key of ["path", "cwd", "allMessagesText", "parentSessionPath", "created"]) {
		assert.equal(text.includes(`"${key}"`), false, `no ${key} field crosses the wire`);
	}
}

// ---- Contract ----

test("the sessions slice advertises two methods and no event", async (t) => {
	assert.deepEqual([...DESKTOP_SESSIONS_METHODS], ["list_sessions", "switch_session"]);
	assert.deepEqual([...DESKTOP_SESSIONS_EVENTS], []);
	const root = makeRoot(t);
	const app = harness(t, customLocation(root));
	app.start();
	await app.invoke(request("caps", "capabilities"));
	const caps = responseFor(app.payloads(), "caps");
	assert.equal(caps.ok, true);
	const at = caps.data.methods.indexOf("list_sessions");
	assert.notEqual(at, -1);
	assert.deepEqual(caps.data.methods.slice(at, at + 2), ["list_sessions", "switch_session"]);
	assert.equal(caps.data.events.includes("list_sessions"), false);
});

test("list params are optional scope, limit 1-50, and an opaque cursor; anything else is invalid_request", () => {
	assert.deepEqual(parseListSessionsParams({}), { scope: "project", limit: 20 });
	assert.deepEqual(parseListSessionsParams({ scope: "all", limit: 50 }), { scope: "all", limit: 50 });
	assert.deepEqual(parseListSessionsParams({ limit: 1 }), { scope: "project", limit: 1 });
	for (const bad of [
		{ scope: "global" },
		{ scope: 1 },
		{ limit: 0 },
		{ limit: 51 },
		{ limit: 1.5 },
		{ limit: "20" },
		{ cursor: "" },
		{ cursor: 3 },
		{ cursor: "not a cursor" },
		{ path: "/tmp/x.jsonl" },
		{ sessionDir: "/tmp" },
	]) {
		assert.deepEqual(parseListSessionsParams(bad as Record<string, unknown>), { error: INVALID_SESSIONS_PARAMS }, JSON.stringify(bad));
	}
});

test("switch params are exactly an id plus an optional scope; anything else is invalid_request", () => {
	assert.deepEqual(parseSwitchSessionParams({ id: "abc" }), { id: "abc", scope: "project" });
	assert.deepEqual(parseSwitchSessionParams({ id: "abc", scope: "all" }), { id: "abc", scope: "all" });
	for (const bad of [{}, { id: "" }, { id: 7 }, { id: "abc", extra: true }, { id: "abc", scope: "global" }, { sessionPath: "/tmp/a.jsonl" }, { id: "x".repeat(257) }]) {
		assert.deepEqual(parseSwitchSessionParams(bad as Record<string, unknown>), { error: INVALID_SESSIONS_PARAMS }, JSON.stringify(bad));
	}
});

test("the project display name is the last path segment, never a path", () => {
	assert.equal(sessionProjectName("/home/me/work/gentle-shell"), "gentle-shell");
	assert.equal(sessionProjectName("C:\\Users\\me\\dev\\gentle-shell\\"), "gentle-shell");
	assert.equal(sessionProjectName(""), "unknown");
	assert.equal(sessionProjectName("C:\\"), "unknown");
	assert.equal(sessionProjectName("/"), "unknown");
});

// ---- list_sessions ----

test("list_sessions returns the project's sessions newest first through Pi's own resolution, with only whitelisted fields", async (t) => {
	const root = makeRoot(t);
	const seeded = seedCustom(root);
	const app = harness(t, customLocation(root));
	app.start();

	await app.invoke(request("list-1", "list_sessions"));
	const payloads = app.payloads();
	const response = responseFor(payloads, "list-1");
	assert.equal(response.ok, true, JSON.stringify(response));
	// Project scope filters a custom directory by cwd exactly as Pi's /resume does.
	assert.deepEqual(response.data.sessions.map((session: any) => session.id), ["s-new", "s-mid", "s-old"]);
	assert.equal("nextCursor" in response.data, false);
	const [newest, middle, oldest] = response.data.sessions;
	assert.deepEqual(newest, {
		id: "s-new",
		modified: seeded.base + 120_000 + 2000,
		messageCount: 2,
		firstMessage: "newest",
		project: "gentle-shell",
		current: true,
	});
	assert.equal(middle.name, "Release prep");
	assert.equal(middle.current, false);
	assert.equal(middle.firstMessage.length <= DESKTOP_SESSIONS_FIRST_MESSAGE_MAX, true);
	assert.equal(middle.firstMessage.startsWith("secret-ish long x"), true, "whitespace is collapsed for display");
	assert.equal(middle.firstMessage.endsWith("…"), true, "a cut first message is marked");
	assert.deepEqual(Object.keys(oldest).sort(), ["current", "firstMessage", "id", "messageCount", "modified", "project"]);
	assertNoPrivateFields(payloads, root);
	assert.equal(payloads.some((payload) => payload.kind === "event"), false, "a read emits no event");
});

test("list_sessions scope all covers a custom session directory across projects", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	const app = harness(t, customLocation(root));
	app.start();

	await app.invoke(request("list-all", "list_sessions", { scope: "all" }));
	const response = responseFor(app.payloads(), "list-all");
	assert.equal(response.ok, true, JSON.stringify(response));
	assert.deepEqual(
		response.data.sessions.map((session: any) => [session.id, session.project]),
		[["s-foreign", "other-app"], ["s-new", "gentle-shell"], ["s-mid", "gentle-shell"], ["s-old", "gentle-shell"]],
	);
	assertNoPrivateFields(app.payloads(), root);
});

test("list_sessions with the default session directory reads Pi's per-project directory and its all-projects root", async (t) => {
	const root = makeRoot(t);
	isolatedAgentDir(t, root.agentDir);
	const base = Date.UTC(2026, 10, 2);
	// Pi's default layout: <agentDir>/sessions/--<encoded cwd>--/<file>.jsonl
	const encode = (cwd: string) => `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const projectDir = join(root.agentDir, "sessions", encode(root.projectCwd));
	writeSession(projectDir, { id: "d-project", cwd: root.projectCwd, at: base, messages: [{ role: "user", text: "here" }] });
	writeSession(join(root.agentDir, "sessions", encode(root.otherCwd)), { id: "d-other", cwd: root.otherCwd, at: base + 1000, messages: [{ role: "user", text: "there" }] });
	const app = harness(t, { cwd: root.projectCwd, sessionDir: projectDir, usesDefault: true, currentId: "d-project" });
	app.start();

	await app.invoke(request("list-project", "list_sessions"));
	await app.invoke(request("list-all", "list_sessions", { scope: "all" }));
	const project = responseFor(app.payloads(), "list-project");
	const all = responseFor(app.payloads(), "list-all");
	assert.deepEqual(project.data.sessions.map((session: any) => session.id), ["d-project"]);
	assert.deepEqual(all.data.sessions.map((session: any) => [session.id, session.project, session.current]), [["d-other", "other-app", false], ["d-project", "gentle-shell", true]]);
	assertNoPrivateFields(app.payloads(), root);
});

test("list_sessions pages with an opaque cursor and stops when the list is exhausted", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	const app = harness(t, customLocation(root));
	app.start();

	await app.invoke(request("page-1", "list_sessions", { scope: "all", limit: 2 }));
	const first = responseFor(app.payloads(), "page-1");
	assert.deepEqual(first.data.sessions.map((session: any) => session.id), ["s-foreign", "s-new"]);
	assert.equal(typeof first.data.nextCursor, "string");
	assertNoPrivateFields(first, root);

	await app.invoke(request("page-2", "list_sessions", { scope: "all", limit: 2, cursor: first.data.nextCursor }));
	const second = responseFor(app.payloads(), "page-2");
	assert.deepEqual(second.data.sessions.map((session: any) => session.id), ["s-mid", "s-old"]);
	assert.equal("nextCursor" in second.data, false, "the last page carries no cursor");

	await app.invoke(request("page-bad", "list_sessions", { cursor: "%%%" }));
	assert.deepEqual(responseFor(app.payloads(), "page-bad").error, INVALID_SESSIONS_PARAMS);
});

test("list_sessions rejects bad params before any owner work", async (t) => {
	const root = makeRoot(t);
	const app = harness(t, customLocation(root));
	app.start();
	await app.invoke(request("bad-limit", "list_sessions", { limit: 0 }));
	await app.invoke(request("bad-scope", "list_sessions", { scope: "everything" }));
	await app.invoke(request("bad-key", "list_sessions", { sessionDir: root.customDir }));
	for (const id of ["bad-limit", "bad-scope", "bad-key"]) {
		const response = responseFor(app.payloads(), id);
		assert.equal(response.ok, false);
		assert.deepEqual(response.error, INVALID_SESSIONS_PARAMS);
	}
	assertNoPrivateFields(app.payloads(), root);
});

test("an empty or missing session directory lists nothing rather than failing", async (t) => {
	const root = makeRoot(t);
	const app = harness(t, customLocation(root));
	app.start();
	await app.invoke(request("empty", "list_sessions"));
	assert.deepEqual(responseFor(app.payloads(), "empty").data, { sessions: [] });
});

test("sessions answer sessions_unavailable when no command context with a session manager is bound", async (t) => {
	const bridge = new DesktopSessionsBridge();
	assert.deepEqual(await bridge.handle("list_sessions", {}, "r-1"), { ok: false, error: SESSIONS_UNAVAILABLE });
	assert.deepEqual(await bridge.handle("switch_session", { id: "abc" }, "r-2"), { ok: false, error: SESSIONS_UNAVAILABLE });
	assert.equal(bridge.handle("list_jobs", {}, "r-3"), undefined, "other methods fall through");

	const root = makeRoot(t);
	const app = harness(t, customLocation(root), { withSessionManager: false });
	app.start();
	await app.invoke(request("no-manager", "list_sessions"));
	assert.deepEqual(responseFor(app.payloads(), "no-manager").error, SESSIONS_UNAVAILABLE);
});

test("a bridge reset drops a late list outcome", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const bridge = new DesktopSessionsBridge({
		owner: {
			list: async () => { await gate; return []; },
			listAll: async () => [],
			findById: () => undefined,
		},
	});
	bridge.attach({ cwd: root.projectCwd, sessionManager: { getCwd: () => root.projectCwd, getSessionDir: () => root.customDir, usesDefaultSessionDir: () => false, getSessionId: () => "s-new" } } as any);
	const pending = bridge.handle("list_sessions", {}, "late")!;
	bridge.reset();
	release();
	assert.deepEqual(await pending, { ok: false, error: SESSIONS_UNAVAILABLE });
});

// ---- switch_session ----

test("switch_session resolves the id through the owner, switches, and answers after the new session starts with a reset sequence", async (t) => {
	const root = makeRoot(t);
	const seeded = seedCustom(root);
	const app = harness(t, customLocation(root));
	app.start();

	await app.invoke(request("switch-1", "switch_session", { id: "s-old" }));
	assert.deepEqual(app.switches, [seeded.oldest], "Pi's switchSession receives the owner-resolved file");
	const payloads = app.payloads();
	const response = responseFor(payloads, "switch-1");
	assert.deepEqual(response, { schema: DESKTOP_RPC_SCHEMA, kind: "response", requestId: "switch-1", ok: true, data: { id: "s-old", changed: true } });
	assertNoPrivateFields(payloads, root);
	assert.equal(payloads.some((payload) => payload.kind === "event"), false, "a switch emits no Desktop event");

	// The replacement session's router answers with its own fresh sequence.
	await app.invoke(request("snapshot-after", "get_snapshot"));
	assert.equal(responseFor(app.payloads(), "snapshot-after").data.sequence, 0);
});

test("switching to the current session is a no-op that answers changed false", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	const app = harness(t, customLocation(root, "s-new"));
	app.start();
	await app.invoke(request("same", "switch_session", { id: "s-new" }));
	assert.deepEqual(responseFor(app.payloads(), "same").data, { id: "s-new", changed: false });
	assert.deepEqual(app.switches, [], "no switch happens");
	assert.equal(app.payloads().some((payload) => payload.kind === "event"), false);
});

test("switch_session answers not_found for an id outside the requested scope and switches across projects only with scope all", async (t) => {
	const root = makeRoot(t);
	const seeded = seedCustom(root);
	const app = harness(t, customLocation(root));
	app.start();

	await app.invoke(request("missing", "switch_session", { id: "no-such-session" }));
	await app.invoke(request("foreign-project", "switch_session", { id: "s-foreign" }));
	assert.deepEqual(responseFor(app.payloads(), "missing").error, SESSION_NOT_FOUND);
	assert.deepEqual(responseFor(app.payloads(), "foreign-project").error, SESSION_NOT_FOUND);
	assert.deepEqual(app.switches, [], "nothing was switched");

	await app.invoke(request("foreign-all", "switch_session", { id: "s-foreign", scope: "all" }));
	assert.deepEqual(responseFor(app.payloads(), "foreign-all").data, { id: "s-foreign", changed: true });
	assert.deepEqual(app.switches, [seeded.foreign]);
	assertNoPrivateFields(app.payloads(), root);
});

test("switch_session rejects bad params before any owner work", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	const app = harness(t, customLocation(root));
	app.start();
	await app.invoke(request("no-id", "switch_session", {}));
	await app.invoke(request("path-shaped", "switch_session", { sessionPath: join(root.customDir, "a.jsonl") }));
	await app.invoke(request("extra", "switch_session", { id: "s-old", force: true }));
	for (const id of ["no-id", "path-shaped", "extra"]) assert.deepEqual(responseFor(app.payloads(), id).error, INVALID_SESSIONS_PARAMS);
	assert.deepEqual(app.switches, []);
	assertNoPrivateFields(app.payloads(), root);
});

test("switch_session answers sessions_unavailable when the bound context cannot switch", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	const app = harness(t, customLocation(root), { withSwitch: false });
	app.start();
	await app.invoke(request("no-switch", "switch_session", { id: "s-old" }));
	assert.deepEqual(responseFor(app.payloads(), "no-switch").error, SESSIONS_UNAVAILABLE);
});

test("a switch cancelled by a session_before_switch handler answers changed false and cancelled", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	const app = harness(t, customLocation(root), { switchBehavior: "cancel" });
	app.start();
	await app.invoke(request("cancelled", "switch_session", { id: "s-old" }));
	assert.deepEqual(responseFor(app.payloads(), "cancelled").data, { id: "s-old", changed: false, cancelled: true });
	assert.equal(app.payloads().some((payload) => payload.kind === "event"), false);
});

test("a switch the runtime refuses answers sessions_unavailable without the raw error or path", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	const app = harness(t, customLocation(root), { switchBehavior: "throw" });
	app.start();
	await app.invoke(request("refused", "switch_session", { id: "s-old" }));
	const response = responseFor(app.payloads(), "refused");
	assert.equal(response.ok, false);
	assert.equal(response.error.code, SESSIONS_UNAVAILABLE.code);
	assertNoPrivateFields(app.payloads(), root);
});

// ---- Requests while a switch is in flight ----

test("while a switch is in flight every other request answers session_switching at once, and only the switch answers from the new session", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	let release!: () => void;
	const hold = new Promise<void>((resolve) => { release = resolve; });
	const app = harness(t, customLocation(root), { holdSwitch: hold });
	app.start();

	const switching = app.invoke(request("sw-2", "switch_session", { id: "s-old" }));
	// Dispatched while sw-2 waits for Pi: answered before the teardown, never queued.
	await app.invoke(request("sw-3", "switch_session", { id: "s-mid" }));
	await app.invoke(request("ls-4", "list_sessions"));
	await app.invoke(request("caps-5", "capabilities"));
	for (const id of ["sw-3", "ls-4", "caps-5"]) assert.deepEqual(responseFor(app.payloads(), id).error, SESSION_SWITCHING, id);
	assert.equal(app.payloads().some((payload) => payload.requestId === "sw-2"), false, "the switch has not answered yet");

	release();
	await switching;
	assert.deepEqual(responseFor(app.payloads(), "sw-2").data, { id: "s-old", changed: true });
	assert.equal(app.switches.length, 1, "the refused switch never reached Pi");
	for (const id of ["sw-2", "sw-3", "ls-4", "caps-5"]) responseFor(app.payloads(), id);

	// After the switch settles, requests are served again.
	await app.invoke(request("ls-6", "list_sessions"));
	assert.equal(responseFor(app.payloads(), "ls-6").ok, true);
});

test("a request still waiting on an owner when a switch tears the session down answers session_switching exactly once", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	const app = harness(t, customLocation(root));
	app.start();

	// `list_jobs` waits for jobs-owner discovery (no owner here), so it is still
	// pending when the switch dispatched right after it tears the session down.
	const jobs = app.invoke(request("jobs-1", "list_jobs"));
	const switching = app.invoke(request("sw-1", "switch_session", { id: "s-old" }));
	await Promise.all([jobs, switching]);
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.deepEqual(responseFor(app.payloads(), "jobs-1").error, SESSION_SWITCHING, "answered before the teardown, not dropped");
	assert.deepEqual(responseFor(app.payloads(), "sw-1").data, { id: "s-old", changed: true });
});

test("a cancelled or failed switch releases the gate", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	for (const behavior of ["cancel", "throw"] as const) {
		const app = harness(t, customLocation(root), { switchBehavior: behavior });
		app.start();
		await app.invoke(request(`sw-${behavior}`, "switch_session", { id: "s-old" }));
		await app.invoke(request(`ls-${behavior}`, "list_sessions"));
		assert.equal(responseFor(app.payloads(), `ls-${behavior}`).ok, true, behavior);
	}
});

test("a command Pi dispatches to the instance a switch replaced answers session_switching without touching its stale context", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	const app = harness(t, customLocation(root), { newInstance: true });
	app.start();
	await app.invoke(request("sw-1", "switch_session", { id: "s-old" }));
	assert.deepEqual(responseFor(app.payloads(), "sw-1").data, { id: "s-old", changed: true });

	// Pi invalidates a replaced instance's ctx: every access throws.
	const stale = new Proxy({}, { get() { throw new Error("This extension ctx is stale after session replacement"); } });
	await app.invoke(request("late-1", "list_sessions"), stale);
	await app.invoke("{not json", stale);
	assert.deepEqual(responseFor(app.payloads(), "late-1").error, SESSION_SWITCHING);
	const malformed = app.payloads().filter((payload) => payload.requestId === null);
	assert.equal(malformed.length, 1);
	assert.deepEqual(malformed[0].error, SESSION_SWITCHING);
});

// ---- Exposure, traversal and cursor regressions (from the independent verifier's probe) ----

test("ids shaped like paths, globs, or prefixes never resolve a session", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	const app = harness(t, customLocation(root));
	app.start();
	const ids = ["../custom-sessions/s-old", "s-old.jsonl", root.customDir, "*", "s", "s-ol"];
	for (const [index, id] of ids.entries()) {
		await app.invoke(request(`trav-${index}`, "switch_session", { id, scope: "all" }));
		assert.deepEqual(responseFor(app.payloads(), `trav-${index}`).error, SESSION_NOT_FOUND, id);
	}
	assert.deepEqual(app.switches, [], "nothing was switched");
	assertNoPrivateFields(app.payloads(), root);
});

test("another project's sessions expose only its display name and the whitelisted fields", async (t) => {
	const root = makeRoot(t);
	const secret = join(root.root, "home", "secret-proj");
	mkdirSync(secret, { recursive: true });
	writeSession(root.customDir, { id: "s-secret", cwd: secret, at: Date.UTC(2026, 10, 3), messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "assistant body text" }] });
	const app = harness(t, customLocation(root));
	app.start();
	await app.invoke(request("all", "list_sessions", { scope: "all" }));
	const [entry] = responseFor(app.payloads(), "all").data.sessions;
	assert.deepEqual(Object.keys(entry).sort(), ["current", "firstMessage", "id", "messageCount", "modified", "project"]);
	assert.equal(entry.project, "secret-proj");
	assertNoPrivateFields(app.payloads(), root);
});

test("forged cursors are either rejected or read as a plain keyset position", async (t) => {
	const root = makeRoot(t);
	seedCustom(root);
	const app = harness(t, customLocation(root));
	app.start();
	const forged = (value: string) => Buffer.from(value).toString("base64url");
	await app.invoke(request("c-proto", "list_sessions", { cursor: forged('{"__proto__":1}') }));
	await app.invoke(request("c-object", "list_sessions", { cursor: forged('{"modified":1,"id":"x"}') }));
	await app.invoke(request("c-nan", "list_sessions", { cursor: forged('[null,"x"]') }));
	await app.invoke(request("c-long", "list_sessions", { cursor: "A".repeat(600) }));
	for (const id of ["c-proto", "c-object", "c-nan", "c-long"]) assert.deepEqual(responseFor(app.payloads(), id).error, INVALID_SESSIONS_PARAMS, id);
	// A well-formed position far in the future is just "everything older": every session, newest first.
	await app.invoke(request("c-huge", "list_sessions", { cursor: forged(JSON.stringify([1e300, "z"])) }));
	assert.deepEqual(responseFor(app.payloads(), "c-huge").data.sessions.map((session: any) => session.id), ["s-new", "s-mid", "s-old"]);
});

test("a session name with backslashes is projected unchanged", () => {
	const entry = projectDesktopSession({ id: "a", cwd: "/w/p", name: "my name C:\Users\devel\secret", modified: new Date(1), messageCount: 1, firstMessage: "hi" }, "b");
	assert.equal(entry?.name, "my name C:\Users\devel\secret");
});
