import assert from "node:assert/strict";
import nodeTest from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import gentleVoice from "../extensions/gentle-voice.ts";
import { VoiceInstallError, type VoiceInstallProgress, type VoiceInstallResult } from "../lib/voice-install.ts";
import { VoiceSessionError, type VoiceSessionState, type VoiceTranscript } from "../lib/voice-session.ts";
import { VOICE_COMMAND_NAME, type VoiceCommandDeps, type VoiceDictation } from "../lib/voice-command.ts";
import type { PushToTalkTimers } from "../lib/voice-push-to-talk.ts";

// /gentle:voice through its registered command, with fake UI, acquisition and
// session adapters: nothing here downloads, loads native code or opens a
// microphone.

type Handler = (event: unknown, ctx: unknown) => unknown;
type Component = { render(width: number): string[]; handleInput?(data: string): void };

// A broken lifecycle shows up as a hang; fail it instead of waiting forever.
const test = (name: string, fn: () => Promise<void>) => nodeTest(name, { timeout: 5_000 }, fn);

const ENTER = "\r";
const ESC = "\x1b";
const VOICE_HOME = "/home/user/.pi/gentle-ai/voice";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function until(check: () => boolean, attempts = 200) {
	for (let attempt = 0; attempt < attempts && !check(); attempt++) await tick();
	assert.ok(check(), "condition not reached");
}

function fakePi() {
	const commands = new Map<string, { description: string; handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
	const handlers = new Map<string, Handler[]>();
	const counts = { tools: 0, sends: 0 };
	const pi = {
		registerCommand: (name: string, registration: { description: string; handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) => commands.set(name, registration),
		registerTool: () => { counts.tools++; },
		registerShortcut: () => { counts.tools++; },
		sendUserMessage: () => { counts.sends++; },
		sendMessage: () => { counts.sends++; },
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	} as unknown as ExtensionAPI;
	const fire = async (event: string, ctx: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
	};
	return { pi, commands, handlers, counts, fire };
}

interface UiScript {
	select?: (title: string, options: string[]) => string | undefined;
	confirm?: (title: string, message: string) => boolean;
}

function fakeContext(script: UiScript = {}, mode = "tui", hasUI = true) {
	const notices: Array<{ message: string; type?: string }> = [];
	const selects: Array<{ title: string; options: string[] }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	const events: string[] = [];
	const renders: Array<boolean | undefined> = [];
	let editor = "draft: ";
	let component: Component | undefined;
	let open = false;
	const listeners: Array<(data: string) => { consume?: boolean; data?: string } | undefined> = [];
	const statuses: Array<string | undefined> = [];
	const terminal = { subscribes: 0, unsubscribes: 0 };
	const tui = { terminal: { rows: 30, columns: 100 }, requestRender: (force?: boolean) => renders.push(force) };
	const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		hasUI,
		mode,
		cwd: "/work/alpha",
		ui: {
			notify: (message: string, type?: string) => { notices.push({ message, type }); events.push(`notify:${message}`); },
			select: async (title: string, options: string[]) => { selects.push({ title, options }); return script.select?.(title, options); },
			confirm: async (title: string, message: string) => { confirms.push({ title, message }); return script.confirm?.(title, message) ?? false; },
			custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => Component) =>
				new Promise((resolve) => {
					open = true;
					events.push("open");
					component = factory(tui, theme, {}, (value) => { open = false; events.push("close"); resolve(value); });
				}),
			pasteToEditor: (text: string) => { editor += text; events.push(`paste:${text}`); },
			getEditorText: () => editor,
			setEditorText: (text: string) => { editor = text; },
			onTerminalInput: (listener: (data: string) => { consume?: boolean; data?: string } | undefined) => {
				terminal.subscribes++;
				listeners.push(listener);
				return () => {
					const index = listeners.indexOf(listener);
					if (index >= 0) { listeners.splice(index, 1); terminal.unsubscribes++; }
				};
			},
			setStatus: (key: string, text: string | undefined) => { if (key === "gentle-voice") statuses.push(text); },
		},
	} as unknown as ExtensionCommandContext;
	// Raw input as Pi's TUI routes it: listeners first, then the focused editor,
	// which appends text and treats DEL as Backspace.
	const type = (data: string) => {
		let current = data;
		for (const listener of [...listeners]) {
			const result = listener(current);
			if (result?.consume) return;
			if (result?.data !== undefined) current = result.data;
		}
		if (current === "\x7f") editor = editor.slice(0, -1);
		else editor += current;
	};
	return { ctx, notices, selects, confirms, events, renders, statuses, terminal, type, editor: () => editor, component: () => component, open: () => open };
}

class FakeSession implements VoiceDictation {
	state: VoiceSessionState = "idle";
	readonly calls: string[] = [];
	readonly started = deferred<void>();
	readonly result = deferred<VoiceTranscript>();
	readonly onStateChange: (state: VoiceSessionState) => void;
	constructor(onStateChange: (state: VoiceSessionState) => void) {
		this.onStateChange = onStateChange;
		this.result.promise.catch(() => {});
	}
	emit(state: VoiceSessionState) {
		this.state = state;
		this.onStateChange(state);
	}
	async start() {
		this.calls.push("start");
		this.emit("starting");
		await this.started.promise;
		this.emit("recording");
	}
	async stop() {
		this.calls.push("stop");
		if (this.state === "recording") this.emit("transcribing");
		const transcript = await this.result.promise;
		this.emit("finished");
		return transcript;
	}
	async cancel() {
		this.calls.push("cancel");
		this.emit("finished");
	}
}

function manualClock() {
	let now = 0;
	let nextId = 1;
	const pending = new Map<number, { at: number; callback: () => void }>();
	const timers: PushToTalkTimers = {
		setTimeout: (callback, ms) => {
			const id = nextId++;
			pending.set(id, { at: now + ms, callback });
			return id;
		},
		clearTimeout: (handle) => { pending.delete(handle as number); },
		now: () => now,
		// Runs right after the timer that deferred it, as setImmediate would with no queued input.
		defer: (callback) => { deferred.push(callback); },
	};
	const deferred: Array<() => void> = [];
	const advance = (ms: number) => {
		const target = now + ms;
		for (;;) {
			let due: [number, { at: number; callback: () => void }] | undefined;
			for (const entry of pending) if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
			if (!due) break;
			pending.delete(due[0]);
			now = due[1].at;
			due[1].callback();
			while (deferred.length > 0) deferred.shift()!();
		}
		now = target;
	};
	return { timers, advance };
}

interface Harness {
	deps: VoiceCommandDeps;
	calls: string[];
	sessions: FakeSession[];
	installs: Array<{ kind: string; options: Record<string, unknown> }>;
	settings: { enabled: boolean; reads: number; writes: boolean[] };
	clock: ReturnType<typeof manualClock>;
}

function harness(overrides: { platform?: string; arch?: string; installed?: boolean; install?: (kind: "runtime" | "model", options: { signal: AbortSignal; onProgress(progress: VoiceInstallProgress): void }) => Promise<VoiceInstallResult>; env?: NodeJS.ProcessEnv; pushToTalk?: boolean } = {}): Harness {
	const calls: string[] = [];
	const sessions: FakeSession[] = [];
	const installs: Harness["installs"] = [];
	// The toggle store is always faked: no test reads or writes the real config home.
	const settings = { enabled: overrides.pushToTalk ?? false, reads: 0, writes: [] as boolean[] };
	const clock = manualClock();
	const state = overrides.installed ? "installed" : "missing";
	const install = overrides.install ?? (async (kind) => ({ kind, path: `${VOICE_HOME}/${kind}`, alreadyInstalled: false }));
	const deps: VoiceCommandDeps = {
		env: overrides.env ?? {},
		probe: () => { calls.push("probe"); return { platform: overrides.platform ?? "darwin", arch: overrides.arch ?? "arm64" }; },
		readStatus: async (target) => {
			calls.push(`status:${target}`);
			return { voiceHome: VOICE_HOME, model: { kind: "model", state, path: `${VOICE_HOME}/models/m` }, runtime: { kind: "runtime", state, path: `${VOICE_HOME}/runtime/r` } };
		},
		installRuntime: async (options) => { calls.push("install:runtime"); installs.push({ kind: "runtime", options: options as unknown as Record<string, unknown> }); return install("runtime", options); },
		installModel: async (options) => { calls.push("install:model"); installs.push({ kind: "model", options: options as unknown as Record<string, unknown> }); return install("model", options); },
		createSession: (options) => {
			calls.push(`session:${options.target}`);
			const session = new FakeSession(options.onStateChange);
			sessions.push(session);
			return session;
		},
		settings: {
			read: () => { settings.reads++; return settings.enabled; },
			write: (enabled) => { settings.writes.push(enabled); settings.enabled = enabled; },
		},
		pushToTalk: { timers: clock.timers },
	};
	return { deps, calls, sessions, installs, settings, clock };
}

const pick = (pattern: RegExp) => (_title: string, options: string[]) => options.find((option) => pattern.test(option));

function register(h: Harness) {
	const pi = fakePi();
	gentleVoice(pi.pi, h.deps);
	return pi;
}

async function run(pi: ReturnType<typeof fakePi>, ui: ReturnType<typeof fakeContext>) {
	return pi.commands.get(VOICE_COMMAND_NAME)!.handler("", ui.ctx);
}

// --- registration and refusals ------------------------------------------------

test("registers only /gentle:voice and does no voice work at registration or session start", async () => {
	const h = harness();
	const pi = register(h);
	assert.equal(VOICE_COMMAND_NAME, "gentle:voice");
	assert.deepEqual([...pi.commands.keys()], ["gentle:voice"]);
	assert.match(pi.commands.get(VOICE_COMMAND_NAME)!.description, /dictation/i);
	assert.equal(pi.counts.tools, 0, "no model-callable tool or shortcut");
	await pi.fire("session_start");
	assert.deepEqual(h.calls, []);
});

test("a delegated child session refuses before any probe, status read or UI", async () => {
	const h = harness({ env: { GENTLE_PI_AGENTS_CHILD: "1" }, installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/dictat/i) });
	await run(pi, ui);
	assert.deepEqual(h.calls, []);
	assert.equal(ui.selects.length, 0);
	assert.match(ui.notices[0]!.message, /delegated/i);
	assert.equal(ui.editor(), "draft: ");
	assert.equal(pi.counts.sends, 0);
});

test("non-TUI modes refuse without voice work", async () => {
	for (const [mode, hasUI] of [["rpc", true], ["print", false]] as const) {
		const h = harness({ installed: true });
		const pi = register(h);
		const ui = fakeContext({ select: pick(/dictat/i) }, mode, hasUI);
		await run(pi, ui);
		assert.deepEqual(h.calls, [], mode);
		assert.equal(ui.selects.length, 0, mode);
		assert.equal(ui.editor(), "draft: ", mode);
	}
});

test("an unsupported platform is explained and offers no download", async () => {
	const h = harness({ platform: "win32", arch: "arm64" });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	await run(pi, ui);
	assert.deepEqual(h.calls, ["probe"]);
	assert.equal(ui.selects.length, 0);
	assert.match(ui.notices[0]!.message, /Windows ARM64/);
	assert.equal(ui.notices[0]!.type, "error");
});

// --- installation -------------------------------------------------------------

test("a missing install offers the download and declining it downloads nothing", async () => {
	const h = harness({ platform: "win32", arch: "x64" });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => false });
	await run(pi, ui);
	assert.ok(!ui.selects[0]!.options.some((option) => /start dictation/i.test(option)), "dictation needs an install first");
	const { message } = ui.confirms[0]!;
	assert.match(message, /MB/);
	assert.ok(message.includes(VOICE_HOME), "names the destination");
	assert.match(message, /CC-BY-4\.0/);
	assert.match(message, /NVIDIA/);
	assert.match(message, /Apache-2\.0/);
	assert.match(message, /Visual C\+\+/);
	assert.match(message, /not .*installed by Gentle AI|never (downloads|installs)/i);
	assert.ok(!h.calls.some((call) => call.startsWith("install:")));
	assert.equal(ui.editor(), "draft: ");
});

test("an accepted download installs runtime then model with progress and pinned defaults", async () => {
	const gate = deferred<void>();
	const h = harness({
		install: async (kind, options) => {
			options.onProgress({ component: kind, phase: "download", item: kind === "model" ? "encoder.int8.onnx" : "node-cpal", receivedBytes: 50, totalBytes: 100, overallReceivedBytes: 50, overallTotalBytes: 100 });
			if (kind === "model") await gate.promise;
			return { kind, path: `${VOICE_HOME}/${kind}`, alreadyInstalled: false };
		},
	});
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	const done = run(pi, ui);
	await until(() => h.calls.includes("install:model"));
	assert.ok(ui.open());
	const screen = ui.component()!.render(80).join("\n");
	assert.match(screen, /50%/);
	assert.match(screen, /encoder\.int8\.onnx/);
	assert.match(screen, /esc/i);
	gate.resolve();
	await done;
	assert.deepEqual(h.calls.filter((call) => call.startsWith("install:")), ["install:runtime", "install:model"]);
	for (const install of h.installs) {
		assert.ok(install.options.signal instanceof AbortSignal);
		for (const key of ["manifest", "manifests", "fetch"]) assert.equal(key in install.options, false, `${install.kind} gets no ${key} override`);
	}
	assert.equal(h.installs[0]!.options.target, "darwin-arm64");
	assert.ok(!ui.open());
	assert.match(ui.notices.at(-1)!.message, /installed/i);
	assert.equal(ui.editor(), "draft: ");
});

test("Esc during a download aborts it and keeps nothing", async () => {
	const h = harness({
		install: (_kind, options) =>
			new Promise((_resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(new VoiceInstallError("aborted", "raw /secret/path")), { once: true });
			}),
	});
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	const done = run(pi, ui);
	await until(() => h.calls.includes("install:runtime") && ui.open());
	ui.component()!.handleInput!(ESC);
	await done;
	assert.equal((h.installs[0]!.options.signal as AbortSignal).aborted, true);
	assert.ok(!h.calls.includes("install:model"));
	assert.ok(!ui.open());
	assert.match(ui.notices.at(-1)!.message, /cancelled/i);
	assert.ok(!ui.notices.some((notice) => notice.message.includes("/secret/path")), "fixed messages only");
});

test("a failed download reports a fixed message without raw error text", async () => {
	const h = harness({ install: async () => { throw new VoiceInstallError("integrity", "encoder at /home/user/x does not match"); } });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	await run(pi, ui);
	const last = ui.notices.at(-1)!;
	assert.equal(last.type, "error");
	assert.match(last.message, /digest|verif/i);
	assert.ok(!last.message.includes("/home/user/x"));
	assert.ok(!ui.open());
});

// --- dictation ----------------------------------------------------------------

async function startDictation(h: Harness, pi: ReturnType<typeof fakePi>, ui: ReturnType<typeof fakeContext>) {
	const done = run(pi, ui);
	await until(() => h.sessions.length === 1 && ui.open());
	const session = h.sessions[0]!;
	session.started.resolve();
	await until(() => session.state === "recording");
	return { done, session };
}

test("Enter stops recording, closes the overlay and pastes the exact transcript into the draft", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	assert.match(ui.component()!.render(80).join("\n"), /recording/i);
	ui.component()!.handleInput!(ENTER);
	await until(() => session.calls.includes("stop"));
	assert.match(ui.component()!.render(80).join("\n"), /transcrib/i);
	assert.ok(ui.open(), "stays open until the transcript settles");
	session.result.resolve({ text: "hola canción", truncated: false });
	await done;
	assert.equal(ui.editor(), "draft: hola canción");
	assert.ok(ui.events.indexOf("close") < ui.events.indexOf("paste:hola canción"), "closes before pasting");
	assert.equal(pi.counts.sends, 0, "never submits");
	assert.deepEqual(session.calls, ["start", "stop"]);
});

test("Esc while recording cancels the session and leaves the draft untouched", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	ui.component()!.handleInput!(ESC);
	await done;
	session.result.resolve({ text: "late text", truncated: false });
	await tick();
	assert.ok(session.calls.includes("cancel"));
	assert.ok(!ui.open());
	assert.equal(ui.editor(), "draft: ");
	assert.equal(pi.counts.sends, 0);
	assert.ok(!ui.events.some((event) => event.startsWith("paste:")));
});

test("the recording limit transcribes by itself and delivers without a key press", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	session.emit("transcribing");
	session.result.resolve({ text: "limit reached", truncated: true });
	session.emit("finished");
	await done;
	assert.ok(!ui.open());
	assert.equal(ui.editor(), "draft: limit reached");
	assert.match(ui.notices.map((notice) => notice.message).join("\n"), /limit/i);
});

test("a session failure shows its fixed message with a user action and pastes nothing", async () => {
	const h = harness({ installed: true, platform: "linux", arch: "x64" });
	h.deps.probe = () => ({ platform: "linux", arch: "x64", glibcVersion: "2.39" });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const done = run(pi, ui);
	await until(() => h.sessions.length === 1);
	h.sessions[0]!.started.reject(new VoiceSessionError("runtime-load"));
	await done;
	const last = ui.notices.at(-1)!;
	assert.equal(last.type, "error");
	assert.match(last.message, /could not be loaded/);
	assert.match(last.message, /libasound|ALSA/);
	assert.ok(!ui.open());
	assert.equal(ui.editor(), "draft: ");
});

test("a second /gentle:voice while one is active is refused with a notice", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	const second = fakeContext({ select: pick(/start dictation/i) });
	await run(pi, second);
	assert.equal(h.sessions.length, 1, "no parallel session");
	assert.match(second.notices[0]!.message, /already/i);
	ui.component()!.handleInput!(ENTER);
	session.result.resolve({ text: "one", truncated: false });
	await done;
	// The lock is released once the first run settles.
	const third = fakeContext({ select: () => undefined });
	await run(pi, third);
	assert.equal(third.selects.length, 1);
});

test("session shutdown cancels an active dictation and drops a late transcript", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	ui.component()!.handleInput!(ENTER);
	await until(() => session.calls.includes("stop"));
	await pi.fire("session_shutdown");
	session.result.resolve({ text: "too late", truncated: false });
	await done;
	await tick();
	assert.ok(session.calls.includes("cancel"));
	assert.ok(!ui.open());
	assert.equal(ui.editor(), "draft: ");
	assert.equal(pi.counts.sends, 0);
	// The state observer stays safe after teardown.
	assert.doesNotThrow(() => session.onStateChange("finished"));
});

test("session shutdown aborts an active download", async () => {
	const h = harness({
		install: (_kind, options) =>
			new Promise((_resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(new VoiceInstallError("aborted", "cancelled")), { once: true });
			}),
	});
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	const done = run(pi, ui);
	await until(() => h.calls.includes("install:runtime") && ui.open());
	await pi.fire("session_shutdown");
	await done;
	assert.equal((h.installs[0]!.options.signal as AbortSignal).aborted, true);
	assert.ok(!ui.open());
	assert.ok(!h.calls.includes("install:model"));
});

test("status reports the target, both components and the unverified hardware state", async () => {
	const h = harness({ platform: "linux", arch: "arm64" });
	h.deps.probe = () => ({ platform: "linux", arch: "arm64", glibcVersion: "2.35", wsl: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/status/i) });
	await run(pi, ui);
	const message = ui.notices.at(-1)!.message;
	assert.match(message, /linux-arm64/);
	assert.match(message, /unproven/i);
	assert.match(message, /model: missing/i);
	assert.match(message, /runtime: missing/i);
	assert.match(message, /not been verified on hardware/);
	assert.match(message, /libasound/);
	assert.ok(!h.calls.some((call) => call.startsWith("install:") || call.startsWith("session:")));
});

test("a transcript that arrives while cancelling is dropped", async () => {
	const h = harness({ installed: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	const { done, session } = await startDictation(h, pi, ui);
	ui.component()!.handleInput!(ENTER);
	await until(() => session.calls.includes("stop"));
	// As with the real worker, the result line can land before the process closes.
	session.cancel = async () => {
		session.calls.push("cancel");
		session.result.resolve({ text: "raced", truncated: false });
		await tick();
		session.emit("finished");
	};
	ui.component()!.handleInput!(ESC);
	await done;
	assert.equal(ui.editor(), "draft: ");
	assert.ok(!ui.events.some((event) => event.startsWith("paste:")));
});

// --- push-to-talk (hold Space) ------------------------------------------------

const SPACE = " ";
const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 40;
const RELEASE = 250;

async function startSession(pi: ReturnType<typeof fakePi>, ui: ReturnType<typeof fakeContext>) {
	await pi.fire("session_start", ui.ctx);
}

// Space pressed and held: the first space, then `repeats` OS auto-repeats.
function holdSpace(h: Harness, ui: ReturnType<typeof fakeContext>, repeats: number, first = true) {
	if (first) ui.type(SPACE);
	for (let index = 0; index < repeats; index++) {
		h.clock.advance(first && index === 0 ? REPEAT_DELAY : REPEAT_INTERVAL);
		ui.type(SPACE);
	}
}

// Holds Space until a dictation is recording, as on the very first hold of a
// session: the install check runs lazily while the spaces are still typed.
async function holdUntilRecording(h: Harness, ui: ReturnType<typeof fakeContext>) {
	holdSpace(h, ui, 4);
	await until(() => h.calls.some((call) => call.startsWith("status:")));
	await tick();
	holdSpace(h, ui, 1, false);
	assert.equal(h.sessions.length, 1, "the hold started one dictation");
	holdSpace(h, ui, 4, false);
	const session = h.sessions[0]!;
	session.started.resolve();
	await until(() => session.state === "recording");
	return session;
}

test("startup arms push-to-talk only when enabled, reading the toggle and nothing else", async () => {
	const enabled = harness({ installed: true, pushToTalk: true });
	const pi = register(enabled);
	const ui = fakeContext();
	await startSession(pi, ui);
	assert.equal(ui.terminal.subscribes, 1);
	assert.equal(enabled.settings.reads, 1);
	assert.deepEqual(enabled.calls, [], "no probe, status read, download or session at startup");

	const disabled = harness({ installed: true });
	const off = register(disabled);
	const typing = fakeContext();
	await startSession(off, typing);
	assert.equal(typing.terminal.subscribes, 0, "no listener when disabled");
	holdSpace(disabled, typing, 6);
	typing.type("a");
	assert.equal(typing.editor(), `draft: ${SPACE.repeat(7)}a`, "typing is unchanged");
	assert.deepEqual(disabled.calls, []);
});

test("child sessions and non-TUI modes never arm or read the toggle", async () => {
	const child = harness({ installed: true, pushToTalk: true, env: { GENTLE_PI_AGENTS_CHILD: "1" } });
	const childPi = register(child);
	const childUi = fakeContext();
	await startSession(childPi, childUi);
	assert.equal(childUi.terminal.subscribes, 0);
	for (const [mode, hasUI] of [["rpc", true], ["print", false]] as const) {
		const h = harness({ installed: true, pushToTalk: true });
		const pi = register(h);
		const ui = fakeContext({}, mode, hasUI);
		await startSession(pi, ui);
		assert.equal(ui.terminal.subscribes, 0, mode);
		assert.equal(h.settings.reads, 0, mode);
	}
	assert.equal(child.settings.reads, 0);
});

test("holding Space records, releasing it pastes the transcript into the draft and never sends", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	const session = await holdUntilRecording(h, ui);
	assert.equal(ui.editor(), "draft: ", "every space typed by the hold was erased");
	assert.match(ui.statuses.at(-1) ?? "", /recording/i);
	assert.ok(!ui.open(), "no overlay steals the editor focus");
	h.clock.advance(RELEASE);
	await until(() => session.calls.includes("stop"));
	assert.match(ui.statuses.at(-1) ?? "", /transcrib/i);
	session.result.resolve({ text: "hola mundo", truncated: false });
	await until(() => ui.editor() === "draft: hola mundo");
	await until(() => ui.statuses.at(-1) === undefined);
	assert.equal(pi.counts.sends, 0);
	assert.deepEqual(session.calls, ["start", "stop"]);
	assert.deepEqual(h.calls.filter((call) => call === "probe").length, 1, "the install is checked once per session");
	// The lock is free again: a second hold starts a second dictation directly.
	holdSpace(h, ui, 4);
	assert.equal(h.sessions.length, 2);
});

test("a release before recording starts stops as soon as recording begins", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	holdSpace(h, ui, 4);
	await until(() => h.calls.some((call) => call.startsWith("status:")));
	await tick();
	holdSpace(h, ui, 1, false);
	const session = h.sessions[0]!;
	h.clock.advance(RELEASE);
	assert.ok(!session.calls.includes("stop"));
	session.started.resolve();
	await until(() => session.calls.includes("stop"));
	session.result.resolve({ text: "short", truncated: false });
	await until(() => ui.editor().endsWith("short"));
});

test("Esc during a hold cancels the dictation and leaves the draft unchanged", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	const session = await holdUntilRecording(h, ui);
	ui.type(ESC);
	await until(() => session.calls.includes("cancel"));
	session.result.resolve({ text: "dropped", truncated: false });
	await until(() => ui.statuses.at(-1) === undefined);
	await tick();
	assert.equal(ui.editor(), "draft: ", "Esc was consumed and nothing was pasted");
	assert.match(ui.notices.at(-1)!.message, /cancelled/i);
	h.clock.advance(RELEASE);
	assert.ok(!session.calls.includes("stop"));
});

test("not installed: the hold types its spaces, notifies once and disarms", async () => {
	const h = harness({ pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	holdSpace(h, ui, 4);
	await until(() => ui.notices.length > 0);
	holdSpace(h, ui, 3, false);
	assert.equal(ui.editor(), `draft: ${SPACE.repeat(8)}`, "all eight spaces typed normally");
	assert.equal(h.sessions.length, 0);
	assert.match(ui.notices[0]!.message, /\/gentle:voice/);
	assert.equal(ui.terminal.unsubscribes, 1, "disarmed");
	h.clock.advance(RELEASE);
	holdSpace(h, ui, 4);
	assert.equal(ui.notices.length, 1, "notified once");
	assert.equal(h.settings.writes.length, 0, "the saved choice is kept");
});

test("a hold while /gentle:voice is dictating does not start a second session", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/start dictation/i) });
	await startSession(pi, ui);
	const { done, session } = await startDictation(h, pi, ui);
	holdSpace(h, ui, 6);
	await tick();
	assert.equal(h.sessions.length, 1);
	assert.equal(ui.editor(), `draft: ${SPACE.repeat(7)}`, "spaces pass through");
	ui.component()!.handleInput!(ENTER);
	session.result.resolve({ text: "one", truncated: false });
	await done;
});

test("session shutdown cancels a held dictation, disarms and drops a late transcript", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	const session = await holdUntilRecording(h, ui);
	await pi.fire("session_shutdown");
	assert.equal(ui.terminal.unsubscribes, 1);
	await until(() => session.calls.includes("cancel"));
	session.result.resolve({ text: "too late", truncated: false });
	await tick();
	await tick();
	assert.equal(ui.editor(), "draft: ");
	h.clock.advance(RELEASE);
	assert.ok(!session.calls.includes("stop"));
});

test("the /gentle:voice menu toggles push-to-talk, persists it and arms or disarms immediately", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext({ select: pick(/disable push-to-talk/i) });
	await startSession(pi, ui);
	await run(pi, ui);
	assert.ok(ui.selects[0]!.options.includes("Disable push-to-talk (hold Space)"));
	assert.deepEqual(h.settings.writes, [false]);
	assert.equal(ui.terminal.unsubscribes, 1);
	holdSpace(h, ui, 4);
	assert.equal(h.sessions.length, 0, "disarmed in the live session");

	const again = fakeContext({ select: pick(/enable push-to-talk/i) });
	await run(pi, again);
	assert.ok(again.selects[0]!.options.includes("Enable push-to-talk (hold Space)"));
	assert.deepEqual(h.settings.writes, [false, true]);
	assert.equal(again.terminal.subscribes, 1, "armed in the live session");
	// A reload reads the persisted choice.
	const reloaded = register(h);
	const fresh = fakeContext();
	await startSession(reloaded, fresh);
	assert.equal(fresh.terminal.subscribes, 1);
});

test("Enable is offered only when voice is installed", async () => {
	const h = harness();
	const pi = register(h);
	const ui = fakeContext({ select: () => undefined });
	await run(pi, ui);
	assert.ok(!ui.selects[0]!.options.some((option) => /push-to-talk/i.test(option)));
});

test("a successful download enables push-to-talk and arms it", async () => {
	const h = harness();
	const pi = register(h);
	const ui = fakeContext({ select: pick(/download/i), confirm: () => true });
	await startSession(pi, ui);
	await run(pi, ui);
	assert.deepEqual(h.settings.writes, [true]);
	assert.equal(ui.terminal.subscribes, 1);
	assert.match(ui.notices.at(-1)!.message, /hold Space/i);
	// Already known installed: the first hold starts directly.
	holdSpace(h, ui, 4);
	assert.equal(h.sessions.length, 1);
});

test("a hold right after a word keeps one space before the pasted transcript", async () => {
	const h = harness({ installed: true, pushToTalk: true });
	const pi = register(h);
	const ui = fakeContext();
	await startSession(pi, ui);
	ui.type("hi");
	const session = await holdUntilRecording(h, ui);
	assert.equal(ui.editor(), "draft: hi ");
	h.clock.advance(RELEASE);
	await until(() => session.calls.includes("stop"));
	session.result.resolve({ text: "there", truncated: false });
	await until(() => ui.editor() === "draft: hi there");
});
