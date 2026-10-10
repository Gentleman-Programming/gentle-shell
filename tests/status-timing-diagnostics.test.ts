import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { createReviewSidebarPublisher } from "../lib/review-sidebar-state.ts";
import {
	StatusTimingDiagnostics, observeNativeStatus, measureStatusSync, measureStatusAsync, measureStatusSidebar,
} from "../lib/status-timing-diagnostics.ts";
import { NativeReviewCliV216, createNodeExecFileAdapter, type ExecFileAdapter, type ExecFileRequest } from "../lib/native-review-cli.ts";

function context() {
	let id = "private-session";
	const notices: string[] = [];
	const ctx = {
		cwd: process.cwd(),
		sessionManager: { getSessionId: () => id },
		ui: { notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionToolContext;
	return { ctx, notices, replace: () => { id = "replacement-session"; } };
}

function wrapped<T>(timing: StatusTimingDiagnostics, run: () => Promise<T>) {
	const definition = { name: "gentle_review", execute: run } as unknown as ToolDefinition;
	return (ctx: ExtensionToolContext) => timing.tool(definition).execute("private-call", { operation: "inspect" }, undefined, undefined, ctx);
}

function summary(timing: StatusTimingDiagnostics, host: ReturnType<typeof context>) {
	timing.command("show", host.ctx);
	return JSON.parse(host.notices.at(-1)!) as {
		host_total_ms: number; dispatch_ms: number; sidebar_ms: number; completion_ms: number;
		truncated: boolean; statuses: Array<{ timeout_ms: number; total_ms: number; resolution_ms: number; adapter_ms: number; decode_ms: number; outcome: Record<string, unknown> }>;
	};
}

const statusBytes = readFileSync(join(process.cwd(), "tests/fixtures/devbinary/status-v5.captured.json"), "utf8");

test("disabled diagnostics do not consult the clock or alter protocol, invocations, or deadlines", async () => {
	const host = context();
	let clockCalls = 0;
	const timing = new StatusTimingDiagnostics(() => { clockCalls++; throw new Error("observer failed"); });
	const requests: ExecFileRequest[] = [];
	const adapter: ExecFileAdapter = async (request) => {
		requests.push(request);
		return { stdout: statusBytes, stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
	};
	const cli = new NativeReviewCliV216(adapter, process.execPath, 30_000);
	const baseline = await cli.targetStatus({ cwd: process.cwd(), agent: "pi" });
	const actual = await wrapped(timing, () => cli.targetStatus({ cwd: process.cwd(), agent: "pi" }))(host.ctx);
	assert.deepEqual(actual, baseline);
	assert.equal(clockCalls, 0);
	assert.deepEqual(requests[1], requests[0]);
	timing.command("show", host.ctx);
	assert.match(host.notices.at(-1)!, /No completed STATUS timing/);
});

test("opt-in captures monotonic stage durations once and excludes all identifying or raw data", async () => {
	const host = context();
	let now = 0;
	const timing = new StatusTimingDiagnostics(() => now);
	timing.reset(host.ctx);
	timing.command("enable", host.ctx);
	const value = { details: { secret: "raw-output" } };
	const actual = await wrapped(timing, async () => {
		now += 7;
		await observeNativeStatus(30_000, async () => {
			measureStatusSync("resolution", () => { now += 3; });
			await measureStatusAsync("adapter", async () => { now += 19; });
			measureStatusSync("decode", () => { now += 5; });
		});
		measureStatusSidebar(() => { now += 2; });
		now += 11;
		return value;
	})(host.ctx);
	assert.equal(actual, value);
	assert.deepEqual(summary(timing, host), {
		schema: "gentle-pi.status-timing/v1", host_total_ms: 47, dispatch_ms: 7,
		sidebar_ms: 2, completion_ms: 13, truncated: false,
		statuses: [{ timeout_ms: 30_000, total_ms: 27, resolution_ms: 3, adapter_ms: 19, decode_ms: 5, outcome: { kind: "success" } }],
	});
	await wrapped(timing, () => observeNativeStatus(99, async () => { now += 99; }))(host.ctx);
	assert.equal(summary(timing, host).statuses[0].timeout_ms, 30_000, "arming is consumed without retrying anything");
	const report = host.notices.at(-1)!;
	for (const forbidden of [host.ctx.cwd, "private-session", "private-call", "raw-output"]) assert.equal(report.includes(forbidden), false);
});

test("enabled fake adapter preserves success and typed failure bytes without extra execution", async () => {
	for (const fail of [false, true]) {
		const host = context();
		const timing = new StatusTimingDiagnostics();
		const failure = { schema: "gentle-ai.review-integration.failure/v2", contract: "gentle-ai.review-integration/v2", required_inputs: [], operation: "review.status", code: "operation_timeout", phase: "pre_native", message: "private raw error", cause: "/private/path", mutation_outcome: "not_started", authority_applicability: "not_evaluated", retry_safe: false, replayability: "manual_action_required", next_action: "stop" };
		const requests: ExecFileRequest[] = [];
		const adapter: ExecFileAdapter = async (request) => {
			requests.push(request);
			return { stdout: fail ? JSON.stringify(failure) : statusBytes, stderr: "", exitCode: fail ? 1 : 0, signal: null, timedOut: false, outputLimitExceeded: false };
		};
		const cli = new NativeReviewCliV216(adapter, process.execPath, 321);
		const invoke = () => cli.targetStatus({ cwd: process.cwd(), agent: "pi" });
		let expected: unknown;
		try { expected = await invoke(); } catch (error) { expected = error; }
		timing.command("enable", host.ctx);
		let actual: unknown;
		try { actual = await wrapped(timing, invoke)(host.ctx); } catch (error) { actual = error; }
		assert.deepEqual(actual, expected);
		assert.deepEqual(requests[1], requests[0]);
		assert.equal(requests.length, 2);
		const report = summary(timing, host);
		assert.equal(report.statuses[0].timeout_ms, 321);
		assert.equal(report.statuses[0].outcome.kind, fail ? "native_failure" : "success");
		if (fail) {
			assert.deepEqual(report.statuses[0].outcome, { kind: "native_failure", code: "operation_timeout", phase: "pre_native", mutation_outcome: "not_started", retry_safe: false, next_action: "stop" });
			assert.equal(host.notices.at(-1)!.includes("private"), false);
		}
	}
});

test("public plain STATUS facade consumes the arm and measures resolution without changing execution", async () => {
	const host = context();
	let now = 0;
	const timing = new StatusTimingDiagnostics(() => now);
	const requests: ExecFileRequest[] = [];
	const body = {
		schema: "gentle-ai.review-authority-status/v1", operation: "review/status", repository: process.cwd(),
		complete: true, authoritative: true, status: "clean", entries: [], locks: [], diagnostics: [],
	};
	const cli = new NativeReviewCliV216(async (request) => {
		requests.push(request);
		now += 17;
		return { stdout: JSON.stringify(body), stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
	}, () => { now += 5; return process.execPath; }, 321, 654);
	const signal = new AbortController().signal;
	const baseline = await cli.reviewStatus({ cwd: process.cwd(), signal });
	timing.command("enable", host.ctx);
	const actual = await wrapped(timing, () => cli.reviewStatus({ cwd: process.cwd(), signal }))(host.ctx);
	assert.deepEqual(actual, baseline);
	assert.deepEqual(requests[1], requests[0]);
	assert.equal(requests.length, 2);
	assert.deepEqual(requests[1].arguments, ["review", "status", "--cwd", process.cwd()]);
	assert.equal(requests[1].signal, signal);
	assert.equal(requests[1].timeoutMs, 321);
	assert.equal(requests[1].maxBufferBytes, 654);
	const report = summary(timing, host);
	assert.equal(report.statuses.length, 1);
	assert.equal(report.statuses[0].resolution_ms, 5);
	assert.equal(report.statuses[0].adapter_ms, 17);
	assert.equal(report.statuses[0].timeout_ms, 321);
	assert.deepEqual(report.statuses[0].outcome, { kind: "success" });
	await wrapped(timing, () => cli.reviewStatus({ cwd: process.cwd(), signal }))(host.ctx);
	assert.deepEqual(summary(timing, host), report, "the facade consumes the arm only once");
});

test("observer clock failures cannot hide a result or original thrown error", async () => {
	const host = context();
	const timing = new StatusTimingDiagnostics(() => { throw new Error("clock failed"); });
	timing.command("enable", host.ctx);
	const sentinel = new Error("original error");
	await assert.rejects(wrapped(timing, () => observeNativeStatus(30, () => measureStatusAsync("adapter", async () => { throw sentinel; })))(host.ctx), (error) => error === sentinel);
	timing.command("enable", host.ctx);
	const value = { ok: true };
	assert.equal(await wrapped(timing, () => observeNativeStatus(30, async () => measureStatusSync("decode", () => value)))(host.ctx), value);
});

test("disable, shutdown, and replacement clear retained and late observations", async () => {
	for (const action of ["disable", "shutdown", "replacement"] as const) {
		const host = context();
		const timing = new StatusTimingDiagnostics();
		timing.command("enable", host.ctx);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const run = wrapped(timing, () => observeNativeStatus(30, () => measureStatusAsync("adapter", () => gate)))(host.ctx);
		if (action === "disable") timing.command("disable", host.ctx);
		if (action === "shutdown") timing.reset();
		if (action === "replacement") host.replace();
		release();
		await run;
		timing.command("show", host.ctx);
		assert.match(host.notices.at(-1)!, /No completed STATUS timing/);
	}
});

test("overlapping calls claim only one armed capture and never mix stages", async () => {
	const host = context();
	let now = 0;
	const timing = new StatusTimingDiagnostics(() => now);
	timing.command("enable", host.ctx);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const first = wrapped(timing, async () => {
		await gate;
		return observeNativeStatus(11, async () => measureStatusSync("decode", () => { now += 3; }));
	})(host.ctx);
	await wrapped(timing, () => observeNativeStatus(22, () => measureStatusAsync("adapter", async () => { now += 9; })))(host.ctx);
	release();
	await first;
	assert.equal(summary(timing, host).statuses.length, 1);
	assert.equal(summary(timing, host).statuses[0].timeout_ms, 22);
	assert.equal(summary(timing, host).statuses[0].decode_ms, 0);
});

test("summaries are bounded and commands never invoke native or persist settings", async () => {
	const host = context();
	const timing = new StatusTimingDiagnostics();
	timing.command("invalid", host.ctx);
	assert.match(host.notices.at(-1)!, /Use enable, disable, or show/);
	timing.command("enable", host.ctx);
	await wrapped(timing, async () => {
		for (let index = 0; index < 100; index++) await observeNativeStatus(30, async () => {});
	})(host.ctx);
	const report = summary(timing, host);
	assert.equal(report.statuses.length, 8);
	assert.equal(report.truncated, true);
	timing.command("disable", host.ctx);
	timing.command("show", host.ctx);
	assert.match(host.notices.at(-1)!, /No completed STATUS timing/);
});

test("registered command observes controller dispatch and sidebar without changing its result", async () => {
	const host = context();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const tools = new Map<string, ToolDefinition>();
	const hooks = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	let calls = 0;
	const cli = new NativeReviewCliV216(async () => {
		calls++;
		return { stdout: statusBytes, stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
	}, process.execPath);
	createGentleAiExtension({ nativeReviewCli: cli })({
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
		registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
		registerCommand: (name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, definition),
		events: { emit: () => { throw new Error("sidebar observer failed"); } },
	} as unknown as ExtensionAPI);
	const command = commands.get("gentle:status-timing")!;
	assert.ok(command);
	await command.handler("enable", host.ctx);
	assert.equal(calls, 0, "arming never runs native STATUS");
	const tool = tools.get("gentle_review")!;
	const actual = await tool.execute("private-call", { operation: "inspect" }, undefined, undefined, host.ctx);
	assert.equal(calls, 1);
	assert.equal(typeof actual.details, "object");
	await command.handler("show", host.ctx);
	const report = JSON.parse(host.notices.at(-1)!);
	assert.equal(report.statuses.length, 1);
	assert.equal(report.statuses[0].outcome.kind, "success");
	assert.equal(typeof report.sidebar_ms, "number");
	assert.equal(calls, 1, "consulting never runs another STATUS");
	for (const handler of hooks.get("session_tree") ?? []) await handler({}, host.ctx);
	await command.handler("show", host.ctx);
	assert.match(host.notices.at(-1)!, /No completed STATUS timing/);
	assert.equal(calls, 1);
});

test("real sidebar publication is timed and throwing listeners cannot hide results", async () => {
	const host = context();
	let now = 0;
	const timing = new StatusTimingDiagnostics(() => now);
	const publisher = createReviewSidebarPublisher({ events: { emit: () => { now += 4; throw new Error("listener failed"); } } } as unknown as ExtensionAPI);
	publisher.reset(host.ctx);
	timing.command("enable", host.ctx);
	const value = { content: [], details: {} };
	const definition = { name: "gentle_review", execute: () => observeNativeStatus(30, async () => value) } as unknown as ToolDefinition;
	const actual = await timing.tool(publisher.tool(definition)).execute("private-call", { operation: "inspect" }, undefined, undefined, host.ctx);
	assert.equal(actual, value);
	assert.equal(summary(timing, host).sidebar_ms, 8);
});

test("isolated Node child measures adapter settlement separately from host completion", async () => {
	const host = context();
	const timing = new StatusTimingDiagnostics();
	timing.command("enable", host.ctx);
	const adapter = createNodeExecFileAdapter();
	const actual = await wrapped(timing, async () => {
		const result = await observeNativeStatus(2000, () => measureStatusAsync("adapter", () => adapter({ file: process.execPath, arguments: ["-e", "setTimeout(() => process.stdout.write('isolated-child'), 30)"], cwd: process.cwd(), timeoutMs: 2000, maxBufferBytes: 1024 })));
		await new Promise((resolve) => setTimeout(resolve, 50));
		return result;
	})(host.ctx);
	assert.equal((actual as unknown as { stdout: string }).stdout, "isolated-child");
	const report = summary(timing, host);
	assert.ok(report.statuses[0].adapter_ms >= 20);
	assert.ok(report.completion_ms >= 35);
	assert.ok(report.host_total_ms >= report.statuses[0].adapter_ms + 35);
});
