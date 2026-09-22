import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { OddAdherenceTelemetry } from "../lib/odd-adherence-telemetry.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

type RecordLine = {
	v: number;
	ts: string;
	session: string;
	repo: string;
	provider: string;
	turn: number;
	tool_calls: number;
	reads: number;
	edits: number;
	distinct_paths: number;
	first_path_order: number | null;
	second_path_order: number | null;
	delegations: number;
	blocked: boolean;
	blocked_kind: string | null;
	no_delegation_mechanism: boolean;
	backstops: { tool_calls: boolean; reads: boolean; edits: boolean };
};

function harness(processEnv: NodeJS.ProcessEnv = {}, activeTools = ["read", "edit", "write", "subagent_run"]): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(name: string, handler: Handler) { handlers.set(name, handler); },
		events: { emit() {} },
		registerCommand() {},
		registerTool() {},
		getFlag: () => undefined,
		getActiveTools: () => activeTools,
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: null,
		processEnv,
		resolveTelemetryTriggerBinary: () => "/usr/bin/true",
		telemetryTriggerSpawn: (() => undefined) as never,
	})(pi);
	return handlers;
}

function context(cwd: string, sessionId = "odd-adherence-session"): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		mode: "interactive",
		ui: { notify() {} },
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
}

async function successfulMutation(
	handlers: Map<string, Handler>,
	ctx: ExtensionContext,
	toolName: "edit" | "write",
	path: string,
	content?: string,
): Promise<void> {
	const input = content === undefined ? { path } : { path, content };
	assert.equal(await handlers.get("tool_call")!({ toolName, input }, ctx), undefined);
	await handlers.get("tool_result")!({ toolName, toolCallId: `${toolName}-${path}`, input, isError: false }, ctx);
}

function logPath(home: string): string {
	return join(home, ".gentle-ai", "odd-adherence.jsonl");
}

function records(home: string): RecordLine[] {
	const path = logPath(home);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as RecordLine);
}

test("counting can run with injected paths and appender without filesystem access", () => {
	const lines: string[] = [];
	const telemetry = new OddAdherenceTelemetry(
		(line) => lines.push(line),
		() => "2026-09-21T14:31:02.000Z",
		(_toolName, input) => typeof input === "object" && input !== null && "path" in input && typeof input.path === "string" ? input.path : undefined,
		() => "repo-root",
	);
	telemetry.start("session", true, "unused");
	const first = telemetry.observeToolCall("session", "write", { path: "one.ts" }, "unused");
	telemetry.observeGateDecision(first, undefined);
	telemetry.observeToolResult("session", "write", { path: "one.ts" }, "unused", true);
	const second = telemetry.observeToolCall("session", "write", { path: "two.ts" }, "unused");
	telemetry.observeGateDecision(second, { block: true, reason: "refused" });
	telemetry.endTurn("session");
	assert.equal(lines.length, 1);
	assert.equal(JSON.parse(lines[0]).distinct_paths, 2);
});

function repository(): { cwd: string; home: string } {
	const cwd = mkdtempSync(join(tmpdir(), "gentle-pi-odd-adherence-"));
	execFileSync("git", ["init", "--quiet"], { cwd });
	const home = join(cwd, "home");
	mkdirSync(home);
	return { cwd, home };
}

test("refusal records two distinct eligible paths and a blocked turn", async () => {
	const { cwd, home } = repository();
	try {
		const handlers = harness({ HOME: home }, ["read", "edit", "write"]);
		const ctx = context(cwd);
		await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
		await successfulMutation(handlers, ctx, "write", join(cwd, "first.ts"));
		const refused = await handlers.get("tool_call")!({ toolName: "write", input: { path: join(cwd, "second.ts") } }, ctx) as { block?: boolean };
		assert.equal(refused.block, true);
		await handlers.get("agent_end")!({}, ctx);
		const [record] = records(home);
		assert.equal(record.distinct_paths, 2);
		assert.equal(record.blocked, true);
		assert.equal(record.blocked_kind, "multi-file-write");
		assert.equal(record.delegations, 0);
		assert.equal(record.first_path_order, 1);
		assert.equal(record.second_path_order, 2);
		assert.equal(record.no_delegation_mechanism, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("delegation-first turns are not marked as blocked", async () => {
	const { cwd, home } = repository();
	try {
		const handlers = harness({ HOME: home });
		const ctx = context(cwd);
		await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
		assert.equal(await handlers.get("tool_call")!({ toolName: "subagent_run", input: {} }, ctx), undefined);
		await successfulMutation(handlers, ctx, "write", join(cwd, "delegated.ts"));
		await handlers.get("agent_end")!({}, ctx);
		const [record] = records(home);
		assert.equal(record.blocked, false);
		assert.equal(record.delegations >= 1, true);
		assert.equal(record.backstops.edits, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("successful exploratory reads feed the read backstop without changing gate behavior", async () => {
	const { cwd, home } = repository();
	try {
		const handlers = harness({ HOME: home });
		const ctx = context(cwd);
		await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
		for (let index = 0; index < 5; index += 1) {
			const path = join(cwd, `read-${index}.ts`);
			assert.equal(await handlers.get("tool_call")!({ toolName: "read", input: { path } }, ctx), undefined);
			await handlers.get("tool_result")!({ toolName: "read", toolCallId: `read-${index}`, input: { path }, isError: false }, ctx);
		}
		await handlers.get("agent_end")!({}, ctx);
		const [record] = records(home);
		assert.equal(record.reads, 5);
		assert.equal(record.backstops.reads, true);
		assert.equal(record.blocked, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("bookkeeping paths and failed calls consume no write budget", async () => {
	const { cwd, home } = repository();
	try {
		const handlers = harness({ HOME: home });
		const ctx = context(cwd);
		await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
		const failedPath = join(cwd, "failed.ts");
		assert.equal(await handlers.get("tool_call")!({ toolName: "write", input: { path: failedPath } }, ctx), undefined);
		await handlers.get("tool_result")!({ toolName: "write", toolCallId: "failed", input: { path: failedPath }, isError: true }, ctx);
		await successfulMutation(handlers, ctx, "write", join(cwd, "actual.ts"));
		await successfulMutation(handlers, ctx, "write", join(cwd, "odd", "tasks", "feature.md"));
		await handlers.get("agent_end")!({}, ctx);
		const [record] = records(home);
		assert.equal(record.distinct_paths, 1);
		assert.equal(record.edits, 1);
		assert.equal(record.blocked, false);
		assert.equal(record.first_path_order, 2);
		assert.equal(record.second_path_order, null);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("child actor writes are exempt from the primary turn", async () => {
	const { cwd, home } = repository();
	try {
		const handlers = harness({ HOME: home });
		const ctx = context(cwd);
		await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
		await successfulMutation(handlers, ctx, "write", join(cwd, "primary.ts"));
		await handlers.get("before_agent_start")!({ agentName: "gentle-ai-worker", systemPrompt: "named child" }, ctx);
		await successfulMutation(handlers, ctx, "write", join(cwd, "child.ts"));
		await handlers.get("agent_end")!({}, ctx);
		await handlers.get("agent_end")!({}, ctx);
		const [record] = records(home);
		assert.equal(record.distinct_paths, 1);
		assert.equal(record.edits, 1);
		assert.equal(record.blocked, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

for (const [label, variable, value] of [["DO_NOT_TRACK", "DO_NOT_TRACK", "1"], ["CI", "CI", "true"]] as const) {
	test(`${label} disables local adherence output`, async () => {
		const { cwd, home } = repository();
		try {
			const handlers = harness({ HOME: home, [variable]: value });
			const ctx = context(cwd);
			await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
			await handlers.get("agent_end")!({}, ctx);
			assert.equal(existsSync(logPath(home)), false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}

test("missing HOME and an unwritable HOME never surface telemetry errors", async () => {
	const { cwd, home } = repository();
	const unwritableHome = join(cwd, "not-a-directory");
	writeFileSync(unwritableHome, "file");
	try {
		for (const processEnv of [{}, { HOME: unwritableHome }]) {
			const handlers = harness(processEnv);
			const ctx = context(cwd, `session-${String(processEnv.HOME ?? "missing")}`);
			await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
			await handlers.get("agent_end")!({}, ctx);
		}
		assert.equal(existsSync(logPath(unwritableHome)), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("the JSONL line contains counts and hashes, never paths or content", async () => {
	const { cwd, home } = repository();
	const secretPath = join(cwd, "secret-path.ts");
	const secretContent = "do-not-record-this-content";
	try {
		const handlers = harness({ HOME: home });
		const ctx = context(cwd);
		await handlers.get("before_agent_start")!({ systemPrompt: "primary" }, ctx);
		await successfulMutation(handlers, ctx, "write", secretPath, secretContent);
		await handlers.get("agent_end")!({}, ctx);
		const line = readFileSync(logPath(home), "utf8").trim();
		const record = JSON.parse(line) as RecordLine;
		assert.equal(line.includes(secretPath), false);
		assert.equal(line.includes(secretContent), false);
		assert.deepEqual(Object.keys(record), [
			"v", "ts", "session", "repo", "provider", "turn", "tool_calls", "reads", "edits", "distinct_paths",
			"first_path_order", "second_path_order", "delegations", "blocked", "blocked_kind", "no_delegation_mechanism", "backstops",
		]);
		assert.match(record.session, /^[0-9a-f]{8}$/);
		assert.match(record.repo, /^[0-9a-f]{8}$/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
