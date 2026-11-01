import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, ProgramStatus, TUI } from "@earendil-works/pi-tui";
import { createProgramIdentityExtension } from "../extensions/gentle-program-identity.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => void;
type Widget = Component & { dispose?: () => void };
function harness(env: NodeJS.ProcessEnv = { PI_PROGRAM_STATUS_APP: "gentle-shell" }, initial: ProgramStatus = { state: "idle", app: "pi" }) {
	const handlers = new Map<string, Handler>();
	const reports: ProgramStatus[] = [];
	const terminal = {
		programStatus: initial as ProgramStatus | undefined,
		setProgramStatus(status: ProgramStatus) {
			assert.equal(this, terminal);
			this.programStatus = status.state === "clear" ? undefined : status;
			reports.push(status);
		},
	};
	let widget: Widget | undefined;
	let widgets = 0;
	const ctx = {
		mode: "tui", hasUI: true,
		ui: { setWidget(_key: string, factory: ((tui: TUI) => Widget) | undefined) {
			widget?.dispose?.();
			widget = factory?.({ terminal } as unknown as TUI);
			widgets++;
		} },
	} as unknown as ExtensionContext;
	createProgramIdentityExtension(env)({ on: (name: string, fn: Handler) => handlers.set(name, fn) } as unknown as ExtensionAPI);
	return { terminal, reports, ctx, widgets: () => widgets, component: () => widget,
		fire: (name: string, context = ctx) => handlers.get(name)?.({}, context) };
}

test("corrects the cached startup identity without inventing or changing native state", () => {
	for (const initial of [
		{ state: "idle", app: "pi" },
		{ state: "working", app: "pi", message: "Compacting context" },
		{ state: "blocked", app: "pi", kind: "auth", message: "Log in" },
	] satisfies ProgramStatus[]) {
		const h = harness(undefined, initial);
		h.fire("session_start");
		assert.deepEqual(h.reports, [{ ...initial, app: "gentle-shell" }]);
		assert.deepEqual(initial.app, "pi");
		assert.deepEqual(h.component()?.render(80), []);
		h.fire("session_shutdown");
	}
});

test("forwards every native state unchanged apart from app and preserves clear", () => {
	const h = harness(); h.fire("session_start");
	for (const status of [
		{ state: "working", app: "pi", message: "Session name" },
		{ state: "blocked", app: "pi", kind: "permission", message: "Allow command?" },
		{ state: "done", app: "pi", message: "Session name" },
		{ state: "error", app: "pi", message: "Failure" },
		{ state: "idle", app: "pi" },
		{ state: "clear" },
	] satisfies ProgramStatus[]) {
		const snapshot = { ...status };
		h.terminal.setProgramStatus(status);
		assert.deepEqual(h.reports.at(-1), status.state === "clear" ? status : { ...status, app: "gentle-shell" });
		assert.deepEqual(status, snapshot);
	}
	h.fire("session_shutdown");
});

test("plain Pi, delegated children and non-TUI modes retain their previous terminal behavior", () => {
	for (const [env, mode, hasUI] of [
		[{}, "tui", true],
		[{ PI_PROGRAM_STATUS_APP: "another-app" }, "tui", true],
		[{ PI_PROGRAM_STATUS_APP: "gentle-shell", GENTLE_PI_AGENTS_CHILD: "1" }, "tui", true],
		[{ PI_PROGRAM_STATUS_APP: "gentle-shell" }, "rpc", true],
		[{ PI_PROGRAM_STATUS_APP: "gentle-shell" }, "json", false],
		[{ PI_PROGRAM_STATUS_APP: "gentle-shell" }, "print", false],
		[{ PI_PROGRAM_STATUS_APP: "gentle-shell" }, "tui", false],
	] as const) {
		const h = harness(env);
		const original = h.terminal.setProgramStatus;
		h.fire("session_start", { ...h.ctx, mode, hasUI } as ExtensionContext);
		assert.equal(h.terminal.setProgramStatus, original);
		assert.equal(h.widgets(), 0);
		assert.deepEqual(h.reports, []);
		h.terminal.setProgramStatus({ state: "working", app: "pi" });
		assert.deepEqual(h.reports, [{ state: "working", app: "pi" }]);
	}
});

test("widget disposal, repeated shutdown and session replacement restore the original method", () => {
	const h = harness();
	const original = h.terminal.setProgramStatus;
	h.fire("session_start");
	assert.notEqual(h.terminal.setProgramStatus, original);
	h.fire("session_start");
	const count = h.reports.length;
	h.terminal.setProgramStatus({ state: "done", app: "pi", message: "latest" });
	assert.equal(h.reports.length, count + 1);
	assert.equal(h.reports.at(-1)?.app, "gentle-shell");
	h.component()?.dispose?.();
	assert.equal(h.terminal.setProgramStatus, original);
	h.fire("session_shutdown"); h.fire("session_shutdown");
	assert.equal(h.terminal.setProgramStatus, original);
	h.terminal.setProgramStatus({ state: "idle", app: "pi" });
	assert.deepEqual(h.reports.at(-1), { state: "idle", app: "pi" });
	h.fire("session_start");
	assert.deepEqual(h.reports.at(-1), { state: "idle", app: "gentle-shell" });
	h.fire("session_shutdown");
});

test("cleanup leaves a later terminal wrapper installed and removes only its own rewrite", () => {
	const h = harness(); h.fire("session_start");
	const inner = h.terminal.setProgramStatus;
	const outer = (status: ProgramStatus) => inner.call(h.terminal, { ...status, message: "other extension" });
	h.terminal.setProgramStatus = outer;
	h.fire("session_shutdown");
	assert.equal(h.terminal.setProgramStatus, outer);
	h.terminal.setProgramStatus({ state: "working", app: "pi" });
	assert.deepEqual(h.reports.at(-1), { state: "working", app: "pi", message: "other extension" });
});

test("real Pi reporter and terminal emit the corrected startup and native states, respecting disabled reporting", () => {
	const root = fileURLToPath(new URL("..", import.meta.url));
	const home = mkdtempSync(join(tmpdir(), "program-identity-"));
	const script = `
		import { ProcessTerminal } from "@earendil-works/pi-tui";
		import { createProgramIdentityExtension } from "./extensions/gentle-program-identity.ts";
		const { ProgramStatusReporter } = await import(new URL("./modes/interactive/program-status-reporter.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
		const chunks = [];
		const write = process.stdout.write.bind(process.stdout);
		process.stdout.write = (data) => { chunks.push(String(data)); return true; };
		const terminal = new ProcessTerminal();
		const reporter = new ProgramStatusReporter(() => terminal, () => "Example");
		const handlers = new Map();
		let widget;
		const ctx = { mode: "tui", hasUI: true, ui: { setWidget(_key, factory) {
			widget?.dispose?.(); widget = factory?.({ terminal });
		} } };
		createProgramIdentityExtension()({ on: (name, fn) => handlers.set(name, fn) });
		terminal.start(() => {}, () => {});
		reporter.report();
		const initial = chunks.splice(0).join("");
		handlers.get("session_start")?.({}, ctx);
		const startup = chunks.splice(0).join("");
		reporter.handleEvent({ type: "agent_start" });
		reporter.setBlocked("dialog", { kind: "permission", message: "Allow?" });
		reporter.setBlocked("dialog", undefined);
		reporter.handleEvent({ type: "agent_settled", aborted: false });
		reporter.handleEvent({ type: "agent_start" });
		reporter.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Failure\\nDetails" } });
		reporter.handleEvent({ type: "agent_settled", aborted: false });
		reporter.reset();
		const states = chunks.splice(0).join("");
		handlers.get("session_shutdown")?.({}, ctx);
		terminal.stop(); process.stdin.pause();
		process.stdout.write = write;
		console.log(JSON.stringify({ initial, startup, states }));
	`;
	const reports = (text: string) => [...text.matchAll(/\x1b\]7501;([^\x1b\x07]*)(?:\x1b\\|\x07)/g)]
		.map((match) => Object.fromEntries(match[1].split(":").map((pair) => {
			const index = pair.indexOf("="); return [pair.slice(0, index), pair.slice(index + 1)];
		})));
	try {
		for (const [app, enabled] of [["gentle-shell", "1"], [undefined, "1"], ["gentle-shell", "0"]]) {
			const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
				cwd: root, encoding: "utf8", timeout: 5000,
				env: { HOME: home, USERPROFILE: home, PATH: dirname(process.execPath), NODE_NO_WARNINGS: "1",
					PI_PROGRAM_STATUS: enabled, PI_PROGRAM_STATUS_APP: app },
			});
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stderr, "");
			const output = JSON.parse(result.stdout);
			if (enabled === "0") {
				assert.deepEqual([reports(output.initial), reports(output.startup), reports(output.states)], [[], [], []]);
				continue;
			}
			assert.deepEqual(reports(output.initial), [{ state: "idle", app: "pi" }]);
			assert.deepEqual(reports(output.startup), app ? [{ state: "idle", app }] : []);
			const identity = app ?? "pi";
			const msg = (text: string) => Buffer.from(text).toString("base64");
			assert.deepEqual(reports(output.states), [
				{ state: "working", app: identity, msg: msg("Example") },
				{ state: "blocked", app: identity, kind: "permission", msg: msg("Allow?") },
				{ state: "working", app: identity, msg: msg("Example") },
				{ state: "done", app: identity, msg: msg("Example") },
				{ state: "working", app: identity, msg: msg("Example") },
				{ state: "error", app: identity, msg: msg("Failure") },
				{ state: "idle", app: identity },
			]);
		}
	} finally { rmSync(home, { recursive: true, force: true }); }
});
