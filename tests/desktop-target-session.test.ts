import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The session the Gentle Shell Desktop window is about (herdr/mods/*/snapshot.js targetSession).
// Every gentle-* mod carries its own byte-identical copy, so each copy is loaded and checked, with
// a fake `herdr` host module: Herdr's focus, agents, terminals and shared state are set per case.

const MODS = fileURLToPath(new URL("../herdr/mods/", import.meta.url));
const copies = readdirSync(MODS).filter((m) => readdirSync(join(MODS, m)).includes("snapshot.js")).sort();

type Host = {
	focused: Record<string, unknown> | null;
	agents: Array<Record<string, unknown>>;
	terminals: Array<Record<string, unknown>>;
	panes: Array<Record<string, unknown>>;
	shared: Map<string, unknown>;
};
const host = globalThis as unknown as { __herdrHost: Host };

const scratch = mkdtempSync(join(tmpdir(), "gentle-target-session-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
writeFileSync(join(scratch, "package.json"), JSON.stringify({ type: "module" }));
mkdirSync(join(scratch, "node_modules", "herdr"), { recursive: true });
writeFileSync(join(scratch, "node_modules", "herdr", "package.json"), JSON.stringify({ name: "herdr", type: "module", exports: "./index.js" }));
writeFileSync(
	join(scratch, "node_modules", "herdr", "index.js"),
	`const h = () => globalThis.__herdrHost;
export const focused = () => h().focused;
export const agents = () => h().agents;
export const terminals = () => h().terminals;
export const panes = () => h().panes;
export const shared = (k) => h().shared.get(k) ?? null;
export const setShared = (k, v) => { h().shared.set(k, v); };
export const home = () => "/home/test";
export const layout = () => null;
export const watchFolder = () => {};
export const exec = async () => ({ stdout: "", stderr: "", code: 0 });
export const run = () => {};
`,
);

type Snapshot = {
	targetSession: (feeds: unknown[], last: string | null) => { key: string; terminal: unknown } | null;
	SESSION_KEY: string;
};
const load = async (mod: string): Promise<Snapshot> => {
	mkdirSync(join(scratch, mod), { recursive: true });
	copyFileSync(join(MODS, mod, "snapshot.js"), join(scratch, mod, "snapshot.js"));
	return import(pathToFileURL(join(scratch, mod, "snapshot.js")).href);
};

// A Gentle Shell TUI running in another terminal (no Herdr terminal of this window matches it).
const tuiFeed = { identity: { agentDir: "/home/test/.gentle-shell/agent", sessionId: "tui-1", pid: 9001, ppid: 9000 } };
const tuiKey = "/home/test/.gentle-shell/agent|tui-1";

// Herdr's window: tab "tab-plain" holds a plain shell (t9); tab "tab-gentle" runs Gentle Shell (t2).
const reset = (focused: Host["focused"]) => {
	host.__herdrHost = {
		focused,
		agents: [{ address: "t2", app: "gentle-shell", tab: "tab-gentle" }],
		terminals: [
			{ address: "t9", pid: 501 },
			{ address: "t2", pid: 502, agent: "gentle-shell" },
		],
		panes: [{ terminal: "t9" }, { terminal: "t2" }],
		shared: new Map(),
	};
};
const focusPlainTab = { space: "sp1", tab: "tab-plain", pane: "p9", terminal: "t9", agent: null };

assert.ok(copies.length > 0, "no gentle-* mod carries snapshot.js");

for (const mod of copies) {
	test(`${mod}: a Herdr tab with no Gentle Shell session shows no session, not the last one shown`, async () => {
		const { targetSession } = await load(mod);
		reset(focusPlainTab);
		assert.equal(targetSession([tuiFeed], tuiKey), null);
		assert.equal(targetSession([tuiFeed], null), null);
	});

	test(`${mod}: a picked TUI session stays shown while Herdr's focus does not move`, async () => {
		const { targetSession, SESSION_KEY } = await load(mod);
		reset(focusPlainTab);
		host.__herdrHost.shared.set(SESSION_KEY, { key: tuiKey, focus: "t9", at: 1 });
		assert.equal(targetSession([tuiFeed], null)?.key, tuiKey);
	});

	test(`${mod}: a Herdr tab running Gentle Shell shows its session while a mod pane has the focus`, async () => {
		const { targetSession } = await load(mod);
		reset({ space: "sp1", tab: "tab-gentle", pane: "chat", terminal: null, agent: null });
		assert.equal(targetSession([tuiFeed], tuiKey)?.key, "terminal|t2");
	});

	test(`${mod}: with no focused Herdr tab the last session shown, else the newest, stays shown`, async () => {
		const { targetSession } = await load(mod);
		reset(null);
		assert.equal(targetSession([tuiFeed], tuiKey)?.key, tuiKey);
		assert.equal(targetSession([tuiFeed], null)?.key, "terminal|t2");
	});
}
