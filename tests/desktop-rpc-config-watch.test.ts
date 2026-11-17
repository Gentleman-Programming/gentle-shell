import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import { PROFILES_KIND, PROFILES_VERSION, profilesFilePath } from "../lib/agent-profiles.ts";
import { DESKTOP_CHANGE_DEBOUNCE_MS, DesktopDirectoryWatcher, watchDesktopDirectory, type DesktopChangeTimers } from "../lib/desktop-rpc-config-watch.ts";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET } from "../lib/desktop-rpc.ts";
import { configWatchTargets, DesktopConfigBridge } from "../lib/desktop-rpc-config.ts";
import { DesktopPermissionBridge } from "../lib/desktop-rpc-permissions.ts";
import { PROFILE_PIN_KIND, PROFILE_PIN_VERSION, localProfilePinPath, repoProfileDeclarationPath } from "../lib/agent-profile-pin.ts";
import { FALLBACKS_KIND, FALLBACKS_VERSION, fallbacksFilePath } from "../lib/model-fallback-store.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";
import { registerYoloSessionPolicy } from "../lib/yolo-session-policy.ts";

// External-change events (#3321). Every watcher and timer is injected: the fake
// directory watcher lets a test say exactly which owner directory reported a
// change, and the fake clock decides when the debounce window closes, so no test
// depends on real filesystem notification timing.

interface FakeClock extends DesktopChangeTimers {
	advance(ms: number): void;
	pending(): number;
}

function fakeClock(): FakeClock {
	let now = 0;
	let next = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		set(fn, ms) {
			const id = next++;
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clear(handle) {
			timers.delete(handle as number);
		},
		advance(ms) {
			now += ms;
			for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
				if (timer.at > now || !timers.has(id)) continue;
				timers.delete(id);
				timer.fn();
			}
		},
		pending() {
			return timers.size;
		},
	};
}

interface FakeWatch {
	dir: string;
	onChange: (filename: string | undefined, removed?: boolean) => void;
	closed: boolean;
}

function fakeWatches(fails: (dir: string) => boolean = () => false) {
	const all: FakeWatch[] = [];
	const attempts: string[] = [];
	return {
		all,
		attempts,
		factory(dir: string, onChange: (filename: string | undefined, removed?: boolean) => void) {
			attempts.push(dir);
			if (fails(dir)) throw Object.assign(new Error("ENOSPC: watcher limit"), { code: "ENOSPC" });
			const watch: FakeWatch = { dir, onChange, closed: false };
			all.push(watch);
			return () => {
				watch.closed = true;
			};
		},
		open(): FakeWatch[] {
			return all.filter((watch) => !watch.closed);
		},
		fire(dir: string, filename: string | undefined): number {
			let delivered = 0;
			for (const watch of all) {
				if (watch.closed || watch.dir !== dir) continue;
				watch.onChange(filename);
				delivered += 1;
			}
			return delivered;
		},
		/** What the real watcher does when its own directory disappears: close, then report it. */
		remove(dir: string): number {
			let delivered = 0;
			for (const watch of all) {
				if (watch.closed || watch.dir !== dir) continue;
				watch.closed = true;
				watch.onChange(undefined, true);
				delivered += 1;
			}
			return delivered;
		},
	};
}

/** Real owner reads (realpath, file reads) finish on the event loop, not the fake clock. */
async function settle(): Promise<void> {
	for (let index = 0; index < 25; index += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

// ---- The debounced directory watcher on its own ----

test("a burst of directory changes is coalesced into one recompute per debounce window", () => {
	const clock = fakeClock();
	const watches = fakeWatches();
	let runs = 0;
	const watcher = new DesktopDirectoryWatcher(() => (runs += 1), { watch: watches.factory, timers: clock, exists: () => true });
	assert.equal(watcher.start([{ dir: "/owner", names: ["profiles.json"] }]), 1);

	watches.fire("/owner", "profiles.json");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS - 50);
	watches.fire("/owner", "profiles.json");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS - 50);
	assert.equal(runs, 0, "every change restarts the window");
	clock.advance(50);
	assert.equal(runs, 1, "one recompute after the last change");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS * 4);
	assert.equal(runs, 1, "no trailing recompute without a new change");
	watcher.dispose();
});

test("unrelated entries in a watched directory never schedule a recompute; unnamed events do", () => {
	const clock = fakeClock();
	const watches = fakeWatches();
	let runs = 0;
	const watcher = new DesktopDirectoryWatcher(() => (runs += 1), { watch: watches.factory, timers: clock, exists: () => true });
	watcher.start([
		{ dir: "/owner", names: ["profiles.json"] },
		{ dir: "/owner", names: ["profile-fallbacks.json"] },
	]);
	assert.equal(watches.all.length, 1, "one watcher per directory, names merged");

	watches.fire("/owner", "notes.txt");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.equal(runs, 0);
	assert.equal(clock.pending(), 0);

	watches.fire("/owner", "profile-fallbacks.json");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.equal(runs, 1);

	watches.fire("/owner", undefined);
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.equal(runs, 2, "a platform that reports no name still triggers a recompute");
	watcher.dispose();
});

test("a directory that cannot be watched is skipped without throwing", () => {
	const clock = fakeClock();
	const watches = fakeWatches((dir) => dir === "/missing");
	let runs = 0;
	const watcher = new DesktopDirectoryWatcher(() => (runs += 1), { watch: watches.factory, timers: clock, exists: () => true });
	assert.equal(
		watcher.start([
			{ dir: "/missing", names: ["models.json"] },
			{ dir: "/owner", names: ["profiles.json"] },
		]),
		1,
	);
	assert.deepEqual(watches.attempts, ["/missing", "/owner"]);
	watches.fire("/owner", "profiles.json");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.equal(runs, 1, "the remaining watcher still works");

	const none = new DesktopDirectoryWatcher(() => (runs += 1), {
		watch: () => {
			throw new Error("unsupported platform");
		},
		timers: clock,
		exists: () => true,
	});
	assert.equal(none.start([{ dir: "/owner", names: ["profiles.json"] }]), 0);
	none.dispose();
	watcher.dispose();
});

test("dispose closes every watcher and cancels a pending recompute", () => {
	const clock = fakeClock();
	const watches = fakeWatches();
	let runs = 0;
	const watcher = new DesktopDirectoryWatcher(() => (runs += 1), { watch: watches.factory, timers: clock, exists: () => true });
	watcher.start([
		{ dir: "/a", names: ["x.json"] },
		{ dir: "/b", names: ["y.json"] },
	]);
	watches.fire("/a", "x.json");
	watcher.dispose();
	watcher.dispose();
	assert.equal(watches.open().length, 0);
	assert.equal(clock.pending(), 0);
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.equal(runs, 0);
	assert.equal(watcher.start([{ dir: "/a", names: ["x.json"] }]), 0, "a disposed watcher never restarts");
});

// ---- Through the channel ----

function profilesFile(active: string): Record<string, unknown> {
	return {
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		active,
		profiles: {
			team: { explore: { model: "anthropic/claude-explore" } },
			ops: { worker: { model: "openai/gpt-worker" } },
		},
	};
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function desktopHost(
	t: test.TestContext,
	options: { mode?: string; watchFails?: (dir: string) => boolean; owner?: boolean } = {},
) {
	const root = mkdtempSync(join(tmpdir(), "gentle-desktop-watch-"));
	const configHome = join(root, "config");
	const agentHome = join(root, "agent");
	const workspace = join(root, "workspace");
	for (const directory of [configHome, agentHome, workspace]) mkdirSync(directory, { recursive: true });
	const previous = {
		host: process.env[INTERACTIVE_HOST_ENV],
		configHome: process.env.GENTLE_PI_CONFIG_HOME,
		agentHome: process.env.GENTLE_PI_AGENT_HOME,
		child: process.env.GENTLE_PI_AGENTS_CHILD,
	};
	process.env[INTERACTIVE_HOST_ENV] = "1";
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	delete process.env.GENTLE_PI_AGENTS_CHILD;

	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const lifecycle = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const hostUi = new Map<string, (value: unknown) => void>();
	const pi = {
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, command);
		},
		on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			lifecycle.set(name, handler);
		},
		registerTool() {},
		events: {
			on(name: string, handler: (value: unknown) => void) {
				hostUi.set(name, handler);
			},
			emit(name: string, value: unknown) {
				hostUi.get(name)?.(value);
			},
		},
	} as unknown as ExtensionAPI;
	if (options.owner !== false) registerYoloSessionPolicy(pi, process.env, { resolveIdentity: async () => "workspace:test" });
	const clock = fakeClock();
	const watches = fakeWatches(options.watchFails);
	desktopRpc(pi, { watch: watches.factory, timers: clock });

	const widgets: string[] = [];
	const session = { id: "session-1" };
	const ctx = {
		mode: options.mode ?? "rpc",
		hasUI: true,
		cwd: workspace,
		sessionManager: { getSessionId: () => session.id },
		ui: {
			setWidget(key: string, lines: string[]) {
				if (key === DESKTOP_RPC_WIDGET) widgets.push(lines[0]!);
			},
			setStatus() {},
			notify() {},
			select: async () => undefined,
			getAllThemes: () => [],
		},
	} as unknown as ExtensionContext;
	const app = {
		root,
		configHome,
		agentHome,
		workspace,
		clock,
		watches,
		ctx,
		session,
		start() {
			lifecycle.get("session_start")?.({}, ctx);
		},
		shutdown() {
			lifecycle.get("session_shutdown")?.({}, ctx);
		},
		async invoke(method: string, params: Record<string, unknown> = {}, requestId = `request-${method}`) {
			await commands.get("gentle:desktop")!.handler(
				JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId, method, params }),
				ctx,
			);
		},
		async mode(args: string) {
			await commands.get("gentle:mode")!.handler(args, ctx);
		},
		lines(): any[] {
			return widgets.map((line) => JSON.parse(line));
		},
		events(name?: string): any[] {
			return app.lines().filter((line) => line.kind === "event" && (name === undefined || line.event === name));
		},
		/** Closes the debounce window, then lets the owner re-reads finish. */
		async elapse() {
			clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
			await settle();
		},
	};
	t.after(async () => {
		app.shutdown();
		const restore = (key: string, value: string | undefined) => {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		};
		restore(INTERACTIVE_HOST_ENV, previous.host);
		restore("GENTLE_PI_CONFIG_HOME", previous.configHome);
		restore("GENTLE_PI_AGENT_HOME", previous.agentHome);
		restore("GENTLE_PI_AGENTS_CHILD", previous.child);
		rmSync(root, { recursive: true, force: true });
	});
	return app;
}

test("an external profiles edit emits one config_changed with source external and no content or path", async (t) => {
	const app = desktopHost(t);
	writeJson(profilesFilePath(app.configHome), profilesFile("team"));
	app.start();
	await settle();
	const configDir = dirname(profilesFilePath(app.configHome));
	assert.ok(app.watches.open().some((watch) => watch.dir === configDir), "the owner directory is watched");

	writeJson(profilesFilePath(app.configHome), profilesFile("ops"));
	app.watches.fire(configDir, "profiles.json");
	app.clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS - 1);
	await settle();
	assert.deepEqual(app.events(), [], "nothing before the debounce window closes");
	await app.elapse();

	await app.invoke("get_config", { store: "profiles" });
	const current = app.lines().at(-1).data;
	const events = app.events("config_changed");
	assert.equal(events.length, 1);
	assert.equal(events[0].seq, 1);
	assert.deepEqual(events[0].data, {
		store: "profiles",
		scope: "global",
		revision: current.revision,
		status: "ok",
		source: "external",
	});
	assert.equal(JSON.stringify(events[0]).includes(app.root), false, "no absolute path on the wire");

	await app.elapse();
	assert.equal(app.events().length, 1, "no repeat without a new change");
});

test("a burst of external writes to several stores coalesces into one event per changed store", async (t) => {
	const app = desktopHost(t);
	writeJson(profilesFilePath(app.configHome), profilesFile("team"));
	app.start();
	await settle();
	const configDir = dirname(profilesFilePath(app.configHome));

	writeJson(profilesFilePath(app.configHome), profilesFile("ops"));
	app.watches.fire(configDir, "profiles.json");
	writeJson(profilesFilePath(app.configHome), profilesFile("team"));
	app.watches.fire(configDir, "profiles.json");
	writeJson(fallbacksFilePath(app.configHome), { kind: FALLBACKS_KIND, version: FALLBACKS_VERSION, profiles: {} });
	app.watches.fire(configDir, "profile-fallbacks.json");
	await app.elapse();

	// profiles went team -> ops -> team inside one window: its revision is back to
	// the last one reported, so only the fallbacks store changed.
	const events = app.events("config_changed");
	assert.deepEqual(
		events.map((event) => [event.data.store, event.data.source]),
		[["profile_fallbacks", "external"]],
	);
});

test("a Desktop set_config is reported once, as desktop, never echoed as external", async (t) => {
	const app = desktopHost(t);
	writeJson(profilesFilePath(app.configHome), profilesFile("team"));
	app.start();
	await settle();
	await app.invoke("get_config", { store: "profiles" });
	const read = app.lines().at(-1).data;

	await app.invoke("set_config", {
		store: "profiles",
		data: profilesFile("ops"),
		expectedRevision: read.writeTargets[0].writeRevision,
	});
	const [response, desktopEvent] = app.lines().slice(-2);
	assert.equal(response.ok, true);
	assert.equal(desktopEvent.data.source, "desktop");

	// The owner's own write wakes the directory watcher like any other write.
	app.watches.fire(dirname(profilesFilePath(app.configHome)), "profiles.json");
	await app.elapse();
	assert.deepEqual(
		app.events("config_changed").map((event) => event.data.source),
		["desktop"],
		"the recomputed revision equals the one the channel already reported",
	);
});

test("an event whose recomputed revisions did not change emits nothing", async (t) => {
	const app = desktopHost(t);
	writeJson(profilesFilePath(app.configHome), profilesFile("team"));
	app.start();
	await settle();
	// Same content rewritten (formatting only): the canonical revision is unchanged.
	writeFileSync(profilesFilePath(app.configHome), `${JSON.stringify(profilesFile("team"), null, 2)}\n`);
	app.watches.fire(dirname(profilesFilePath(app.configHome)), "profiles.json");
	await app.elapse();
	assert.deepEqual(app.events(), []);
});

test("watcher creation failure leaves the channel working without external events", async (t) => {
	const app = desktopHost(t, { watchFails: () => true });
	writeJson(profilesFilePath(app.configHome), profilesFile("team"));
	app.start();
	await settle();
	assert.ok(app.watches.attempts.length > 0, "watchers were attempted");
	assert.equal(app.watches.open().length, 0);

	writeJson(profilesFilePath(app.configHome), profilesFile("ops"));
	await app.elapse();
	assert.deepEqual(app.events(), []);

	await app.invoke("get_snapshot");
	const snapshot = app.lines().at(-1);
	assert.equal(snapshot.ok, true, "get_snapshot stays the source of truth");
	await app.invoke("get_config", { store: "profiles" });
	const read = app.lines().at(-1);
	assert.equal(read.ok, true);
	assert.equal(read.data.value.active, "ops");
	assert.equal(
		snapshot.data.state.config.stores.find((store: any) => store.store === "profiles").revision,
		read.data.revision,
	);
	await app.invoke("set_config", {
		store: "profiles",
		data: profilesFile("team"),
		expectedRevision: read.data.writeTargets[0].writeRevision,
	});
	assert.equal(app.lines().at(-2).ok, true, "writes still work");
	assert.equal(app.events("config_changed").length, 1);
});

test("session shutdown and session switch dispose every watcher and pending recompute", async (t) => {
	const app = desktopHost(t);
	writeJson(profilesFilePath(app.configHome), profilesFile("team"));
	app.start();
	await settle();
	const first = app.watches.open();
	assert.ok(first.length > 0);
	const configDir = dirname(profilesFilePath(app.configHome));

	// Switch: a new session_start replaces every watcher of the old session.
	writeJson(profilesFilePath(app.configHome), profilesFile("ops"));
	app.watches.fire(configDir, "profiles.json");
	app.start();
	await settle();
	assert.equal(first.every((watch) => watch.closed), true, "old watchers closed on switch");
	assert.ok(app.watches.open().length > 0, "the new session watches again");
	await app.elapse();
	assert.deepEqual(app.events(), [], "the old session's pending recompute was cancelled");

	app.shutdown();
	assert.equal(app.watches.open().length, 0, "shutdown closes every watcher");
	writeJson(profilesFilePath(app.configHome), profilesFile("team"));
	for (const watch of app.watches.all) watch.onChange("profiles.json");
	await app.elapse();
	assert.equal(app.clock.pending(), 0);
	assert.deepEqual(app.lines(), [], "nothing is published after shutdown");
});

test("non-interactive hosts create no watchers and subscribe to no owner", async (t) => {
	for (const mode of ["tui", "print"]) {
		const app = desktopHost(t, { mode });
		app.start();
		await settle();
		assert.deepEqual(app.watches.attempts, [], `${mode}: no watcher attempted`);
		await app.mode("yolo");
		await app.elapse();
		assert.deepEqual(app.lines(), [], `${mode}: nothing published`);
	}
});

// ---- Permission mode changes made outside Desktop RPC ----

test("a /gentle:mode change emits permission_mode_changed with source external", async (t) => {
	const app = desktopHost(t);
	app.start();
	await settle();

	await app.mode("yolo");
	await settle();
	assert.deepEqual(app.events(), [], "debounced, not immediate");
	await app.elapse();
	const events = app.events("permission_mode_changed");
	assert.equal(events.length, 1);
	assert.deepEqual(events[0].data, {
		mode: "yolo",
		previous_mode: "normal",
		default_mode: "normal",
		persisted: false,
		source: "external",
	});

	await app.mode("default auto");
	await app.elapse();
	assert.deepEqual(app.events("permission_mode_changed").at(-1).data, {
		mode: "yolo",
		previous_mode: "yolo",
		default_mode: "auto",
		persisted: true,
		source: "external",
	});
	assert.equal(app.events().length, 2);

	await app.invoke("get_permission_mode");
	assert.deepEqual(app.lines().at(-1).data, { mode: "yolo", default_mode: "auto" });
});

test("a Desktop set_permission_mode is reported once, as desktop, never echoed as external", async (t) => {
	const app = desktopHost(t);
	app.start();
	await settle();
	await app.invoke("set_permission_mode", { mode: "auto", persist: true });
	await app.elapse();
	await app.elapse();
	assert.deepEqual(
		app.events().map((event) => [event.event, event.data.source]),
		[["permission_mode_changed", "desktop"]],
	);
});

test("permission observation stops on shutdown and restarts on a new session", async (t) => {
	const app = desktopHost(t);
	app.start();
	await settle();
	app.shutdown();
	await app.mode("yolo");
	await app.elapse();
	assert.deepEqual(app.lines(), [], "no event after shutdown");

	app.session.id = "session-2";
	app.start();
	await settle();
	await app.mode("auto");
	await app.elapse();
	const events = app.events("permission_mode_changed");
	assert.equal(events.length, 1);
	assert.equal(events[0].data.mode, "auto");
	assert.equal(events[0].data.source, "external");
	assert.equal(events[0].seq, 1, "the new session's sequence starts at 1");
});

test("a missing permission owner leaves config watching and the channel intact", async (t) => {
	const app = desktopHost(t, { owner: false });
	writeJson(profilesFilePath(app.configHome), profilesFile("team"));
	app.start();
	await settle();
	writeJson(profilesFilePath(app.configHome), profilesFile("ops"));
	app.watches.fire(dirname(profilesFilePath(app.configHome)), "profiles.json");
	await app.elapse();
	assert.deepEqual(app.events().map((event) => event.event), ["config_changed"]);
	await app.invoke("get_permission_mode");
	assert.equal(app.lines().at(-1).error.code, "permission_unavailable");
});

// ---- Bridge seams: pin layers follow the session cwd; Desktop sets are never echoed ----

test("pin layers are watched in the session worktree and follow a cwd change", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-desktop-watch-pins-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const configHome = join(root, "config");
	const first = join(root, "first");
	const second = join(root, "second");
	for (const directory of [configHome, first, second]) mkdirSync(directory, { recursive: true });
	const resolveWorktree = (_path: string, cwd: string) => ({ root: cwd, commonDir: join(cwd, ".git-common") });
	const pinDirs = (cwd: string) => [dirname(localProfilePinPath(join(cwd, ".git-common"))), dirname(repoProfileDeclarationPath(cwd))];
	for (const directory of [...pinDirs(first), ...pinDirs(second)]) mkdirSync(directory, { recursive: true });
	const clock = fakeClock();
	const watches = fakeWatches();
	const bridge = new DesktopConfigBridge(
		{ configHome, agentHome: join(root, "agent"), resolveWorktree },
		{ watch: watches.factory, timers: clock },
	);
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	bridge.attach({ cwd: first } as unknown as ExtensionContext);
	bridge.wire((event, data) => events.push({ event, data }));

	const open = () => watches.open().map((watch) => watch.dir);
	for (const dir of pinDirs(first)) assert.ok(open().includes(dir), `watches ${dir}`);
	const targets = configWatchTargets({ cwd: first, configHome, agentHome: join(root, "agent"), resolveWorktree });
	const pinTargets = targets.filter((target) => target.names.includes("profile-pin.json") || target.names.includes("profile.json"));
	assert.deepEqual(
		pinTargets.map((target) => [target.dir, target.names[0]]),
		[
			[pinDirs(first)[0], "profile-pin.json"],
			[pinDirs(first)[1], "profile.json"],
		],
		"each pin layer is watched by its owner file name in its own directory",
	);

	writeJson(profilesFilePath(configHome), profilesFile("team"));
	writeJson(repoProfileDeclarationPath(first), { kind: PROFILE_PIN_KIND, version: PROFILE_PIN_VERSION, profile: "ops" });
	watches.fire(dirname(repoProfileDeclarationPath(first)), "profile.json");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.deepEqual(
		events.map((entry) => entry.data.store).sort(),
		["pins", "profiles"],
		"the pin layer and the profiles store it resolves against both changed",
	);

	// A command bound with another cwd moves the pin layers, so the watchers move.
	bridge.attach({ cwd: second } as unknown as ExtensionContext);
	for (const dir of pinDirs(first)) assert.equal(open().includes(dir), false, `stopped watching ${dir}`);
	for (const dir of pinDirs(second)) assert.ok(open().includes(dir), `watches ${dir}`);

	bridge.reset();
	assert.deepEqual(open(), []);
});

test("an owner notification that settles during a Desktop set is deferred and never echoed", async () => {
	const clock = fakeClock();
	let state = { mode: "normal", defaultMode: "normal" };
	let notify: () => void = () => {};
	let release: () => void = () => {};
	const adapter = {
		read: async () => "OFF",
		readSnapshot: async () => ({ yolo: "OFF", mode: state.mode, defaultMode: state.defaultMode }),
		setMode: async (mode: string) => {
			state = { ...state, mode: "normal" };
			notify();
			await new Promise<void>((resolve) => (release = resolve));
			state = { ...state, mode };
			notify();
			return true;
		},
		toggle: async () => {},
		observe: (refresh: () => void) => {
			notify = refresh;
			return () => (notify = () => {});
		},
		dispose: () => {},
	};
	const bridge = new DesktopPermissionBridge({} as ExtensionAPI, async () => adapter as never, { timers: clock });
	const events: Array<Record<string, unknown>> = [];
	bridge.attach({ cwd: "/workspace" } as unknown as ExtensionContext);
	await bridge.wire((_event, data) => events.push(data));

	const pending = bridge.handle("set_permission_mode", { mode: "yolo" });
	await settle();
	// The owner's transient revoke-to-normal window closes while the set is in flight.
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	await settle();
	assert.deepEqual(events, [], "no external event mid-set");
	release();
	const outcome = await pending;
	assert.equal(outcome?.ok, true);
	assert.equal((outcome as any).event.data.source, "desktop");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	await settle();
	assert.deepEqual(events, [], "the deferred window finds the state Desktop already reported");

	state = { ...state, mode: "auto" };
	notify();
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	await settle();
	assert.deepEqual(events, [
		{ mode: "auto", previous_mode: "yolo", default_mode: "normal", persisted: false, source: "external" },
	]);

	bridge.reset();
	state = { ...state, mode: "normal" };
	notify();
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	await settle();
	assert.equal(events.length, 1, "reset unsubscribes from the owner");
});

test("the real directory watcher closes itself when its directory is removed", { timeout: 10_000 }, async (t) => {
	// Regression: on Windows a removed watched directory keeps reporting events
	// forever, which kept the process alive after a test (or session) removed it.
	const root = mkdtempSync(join(tmpdir(), "gentle-desktop-watch-real-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "config");
	mkdirSync(dir);
	const seen: Array<string | undefined> = [];
	const close = watchDesktopDirectory(dir, (filename) => seen.push(filename));
	writeFileSync(join(dir, "profiles.json"), "{}\n");
	const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
	for (let index = 0; index < 100 && !seen.includes("profiles.json"); index += 1) await delay(20);
	assert.ok(seen.includes("profiles.json"), "a named owner file event is delivered");

	rmSync(dir, { recursive: true, force: true });
	await delay(500);
	const afterRemoval = seen.length;
	await delay(300);
	assert.equal(seen.length, afterRemoval, "a removed directory stops delivering events");
	if (seen.length > 0 && !seen.slice(-1).includes("profiles.json")) assert.equal(seen.at(-1), undefined);
	close();
	close();
});

// ---- Verifier follow-ups (#3321): knock-on stores, cwd re-target, late directories ----

const worktreeAt = (_path: string, cwd: string) => ({ root: cwd, commonDir: join(cwd, ".git-common") });
const pinFile = (profile: string) => ({ kind: PROFILE_PIN_KIND, version: PROFILE_PIN_VERSION, profile });
function profilesNamed(names: string[], active: string): Record<string, unknown> {
	return {
		kind: PROFILES_KIND,
		version: PROFILES_VERSION,
		active,
		profiles: Object.fromEntries(names.map((name) => [name, { explore: { model: "anthropic/claude-explore" } }])),
	};
}
function scratchRoot(t: test.TestContext, prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

test("a Desktop profiles write that makes a pin stale reports the pin once, as external", (t) => {
	const root = scratchRoot(t, "gentle-desktop-watch-p1-");
	const configHome = join(root, "config");
	const cwd = join(root, "ws");
	mkdirSync(cwd, { recursive: true });
	writeJson(profilesFilePath(configHome), profilesNamed(["team", "ops"], "team"));
	writeJson(repoProfileDeclarationPath(cwd), pinFile("ops"));
	const clock = fakeClock();
	const watches = fakeWatches();
	const bridge = new DesktopConfigBridge(
		{ configHome, agentHome: join(root, "agent"), resolveWorktree: worktreeAt },
		{ watch: watches.factory, timers: clock },
	);
	const events: Array<Record<string, unknown>> = [];
	bridge.attach({ cwd } as unknown as ExtensionContext);
	bridge.wire((_event, data) => events.push(data));

	const read = bridge.handle("get_config", { store: "profiles" }) as any;
	const out = bridge.handle("set_config", {
		store: "profiles",
		data: profilesNamed(["team"], "team"),
		expectedRevision: read.data.writeTargets[0].writeRevision,
	}) as any;
	assert.equal(out.ok, true);
	assert.equal(out.event.data.store, "profiles");
	assert.equal(out.event.data.source, "desktop");

	watches.fire(dirname(profilesFilePath(configHome)), "profiles.json");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	watches.fire(dirname(profilesFilePath(configHome)), "profiles.json");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	// `source` answers "was this a Desktop write to this store": the pin went stale
	// as a consequence, so it is reported once, as external; profiles is not echoed.
	assert.deepEqual(
		events.map((data) => [data.store, data.source, data.status]),
		[["pins", "external", "invalid"]],
	);
	bridge.reset();
});

test("a cwd re-target reports cwd-dependent stores that changed and re-baselines them", (t) => {
	const root = scratchRoot(t, "gentle-desktop-watch-p2-");
	const configHome = join(root, "config");
	const first = join(root, "a");
	const second = join(root, "b");
	writeJson(profilesFilePath(configHome), profilesNamed(["team", "ops"], "team"));
	writeJson(repoProfileDeclarationPath(first), pinFile("ops"));
	mkdirSync(second, { recursive: true });
	const clock = fakeClock();
	const watches = fakeWatches();
	const bridge = new DesktopConfigBridge(
		{ configHome, agentHome: join(root, "agent"), resolveWorktree: worktreeAt },
		{ watch: watches.factory, timers: clock },
	);
	const events: Array<Record<string, unknown>> = [];
	bridge.attach({ cwd: first } as unknown as ExtensionContext);
	bridge.wire((_event, data) => events.push(data));

	bridge.attach({ cwd: second } as unknown as ExtensionContext);
	assert.deepEqual(
		events.map((data) => [data.store, data.source, data.status]),
		[["pins", "external", "missing"]],
		"the pins of the new cwd differ; models and subagents read the same in both",
	);

	// An unrelated external change afterwards reports only itself.
	writeJson(fallbacksFilePath(configHome), { kind: FALLBACKS_KIND, version: FALLBACKS_VERSION, profiles: {} });
	watches.fire(configHome, "profile-fallbacks.json");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.deepEqual(
		events.map((data) => data.store),
		["pins", "profile_fallbacks"],
	);

	// Re-binding the same cwd changes nothing and emits nothing.
	bridge.attach({ cwd: second } as unknown as ExtensionContext);
	assert.equal(events.length, 2);
	bridge.reset();
});

test("a missing owner directory is watched through its nearest existing ancestor and upgraded once created", (t) => {
	const root = scratchRoot(t, "gentle-desktop-watch-late-");
	const target = join(root, "a", "b");
	const clock = fakeClock();
	const watches = fakeWatches();
	let runs = 0;
	const watcher = new DesktopDirectoryWatcher(() => (runs += 1), { watch: watches.factory, timers: clock });
	assert.equal(watcher.start([{ dir: target, names: ["x.json"] }]), 1);
	assert.deepEqual(watches.open().map((watch) => watch.dir), [root], "the nearest existing ancestor, not recursive");

	watches.fire(root, "zzz");
	watches.fire(root, "a");
	assert.deepEqual(watches.open().map((watch) => watch.dir), [root], "no upgrade before the segment exists");

	mkdirSync(join(root, "a"));
	watches.fire(root, "a");
	assert.deepEqual(watches.open().map((watch) => watch.dir), [join(root, "a")], "one level closer; the ancestor watcher is closed");

	mkdirSync(target);
	writeFileSync(join(target, "x.json"), "{}\n");
	watches.fire(join(root, "a"), undefined);
	assert.deepEqual(watches.open().map((watch) => watch.dir), [target], "upgraded to the real directory");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.equal(runs, 1, "the upgrade recomputes once, in case the file was written before the watcher");

	watches.fire(target, "other.json");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.equal(runs, 1);
	watches.fire(target, "x.json");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.equal(runs, 2);

	watcher.dispose();
	assert.deepEqual(watches.open(), []);
	assert.equal(watches.all.length, 3, "one watcher per step, each closed");
});

test("a pending ancestor watcher is closed on dispose", (t) => {
	const root = scratchRoot(t, "gentle-desktop-watch-late-dispose-");
	const clock = fakeClock();
	const watches = fakeWatches();
	let runs = 0;
	const watcher = new DesktopDirectoryWatcher(() => (runs += 1), { watch: watches.factory, timers: clock });
	watcher.start([{ dir: join(root, "later"), names: ["x.json"] }]);
	watcher.dispose();
	assert.deepEqual(watches.open(), []);
	mkdirSync(join(root, "later"));
	for (const watch of watches.all) watch.onChange("later");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.equal(runs, 0);
	assert.deepEqual(watches.open(), [], "a disposed watcher never upgrades");
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
	for (let waited = 0; waited < ms && !condition(); waited += 25) await delay(25);
}

test("real fs.watch: a local pin written into a fresh git-common gentle-ai directory raises exactly one event", { timeout: 20_000 }, async (t) => {
	const root = scratchRoot(t, "gentle-desktop-watch-real-pin-");
	const configHome = join(root, "config");
	const cwd = join(root, "ws");
	mkdirSync(cwd, { recursive: true });
	writeJson(profilesFilePath(configHome), profilesNamed(["team"], "team"));
	const bridge = new DesktopConfigBridge({ configHome, agentHome: join(root, "agent"), resolveWorktree: worktreeAt });
	const events: Array<Record<string, unknown>> = [];
	bridge.attach({ cwd } as unknown as ExtensionContext);
	bridge.wire((_event, data) => events.push(data));
	t.after(() => bridge.reset());
	await delay(100);

	writeJson(localProfilePinPath(join(cwd, ".git-common")), pinFile("team"));
	await waitFor(() => events.length > 0);
	await delay(800);
	assert.deepEqual(events.map((data) => [data.store, data.source, data.status]), [["pins", "external", "ok"]]);
});

// P3 from the verifier probe: real fs.watch and real timers.
test("real fs.watch: rename-replace, Desktop write, delete, recreate, late .pi directory, reset", { timeout: 30_000 }, async (t) => {
	const root = scratchRoot(t, "gentle-desktop-watch-real-p3-");
	const configHome = join(root, "config");
	const cwd = join(root, "ws");
	const agentHome = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentHome, { recursive: true });
	const path = profilesFilePath(configHome);
	writeJson(path, profilesNamed(["team", "ops"], "team"));
	const bridge = new DesktopConfigBridge({ configHome, agentHome, resolveWorktree: worktreeAt });
	const events: Array<Record<string, unknown>> = [];
	bridge.attach({ cwd } as unknown as ExtensionContext);
	bridge.wire((_event, data) => events.push(data));
	t.after(() => bridge.reset());
	await delay(100);
	const since = (start: number) => events.slice(start).map((data) => [data.store, data.status]);

	// Atomic temp + rename replace.
	writeFileSync(`${path}.tmp123`, JSON.stringify(profilesNamed(["team", "ops"], "ops")));
	renameSync(`${path}.tmp123`, path);
	await waitFor(() => events.length > 0);
	await delay(600);
	assert.deepEqual(
		events.map((data) => [data.store, data.source, Object.keys(data).sort().join(",")]),
		[["profiles", "external", "revision,scope,source,status,store"]],
	);

	// A Desktop write is never echoed by the real watcher.
	let start = events.length;
	const read = bridge.handle("get_config", { store: "profiles" }) as any;
	const out = bridge.handle("set_config", {
		store: "profiles",
		data: profilesNamed(["team", "ops"], "team"),
		expectedRevision: read.data.writeTargets[0].writeRevision,
	}) as any;
	assert.equal(out.ok, true);
	await delay(800);
	assert.deepEqual(since(start), []);

	start = events.length;
	unlinkSync(path);
	await waitFor(() => events.length > start);
	await delay(600);
	assert.deepEqual(since(start), [["profiles", "missing"]]);

	start = events.length;
	writeJson(path, profilesNamed(["team"], "team"));
	await waitFor(() => events.length > start);
	await delay(600);
	assert.deepEqual(since(start), [["profiles", "ok"]]);

	// `.pi` did not exist at start: the cwd ancestor watcher upgrades to it.
	start = events.length;
	writeJson(join(cwd, ".pi", "subagents.json"), { agents: {} });
	writeJson(repoProfileDeclarationPath(cwd), pinFile("team"));
	await waitFor(() => new Set(events.slice(start).map((data) => data.store)).size >= 2);
	await delay(800);
	const late = since(start).map(([store]) => store as string);
	assert.deepEqual([...late].sort(), ["pins", "subagents"], "one event per changed store, no duplicates");

	bridge.reset();
	start = events.length;
	writeJson(path, profilesNamed(["ops"], "ops"));
	await delay(600);
	assert.deepEqual(since(start), [], "nothing after reset");
});

// P4 from the verifier probe.
test("an external permission change right after a Desktop set's response is still reported", async () => {
	const clock = fakeClock();
	let state = { mode: "normal", defaultMode: "normal" };
	let notify = () => {};
	const adapter = {
		read: async () => "OFF",
		toggle: async () => {},
		readSnapshot: async () => ({ yolo: "OFF", mode: state.mode, defaultMode: state.defaultMode }),
		setMode: async (mode: string) => {
			state = { ...state, mode };
			notify();
			return true;
		},
		observe: (refresh: () => void) => {
			notify = refresh;
			return () => (notify = () => {});
		},
		dispose: () => {},
	};
	const bridge = new DesktopPermissionBridge({} as ExtensionAPI, async () => adapter as never, { timers: clock });
	const events: Array<Record<string, unknown>> = [];
	bridge.attach({ cwd: "/w" } as unknown as ExtensionContext);
	await bridge.wire((_event, data) => events.push(data));
	const out = (await bridge.handle("set_permission_mode", { mode: "yolo" })) as any;
	assert.equal(out.event.data.source, "desktop");
	state = { ...state, mode: "auto" };
	notify();
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	await settle();
	assert.deepEqual(events, [{ mode: "auto", previous_mode: "yolo", default_mode: "normal", persisted: false, source: "external" }]);

	// A throwing emitter never propagates into the owner observer or the timer.
	const throwing = new DesktopPermissionBridge({} as ExtensionAPI, async () => adapter as never, { timers: clock });
	throwing.attach({ cwd: "/w" } as unknown as ExtensionContext);
	await throwing.wire(() => {
		throw new Error("closed");
	});
	state = { ...state, mode: "normal" };
	assert.doesNotThrow(() => notify());
	assert.doesNotThrow(() => clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS));
	await settle();
	throwing.reset();
	bridge.reset();
});

// P5 from the verifier probe.
test("a permission re-read still in flight when the session resets never emits", async () => {
	const clock = fakeClock();
	let state = { mode: "normal", defaultMode: "normal" };
	let notify = () => {};
	let hold: (() => void) | undefined;
	const adapter = {
		read: async () => "OFF",
		toggle: async () => {},
		readSnapshot: async () => {
			if (hold === undefined && state.mode === "yolo") await new Promise<void>((resolve) => (hold = resolve));
			return { yolo: "OFF", mode: state.mode, defaultMode: state.defaultMode };
		},
		observe: (refresh: () => void) => {
			notify = refresh;
			return () => (notify = () => {});
		},
		dispose: () => {},
	};
	const bridge = new DesktopPermissionBridge({} as ExtensionAPI, async () => adapter as never, { timers: clock });
	const events: Array<Record<string, unknown>> = [];
	bridge.attach({ cwd: "/w" } as unknown as ExtensionContext);
	await bridge.wire((_event, data) => events.push(data));
	state = { ...state, mode: "yolo" };
	notify();
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	await delay(5);
	bridge.reset();
	hold?.();
	await settle();
	assert.deepEqual(events, []);
});

// ---- Native review follow-ups (#3321): pending recompute on re-target, removed directories, wire() rejections ----

test("a change debounced before a cwd re-target is still reported", (t) => {
	const root = scratchRoot(t, "gentle-desktop-watch-r3-");
	const configHome = join(root, "config");
	const first = join(root, "a");
	const second = join(root, "b");
	for (const directory of [first, second]) mkdirSync(directory, { recursive: true });
	writeJson(profilesFilePath(configHome), profilesNamed(["team", "ops"], "team"));
	const clock = fakeClock();
	const watches = fakeWatches();
	const bridge = new DesktopConfigBridge(
		{ configHome, agentHome: join(root, "agent"), resolveWorktree: worktreeAt },
		{ watch: watches.factory, timers: clock },
	);
	const events: Array<Record<string, unknown>> = [];
	bridge.attach({ cwd: first } as unknown as ExtensionContext);
	bridge.wire((_event, data) => events.push(data));

	writeJson(profilesFilePath(configHome), profilesNamed(["team", "ops"], "ops"));
	watches.fire(configHome, "profiles.json");
	// The window has not closed yet when a command binds another cwd.
	bridge.attach({ cwd: second } as unknown as ExtensionContext);
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS * 2);
	assert.deepEqual(
		events.map((data) => [data.store, data.source]),
		[["profiles", "external"]],
		"the pending global change is flushed by the re-target, once",
	);
	bridge.reset();
});

test("a removed owner directory is re-armed through its ancestor and reports its recreation once", (t) => {
	const root = scratchRoot(t, "gentle-desktop-watch-r4-");
	const configHome = join(root, "config");
	const cwd = join(root, "ws");
	mkdirSync(cwd, { recursive: true });
	writeJson(profilesFilePath(configHome), profilesNamed(["team"], "team"));
	const clock = fakeClock();
	const watches = fakeWatches();
	const bridge = new DesktopConfigBridge(
		{ configHome, agentHome: join(root, "agent"), resolveWorktree: worktreeAt },
		{ watch: watches.factory, timers: clock },
	);
	const events: Array<Record<string, unknown>> = [];
	bridge.attach({ cwd } as unknown as ExtensionContext);
	bridge.wire((_event, data) => events.push(data));

	rmSync(configHome, { recursive: true, force: true });
	assert.equal(watches.remove(configHome), 1);
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.deepEqual(events.map((data) => [data.store, data.status]), [["profiles", "missing"]]);
	assert.ok(
		watches.open().some((watch) => watch.dir === root),
		"the nearest existing ancestor watches for the directory to come back",
	);

	mkdirSync(configHome);
	writeJson(profilesFilePath(configHome), profilesNamed(["ops"], "ops"));
	watches.fire(root, "config");
	assert.ok(watches.open().some((watch) => watch.dir === configHome), "upgraded to the recreated directory");
	watches.fire(configHome, "profiles.json");
	clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
	assert.deepEqual(
		events.slice(1).map((data) => [data.store, data.source, data.status]),
		[["profiles", "external", "ok"]],
		"exactly one event for the recreated store",
	);
	bridge.reset();
	assert.deepEqual(watches.open(), []);
});

test("wire() never rejects when the permission owner throws, and leaves no external events", async () => {
	const clock = fakeClock();
	let notify: (() => void) | undefined;
	const adapter = {
		read: async () => "OFF",
		toggle: async () => {},
		get readSnapshot(): never {
			throw new Error("owner torn down");
		},
		observe: (refresh: () => void) => {
			notify = refresh;
			return () => (notify = undefined);
		},
		dispose: () => {},
	};
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const bridge = new DesktopPermissionBridge({} as ExtensionAPI, async () => adapter as never, { timers: clock });
		const events: unknown[] = [];
		bridge.attach({ cwd: "/w" } as unknown as ExtensionContext);
		await assert.doesNotReject(bridge.wire((_event, data) => events.push(data)));
		notify?.();
		clock.advance(DESKTOP_CHANGE_DEBOUNCE_MS);
		await settle();
		assert.deepEqual(events, []);

		const failing = new DesktopPermissionBridge(
			{} as ExtensionAPI,
			(() => {
				throw new Error("discovery exploded");
			}) as never,
			{ timers: clock },
		);
		failing.attach({ cwd: "/w" } as unknown as ExtensionContext);
		await assert.doesNotReject(failing.wire(() => {}));
		bridge.reset();
		failing.reset();
		await settle();
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});
