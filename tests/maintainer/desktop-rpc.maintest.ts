import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DESKTOP_RPC_SCHEMA, DESKTOP_RPC_WIDGET } from "../../lib/desktop-rpc.ts";
import { normalizeProfilesFile, serializeProfilesFile } from "../../lib/agent-profiles.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const runtime = resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const desktopExtension = resolve(packageRoot, "extensions/gentle-desktop-rpc.ts");
const ownerExtension = resolve(packageRoot, "extensions/gentle-ai.ts");
const usageOwnerExtension = resolve(packageRoot, "extensions/gentle-shell.ts");
const designOwnerExtension = resolve(packageRoot, "extensions/gentle-design.ts");
const jobsOwnerExtension = resolve(packageRoot, "extensions/gentle-agents.ts");
const WAIT_TIMEOUT_MS = 20_000;

/** Isolated filesystem, no provider, no network, no inherited user configuration. */
function isolatedRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	for (const name of ["home", "sessions", "tmp", "config", "workspace"]) mkdirSync(join(root, name));
	return root;
}

function probeEnvironment(root: string): Record<string, string> {
	const home = join(root, "home");
	const temporary = join(root, "tmp");
	return {
		PATH: process.env.PATH ?? "",
		HOME: home,
		USERPROFILE: home,
		TMPDIR: temporary,
		TMP: temporary,
		TEMP: temporary,
		PI_OFFLINE: "1",
		PI_NO_LOCAL_LLM: "1",
		NO_COLOR: "1",
		GENTLE_SHELL_INTERACTIVE_HOST: "1",
		GENTLE_PI_CONFIG_HOME: join(root, "config"),
		GENTLE_PI_AGENT_HOME: join(home, "agent"),
		PI_CODING_AGENT_DIR: join(home, "agent"),
		GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
	};
}

function probeArgs(root: string, extensions: string[]): string[] {
	return [
		runtime,
		"--mode", "rpc",
		"--no-extensions",
		...extensions.flatMap((extension) => ["-e", extension]),
		"--session-dir", join(root, "sessions"),
		"--offline", "--no-mcp", "--no-skills", "--no-context-files",
	];
}

/** A live RPC session: one request at a time, correlated by record id or requestId. */
class LiveProbe {
	readonly root: string;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly records: Array<Record<string, any>> = [];
	private buffer = "";
	private stderr = "";
	private readonly waiters = new Set<() => void>();
	private readonly closed: Promise<number | null>;

	constructor(root: string, extensions: string[]) {
		this.root = root;
		this.child = spawn(process.execPath, probeArgs(root, extensions), {
			cwd: join(root, "workspace"),
			env: probeEnvironment(root),
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.closed = new Promise((resolveClosed) => this.child.on("close", (code) => resolveClosed(code)));
		this.child.stdout.setEncoding("utf8");
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
		this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line.length > 0) this.records.push(JSON.parse(line));
			newline = this.buffer.indexOf("\n");
		}
		for (const waiter of [...this.waiters]) waiter();
	}

	send(record: Record<string, unknown>): void {
		this.child.stdin.write(`${JSON.stringify(record)}\n`);
	}

	waitFor<T extends Record<string, any>>(predicate: (record: Record<string, any>) => boolean, label: string): Promise<T> {
		const find = () => this.records.find(predicate) as T | undefined;
		const existing = find();
		if (existing) return Promise.resolve(existing);
		return new Promise((resolveWait, rejectWait) => {
			const timer = setTimeout(() => {
				this.waiters.delete(check);
				rejectWait(new Error(`${label} did not arrive within ${WAIT_TIMEOUT_MS}ms; stderr: ${this.stderr.slice(0, 500)}`));
			}, WAIT_TIMEOUT_MS);
			const check = () => {
				const hit = find();
				if (!hit) return;
				clearTimeout(timer);
				this.waiters.delete(check);
				resolveWait(hit);
			};
			this.waiters.add(check);
		});
	}

	desktopPayloads(): Array<Record<string, any>> {
		return this.records
			.filter((record) => record.type === "extension_ui_request" && record.widgetKey === DESKTOP_RPC_WIDGET)
			.map((record) => JSON.parse(record.widgetLines[0]));
	}

	async close(): Promise<{ status: number | null; stderr: string }> {
		if (!this.child.stdin.destroyed) this.child.stdin.end();
		const status = await this.closed;
		return { status, stderr: this.stderr };
	}

	kill(): void {
		this.child.kill("SIGKILL");
	}
}

function desktopRequest(requestId: string, method: string, params: Record<string, unknown> = {}) {
	return { schema: DESKTOP_RPC_SCHEMA, requestId, method, params };
}

function prompt(id: string, request: Record<string, unknown>) {
	return { id, type: "prompt", message: `/gentle:desktop ${JSON.stringify(request)}` };
}

test("installed Pi dispatches Desktop RPC without adding conversation messages", () => {
	const root = isolatedRoot("desktop-rpc-maintainer-");
	try {
		const input = [
			prompt("prompt-1", desktopRequest("real-1", "capabilities")),
			{ id: "messages-1", type: "get_messages" },
		].map((value) => JSON.stringify(value)).join("\n") + "\n";
		const child = spawnSync(process.execPath, probeArgs(root, [desktopExtension]), {
			cwd: join(root, "workspace"),
			env: probeEnvironment(root),
			input,
			encoding: "utf8",
			timeout: 15000,
		});

		assert.ifError(child.error);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(child.stderr, "");
		const records = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
		const promptResponse = records.find((record) => record.id === "prompt-1");
		assert.deepEqual(promptResponse, {
			id: "prompt-1",
			type: "response",
			command: "prompt",
			success: true,
			data: { disposition: "handled" },
		});
		const messages = records.find((record) => record.id === "messages-1");
		assert.deepEqual(messages.data, { messages: [] });

		const widget = records.find((record) => record.type === "extension_ui_request" && record.widgetKey === DESKTOP_RPC_WIDGET);
		assert.equal(widget.method, "setWidget");
		const response = JSON.parse(widget.widgetLines[0]);
		assert.equal(response.schema, DESKTOP_RPC_SCHEMA);
		assert.equal(response.kind, "response");
		assert.equal(response.requestId, "real-1");
		assert.equal(response.ok, true);
		assert.deepEqual(response.data.methods, ["capabilities", "get_snapshot", "get_config", "set_config", "get_permission_mode", "set_permission_mode", "get_subscription_usage", "refresh_subscription_usage", "get_design_canvas", "list_jobs", "cancel_job", "list_subagents", "cancel_subagent"]);
		assert.deepEqual(response.data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "agents_update"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Real production wiring for the read-side config slice: the installed runtime
 * serves `get_config` and the bounded `get_snapshot` projection from isolated,
 * pre-seeded stores without a second store, a watcher, or any write.
 */
test("installed Pi serves Desktop config reads from the existing stores", () => {
	const root = isolatedRoot("desktop-rpc-config-");
	try {
		const configHome = join(root, "config");
		const workspace = join(root, "workspace");
		mkdirSync(join(workspace, ".pi", "gentle-ai"), { recursive: true });
		writeFileSync(
			join(configHome, "profiles.json"),
			`${JSON.stringify({
				kind: "gentle-pi.agent_model_profiles",
				version: 1,
				active: "team",
				profiles: { team: { explore: { model: "anthropic/claude-probe" } } },
			})}\n`,
		);
		const projectModels = `${JSON.stringify({ worker: { model: "openai/gpt-probe" } })}\n`;
		writeFileSync(join(workspace, ".pi", "gentle-ai", "models.json"), projectModels);

		const input = [
			prompt("prompt-config", desktopRequest("config-1", "get_config", { store: "profiles" })),
			prompt("prompt-models", desktopRequest("config-2", "get_config", { store: "models" })),
			prompt("prompt-snapshot", desktopRequest("config-3", "get_snapshot")),
		].map((value) => JSON.stringify(value)).join("\n") + "\n";
		const child = spawnSync(process.execPath, probeArgs(root, [desktopExtension]), {
			cwd: workspace,
			env: probeEnvironment(root),
			input,
			encoding: "utf8",
			timeout: 15000,
		});

		assert.ifError(child.error);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(child.stderr, "");
		const records = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
		const payloads = records
			.filter((record) => record.type === "extension_ui_request" && record.widgetKey === DESKTOP_RPC_WIDGET)
			.map((record) => JSON.parse(record.widgetLines[0]));
		const byRequest = (id: string) => payloads.find((payload) => payload.requestId === id && payload.kind === "response");

		const profiles = byRequest("config-1");
		assert.equal(profiles.ok, true);
		assert.equal(profiles.data.store, "profiles");
		assert.equal(profiles.data.scope, "global");
		assert.equal(profiles.data.readOnly, false);
		assert.equal(profiles.data.status, "ok");
		assert.equal(profiles.data.value.active, "team");
		assert.match(profiles.data.revision, /^sha256:[a-f0-9]{32}$/);

		const models = byRequest("config-2");
		assert.equal(models.ok, true);
		assert.equal(models.data.store, "models");
		assert.equal(models.data.readOnly, true);
		assert.deepEqual(models.data.value, { worker: { model: "openai/gpt-probe" } });

		const snapshot = byRequest("config-3").data;
		assert.equal(snapshot.state.config.stores.length, 6);
		assert.deepEqual(
			snapshot.state.config.stores.map((entry: any) => entry.store),
			["profiles", "models", "profile_fallbacks", "subagents", "pins", "managed_assets"],
		);
		assert.equal(snapshot.state.config.stores[0].status, "ok");
		assert.equal(JSON.stringify(snapshot).includes("claude-probe"), false, "snapshots stay bounded");

		assert.equal(payloads.some((payload) => payload.kind === "event"), false, "a read emits nothing");
		assert.equal(readFileSync(join(workspace, ".pi", "gentle-ai", "models.json"), "utf8"), projectModels);
		assert.equal(existsSync(join(root, "config", "profile-fallbacks.json")), false, "no store is created by a read");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Real production wiring for the read-side usage slice: the installed runtime
 * loads the actual usage owner (`extensions/gentle-shell.ts`, which owns the
 * UsageStore / UsageSourceRegistry / refreshUsage / after_provider_response
 * closures) plus this transport extension. `get_subscription_usage` is a read,
 * so the probe stays fully offline and only observes truthful pending answers
 * — it never triggers a live provider refresh.
 */
test("installed Pi serves offline subscription usage reads from the real owner", () => {
	const root = isolatedRoot("desktop-rpc-usage-");
	try {
		const input = [
			prompt("prompt-anthropic", desktopRequest("usage-1", "get_subscription_usage", { provider: "anthropic" })),
			prompt("prompt-codex", desktopRequest("usage-2", "get_subscription_usage", { provider: "openai-codex" })),
			prompt("prompt-all", desktopRequest("usage-3", "get_subscription_usage")),
		].map((value) => JSON.stringify(value)).join("\n") + "\n";
		const child = spawnSync(process.execPath, probeArgs(root, [usageOwnerExtension, desktopExtension]), {
			cwd: join(root, "workspace"),
			env: probeEnvironment(root),
			input,
			encoding: "utf8",
			timeout: 15000,
		});

		assert.ifError(child.error);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(child.stderr, "");
		const records = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
		const payloads = records
			.filter((record) => record.type === "extension_ui_request" && record.widgetKey === DESKTOP_RPC_WIDGET)
			.map((record) => JSON.parse(record.widgetLines[0]));
		const byRequest = (id: string) => payloads.find((payload) => payload.requestId === id && payload.kind === "response");

		// Anthropic has no usage endpoint; offline it must stay pending, never a
		// fabricated snapshot or a failed fetch.
		const anthropic = byRequest("usage-1");
		assert.equal(anthropic.ok, true, JSON.stringify(anthropic));
		assert.deepEqual(anthropic.data.providers, [{ provider: "anthropic", status: "pending" }]);

		const codex = byRequest("usage-2");
		assert.equal(codex.ok, true, JSON.stringify(codex));
		assert.deepEqual(codex.data.providers, [{ provider: "openai-codex", status: "pending" }]);

		const all = byRequest("usage-3");
		assert.equal(all.ok, true, JSON.stringify(all));
		assert.ok(Array.isArray(all.data.providers), "an unfiltered read projects the scope providers");

		assert.equal(payloads.some((payload) => payload.kind === "event"), false, "an offline read emits nothing");
		assert.equal(JSON.stringify(payloads).includes("chatgpt.com"), false, "no endpoint leaks into the wire");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Real production wiring for the read-side design slice: the installed runtime
 * loads the actual design owner (`extensions/gentle-design.ts`, which owns the
 * single `DesignCanvas` from `createDesignCanvas` plus `listDesigns`) alongside
 * this transport extension. `get_design_canvas` is a read, so the probe stays
 * fully offline and observes the truthful owner-loaded stopped state — it never
 * starts a canvas server or opens a browser.
 */
test("installed Pi serves the owner-loaded stopped design canvas without starting a server", () => {
	const root = isolatedRoot("desktop-rpc-design-");
	try {
		const input = [
			prompt("prompt-canvas", desktopRequest("design-1", "get_design_canvas")),
			prompt("prompt-url", desktopRequest("design-2", "get_design_canvas", { includeUrl: true })),
		].map((value) => JSON.stringify(value)).join("\n") + "\n";
		const child = spawnSync(process.execPath, probeArgs(root, [designOwnerExtension, desktopExtension]), {
			cwd: join(root, "workspace"),
			env: probeEnvironment(root),
			input,
			encoding: "utf8",
			timeout: 15000,
		});

		assert.ifError(child.error);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(child.stderr, "");
		const records = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
		const payloads = records
			.filter((record) => record.type === "extension_ui_request" && record.widgetKey === DESKTOP_RPC_WIDGET)
			.map((record) => JSON.parse(record.widgetLines[0]));
		const byRequest = (id: string) => payloads.find((payload) => payload.requestId === id && payload.kind === "response");

		const canvas = byRequest("design-1");
		assert.equal(canvas.ok, true, JSON.stringify(canvas));
		assert.deepEqual(canvas.data, { running: false, slug: null, connectedClients: 0, designs: [] });
		assert.equal("url" in canvas.data, false, "the tokenized URL is never a default field");

		// Even an explicit includeUrl cannot invent a URL for a canvas that is not
		// running; the capability simply stays absent.
		const withUrl = byRequest("design-2");
		assert.equal(withUrl.ok, true, JSON.stringify(withUrl));
		assert.equal("url" in withUrl.data, false, "a stopped canvas has no URL to include");

		assert.equal(payloads.some((payload) => payload.kind === "event"), false, "an offline read emits nothing");
		assert.equal(JSON.stringify(payloads).includes("/tok/"), false, "no tokenized URL leaks into the wire");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Real production wiring for the jobs slice: the installed runtime loads the
 * actual jobs owner (`extensions/gentle-agents.ts`, which owns the single
 * parent-session `JobRegistry` plus the parent `MonitorController`) alongside
 * this transport extension. `list_jobs` is a read, so the probe stays offline
 * and observes the truthful owner-loaded empty list — it never starts a job.
 */
test("installed Pi serves the owner-loaded empty job list without starting a job", () => {
	const root = isolatedRoot("desktop-rpc-jobs-");
	try {
		const input = [
			prompt("prompt-list", desktopRequest("jobs-1", "list_jobs")),
		].map((value) => JSON.stringify(value)).join("\n") + "\n";
		const child = spawnSync(process.execPath, probeArgs(root, [jobsOwnerExtension, desktopExtension]), {
			cwd: join(root, "workspace"),
			env: probeEnvironment(root),
			input,
			encoding: "utf8",
			timeout: 20000,
		});

		assert.ifError(child.error);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(child.stderr, "");
		const records = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
		const payloads = records
			.filter((record) => record.type === "extension_ui_request" && record.widgetKey === DESKTOP_RPC_WIDGET)
			.map((record) => JSON.parse(record.widgetLines[0]));
		const byRequest = (id: string) => payloads.find((payload) => payload.requestId === id && payload.kind === "response");

		const list = byRequest("jobs-1");
		assert.equal(list.ok, true, JSON.stringify(list));
		assert.deepEqual(list.data, { jobs: [] }, "no jobs exist, so the list is empty rather than fabricated");

		assert.equal(payloads.some((payload) => payload.kind === "event"), false, "an offline list emits nothing");
		assert.equal(JSON.stringify(payloads).includes("command"), false, "no command text leaks into the wire");
		assert.equal(JSON.stringify(payloads).includes("outputPath"), false, "no output path leaks into the wire");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Real production wiring for the subagents slice: the installed runtime loads
 * the actual agents owner (`extensions/gentle-agents.ts`, which owns the single
 * parent-session `TaskStore` plus the parent `AgentRunner`) alongside this
 * transport extension. `list_subagents` is a read, so the probe stays offline
 * and observes the truthful owner-loaded empty list — it never starts a child.
 */
test("installed Pi serves the owner-loaded empty subagent list without starting a child", () => {
	const root = isolatedRoot("desktop-rpc-agents-");
	try {
		const input = [
			prompt("prompt-list", desktopRequest("agents-1", "list_subagents")),
		].map((value) => JSON.stringify(value)).join("\n") + "\n";
		const child = spawnSync(process.execPath, probeArgs(root, [jobsOwnerExtension, desktopExtension]), {
			cwd: join(root, "workspace"),
			env: probeEnvironment(root),
			input,
			encoding: "utf8",
			timeout: 20000,
		});

		assert.ifError(child.error);
		assert.equal(child.status, 0, child.stderr);
		assert.equal(child.stderr, "");
		const records = child.stdout.trim().split("\n").map((line) => JSON.parse(line));
		const payloads = records
			.filter((record) => record.type === "extension_ui_request" && record.widgetKey === DESKTOP_RPC_WIDGET)
			.map((record) => JSON.parse(record.widgetLines[0]));
		const byRequest = (id: string) => payloads.find((payload) => payload.requestId === id && payload.kind === "response");

		const list = byRequest("agents-1");
		assert.equal(list.ok, true, JSON.stringify(list));
		assert.deepEqual(list.data, { agents: [] }, "no subagents exist, so the list is empty rather than fabricated");

		assert.equal(payloads.some((payload) => payload.kind === "event"), false, "an offline list emits nothing");
		assert.equal(JSON.stringify(payloads).includes("prompt"), false, "no prompt text leaks into the wire");
		assert.equal(JSON.stringify(payloads).includes("sessionPath"), false, "no session path leaks into the wire");
		assert.equal(JSON.stringify(payloads).includes("cwd"), false, "no working directory leaks into the wire");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Real production wiring for the write slice: the installed runtime serves a
 * `set_config` round trip through the existing `profiles.json` owner, writes the
 * isolated file atomically, emits exactly one ordered `config_changed`, and adds
 * no conversation message. Nothing here reimplements the store owner.
 */
test("installed Pi applies a Desktop config write through the existing store owner", async () => {
	const root = isolatedRoot("desktop-rpc-config-write-");
	const probe = new LiveProbe(root, [desktopExtension]);
	try {
		const configHome = join(root, "config");
		const path = join(configHome, "profiles.json");
		writeFileSync(
			path,
			`${JSON.stringify({
				kind: "gentle-pi.agent_model_profiles",
				version: 1,
				active: "team",
				profiles: { team: { explore: { model: "anthropic/claude-probe" } } },
			})}\n`,
		);
		const responseFor = (requestId: string) => probe.waitFor(
			(record) => record.type === "extension_ui_request" && record.widgetKey === DESKTOP_RPC_WIDGET &&
				JSON.parse(record.widgetLines[0]).kind === "response" &&
				JSON.parse(record.widgetLines[0]).requestId === requestId,
			`response ${requestId}`,
		).then((record) => JSON.parse(record.widgetLines[0]));

		probe.send(prompt("prompt-read", desktopRequest("read-1", "get_config", { store: "profiles" })));
		const before = await responseFor("read-1");
		assert.equal(before.ok, true, JSON.stringify(before));
		const writeTarget = before.data.writeTargets.find((entry: any) => entry.target === "global");
		assert.equal(writeTarget.status, "ok");
		const previousBytes = readFileSync(path, "utf8");

		const data = {
			kind: "gentle-pi.agent_model_profiles",
			version: 1,
			active: "team",
			profiles: {
				team: { explore: { model: "anthropic/claude-probe" } },
				ops: { worker: { model: "openai/gpt-probe-write", thinking: "high" } },
			},
		};
		probe.send(prompt("prompt-write", desktopRequest("write-1", "set_config", {
			store: "profiles",
			data,
			expectedRevision: writeTarget.writeRevision,
		})));
		const written = await responseFor("write-1");
		assert.equal(written.ok, true, JSON.stringify(written));
		assert.equal(written.data.changed, true);
		assert.equal(written.data.writeTarget, "global");
		assert.equal(written.data.readOnly, false);
		assert.deepEqual(Object.keys(written.data.value.profiles).sort(), ["ops", "team"]);

		const event = await probe.waitFor(
			(record) => record.type === "extension_ui_request" && record.widgetKey === DESKTOP_RPC_WIDGET &&
				JSON.parse(record.widgetLines[0]).event === "config_changed",
			"config_changed event",
		).then((record) => JSON.parse(record.widgetLines[0]));
		assert.equal(event.seq, 1);
		assert.deepEqual(event.data, {
			store: "profiles",
			scope: "global",
			writeTarget: "global",
			revision: written.data.revision,
			writeRevision: written.data.writeRevision,
			source: "desktop",
		});

		probe.send(prompt("prompt-read-2", desktopRequest("read-2", "get_config", { store: "profiles" })));
		const after = await responseFor("read-2");
		assert.equal(after.ok, true, JSON.stringify(after));
		assert.deepEqual(Object.keys(after.data.value.profiles).sort(), ["ops", "team"]);
		assert.notEqual(after.data.revision, before.data.revision);

		probe.send({ id: "messages-1", type: "get_messages" });
		const messages = await probe.waitFor((record) => record.id === "messages-1", "get_messages response");
		assert.deepEqual(messages.data, { messages: [] }, "control traffic never reaches the conversation");

		for (const id of ["prompt-read", "prompt-write", "prompt-read-2"]) {
			assert.deepEqual(
				await probe.waitFor((record) => record.id === id, `prompt response ${id}`),
				{ id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } },
			);
		}

		const onDisk = readFileSync(path, "utf8");
		assert.notEqual(onDisk, previousBytes, "the isolated store really changed on disk");
		assert.equal(onDisk, serializeProfilesFile(normalizeProfilesFile(data)!.file), "the owner serialization is the disk content");
		assert.deepEqual(JSON.parse(onDisk).profiles.ops, { worker: { model: "openai/gpt-probe-write", thinking: "high" } });
		assert.equal(existsSync(join(configHome, "profile-fallbacks.json")), false, "no other store is created");

		assert.deepEqual(
			probe.desktopPayloads().map((payload) => `${payload.kind}:${payload.requestId ?? payload.event}`),
			["response:read-1", "response:write-1", "event:config_changed", "response:read-2"],
			"one ordered event follows its response and nothing else is emitted",
		);

		const closed = await probe.close();
		assert.equal(closed.status, 0, closed.stderr);
		assert.equal(closed.stderr, "");
	} finally {
		probe.kill();
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Real production wiring: the installed Pi runtime loads the actual owner
 * extension (`extensions/gentle-ai.ts`, which registers the
 * YoloSessionController) plus this transport extension. Nothing here
 * reimplements the owner. Requests are sent one at a time because Pi's RPC
 * loop dispatches prompts concurrently.
 */
test("installed Pi applies a Desktop permission change through the real owner without a restart", async () => {
	const root = isolatedRoot("desktop-rpc-owner-");
	const probe = new LiveProbe(root, [ownerExtension, desktopExtension]);
	try {
		const responseFor = (requestId: string) => probe.waitFor(
			(record) => record.type === "extension_ui_request" && record.widgetKey === DESKTOP_RPC_WIDGET &&
				JSON.parse(record.widgetLines[0]).kind === "response" &&
				JSON.parse(record.widgetLines[0]).requestId === requestId,
			`response ${requestId}`,
		).then((record) => JSON.parse(record.widgetLines[0]));

		probe.send(prompt("prompt-read-1", desktopRequest("read-1", "get_permission_mode")));
		const before = await responseFor("read-1");
		assert.deepEqual(before.data, { mode: "normal", default_mode: "normal" });

		probe.send(prompt("prompt-set", desktopRequest("set-1", "set_permission_mode", { mode: "auto", persist: false })));
		const set = await responseFor("set-1");
		assert.deepEqual(set.data, { mode: "auto", default_mode: "normal", persisted: false, changed: true });
		const event = await probe.waitFor(
			(record) => record.type === "extension_ui_request" && record.widgetKey === DESKTOP_RPC_WIDGET &&
				JSON.parse(record.widgetLines[0]).event === "permission_mode_changed",
			"permission_mode_changed event",
		).then((record) => JSON.parse(record.widgetLines[0]));
		assert.equal(event.seq, 1);
		assert.deepEqual(event.data, {
			mode: "auto",
			previous_mode: "normal",
			default_mode: "normal",
			persisted: false,
			source: "desktop",
		});

		probe.send(prompt("prompt-read-2", desktopRequest("read-2", "get_permission_mode")));
		const after = await responseFor("read-2");
		assert.deepEqual(after.data, { mode: "auto", default_mode: "normal" }, "the same process reads the applied mode");

		probe.send({ id: "messages-1", type: "get_messages" });
		const messages = await probe.waitFor((record) => record.id === "messages-1", "get_messages response");
		assert.deepEqual(messages.data, { messages: [] }, "control traffic never reaches the conversation");

		for (const id of ["prompt-read-1", "prompt-set", "prompt-read-2"]) {
			assert.deepEqual(
				await probe.waitFor((record) => record.id === id, `prompt response ${id}`),
				{ id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } },
			);
		}
		assert.deepEqual(
			probe.desktopPayloads().map((payload) => `${payload.kind}:${payload.requestId ?? payload.event}`),
			["response:read-1", "response:set-1", "event:permission_mode_changed", "response:read-2"],
			"one ordered event follows its response and nothing else is emitted",
		);
		assert.equal(existsSync(join(root, "config", "permission-mode.json")), false, "persist:false never writes the default");

		const closed = await probe.close();
		assert.equal(closed.status, 0, closed.stderr);
		assert.equal(closed.stderr, "");
	} finally {
		probe.kill();
		rmSync(root, { recursive: true, force: true });
	}
});
