import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import desktopRpc from "../extensions/gentle-desktop-rpc.ts";
import gentleAgents, { type SessionTransportFactory } from "../extensions/gentle-agents.ts";
import { createJobRegistry, type JobExecOperations, type JobRecord } from "../lib/background-jobs.ts";
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
	parseCancelJobParams,
	parseDesktopJobEntry,
	parseListJobsParams,
	projectDesktopJob,
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
		"list_subagents",
		"cancel_subagent",
	]);
	assert.deepEqual(response.data.events, ["config_changed", "permission_mode_changed", "rate_limit", "design_canvas", "jobs_update", "agents_update"]);
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
async function realOwnerHarness(t: test.TestContext): Promise<RealOwnerHarness> {
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
			getSessionId: () => "session-a",
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

	return { pi, ctx, tools, fake, scheduled, service, events, fireTimeout: (ms = 1000) => scheduled.fire(ms), handlers, listeners };
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
