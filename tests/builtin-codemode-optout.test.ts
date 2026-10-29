import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import quietTools from "../extensions/quiet-tools.ts";
import {
	BUILTIN_CODEMODE_OPTOUT_ENTRY,
	builtinCodemodeOptOutStatePath,
	offerBuiltinCodemodeOptOut,
	withBuiltinExtensionExcluded,
} from "../lib/builtin-codemode-optout.ts";

// gentle-pi replaces Pi's builtin codemode with its compact renderer, so Pi
// warns at every startup. In a user-owned Pi home gentle-pi may only add the
// `-builtin:codemode` opt-out after the user accepts a one-time prompt.

type Prompt = { title: string; message: string };

function fixture(t: TestContext, settings?: string) {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-codemode-optout-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const configHome = join(root, "gentle-ai");
	mkdirSync(agentDir, { recursive: true });
	const settingsPath = join(agentDir, "settings.json");
	if (settings !== undefined) writeFileSync(settingsPath, settings);
	return { root, agentDir, configHome, settingsPath };
}

function interactive(answer: boolean, mode: "tui" | "rpc" | "print" | "json" = "tui", hasUI = true) {
	const prompts: Prompt[] = [];
	const notices: string[] = [];
	const ctx = {
		hasUI,
		mode,
		ui: {
			async confirm(title: string, message: string) { prompts.push({ title, message }); return answer; },
			notify(message: string) { notices.push(message); },
		},
	};
	return { ctx, prompts, notices };
}

function extensionHarness(settings: Record<string, unknown> = {}) {
	const tools: ToolDefinition[] = [];
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const pi = {
		registerTool(tool: ToolDefinition) { tools.push(tool); },
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		getSettings() { return { codemode: { mode: "on" }, ...settings }; },
		getAllTools() { return []; },
		appendEntry() {},
	} as unknown as ExtensionAPI;
	const startSession = async (ctx: unknown) => {
		for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, { sessionManager: {}, ...(ctx as object) });
		// The offer runs detached from session_start; let it settle.
		await new Promise((resolve) => setImmediate(resolve));
	};
	return { pi, tools, startSession };
}

const read = (path: string) => readFileSync(path, "utf8");

test("the pure edit appends the opt-out and keeps every other key, indentation, and trailing newline", () => {
	for (const [indent, newline] of [[4, "\n"], ["\t", "\n"], [undefined, ""]] as const) {
		const original = { theme: "rose", extensions: ["./ext/a.ts", "!./ext/b.ts"], packages: ["npm:gentle-pi"] };
		const text = `${JSON.stringify(original, null, indent)}${newline}`;
		const expected = { ...original, extensions: [...original.extensions, BUILTIN_CODEMODE_OPTOUT_ENTRY] };
		assert.equal(withBuiltinExtensionExcluded(text), `${JSON.stringify(expected, null, indent)}${newline}`);
	}
	assert.equal(withBuiltinExtensionExcluded('{"theme":"rose"}'), '{"theme":"rose","extensions":["-builtin:codemode"]}');
});

test("the pure edit refuses explicit entries, malformed JSON, non-object settings, and non-array extensions", () => {
	for (const entry of ["+builtin:codemode", "!builtin:codemode", "builtin:codemode", "-builtin:codemode"]) {
		assert.equal(withBuiltinExtensionExcluded(JSON.stringify({ extensions: [entry] })), undefined, entry);
	}
	for (const text of ["{ not json", "[]", "null", "42", '{"extensions":"oops"}']) {
		assert.equal(withBuiltinExtensionExcluded(text), undefined, text);
	}
});

test("accepting the prompt appends the opt-out to the agent settings.json and says when the warning goes away", async (t) => {
	const original = `${JSON.stringify({ theme: "rose", extensions: ["./ext/a.ts"], packages: ["npm:gentle-pi"] }, null, 2)}\n`;
	const f = fixture(t, original);
	const { ctx, prompts, notices } = interactive(true);

	const outcome = await offerBuiltinCodemodeOptOut(ctx, { agentDir: f.agentDir, configHome: f.configHome, effectiveExtensions: ["./ext/a.ts"] });
	assert.equal(outcome, "accepted");
	assert.equal(prompts.length, 1);
	assert.match(prompts[0]!.message, /compact/);
	assert.match(prompts[0]!.message, /-builtin:codemode/);
	assert.match(prompts[0]!.message, /Nothing is written unless you accept/);
	assert.ok(prompts[0]!.message.includes(f.settingsPath));
	const expected = { theme: "rose", extensions: ["./ext/a.ts", "-builtin:codemode"], packages: ["npm:gentle-pi"] };
	assert.equal(read(f.settingsPath), `${JSON.stringify(expected, null, 2)}\n`);
	assert.match(notices.join("\n"), /next launch/);

	// The entry is now explicit: a second session neither prompts nor writes.
	const second = interactive(true);
	assert.equal(await offerBuiltinCodemodeOptOut(second.ctx, { agentDir: f.agentDir, configHome: f.configHome, effectiveExtensions: expected.extensions }), "explicit-entry");
	assert.equal(second.prompts.length, 0);
	assert.equal(read(f.settingsPath), `${JSON.stringify(expected, null, 2)}\n`);
});

test("declining writes nothing to settings.json and is remembered so the next session does not ask", async (t) => {
	const original = '{"theme":"rose"}';
	const f = fixture(t, original);
	const first = interactive(false);
	assert.equal(await offerBuiltinCodemodeOptOut(first.ctx, { agentDir: f.agentDir, configHome: f.configHome }), "declined");
	assert.equal(first.prompts.length, 1);
	assert.equal(read(f.settingsPath), original);
	assert.ok(existsSync(builtinCodemodeOptOutStatePath(f.configHome)));
	assert.match(first.notices.join("\n"), /-builtin:codemode/);

	const second = interactive(true);
	assert.equal(await offerBuiltinCodemodeOptOut(second.ctx, { agentDir: f.agentDir, configHome: f.configHome }), "declined-before");
	assert.equal(second.prompts.length, 0);
	assert.equal(read(f.settingsPath), original);
});

test("a decline for one agent dir does not silence the prompt for another", async (t) => {
	const a = fixture(t, "{}");
	const b = fixture(t, "{}");
	assert.equal(await offerBuiltinCodemodeOptOut(interactive(false).ctx, { agentDir: a.agentDir, configHome: a.configHome }), "declined");
	const other = interactive(false);
	assert.equal(await offerBuiltinCodemodeOptOut(other.ctx, { agentDir: b.agentDir, configHome: a.configHome }), "declined");
	assert.equal(other.prompts.length, 1);
});

test("any explicit builtin:codemode entry in the file or the effective settings means no prompt and no write", async (t) => {
	for (const entry of ["+builtin:codemode", "!builtin:codemode", "builtin:codemode", "-builtin:codemode"]) {
		const fileText = JSON.stringify({ extensions: ["./ext/a.ts", entry] });
		const inFile = fixture(t, fileText);
		const fromFile = interactive(true);
		assert.equal(await offerBuiltinCodemodeOptOut(fromFile.ctx, { agentDir: inFile.agentDir, configHome: inFile.configHome }), "explicit-entry", entry);
		assert.equal(fromFile.prompts.length, 0);
		assert.equal(read(inFile.settingsPath), fileText);

		// A project-level entry surfaces only through the effective settings.
		const effective = fixture(t, "{}");
		const fromEffective = interactive(true);
		assert.equal(await offerBuiltinCodemodeOptOut(fromEffective.ctx, { agentDir: effective.agentDir, configHome: effective.configHome, effectiveExtensions: [entry] }), "explicit-entry", entry);
		assert.equal(fromEffective.prompts.length, 0);
		assert.equal(read(effective.settingsPath), "{}");
	}
});

test("malformed, non-object, or non-array-extensions settings are never prompted for or rewritten", async (t) => {
	for (const text of ["{ not json", "[]", '{"extensions":"oops"}']) {
		const f = fixture(t, text);
		const { ctx, prompts } = interactive(true);
		assert.equal(await offerBuiltinCodemodeOptOut(ctx, { agentDir: f.agentDir, configHome: f.configHome }), "unwritable", text);
		assert.equal(prompts.length, 0);
		assert.equal(read(f.settingsPath), text);
	}
});

test("a missing settings.json is not created and no prompt is shown", async (t) => {
	const f = fixture(t);
	const { ctx, prompts } = interactive(true);
	assert.equal(await offerBuiltinCodemodeOptOut(ctx, { agentDir: f.agentDir, configHome: f.configHome }), "unwritable");
	assert.equal(prompts.length, 0);
	assert.equal(existsSync(f.settingsPath), false);
});

test("a symlinked settings.json stays a symlink and its target receives the opt-out", async (t) => {
	const f = fixture(t);
	const dotfiles = join(f.root, "dotfiles");
	mkdirSync(dotfiles);
	const target = join(dotfiles, "pi-settings.json");
	writeFileSync(target, '{\n  "theme": "rose"\n}\n');
	symlinkSync(target, f.settingsPath);

	const { ctx } = interactive(true);
	assert.equal(await offerBuiltinCodemodeOptOut(ctx, { agentDir: f.agentDir, configHome: f.configHome }), "accepted");
	assert.ok(lstatSync(f.settingsPath).isSymbolicLink());
	assert.equal(readlinkSync(f.settingsPath), target);
	assert.equal(read(target), '{\n  "theme": "rose",\n  "extensions": [\n    "-builtin:codemode"\n  ]\n}\n');
});

test("without an interactive TUI there is no prompt, no write, and no remembered decline", async (t) => {
	for (const [mode, hasUI] of [["tui", false], ["rpc", true], ["print", false], ["json", false]] as const) {
		const f = fixture(t, "{}");
		const { ctx, prompts } = interactive(true, mode, hasUI);
		assert.equal(await offerBuiltinCodemodeOptOut(ctx, { agentDir: f.agentDir, configHome: f.configHome }), "no-ui", mode);
		assert.equal(prompts.length, 0);
		assert.equal(read(f.settingsPath), "{}");
		assert.equal(existsSync(builtinCodemodeOptOutStatePath(f.configHome)), false);
	}
});

test("a failing dialog never escapes and writes nothing", async (t) => {
	const f = fixture(t, "{}");
	const ctx = { hasUI: true, mode: "tui", ui: { async confirm(): Promise<boolean> { throw new Error("dialog closed"); }, notify() {} } };
	assert.equal(await offerBuiltinCodemodeOptOut(ctx, { agentDir: f.agentDir, configHome: f.configHome }), "failed");
	assert.equal(read(f.settingsPath), "{}");
});

test("quiet-tools always registers the compact codemode and offers the opt-out once per process from session_start", async (t) => {
	const f = fixture(t, "{}");
	const { pi, tools, startSession } = extensionHarness();
	await quietTools(pi, undefined, { agentDir: f.agentDir, configHome: f.configHome });
	assert.ok(tools.some((tool) => tool.name === "codemode"), "compact codemode must stay registered");

	const declined = interactive(false);
	await startSession(declined.ctx);
	assert.equal(declined.prompts.length, 1);
	assert.equal(read(f.settingsPath), "{}");

	// A later session_start in the same process (e.g. /new) does not ask again.
	const again = interactive(true);
	await startSession(again.ctx);
	assert.equal(again.prompts.length, 0);
});

test("quiet-tools reads explicit entries from the effective settings and stays silent without a TUI", async (t) => {
	for (const [settings, session] of [
		[{ extensions: ["+builtin:codemode"] }, interactive(true)],
		[{}, interactive(true, "rpc")],
		[{}, interactive(true, "tui", false)],
	] as const) {
		const f = fixture(t, "{}");
		const { pi, tools, startSession } = extensionHarness(settings);
		await quietTools(pi, undefined, { agentDir: f.agentDir, configHome: f.configHome });
		assert.ok(tools.some((tool) => tool.name === "codemode"));
		await startSession(session.ctx);
		assert.equal(session.prompts.length, 0);
		assert.equal(read(f.settingsPath), "{}");
	}
});

test("quiet-tools accepts the opt-out end to end", async (t) => {
	const f = fixture(t, '{"theme":"rose"}\n');
	const { pi, tools, startSession } = extensionHarness();
	await quietTools(pi, undefined, { agentDir: f.agentDir, configHome: f.configHome });
	assert.ok(tools.some((tool) => tool.name === "codemode"));
	await startSession(interactive(true).ctx);
	assert.equal(read(f.settingsPath), '{"theme":"rose","extensions":["-builtin:codemode"]}\n');
});
