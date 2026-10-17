import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import {
	CONTEXT_BACKSTOP_FRACTION_ENV,
	CONTEXT_BACKSTOP_TOKENS_ENV,
	contextBackstopReached,
	contextBackstopThreshold,
} from "../lib/context-backstop.ts";

// Harness roadmap R1: the parent-context backstop was a fixed "~150k tokens" in prompt text, so the model had to
// estimate its own context. The runtime now measures it against min(absolute cap, fraction x context window) and
// tells the primary session once per crossing.

test("the threshold is the smaller of the absolute cap and 15% of the context window", () => {
	assert.equal(contextBackstopThreshold(1_000_000, {}), 150_000, "a large window keeps the absolute cap");
	assert.equal(contextBackstopThreshold(400_000, {}), 60_000);
	// Bench gate (T12): a 272k window reaches it near 41k, where delegating the wide task paid off.
	assert.equal(contextBackstopThreshold(272_000, {}), 40_800);
	assert.equal(contextBackstopThreshold(200_000, {}), 30_000, "a small window reaches it at 15% of its size");
	assert.equal(contextBackstopThreshold(128_000, {}), 19_200);
	for (const unknown of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.equal(contextBackstopThreshold(unknown, {}), 150_000, `window ${unknown} falls back to the cap`);
	}
});

test("the cap and the fraction are overridable by environment; invalid values keep the defaults", () => {
	assert.equal(contextBackstopThreshold(1_000_000, { [CONTEXT_BACKSTOP_TOKENS_ENV]: "100000" }), 100_000);
	assert.equal(contextBackstopThreshold(4_000_000, { [CONTEXT_BACKSTOP_TOKENS_ENV]: "300000" }), 300_000, "a raised cap applies where the fraction allows it");
	assert.equal(contextBackstopThreshold(1_000_000, { [CONTEXT_BACKSTOP_FRACTION_ENV]: "0.1" }), 100_000);
	assert.equal(contextBackstopThreshold(200_000, { [CONTEXT_BACKSTOP_TOKENS_ENV]: "80000", [CONTEXT_BACKSTOP_FRACTION_ENV]: "1" }), 80_000);
	for (const value of ["", "abc", "0", "-5", "1.5e999"]) {
		assert.equal(contextBackstopThreshold(1_000_000, { [CONTEXT_BACKSTOP_TOKENS_ENV]: value }), 150_000, `tokens ${JSON.stringify(value)}`);
	}
	for (const value of ["", "abc", "0", "-0.5", "1.5"]) {
		assert.equal(contextBackstopThreshold(200_000, { [CONTEXT_BACKSTOP_FRACTION_ENV]: value }), 30_000, `fraction ${JSON.stringify(value)}`);
	}
});

// R1 review advisory: a tiny window or fraction floored the threshold to 0, so an
// empty context counted as reaching the backstop (and admitted every writer).
test("the threshold is never below one token, so an empty context never reaches it", () => {
	assert.equal(contextBackstopThreshold(200_000, { [CONTEXT_BACKSTOP_FRACTION_ENV]: "0.000001" }), 1);
	assert.equal(contextBackstopThreshold(1, {}), 1);
	assert.equal(contextBackstopReached({ tokens: 0, contextWindow: 1 }, {}), false);
	assert.equal(contextBackstopReached({ tokens: 1, contextWindow: 1 }, {}), true);
});

test("unknown tokens never count as reaching the backstop", () => {
	assert.equal(contextBackstopReached({ tokens: 150_000, contextWindow: 1_000_000 }, {}), true);
	assert.equal(contextBackstopReached({ tokens: 149_999, contextWindow: 1_000_000 }, {}), false);
	assert.equal(contextBackstopReached({ tokens: 19_200, contextWindow: 128_000 }, {}), true);
	assert.equal(contextBackstopReached({ tokens: 19_199, contextWindow: 128_000 }, {}), false);
	assert.equal(contextBackstopReached({ tokens: null, contextWindow: 128_000 }, {}), false, "null right after compaction");
	assert.equal(contextBackstopReached(undefined, {}), false);
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Patch = { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean } | undefined;

function session(t: TestContext, child: boolean) {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "context-backstop-")));
	const configHome = mkdtempSync(join(tmpdir(), "context-backstop-config-"));
	const previous = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(configHome, { recursive: true, force: true });
	});
	const handlers = new Map<string, Handler>();
	const pi = { on: (name: string, handler: Handler) => { handlers.set(name, handler); }, events: { on() {}, emit() {} }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, processEnv: { GENTLE_PI_AGENTS_CHILD: child ? "1" : "0", GENTLE_AI_TELEMETRY: "0" } })(pi);
	let usage: ContextUsage | undefined = { tokens: 10_000, contextWindow: 1_000_000, percent: 1 };
	const sessionManager = { getSessionId: () => "session-backstop", getCwd: () => cwd, getEntries: () => [], getBranch: () => [] };
	const ctx = { cwd, hasUI: false, ui: { notify() {} }, sessionManager, getContextUsage: () => usage } as unknown as ExtensionContext;
	const setTokens = (tokens: number | null, contextWindow = 1_000_000) => {
		usage = { tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 };
	};
	const read = (overrides: Record<string, unknown> = {}) => handlers.get("tool_result")!({
		toolName: "read", toolCallId: "call-read", isError: false, input: { path: "a.ts" },
		content: [{ type: "text", text: "file body" }], structuredContent: { lines: 1 }, ...overrides,
	}, ctx) as Promise<Patch>;
	return { cwd, ctx, handlers, setTokens, read };
}

test("the primary session gets one notice when its measured context first reaches the backstop", async (t) => {
	const s = session(t, false);
	assert.equal(await s.read(), undefined, "below the backstop nothing is appended");
	s.setTokens(160_000);
	const crossed = await s.read();
	assert.equal(crossed?.content?.[0]?.text, "file body", "the tool output is kept first");
	const notice = crossed?.content?.[1]?.text ?? "";
	assert.match(notice, /Context backstop/);
	assert.match(notice, /160,000 tokens/, "measured tokens");
	assert.match(notice, /16% of the 1,000,000-token context window/, "percent of the window");
	assert.match(notice, /150,000-token backstop/, "the threshold");
	assert.match(notice, /delegate the next bounded unit that needs several steps \(its reads, edits, and checks\) with a short handoff/);
	assert.match(notice, /single small edits and state checks stay inline/);
	assert.deepEqual(crossed?.structuredContent, { lines: 1 }, "structured content is kept");
	assert.equal(crossed && "isError" in crossed, false, "the error flag is never altered");
	assert.equal(await s.read(), undefined, "once per crossing");
	s.setTokens(null);
	assert.equal(await s.read(), undefined, "unknown tokens neither notify nor re-arm");
	s.setTokens(170_000);
	assert.equal(await s.read(), undefined, "still past the same crossing");
	s.setTokens(40_000);
	assert.equal(await s.read(), undefined, "dropping below the backstop re-arms it");
	s.setTokens(19_200, 128_000);
	const again = await s.read({ isError: true, structuredContent: undefined });
	assert.match(again?.content?.[1]?.text ?? "", /19,200 tokens \(15% of the 128,000-token context window\), at or past the 19,200-token backstop/, "a small window reaches it at 15% of its size");
	assert.equal(again && "structuredContent" in again, false, "absent structured content stays absent");
	assert.equal(again && "isError" in again, false, "an error result keeps its flag");
});

test("child sessions never get the notice", async (t) => {
	const s = session(t, true);
	s.setTokens(390_000);
	assert.equal(await s.read(), undefined);
});

test("a parent commit result carries both the slice line and the backstop notice", async (t) => {
	const s = session(t, false);
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: s.cwd, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(s.cwd, "README.md"), "base\n");
	git("add", "README.md");
	git("commit", "-q", "-m", "base");
	git("switch", "-q", "-c", "feat/x");
	writeFileSync(join(s.cwd, "a.ts"), "one\n");
	git("add", "a.ts");
	git("commit", "-q", "-m", "feat: a");
	s.setTokens(200_000);
	const result = await s.handlers.get("tool_result")!({
		toolName: "bash", toolCallId: "call-1", isError: false, input: { command: "git commit -m 'feat: a'" },
		content: [{ type: "text", text: "[feat/x 1234567] feat: a" }], structuredContent: { exitCode: 0 },
	}, s.ctx) as Patch;
	assert.equal(result?.content?.[0]?.text, "[feat/x 1234567] feat: a");
	assert.match(result?.content?.[1]?.text ?? "", /Commit slice: 1 authored changed lines/);
	assert.match(result?.content?.[2]?.text ?? "", /Context backstop/);
	assert.deepEqual(result?.structuredContent, { exitCode: 0 });
});

test("a parent write result carries the notice after its own bookkeeping", async (t) => {
	const s = session(t, false);
	s.setTokens(150_000);
	const result = await s.handlers.get("tool_result")!({
		toolName: "write", toolCallId: "call-w", isError: false, input: { path: "src/a.ts" },
		content: [{ type: "text", text: "Wrote src/a.ts" }],
	}, s.ctx) as Patch;
	assert.equal(result?.content?.[0]?.text, "Wrote src/a.ts");
	assert.match(result?.content?.[1]?.text ?? "", /Context backstop/);
});
