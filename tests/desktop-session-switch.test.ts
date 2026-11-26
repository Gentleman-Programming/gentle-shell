import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// What the chat (herdr/mods/gentle-chat) and the inspector (herdr/mods/gentle-inspector) do when
// the window switches to another session. The real mods are loaded with fake host modules: `herdr`
// (Herdr's focus, agents, terminals, shared state and actions), `gpui-kit` / `gpui-base` (drawing,
// kept as the strings drawn) and `fs/promises` (file reads a case can hold, as a slow read would).

const MODS = new URL("../herdr/mods/", import.meta.url).href;
const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const delegate = (names: string[]) => `const h = () => globalThis.__modHost;\n${names.map((n) => `export const ${n} = (...a) => h().${n}(...a);`).join("\n")}`;
const FAKES: Record<string, string> = {
	herdr: moduleUrl(delegate(["agents", "terminals", "panes", "focused", "props", "layout", "home", "hc", "run", "exec", "shared", "setShared", "theme", "fonts", "settings", "watchFolder", "nextCommand", "openOverlay", "readTextFile", "writeTextFile"])),
	"fs/promises": moduleUrl(delegate(["readFile", "readdir", "exists"])),
	"gpui-kit": moduleUrl(`${delegate(["div", "svg"])}\nexport class View {}`),
	"gpui-base": moduleUrl(`${delegate(["v_flex", "h_flex", "TextView", "Textarea", "Popover"])}
export const ScrollHandle = { new: () => globalThis.__modHost.div() };
export const TextareaState = { new: () => {
  let value = "";
  return { on() {}, set_auto_grow() {}, focus() {}, set_selected_range() {}, value: () => value, set_value: (v) => { value = v; } };
} };`),
};
registerHooks({
	resolve(specifier, context, next) {
		if (FAKES[specifier] && context.parentURL?.startsWith(MODS)) return { url: FAKES[specifier], shortCircuit: true };
		return next(specifier, context);
	},
});

const HOME = "/home/test";
const AGENT = `${HOME}/.gentle-shell/agent`;
const never = () => new Promise<never>(() => {});
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A session snapshot (docs/desktop-feed.md) and a transcript line.
const feedOf = (id: string, pid: number, cwd: string, sessionFile?: string) => ({
	schema: "gentle-shell.desktop-feed/v1",
	updatedAt: "2026-11-26T00:00:00.000Z",
	identity: { agentDir: AGENT, sessionId: id, pid, ppid: 1, cwd, ...(sessionFile ? { sessionFile } : {}) },
});
const line = (text: string) => `${JSON.stringify({ type: "compaction", summary: text })}\n`;

type View = Record<string, any>;
type Cx = Record<string, any>;

// Herdr's window and this computer's files: `feeds` as the status bar's reader published them,
// `files` the readable files, `dirs` the existing folders (the sessions' desktop inboxes). Every
// `hc` call, file write and drawn string is kept.
function makeHost({ agents, terminals, feeds, files = {}, dirs = [] }: {
	agents: Array<Record<string, unknown>>;
	terminals: Array<Record<string, unknown>>;
	feeds: unknown[];
	files?: Record<string, string>;
	dirs?: string[];
}) {
	const shared = new Map<string, unknown>([["gentle-shell.feeds", { feeds }], ["gentle-shell.feeds.digest", "d1"]]);
	const holds = new Map<string, { reached: () => void; gate: Promise<void> }>();
	const timers: Array<{ ms: number; fn: (cx: Cx) => void }> = [];
	const errors: unknown[] = [];
	const drawn: string[] = [];
	const draw = (...args: unknown[]) => {
		for (const a of args) if (typeof a === "string") drawn.push(a);
		return element;
	};
	// Any element and any chain of its builder calls; `.when(cond, fn)` applies fn when cond holds.
	const when = (cond: unknown, fn: (el: unknown) => unknown) => (cond ? fn(element) : element);
	const element: any = new Proxy(function () {}, {
		get: (_t, k) => (k === "then" ? undefined : k === "when" ? when : element),
		apply: (_t, _self, args) => draw(...args),
	});
	const host = {
		focused: null as Record<string, unknown> | null,
		shared,
		hcCalls: [] as string[][],
		written: [] as string[],
		drawn,
		errors,
		// Holds the next read of `path` until release(); `reached` resolves once the mod asked for it.
		hold(path: string) {
			let reached!: () => void;
			let release!: () => void;
			const asked = new Promise<void>((resolve) => { reached = resolve; });
			holds.set(path, { reached, gate: new Promise<void>((resolve) => { release = resolve; }) });
			return { reached: asked, release: () => release() };
		},
		show(terminal: string, tab: string) {
			host.focused = { space: "sp1", tab, pane: `p-${terminal}`, terminal, agent: terminal };
		},
		// The host's context: timers wait for flush(), spawned work starts at once.
		cx: {
			notify() {}, propagate() {}, stop_propagation() {}, bind_keys() {},
			focus_handle: () => element,
			sleep: async () => {},
			spawn(fn: (cx: Cx) => Promise<unknown>) { Promise.resolve(fn(host.cx)).catch((e) => errors.push(e)); },
			timer: {
				after(ms: number, fn: (cx: Cx) => void) { timers.push({ ms, fn }); return { cancel() {} }; },
				every() { return { cancel() {} }; },
			},
		} as Cx,
		// Runs the 1 ms timers set so far: a mod's "in the next host call".
		flush() {
			for (const t of timers.splice(0).filter((t) => t.ms === 1)) t.fn(host.cx);
		},
	};
	// What the fake `herdr`, `fs/promises`, `gpui-kit` and `gpui-base` modules export.
	const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
	const api = {
		agents: () => agents,
		terminals: () => terminals,
		panes: () => terminals.map((t) => ({ terminal: t.address })),
		focused: () => host.focused,
		props: () => ({}),
		layout: () => null,
		home: () => HOME,
		hc: async (args: string[]) => { host.hcCalls.push(args); return { code: 0, stdout: "", stderr: "" }; },
		run: () => null,
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
		shared: (k: string) => shared.get(k) ?? null,
		setShared: (k: string, v: unknown) => { shared.set(k, v); },
		theme: () => ({}),
		fonts: () => [],
		settings: () => ({}),
		watchFolder: never,
		nextCommand: never,
		openOverlay: () => "overlay",
		readTextFile: async () => null,
		writeTextFile: async (path: string) => { host.written.push(path); },
		readFile: async (path: string, encoding?: string) => {
			const hold = holds.get(path);
			if (hold) { holds.delete(path); hold.reached(); await hold.gate; }
			if (!(path in files)) throw enoent(path);
			return encoding ? files[path] : Buffer.from(files[path]);
		},
		readdir: async (path: string) => { throw enoent(path); },
		exists: async (path: string) => dirs.includes(path),
		div: draw, svg: draw, v_flex: draw, h_flex: draw, TextView: draw, Textarea: draw, Popover: draw,
	};
	const g = globalThis as unknown as { __modHost: unknown; localStorage: unknown };
	g.__modHost = api;
	g.localStorage = { getItem: () => null, setItem() {} };
	return host;
}

const open = async (mod: string, host: ReturnType<typeof makeHost>) => {
	const { default: View } = await import(`${MODS}${mod}/main.js`);
	const view: View = new View();
	view.init({}, host.cx);
	return view;
};

// Two Gentle Shell sessions in Herdr tabs of this window: A in t1 (tab-a), B in t2 (tab-b).
const A = { key: `${AGENT}|a`, file: "/work/a/a.jsonl", settings: "/work/a/.pi/settings.json" };
const B = { key: `${AGENT}|b`, file: "/work/b/b.jsonl", settings: "/work/b/.pi/settings.json" };
const twoSessions = () => makeHost({
	agents: [{ address: "t1", app: "gentle-shell", tab: "tab-a" }, { address: "t2", app: "gentle-shell", tab: "tab-b" }],
	terminals: [{ address: "t1", pid: 601, agent: "gentle-shell" }, { address: "t2", pid: 602, agent: "gentle-shell" }],
	feeds: [feedOf("a", 601, "/work/a", A.file), feedOf("b", 602, "/work/b", B.file)],
	files: { [A.file]: line("from A"), [B.file]: line("from B") },
	dirs: [`${AGENT}/desktop/inbox/a`, `${AGENT}/desktop/inbox/b`],
});
const shownText = (chat: View) => JSON.stringify(chat.feed.items);

test("gentle-chat: Send and profile Apply go to the session the window shows while the previous one's read stalls", async () => {
	const host = twoSessions();
	host.show("t1", "tab-a");
	const read = host.hold(A.file);
	const chat = await open("gentle-chat", host);
	await read.reached;
	chat.input.set_value("first");
	chat.send(host.cx);
	await settle();

	host.show("t2", "tab-b");
	chat.follow(host.cx);
	host.flush();
	chat.input.set_value("hello");
	chat.send(host.cx);
	chat.applyProfile("fast", host.cx);
	await settle();
	assert.deepEqual(host.hcCalls, [["send", "t1", "first"], ["send", "t2", "hello"]]);
	assert.deepEqual(host.written.map((p) => p.slice(0, p.lastIndexOf("/"))), [`${AGENT}/desktop/inbox/b`]);

	read.release();
	await settle();
	assert.equal(chat.key, B.key);
	assert.equal(chat.file, B.file);
	assert.match(shownText(chat), /from B/);
	assert.doesNotMatch(shownText(chat), /from A/);
	assert.deepEqual(host.errors, []);
});

test("gentle-chat: a refresh that ends after the switch never shows its session under the new one", async () => {
	const host = twoSessions();
	host.show("t1", "tab-a");
	const readA = host.hold(A.settings);
	const readB = host.hold(B.settings);
	const chat = await open("gentle-chat", host);
	await readA.reached;

	host.show("t2", "tab-b");
	chat.follow(host.cx);
	host.flush();
	readA.release();
	await settle();
	assert.notEqual(chat.file, A.file);
	assert.doesNotMatch(shownText(chat), /from A/);

	readB.release();
	await settle();
	assert.equal(chat.file, B.file);
	assert.match(shownText(chat), /from B/);
	assert.deepEqual(host.errors, []);
});

test("gentle-inspector: a refusal stays with its session and is gone once another session shows", async () => {
	const refusal = "Open that session's terminal to run /commands.";
	// A: a Gentle Shell TUI in another terminal (no Herdr terminal here); B: one in tab-b (t2).
	const host = makeHost({
		agents: [{ address: "t2", app: "gentle-shell", tab: "tab-b" }],
		terminals: [{ address: "t2", pid: 602, agent: "gentle-shell" }],
		feeds: [feedOf("a", 9001, "/work/a"), feedOf("b", 602, "/work/b")],
	});
	host.show("t2", "tab-b");
	host.shared.set("gentle-shell.session", { key: A.key, focus: "t2", at: 1 }); // A picked in the sidebar
	const inspector = await open("gentle-inspector", host);
	const render = () => { host.drawn.length = 0; inspector.render(host.cx); return host.drawn; };

	render();
	inspector.command("agent-1", "/gentle:agents", host.cx);
	assert.ok(render().includes(refusal));
	assert.ok(render().includes(refusal), "the refusal stays while its session shows");

	host.shared.set("gentle-shell.session", null); // B's tab clicked: Herdr's focus decides again
	assert.ok(!render().includes(refusal));
	assert.deepEqual(host.errors, []);
});
