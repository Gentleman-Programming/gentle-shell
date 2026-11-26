import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import gentleAgents, { type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { createJobRegistry, createOutputTail, MAX_TAIL_LINE_CHARS, TAIL_LINES, type JobExecOperations, type JobRecord } from "../lib/background-jobs.ts";
import { createMonitorController, type MonitorController } from "../lib/background-monitor.ts";
import { registerBackgroundJobTools } from "../lib/background-jobs-tools.ts";
import {
	DESKTOP_JOBS_EVENT,
	DESKTOP_JOBS_EVENTS,
	DESKTOP_JOBS_LIST_LIMIT,
	DESKTOP_JOBS_METHODS,
	DESKTOP_JOBS_SERVICE_CHANNEL,
	DESKTOP_JOBS_SERVICE_SCHEMA,
	INVALID_JOBS_PARAMS,
	isDesktopJobsServiceShape,
	JOB_NOT_FOUND,
	JOBS_UNAVAILABLE,
	DESKTOP_JOB_OUTPUT_MAX_CHARS,
	parseCancelJobParams,
	parseDesktopJobEntry,
	parseDesktopJobOutput,
	parseJobOutputParams,
	parseListJobsParams,
	plainJobOutput,
	projectDesktopJob,
	projectDesktopJobOutput,
	selectDesktopJobs,
	type DesktopJobEntry,
	type DesktopJobsOwnerRead,
	type DesktopJobsService,
} from "../lib/desktop-rpc-jobs.ts";
import { DesktopJobsBridge, discoverDesktopJobsService } from "../lib/desktop-jobs-service.ts";
import { JOBS_FINISHED_TTL_MS } from "../lib/jobs-widget.ts";
import { DESKTOP_RPC_SCHEMA, DesktopRpcRouter, type DesktopRpcDomain } from "../lib/desktop-rpc.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// Settling closes the job's log file first, which takes real I/O turns.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// ---- Fixtures: the existing background-job fake, plus a fake monitor ----

interface FakeRun {
	command: string;
	cwd: string;
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	resolve: (exitCode: number | null) => void;
	reject: (error: Error) => void;
}

function fakeOperations() {
	const runs: FakeRun[] = [];
	const operations: JobExecOperations = {
		exec: (command, cwd, options) => new Promise((resolve, reject) => {
			const run: FakeRun = { command, cwd, onData: options.onData, signal: options.signal, resolve: (exitCode) => resolve({ exitCode }), reject };
			options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			runs.push(run);
		}),
	};
	return { runs, operations };
}

interface RegistryFixture {
	dir: string;
	fake: ReturnType<typeof fakeOperations>;
	settled: JobRecord[];
	registry: ReturnType<typeof createJobRegistry>;
	monitors: MonitorController;
	monitorCancels: string[];
	now(): number;
	tick(ms: number): void;
	cleanup(): void;
}

function makeRegistry(): RegistryFixture {
	const dir = mkdtempSync(join(tmpdir(), "desktop-rpc-jobs-"));
	const fake = fakeOperations();
	const settled: JobRecord[] = [];
	let clock = 1000;
	const registry = createJobRegistry({
		outputDir: () => dir,
		now: () => clock,
		shell: () => ({ operations: fake.operations }),
		onSettled: (job) => settled.push(job),
	});
	const monitorCancels: string[] = [];
	const monitors = createMonitorController({
		registry,
		schedule: (fn, ms) => {
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		},
		now: () => clock,
		deliver: () => {},
	});
	// Observe the monitor's cancel path without a second monitor manager.
	const originalCancel = monitors.cancel.bind(monitors);
	monitors.cancel = (id: string) => { monitorCancels.push(id); originalCancel(id); };
	const tick = (ms: number) => { clock += ms; };
	return { dir, fake, settled, registry, monitors, monitorCancels, now: () => clock, tick, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeOwnerService(fixture: RegistryFixture, sessionId = "session-a") {
	const observers = new Set<(sessionId: string) => void>();
	let disposed = false;
	const service: DesktopJobsService = {
		schema: DESKTOP_JOBS_SERVICE_SCHEMA,
		read: (): DesktopJobsOwnerRead => ({ sessionId, jobs: disposed ? [] : selectDesktopJobs(fixture.registry.list(sessionId), fixture.now()) }),
		cancel: (id: string) => {
			if (disposed) return { kind: "not_found" };
			const job = fixture.registry.get(id);
			if (!job || job.ownerSessionId !== sessionId) return { kind: "not_found" };
			const wasRunning = job.status === "running";
			fixture.monitors.cancel(job.id);
			fixture.registry.stop(job.id);
			return { kind: "ok", job: projectDesktopJob(job), changed: wasRunning };
		},
		output: (id: string) => {
			if (disposed) return { kind: "not_found" };
			const job = fixture.registry.get(id);
			if (!job || job.ownerSessionId !== sessionId) return { kind: "not_found" };
			return { kind: "ok", view: projectDesktopJobOutput(job) };
		},
		observe: (onChange) => {
			observers.add(onChange);
			return () => observers.delete(onChange);
		},
		dispose: () => { disposed = true; observers.clear(); },
	};
	return { service, observers, notify: (id: string) => { for (const observer of [...observers]) observer(id); } };
}

function makeBridge(service: DesktopJobsService, sessionId = "session-a") {
	const bridge = new DesktopJobsBridge({} as ExtensionAPI, { discover: async () => service });
	const host = { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
	bridge.attach(host);
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	bridge.wire((event, data) => events.push({ event, data }));
	return { bridge, events };
}

// ---- Pure contract: projection and params ----

test("projectDesktopJob keeps only the whitelist and never command/cwd/path/tail", () => {
	const job: JobRecord = {
		id: "job-1",
		kind: "command",
		label: "CI for PR 42",
		command: "gh run watch 42 --exit-status",
		cwd: "/home/devel/secret-repo",
		ownerSessionId: "session-a",
		outputPath: "/tmp/gentle-jobs/job-1.log",
		startedAt: 1000,
		status: "running",
		tail: ["secret output line"],
	};
	assert.deepEqual(projectDesktopJob(job), { id: "job-1", label: "CI for PR 42", status: "running", startedAt: 1000 });

	job.status = "exited";
	job.endedAt = 2000;
	job.exitCode = 0;
	job.tail = ["done"];
	assert.deepEqual(projectDesktopJob(job), { id: "job-1", label: "CI for PR 42", status: "exited", startedAt: 1000, endedAt: 2000, exitCode: 0 });

	job.exitCode = null;
	assert.deepEqual(projectDesktopJob(job), { id: "job-1", label: "CI for PR 42", status: "exited", startedAt: 1000, endedAt: 2000, exitCode: null });

	// The projection can never carry a secret field, whatever the source object held.
	const projected = JSON.stringify(projectDesktopJob(job));
	assert.equal(projected.includes("gh run"), false);
	assert.equal(projected.includes("secret-repo"), false);
	assert.equal(projected.includes("gentle-jobs"), false);
	assert.equal(projected.includes("secret output"), false);
});

test("selectDesktopJobs keeps running first then recent finished, bounded", () => {
	const job = (id: string, startedAt: number, status: JobRecord["status"], endedAt?: number): JobRecord => ({
		id, kind: "command", label: id, command: "c", cwd: "/", ownerSessionId: "s", outputPath: "/p", startedAt, status, endedAt, exitCode: status === "exited" ? 0 : undefined, tail: [],
	});
	const jobs = [job("job-1", 100, "running"), job("job-2", 200, "exited", 300), job("job-3", 150, "stopped", 400)];
	const now = 300 + JOBS_FINISHED_TTL_MS - 1;
	const selected = selectDesktopJobs(jobs, now);
	assert.deepEqual(selected.map((entry) => entry.id), ["job-1", "job-3", "job-2"], "running first, then finished newest-end first");

	// A finished job beyond the TTL drops out.
	assert.deepEqual(selectDesktopJobs(jobs, 400 + JOBS_FINISHED_TTL_MS).map((entry) => entry.id), ["job-1"]);

	// The list is bounded even with far more finished jobs than the limit.
	const many = Array.from({ length: DESKTOP_JOBS_LIST_LIMIT + 20 }, (_, i) => job(`job-${i}`, i, "exited", i + 1));
	assert.equal(selectDesktopJobs(many, 10_000).length, DESKTOP_JOBS_LIST_LIMIT);
});

test("params parsers accept only the documented shapes", () => {
	assert.deepEqual(parseListJobsParams({}), { ok: true });
	assert.deepEqual(parseListJobsParams({ unexpected: true }), { error: INVALID_JOBS_PARAMS });
	assert.deepEqual(parseCancelJobParams({ id: "job-1" }), { id: "job-1" });
	for (const params of [{}, { id: "" }, { id: 1 }, { id: "job-1", extra: true }, { job_id: "job-1" }]) {
		assert.deepEqual(parseCancelJobParams(params), { error: INVALID_JOBS_PARAMS }, JSON.stringify(params));
	}
});

test("isDesktopJobsServiceShape accepts only the versioned adapter", () => {
	const good = { schema: DESKTOP_JOBS_SERVICE_SCHEMA, read: () => ({ sessionId: "s", jobs: [] }), cancel: () => ({ kind: "not_found" }), observe: () => () => {}, dispose: () => {} };
	assert.equal(isDesktopJobsServiceShape(good), true);
	assert.equal(isDesktopJobsServiceShape({ ...good, schema: "gentle-pi.desktop-jobs-service/v0" }), false);
	assert.equal(isDesktopJobsServiceShape({ ...good, cancel: undefined }), false);
	assert.equal(isDesktopJobsServiceShape(null), false);
	assert.equal(isDesktopJobsServiceShape("nope"), false);
});

test("parseDesktopJobEntry re-validates owner entries and drops foreign fields", () => {
	assert.deepEqual(parseDesktopJobEntry({ id: "j", label: "l", status: "running", startedAt: 1 }), { id: "j", label: "l", status: "running", startedAt: 1 });
	assert.deepEqual(
		parseDesktopJobEntry({ id: "j", label: "l", status: "exited", startedAt: 1, endedAt: 2, exitCode: 0, command: "rm -rf /", cwd: "/etc", outputPath: "/secret", tail: ["x"] }),
		{ id: "j", label: "l", status: "exited", startedAt: 1, endedAt: 2, exitCode: 0 },
	);
	for (const bad of [
		null,
		{ id: "", label: "l", status: "running", startedAt: 1 },
		{ id: "j", label: 1, status: "running", startedAt: 1 },
		{ id: "j", label: "l", status: "exploded", startedAt: 1 },
		{ id: "j", label: "l", status: "running", startedAt: "yesterday" },
		{ id: "j", label: "l", status: "running", startedAt: -1 },
		{ id: "j", label: "l", status: "exited", startedAt: 1, endedAt: "soon" },
		{ id: "j", label: "l", status: "exited", startedAt: 1, exitCode: "0" },
		{ id: "j", label: "l", status: "exited", startedAt: 1, exitCode: Number.NaN },
	]) {
		assert.equal(parseDesktopJobEntry(bad), undefined, JSON.stringify(bad));
	}
});

// ---- Bridge reads ----

test("list_jobs answers the projected active-session list and emits nothing", async () => {
	const fixture = makeRegistry();
	try {
		const { service } = makeOwnerService(fixture);
		fixture.registry.start({ command: "make ci", cwd: "/repo", ownerSessionId: "session-a", label: "CI" });
		const { bridge, events } = makeBridge(service);
		const outcome = await bridge.handle("list_jobs", {});
		assert.equal(outcome.ok, true);
		assert.deepEqual((outcome as { ok: true; data: Record<string, unknown> }).data, {
			jobs: [{ id: "job-1", label: "CI", status: "running", startedAt: 1000 }],
		});
		assert.equal(events.length, 0, "a read emits nothing");
	} finally {
		fixture.cleanup();
	}
});

test("list_jobs filters out foreign sessions", async () => {
	const fixture = makeRegistry();
	try {
		const { service } = makeOwnerService(fixture, "session-a");
		fixture.registry.start({ command: "a", cwd: "/", ownerSessionId: "session-a", label: "mine" });
		fixture.registry.start({ command: "b", cwd: "/", ownerSessionId: "session-b", label: "theirs" });
		const { bridge } = makeBridge(service, "session-a");
		const outcome = await bridge.handle("list_jobs", {});
		assert.equal(outcome.ok, true);
		assert.deepEqual(
			((outcome as { ok: true; data: Record<string, unknown> }).data as { jobs: DesktopJobEntry[] }).jobs.map((entry) => entry.label),
			["mine"],
		);
	} finally {
		fixture.cleanup();
	}
});

test("invalid params are rejected before any owner discovery", async () => {
	const fixture = makeRegistry();
	try {
		const { service } = makeOwnerService(fixture);
		let discoveries = 0;
		const bridge = new DesktopJobsBridge({} as ExtensionAPI, { discover: async () => { discoveries += 1; return service; } });
		bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
		for (const params of [{ unexpected: true }]) {
			const bad = await bridge.handle("list_jobs", params);
			assert.equal(bad.ok, false);
			assert.deepEqual(bad.error, INVALID_JOBS_PARAMS);
		}
		for (const params of [{}, { id: "" }, { id: 1 }, { id: "job-1", extra: true }]) {
			const bad = await bridge.handle("cancel_job", params);
			assert.equal(bad.ok, false);
			assert.deepEqual(bad.error, INVALID_JOBS_PARAMS);
		}
		assert.equal(discoveries, 0, "invalid params never reach discovery");
	} finally {
		fixture.cleanup();
	}
});

test("no owner answers jobs_unavailable rather than inventing an empty list", async () => {
	const bridge = new DesktopJobsBridge({} as ExtensionAPI, { discover: async () => undefined });
	bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	const outcome = await bridge.handle("list_jobs", {});
	assert.equal(outcome.ok, false);
	assert.deepEqual(outcome.error, JOBS_UNAVAILABLE);
});

test("a throwing or malformed owner never leaks raw errors or command text", async () => {
	const throwing: DesktopJobsService = {
		schema: DESKTOP_JOBS_SERVICE_SCHEMA,
		read: () => { throw new Error("secret command /tmp/job-1.log /etc/passwd"); },
		cancel: () => { throw new Error("secret command /tmp/job-1.log /etc/passwd"); },
		observe: () => () => {},
		dispose: () => {},
	};
	const { bridge } = makeBridge(throwing);
	const read = await bridge.handle("list_jobs", {});
	assert.equal(read.ok, false);
	assert.equal(JSON.stringify(read).includes("secret command"), false);
	assert.deepEqual(read.error, JOBS_UNAVAILABLE);
	const cancelled = await bridge.handle("cancel_job", { id: "job-1" });
	assert.equal(cancelled.ok, false);
	assert.equal(JSON.stringify(cancelled).includes("secret command"), false);

	// A foreign command field on an owner entry is dropped, never echoed and never
	// turned into a failure: the projection rebuilds only whitelisted fields.
	const malformed: DesktopJobsService = {
		schema: DESKTOP_JOBS_SERVICE_SCHEMA,
		read: () => ({ sessionId: "session-a", jobs: [{ id: "j", label: "l", status: "running", startedAt: 1, command: "rm -rf /" }] as unknown as DesktopJobEntry[] }),
		cancel: () => ({ kind: "not_found" }),
		observe: () => () => {},
		dispose: () => {},
	};
	const badBridge = makeBridge(malformed);
	const bad = await badBridge.bridge.handle("list_jobs", {});
	assert.equal(bad.ok, true);
	assert.deepEqual((bad as { ok: true; data: Record<string, unknown> }).data, { jobs: [{ id: "j", label: "l", status: "running", startedAt: 1 }] });
	assert.equal(JSON.stringify(bad).includes("rm -rf"), false);
});

// ---- Cancel: the job_stop stop path ----

test("cancel_job stops a running job through the same monitor-cancel + registry-stop path", async () => {
	const fixture = makeRegistry();
	try {
		const { service } = makeOwnerService(fixture);
		const job = fixture.registry.start({ command: "make ci", cwd: "/repo", ownerSessionId: "session-a", label: "CI" });
		const { bridge, events } = makeBridge(service);
		const outcome = await bridge.handle("cancel_job", { id: job.id });
		assert.equal(outcome.ok, true);
		assert.deepEqual((outcome as { ok: true; data: Record<string, unknown> }).data, {
			job: { id: "job-1", label: "CI", status: "stopped", startedAt: 1000, endedAt: 1000 },
		});
		assert.equal(fixture.registry.get(job.id)!.status, "stopped", "the real registry stopped the job");
		assert.deepEqual(fixture.monitorCancels, ["job-1"], "the monitor cancel path ran");
		assert.equal(events.length, 0, "the observer is not the event source for a Desktop cancel");
	} finally {
		fixture.cleanup();
	}
});

test("cancel_job of an already-terminal job answers its terminal state without an error or event", async () => {
	const fixture = makeRegistry();
	try {
		const { service } = makeOwnerService(fixture);
		const job = fixture.registry.start({ command: "make ci", cwd: "/repo", ownerSessionId: "session-a", label: "CI" });
		fixture.fake.runs[0]!.resolve(0);
		await settle();
		const { bridge, events } = makeBridge(service);
		const outcome = await bridge.handle("cancel_job", { id: job.id });
		assert.equal(outcome.ok, true);
		const data = (outcome as { ok: true; data: Record<string, unknown> }).data as { job: DesktopJobEntry };
		assert.equal(data.job.status, "exited");
		assert.equal(data.job.exitCode, 0);
		assert.equal(events.length, 0, "an already-terminal cancel emits nothing");
	} finally {
		fixture.cleanup();
	}
});

test("cancel_job unknown and foreign-session ids are typed not_found", async () => {
	const fixture = makeRegistry();
	try {
		const { service } = makeOwnerService(fixture, "session-a");
		fixture.registry.start({ command: "a", cwd: "/", ownerSessionId: "session-b", label: "theirs" });
		const { bridge } = makeBridge(service, "session-a");
		const foreign = await bridge.handle("cancel_job", { id: "job-1" });
		assert.equal(foreign.ok, false);
		assert.deepEqual(foreign.error, JOB_NOT_FOUND);

		const unknown = await bridge.handle("cancel_job", { id: "job-99" });
		assert.equal(unknown.ok, false);
		assert.deepEqual(unknown.error, JOB_NOT_FOUND);
		assert.equal(fixture.registry.get("job-1")!.status, "running", "a foreign job is never stopped");
	} finally {
		fixture.cleanup();
	}
});

// ---- Events: observer-driven registry changes ----

test("agent-driven changes become jobs_update events filtered by active session", async () => {
	const fixture = makeRegistry();
	try {
		const { service, notify } = makeOwnerService(fixture, "session-a");
		const { bridge, events } = makeBridge(service, "session-a");
		await bridge.handle("list_jobs", {});
		// A job starts for the active session.
		fixture.registry.start({ command: "a", cwd: "/", ownerSessionId: "session-a", label: "mine" });
		notify("session-a");
		assert.equal(events.length, 1);
		assert.equal(events[0]!.event, DESKTOP_JOBS_EVENT);
		assert.deepEqual(events[0]!.data, { jobs: [{ id: "job-1", label: "mine", status: "running", startedAt: 1000 }] });

		// A foreign-session change does not reach this bridge.
		fixture.registry.start({ command: "b", cwd: "/", ownerSessionId: "session-b", label: "theirs" });
		notify("session-b");
		assert.equal(events.length, 1, "a foreign session change is filtered out");
	} finally {
		fixture.cleanup();
	}
});

test("session reset disconnects observers and drops stale async outcomes", async () => {
	const observers = new Set<(sessionId: string) => void>();
	const service: DesktopJobsService = {
		schema: DESKTOP_JOBS_SERVICE_SCHEMA,
		read: () => ({ sessionId: "session-a", jobs: [] }),
		cancel: () => ({ kind: "not_found" }),
		observe: (onChange) => { observers.add(onChange); return () => observers.delete(onChange); },
		dispose: () => { observers.clear(); },
	};
	let releaseService: (value: DesktopJobsService) => void = () => {};
	const serviceGate = new Promise<DesktopJobsService>((resolve) => { releaseService = resolve; });
	const bridge = new DesktopJobsBridge({} as ExtensionAPI, { discover: () => serviceGate });
	bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	bridge.wire((event, data) => events.push({ event, data }));

	const pending = bridge.handle("list_jobs", {});
	bridge.reset();
	for (const observer of [...observers]) observer("session-a");
	assert.equal(events.length, 0, "a disposed session never delivers a change");
	releaseService(service);
	const outcome = await pending;
	assert.equal(outcome.ok, false, "a stale discovery resolves to a safe typed answer");
	assert.deepEqual(outcome.error, JOBS_UNAVAILABLE);
});

test("a late discovery after reset is disposed and never cached for the next session", async () => {
	const disposed: string[] = [];
	const service: DesktopJobsService = {
		schema: DESKTOP_JOBS_SERVICE_SCHEMA,
		read: () => ({ sessionId: "session-a", jobs: [] }),
		cancel: () => ({ kind: "not_found" }),
		observe: () => () => {},
		dispose: () => { disposed.push("old"); },
	};
	let releaseOld: (value: DesktopJobsService) => void = () => {};
	const oldGate = new Promise<DesktopJobsService>((resolve) => { releaseOld = resolve; });
	let discoverCount = 0;
	const bridge = new DesktopJobsBridge({} as ExtensionAPI, {
		discover: () => { discoverCount += 1; return discoverCount === 1 ? oldGate : Promise.resolve(service); },
	});
	bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	const first = bridge.handle("list_jobs", {});
	bridge.reset();
	releaseOld(service);
	const firstOutcome = await first;
	assert.equal(firstOutcome.ok, false);
	assert.deepEqual(disposed, ["old"], "the late adapter is disposed, never cached");
});

// ---- Discovery ----

test("discoverDesktopJobsService accepts the versioned adapter and ignores malformed responders", async () => {
	const listeners = new Map<string, (value: unknown) => void>();
	const pi = {
		events: {
			on(name: string, handler: (value: unknown) => void) { listeners.set(name, handler); return () => listeners.delete(name); },
			emit(name: string, value: unknown) { listeners.get(name)?.(value); },
		},
	} as unknown as ExtensionAPI;
	const ctx = {} as ExtensionContext;

	listeners.set(DESKTOP_JOBS_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({
			schema: DESKTOP_JOBS_SERVICE_SCHEMA,
			read: () => ({ sessionId: "s", jobs: [] }),
			cancel: () => ({ kind: "not_found" }),
			observe: () => () => {},
			dispose: () => {},
		});
	});
	const service = await discoverDesktopJobsService(pi, ctx);
	assert.equal(service?.schema, DESKTOP_JOBS_SERVICE_SCHEMA);

	listeners.set(DESKTOP_JOBS_SERVICE_CHANNEL, (payload) => {
		(payload as { respond(service: unknown): void }).respond({ schema: "gentle-pi.desktop-jobs-service/v0", read: () => ({ sessionId: "s", jobs: [] }) });
	});
	assert.equal(await discoverDesktopJobsService(pi, ctx), undefined);
});

// ---- Router sequencing: response before event ----

test("the router publishes a changed cancel response before its jobs_update event", async () => {
	const fixture = makeRegistry();
	try {
		const { service } = makeOwnerService(fixture);
		const job = fixture.registry.start({ command: "make ci", cwd: "/repo", ownerSessionId: "session-a", label: "CI" });
		const bridge = new DesktopJobsBridge({} as ExtensionAPI, { discover: async () => service });
		bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
		const domain: DesktopRpcDomain = (method, params) => bridge.handle(method, params as Record<string, unknown>);
		const lines: string[] = [];
		const router = new DesktopRpcRouter(
			["capabilities", "get_snapshot", ...DESKTOP_JOBS_METHODS],
			[...DESKTOP_JOBS_EVENTS],
			undefined,
			domain,
		);
		router.start((line) => lines.push(line));
		await router.handle(JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "cancel-1", method: "cancel_job", params: { id: job.id } }));
		assert.deepEqual(lines.map((line) => JSON.parse(line).kind), ["response", "event"]);
		assert.equal(JSON.parse(lines[0]!).requestId, "cancel-1");
		assert.deepEqual(JSON.parse(lines[1]!).data, { jobs: [{ id: "job-1", label: "CI", status: "stopped", startedAt: 1000, endedAt: 1000 }] });
	} finally {
		fixture.cleanup();
	}
});

// ---- Real tool wiring: the job_stop onChange descriptor ----

test("the real job_stop tool reports a changed stop but not a no-op stop", async () => {
	const fixture = makeRegistry();
	try {
		const changes: Array<{ kind: string; changed: boolean }> = [];
		const tools: Array<{ name: string; execute: (...args: any[]) => Promise<unknown> }> = [];
		registerBackgroundJobTools({
			registerTool: (tool: any) => tools.push(tool),
			registerMessageRenderer: () => {},
		} as unknown as ExtensionAPI, {
			registry: fixture.registry,
			monitors: fixture.monitors,
			sessionId: () => "session-a",
			now: () => fixture.now(),
			onChange: (change) => changes.push({ kind: change.kind, changed: change.kind === "start" ? true : change.changed }),
		});
		const jobStop = tools.find((tool) => tool.name === "job_stop")!;
		const bashBackground = tools.find((tool) => tool.name === "bash_background")!;
		const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "session-a" } };

		// Start a job through the real tool: always a change.
		await bashBackground.execute(undefined, { command: "make ci", label: "CI" }, undefined, undefined, ctx);
		assert.deepEqual(changes.at(-1), { kind: "start", changed: true });

		// Stop it: a real running -> stopped transition.
		await jobStop.execute(undefined, { job_id: "job-1" }, undefined, undefined, ctx);
		assert.deepEqual(changes.at(-1), { kind: "stop", changed: true });

		// Stop it again: already terminal, so no change.
		await jobStop.execute(undefined, { job_id: "job-1" }, undefined, undefined, ctx);
		assert.deepEqual(changes.at(-1), { kind: "stop", changed: false });
	} finally {
		fixture.cleanup();
	}
});

// ---- Transport: capabilities and owner absence ----

function desktopHarness(t: test.TestContext) {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	process.env[INTERACTIVE_HOST_ENV] = "1";
	t.after(() => {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	});
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: any) => void>();
	const pi = {
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(name: string, handler: any) { events.set(name, handler); },
	} as unknown as ExtensionAPI;
	desktopRpc(pi);
	const widgets: Array<{ key: string; lines: string[] }> = [];
	const ctx = { mode: "rpc", ui: { setWidget(key: string, lines: string[]) { widgets.push({ key, lines }); } } };
	events.get("session_start")?.({}, ctx);
	return { commands, events, ctx, widgets };
}

test("the Desktop transport advertises the jobs methods and event", (t) => {
	const app = desktopHarness(t);
	app.commands.get("gentle:desktop")!.handler(
		JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "cap-1", method: "capabilities", params: {} }),
		app.ctx,
	);
	const response = JSON.parse(app.widgets[0]!.lines[0]!);
	assert.deepEqual(response.data.methods, [
		"capabilities",
		"get_snapshot",
		"get_config",
		"set_config",
		"get_permission_mode",
		"set_permission_mode",
		"get_subscription_usage",
		"refresh_subscription_usage",
		"get_design_canvas",
		"list_jobs",
		"cancel_job",
		"get_job_output",
		"apply_profile",
		"list_subagents",
		"cancel_subagent",
		"get_subagent_thread",
		"list_sessions",
		"switch_session",
		"get_changes",
		"get_change_diff",
		"get_review_mode",
		"set_review_mode",
		"get_usage_stats",
		"get_update_status",
		"list_agent_definitions",
		"get_status",
		"get_background_subagents",
		"set_background_subagents",
		"get_profile_binding",
		"clear_profile_binding",
		"get_auth_status",
		"reload_credentials",
	]);
	assert.deepEqual(response.data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "profile_applied", "agents_update", "review_mode_changed", "profile_binding_changed"]);
});

test("list_jobs answers jobs_unavailable through the transport without an owner extension", async (t) => {
	const app = desktopHarness(t);
	await app.commands.get("gentle:desktop")!.handler(
		JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "jobs-1", method: "list_jobs", params: {} }),
		app.ctx,
	);
	const response = JSON.parse(app.widgets[0]!.lines[0]!);
	assert.equal(response.ok, false);
	assert.deepEqual(response.error, JOBS_UNAVAILABLE);
});

// ---- Real owner: the gentle-agents jobs seam drives monitor self-stop ----

interface RealOwnerHarness {
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
	listeners: Map<string, Set<(data: unknown) => void>>;
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	tools: Map<string, any>;
	fake: ReturnType<typeof fakeOperations>;
	scheduled: ReturnType<typeof recordedSchedule>;
	service: DesktopJobsService;
	events: Array<{ event: string; data: Record<string, unknown> }>;
	fireTimeout(ms?: number): void;
	/** The host session id the harness context reports; changeable to model a session switch. */
	session: { id: string };
	/** Advance the owner clock. */
	tick(ms: number): void;
}

function recordedSchedule() {
	const entries: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	return {
		entries,
		schedule: (fn: () => void, ms: number) => {
			const entry = { fn, ms, cancelled: false };
			entries.push(entry);
			return () => { entry.cancelled = true; };
		},
		fire(ms: number) {
			const entry = entries.find((candidate) => candidate.ms === ms && !candidate.cancelled);
			if (!entry) throw new Error(`no pending schedule at ${ms}ms`);
			entry.cancelled = true;
			entry.fn();
		},
	};
}

/**
 * Instantiates the real `gentleAgents` extension (the actual owner seam, real
 * `JobRegistry`, and real `MonitorController`) with a fake host, then discovers
 * the real owner service and subscribes a Desktop bridge. This is the same
 * production wiring the maintainer probe loads, driven in-process.
 */
async function realOwnerHarness(t: test.TestContext, session: { id: string } = { id: "session-a" }): Promise<RealOwnerHarness> {
	const root = mkdtempSync(join(tmpdir(), "desktop-rpc-jobs-real-"));
	t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
	const home = join(root, "home");
	const agentHome = join(root, "agent");
	const cwd = join(root, "workspace");
	const configHome = join(root, "config");
	const jobOutputDir = join(root, "job-output");
	for (const directory of [home, agentHome, cwd, configHome, jobOutputDir]) mkdirSync(directory, { recursive: true });

	const fake = fakeOperations();
	const scheduled = recordedSchedule();
	let clock = 1000;

	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const tools = new Map<string, any>();
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const pi = {
		appendEntry: () => {},
		registerMarkdownTransformer: () => {},
		events: {
			emit: (name: string, data: unknown) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(data); },
			on: (name: string, listener: (data: unknown) => void) => {
				const set = listeners.get(name) ?? new Set();
				listeners.set(name, set);
				set.add(listener);
				return () => { set.delete(listener); };
			},
		},
		sendMessage: () => {},
		sendUserMessage: () => {},
		registerMessageRenderer: () => {},
		registerEntryRenderer: () => {},
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerShortcut: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		sessionManager: {
			getSessionId: () => session.id,
			getCwd: () => cwd,
			getEntries: () => [],
			getBranch: () => [],
			getSessionFile: () => undefined,
			getSessionName: () => "test",
		},
		ui: {
			notify: () => {},
			setStatus: () => {},
			custom: async () => {},
			setWidget: () => {},
			select: async () => undefined,
			confirm: async () => true,
			input: async () => undefined,
			editor: async () => "edited",
		},
		isIdle: () => true,
	} as unknown as ExtensionContext;

	const inertSessionTransport: SessionTransportFactory = {
		createRegistry: async () => ({ list: async () => [], listActivations: async () => [] }),
		createListener: (registry) => ({ registry, start: async () => {}, close: async () => {} }),
		createClient: () => ({ close() {}, sendNotification: async () => { throw new Error("inert transport must not send"); } }),
	};

	gentleAgents(pi, { GENTLE_PI_CONFIG_HOME: configHome, PATH: process.env.PATH ?? "" }, {
		home,
		agentHome,
		env: { GENTLE_PI_CONFIG_HOME: configHome, PATH: process.env.PATH ?? "" },
		schedule: scheduled.schedule,
		now: () => clock,
		jobShell: () => ({ operations: fake.operations }),
		jobOutputDir: () => jobOutputDir,
		sessionTransport: inertSessionTransport,
		resolveWorktree: (path: string, base: string) => ({ root: resolve(base, path), commonDir: "/fixture/common" }),
		spawn: () => { throw new Error("real-owner jobs harness must not spawn children"); },
		pi: { command: "pi", args: [] },
	});

	for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "new" }, ctx);

	const service = await discoverDesktopJobsService(pi, ctx);
	assert.ok(service, "the real owner seam must answer in-process");

	const events: Array<{ event: string; data: Record<string, unknown> }> = [];
	const bridge = new DesktopJobsBridge(pi, { discover: async () => service });
	bridge.attach(ctx);
	bridge.wire((event, data) => events.push({ event, data }));
	await bridge.start();

	return { pi, ctx, tools, fake, scheduled, service, events, fireTimeout: (ms = 1000) => scheduled.fire(ms), handlers, listeners, session, tick: (ms: number) => { clock += ms; } };
}

test("the real owner notifies a monitor self-timeout exactly once and suppresses duplicate lists", async (t) => {
	const harness = await realOwnerHarness(t);
	const monitor = harness.tools.get("monitor");
	assert.ok(monitor, "the real monitor tool is registered");

	await monitor.execute(undefined, { command: "tail -f app.log", timeout_seconds: 1 }, undefined, undefined, harness.ctx);
	assert.equal(harness.events.length, 1, "the monitor start emits one jobs_update");
	assert.deepEqual(harness.events[0]!.data, { jobs: [{ id: "job-1", label: "Background monitor", status: "running", startedAt: 1000 }] });

	// A pending output line means the self-stop flushes events (refresh while
	// still running, byte-identical list) before the stopped notice (refresh
	// after the registry stop). Both refresh through refreshJobStatus; the
	// bridge must emit exactly once for the actual transition.
	harness.fake.runs[0]!.onData(Buffer.from("hello\n"));
	harness.fireTimeout(1000);

	assert.equal(harness.events.length, 2, "the monitor self-stop emits exactly one more jobs_update");
	assert.deepEqual(harness.events[1]!.data, {
		jobs: [{ id: "job-1", label: "Background monitor", status: "stopped", startedAt: 1000, endedAt: 1000 }],
	});
});

test("the real owner notifies a monitor self-timeout once even without pending lines", async (t) => {
	const harness = await realOwnerHarness(t);
	const monitor = harness.tools.get("monitor");
	assert.ok(monitor, "the real monitor tool is registered");

	await monitor.execute(undefined, { command: "tail -f app.log", timeout_seconds: 1 }, undefined, undefined, harness.ctx);
	harness.fireTimeout(1000);

	assert.equal(harness.events.length, 2, "start then stop, exactly once each");
	assert.deepEqual(harness.events[1]!.data, {
		jobs: [{ id: "job-1", label: "Background monitor", status: "stopped", startedAt: 1000, endedAt: 1000 }],
	});
});

test("a shut-down owner leaves the jobs service channel and never answers discovery", async (t) => {
	const harness = await realOwnerHarness(t);
	assert.equal(harness.listeners.get(DESKTOP_JOBS_SERVICE_CHANNEL)?.size, 1, "one owner answers while the session is live");
	for (const handler of harness.handlers.get("session_shutdown") ?? []) await handler({}, harness.ctx);
	assert.equal(harness.listeners.get(DESKTOP_JOBS_SERVICE_CHANNEL)?.size ?? 0, 0, "the owner subscription is removed on shutdown");
	let answered = 0;
	harness.pi.events.emit(DESKTOP_JOBS_SERVICE_CHANNEL, { context: harness.ctx, respond: () => { answered += 1; } });
	assert.equal(answered, 0, "a replaced runtime is never discovered through the old owner");
});

// ---- get_job_output: the bounded, owner-verified tail read ----

function errorOf(outcome: unknown): unknown {
	assert.equal((outcome as { ok: boolean }).ok, false, JSON.stringify(outcome));
	return (outcome as { error: unknown }).error;
}

function outputData(outcome: unknown): { job: DesktopJobEntry; output: string; truncated: boolean } {
	assert.equal((outcome as { ok: boolean }).ok, true, JSON.stringify(outcome));
	return (outcome as { ok: true; data: { job: DesktopJobEntry; output: string; truncated: boolean } }).data;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

test("plainJobOutput strips terminal control sequences and keeps the visible text", () => {
	assert.equal(plainJobOutput(["\u001b[1;32mPASS\u001b[0m tests/a.test.ts"]), "PASS tests/a.test.ts", "CSI colors are stripped");
	assert.equal(plainJobOutput(["\u001b]0;window title\u0007build ok"]), "build ok", "BEL-terminated OSC is stripped");
	assert.equal(plainJobOutput(["\u001b]8;;https://example.test\u001b\\link\u001b]8;;\u001b\\"]), "link", "ST-terminated OSC hyperlinks are stripped");
	assert.equal(plainJobOutput(["\u001b]0;unterminated title"]), "", "an unterminated OSC never leaks its payload");
	assert.equal(plainJobOutput(["\u001b(Bplain\u001b7"]), "plain", "two-character escapes are stripped");
	assert.equal(plainJobOutput(["\u009b31mred"]), "red", "8-bit CSI is stripped");
	assert.equal(plainJobOutput(["10%\r55%\r100%"]), "100%", "a carriage-return progress line shows its final state");
	assert.equal(plainJobOutput(["done\r"]), "done", "a trailing carriage return keeps the last visible text");
	assert.equal(plainJobOutput(["a\u0007b\u0008c\u0000d\u007fe\tf"]), "abcde\tf", "other control characters are removed, tabs kept");
	assert.equal(plainJobOutput(["\udc00tail ✓ \u{1F680}", "end \ud83d"]), "tail ✓ \u{1F680}\nend ", "lone surrogates from a cut line are removed, whole characters kept");
	assert.equal(plainJobOutput(["one", "two"]), "one\ntwo", "lines are joined with newlines");
	assert.equal(plainJobOutput([]), "");
});

test("projectDesktopJobOutput carries only the job projection, the plain tail text, and truncated", () => {
	const job: JobRecord = {
		id: "job-1", kind: "command", label: "CI", command: "make ci SECRET=1", cwd: "/home/devel/secret-repo", ownerSessionId: "session-a",
		outputPath: "/tmp/gentle-jobs/job-1.log", startedAt: 1000, status: "failed", endedAt: 2000, error: "spawn /bin/secret ENOENT",
		tail: ["\u001b[31mFAIL\u001b[0m", "line 2"],
	};
	const view = projectDesktopJobOutput(job);
	assert.deepEqual(view, { job: { id: "job-1", label: "CI", status: "failed", startedAt: 1000, endedAt: 2000 }, output: "FAIL\nline 2", truncated: false });
	const serialized = JSON.stringify(view);
	for (const secret of ["make ci", "secret-repo", "gentle-jobs", "ENOENT", "session-a"]) assert.equal(serialized.includes(secret), false, secret);
	assert.equal(projectDesktopJobOutput({ ...job, tailTruncated: true }).truncated, true);
});

test("parseJobOutputParams accepts exactly { id }", () => {
	assert.deepEqual(parseJobOutputParams({ id: "job-1" }), { id: "job-1" });
	for (const params of [{}, { id: "" }, { id: 1 }, { id: "job-1", extra: true }, { job_id: "job-1" }, { id: "job-1", lines: 5 }]) {
		assert.deepEqual(parseJobOutputParams(params), { error: INVALID_JOBS_PARAMS }, JSON.stringify(params));
	}
});

test("parseDesktopJobOutput re-validates, bounds, and re-normalizes the owner answer", () => {
	const job = { id: "j", label: "l", status: "running", startedAt: 1 };
	assert.deepEqual(parseDesktopJobOutput({ job, output: "\u001b[1mok\u001b[0m", truncated: false, outputPath: "/secret" }), { job, output: "ok", truncated: false });
	for (const bad of [null, { job, output: 1, truncated: false }, { job, output: "x" }, { job: { id: "" }, output: "x", truncated: false }, { output: "x", truncated: false }]) {
		assert.equal(parseDesktopJobOutput(bad), undefined, JSON.stringify(bad));
	}
	// An oversized owner answer is cut to the documented bound and marked truncated.
	const oversized = parseDesktopJobOutput({ job, output: Array.from({ length: TAIL_LINES + 5 }, (_, i) => `line ${i}`).join("\n"), truncated: false })!;
	assert.equal(oversized.truncated, true);
	assert.equal(oversized.output.split("\n").length, TAIL_LINES);
	assert.equal(oversized.output.split("\n").at(-1), `line ${TAIL_LINES + 4}`);
	const huge = parseDesktopJobOutput({ job, output: `\u{1F680}${"x".repeat(DESKTOP_JOB_OUTPUT_MAX_CHARS)}`, truncated: false })!;
	assert.equal(huge.truncated, true);
	assert.ok(huge.output.length <= DESKTOP_JOB_OUTPUT_MAX_CHARS);
	assert.equal(LONE_SURROGATE.test(huge.output), false, "the bound never splits a character");
});

test("get_job_output answers the owned job's plain bounded tail and emits nothing", async () => {
	const fixture = makeRegistry();
	try {
		const { service } = makeOwnerService(fixture);
		const job = fixture.registry.start({ command: "make ci TOKEN=abc", cwd: "/repo/secret", ownerSessionId: "session-a", label: "CI" });
		fixture.fake.runs[0]!.onData(Buffer.from("\u001b[32mstep 1 ok\u001b[0m\r\nprogress 10%\rprogress 100%\n"));
		const { bridge, events } = makeBridge(service);
		const outcome = await bridge.handle("get_job_output", { id: job.id });
		assert.deepEqual(outputData(outcome), {
			job: { id: "job-1", label: "CI", status: "running", startedAt: 1000 },
			output: "step 1 ok\nprogress 100%",
			truncated: false,
		});
		assert.equal("event" in (outcome as object), false, "a read carries no event");
		assert.equal(events.length, 0, "a read emits nothing");
		assert.equal(fixture.registry.get(job.id)!.status, "running", "a read never stops or changes the job");
		const serialized = JSON.stringify(outcome);
		for (const secret of ["make ci", "TOKEN", "/repo/secret", ".log", "session-a"]) assert.equal(serialized.includes(secret), false, secret);
	} finally {
		fixture.cleanup();
	}
});

test("get_job_output keeps the owner bounds and reports truncation", async () => {
	const fixture = makeRegistry();
	try {
		const { service } = makeOwnerService(fixture);
		const job = fixture.registry.start({ command: "noisy", cwd: "/", ownerSessionId: "session-a", label: "noisy" });
		const { bridge } = makeBridge(service);
		fixture.fake.runs[0]!.onData(Buffer.from("short\n"));
		assert.equal(outputData(await bridge.handle("get_job_output", { id: job.id })).truncated, false, "a complete short tail is not truncated");

		const lines = Array.from({ length: TAIL_LINES + 10 }, (_, i) => `line ${i}`);
		fixture.fake.runs[0]!.onData(Buffer.from(`${lines.join("\n")}\n`));
		const many = outputData(await bridge.handle("get_job_output", { id: job.id }));
		assert.equal(many.truncated, true, "dropped earlier lines are reported");
		assert.deepEqual(many.output.split("\n"), lines.slice(-TAIL_LINES), "only the owner's last TAIL_LINES lines cross");

		// A single endless line keeps only its newest characters, whole code points only.
		const job2 = fixture.registry.start({ command: "bar", cwd: "/", ownerSessionId: "session-a", label: "bar" });
		// The odd trailing character makes the owner's fixed-length cut land inside a UTF-16 pair.
		fixture.fake.runs[1]!.onData(Buffer.from(`${"\u{1F680}".repeat(MAX_TAIL_LINE_CHARS)}z\n`));
		assert.equal(LONE_SURROGATE.test(fixture.registry.get(job2.id)!.tail[0]!), true, "the owner tail itself holds a half character");
		const long = outputData(await bridge.handle("get_job_output", { id: job2.id }));
		assert.equal(long.truncated, true, "a shortened line is reported");
		assert.ok(long.output.length <= MAX_TAIL_LINE_CHARS + 1);
		assert.equal(LONE_SURROGATE.test(long.output), false, "no half character crosses the wire");
		assert.ok(long.output.startsWith("…\u{1F680}"));
		assert.ok(long.output.endsWith("\u{1F680}z"));
	} finally {
		fixture.cleanup();
	}
});

test("get_job_output answers not_found for unknown and foreign-session ids", async () => {
	const fixture = makeRegistry();
	try {
		const { service } = makeOwnerService(fixture, "session-a");
		fixture.registry.start({ command: "b", cwd: "/", ownerSessionId: "session-b", label: "theirs" });
		fixture.fake.runs[0]!.onData(Buffer.from("their secret output\n"));
		const { bridge, events } = makeBridge(service, "session-a");
		const foreign = await bridge.handle("get_job_output", { id: "job-1" });
		assert.equal(foreign.ok, false);
		assert.deepEqual(foreign.error, JOB_NOT_FOUND);
		assert.equal(JSON.stringify(foreign).includes("their secret"), false);
		const unknown = await bridge.handle("get_job_output", { id: "job-99" });
		assert.equal(unknown.ok, false);
		assert.deepEqual(unknown.error, JOB_NOT_FOUND);
		assert.equal(events.length, 0);
	} finally {
		fixture.cleanup();
	}
});

test("get_job_output rejects invalid params before any owner discovery", async () => {
	let discoveries = 0;
	const bridge = new DesktopJobsBridge({} as ExtensionAPI, { discover: async () => { discoveries += 1; return undefined; } });
	bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	for (const params of [{}, { id: "" }, { id: 1 }, { id: "job-1", extra: true }, { job_id: "job-1" }]) {
		const bad = await bridge.handle("get_job_output", params);
		assert.equal(bad.ok, false);
		assert.deepEqual(bad.error, INVALID_JOBS_PARAMS);
	}
	assert.equal(discoveries, 0, "invalid params never reach discovery");
});

test("get_job_output answers jobs_unavailable for an absent, outdated, throwing, or malformed owner", async () => {
	const absent = new DesktopJobsBridge({} as ExtensionAPI, { discover: async () => undefined });
	absent.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	assert.deepEqual(errorOf(await absent.handle("get_job_output", { id: "job-1" })), JOBS_UNAVAILABLE);

	const base = { schema: DESKTOP_JOBS_SERVICE_SCHEMA, read: () => ({ sessionId: "session-a", jobs: [] }), cancel: () => ({ kind: "not_found" as const }), observe: () => () => {}, dispose: () => {} };
	// An owner adapter without the output read (an older owner) is still a valid
	// list/cancel owner, but cannot answer this method.
	const outdated = makeBridge(base as DesktopJobsService);
	assert.deepEqual(errorOf(await outdated.bridge.handle("get_job_output", { id: "job-1" })), JOBS_UNAVAILABLE);
	assert.equal((await outdated.bridge.handle("list_jobs", {})).ok, true, "list_jobs still works against that owner");

	const throwing = makeBridge({ ...base, output: () => { throw new Error("secret /tmp/job-1.log make deploy"); } } as DesktopJobsService);
	const thrown = await throwing.bridge.handle("get_job_output", { id: "job-1" });
	assert.deepEqual(errorOf(thrown), JOBS_UNAVAILABLE);
	assert.equal(JSON.stringify(thrown).includes("secret"), false);

	const malformed = makeBridge({ ...base, output: () => ({ kind: "ok", view: { job: { id: "j" }, output: "x", truncated: false } }) } as unknown as DesktopJobsService);
	assert.deepEqual(errorOf(await malformed.bridge.handle("get_job_output", { id: "job-1" })), JOBS_UNAVAILABLE);
});

test("the real owner answers get_job_output for its own job and not_found otherwise", async (t) => {
	const harness = await realOwnerHarness(t);
	const monitor = harness.tools.get("monitor");
	await monitor.execute(undefined, { command: "tail -f app.log", timeout_seconds: 60, label: "app log" }, undefined, undefined, harness.ctx);
	harness.fake.runs[0]!.onData(Buffer.from("\u001b[33mwarn\u001b[0m disk 91%\n"));
	assert.equal(typeof harness.service.output, "function", "the real owner exposes the output read");
	assert.deepEqual(harness.service.output!("job-1"), {
		kind: "ok",
		view: { job: { id: "job-1", label: "app log", status: "running", startedAt: 1000 }, output: "warn disk 91%", truncated: false },
	});
	assert.deepEqual(harness.service.output!("job-99"), { kind: "not_found" });
	const eventsBefore = harness.events.length;
	harness.service.output!("job-1");
	assert.equal(harness.events.length, eventsBefore, "the owner read notifies no observer");
	harness.service.dispose();
	assert.deepEqual(harness.service.output!("job-1"), { kind: "not_found" }, "a disposed adapter answers nothing");
});

test("get_job_output answers jobs_unavailable through the transport without an owner extension", async (t) => {
	const app = desktopHarness(t);
	await app.commands.get("gentle:desktop")!.handler(
		JSON.stringify({ schema: DESKTOP_RPC_SCHEMA, requestId: "out-1", method: "get_job_output", params: { id: "job-1" } }),
		app.ctx,
	);
	const response = JSON.parse(app.widgets[0]!.lines[0]!);
	assert.equal(response.requestId, "out-1");
	assert.equal(response.ok, false);
	assert.deepEqual(response.error, JOBS_UNAVAILABLE);
});

// ---- get_job_output: independent-verifier probes pinned as regressions ----

const HAS_ESC_OR_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

test("the real owner never reads one session's output into another session's adapter", async (t) => {
	const harness = await realOwnerHarness(t);
	await harness.tools.get("monitor").execute(undefined, { command: "tail -f app.log", timeout_seconds: 60, label: "app log" }, undefined, undefined, harness.ctx);
	harness.fake.runs[0]!.onData(Buffer.from("SECRET_TOKEN=abc\n"));
	assert.equal(harness.service.output!("job-1").kind, "ok", "the owning session reads its own job");

	// The host switches to another session; its adapter is discovered fresh.
	harness.session.id = "session-b";
	for (const handler of harness.handlers.get("session_start") ?? []) await handler({ reason: "new" }, harness.ctx);
	const other = await discoverDesktopJobsService(harness.pi, harness.ctx);
	assert.ok(other, "the new session's adapter is discovered");
	assert.deepEqual(other.output!("job-1"), { kind: "not_found" });

	const bridge = new DesktopJobsBridge(harness.pi, { discover: async () => other });
	bridge.attach(harness.ctx);
	const outcome = await bridge.handle("get_job_output", { id: "job-1" });
	assert.deepEqual(errorOf(outcome), JOB_NOT_FOUND);
	assert.equal(JSON.stringify(outcome).includes("SECRET"), false, "no byte of the other session's output crosses");
});

test("a reset during discovery answers get_job_output with jobs_unavailable and never reads output", async () => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let outputCalls = 0;
	const service: DesktopJobsService = {
		schema: DESKTOP_JOBS_SERVICE_SCHEMA,
		read: () => ({ sessionId: "session-a", jobs: [] }),
		cancel: () => ({ kind: "not_found" }),
		output: () => {
			outputCalls += 1;
			return { kind: "ok", view: { job: { id: "j", label: "l", status: "running", startedAt: 1 }, output: "old secret", truncated: false } };
		},
		observe: () => () => {},
		dispose: () => {},
	};
	const bridge = new DesktopJobsBridge({} as ExtensionAPI, { discover: async () => { await gate; return service; } });
	bridge.attach({ sessionManager: { getSessionId: () => "session-a" } } as unknown as ExtensionContext);
	const pending = bridge.handle("get_job_output", { id: "j" });
	bridge.reset();
	release();
	const outcome = await pending;
	assert.deepEqual(errorOf(outcome), JOBS_UNAVAILABLE);
	assert.equal(outputCalls, 0, "a superseded session's owner is never read");
	assert.equal(JSON.stringify(outcome).includes("old secret"), false);
});

test("get_job_output keeps answering a finished owned job after it leaves list_jobs", async (t) => {
	const harness = await realOwnerHarness(t);
	await harness.tools.get("monitor").execute(undefined, { command: "tail -f app.log", timeout_seconds: 60, label: "app log" }, undefined, undefined, harness.ctx);
	harness.fake.runs[0]!.onData(Buffer.from("done line\n"));
	harness.fake.runs[0]!.resolve(0);
	await settle();
	assert.equal(harness.service.output!("job-1").kind, "ok", "readable within the list linger");

	harness.tick(JOBS_FINISHED_TTL_MS + 1);
	assert.deepEqual(harness.service.read().jobs, [], "the finished job has left list_jobs");
	const past = harness.service.output!("job-1");
	assert.equal(past.kind, "ok", "the owner registry still holds it, so its output stays readable");
	assert.equal((past as { kind: "ok"; view: { output: string } }).view.output, "done line");
});

test("plainJobOutput strips string, 8-bit, lone, and redraw sequences idempotently", () => {
	const cases: Array<[string, string]> = [
		["\u001bP1$r0m\u001b\\after", "after"],
		["\u001b_apc payload\u001b\\x", "x"],
		["trailing lone esc\u001b", "trailing lone esc"],
		["a\u0085b\u009cc", "abc"],
		["\u001b[2K\u001b[1Gprogress 40%", "progress 40%"],
		["col1\tcol2", "col1\tcol2"],
		["50%\r\r", "50%"],
		["\u001b]0;t\u0007\u001b[31m10%\u001b[0m\r\u001b[31m20%\u001b[0m", "20%"],
		["abc\r\u001b[K", "abc"],
		["\u001b[?25l\u001b[?25hhidden cursor", "hidden cursor"],
	];
	for (const [input, expected] of cases) {
		const once = plainJobOutput([input]);
		assert.equal(once, expected, JSON.stringify(input));
		assert.equal(plainJobOutput([once]), once, `idempotent: ${JSON.stringify(input)}`);
	}
});

test("an owner line cut inside an escape sequence leaves no ESC byte or control character", () => {
	// Known cosmetic limit: the owner's fixed-length cut can land inside an
	// escape sequence, so a fragment of its parameters can remain visible text.
	// What must never remain is the ESC byte or any control character but tab.
	const tail = createOutputTail();
	tail.push(`\u001b[38;5;196m${"x".repeat(MAX_TAIL_LINE_CHARS - 5)}\n`);
	assert.equal(tail.truncated(), true);
	const plain = plainJobOutput(tail.lines());
	assert.equal(plain.includes("\u001b"), false);
	assert.equal(HAS_ESC_OR_CONTROL.test(plain), false);
	assert.ok(plain.endsWith("x".repeat(MAX_TAIL_LINE_CHARS - 5)));
});

test("the owner tail truncation flag holds at its exact boundaries", () => {
	const lines = (count: number) => Array.from({ length: count }, (_, i) => `l${i}`).join("\n");

	const exact = createOutputTail();
	exact.push(`${lines(TAIL_LINES)}\n`);
	assert.equal(exact.lines().length, TAIL_LINES);
	assert.equal(exact.truncated(), false, "exactly TAIL_LINES complete lines is complete");

	const plus = createOutputTail();
	plus.push(`${lines(TAIL_LINES)}\npartial`);
	assert.equal(plus.lines().length, TAIL_LINES);
	assert.equal(plus.lines().at(-1), "partial");
	assert.equal(plus.truncated(), true, "TAIL_LINES complete lines plus a partial drops the oldest");

	const atLimit = createOutputTail();
	atLimit.push(`${"y".repeat(MAX_TAIL_LINE_CHARS)}\n`);
	assert.equal(atLimit.truncated(), false, "a line of exactly MAX_TAIL_LINE_CHARS is not cut");

	const overLimit = createOutputTail();
	overLimit.push(`${"y".repeat(MAX_TAIL_LINE_CHARS + 1)}\n`);
	assert.equal(overLimit.truncated(), true, "one character more is cut");

	const crlf = createOutputTail();
	crlf.push("a\r\nb\r\n");
	assert.deepEqual(crlf.lines(), ["a", "b"]);
	assert.equal(crlf.truncated(), false, "CRLF line endings lose nothing");
});

test("an owner without a callable output read keeps list and cancel working", async () => {
	const base = {
		schema: DESKTOP_JOBS_SERVICE_SCHEMA,
		read: () => ({ sessionId: "session-a", jobs: [{ id: "j", label: "l", status: "running" as const, startedAt: 1 }] }),
		cancel: () => ({ kind: "ok" as const, job: { id: "j", label: "l", status: "stopped" as const, startedAt: 1, endedAt: 2 }, changed: true }),
		observe: () => () => {},
		dispose: () => {},
	};
	const { bridge } = makeBridge(base as DesktopJobsService);
	assert.equal((await bridge.handle("list_jobs", {})).ok, true);
	const cancelled = await bridge.handle("cancel_job", { id: "j" });
	assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
	assert.deepEqual(errorOf(await bridge.handle("get_job_output", { id: "j" })), JOBS_UNAVAILABLE);

	const notCallable = makeBridge({ ...base, output: 5 } as unknown as DesktopJobsService);
	assert.deepEqual(errorOf(await notCallable.bridge.handle("get_job_output", { id: "j" })), JOBS_UNAVAILABLE);
});

test("get_job_output drops every extra owner key and rejects non-string ids", async () => {
	const service = {
		schema: DESKTOP_JOBS_SERVICE_SCHEMA,
		read: () => ({ sessionId: "session-a", jobs: [] }),
		cancel: () => ({ kind: "not_found" }),
		output: () => ({
			kind: "ok",
			view: {
				job: { id: "j", label: "l", status: "exited", startedAt: 1, endedAt: 2, exitCode: 3, command: "rm -rf", cwd: "/x", ownerSessionId: "session-a" },
				output: "o", truncated: false, outputPath: "/p", env: { A: 1 }, error: "boom",
			},
		}),
		observe: () => () => {},
		dispose: () => {},
	} as unknown as DesktopJobsService;
	const { bridge } = makeBridge(service);
	assert.deepEqual(await bridge.handle("get_job_output", { id: "j" }), {
		ok: true,
		data: { job: { id: "j", label: "l", status: "exited", startedAt: 1, endedAt: 2, exitCode: 3 }, output: "o", truncated: false },
	});
	for (const params of [{ id: null }, { id: ["j"] }, { id: { toString: () => "j" } }, { id: "j", id2: "k" }]) {
		assert.deepEqual(errorOf(await bridge.handle("get_job_output", params as Record<string, unknown>)), INVALID_JOBS_PARAMS);
	}
});
