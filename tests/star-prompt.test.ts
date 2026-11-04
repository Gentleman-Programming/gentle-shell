import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createStarPromptExtension } from "../extensions/gentle-star-prompt.ts";
import {
	DEFAULT_STAR_PROMPT_STATE,
	DISMISS_CHORD,
	PROMPTS_BEFORE_ASKING,
	STAR_CHORD,
	STAR_PROMPT_IDLE_MS,
	STAR_PROMPT_VISIBLE_MS,
	ghStarred,
	readStarPromptState,
	shouldOfferStarPrompt,
	writeStarPromptState,
	type StarPromptState,
} from "../lib/star-prompt.ts";

// ---------- lib: state ----------

test("star prompt state: a missing file reads as fresh defaults and stays usable", () => {
	const dir = join(tmpdir(), `star-prompt-${Date.now()}-${Math.random()}`);
	try {
		const read = readStarPromptState(dir);
		assert.equal(read.unusable, false);
		assert.equal(read.state.sent, 0);
		assert.equal(read.state.dismissed, false);
	} finally {
		rm(dir, { recursive: true, force: true }).catch(() => {});
	}
});

test("star prompt state: malformed JSON fails closed as unusable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "star-prompt-"));
	try {
		await writeFile(join(dir, "star-prompt.json"), "{not json");
		const read = readStarPromptState(dir);
		assert.equal(read.malformed, true);
		assert.equal(read.unusable, true);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("star prompt state: valid content round-trips", async () => {
	const dir = await mkdtemp(join(tmpdir(), "star-prompt-"));
	try {
		writeStarPromptState(dir, { schema: "gentle-shell.star-prompt/v1", sent: 7, dismissed: true });
		const raw = JSON.parse(await readFile(join(dir, "star-prompt.json"), "utf8"));
		assert.equal(raw.sent, 7);
		const read = readStarPromptState(dir);
		assert.equal(read.unusable, false);
		assert.equal(read.state.sent, 7);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// ---------- lib: decision ----------

test("decision: silent through the threshold, eligible from sent + 1", () => {
	const base = { sent: 0, dismissed: false, unusable: false, offeredThisSession: false, agentRunning: false };
	for (let sent = 0; sent <= PROMPTS_BEFORE_ASKING; sent++) {
		assert.equal(shouldOfferStarPrompt({ ...base, sent }), false, `sent=${sent}`);
	}
	assert.equal(shouldOfferStarPrompt({ ...base, sent: PROMPTS_BEFORE_ASKING + 1 }), true);
});

test("decision: dismissal, unusable state, already offered, or a running agent blocks the offer", () => {
	const base = { sent: PROMPTS_BEFORE_ASKING + 1, dismissed: false, unusable: false, offeredThisSession: false, agentRunning: false };
	assert.equal(shouldOfferStarPrompt({ ...base, dismissed: true }), false);
	assert.equal(shouldOfferStarPrompt({ ...base, unusable: true }), false);
	assert.equal(shouldOfferStarPrompt({ ...base, offeredThisSession: true }), false);
	assert.equal(shouldOfferStarPrompt({ ...base, agentRunning: true }), false);
});

// ---------- harness ----------

const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

interface OfferRow {
	render(width: number): string[];
	handleMouse(event: never): unknown;
	dispose?(): void;
}

interface HarnessOptions {
	state?: unknown;
	unusable?: boolean;
	writeState?: (_configHome: string, state: StarPromptState) => void;
	ghStarOutcome?: "yes" | "unknown";
}

function harness(options: HarnessOptions = {}) {
	const handlers = new Map<string, Set<(event: any, ctx: ExtensionContext) => unknown>>();
	const on = (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
		if (!handlers.has(event)) handlers.set(event, new Set());
		handlers.get(event)!.add(handler);
		return () => handlers.get(event)!.delete(handler);
	};
	const pi = { on } as unknown as ExtensionAPI;

	const statuses: Array<string | undefined> = [];
	const notes: string[] = [];
	let terminalHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
	let widget: OfferRow | undefined;
	let renders = 0;
	const tui = { requestRender: () => void renders++ };
	const ctx = {
		ui: {
			theme,
			setStatus: (_key: string, text: string | undefined) => statuses.push(text),
			// The offer row: wide enough here that the offer text is never truncated.
			setWidget: (_key: string, factory: ((tui: unknown, theme: unknown) => OfferRow) | undefined, options?: { placement?: string }) => {
				widget?.dispose?.();
				widget = factory?.(tui, theme);
				if (widget) assert.equal(options?.placement, "belowEditor");
				statuses.push(widget?.render(400).join("\n"));
			},
			notify: (message: string) => notes.push(message),
			onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
				terminalHandler = handler;
				return () => {
					terminalHandler = undefined;
				};
			},
		},
	} as unknown as ExtensionContext;

	const written: Array<{ sent: number; dismissed: boolean }> = [];
	let clock = 1_000_000;
	const scheduled: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
	const schedule = (ms: number, fn: () => void) => {
		const timer = { ms, fn, cancelled: false };
		scheduled.push(timer);
		return { cancel: () => void (timer.cancelled = true) };
	};
	const advance = (ms: number) => void (clock += ms);

	const gh = { starred: 0, star: 0 };
	const openedUrls: string[] = [];
	const deps = {
		configHome: "/unused",
		readState: () => ({ state: (options.state ?? { schema: "gentle-shell.star-prompt/v1", sent: 0, dismissed: false }) as StarPromptState, unusable: options.unusable ?? false }),
		writeState: options.writeState ?? ((_configHome: string, state: StarPromptState) => {
			written.push(state);
		}),
		schedule,
		now: () => clock,
		ghStarred: () => {
			gh.starred++;
			return Promise.resolve("no" as const);
		},
		ghStar: () => {
			gh.star++;
			return Promise.resolve(options.ghStarOutcome ?? "yes");
		},
		openRepository: (url: string) => {
			openedUrls.push(url);
			return Promise.resolve({ opened: true });
		},
	};

	createStarPromptExtension(pi, deps);
	const fire = async (event: string, payload: Record<string, unknown> = {}) => {
		for (const handler of handlers.get(event) ?? []) handler({ type: event, ...payload } as any, ctx);
		await drain();
	};
	const send = (text: string) => fire("input", { text, source: "interactive" });
	const key = (data: string) => terminalHandler?.(data);

	return { fire, send, key, statuses, notes, written, scheduled, advance, gh, openedUrls, get terminalHandler() { return terminalHandler; }, get widget() { return widget; }, get renders() { return renders; } };
}

const stateWith = (sent: number, extra: Record<string, unknown> = {}) => ({ schema: "gentle-shell.star-prompt/v1", sent, dismissed: false, ...extra });

// ---------- extension ----------

test("extension: counts sent prompts and persists the counter", async () => {
	const h = harness();
	await h.send("one");
	await h.send("two");
	assert.equal(h.written.length, 2);
	assert.equal(h.written[1].sent, 2);
});

test("extension: an unwritable counter disables asking (fail closed)", async () => {
	const persistFailures = { count: 0 };
	const h = harness({ writeState: () => {
		persistFailures.count++;
		throw new Error("EACCES");
	} });
	await h.send("one");
	assert.equal(persistFailures.count, 1);
	// Sent past the threshold; the next agent_end must not even schedule an idle wait.
	for (let i = 0; i < 10; i++) await h.send(`spam-${i}`);
	await h.fire("agent_end");
	assert.equal(h.scheduled.filter((t) => t.ms === STAR_PROMPT_IDLE_MS).length, 0);
});

test("extension: no offer before the threshold; idle offer after the 5th prompt", async () => {
	const h = harness({ state: stateWith(4) });
	await h.fire("agent_end");
	assert.equal(h.scheduled.length, 0);

	await h.send("fifth");
	await h.send("sixth");
	await h.fire("agent_end");
	assert.deepEqual(h.scheduled.map((t) => t.ms), [STAR_PROMPT_IDLE_MS]);

	// Idle elapses with no activity: the footer shows the offer.
	h.advance(STAR_PROMPT_IDLE_MS);
	h.scheduled[0].fn();
	assert.ok(h.statuses.some((text) => typeof text === "string" && text.includes("Ctrl+G")));
});

test("extension: activity during the idle wait re-arms and defers the offer", async () => {
	const h = harness({ state: stateWith(9) });
	await h.fire("agent_end");
	h.advance(STAR_PROMPT_IDLE_MS - 1);
	h.key("x"); // typing resets the idle clock; never consumed
	assert.equal(h.scheduled.length, 2); // the stale wait was cancelled and a fresh one armed
	h.advance(STAR_PROMPT_IDLE_MS - 2);
	h.scheduled[1].fn();
	assert.equal(h.statuses.some((text) => typeof text === "string"), false);

	// Staying idle across the re-armed window finally shows the offer.
	h.advance(2); // now - lastInputAt reaches exactly IDLE_MS
	h.scheduled[2].fn();
	assert.ok(h.statuses.some((text) => typeof text === "string" && text.includes("Ctrl+G")));
});

test("extension: a second agent_end while an idle wait is pending schedules nothing new", async () => {
	const h = harness({ state: stateWith(9) });
	await h.fire("agent_end");
	await h.fire("agent_end");
	assert.equal(h.scheduled.filter((t) => t.ms === STAR_PROMPT_IDLE_MS).length, 1);
});

test("extension: Ctrl+G stars via gh, thanks, and dismisses forever", async () => {
	const h = harness({ state: stateWith(9) });
	await h.fire("agent_end");
	h.advance(STAR_PROMPT_IDLE_MS);
	h.scheduled[0].fn();
	assert.equal(h.gh.starred, 1); // users who already starred are never asked
	assert.equal(typeof h.statuses.at(-1), "string");

	const consumed = h.key(STAR_CHORD);
	assert.deepEqual(consumed, { consume: true });
	assert.equal(h.gh.star, 1);
	await drain(); // starNow resolves async
	assert.ok(h.notes[0].includes("Thanks for the star"));
	assert.equal(h.written.at(-1)?.dismissed, true);
});

test("extension: a state file from the removed directStar opt-in still stars through gh, never the browser", async () => {
	const h = harness({ state: stateWith(9, { directStar: false }) });
	await h.fire("agent_end");
	h.advance(STAR_PROMPT_IDLE_MS);
	h.scheduled[0].fn();
	assert.equal(h.gh.starred, 1);
	assert.deepEqual(h.key(STAR_CHORD), { consume: true });
	assert.equal(h.gh.star, 1);
	await drain();
	assert.deepEqual(h.openedUrls, []);
	assert.ok(h.notes[0].includes("Thanks for the star"));
	assert.equal(h.written.at(-1)?.dismissed, true);
});

test("extension: the offer is painted in the theme's success green, like added lines in the changes view", async () => {
	const h = harness({ state: stateWith(9) });
	await h.fire("agent_end");
	h.advance(STAR_PROMPT_IDLE_MS);
	h.scheduled[0].fn();
	const offer = h.statuses.at(-1);
	assert.ok(typeof offer === "string" && offer.startsWith("<success>Enjoying Gentle Shell?") && offer.includes("never asks again</success>"));
});

const mouse = (type: "move" | "click", x: number, button: "none" | "left" | "right" = type === "move" ? "none" : "left") =>
	({ type, button, x, y: 0, screenX: x, screenY: 0, width: 400, height: 1, shift: false, alt: false, ctrl: false }) as never;

async function visibleOffer(state = stateWith(9)) {
	const h = harness({ state });
	await h.fire("agent_end");
	h.advance(STAR_PROMPT_IDLE_MS);
	h.scheduled[0].fn();
	const row = h.widget!.render(400)[0]!;
	const plain = row.replace(/<\/?[a-z]+>/g, "");
	return { h, buttonX: plain.indexOf("[star]") };
}

test("extension: the offer row ends with a [star] button painted like the sidebar's clickable controls", async () => {
	const { h, buttonX } = await visibleOffer();
	assert.ok(buttonX > 0);
	assert.ok(h.widget!.render(400)[0]!.endsWith("</success> <accent>[star]</accent>"));

	assert.deepEqual(h.widget!.handleMouse(mouse("move", buttonX + 2)), { handled: true, render: true });
	assert.ok(h.widget!.render(400)[0]!.endsWith("<warning>[star]</warning>"), "hover uses the shared hover role");
	assert.deepEqual(h.widget!.handleMouse(mouse("move", buttonX + 2)), { handled: true });

	h.widget!.handleMouse(mouse("move", 3));
	assert.ok(h.widget!.render(400)[0]!.endsWith("<accent>[star]</accent>"), "moving off the button clears the hover");
});

test("extension: a left click on [star] stars exactly like Ctrl+G and removes the button", async () => {
	const { h, buttonX } = await visibleOffer({ ...DEFAULT_STAR_PROMPT_STATE, sent: 9 });
	const row = h.widget!;
	assert.equal(row.handleMouse(mouse("click", 3)), undefined, "the offer text is not the button");
	assert.equal(row.handleMouse(mouse("click", buttonX, "right")), undefined);
	assert.equal(h.gh.star, 0);

	assert.deepEqual(row.handleMouse(mouse("click", buttonX)), { handled: true, render: true });
	assert.equal(h.gh.star, 1);
	assert.equal(h.widget, undefined);
	assert.equal(h.statuses.at(-1), undefined);
	await drain();
	assert.deepEqual(h.openedUrls, []);
	assert.ok(h.notes[0].includes("Thanks for the star"));
	assert.equal(h.written.at(-1)?.dismissed, true);
});

test("extension: a narrow terminal truncates the offer text, never the [star] button", async () => {
	const { h } = await visibleOffer();
	const row = h.widget!.render(60)[0]!;
	assert.ok(row.includes("…"));
	assert.ok(row.endsWith(" <accent>[star]</accent>"));
	assert.ok(row.replace(/<\/?[a-z]+>/g, "").length <= 60);
});

test("extension: when gh cannot star, Ctrl+G falls back to opening both repos in the browser", async () => {
	const h = harness({ state: stateWith(9), ghStarOutcome: "unknown" });
	await h.fire("agent_end");
	h.advance(STAR_PROMPT_IDLE_MS);
	h.scheduled[0].fn();
	const consumed = h.key(STAR_CHORD);
	assert.deepEqual(consumed, { consume: true });
	assert.equal(h.gh.star, 1);
	await drain();
	assert.deepEqual(h.notes, []);
	// Both sibling repos open so the chord never dead-ends.
	assert.deepEqual(h.openedUrls, [
		"https://github.com/Gentleman-Programming/gentle-shell",
		"https://github.com/Gentleman-Programming/gentle-ai",
	]);
	assert.equal(h.written.at(-1)?.dismissed, true);
});

test("extension: Alt+D dismisses forever and the offer never returns", async () => {
	const h = harness({ state: stateWith(9) });
	await h.fire("agent_end");
	h.advance(STAR_PROMPT_IDLE_MS);
	h.scheduled[0].fn();
	const consumed = h.key(DISMISS_CHORD);
	assert.deepEqual(consumed, { consume: true });
	assert.equal(h.written.at(-1)?.dismissed, true);
	assert.ok(h.statuses.at(-1) === undefined);

	await h.fire("agent_end");
	assert.equal(h.scheduled.filter((t) => t.ms === STAR_PROMPT_IDLE_MS).length, 1); // no new wait
});

test("extension: an unanswered offer auto-hides and asks no more this session", async () => {
	const h = harness({ state: stateWith(9) });
	await h.fire("agent_end");
	h.advance(STAR_PROMPT_IDLE_MS);
	h.scheduled[0].fn();
	const visibleTimers = h.scheduled.filter((t) => t.ms === STAR_PROMPT_VISIBLE_MS);
	assert.equal(visibleTimers.length, 1);
	h.advance(STAR_PROMPT_VISIBLE_MS);
	visibleTimers[0].fn();
	assert.ok(h.statuses.at(-1) === undefined);

	await h.fire("agent_end");
	assert.equal(h.scheduled.filter((t) => t.ms === STAR_PROMPT_IDLE_MS).length, 1);
});

test("extension: chords are never consumed while the offer is hidden", () => {
	const h = harness({ state: stateWith(9) });
	assert.equal(h.key(STAR_CHORD), undefined);
	assert.equal(h.key(DISMISS_CHORD), undefined);
	assert.equal(h.gh.star, 0);
	assert.deepEqual(h.openedUrls, []);
});

test("extension: unusable state never offers", async () => {
	const h = harness({ unusable: true, state: stateWith(50) });
	await h.fire("agent_end");
	assert.equal(h.scheduled.length, 0);
});

test("extension: already-starred skips the offer and marks dismissed", async () => {
	const handlers = new Map<string, Set<(event: any, ctx: ExtensionContext) => unknown>>();
	const pi = { on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
		if (!handlers.has(event)) handlers.set(event, new Set());
		handlers.get(event)!.add(handler);
		return () => {};
	} } as unknown as ExtensionAPI;
	const ctx = {
		ui: {
			setStatus: () => {},
			notify: () => {},
			onTerminalInput: () => () => {},
		},
	} as unknown as ExtensionContext;
	const written: Array<{ dismissed: boolean }> = [];
	createStarPromptExtension(pi, {
		configHome: "/unused",
		readState: () => ({ state: stateWith(50) as StarPromptState, unusable: false }),
		writeState: (_: string, state: { dismissed: boolean }) => written.push(state),
		schedule: () => ({ cancel: () => {} }),
		now: () => 0,
		ghStarred: () => Promise.resolve("yes" as const),
		ghStar: () => Promise.resolve("yes" as const),
		openRepository: () => Promise.resolve({ opened: true }),
	});
	for (const handler of handlers.get("agent_end") ?? []) handler({ type: "agent_end" }, ctx);
	await drain();
	assert.equal(written.length, 1);
	assert.equal(written[0].dismissed, true);
});

test("lib: ghStarred classifies 404 as no and other failures as unknown", async () => {
	const failWith = (stderr: string) => ((_command: string, _args: readonly string[], _opts: unknown, cb: (e: Error | undefined, _o: string, stderr: string) => void) => cb(new Error("failed"), "", stderr));
	const notStarred = await ghStarred({ exec: failWith("HTTP 404") as never, repositories: ["x/y"] });
	assert.equal(notStarred, "no");
	const broken = await ghStarred({ exec: ((_command: string, _args: readonly string[], _opts: unknown, cb: (e: Error | undefined) => void) => cb(new Error("boom"))) as never, repositories: ["x/y"] });
	assert.equal(broken, "unknown");
});

test("lib: a failed PUT, including HTTP 404, is never reported as starred", async () => {
	const { ghStar } = await import("../lib/star-prompt.ts");
	const failWith = (stderr: string) => ((_command: string, _args: readonly string[], _opts: unknown, cb: (e: Error | undefined, _o: string, stderr: string) => void) => cb(new Error("failed"), "", stderr));
	// A 404 on PUT means the repository is missing or the token cannot star it: thanking would be a lie.
	assert.equal(await ghStar({ exec: failWith("gh: Not Found (HTTP 404)") as never, repositories: ["x/y"] }), "unknown");
	assert.equal(await ghStar({ exec: failWith("boom") as never, repositories: ["x/y"] }), "unknown");
});

test("lib: execFile's null error (exit 0) means starred, and a null error on PUT means starred", async () => {
	// Real child_process passes error = null on success; that must not crash (found in TUI smoke).
	const ok = ((_command: string, _args: readonly string[], _opts: unknown, cb: (e: Error | null, _o: string, _s: string) => void) => cb(null, "", "")) as never;
	assert.equal(await ghStarred({ exec: ok, repositories: ["x/y"] }), "yes");
	const { ghStar } = await import("../lib/star-prompt.ts");
	assert.equal(await ghStar({ exec: ok, repositories: ["x/y"] }), "yes");
});
