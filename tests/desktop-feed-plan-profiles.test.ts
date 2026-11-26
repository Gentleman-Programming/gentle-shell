import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDesktopFeedExtension, type DesktopFeedOptions } from "../extensions/gentle-desktop-feed.ts";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { buildDesktopFeedSnapshot, DESKTOP_FEED_LIMITS, type DesktopFeedInput, type DesktopFeedSnapshot, type DesktopFeedTimers } from "../lib/desktop-feed.ts";
import { DESKTOP_ACTION_KINDS, DESKTOP_ACTION_SCHEMA, desktopActionInboxDir, desktopActionOutboxDir, parseDesktopAction } from "../lib/desktop-feed-actions.ts";
import { createDesktopFeedProfileReader } from "../lib/desktop-feed-sources.ts";
import { desktopFeedFile } from "../lib/desktop-feed-store.ts";
import { createProfile, emptyProfilesFile, profilesFilePath, serializeProfilesFile, setActiveProfile } from "../lib/agent-profiles.ts";
import { DESKTOP_PROFILES_SERVICE_CHANNEL, DESKTOP_PROFILES_SERVICE_SCHEMA, type DesktopProfileApplyRequest, type DesktopProfileApplyResult } from "../lib/desktop-rpc-profiles.ts";
import { DESKTOP_USAGE_SERVICE_CHANNEL, DESKTOP_USAGE_SERVICE_SCHEMA, type DesktopUsageOwnerEntry, type DesktopUsageRecordedSnapshot } from "../lib/desktop-rpc-usage.ts";
import { DESKTOP_RPC_SCHEMA } from "../lib/desktop-rpc.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";
import type { ProviderUsage } from "../lib/shell-usage.ts";

// S12 (odd/tasks/herdr-desktop.md): the desktop shows the subscription plan
// (name and every usage window, as the TUI usage panel does) and the model
// profiles (list, active, per-agent models), and switches profile through the
// same owner as /gentle:profiles. Every value comes from the TUI's own owners.

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
const GENTLE_ENV = { PI_PROGRAM_STATUS_APP: "gentle-shell", HERDR_ENV: "1", HERDR_PANE_ID: "t7" };

// The usage owner ages snapshots on the real clock (stale after 5 minutes).
const FETCHED = Date.now() - 1000;
const CODEX: ProviderUsage = {
	provider: "openai-codex",
	plan: "pro",
	fetchedAt: FETCHED,
	limits: [
		{ name: "codex", limitReached: false, windows: [{ label: "5h", usedPercent: 21, windowSeconds: 18_000, resetAt: NOW + 3_600_000 }, { label: "week", usedPercent: 64, windowSeconds: 604_800, resetAt: NOW + 86_400_000 }] },
		{ name: "codex-spark", limitReached: true, windows: [{ label: "5h", usedPercent: 100, windowSeconds: 18_000, resetAt: null }] },
	],
};

// ---- Harness ----

function fakeTimers() {
	const pending = new Map<number, { fn: () => void; ms: number }>();
	let next = 0;
	const timers: DesktopFeedTimers = {
		set(fn, ms) { next += 1; pending.set(next, { fn, ms }); return next; },
		clear(handle) { pending.delete(handle as number); },
	};
	return {
		timers,
		delays: () => [...pending.values()].map((entry) => entry.ms),
		/** Runs the pending timers (only those armed for less than `below` ms, when given). */
		run(below = Number.POSITIVE_INFINITY) {
			const due = [...pending.entries()].filter(([, entry]) => entry.ms < below);
			for (const [id] of due) pending.delete(id);
			for (const [, { fn }] of due) fn();
		},
	};
}

function fakeBus() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(name: string, fn: (data: unknown) => void) {
			const set = listeners.get(name) ?? new Set();
			set.add(fn);
			listeners.set(name, set);
			return () => { set.delete(fn); };
		},
		emit(name: string, data: unknown) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); },
	};
}

type Handler = (event: any, ctx: any) => unknown;
function fakePi() {
	const bus = fakeBus();
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const pi = {
		on(name: string, fn: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); return () => {}; },
		events: bus,
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerTool() {},
		getThinkingLevel: () => "high",
		sendUserMessage() {},
	} as unknown as ExtensionAPI;
	const fire = (name: string, event: unknown, ctx: unknown) => { for (const fn of handlers.get(name) ?? []) fn(event, ctx); };
	return { pi, bus, commands, fire };
}

function fakeCtx(cwd: string, overrides: Record<string, unknown> = {}) {
	const widgets: Array<{ key: string; lines: string[] }> = [];
	let idle = true;
	return {
		cwd, mode: "tui", hasUI: true,
		isIdle: () => idle,
		setIdle(value: boolean) { idle = value; },
		abort() {},
		model: { id: "gpt-5.5", provider: "openai-codex", reasoning: true, contextWindow: 200_000 },
		modelRegistry: { isUsingOAuth: () => true },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 200_000, percent: 0.5 }),
		ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); }, setStatus() {}, notify() {}, confirm: async () => true },
		widgets,
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionFile: () => "/agent/sessions/--w--/2026_sess-1.jsonl",
			getSessionName: () => undefined,
			getCwd: () => cwd,
			getBranch: () => [],
			getEntries: () => [],
			getLeafId: () => null,
		},
		...overrides,
	};
}

/** The usage owner (gentle-shell's UsageStore seam), speaking its owner-service contract. */
function usageOwner(bus: ReturnType<typeof fakeBus>) {
	const state = {
		entries: [] as DesktopUsageOwnerEntry[],
		afterRefresh: undefined as DesktopUsageOwnerEntry[] | undefined,
		refreshes: [] as Array<string | null>,
		reads: 0,
		observers: new Set<(recorded: DesktopUsageRecordedSnapshot) => void>(),
	};
	bus.on(DESKTOP_USAGE_SERVICE_CHANNEL, (payload) => {
		const read = (provider?: string) => {
			state.reads += 1;
			return { providers: state.entries.filter((entry) => provider === undefined || entry.provider === provider) };
		};
		(payload as { respond(service: unknown): void }).respond({
			schema: DESKTOP_USAGE_SERVICE_SCHEMA,
			read,
			refresh: async (provider?: string) => {
				state.refreshes.push(provider ?? null);
				if (state.afterRefresh) state.entries = state.afterRefresh;
				return read(provider);
			},
			observe: (fn: (recorded: DesktopUsageRecordedSnapshot) => void) => { state.observers.add(fn); return () => { state.observers.delete(fn); }; },
			dispose: () => {},
		});
	});
	return state;
}

/** The /gentle:profiles owner (gentle-ai's apply seam). */
function profilesOwner(bus: ReturnType<typeof fakeBus>, answer: (request: DesktopProfileApplyRequest) => DesktopProfileApplyResult) {
	const calls: DesktopProfileApplyRequest[] = [];
	bus.on(DESKTOP_PROFILES_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({
			schema: DESKTOP_PROFILES_SERVICE_SCHEMA,
			apply: async (request: DesktopProfileApplyRequest) => { calls.push(request); return answer(request); },
			dispose: () => {},
		});
	});
	return calls;
}

function harness(t: { after(fn: () => void): void }, options: Partial<DesktopFeedOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "desktop-plan-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	mkdirSync(workspace, { recursive: true });
	const clock = fakeTimers();
	const h = fakePi();
	let fireWatch: (() => void) | undefined;
	let profileReads = 0;
	createDesktopFeedExtension({
		env: GENTLE_ENV,
		agentDir,
		now: () => NOW,
		timers: clock.timers,
		git: () => async () => ({ stdout: "", code: 128 }),
		parentOf: async () => undefined,
		profile: () => { profileReads += 1; return { name: "work", tier: undefined }; },
		realpath: (path) => path,
		sweep: () => {},
		actionWatch: (_dir, onChange) => { fireWatch = onChange; return () => {}; },
		...options,
	})(h.pi);
	const ctx = fakeCtx(workspace);
	const inbox = desktopActionInboxDir(agentDir, "sess-1");
	const outbox = desktopActionOutboxDir(agentDir, "sess-1");
	let n = 0;
	return {
		...h, ctx, clock, agentDir,
		get profileReads() { return profileReads; },
		start: async () => { h.fire("session_start", { reason: "startup" }, ctx); await settle(); clock.run(); await settle(); clock.run(); },
		/** Drops one action, lets the session answer, and returns its answer. */
		async act(kind: string, args: Record<string, unknown>) {
			n += 1;
			const id = `a${n}`;
			writeFileSync(join(inbox, `${id}.json`), JSON.stringify({ schema: DESKTOP_ACTION_SCHEMA, id, sessionId: "sess-1", kind, args, createdAt: new Date(NOW - 1000).toISOString() }));
			fireWatch?.();
			await settle();
			await settle();
			clock.run();
			await settle();
			const file = join(outbox, `${id}.json`);
			return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } : undefined;
		},
		snapshot: () => JSON.parse(readFileSync(desktopFeedFile(agentDir, "sess-1"), "utf8")) as DesktopFeedSnapshot,
		/** Runs the pending timers and lets the owner reads they start answer, `times` times. */
		async tick(times = 1) { for (let i = 0; i < times; i++) { clock.run(); await settle(); } clock.run(); },
	};
}

function input(overrides: Partial<DesktopFeedInput> = {}): DesktopFeedInput {
	return {
		now: NOW,
		identity: { sessionId: "sess-1", sessionFile: undefined, sessionName: undefined, cwd: "/w", realCwd: undefined, pid: 100, ppid: 99, ancestors: [], mode: "tui", agentDir: "/agent", env: {} },
		branch: null,
		model: { id: "gpt-5.5", provider: "openai-codex", reasoning: true },
		thinkingLevel: "high",
		subscription: true,
		profile: { name: "work (session)", tier: "fast" },
		context: undefined,
		usage: undefined,
		permission: undefined,
		todo: { tasks: [], nextId: 1, updatedTurn: null },
		changes: undefined,
		agents: undefined,
		jobs: undefined,
		review: undefined,
		stats: { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, toolCalls: 0, toolErrors: 0, spanMs: 0, cacheHitRate: null, models: [] },
		activity: { working: false, blocked: 0, blockedLabel: undefined, streaming: false, phase: undefined },
		pendingQuestion: undefined,
		...overrides,
	};
}

const codexWire = {
	provider: "openai-codex", status: "ok", plan: "pro", fetchedAt: FETCHED, note: null,
	limits: [
		{ name: "codex", limitReached: false, windows: [{ label: "5h", usedPercent: 21, windowSeconds: 18_000, resetAt: NOW + 3_600_000 }, { label: "week", usedPercent: 64, windowSeconds: 604_800, resetAt: NOW + 86_400_000 }] },
		{ name: "codex-spark", limitReached: true, windows: [{ label: "5h", usedPercent: 100, windowSeconds: 18_000, resetAt: null }] },
	],
};

// ---- Plan usage: the shape ----

test("S12: usage publishes the active provider's plan and every window, and every provider the TUI panel lists", () => {
	const snapshot = buildDesktopFeedSnapshot(input({
		usage: { provider: "openai-codex", status: "ok", fetchedAt: CODEX.fetchedAt, plan: "pro", limits: CODEX.limits },
		usageProviders: [
			{ provider: "openai-codex", status: "ok", fetchedAt: CODEX.fetchedAt, plan: "pro", limits: CODEX.limits },
			{ provider: "claude-bridge", status: "unavailable" },
			{ provider: "nan", status: "failed" },
			{ provider: "anthropic", status: "pending" },
		],
	}));
	assert.deepEqual(snapshot.usage, {
		...codexWire,
		providers: [
			codexWire,
			{ provider: "claude-bridge", status: "unavailable", plan: null, fetchedAt: null, note: "no subscription usage for this provider", limits: [] },
			{ provider: "nan", status: "failed", plan: null, fetchedAt: null, note: "fetch failed · r to retry", limits: [] },
			{ provider: "anthropic", status: "pending", plan: null, fetchedAt: null, note: "usage arrives with the first response", limits: [] },
		],
	});
});

test("S12: a provider that reports nothing says so in the TUI's words; no usage at all stays null", () => {
	const pending = buildDesktopFeedSnapshot(input({ usage: { provider: "openai-codex", status: "pending" }, usageProviders: [{ provider: "openai-codex", status: "pending" }] }));
	assert.deepEqual(pending.usage, { provider: "openai-codex", status: "pending", plan: null, fetchedAt: null, note: "no usage yet · r to fetch", limits: [], providers: [{ provider: "openai-codex", status: "pending", plan: null, fetchedAt: null, note: "no usage yet · r to fetch", limits: [] }] });
	assert.equal(buildDesktopFeedSnapshot(input({ usage: undefined, usageProviders: [] })).usage, null);
	// Bounded: at most DESKTOP_FEED_LIMITS.usageProviders providers.
	const many = Array.from({ length: 20 }, (_, i) => ({ provider: `p${i}`, status: "unavailable" as const }));
	assert.equal(buildDesktopFeedSnapshot(input({ usage: many[0], usageProviders: many })).usage!.providers.length, DESKTOP_FEED_LIMITS.usageProviders);
});

// ---- Profiles: the shape ----

test("S12: profiles publish every saved profile with its tier, mode, orchestrator and per-agent models, and which one is active", () => {
	const snapshot = buildDesktopFeedSnapshot(input({
		profile: {
			name: "fast (session)",
			tier: "fast",
			catalog: {
				active: "fast",
				default: "work",
				items: [
					{ name: "work", config: { "gentle-writer": { model: "anthropic/claude-sonnet-5-5", thinking: "medium" }, "gentle-verifier": {} }, mode: "organic" },
					{ name: "fast", config: { orchestrator: { model: "openai-codex/gpt-5.5", thinking: "low", tier: "fast" }, "gentle-writer": { model: "openai-codex/gpt-5.5" } }, mode: "full-delegation" },
				],
			},
		},
	}));
	assert.deepEqual(snapshot.profiles, {
		active: "fast",
		default: "work",
		items: [
			{ name: "work", tier: null, mode: "organic", orchestrator: null, roles: [{ agent: "gentle-verifier", model: "inherit", thinking: "inherit" }, { agent: "gentle-writer", model: "anthropic/claude-sonnet-5-5", thinking: "medium" }], truncated: false },
			{ name: "fast", tier: "fast", mode: "full-delegation", orchestrator: { model: "openai-codex/gpt-5.5", thinking: "low", tier: "fast" }, roles: [{ agent: "gentle-writer", model: "openai-codex/gpt-5.5", thinking: "inherit" }], truncated: false },
		],
		truncated: false,
	});
	// The header's profile label is unchanged.
	assert.deepEqual(snapshot.model.profile, { name: "fast (session)", tier: "fast" });
	// No readable store: no list.
	assert.equal(buildDesktopFeedSnapshot(input()).profiles, null);
});

test("S12: the profiles list is bounded: profiles and roles per profile", () => {
	const roles = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`agent-${String(i).padStart(2, "0")}`, { model: "m" }]));
	const items = Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, config: roles, mode: "organic" as const }));
	const profiles = buildDesktopFeedSnapshot(input({ profile: { name: undefined, tier: undefined, catalog: { active: undefined, default: undefined, items } } })).profiles!;
	assert.equal(profiles.items.length, DESKTOP_FEED_LIMITS.profiles);
	assert.equal(profiles.truncated, true);
	assert.equal(profiles.items[0]!.roles.length, DESKTOP_FEED_LIMITS.profileRoles);
	assert.equal(profiles.items[0]!.truncated, true);
	assert.equal(profiles.active, null);
});

test("S12: the profile reader lists the saved profiles from the same store /gentle:profiles uses", (t) => {
	const root = mkdtempSync(join(tmpdir(), "desktop-profiles-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configHome = join(root, "config");
	mkdirSync(configHome, { recursive: true });
	let file = createProfile(emptyProfilesFile(), "work", { "gentle-writer": { model: "anthropic/claude-sonnet-5-5", thinking: "medium" } });
	file = createProfile(file, "fast", { orchestrator: { model: "openai-codex/gpt-5.5", tier: "fast" }, "gentle-writer": { model: "openai-codex/gpt-5.5" } });
	file = setActiveProfile(file, "work");
	writeFileSync(profilesFilePath(configHome), serializeProfilesFile(file));
	const read = createDesktopFeedProfileReader({ GENTLE_PI_CONFIG_HOME: configHome, HOME: root }, () => undefined)(join(root, "w"), undefined);
	assert.equal(read.name, "work");
	assert.deepEqual(read.catalog?.default, "work");
	assert.deepEqual(read.catalog?.active, "work");
	assert.deepEqual(read.catalog?.items.map((item) => [item.name, item.mode, Object.keys(item.config)]), [["work", "organic", ["gentle-writer"]], ["fast", "organic", ["orchestrator", "gentle-writer"]]]);
});

// ---- Plan usage: the extension, on the TUI's cadence ----

test("S12: the feed publishes the owner's plan and windows once the TUI's session-start fetch settles, and never fetches itself", async (t) => {
	const h = harness(t);
	const owner = usageOwner(h.bus);
	owner.entries = [{ provider: "openai-codex", supported: true, refreshable: true, failed: false }];
	// The session starts: the debounced write runs, the follow-up reads wait.
	h.fire("session_start", { reason: "startup" }, h.ctx);
	await settle();
	h.clock.run(1000);
	await settle();
	h.clock.run(1000);
	assert.equal(h.snapshot().usage!.status, "pending");
	assert.deepEqual(h.clock.delays(), [2000], "one follow-up read is armed");
	// gentle-shell's own forced fetch at session_start lands in the owner's store.
	owner.entries = [{ provider: "openai-codex", supported: true, refreshable: true, failed: false, snapshot: CODEX }, { provider: "anthropic", supported: true, refreshable: false, failed: false }];
	await h.tick(3);
	const usage = h.snapshot().usage!;
	assert.equal(usage.plan, "pro");
	assert.deepEqual(usage.limits, codexWire.limits);
	assert.deepEqual(usage.providers.map((entry) => [entry.provider, entry.status, entry.note]), [["openai-codex", "ok", null], ["anthropic", "pending", "usage arrives with the first response"]]);
	// A settled turn is the TUI's other fetch point (agent_end): the feed reads again, never refreshes.
	h.fire("agent_settled", {}, h.ctx);
	await h.tick(3);
	assert.deepEqual(owner.refreshes, [], "the feed adds no provider call");
	// Follow-up reads are bounded: nothing stays armed once they ran.
	await h.tick(3);
	assert.deepEqual(h.clock.delays(), []);
});

test("S12: a header-carried snapshot (Claude's 5h and 7d) reaches the feed for the active provider", async (t) => {
	const h = harness(t);
	const owner = usageOwner(h.bus);
	h.ctx.model = { ...h.ctx.model, provider: "claude-bridge" } as typeof h.ctx.model;
	owner.entries = [{ provider: "claude-bridge", supported: false, refreshable: false, failed: false }];
	await h.start();
	const claude: ProviderUsage = { provider: "claude-bridge", plan: undefined, fetchedAt: NOW, limits: [{ name: "all", limitReached: false, windows: [{ label: "5h", usedPercent: 12, windowSeconds: 18_000, resetAt: null }, { label: "week", usedPercent: 40, windowSeconds: 604_800, resetAt: null }] }] };
	// gentle-shell's after_provider_response: records the snapshot, then tells its observers.
	owner.entries = [{ provider: "claude-bridge", supported: false, refreshable: false, failed: false, snapshot: claude }];
	for (const fn of owner.observers) fn({ provider: "claude-bridge", usage: claude });
	await h.tick(1);
	const usage = h.snapshot().usage!;
	assert.equal(usage.status, "ok");
	assert.deepEqual(usage.limits[0]!.windows.map((w) => w.label), ["5h", "week"]);
	assert.deepEqual(usage.providers.map((entry) => entry.provider), ["claude-bridge"]);
});

test("S12: refresh_usage runs the owner's refresh once, as the TUI panel's r does, and the snapshot follows", async (t) => {
	const h = harness(t);
	const owner = usageOwner(h.bus);
	owner.entries = [{ provider: "openai-codex", supported: true, refreshable: true, failed: false }];
	owner.afterRefresh = [{ provider: "openai-codex", supported: true, refreshable: true, failed: false, snapshot: CODEX }];
	await h.start();
	const answer = await h.act("refresh_usage", {});
	assert.equal(answer?.ok, true);
	assert.deepEqual(answer?.data, { providers: [{ provider: "openai-codex", status: "ok" }] });
	assert.deepEqual(owner.refreshes, [null]);
	assert.equal(h.snapshot().usage!.plan, "pro");
	// One provider, the RPC's own param.
	assert.equal((await h.act("refresh_usage", { provider: "openai-codex" }))?.ok, true);
	assert.deepEqual(owner.refreshes, [null, "openai-codex"]);
	// Anything else never reaches the owner.
	for (const args of [{ provider: "" }, { provider: 5 }, { provider: "x", force: true }]) {
		const refused = await h.act("refresh_usage", args);
		assert.deepEqual(refused?.error?.code, "invalid_action", JSON.stringify(args));
	}
	assert.deepEqual(owner.refreshes, [null, "openai-codex"]);
});

// ---- Profiles: the extension ----

test("S12: the snapshot carries the session's profiles from the reader", async (t) => {
	const catalog = { active: "work", default: "work", items: [{ name: "work", config: { "gentle-writer": { model: "m1" } }, mode: "organic" as const }] };
	const h = harness(t, { profile: () => ({ name: "work", tier: undefined, catalog }) });
	await h.start();
	assert.deepEqual(h.snapshot().profiles, { active: "work", default: "work", items: [{ name: "work", tier: null, mode: "organic", orchestrator: null, roles: [{ agent: "gentle-writer", model: "m1", thinking: "inherit" }], truncated: false }], truncated: false });
});

test("S12: apply_profile runs /gentle:profiles' own apply once, for this session, and the profile is read again", async (t) => {
	const h = harness(t);
	const calls = profilesOwner(h.bus, () => ({ status: "applied", notes: [{ level: "info", text: "Using \"fast\" in this session." }] }));
	await h.start();
	const reads = h.profileReads;
	const answer = await h.act("apply_profile", { name: "fast" });
	assert.deepEqual(calls, [{ profile: "fast", mode: "session" }]);
	assert.deepEqual(answer, { ...answer, ok: true, data: { profile: "fast", mode: "session", status: "applied", notes: [{ level: "info", text: "Using \"fast\" in this session." }] } });
	assert.ok(h.profileReads > reads, "the profile is read again after an apply");
});

test("S12: apply_profile hands the owner's confirmation to the desktop and passes its token back unchanged", async (t) => {
	const h = harness(t);
	const calls = profilesOwner(h.bus, (request) => (request.confirmation === "tok-1"
		? { status: "applied", notes: [] }
		: { status: "confirmation_required", title: "Use \"fast\"?", message: "gentle-writer: sonnet → gpt-5.5", confirmation: "tok-1" }));
	await h.start();
	const first = await h.act("apply_profile", { name: "fast" });
	assert.deepEqual(first?.data, { profile: "fast", mode: "session", status: "confirmation_required", confirmation: { title: "Use \"fast\"?", message: "gentle-writer: sonnet → gpt-5.5", token: "tok-1" } });
	const second = await h.act("apply_profile", { name: "fast", confirmation: "tok-1" });
	assert.equal(second?.data?.status, "applied");
	assert.deepEqual(calls, [{ profile: "fast", mode: "session" }, { profile: "fast", mode: "session", confirmation: "tok-1" }]);
});

test("S12: apply_profile keeps the owner's refusals and, like /gentle:profiles, also runs while the session works", async (t) => {
	const h = harness(t);
	const calls = profilesOwner(h.bus, (request) => (request.profile === "busy" ? { status: "busy" } : { status: "unknown_profile" }));
	await h.start();
	assert.deepEqual((await h.act("apply_profile", { name: "ghost" }))?.error, { code: "unknown_profile", message: "No saved profile with that name" });
	assert.deepEqual((await h.act("apply_profile", { name: "busy" }))?.error, { code: "profile_apply_busy", message: "Another profile apply is in progress" });
	assert.equal(calls.length, 2);
	// Never the global default, never another key, never an over-long name: the owner is not asked.
	for (const args of [{ name: "fast", mode: "default" }, { name: "" }, { name: "x".repeat(129) }, { profile: "fast" }, { name: "fast", confirmation: 7 }]) {
		assert.equal((await h.act("apply_profile", args))?.error?.code, "invalid_action", JSON.stringify(args));
	}
	assert.equal(calls.length, 2);
	// While the agent works the TUI still lets you switch the profile; the desktop matches it.
	h.ctx.setIdle(false);
	h.fire("agent_start", {}, h.ctx);
	const busy = await h.act("apply_profile", { name: "fast" });
	assert.notEqual(busy?.error?.code, "profile_while_busy");
	assert.equal(calls.length, 3);
	assert.equal(calls[2].profile, "fast");
});

test("S12: the action kinds add refresh_usage and apply_profile and keep every earlier kind", () => {
	assert.deepEqual([...DESKTOP_ACTION_KINDS], ["set_permission_mode", "cancel_job", "cancel_subagent", "answer_question", "abort_turn", "send_prompt", "refresh_usage", "apply_profile"]);
	const parse = (kind: string, args: Record<string, unknown>) => parseDesktopAction(JSON.stringify({ schema: DESKTOP_ACTION_SCHEMA, id: "x1", sessionId: "s", kind, args, createdAt: new Date(NOW).toISOString() }), "s", NOW);
	assert.equal(parse("refresh_usage", {}).ok, true);
	assert.equal(parse("apply_profile", { name: "fast" }).ok, true);
	assert.equal(parse("set_permission_mode", { mode: "auto" }).ok, true);
});

// ---- The desktop RPC is unchanged ----


/** Channel lines other than the feed's session_snapshot events, without the shared event counter. */
function withoutSessionSnapshots(lines: Array<string | undefined>): unknown[] {
	return lines
		.map((line) => JSON.parse(line!) as Record<string, unknown>)
		.filter((line) => line.event !== "session_snapshot")
		.map(({ seq: _seq, ...line }) => line);
}

test("S12: desktop RPC refresh_subscription_usage and apply_profile answers are byte-identical with the feed loaded", async (t) => {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => { if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV]; else process.env[INTERACTIVE_HOST_ENV] = previous; });
	const run = async (withFeed: boolean) => {
		const h = fakePi();
		const owner = usageOwner(h.bus);
		owner.entries = [{ provider: "openai-codex", supported: true, refreshable: true, failed: false }];
		owner.afterRefresh = [{ provider: "openai-codex", supported: true, refreshable: true, failed: false, snapshot: CODEX }];
		const applies = profilesOwner(h.bus, () => ({ status: "applied", notes: [] }));
		desktopRpc(h.pi);
		const root = mkdtempSync(join(tmpdir(), "desktop-plan-rpc-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const clock = fakeTimers();
		if (withFeed) createDesktopFeedExtension({ env: { ...GENTLE_ENV, [INTERACTIVE_HOST_ENV]: "1" }, agentDir: join(root, "agent"), now: () => NOW, timers: clock.timers, git: () => async () => ({ stdout: "", code: 128 }), parentOf: async () => undefined, profile: () => ({ name: undefined, tier: undefined }), sweep: () => {}, actionWatch: () => () => {} })(h.pi);
		const ctx = fakeCtx(root, { mode: "rpc" });
		h.fire("session_start", { reason: "startup" }, ctx);
		await settle();
		const call = async (requestId: string, method: string, params: Record<string, unknown>) =>
			h.commands.get("gentle:desktop")!.handler(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }), ctx);
		await call("r1", "refresh_subscription_usage", {});
		await call("r2", "apply_profile", { profile: "fast", mode: "session" });
		await settle();
		clock.run();
		return { lines: ctx.widgets.filter((widget) => widget.key === "gentle-desktop-rpc").map((widget) => widget.lines[0]), refreshes: owner.refreshes, applies };
	};
	const without = await run(false);
	const withFeed = await run(true);
	// #3319: the feed also publishes its own session_snapshot events on the
	// channel; every other line is unchanged, in the same order.
	assert.deepEqual(withoutSessionSnapshots(withFeed.lines), withoutSessionSnapshots(without.lines));
	assert.ok(without.lines.length >= 2);
	assert.deepEqual(withFeed.refreshes, without.refreshes);
	assert.deepEqual(withFeed.applies, without.applies);
});
