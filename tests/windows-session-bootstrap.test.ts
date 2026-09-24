import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FIXED_WINDOWS_POWERSHELL, WindowsActiveSessionClient, WindowsActiveSessionListener, WindowsSessionPresenceRegistry, WindowsSessionRegistryPhaseSequence, type WindowsSessionRegistryPhaseEvent, parseWindowsHostFrame } from "../lib/windows-session-transport.ts";
import { createDefaultSessionTransport } from "../extensions/gentle-agents.ts";
import { ActiveSessionClientError, FrameDecoder, encodeNotificationFrame, type AckFrame } from "../lib/agents-session-transport.ts";
import { decidePackedRunnerEntrypoint, deriveWindowsStartupTimingPathDelta, validateWindowsStartupTimingMachinePaths, WINDOWS_STARTUP_TIMING_WINDOWS_PATH_KEYS } from "../scripts/test-packed-runner.mjs";

const runtime = fileURLToPath(new URL("../runtime/windows-session-transport.ps1", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/windows-session-bootstrap.ps1", import.meta.url));
const packedRunner = fileURLToPath(new URL("../scripts/test-packed-runner.mjs", import.meta.url));

type CleanupChild = EventEmitter & { pid?: number; stdin: EventEmitter & { write(input: string): boolean; end(input?: string): void }; stdout: EventEmitter & { destroy?(): void }; stderr: EventEmitter & { resume?(): void; destroy?(): void }; kill(): boolean };
type ChildLifecycle = Readonly<{ child: CleanupChild; changed: EventEmitter; closeObserved: boolean; exitObserved: boolean; processError?: Error; stdinError?: Error; stdoutError?: Error; stderrError?: Error; stdinClosed: boolean; stdoutClosed: boolean; stderrClosed: boolean; exitCode: number }>;

function observeChildLifecycle(child: CleanupChild): ChildLifecycle {
	const lifecycle = { child, changed: new EventEmitter(), closeObserved: false, exitObserved: false, processError: undefined as Error | undefined, stdinError: undefined as Error | undefined, stdoutError: undefined as Error | undefined, stderrError: undefined as Error | undefined, stdinClosed: false, stdoutClosed: false, stderrClosed: false, exitCode: -1 };
	const changed = () => lifecycle.changed.emit("changed");
	child.once("close", (code: number | null) => { lifecycle.closeObserved = true; lifecycle.exitCode = code ?? -1; changed(); });
	child.once("exit", () => { lifecycle.exitObserved = true; changed(); });
	child.on("error", (error: Error) => { lifecycle.processError = error; changed(); });
	child.stdin.on("error", (error: Error) => { lifecycle.stdinError = error; changed(); });
	child.stdout.on("error", (error: Error) => { lifecycle.stdoutError = error; changed(); });
	child.stderr.on("error", (error: Error) => { lifecycle.stderrError = error; changed(); });
	child.stdin.once("close", () => { lifecycle.stdinClosed = true; changed(); });
	child.stdout.once("close", () => { lifecycle.stdoutClosed = true; changed(); });
	child.stderr.once("close", () => { lifecycle.stderrClosed = true; changed(); });
	return lifecycle;
}

function hasLifecycleError(lifecycle: ChildLifecycle): boolean {
	return lifecycle.processError !== undefined || lifecycle.stdinError !== undefined || lifecycle.stdoutError !== undefined || lifecycle.stderrError !== undefined;
}

function noProcessStreamsClosed(lifecycle: ChildLifecycle): boolean {
	return lifecycle.processError !== undefined && lifecycle.child.pid === undefined && lifecycle.stdinClosed && lifecycle.stdoutClosed && lifecycle.stderrClosed;
}

function waitForChildClose(lifecycle: ChildLifecycle, deadlineMs: number): Promise<boolean> {
	if (lifecycle.closeObserved || noProcessStreamsClosed(lifecycle)) return Promise.resolve(true);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (closed: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			lifecycle.changed.removeListener("changed", onChanged);
			resolve(closed);
		};
		const onChanged = () => { if (lifecycle.closeObserved || noProcessStreamsClosed(lifecycle)) finish(true); };
		const timer = setTimeout(() => finish(false), deadlineMs);
		lifecycle.changed.on("changed", onChanged);
		onChanged();
	});
}

function waitForStartupControlClose(lifecycle: ChildLifecycle, deadlineMs: number): Promise<boolean> {
	if (lifecycle.closeObserved) return Promise.resolve(true);
	if (hasLifecycleError(lifecycle)) return Promise.resolve(false);
	return new Promise((resolve) => {
		let settled = false;
		const finish = (closed: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			lifecycle.changed.removeListener("changed", onChanged);
			resolve(closed);
		};
		const onChanged = () => { if (lifecycle.closeObserved) finish(true); else if (hasLifecycleError(lifecycle)) finish(false); };
		const timer = setTimeout(() => finish(false), deadlineMs);
		lifecycle.changed.on("changed", onChanged);
		onChanged();
	});
}

async function settleOwnedChild(child: CleanupChild, lifecycle: ChildLifecycle, deadlines: Readonly<{ terminateMs: number; killMs: number }>): Promise<void> {
	if (lifecycle.closeObserved || noProcessStreamsClosed(lifecycle)) return;
	try { child.stdin.end(); } catch { /* cleanup continues through bounded settlement */ }
	if (await waitForChildClose(lifecycle, deadlines.terminateMs)) return;
	if (child.pid === undefined && lifecycle.processError !== undefined) {
		child.stdout.destroy?.();
		child.stderr.destroy?.();
		if (await waitForChildClose(lifecycle, deadlines.killMs)) return;
		throw new Error("owned Windows helper did not settle after spawn failure");
	}
	try { child.kill(); } catch { /* the second bounded wait determines settlement */ }
	if (await waitForChildClose(lifecycle, deadlines.killMs)) return;
	child.stdout.destroy?.();
	child.stderr.destroy?.();
	throw new Error("owned Windows helper did not settle after termination");
}

const maxBootstrapDiagnosticBytes = 512;
const bootstrapDiagnosticCategories = new Set(["compiler", "argument", "invalid-operation", "not-supported", "security", "assembly-load", "type-load", "other"]);
const bootstrapDiagnosticReasons = new Set(["compiler-errors", "source-code-error", "type-already-exists", "reference-load", "unsupported", "unknown"]);
const bootstrapLanguageModes = new Set(["full", "constrained", "restricted", "no-language", "unknown"]);
type BootstrapDiagnostic = Readonly<{ kind: "windows-session-bootstrap-diagnostic"; category: "compiler" | "argument" | "invalid-operation" | "not-supported" | "security" | "assembly-load" | "type-load" | "other"; compilerCodes: readonly string[]; reason: "compiler-errors" | "source-code-error" | "type-already-exists" | "reference-load" | "unsupported" | "unknown"; languageMode: "full" | "constrained" | "restricted" | "no-language" | "unknown" }>;

function parseBootstrapDiagnostic(stderr: string): BootstrapDiagnostic | undefined {
	if (Buffer.byteLength(stderr, "utf8") > maxBootstrapDiagnosticBytes || !stderr.endsWith("\n")) return undefined;
	const lines = stderr.slice(0, -1).split("\n");
	if (lines.length !== 1 || lines[0].length === 0) return undefined;
	let value: unknown;
	try { value = JSON.parse(lines[0]); } catch { return undefined; }
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== 5 || keys.join(",") !== "category,compilerCodes,kind,languageMode,reason" || record.kind !== "windows-session-bootstrap-diagnostic" || typeof record.category !== "string" || !bootstrapDiagnosticCategories.has(record.category) || typeof record.reason !== "string" || !bootstrapDiagnosticReasons.has(record.reason) || typeof record.languageMode !== "string" || !bootstrapLanguageModes.has(record.languageMode) || !Array.isArray(record.compilerCodes) || record.compilerCodes.length > 8 || record.compilerCodes.some((code) => typeof code !== "string")) return undefined;
	const compilerCodes = record.compilerCodes as string[];
	if (new Set(compilerCodes).size !== compilerCodes.length || compilerCodes.some((code) => !/^CS[0-9]{4}$/.test(code)) || (record.category !== "compiler" && compilerCodes.length !== 0)) return undefined;
	return Object.freeze({ kind: "windows-session-bootstrap-diagnostic", category: record.category as BootstrapDiagnostic["category"], compilerCodes: Object.freeze([...compilerCodes]), reason: record.reason as BootstrapDiagnostic["reason"], languageMode: record.languageMode as BootstrapDiagnostic["languageMode"] });
}

function appendBoundedOutput(output: string, chunk: Buffer, limit: number): Readonly<{ output: string; overflow: boolean }> {
	const remaining = limit - Buffer.byteLength(output, "utf8");
	if (remaining <= 0) return { output, overflow: true };
	if (chunk.length <= remaining) return { output: output + chunk.toString("utf8"), overflow: false };
	let end = remaining;
	while (end > 0 && (chunk[end] & 0xc0) === 0x80) end--;
	return { output: output + chunk.subarray(0, end).toString("utf8"), overflow: true };
}

const bootstrapRejectionStages = new Set(["volume-open", "ancestor-open", "routing-open", "transport-create-or-open", "transport-assert-owned", "presence-create-or-open", "presence-assert-owned", "unknown"]);
type BootstrapRejectionDiagnostic = Readonly<{ kind: "windows-session-bootstrap-rejection"; stage: "volume-open" | "ancestor-open" | "routing-open" | "transport-create-or-open" | "transport-assert-owned" | "presence-create-or-open" | "presence-assert-owned" | "unknown"; ntstatus: number | null }>;
type BootstrapDiagnosticContext = Readonly<{ diagnostic(message: string): void }>;

function emitBootstrapRejection(context: BootstrapDiagnosticContext, diagnostic: BootstrapRejectionDiagnostic): void {
	context.diagnostic(JSON.stringify(diagnostic));
}

function parseBootstrapRejectionDiagnostic(stderr: string): BootstrapRejectionDiagnostic | undefined {
	if (Buffer.byteLength(stderr, "utf8") > maxBootstrapDiagnosticBytes || !stderr.endsWith("\n")) return undefined;
	const lines = stderr.slice(0, -1).split("\n");
	if (lines.length !== 1 || lines[0].length === 0) return undefined;
	let value: unknown;
	try { value = JSON.parse(lines[0]); } catch { return undefined; }
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== 3 || keys.join(",") !== "kind,ntstatus,stage" || record.kind !== "windows-session-bootstrap-rejection" || typeof record.stage !== "string" || !bootstrapRejectionStages.has(record.stage) || (record.ntstatus !== null && (!Number.isInteger(record.ntstatus) || typeof record.ntstatus !== "number" || record.ntstatus < 0 || record.ntstatus > 0xffffffff))) return undefined;
	return Object.freeze({ kind: "windows-session-bootstrap-rejection", stage: record.stage as BootstrapRejectionDiagnostic["stage"], ntstatus: record.ntstatus as number | null });
}

const maxFixtureFailureDiagnosticBytes = 256;
const fixtureFailureStages = new Set(["replacement-copy", "replacement-acl", "replacement-rename"]);
const fixtureFailureCodeKinds = new Set(["hresult", "win32", "unknown"]);
type FixtureFailureDiagnostic = Readonly<{ kind: "windows-session-bootstrap-fixture-failure"; stage: "replacement-copy" | "replacement-acl" | "replacement-rename"; codeKind: "hresult" | "win32" | "unknown"; code: number | null }>;

function parseFixtureFailureDiagnostic(stdout: string): FixtureFailureDiagnostic | undefined {
	if (Buffer.byteLength(stdout, "utf8") > maxFixtureFailureDiagnosticBytes || !stdout.endsWith("\n")) return undefined;
	const lines = stdout.slice(0, -1).split("\n");
	if (lines.length !== 1 || lines[0].length === 0) return undefined;
	let value: unknown;
	try { value = JSON.parse(lines[0]); } catch { return undefined; }
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.length !== 5 || keys.join(",") !== "code,codeKind,kind,ok,stage" || record.ok !== false || record.kind !== "windows-session-bootstrap-fixture-failure" || typeof record.stage !== "string" || !fixtureFailureStages.has(record.stage) || typeof record.codeKind !== "string" || !fixtureFailureCodeKinds.has(record.codeKind)) return undefined;
	const diagnosticCode = record.code;
	if (diagnosticCode !== null && (typeof diagnosticCode !== "number" || !Number.isSafeInteger(diagnosticCode) || diagnosticCode < -0x80000000 || diagnosticCode > 0x7fffffff || (record.codeKind === "win32" && diagnosticCode <= 0) || (record.codeKind === "hresult" && diagnosticCode === 0) || record.codeKind === "unknown")) return undefined;
	if (diagnosticCode === null && record.codeKind !== "unknown") return undefined;
	return Object.freeze({ kind: "windows-session-bootstrap-fixture-failure", stage: record.stage as FixtureFailureDiagnostic["stage"], codeKind: record.codeKind as FixtureFailureDiagnostic["codeKind"], code: diagnosticCode as number | null });
}

function fixtureFailureMessage(code: number, stdout: string): string {
	if (code === 0) return "Windows fixture failed";
	const diagnostic = parseFixtureFailureDiagnostic(stdout);
	return diagnostic ? `Windows replacement fixture failed: ${diagnostic.stage}:${diagnostic.codeKind}:${diagnostic.code ?? "unknown"}` : "Windows fixture failed";
}

async function runBootstrapStartupControl(options: Readonly<{ spawnProcess?: (...args: any[]) => CleanupChild; startupDeadlineMs?: number; terminateMs?: number; killMs?: number }> = {}): Promise<Readonly<{ code: number; stdout: string; stderr: string; outputOverflow: boolean }>> {
	const child = (options.spawnProcess ?? spawn)(FIXED_WINDOWS_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", runtime], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }) as CleanupChild;
	const lifecycle = observeChildLifecycle(child);
	const deadlines = { startupDeadlineMs: options.startupDeadlineMs ?? 30_000, terminateMs: options.terminateMs ?? 2_500, killMs: options.killMs ?? 2_500 };
	let stdout = "";
	let stderr = "";
	let outputOverflow = false;
	child.stdout.on("data", (chunk: Buffer) => { const captured = appendBoundedOutput(stdout, chunk, maxBootstrapDiagnosticBytes); stdout = captured.output; outputOverflow ||= captured.overflow; });
	child.stderr.on("data", (chunk: Buffer) => { const captured = appendBoundedOutput(stderr, chunk, maxBootstrapDiagnosticBytes); stderr = captured.output; outputOverflow ||= captured.overflow; });
	let inputWriteFailed = false;
	try { child.stdin.end('{"requestId":"start-1","operation":"start"}\n{"requestId":"shutdown-2","operation":"shutdown"}\n'); } catch { inputWriteFailed = true; }
	const closed = inputWriteFailed ? false : await waitForStartupControlClose(lifecycle, deadlines.startupDeadlineMs);
	if (!closed || hasLifecycleError(lifecycle)) {
		let cleanupFailed = false;
		try { await settleOwnedChild(child, lifecycle, deadlines); } catch { cleanupFailed = true; }
		throw new Error(cleanupFailed ? "Windows bootstrap startup control did not settle" : "Windows bootstrap startup control did not complete");
	}
	if (outputOverflow) throw new Error("Windows bootstrap startup control exceeded bounded output");
	return { code: lifecycle.exitCode, stdout, stderr, outputOverflow };
}

type StartupMarker = "script-entered" | "native-ready";
const maxHelperControlBytes = 16_384;

class HelperControlStream {
	private markerOrdinal = 0;
	private startReplySeen = false;
	private readonly requireStartupMarkers: boolean;
	private readonly errorMessage: string;
	constructor(requireStartupMarkers: boolean, errorMessage: string) {
		this.requireStartupMarkers = requireStartupMarkers;
		this.errorMessage = errorMessage;
	}
	push(rawLine: string): ReturnType<typeof parseWindowsHostFrame> | undefined {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (Buffer.byteLength(line, "utf8") > maxHelperControlBytes) throw new Error(this.errorMessage);
		const marker = this.startupMarker(line);
		if (marker !== undefined) {
			const expected = this.markerOrdinal === 0 ? "script-entered" : this.markerOrdinal === 1 ? "native-ready" : undefined;
			if (this.startReplySeen || marker !== expected) throw new Error(this.errorMessage);
			this.markerOrdinal++;
			return undefined;
		}
		let reply: ReturnType<typeof parseWindowsHostFrame>;
		try { reply = parseWindowsHostFrame(line); } catch { throw new Error(this.errorMessage); }
		if (!this.startReplySeen) {
			if (reply.requestId !== "start-1" || (this.requireStartupMarkers && this.markerOrdinal !== 2) || (!this.requireStartupMarkers && this.markerOrdinal === 1)) throw new Error(this.errorMessage);
			this.startReplySeen = true;
		}
		return reply;
	}
	assertStartupComplete() {
		if (!this.startReplySeen || (this.requireStartupMarkers && this.markerOrdinal !== 2)) throw new Error(this.errorMessage);
	}
	private startupMarker(line: string): StartupMarker | undefined {
		let value: unknown;
		try { value = JSON.parse(line); } catch { return undefined; }
		if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || (value as Record<string, unknown>).event !== "startup-marker") return undefined;
		const marker = value as Record<string, unknown>;
		if (Object.keys(marker).length === 2 && marker.marker === "script-entered" && line === '{"event":"startup-marker","marker":"script-entered"}') return "script-entered";
		if (Object.keys(marker).length === 2 && marker.marker === "native-ready" && line === '{"event":"startup-marker","marker":"native-ready"}') return "native-ready";
		throw new Error(this.errorMessage);
	}
}

function parseHelperControlOutput(stdout: string, requireStartupMarkers: boolean, errorMessage: string): readonly ReturnType<typeof parseWindowsHostFrame>[] {
	if (!stdout.endsWith("\n")) throw new Error(errorMessage);
	const stream = new HelperControlStream(requireStartupMarkers, errorMessage);
	const frames: ReturnType<typeof parseWindowsHostFrame>[] = [];
	for (const line of stdout.slice(0, -1).split("\n")) {
		if (line.length === 0) throw new Error(errorMessage);
		const frame = stream.push(line);
		if (frame !== undefined) frames.push(frame);
	}
	stream.assertStartupComplete();
	return frames;
}

function parseStartupControlFrames(stdout: string): readonly ReturnType<typeof parseWindowsHostFrame>[] {
	return parseHelperControlOutput(stdout, true, "Windows bootstrap startup control returned malformed protocol output");
}

test("Windows helper control stream enforces fixed marker framing and order", () => {
	const start = '{"requestId":"start-1","ok":true,"result":{"state":"partial"}}';
	const shutdown = '{"requestId":"shutdown-2","ok":true,"result":{"state":"partial"}}';
	const entered = '{"event":"startup-marker","marker":"script-entered"}';
	const ready = '{"event":"startup-marker","marker":"native-ready"}';
	assert.deepEqual(parseHelperControlOutput(`${entered}\r\n${ready}\n${start}\r\n${shutdown}\n`, true, "invalid helper control stream").map((frame) => frame.requestId), ["start-1", "shutdown-2"]);
	assert.deepEqual(parseHelperControlOutput(`${start}\n${shutdown}\n`, false, "invalid helper control stream").map((frame) => frame.requestId), ["start-1", "shutdown-2"], "explicit fixture compatibility permits an uninstrumented helper");
	for (const stream of [
		`${ready}\n${start}\n`,
		`${entered}\n${entered}\n${start}\n`,
		`${entered}\n${start}\n`,
		`${entered} \n${ready}\n${start}\n`,
		`${entered}\n{"event":"startup-marker","marker":"unknown"}\n${start}\n`,
	]) assert.throws(() => parseHelperControlOutput(stream, true, "invalid helper control stream"), /invalid helper control stream/);
});

async function runPowerShell(script: string, args: string[], input = "", options: Readonly<{ spawnProcess?: (...args: any[]) => CleanupChild }> = {}): Promise<{ code: number; stdout: string; stderr: string; stderrOverflow: boolean }> {
	const child = (options.spawnProcess ?? spawn)(FIXED_WINDOWS_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, ...args], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }) as CleanupChild;
	const lifecycle = observeChildLifecycle(child);
	let stdout = "";
	let stderr = "";
	let stderrOverflow = false;
	child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
	child.stderr.on("data", (chunk: Buffer) => { const captured = appendBoundedOutput(stderr, chunk, maxBootstrapDiagnosticBytes); stderr = captured.output; stderrOverflow ||= captured.overflow; });
	try { child.stdin.end(input); } catch { await settleOwnedChild(child, lifecycle, { terminateMs: 2_500, killMs: 2_500 }); throw new Error("Windows helper input could not close"); }
	if (!await waitForChildClose(lifecycle, 30_000) || hasLifecycleError(lifecycle)) {
		try { await settleOwnedChild(child, lifecycle, { terminateMs: 2_500, killMs: 2_500 }); } catch { throw new Error("Windows helper did not settle"); }
		throw new Error("Windows helper did not complete");
	}
	return { code: lifecycle.exitCode, stdout, stderr, stderrOverflow };
}

async function openInitializedHelper(agentHome: string, options: Readonly<{ diagnostics: BootstrapDiagnosticContext; spawnProcess?: (...args: any[]) => CleanupChild; initialDeadlineMs?: number; responseDeadlineMs?: number; terminateMs?: number; killMs?: number }>) {
	const child = (options.spawnProcess ?? spawn)(FIXED_WINDOWS_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", runtime], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }) as CleanupChild;
	const lifecycle = observeChildLifecycle(child);
	const deadlines = { initialDeadlineMs: options.initialDeadlineMs ?? 25_000, responseDeadlineMs: options.responseDeadlineMs ?? 3_000, terminateMs: options.terminateMs ?? 3_000, killMs: options.killMs ?? 3_000 };
	const frames: ReturnType<typeof parseWindowsHostFrame>[] = [];
	// Fake spawned children predate startup markers; real helper launches require them.
	const controlStream = new HelperControlStream(options.spawnProcess === undefined, "Windows helper returned malformed protocol output");
	let buffered = Buffer.alloc(0);
	let protocolError: Error | undefined;
	let outputFinalized = false;
	const recordProtocolError = () => {
		if (protocolError !== undefined) return;
		protocolError = new Error("Windows helper returned malformed protocol output");
		buffered = Buffer.alloc(0);
		lifecycle.changed.emit("changed");
	};
	const finishOutput = () => {
		if (outputFinalized) return;
		outputFinalized = true;
		if (buffered.length !== 0) recordProtocolError();
	};
	let stderr = "";
	let stderrOverflow = false;
	const rejectionChanged = new EventEmitter();
	child.stderr.resume();
	child.stderr.on("data", (chunk: Buffer) => { const captured = appendBoundedOutput(stderr, chunk, maxBootstrapDiagnosticBytes); stderr = captured.output; stderrOverflow ||= captured.overflow; rejectionChanged.emit("changed"); });
	const waitFor = (count: number, deadlineMs: number) => new Promise<void>((resolve, reject) => {
		let settled = false;
		let pollTimer: ReturnType<typeof setTimeout> | undefined;
		const onChanged = () => poll();
		const settle = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadlineTimer);
			if (pollTimer) clearTimeout(pollTimer);
			lifecycle.changed.removeListener("changed", onChanged);
			if (error) reject(error); else resolve();
		};
		const deadlineTimer = setTimeout(() => settle(new Error("Windows helper did not reply")), deadlineMs);
		const poll = () => {
			if (pollTimer) { clearTimeout(pollTimer); pollTimer = undefined; }
			if (protocolError !== undefined) return settle(protocolError);
			if (lifecycle.closeObserved) {
				finishOutput();
				return settle(protocolError ?? new Error("Windows helper exited before its reply"));
			}
			if (lifecycle.processError) return settle(lifecycle.processError);
			if (lifecycle.exitObserved) return settle(new Error("Windows helper exited before its reply"));
			if (frames.length >= count) return settle();
			pollTimer = setTimeout(poll, 25);
		};
		lifecycle.changed.on("changed", onChanged);
		poll();
	});
	const waitForUnsafeRejection = () => new Promise<BootstrapRejectionDiagnostic>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error, diagnostic?: BootstrapRejectionDiagnostic) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			rejectionChanged.removeListener("changed", check);
			lifecycle.changed.removeListener("changed", check);
			if (error) reject(error); else resolve(diagnostic!);
		};
		const check = () => {
			if (protocolError !== undefined) return finish(protocolError);
			if (stderrOverflow) return finish(new Error("Windows helper unsafe rejection diagnostic exceeded bounded output"));
			const diagnostic = parseBootstrapRejectionDiagnostic(stderr);
			if (diagnostic) return finish(undefined, diagnostic);
			if (lifecycle.closeObserved || lifecycle.processError) return finish(new Error("Windows helper unsafe rejection diagnostic was missing"));
		};
		const timer = setTimeout(() => finish(new Error("Windows helper unsafe rejection diagnostic was missing")), deadlines.responseDeadlineMs);
		rejectionChanged.on("changed", check);
		lifecycle.changed.on("changed", check);
		check();
	});
	const exitWithin = async () => {
		if (await waitForChildClose(lifecycle, deadlines.responseDeadlineMs)) return;
		try { await closeOwnedChild(); } catch { throw new Error("Windows helper did not exit after a fatal schema error"); }
		throw new Error("Windows helper did not exit after a fatal schema error");
	};	const closeOwnedChild = () => settleOwnedChild(child, lifecycle, { terminateMs: deadlines.terminateMs, killMs: deadlines.killMs });
	const closeWithStreamCheck = async () => {
		let cleanupError: unknown;
		try { await closeOwnedChild(); } catch (error) { cleanupError = error; }
		finally { finishOutput(); }
		if (protocolError !== undefined) throw protocolError;
		if (cleanupError !== undefined) throw cleanupError;
	};
	child.stdout.on("data", (chunk: Buffer) => {
		if (protocolError !== undefined) return;
		if (!Buffer.isBuffer(chunk)) { recordProtocolError(); return; }
		const output = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
		let offset = 0;
		for (;;) {
			const newline = output.indexOf(10, offset);
			if (newline < 0) {
				const suffix = output.subarray(offset);
				if (suffix.length > maxHelperControlBytes + 1) recordProtocolError();
				else buffered = Buffer.from(suffix);
				return;
			}
			const bytes = output.subarray(offset, newline);
			offset = newline + 1;
			if (bytes.length > maxHelperControlBytes + 1) { recordProtocolError(); return; }
			try {
				const line = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				const frame = controlStream.push(line);
				if (frame !== undefined) frames.push(frame);
			} catch { recordProtocolError(); return; }
		}
	});
	child.stdout.once("end", finishOutput);
	child.stdout.once("close", finishOutput);
	child.once("close", finishOutput);
	try {
		child.stdin.write('{"requestId":"start-1","operation":"start"}\n');
		child.stdin.write(`${JSON.stringify({ requestId: "initialize-2", operation: "initialize", agentHome })}\n`);
		await waitFor(2, deadlines.initialDeadlineMs);
		controlStream.assertStartupComplete();
		if (!frames[1].ok && frames[1].error === "unsafe") {
			const diagnostic = await waitForUnsafeRejection();
			emitBootstrapRejection(options.diagnostics, diagnostic);
		}
	} catch (error) {
		try { await closeWithStreamCheck(); } catch { /* preserve the startup failure after owned cleanup */ }
		throw error;
	}
	const request = async (operation: "enumerate" | "shutdown" | "record" | "publish" | "list" | "resolve" | "remove" | "listen" | "stop-listener", values: Record<string, unknown> = {}) => {
		if (protocolError !== undefined) throw protocolError;
		const count = frames.length + 1;
		const requestId = `${operation}-${count}`;
		child.stdin.write(`${JSON.stringify({ requestId, operation, ...values })}\n`);
		await waitFor(count, deadlines.responseDeadlineMs);
		const frame = frames[count - 1];
		assert.equal(frame.requestId, requestId);
		return frame;
	};
	return {
		get frames() { return frames; },
		get exited() { return lifecycle.closeObserved; },
		get rejectionDiagnostic() { return stderrOverflow ? undefined : parseBootstrapRejectionDiagnostic(stderr); },
		enumerate: () => request("enumerate"),
		shutdown: () => request("shutdown"),
		presence: (operation: "record" | "publish" | "list" | "resolve" | "remove" | "listen" | "stop-listener", values: Record<string, unknown> = {}) => request(operation, values),
		invalidStartSchema: async () => { child.stdin.write(`${JSON.stringify({ requestId: `invalid-${frames.length + 1}`, operation: "start", extra: true })}\n`); await exitWithin(); },
		closeInput: closeWithStreamCheck,
	};
}

type InitializedHelper = Awaited<ReturnType<typeof openInitializedHelper>>;
async function withInitializedHelpers<T>(agentHomes: readonly string[], action: (helpers: readonly InitializedHelper[]) => Promise<T>, options: Readonly<{ diagnostics: BootstrapDiagnosticContext; spawnProcess?: (...args: any[]) => CleanupChild; initialDeadlineMs?: number; responseDeadlineMs?: number; terminateMs?: number; killMs?: number }>): Promise<T> {
	const opened = await Promise.allSettled(agentHomes.map((agentHome) => openInitializedHelper(agentHome, options)));
	const helpers: InitializedHelper[] = [];
	let initializationError: unknown;
	for (const outcome of opened) {
		if (outcome.status === "fulfilled") helpers.push(outcome.value);
		else if (initializationError === undefined) initializationError = outcome.reason;
	}
	try {
		if (initializationError !== undefined) throw initializationError;
		return await action(helpers);
	} finally {
		const cleanup = await Promise.allSettled(helpers.map((helper) => helper.closeInput()));
		const failed = cleanup.find((outcome) => outcome.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	}
}

type HelperRequest = Readonly<{ requestId: string; operation: "start" | "initialize" | "enumerate" | "shutdown"; agentHome?: string }>;
function plannedHelperRequests(agentHome: string, enumerate: boolean): readonly HelperRequest[] {
	return Object.freeze([
		{ requestId: "start-1", operation: "start" },
		{ requestId: "initialize-2", operation: "initialize", agentHome },
		...(enumerate ? [{ requestId: "enumerate-3", operation: "enumerate" as const }] : []),
		{ requestId: `shutdown-${enumerate ? 4 : 3}`, operation: "shutdown" },
	]);
}

async function helper(agentHome: string, enumerate = false, options: Readonly<{ diagnostics: BootstrapDiagnosticContext; spawnProcess?: (...args: any[]) => CleanupChild }>) {
	const requests = plannedHelperRequests(agentHome, enumerate);
	const result = await runPowerShell(runtime, [], requests.map((request) => JSON.stringify(request)).join("\n") + "\n", options);
	assert.equal(result.code, 0);
	const frames = parseHelperControlOutput(result.stdout, options.spawnProcess === undefined, "Windows helper returned malformed protocol output");
	assert.equal(frames.length, requests.length);
	assert.deepEqual(frames.map((frame) => frame.requestId), requests.map((request) => request.requestId));
	if (frames.some((frame) => !frame.ok && frame.error === "unsafe")) {
		if (result.stderrOverflow) throw new Error("Windows helper unsafe rejection diagnostic exceeded bounded output");
		const diagnostic = parseBootstrapRejectionDiagnostic(result.stderr);
		if (!diagnostic) throw new Error("Windows helper unsafe rejection diagnostic was missing");
		emitBootstrapRejection(options.diagnostics, diagnostic);
	}
	return frames;
}

async function fixtureResult(mode: "capture" | "equals" | "measure" | "add-extra-ace" | "junction" | "rename" | "replace-identical" | "hardlink" | "append" | "exclusive-open", path: string, extra: string[] = []) {
	const result = await runPowerShell(fixture, ["-Mode", mode, "-Path", path, ...extra]);
	assert.equal(result.code, 0, fixtureFailureMessage(result.code, result.stdout));
	return JSON.parse(result.stdout) as Record<string, boolean>;
}

const publicHostErrors = new Set(["unavailable", "unsafe", "busy", "not_found", "invalid"]);
function requirePublicPresenceResult(reply: unknown): unknown {
	if (reply && typeof reply === "object") {
		const frame = reply as Record<string, unknown>;
		if (frame.ok === true && Object.prototype.hasOwnProperty.call(frame, "result")) return frame.result;
		if (frame.ok === false && typeof frame.error === "string" && publicHostErrors.has(frame.error)) assert.fail(`Windows presence reply failed: ${frame.error}`);
	}
	assert.fail("Windows presence reply failed: unknown");
}

test("presence reply assertion preserves results and redacts malformed errors", () => {
	const result = Object.freeze({ records: Object.freeze([]) });
	assert.strictEqual(requirePublicPresenceResult({ ok: true, result }), result);
	assert.throws(() => requirePublicPresenceResult({ ok: false, error: "unsafe" }), /Windows presence reply failed: unsafe/);
	assert.throws(() => requirePublicPresenceResult({ ok: false, error: "C:\\private" }), /Windows presence reply failed: unknown/);
	assert.throws(() => requirePublicPresenceResult(undefined), /Windows presence reply failed: unknown/);
});

class FakeHelperChild extends EventEmitter {
	pid: number | undefined = 42;
	endCalls = 0;
	killCalls = 0;
	destroyCalls = 0;
	killResult = true;
	readonly stdin = Object.assign(new EventEmitter(), { write: (_value: string) => { this.onWrite?.(); return true; }, end: () => { this.endCalls++; this.onEnd?.(); } });
	readonly stdout = Object.assign(new EventEmitter(), { destroy: () => { this.destroyCalls++; } });
	readonly stderr = Object.assign(new EventEmitter(), { resume: () => {}, destroy: () => { this.destroyCalls++; } });
	onWrite?: () => void;
	onEnd?: () => void;
	kill() { this.killCalls++; return this.killResult; }
}

const fakeCleanupDeadlines = Object.freeze({ initialDeadlineMs: 40, responseDeadlineMs: 20, terminateMs: 10, killMs: 10 });
const unexpectedBootstrapDiagnostic: BootstrapDiagnosticContext = Object.freeze({ diagnostic: () => assert.fail("unexpected Windows bootstrap rejection diagnostic") });

test("owned helper cleanup settles a spawn error without an exit event", async () => {
	const child = new FakeHelperChild();
	child.pid = undefined;
	const spawnError = new Error("spawn failed");
	queueMicrotask(() => { child.emit("error", spawnError); child.stdin.emit("close"); child.stdout.emit("close"); child.stderr.emit("close"); });
	await assert.rejects(openInitializedHelper("C:\\profile\\agent", { diagnostics: unexpectedBootstrapDiagnostic, spawnProcess: () => child as unknown as CleanupChild, ...fakeCleanupDeadlines }), /spawn failed/);
	assert.equal(child.endCalls, 0);
	assert.equal(child.killCalls, 0);
});

test("owned helper cleanup reports failure after two bounded termination waits", async () => {
	const child = new FakeHelperChild();
	child.killResult = false;
	await assert.rejects(settleOwnedChild(child as unknown as CleanupChild, observeChildLifecycle(child as unknown as CleanupChild), { terminateMs: 10, killMs: 10 }), /did not settle/);
	assert.equal(child.endCalls, 1);
	assert.equal(child.killCalls, 1);
	assert.equal(child.destroyCalls, 2);
});

test("owned helper cleanup settles normally without escalation", async () => {
	const child = new FakeHelperChild();
	const lifecycle = observeChildLifecycle(child as unknown as CleanupChild);
	child.onEnd = () => child.emit("close");
	await settleOwnedChild(child as unknown as CleanupChild, lifecycle, { terminateMs: 20, killMs: 20 });
	assert.equal(child.endCalls, 1);
	assert.equal(child.killCalls, 0);
});

test("held helper reports delayed unsafe rejection before an assertion failure and closes input", async () => {
	const child = new FakeHelperChild();
	let writes = 0;
	child.onWrite = () => {
		writes++;
		if (writes === 2) queueMicrotask(() => {
			child.stdout.emit("data", Buffer.from('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n'));
			child.stdout.emit("data", Buffer.from('{"requestId":"initialize-2","ok":false,"error":"unsafe"}\n'));
			setTimeout(() => child.stderr.emit("data", Buffer.from('{"kind":"windows-session-bootstrap-rejection","stage":"transport-assert-owned","ntstatus":null}\n')), 5);
		});
	};
	child.onEnd = () => child.emit("close", 0);
	const emitted: string[] = [];
	const diagnostics: BootstrapDiagnosticContext = { diagnostic: (message) => emitted.push(message) };
	let owned: InitializedHelper | undefined;
	await assert.rejects(withInitializedHelpers(["C:\\profile\\agent"], async ([held]) => {
		owned = held;
		assert.deepEqual(emitted, ['{"kind":"windows-session-bootstrap-rejection","stage":"transport-assert-owned","ntstatus":null}']);
		assert.equal(held.frames[1].ok, true, "deliberate assertion failure after initialization");
	}, { spawnProcess: () => child as unknown as CleanupChild, diagnostics, ...fakeCleanupDeadlines }), /deliberate assertion failure/);
	assert.equal(child.endCalls, 1);
	assert.equal(child.killCalls, 0);
	assert.equal(owned?.exited, true);
});

test("held helper bounds a missing unsafe rejection diagnostic and closes input", async () => {
	const child = new FakeHelperChild();
	let writes = 0;
	child.onWrite = () => {
		writes++;
		if (writes === 2) queueMicrotask(() => {
			child.stdout.emit("data", Buffer.from('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n'));
			child.stdout.emit("data", Buffer.from('{"requestId":"initialize-2","ok":false,"error":"unsafe"}\n'));
		});
	};
	child.onEnd = () => child.emit("close", 0);
	await assert.rejects(openInitializedHelper("C:\\profile\\agent", { diagnostics: unexpectedBootstrapDiagnostic, spawnProcess: () => child as unknown as CleanupChild, ...fakeCleanupDeadlines }), /unsafe rejection diagnostic/);
	assert.equal(child.endCalls, 1);
	assert.equal(child.killCalls, 0);
});

test("normal helper emits a validated unsafe rejection through its diagnostic context", async (t) => {
	const child = new FakeHelperChild();
	child.onEnd = () => {
		child.stdout.emit("data", Buffer.from('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n'));
		child.stdout.emit("data", Buffer.from('{"requestId":"initialize-2","ok":false,"error":"unsafe"}\n'));
		child.stdout.emit("data", Buffer.from('{"requestId":"shutdown-3","ok":true,"result":{"state":"partial"}}\n'));
		setTimeout(() => {
			child.stderr.emit("data", Buffer.from('{"kind":"windows-session-bootstrap-rejection","stage":"transport-assert-owned","ntstatus":null}\n'));
			child.emit("close", 0);
		}, 5);
	};
	const emitted: string[] = [];
	const diagnostics: BootstrapDiagnosticContext = { diagnostic: (message) => { emitted.push(message); t.diagnostic(message); } };
	const frames = await helper("C:\\profile\\agent", false, { spawnProcess: () => child as unknown as CleanupChild, diagnostics });
	assert.equal(frames[1].error, "unsafe");
	assert.deepEqual(emitted, ['{"kind":"windows-session-bootstrap-rejection","stage":"transport-assert-owned","ntstatus":null}']);
	assert.equal(child.endCalls, 1);
});

test("held helper reader rejects deferred malformed and duplicate control frames", async () => {
	for (const { prefix, deferred, cleanupRejects } of [
		{ prefix: "", deferred: '{"event":"startup-marker","marker":"unknown"}\n', cleanupRejects: true },
		{ prefix: '{"event":"startup-marker","marker":"script-entered"}\n{"event":"startup-marker","marker":"native-ready"}\n', deferred: '{"event":"startup-marker","marker":"native-ready"}\n', cleanupRejects: false },
	]) {
		const child = new FakeHelperChild();
		let writes = 0;
		child.onWrite = () => {
			if (++writes !== 2) return;
			queueMicrotask(() => {
				child.stdout.emit("data", Buffer.from(`${prefix}{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n{"requestId":"initialize-2","ok":true,"result":{"state":"initialized","bootstrap":"complete"}}\n`));
				child.stdout.emit("data", Buffer.from(deferred));
			});
		};
		if (cleanupRejects) child.killResult = false;
		else child.onEnd = () => child.emit("close", 0);
		await assert.rejects(openInitializedHelper("C:\\profile\\agent", { diagnostics: unexpectedBootstrapDiagnostic, spawnProcess: () => child as unknown as CleanupChild, ...fakeCleanupDeadlines }), /malformed protocol output/);
		assert.equal(child.endCalls, 1);
		if (cleanupRejects) {
			assert.equal(child.killCalls, 1);
			assert.equal(child.destroyCalls, 2);
		}
	}
});

test("held helper reader rejects truncated and oversized suffixes after valid replies", async () => {
	for (const suffix of [Buffer.from("{"), Buffer.alloc(maxHelperControlBytes + 2, 0x78)]) {
		const child = new FakeHelperChild();
		let writes = 0;
		child.onWrite = () => {
			if (++writes !== 2) return;
			queueMicrotask(() => {
				child.stdout.emit("data", Buffer.from('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n{"requestId":"initialize-2","ok":true,"result":{"state":"initialized","bootstrap":"complete"}}\n'));
				child.stdout.emit("data", suffix);
				child.stdout.emit("end");
			});
		};
		child.onEnd = () => child.emit("close", 0);
		await assert.rejects(openInitializedHelper("C:\\profile\\agent", { diagnostics: unexpectedBootstrapDiagnostic, spawnProcess: () => child as unknown as CleanupChild, ...fakeCleanupDeadlines }), /malformed protocol output/);
		assert.equal(child.endCalls, 1);
	}
});

test("concurrent held helper ownership cleans fulfilled helpers after another initialization rejects", async () => {
	const fulfilled = new FakeHelperChild();
	let writes = 0;
	fulfilled.onWrite = () => {
		writes++;
		if (writes === 2) queueMicrotask(() => {
			fulfilled.stdout.emit("data", Buffer.from('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}\n'));
			fulfilled.stdout.emit("data", Buffer.from('{"requestId":"initialize-2","ok":true,"result":{"state":"initialized","bootstrap":"complete"}}\n'));
		});
	};
	fulfilled.onEnd = () => fulfilled.emit("close", 0);
	const rejected = new FakeHelperChild();
	rejected.onWrite = () => queueMicrotask(() => rejected.emit("close", 1));
	await assert.rejects(withInitializedHelpers(["C:\\profile\\agent", "C:\\profile\\agent"], async () => assert.fail("should not run after initialization rejection"), {
		diagnostics: unexpectedBootstrapDiagnostic,
		spawnProcess: (() => { let calls = 0; return () => (++calls === 1 ? fulfilled : rejected) as unknown as CleanupChild; })(),
		...fakeCleanupDeadlines,
	}), /exited before its reply/);
	assert.equal(fulfilled.endCalls, 1);
	assert.equal(fulfilled.killCalls, 0);
});

test("owned helper cleanup waits for close after exit", async () => {
	const child = new FakeHelperChild();
	const lifecycle = observeChildLifecycle(child as unknown as CleanupChild);
	queueMicrotask(() => child.emit("exit", 0));
	setTimeout(() => child.emit("close", 0), 15);
	assert.equal(await waitForChildClose(lifecycle, 40), true);
	assert.equal(lifecycle.closeObserved, true);
});

test("owned helper cleanup fails bounded exit without close", async () => {
	const child = new FakeHelperChild();
	const lifecycle = observeChildLifecycle(child as unknown as CleanupChild);
	queueMicrotask(() => child.emit("exit", 0));
	assert.equal(await waitForChildClose(lifecycle, 15), false);
});

test("owned helper cleanup accepts an already observed close", async () => {
	const child = new FakeHelperChild();
	const lifecycle = observeChildLifecycle(child as unknown as CleanupChild);
	child.emit("close", 0);
	assert.equal(await waitForChildClose(lifecycle, 15), true);
});

test("startup control contains asynchronous stdin errors and waits for close", async () => {
	const child = new FakeHelperChild();
	child.onEnd = () => queueMicrotask(() => { child.stdin.emit("error", new Error("input failed")); child.emit("close", 1); });
	await assert.rejects(runBootstrapStartupControl({ spawnProcess: () => child as unknown as CleanupChild, startupDeadlineMs: 20, terminateMs: 10, killMs: 10 }), /did not complete/);
	assert.equal(child.endCalls, 1);
	assert.equal(child.killCalls, 0);
});

test("startup control reports a bounded failure when stdin error never closes", async () => {
	const child = new FakeHelperChild();
	child.onEnd = () => queueMicrotask(() => child.stdin.emit("error", new Error("input failed")));
	await assert.rejects(runBootstrapStartupControl({ spawnProcess: () => child as unknown as CleanupChild, startupDeadlineMs: 20, terminateMs: 10, killMs: 10 }), /did not settle/);
	assert.equal(child.endCalls, 2);
	assert.equal(child.killCalls, 1);
	assert.equal(child.destroyCalls, 2);
});

test("premature helper close rejects initialization and bounded cleanup settles", async () => {
	const child = new FakeHelperChild();
	child.onWrite = () => child.emit("close");
	await assert.rejects(openInitializedHelper("C:\\profile\\agent", { diagnostics: unexpectedBootstrapDiagnostic, spawnProcess: () => child as unknown as CleanupChild, ...fakeCleanupDeadlines }), /exited before its reply/);
	assert.equal(child.killCalls, 0);
});

test("Windows helper constructs the native Volume GUID path with exactly one native prefix", async () => {
	const source = await readFile(runtime, "utf8");
	assert.ok(source.includes('return @"\\??\\" + volume.Substring(4);'));
});

test("Windows bootstrap source guard permits object-manager alias resolution only for the canonical volume root", async (t) => {
	t.diagnostic("source guard, not native Windows proof");
	const source = await readFile(runtime, "utf8");
	assert.match(source, /static OpenResult OpenVolume\(string volumePath\)/);
	assert.match(source, /static IntPtr RequireVolumeOpen\(string volumePath, uint volumeSerial\)/);
	assert.match(source, /SetStage\("volume-open"\); IntPtr volume = RequireVolumeOpen\(VolumePath\(agentHome, out volumeSerial\), volumeSerial\)/);
	assert.doesNotMatch(source, /RequireOpen\(IntPtr\.Zero, VolumePath\(agentHome\)/);
	const volumeStart = source.indexOf("static OpenResult OpenVolume(string volumePath)");
	const volumeEnd = source.indexOf("static void AssertDirectory", volumeStart);
	assert.ok(volumeStart >= 0 && volumeEnd > volumeStart, "source guard: canonical-volume root opener was not found");
	const volumeOpen = source.slice(volumeStart, volumeEnd);
	assert.match(volumeOpen, /attributes\.Attributes = OBJ_CASE_INSENSITIVE;/);
	assert.doesNotMatch(volumeOpen, /OBJ_DONT_REPARSE/);
	assert.match(volumeOpen, /FILE_DIRECTORY_FILE \| FILE_SYNCHRONOUS_IO_NONALERT \| FILE_OPEN_REPARSE_POINT/);
	const componentStart = source.indexOf("static OpenResult Open(IntPtr root, string name, bool privateDirectory, bool create, byte[] descriptor)");
	const componentEnd = source.indexOf("// OBJ_DONT_REPARSE", componentStart);
	assert.ok(componentStart >= 0 && componentEnd > componentStart, "source guard: component opener was not found");
	const componentOpen = source.slice(componentStart, componentEnd);
	assert.match(componentOpen, /attributes\.Attributes = OBJ_CASE_INSENSITIVE \| OBJ_DONT_REPARSE;/);
	assert.match(componentOpen, /FILE_DIRECTORY_FILE \| FILE_SYNCHRONOUS_IO_NONALERT \| FILE_OPEN_REPARSE_POINT/);
	assert.match(source, /if \(!GetFileInformationByHandle\(result\.Handle, out info\) \|\| info\.VolumeSerialNumber != volumeSerial\) Fail\("unsafe"\);/);
});

test("Windows bootstrap bridge admits only explicit partial or initialized public states", () => {
	assert.deepEqual(parseWindowsHostFrame('{"requestId":"start-1","ok":true,"result":{"state":"partial"}}'), {
		requestId: "start-1", ok: true, result: { state: "partial" },
	});
	assert.deepEqual(parseWindowsHostFrame('{"requestId":"initialize-2","ok":true,"result":{"state":"initialized","bootstrap":"complete"}}'), {
		requestId: "initialize-2", ok: true, result: { state: "initialized", bootstrap: "complete" },
	});
	assert.deepEqual(parseWindowsHostFrame('{"requestId":"enumerate-3","ok":true,"result":{"state":"initialized","bootstrap":"complete","entries":2}}'), {
		requestId: "enumerate-3", ok: true, result: { state: "initialized", bootstrap: "complete", entries: 2 },
	});
	assert.throws(() => parseWindowsHostFrame('{"requestId":"start-1","ok":true,"result":{"ready":true}}'), /invalid Windows transport frame/);
});

test("Windows helper request plans correlate standalone and enumeration reply counts", () => {
	assert.deepEqual(plannedHelperRequests("C:\\profile\\agent", false).map((request) => request.requestId), ["start-1", "initialize-2", "shutdown-3"]);
	assert.deepEqual(plannedHelperRequests("C:\\profile\\agent", true).map((request) => request.requestId), ["start-1", "initialize-2", "enumerate-3", "shutdown-4"]);
});

test("Windows startup marker source emits fixed ordinal control records", async (t) => {
	t.diagnostic("source guard, not native Windows timing proof");
	const source = await readFile(runtime, "utf8");
	const scriptEntered = source.indexOf("[Console]::Out.WriteLine('{\"event\":\"startup-marker\",\"marker\":\"script-entered\"}')");
	const strictMode = source.indexOf("Set-StrictMode -Version Latest");
	const addType = source.indexOf("Add-Type -ErrorAction Stop");
	const nativeReady = source.indexOf("[WindowsSessionBootstrap]::WriteControl('{\"event\":\"startup-marker\",\"marker\":\"native-ready\"}')");
	assert.ok(scriptEntered >= 0 && strictMode > scriptEntered && addType > strictMode && nativeReady > addType, "startup markers must bound, not replace, the bootstrap interval");
	assert.match(source.slice(scriptEntered, strictMode), /^\[Console\]::Out\.WriteLine\('\{"event":"startup-marker","marker":"script-entered"\}'\)\r?\n$/);
	assert.match(source.slice(nativeReady, source.indexOf("\n", nativeReady)), /^\s*\[WindowsSessionBootstrap\]::WriteControl\('\{"event":"startup-marker","marker":"native-ready"\}'\)\r?$/);
});

test("packed Windows startup timing source guard uses the installed helper direct driver", async (t) => {
	t.diagnostic("source guard, not hosted Windows timing proof");
	const source = await readFile(packedRunner, "utf8");
	assert.match(source, /const WINDOWS_STARTUP_TIMING_BUDGET_MS = 25_000;/);
	assert.ok(source.includes('const WINDOWS_STARTUP_TIMING_POWERSHELL = "C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe";'));
	assert.match(source, /spawn\(WINDOWS_STARTUP_TIMING_POWERSHELL, \["-NoLogo", "-NoProfile", "-NonInteractive", "-File", runtimeScript\], \{ cwd, env, shell: false, windowsHide: true, stdio: \["pipe", "pipe", "pipe"\] \}\)/);
	assert.match(source, /child\.stdin\.end\(WINDOWS_STARTUP_TIMING_START_REQUEST/);
	assert.match(source, /WINDOWS_STARTUP_TIMING_VALID_START_REPLIES\.has\(line\) \|\| markerOrdinal !== 2/);
	assert.match(source, /WINDOWS_STARTUP_TIMING_REJECTED_START_REPLY\.test\(line\)/);
	assert.match(source, /line\.length >= 3 && line\[0\] === 0xef && line\[1\] === 0xbb && line\[2\] === 0xbf/);
	assert.match(source, /const elapsedMs = Number\(process\.hrtime\.bigint\(\) - startedAt\) \/ 1e6;/);
	assert.match(source, /mode: "windows-startup-timing"/);
	assert.doesNotMatch(source, /new WindowsSessionTransportHost\(\{[^}]*rpcDeadlineMs: WINDOWS_STARTUP_TIMING_BUDGET_MS/);
	const helper = await readFile(runtime, "utf8");
	assert.match(helper, /function Write-Reply\([\s\S]*?@\{ requestId = \$requestId; ok = \$true; result = \$result \} \| ConvertTo-Json -Compress -Depth 4/);
	const timingDriver = source.slice(source.indexOf("function runWindowsStartupTimingProbe"), source.indexOf("async function testHookedPackedRunner"));
	assert.doesNotMatch(timingDriver, /JSON\.parse/);
});

test("Windows startup environment delta admits only the fixed machine path allowlist", () => {
	const source = {
		ProgramFiles: "C:\\Program Files",
		"ProgramFiles(x86)": "C:\\Program Files (x86)",
		ProgramW6432: "C:\\Program Files",
		SystemRoot: "C:\\Windows",
	};
	const delta = deriveWindowsStartupTimingPathDelta(source);
	assert.equal(delta.ready, true);
	assert.deepEqual(delta.pathAdditionKeys, WINDOWS_STARTUP_TIMING_WINDOWS_PATH_KEYS);
	assert.deepEqual(delta.values, {
		ProgramFiles: "C:\\Program Files",
		"ProgramFiles(x86)": "C:\\Program Files (x86)",
		ProgramW6432: "C:\\Program Files",
		CommonProgramFiles: "C:\\Program Files\\Common Files",
		"CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files",
		CommonProgramW6432: "C:\\Program Files\\Common Files",
		PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules",
	});
	for (const invalid of [
		{ ...source, ProgramFiles: "C:\\Program Files\n" },
		{ ...source, ProgramFiles: "C:\\Program Files\0" },
		{ ProgramFiles: source.ProgramFiles, "ProgramFiles(x86)": source["ProgramFiles(x86)"], SystemRoot: source.SystemRoot },
		{ ...source, programfiles: "D:\\Program Files" },
		{ ...source, ProgramFiles: "C:\\Program Files\\..\\Users" },
	]) assert.equal(deriveWindowsStartupTimingPathDelta(invalid).ready, false);
	assert.equal(deriveWindowsStartupTimingPathDelta({ ...source, programfiles: source.ProgramFiles }).ready, true, "same-value aliases have an explicit deterministic policy");
});

test("Windows startup environment operational validation rejects noncanonical machine paths", () => {
	const delta = deriveWindowsStartupTimingPathDelta({
		ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files", SystemRoot: "C:\\Windows",
	});
	const filesystem = { lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false }), realpath: (path: string) => path };
	assert.equal(validateWindowsStartupTimingMachinePaths(delta, filesystem), true);
	assert.equal(validateWindowsStartupTimingMachinePaths(delta, { ...filesystem, realpath: () => "C:\\Users" }), false);
	assert.equal(validateWindowsStartupTimingMachinePaths(delta, { ...filesystem, lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => true }) }), false);
});

test("Windows packed runner entrypoint guard distinguishes imports, aliases, and unresolved entries", () => {
	const resolvePath = (path: string) => path;
	const inert = { identity: "import", runModes: false, exitCode: null };
	assert.deepEqual(decidePackedRunnerEntrypoint("/repo/runner.mjs", undefined, "linux", { resolvePath, realpath: (path: string) => path }), inert);
	assert.deepEqual(decidePackedRunnerEntrypoint("/repo/runner.mjs", "/repo/alias.mjs", "linux", { resolvePath, realpath: () => "/repo/runner.mjs" }), { identity: "main", runModes: true, exitCode: null });
	assert.deepEqual(decidePackedRunnerEntrypoint("C:\\Repo Dir\\Runner.mjs", "c:\\repo dir\\runner.mjs", "win32", { resolvePath, realpath: (path: string) => path }), { identity: "main", runModes: true, exitCode: null });
	assert.deepEqual(decidePackedRunnerEntrypoint("/repo/runner.mjs", "/repo/other.mjs", "linux", { resolvePath, realpath: (path: string) => path }), inert);
	assert.deepEqual(decidePackedRunnerEntrypoint("/repo/runner.mjs", "/foreign-cli.mjs", "linux", { resolvePath, realpath: () => { throw new Error("unresolved"); } }), inert, "a foreign importer with an unresolvable argv entry cannot set an exit code or run a mode");
	assert.deepEqual(decidePackedRunnerEntrypoint("/repo/runner.mjs", "/repo/runner.mjs", "linux", { resolvePath, realpath: () => { throw new Error("unresolved"); } }), { identity: "direct-unresolved", runModes: false, exitCode: 1 });
});

test("Windows packed startup environment experiment source guard selects the paired CI case", async (t) => {
	t.diagnostic("source guard, not hosted Windows environment experiment proof");
	const source = await readFile(packedRunner, "utf8");
	assert.match(source, /WINDOWS_STARTUP_TIMING_ENVIRONMENT_CASE_NAMES = Object\.freeze\(\["baseline", "windows-paths"\]\)/);
	assert.match(source, /export function deriveWindowsStartupTimingPathDelta\(source\)/);
	assert.match(source, /const pathDelta = deriveWindowsStartupTimingPathDelta\(process\.env\)/);
	assert.match(source, /const treatmentPathDelta = validateWindowsStartupTimingMachinePaths\(pathDelta\) \? pathDelta : undefined/);
	assert.match(source, /isTreatment \? Object\.assign\(\{\}, isolatedEnv, treatmentPathDelta\.values\) : isolatedEnv/);
	assert.match(source, /caseOrder: "baseline-first-fixed"/);
	assert.match(source, /sharedState: "shared-owned-home-and-cache"/);
	assert.match(source, /confounders: "baseline-first-order-and-cache-effects"/);
	assert.match(source, /conclusion: "no-causal-attribution-not-product-ready"/);
	assert.match(source, /mode: "windows-startup-timing-environment"/);
	assert.match(source, /receipt\.cases\[0\]\.physicalCloseObserved !== true/);
	const environmentFactory = source.slice(source.indexOf("function isValidatedWindowsMachineRoot"), source.indexOf("function assertPackResult"));
	const environmentExperiment = source.slice(source.indexOf("async function testWindowsStartupTimingEnvironmentExperiment"), source.indexOf("async function testUnhookedPackedImports"));
	assert.doesNotMatch(environmentFactory, /\.\.\.process\.env/);
	assert.doesNotMatch(environmentExperiment, /\.\.\.process\.env/);
	assert.doesNotMatch(environmentFactory, /PSModulePath:\s*process\.env/);
	const workflow = await readFile(fileURLToPath(new URL("../.github/workflows/windows-session-bootstrap.yml", import.meta.url)), "utf8");
	assert.match(workflow, /workflow_dispatch:\s+inputs:\s+run_windows_startup_experiment:\s+description: "Run the completed paired Windows startup experiment"\s+required: false\s+default: false\s+type: boolean/);
	assert.match(workflow, /Measure paired packed Windows helper startup environment experiment \(experimental\)/);
	assert.match(workflow, /if: "!cancelled\(\) && inputs\.run_windows_startup_experiment == true && matrix\.platform == 'windows' && steps\.install_windows_dependencies\.outcome == 'success'"/);
	assert.match(workflow, /Prove packed real SDK session lifecycle \(Windows\)\s+if: "!cancelled\(\) && matrix\.platform == 'windows' && steps\.install_windows_dependencies\.outcome == 'success'"/);
	assert.match(workflow, /node scripts\\test-packed-runner\.mjs --windows-startup-timing-environment/);
	for (const title of [
		"Windows startup environment delta admits only the fixed machine path allowlist",
		"Windows startup environment operational validation rejects noncanonical machine paths",
		"Windows packed startup environment experiment source guard selects the paired CI case",
		"Windows packed runner entrypoint guard distinguishes imports, aliases, and unresolved entries",
	]) assert.ok(workflow.includes(title));
	assert.doesNotMatch(workflow, /node scripts\\test-packed-runner\.mjs --windows-startup-timing\n/);
});

test("Windows bootstrap Add-Type failures use an owned bounded diagnostic", async () => {
	const source = await readFile(runtime, "utf8");
	assert.match(source, /Add-Type -ErrorAction Stop -ErrorVariable \+addTypeErrors -TypeDefinition @'/);
	assert.match(source, /catch \{\s*\$nativeReady = \$false\s*Write-BootstrapDiagnostic \(@\(\$addTypeErrors\) \+ @\(\$_\)\)\s*\}/);
});

test("Windows bootstrap captures only local Add-Type records and fixed metadata", async () => {
	const source = await readFile(runtime, "utf8");
	assert.match(source, /\$addTypeErrors = @\(\)/);
	assert.match(source, /-ErrorVariable \+addTypeErrors/);
	assert.match(source, /reason = \$reason; languageMode = \$languageMode/);
	assert.doesNotMatch(source, /\$Error\b/);
});

test("Windows bootstrap diagnostic guards wrapped Add-Type entries under StrictMode", async () => {
	const source = await readFile(runtime, "utf8");
	assert.match(source, /function Get-BootstrapProperty/);
	assert.match(source, /function ConvertTo-BootstrapDiagnosticRecord/);
	assert.match(source, /\.PSObject\.Properties\[\$name\]/);
	assert.match(source, /\$candidate -is \[System\.Management\.Automation\.ErrorRecord\]/);
	assert.match(source, /\$wrapped = Get-BootstrapProperty \$candidate 'ErrorRecord'/);
	assert.match(source, /\$wrapped -is \[System\.Management\.Automation\.ErrorRecord\]/);
	assert.match(source, /function Write-BootstrapDiagnosticFallback/);
	assert.match(source, /catch \{ Write-BootstrapDiagnosticFallback \}/);
	assert.doesNotMatch(source, /\$record\.CategoryInfo|\$record\.ErrorDetails|\$record\.Exception/);
});

test("Windows bootstrap source guard—not native proof—extracts only structured compiler ErrorNumber values", async (t) => {
	t.diagnostic("source guard, not native Windows proof");
	const source = await readFile(runtime, "utf8");
	assert.match(source, /TargetObject/);
	assert.match(source, /function Get-BootstrapCompilerErrorCode/);
	assert.match(source, /\$target -isnot \[System\.CodeDom\.Compiler\.CompilerError\]/);
	assert.match(source, /Get-BootstrapProperty \$target 'ErrorNumber'/);
	assert.ok(source.includes(String.raw`$errorNumber -cmatch '\ACS[0-9]{4}\z'`));
	assert.doesNotMatch(source, /TargetObject\.ToString/);
	assert.doesNotMatch(source, /Get-BootstrapProperty \$target 'ErrorText'/);
});

test("Windows bootstrap rejection diagnostic is fixed-stage evidence, not native Windows compile proof", async (t) => {
	t.diagnostic("source guard, not native Windows compile proof");
	const source = await readFile(runtime, "utf8");
	assert.match(source, /public readonly uint\? NtStatus/);
	assert.match(source, /SetNtStatus\(result\.Status\)/);
	assert.match(source, /Write-BootstrapRejectionDiagnostic \$_\.Exception/);
	assert.match(source, /kind = 'windows-session-bootstrap-rejection'; stage = \$stage; ntstatus = \$ntstatus/);
	assert.doesNotMatch(source, /new BootstrapFailure\("unsafe"\)/);
	const rejectionWriter = source.match(/function Write-BootstrapRejectionDiagnostic[\s\S]*?\n\}/)?.[0];
	assert.ok(rejectionWriter);
	assert.doesNotMatch(rejectionWriter, /\.HasValue|\.Value|GetLastErrorText|ToString\(\)|Message|StackTrace/);
});

test("Windows bootstrap diagnostic parser accepts fixed Add-Type evidence", () => {
	assert.deepEqual(parseBootstrapDiagnostic('{"kind":"windows-session-bootstrap-diagnostic","category":"compiler","compilerCodes":["CS1001","CS1739"],"reason":"source-code-error","languageMode":"full"}\n'), {
		kind: "windows-session-bootstrap-diagnostic", category: "compiler", compilerCodes: ["CS1001", "CS1739"], reason: "source-code-error", languageMode: "full",
	});
	assert.deepEqual(parseBootstrapDiagnostic('{"kind":"windows-session-bootstrap-diagnostic","category":"other","compilerCodes":[],"reason":"unknown","languageMode":"constrained"}\n'), {
		kind: "windows-session-bootstrap-diagnostic", category: "other", compilerCodes: [], reason: "unknown", languageMode: "constrained",
	});
	assert.deepEqual(parseBootstrapDiagnostic('{"kind":"windows-session-bootstrap-diagnostic","category":"other","compilerCodes":[],"reason":"unknown","languageMode":"unknown"}\n'), {
		kind: "windows-session-bootstrap-diagnostic", category: "other", compilerCodes: [], reason: "unknown", languageMode: "unknown",
	});
});

test("Windows bootstrap diagnostic parser fails closed for unsafe input", () => {
	assert.equal(parseBootstrapDiagnostic('{"kind":"windows-session-bootstrap-diagnostic","category":"other","compilerCodes":["CS1001"],"reason":"unknown","languageMode":"full"}\n'), undefined);
	assert.equal(parseBootstrapDiagnostic('{"kind":"windows-session-bootstrap-diagnostic","category":"compiler","compilerCodes":["CS1001","CS1001"],"reason":"source-code-error","languageMode":"full"}\n'), undefined);
	assert.equal(parseBootstrapDiagnostic('{"kind":"windows-session-bootstrap-diagnostic","category":"compiler","compilerCodes":[],"reason":"untrusted-error-id","languageMode":"full"}\n'), undefined);
	assert.equal(parseBootstrapDiagnostic("x".repeat(maxBootstrapDiagnosticBytes + 1)), undefined);
});

test("Windows bootstrap rejection parser admits only fixed native phase evidence", () => {
	assert.deepEqual(parseBootstrapRejectionDiagnostic('{"kind":"windows-session-bootstrap-rejection","stage":"transport-assert-owned","ntstatus":null}\n'), {
		kind: "windows-session-bootstrap-rejection", stage: "transport-assert-owned", ntstatus: null,
	});
	assert.deepEqual(parseBootstrapRejectionDiagnostic('{"kind":"windows-session-bootstrap-rejection","stage":"ancestor-open","ntstatus":3221225524}\n'), {
		kind: "windows-session-bootstrap-rejection", stage: "ancestor-open", ntstatus: 3221225524,
	});
	assert.equal(parseBootstrapRejectionDiagnostic('{"kind":"windows-session-bootstrap-rejection","stage":"transport-assert-owned","ntstatus":-1}\n'), undefined);
	assert.equal(parseBootstrapRejectionDiagnostic('{"kind":"windows-session-bootstrap-rejection","stage":"transport-assert-owned","ntstatus":1.5}\n'), undefined);
	assert.equal(parseBootstrapRejectionDiagnostic('{"kind":"windows-session-bootstrap-rejection","stage":"transport-assert-owned","ntstatus":0,"sid":"S-1-5-18"}\n'), undefined);
	assert.equal(parseBootstrapRejectionDiagnostic('{"kind":"windows-session-bootstrap-rejection","stage":"transport-assert-owned","ntstatus":null}' + " ".repeat(maxBootstrapDiagnosticBytes) + "\n"), undefined);
});

test("Windows fixture replacement failure parser admits only fixed diagnostic evidence", () => {
	const copyFailure = '{"ok":false,"kind":"windows-session-bootstrap-fixture-failure","stage":"replacement-copy","codeKind":"hresult","code":-2147024864}\n';
	assert.deepEqual(parseFixtureFailureDiagnostic(copyFailure), { kind: "windows-session-bootstrap-fixture-failure", stage: "replacement-copy", codeKind: "hresult", code: -2147024864 });
	assert.deepEqual(parseFixtureFailureDiagnostic('{"ok":false,"kind":"windows-session-bootstrap-fixture-failure","stage":"replacement-rename","codeKind":"unknown","code":null}\n'), { kind: "windows-session-bootstrap-fixture-failure", stage: "replacement-rename", codeKind: "unknown", code: null });
	assert.equal(fixtureFailureMessage(1, copyFailure), "Windows replacement fixture failed: replacement-copy:hresult:-2147024864");
	assert.equal(fixtureFailureMessage(1, '{"ok":false,"kind":"windows-session-bootstrap-fixture-failure","stage":"replacement-copy","codeKind":"hresult","code":-2147024864,"path":"private"}\n'), "Windows fixture failed");
	assert.equal(parseFixtureFailureDiagnostic('{"ok":false,"kind":"windows-session-bootstrap-fixture-failure","stage":"replacement-acl","codeKind":"win32","code":-1}\n'), undefined);
	assert.equal(parseFixtureFailureDiagnostic('{"ok":false,"kind":"windows-session-bootstrap-fixture-failure","stage":"replacement-acl","codeKind":"win32","code":0}\n'), undefined);
	assert.equal(parseFixtureFailureDiagnostic('{"ok":false,"kind":"windows-session-bootstrap-fixture-failure","stage":"replacement-acl","codeKind":"hresult","code":0}\n'), undefined);
	assert.equal(parseFixtureFailureDiagnostic('{"ok":false,"kind":"windows-session-bootstrap-fixture-failure","stage":"replacement-copy","codeKind":"unknown","code":0}\n'), undefined);
	assert.equal(parseFixtureFailureDiagnostic("x".repeat(maxFixtureFailureDiagnosticBytes + 1)), undefined);
});

test("Windows fixture replacement failures expose only fixed stages and numeric codes", async (t) => {
	t.diagnostic("source guard, not native Windows proof");
	const source = await readFile(fixture, "utf8");
	assert.match(source, /\$replacementStage = 'replacement-copy'[\s\S]*?\[IO\.File\]::Copy/);
	assert.match(source, /\$replacementStage = 'replacement-acl'\s*Set-Acl/);
	assert.match(source, /\$original = "\$Path\.original-\$\(\[Guid\]::NewGuid\(\)\.ToString\('N'\)\)"/);
	assert.match(source, /\$replacementStage = 'replacement-rename'[\s\S]*?MoveFileEx\(\$Path, \$original, 0\)/);
	assert.match(source, /MoveFileEx\(\$temp, \$Path, 0\)/);
	assert.doesNotMatch(source, /MoveFileEx\(\$temp, \$Path, 1\)/);
	assert.match(source, /\[Runtime\.InteropServices\.Marshal\]::GetLastWin32Error\(\)/);
	assert.match(source, /kind = 'windows-session-bootstrap-fixture-failure'; stage = \$replacementStage; codeKind = \$replacementCodeKind; code = \$replacementCode/);
	assert.doesNotMatch(source, /replacementStage[\s\S]*?\.Message|replacementStage[\s\S]*?\.ToString\(\)|replacementStage[\s\S]*?StackTrace/);
});

test("Windows presence source guard uses rooted no-replace publication and same-handle deletion", async (t) => {
	t.diagnostic("source guard, not native Windows proof");
	const source = await readFile(runtime, "utf8");
	assert.match(source, /static OpenResult OpenRecord\(IntPtr root, string name, bool create, byte\[\] descriptor, bool allowDeleteSharing\)/);
	assert.match(source, /attributes\.Attributes = OBJ_CASE_INSENSITIVE \| OBJ_DONT_REPARSE/);
	assert.match(source, /NtSetInformationFile\(file, out io, memory, \(uint\)\(header \+ chars\.Length\), 10\)/);
	assert.match(source, /const int FileDispositionInformation = 13/);
	assert.match(source, /NtSetInformationFile\(file, out io, memory, 1, FileDispositionInformation\)/);
	assert.doesNotMatch(source, /NtSetInformationFile\(file, out io, memory, 1, 4\)/);
	assert.match(source, /RecordIdentity identity = AssertRecord\(file, sid\);/);
	assert.match(source, /SafeFileHandle Handle/);
	assert.match(source, /new SafeFileHandle\(handle, true\)/);
	assert.match(source, /OpenRecord\(Presence, temporary, true, descriptor, true\)/);
	assert.match(source, /OpenRecord\(Presence, name, false, null, true\)/);
	assert.match(source, /FILE_SHARE_READ \| FILE_SHARE_WRITE \| \(allowDeleteSharing \? FILE_SHARE_DELETE : 0\)/);
	assert.match(source, /OwnedPublications\.Add\(owned\)/);
	assert.match(source, /AssertRetainedPublication\(owned\.Handle, owned\.Sid\)/);
	assert.match(source, /owned\.Dispose\(\)/);
	assert.match(source, /info\.NumberOfLinks != 1/);
	assert.match(source, /!identity\.Equals\(retained\)/);
	assert.match(source, /try \{\s*if \(owned\.Sid != sid\) Fail\("unsafe"\); RecordIdentity retained = AssertRetainedPublication/);
	assert.match(source, /function Write-Reply\([\s\S]*?result = \$result \} \| ConvertTo-Json -Compress -Depth 4/);
	assert.match(source, /public static PresenceRecord\[\] List\(string sid\) \{ return List\(null, sid\); \}/);
	assert.match(source, /public static PresenceRecord\[\] List\(string excluded, string sid\)/);
	assert.match(source, /\$nativeRecords = if \(\$hasExcludeSessionId\) \{ \[WindowsSessionBootstrap\]::List\(\$excludeSessionId, \$identity\.Sid\) \} else \{ \[WindowsSessionBootstrap\]::List\(\$identity\.Sid\) \}/);
	assert.match(source, /public static void RemoveOwn\(string sessionId, string endpoint, long createdAt, string sid\)/);
});

test("Windows bootstrap startup control", { skip: process.platform !== "win32", timeout: 40_000 }, async (t) => {
	const result = await runBootstrapStartupControl();
	assert.equal(result.code, 0, "Windows bootstrap startup control exited unsuccessfully");
	const frames = parseStartupControlFrames(result.stdout);
	assert.deepEqual(frames.map((frame) => frame.requestId), ["start-1", "shutdown-2"]);
	const [start, shutdown] = frames;
	assert.deepEqual(shutdown, { requestId: "shutdown-2", ok: true, result: { state: "partial" } });
	if (!start.ok && start.error === "unavailable") {
		const diagnostic = parseBootstrapDiagnostic(result.stderr);
		if (!diagnostic) assert.fail("Windows bootstrap startup diagnostic was missing or malformed");
		t.diagnostic(JSON.stringify(diagnostic));
		assert.fail("Windows bootstrap start unavailable");
	}
	assert.deepEqual(start, { requestId: "start-1", ok: true, result: { state: "partial" } });
	if (result.stderr !== "") assert.fail("Windows bootstrap startup control emitted unexpected diagnostics");
});

test("Windows-native bootstrap pins ancestors, creates exact private boundaries, and remains partial", { skip: process.platform !== "win32", timeout: 20_000 }, async (t) => {
	const diagnostics: BootstrapDiagnosticContext = t;
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-bootstrap-"));
	const agentHome = join(root, "profile", "agent");
	const routing = join(agentHome, "gentle-agents");
	const baseline = join(root, "ancestor.sd");
	const ancestorBaselines = [root, join(root, "profile"), agentHome, routing].map((path, index) => ({ path, baseline: join(root, `ancestor-${index}.sd`) }));
	await mkdir(routing, { recursive: true });
	for (const candidate of ancestorBaselines) assert.equal((await fixtureResult("capture", candidate.path, ["-BaselinePath", candidate.baseline])).equal, true);
	assert.equal((await fixtureResult("capture", routing, ["-BaselinePath", baseline])).equal, true);
	const frames = await helper(agentHome, false, { diagnostics });
	assert.deepEqual(frames.map((frame) => frame.ok ? frame.result : frame.error), [{ state: "partial" }, { state: "initialized", bootstrap: "complete" }, { state: "partial" }]);
	assert.equal((await fixtureResult("equals", routing, ["-BaselinePath", baseline])).equal, true);
	for (const candidate of ancestorBaselines) assert.equal((await fixtureResult("equals", candidate.path, ["-BaselinePath", candidate.baseline])).equal, true);
	assert.deepEqual(await fixtureResult("measure", join(routing, "transport")), { ok: true, directory: true, reparse: false, ownerCurrent: true, privateBoundary: true });
	assert.deepEqual(await fixtureResult("measure", join(routing, "transport", "presence")), { ok: true, directory: true, reparse: false, ownerCurrent: true, privateBoundary: true });
	await mkdir(join(routing, "transport", "presence", "seed-a"));
	await mkdir(join(routing, "transport", "presence", "seed-b"));
	assert.deepEqual((await helper(agentHome, true, { diagnostics }))[2].result, { state: "initialized", bootstrap: "complete", entries: 2 });
});

test("Windows-native presence publishes, resolves, lists, and removes only its own record", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
	const diagnostics: BootstrapDiagnosticContext = t;
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-presence-"));
	const agentHome = join(root, "profile", "agent");
	await mkdir(join(agentHome, "gentle-agents"), { recursive: true });
	const held = await openInitializedHelper(agentHome, { diagnostics });
	try {
		const recorded = await held.presence("record", { sessionId: "session-a", createdAt: 1 });
		assert.equal(recorded.ok, true);
		const record = recorded.result as Record<string, unknown>;
		assert.deepEqual(Object.keys(record).sort(), ["createdAt", "endpoint", "sessionId", "version"]);
		assert.equal(record.sessionId, "session-a");
		assert.match(record.endpoint as string, /^\\\\\.\\pipe\\gentle-pi-[0-9a-f]{32}$/);
		assert.equal((await held.presence("publish", { record })).ok, true);
		assert.equal((await held.presence("publish", { record })).error, "busy", "no-replace collision preserves the published record");
		assert.deepEqual(requirePublicPresenceResult(await held.presence("list")), { records: [record] }, "an omitted excludeSessionId lists one record");
		const secondReply = await held.presence("record", { sessionId: "session-b", createdAt: 2 });
		assert.equal(secondReply.ok, true);
		const secondRecord = secondReply.result as Record<string, unknown>;
		assert.equal((await held.presence("publish", { record: secondRecord })).ok, true);
		assert.deepEqual(requirePublicPresenceResult(await held.presence("list")), { records: [record, secondRecord] }, "an omitted excludeSessionId lists multiple records");
		assert.deepEqual(requirePublicPresenceResult(await held.presence("list", { excludeSessionId: "session-b" })), { records: [record] }, "a valid excludeSessionId is honored");
		assert.equal((await held.presence("list", { excludeSessionId: "" })).error, "invalid", "an explicit malformed excludeSessionId is rejected");
		assert.equal((await held.presence("remove", { record: secondRecord })).ok, true);
		assert.deepEqual((await held.presence("resolve", { sessionId: "session-a" })).result, record);
		const token = (record.endpoint as string).slice("\\\\.\\pipe\\gentle-pi-".length);
		const publishedPath = join(agentHome, "gentle-agents", "transport", "presence", `session-a.${token}.json`);
		assert.deepEqual(await fixtureResult("replace-identical", publishedPath), { ok: true, replaced: true });
		assert.deepEqual(requirePublicPresenceResult(await held.presence("list")), { records: [record] }, "the replacement retains the public record and accepted ACL");
		assert.equal((await held.presence("remove", { record })).error, "unsafe", "a replacement with identical public bytes and ACL is not owned");
		await stat(publishedPath);
	} finally { await held.closeInput(); }
});

test("Windows-native owned publication removes its unchanged rooted record", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
	const diagnostics: BootstrapDiagnosticContext = t;
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-presence-"));
	const agentHome = join(root, "profile", "agent");
	await mkdir(join(agentHome, "gentle-agents"), { recursive: true });
	const held = await openInitializedHelper(agentHome, { diagnostics });
	try {
		const recorded = await held.presence("record", { sessionId: "session-remove", createdAt: 1 });
		assert.equal(recorded.ok, true);
		const record = recorded.result as Record<string, unknown>;
		assert.equal((await held.presence("publish", { record })).ok, true);
		assert.equal((await held.presence("remove", { record })).ok, true);
		assert.deepEqual(requirePublicPresenceResult(await held.presence("list")), { records: [] });
		assert.equal((await held.presence("resolve", { sessionId: "session-remove" })).error, "not_found");
	} finally { await held.closeInput(); }
});

test("Windows-native shutdown releases and cleans unchanged owned publications", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
	const diagnostics: BootstrapDiagnosticContext = t;
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-presence-"));
	const agentHome = join(root, "profile", "agent");
	await mkdir(join(agentHome, "gentle-agents"), { recursive: true });
	const held = await openInitializedHelper(agentHome, { diagnostics });
	let publishedPath = "";
	try {
		const recorded = await held.presence("record", { sessionId: "session-shutdown", createdAt: 1 });
		assert.equal(recorded.ok, true);
		const record = recorded.result as Record<string, unknown>;
		assert.equal((await held.presence("publish", { record })).ok, true);
		const token = (record.endpoint as string).slice("\\\\.\\pipe\\gentle-pi-".length);
		publishedPath = join(agentHome, "gentle-agents", "transport", "presence", `session-shutdown.${token}.json`);
	} finally { await held.closeInput(); }
	await assert.rejects(stat(publishedPath));
});

test("Windows-native invalid owned ACL removal preserves the record and releases ownership before shutdown", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
	const diagnostics: BootstrapDiagnosticContext = t;
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-presence-"));
	const agentHome = join(root, "profile", "agent");
	await mkdir(join(agentHome, "gentle-agents"), { recursive: true });
	const held = await openInitializedHelper(agentHome, { diagnostics });
	try {
		const recorded = await held.presence("record", { sessionId: "session-invalid-acl", createdAt: 1 });
		assert.equal(recorded.ok, true);
		const record = recorded.result as Record<string, unknown>;
		assert.equal((await held.presence("publish", { record })).ok, true);
		const token = (record.endpoint as string).slice("\\\\.\\pipe\\gentle-pi-".length);
		const publishedPath = join(agentHome, "gentle-agents", "transport", "presence", `session-invalid-acl.${token}.json`);
		assert.deepEqual(await fixtureResult("add-extra-ace", publishedPath), { ok: true, changed: true });
		assert.equal((await held.presence("remove", { record })).error, "unsafe");
		await stat(publishedPath);
		assert.deepEqual(await fixtureResult("exclusive-open", publishedPath), { ok: true, exclusive: true }, "owned retained handle was released before shutdown");
	} finally { await held.closeInput(); }
});

test("Windows-native presence rejects hardlinks, corrupted ACLs, and oversized records", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
	const diagnostics: BootstrapDiagnosticContext = t;
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-presence-"));
	const agentHome = join(root, "profile", "agent");
	await mkdir(join(agentHome, "gentle-agents"), { recursive: true });
	const held = await openInitializedHelper(agentHome, { diagnostics });
	try {
		const presence = join(agentHome, "gentle-agents", "transport", "presence");
		assert.deepEqual(await fixtureResult("junction", join(presence, "reparse.0123456789abcdef0123456789abcdef.json"), ["-Target", root]), { ok: true, reparse: true });
		assert.deepEqual(requirePublicPresenceResult(await held.presence("list")), { records: [] }, "a reparse record is ignored");
		for (const [sessionId, mutation] of [["hardlink", "hardlink"], ["bad-acl", "add-extra-ace"], ["oversize", "append"]] as const) {
			const recorded = await held.presence("record", { sessionId, createdAt: 1 });
			assert.equal(recorded.ok, true);
			const record = recorded.result as Record<string, unknown>;
			assert.equal((await held.presence("publish", { record })).ok, true);
			const token = (record.endpoint as string).slice("\\\\.\\pipe\\gentle-pi-".length);
			const publishedPath = join(agentHome, "gentle-agents", "transport", "presence", `${sessionId}.${token}.json`);
			if (mutation === "hardlink") await fixtureResult("hardlink", publishedPath, ["-Target", join(dirname(publishedPath), `other.${token}.json`)]);
			else await fixtureResult(mutation, publishedPath);
			assert.deepEqual(requirePublicPresenceResult(await held.presence("list")), { records: [] });
			assert.equal((await held.presence("resolve", { sessionId })).error, "not_found");
		}
	} finally { await held.closeInput(); }
});

test("Windows-native bootstrap rejects a corrupted private boundary and preserves a failed bootstrap without recursive cleanup", { skip: process.platform !== "win32", timeout: 20_000 }, async (t) => {
	const emitted: string[] = [];
	const diagnostics: BootstrapDiagnosticContext = { diagnostic: (message) => { emitted.push(message); t.diagnostic(message); } };
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-bootstrap-"));
	const agentHome = join(root, "profile", "agent");
	const routing = join(agentHome, "gentle-agents");
	const badBoundary = join(routing, "transport");
	const badBaseline = join(root, "bad-boundary.sd");
	await mkdir(badBoundary, { recursive: true });
	await fixtureResult("add-extra-ace", badBoundary);
	assert.equal((await fixtureResult("capture", badBoundary, ["-BaselinePath", badBaseline])).equal, true);
	const frames = await helper(agentHome, false, { diagnostics });
	assert.equal(frames[1].ok, false);
	assert.equal(frames[1].error, "unsafe");
	assert.deepEqual(emitted, ['{"kind":"windows-session-bootstrap-rejection","stage":"transport-assert-owned","ntstatus":null}']);
	await stat(badBoundary);
	assert.equal((await fixtureResult("equals", badBoundary, ["-BaselinePath", badBaseline])).equal, true);
	await assert.rejects(stat(join(badBoundary, "presence")));
});

test("Windows-native bootstrap releases handles on shutdown before its stdin closes", { skip: process.platform !== "win32", timeout: 20_000 }, async (t) => {
	const diagnostics: BootstrapDiagnosticContext = t;
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-bootstrap-"));
	const agentHome = join(root, "profile", "agent");
	const routing = join(agentHome, "gentle-agents");
	await mkdir(routing, { recursive: true });
	const held = await openInitializedHelper(agentHome, { diagnostics });
	try {
		assert.deepEqual(held.frames[1].result, { state: "initialized", bootstrap: "complete" });
		await held.shutdown();
		assert.equal(held.exited, false);
		assert.deepEqual(await fixtureResult("rename", routing, ["-Target", join(root, "routing-after-shutdown")]), { ok: true, renamed: true });
	} finally { await held.closeInput(); }
});

test("Windows-native bootstrap exits on an invalid recognized schema while stdin remains open", { skip: process.platform !== "win32", timeout: 20_000 }, async (t) => {
	const diagnostics: BootstrapDiagnosticContext = t;
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-bootstrap-"));
	const agentHome = join(root, "profile", "agent");
	const routing = join(agentHome, "gentle-agents");
	await mkdir(routing, { recursive: true });
	const held = await openInitializedHelper(agentHome, { diagnostics });
	try {
		await held.invalidStartSchema();
		assert.equal(held.exited, true);
		assert.equal(held.frames[2].error, "invalid");
		assert.deepEqual(await fixtureResult("rename", routing, ["-Target", join(root, "routing-after-invalid")]), { ok: true, renamed: true });
	} finally { await held.closeInput(); }
});

test("Windows-native failed bootstrap releases its handles before stdin closes", { skip: process.platform !== "win32", timeout: 20_000 }, async (t) => {
	const diagnostics: BootstrapDiagnosticContext = t;
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-bootstrap-"));
	const agentHome = join(root, "profile", "agent");
	const routing = join(agentHome, "gentle-agents");
	await mkdir(join(routing, "transport"), { recursive: true });
	await fixtureResult("add-extra-ace", join(routing, "transport"));
	const held = await openInitializedHelper(agentHome, { diagnostics });
	try {
		assert.equal(held.frames[1].error, "unsafe");
		assert.deepEqual(held.rejectionDiagnostic, { kind: "windows-session-bootstrap-rejection", stage: "transport-assert-owned", ntstatus: null });
		assert.equal(held.exited, false);
		assert.deepEqual(await fixtureResult("rename", routing, ["-Target", join(root, "routing-after-failure")]), { ok: true, renamed: true });
	} finally { await held.closeInput(); }
});

test("Windows-native bootstrap closes pinned handles after malformed input", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-bootstrap-"));
	const agentHome = join(root, "profile", "agent");
	const routing = join(agentHome, "gentle-agents");
	await mkdir(routing, { recursive: true });
	const input = ['{"requestId":"start-1","operation":"start"}', JSON.stringify({ requestId: "initialize-2", operation: "initialize", agentHome }), "{"].join("\n") + "\n";
	const result = await runPowerShell(runtime, [], input);
	assert.equal(result.code, 0);
	const frame = parseHelperControlOutput(result.stdout, true, "Windows helper returned malformed protocol output")[1];
	assert.ok(frame.ok && frame.result !== undefined && "state" in frame.result);
	assert.equal(frame.result.state, "initialized");
	assert.deepEqual(await fixtureResult("rename", routing, ["-Target", join(root, "routing-released")]), { ok: true, renamed: true });
});

test("Windows-native bootstrap rejects a reparse routing parent and concurrent initialize does not hang", { skip: process.platform !== "win32", timeout: 20_000 }, async (t) => {
	const emitted: string[] = [];
	const diagnostics: BootstrapDiagnosticContext = { diagnostic: (message) => { emitted.push(message); t.diagnostic(message); } };
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-bootstrap-"));
	const agentHome = join(root, "profile", "agent");
	const routing = join(agentHome, "gentle-agents");
	const target = join(root, "routing-target");
	await mkdir(join(agentHome), { recursive: true });
	await mkdir(target);
	await fixtureResult("junction", routing, ["-Target", target]);
	assert.equal((await helper(agentHome, false, { diagnostics }))[1].error, "unsafe");
	assert.equal(emitted.length, 1);
	const rejection = JSON.parse(emitted[0]) as BootstrapRejectionDiagnostic;
	assert.equal(rejection.kind, "windows-session-bootstrap-rejection");
	assert.equal(rejection.stage, "routing-open");
	assert.ok(rejection.ntstatus === 0xC000050B || rejection.ntstatus === null);
	const concurrentRoot = await mkdtemp(join(os.tmpdir(), "gentle-pi-bootstrap-"));
	const concurrentHome = join(concurrentRoot, "profile", "agent");
	await mkdir(join(concurrentHome, "gentle-agents"), { recursive: true });
	await withInitializedHelpers([concurrentHome, concurrentHome], async (helpers) => {
		const results = await Promise.all(helpers.map((candidate) => candidate.enumerate()));
		for (const frame of results) assert.deepEqual(frame.result, { state: "initialized", bootstrap: "complete", entries: 0 });
		await Promise.all(helpers.map((candidate) => candidate.shutdown()));
	}, { diagnostics });
});

async function withWindowsNativeListener<T>(callback: (notification: Readonly<{ id: string; senderSessionId: string; message: string }>) => Promise<void>, action: (value: Readonly<{ listener: WindowsActiveSessionListener; client: WindowsActiveSessionClient; agentHome: string }>) => Promise<T>, createRegistry: (home: string) => Promise<WindowsSessionPresenceRegistry> = (home) => WindowsSessionPresenceRegistry.create(home)): Promise<T> {
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-listener-"));
	const agentHome = join(root, "profile", "agent");
	await mkdir(join(agentHome, "gentle-agents"), { recursive: true });
	let listenerRegistry: WindowsSessionPresenceRegistry | undefined;
	let clientRegistry: WindowsSessionPresenceRegistry | undefined;
	let listener: WindowsActiveSessionListener | undefined;
	let client: WindowsActiveSessionClient | undefined;
	let listenerClosed = false;
	try {
		listenerRegistry = await createRegistry(agentHome);
		clientRegistry = await createRegistry(agentHome);
		listener = new WindowsActiveSessionListener(listenerRegistry, "recipient", callback);
		client = new WindowsActiveSessionClient(clientRegistry, "sender");
		await listener.start();
		return await action({ listener, client, agentHome });
	} finally {
		client?.close();
		if (listener) { await listener.close().then(() => { listenerClosed = true; }, () => {}); }
		if (listenerRegistry && !listenerClosed) await listenerRegistry.close().catch(() => {});
		if (clientRegistry) await clientRegistry.close().catch(() => {});
	}
}

function waitWindowsNativeSignal(signal: Promise<void>, message: string) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), 2_500);
		void signal.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); reject(new Error(message)); });
	});
}

test("Windows native listener setup closes the first acquired registry when the second acquisition rejects", async () => {
	let closes = 0;
	const first = { close: async () => { closes++; } } as unknown as WindowsSessionPresenceRegistry;
	let calls = 0;
	await assert.rejects(withWindowsNativeListener(async () => {}, async () => assert.fail("action must not run"), async () => {
		if (++calls === 1) return first;
		throw new Error("second registry failed");
	}), /second registry failed/);
	assert.equal(closes, 1);
});

test("Windows default transport creates a registry without an observer", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-observer-"));
	const agentHome = join(root, "profile", "agent");
	await mkdir(join(agentHome, "gentle-agents"), { recursive: true });
	const registry = await createDefaultSessionTransport("win32").createRegistry(agentHome);
	try {
		assert.deepEqual(await registry.listActivations(), []);
	} finally {
		await registry.close();
	}
});

test("Windows default transport emits fixed ordered phase events for its own registry", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-observer-"));
	const agentHome = join(root, "profile", "agent");
	await mkdir(join(agentHome, "gentle-agents"), { recursive: true });
	const events: WindowsSessionRegistryPhaseEvent[] = [];
	const sequence = new WindowsSessionRegistryPhaseSequence();
	const registry = await createDefaultSessionTransport("win32").createRegistry(agentHome, (event) => {
		events.push(event);
		return sequence.observe(event);
	});
	try {
		assert.deepEqual(events, [
			{ phase: "start", status: "succeeded", error: null, lastStartupMarker: "native-ready" },
			{ phase: "initialize", status: "succeeded", error: null, lastStartupMarker: "native-ready" },
		]);
		for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["error", "lastStartupMarker", "phase", "status"], "events expose only fixed startup progress");
	} finally {
		await registry.close();
	}
	assert.deepEqual(events, [
		{ phase: "start", status: "succeeded", error: null, lastStartupMarker: "native-ready" },
		{ phase: "initialize", status: "succeeded", error: null, lastStartupMarker: "native-ready" },
		{ phase: "cleanup", status: "succeeded", error: null, lastStartupMarker: "native-ready" },
	]);
	assert.equal(sequence.admitsFullSuccess, true, "the seam callback retains the reducer receiver through its wrapper");
});

test("Windows default transport rejects asynchronous observer setup without awaiting it", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-observer-"));
	const agentHome = join(root, "profile", "agent");
	await mkdir(join(agentHome, "gentle-agents"), { recursive: true });
	await assert.rejects(createDefaultSessionTransport("win32").createRegistry(agentHome, () => Promise.reject(new Error("observer rejected")) as never));
	await new Promise<void>((resolve) => setImmediate(resolve));
	const recovered = await createDefaultSessionTransport("win32").createRegistry(agentHome);
	await recovered.close();
});

const successfulPhase = (phase: WindowsSessionRegistryPhaseEvent["phase"], lastStartupMarker: StartupMarker | null = null): WindowsSessionRegistryPhaseEvent => Object.freeze({ phase, status: "succeeded", error: null, lastStartupMarker });
const failedPhase = (phase: WindowsSessionRegistryPhaseEvent["phase"], error: NonNullable<WindowsSessionRegistryPhaseEvent["error"]> = Object.freeze({ class: "rejected", code: "unknown" }), lastStartupMarker: StartupMarker | null = null): WindowsSessionRegistryPhaseEvent => Object.freeze({ phase, status: "failed", error, lastStartupMarker });

test("Windows phase sequence preserves failed start with successful cleanup", () => {
	const sequence = new WindowsSessionRegistryPhaseSequence();
	sequence.observe(failedPhase("start"));
	sequence.observe(successfulPhase("cleanup"));
	assert.equal(sequence.operationSucceeded, false);
	assert.equal(sequence.terminalSequenceValid, true);
	assert.equal(sequence.cleanupComplete, true);
	assert.equal(sequence.admitsFullSuccess, false);
	assert.deepEqual(sequence.snapshot(), { availability: "observed", provenance: "owned-instance", restoration: "not-required", startCalls: 1, initializeCalls: 0, cleanupCalls: 1, firstFailurePhase: "start", firstFailureClass: "rejected", firstFailureCode: "unknown", lastStartupMarker: null });
});

test("Windows phase sequence preserves failed initialize with successful cleanup", () => {
	const sequence = new WindowsSessionRegistryPhaseSequence();
	sequence.observe(successfulPhase("start"));
	sequence.observe(failedPhase("initialize"));
	sequence.observe(successfulPhase("cleanup"));
	assert.equal(sequence.operationSucceeded, false);
	assert.equal(sequence.terminalSequenceValid, true);
	assert.equal(sequence.cleanupComplete, true);
	assert.equal(sequence.admitsFullSuccess, false);
	assert.deepEqual(sequence.snapshot(), { availability: "observed", provenance: "owned-instance", restoration: "not-required", startCalls: 1, initializeCalls: 1, cleanupCalls: 1, firstFailurePhase: "initialize", firstFailureClass: "rejected", firstFailureCode: "unknown", lastStartupMarker: null });
});

test("Windows phase sequence admits only complete successful operations", () => {
	const sequence = new WindowsSessionRegistryPhaseSequence();
	sequence.observe(successfulPhase("start"));
	assert.equal(sequence.terminalSequenceValid, false);
	assert.equal(sequence.admitsFullSuccess, false);
	sequence.observe(successfulPhase("initialize"));
	sequence.observe(successfulPhase("cleanup"));
	assert.equal(sequence.operationSucceeded, true);
	assert.equal(sequence.terminalSequenceValid, true);
	assert.equal(sequence.cleanupComplete, true);
	assert.equal(sequence.admitsFullSuccess, true);
});

test("Windows phase sequence preserves an operation failure when cleanup fails", () => {
	const sequence = new WindowsSessionRegistryPhaseSequence();
	sequence.observe(failedPhase("start", Object.freeze({ class: "rejected", code: "spawn" })));
	sequence.observe(failedPhase("cleanup", Object.freeze({ class: "rejected", code: "unknown" })));
	assert.equal(sequence.terminalSequenceValid, true);
	assert.equal(sequence.cleanupComplete, false);
	assert.deepEqual(sequence.snapshot(), { availability: "observed", provenance: "owned-instance", restoration: "not-required", startCalls: 1, initializeCalls: 0, cleanupCalls: 1, firstFailurePhase: "start", firstFailureClass: "rejected", firstFailureCode: "spawn", lastStartupMarker: null });
});

test("Windows phase sequence preserves bounded rejection sites and the first operation failure", () => {
	for (const failure of [
		Object.freeze({ class: "timed-out" as const, code: "deadline" as const }),
		Object.freeze({ class: "rejected" as const, code: "write" as const }),
		Object.freeze({ class: "rejected" as const, code: "spawn" as const }),
		Object.freeze({ class: "rejected" as const, code: "protocol" as const }),
	]) {
		const sequence = new WindowsSessionRegistryPhaseSequence();
		sequence.observe(failedPhase("start", failure));
		sequence.observe(failedPhase("cleanup", Object.freeze({ class: "rejected", code: "unknown" })));
		assert.equal(sequence.snapshot().firstFailureCode, failure.code);
	}
});

test("Windows phase sequence retains a last observed startup marker through deadline and cleanup", () => {
	const sequence = new WindowsSessionRegistryPhaseSequence();
	sequence.observe(failedPhase("start", Object.freeze({ class: "timed-out", code: "deadline" }), "script-entered"));
	sequence.observe(successfulPhase("cleanup", "script-entered"));
	assert.equal(sequence.admitsFullSuccess, false, "a startup marker is not readiness");
	assert.deepEqual(sequence.snapshot(), { availability: "observed", provenance: "owned-instance", restoration: "not-required", startCalls: 1, initializeCalls: 0, cleanupCalls: 1, firstFailurePhase: "start", firstFailureClass: "timed-out", firstFailureCode: "deadline", lastStartupMarker: "script-entered" });
});

test("Windows phase sequence rejects duplicate, out-of-order, and invalid events permanently", () => {
	for (const events of [
		[successfulPhase("cleanup")],
		[successfulPhase("start"), successfulPhase("start")],
		[{ phase: "start", status: "failed", error: { class: "timed-out", code: "unknown" } }],
		[{ phase: "start", status: "failed", error: { class: "rejected", code: "deadline" } }],
		[{ phase: "start", status: "failed", error: { class: "rejected", code: "native-code" } }],
	] as const) {
		const sequence = new WindowsSessionRegistryPhaseSequence();
		for (const event of events) sequence.observe(event);
		sequence.observe(successfulPhase("cleanup"));
		assert.equal(sequence.terminalSequenceValid, false);
		assert.equal(sequence.cleanupComplete, false);
		assert.equal(sequence.admitsFullSuccess, false);
		assert.deepEqual(sequence.snapshot(), { availability: "unavailable", provenance: "ambiguous", restoration: "not-required", startCalls: null, initializeCalls: null, cleanupCalls: null, firstFailurePhase: null, firstFailureClass: null, firstFailureCode: null, lastStartupMarker: null });
	}
});

test("Windows registry source guard preserves operation failure through observer cleanup", async (t) => {
	t.diagnostic("source guard, not native Windows proof");
	const source = await readFile(fileURLToPath(new URL("../lib/windows-session-transport.ts", import.meta.url)), "utf8");
	assert.match(source, /catch \(error\) \{\s*try \{ await run\("cleanup", \(\) => host\.close\(\)\); \} catch \{[^}]*\}\s*registryError\(error\);/);
	assert.match(source, /export type WindowsSessionRegistryPhaseObserver = \(event: WindowsSessionRegistryPhaseEvent\) => undefined;/);
	assert.match(source, /transportError\("Windows transport host unavailable", "spawn"\)/);
	assert.match(source, /transportError\("Windows transport request timed out", "deadline"\)/);
	assert.match(source, /transportError\("Windows transport host exited", "write"\)/);
	assert.match(source, /lastStartupMarker: this\.readLastStartupMarker\(\)/);
	assert.match(source, /new WindowsSessionRegistryObserver\(observePhase, \(\) => host\.lastStartupMarker\)/);
	assert.match(source, /this\.abort\("Windows transport host unavailable", true, "protocol"\)/);
	assert.match(source, /if \(result === undefined\) return;\s*this\.active = false;\s*try \{ Promise\.resolve\(result\)\.catch\(\(\) => \{\}\);/);
	assert.doesNotMatch(source, /WindowsSessionTransportHostObserver|observeHost\?\.\(host\)|Object\.defineProperty\(candidate/);
});

test("packed lifecycle source uses the exported phase sequence", async (t) => {
	t.diagnostic("source guard, not packed lifecycle proof");
	const source = await readFile(fileURLToPath(new URL("../scripts/test-packed-runner.mjs", import.meta.url)), "utf8");
	assert.match(source, /const \{ WindowsSessionRegistryPhaseSequence \} = await within\(load\(jiti\.import/);
	assert.match(source, /const createWindowsRegistryObservation = \(PhaseSequence\) => \{\s*if \(process\.platform === "win32"\) return new PhaseSequence\(\);/);
	assert.match(source, /createWindowsRegistryObservation\(WindowsSessionRegistryPhaseSequence\)/);
	assert.match(source, /windowsRegistryObservation\.startupSucceeded/);
	assert.match(source, /windowsRegistryObservation\.cleanupComplete/);
	assert.match(source, /windowsRegistryObservation\.admitsFullSuccess/);
	assert.match(source, /lastStartupMarker: null/);
	assert.match(source, /windowsRegistryObservation\.lastStartupMarker === "native-ready"/);
	assert.match(source, /const SDK_LIFECYCLE_WINDOWS_BIND_DEADLINE_MS = 30_000 \+ 2_000 \+ 2_000 \+ 6_000;/);
	assert.match(source, /const SDK_LIFECYCLE_WINDOWS_REGISTRY_DEADLINE_MS = 30_000 \+ 2_000 \+ 2_000 \+ 2 \* 500 \+ 5_000;/);
	assert.match(source, /const SDK_LIFECYCLE_WINDOWS_LIST_DEADLINE_MS = 2_000;/);
	assert.match(source, /const SDK_LIFECYCLE_PROBE_TIMEOUT_MS = 4 \* 30_000 \+ 2 \* 30_000 \+ 2 \* 40_000 \+ 40_000 \+ 3 \* 2_000 \+ 2 \* 15_000 \+ 15_000 \+ 4_000 \+ 5_000;/);
	assert.match(source, /bindExtensions\(\{ mode: "json", onError: recordExtensionError \}\), SDK_LIFECYCLE_WINDOWS_BIND_DEADLINE_MS/);
	assert.match(source, /createRegistry\(agentHome, \(event\) => windowsRegistryObservation\.observe\(event\)\), SDK_LIFECYCLE_WINDOWS_REGISTRY_DEADLINE_MS/);
	assert.match(source, /within\(observer\.listActivations\(\), SDK_LIFECYCLE_WINDOWS_LIST_DEADLINE_MS\)/);
	assert.match(source, /setTimeout\(\(\) => requestStop\(new SdkLifecycleFailure\("lifecycle-probe", "timed-out"\)\), SDK_LIFECYCLE_PROBE_TIMEOUT_MS\)/);
	assert.doesNotMatch(source, /createRegistry\(agentHome,[\s\S]{0,160}(?:startupDeadlineMs|rpcDeadlineMs)/);
	assert.doesNotMatch(source, /Object\.defineProperty\(candidate|Host\.prototype|windowsRegistryObservation\.restore|let expected = "start"/);
});

function openWindowsNativePipe(endpoint: string) {
	return new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
		const socket = createConnection(endpoint);
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("Windows native pipe did not connect")); }, 2_000);
		socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
		socket.once("error", () => { clearTimeout(timer); reject(new Error("Windows native pipe did not connect")); });
	});
}

function readWindowsNativeAck(socket: ReturnType<typeof createConnection>, expectedId: string) {
	return new Promise<AckFrame>((resolve, reject) => {
		const decoder = new FrameDecoder();
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("Windows native ACK did not arrive")); }, 2_500);
		const finish = (error?: Error, ack?: AckFrame) => { clearTimeout(timer); socket.removeAllListeners("data"); socket.removeAllListeners("end"); socket.removeAllListeners("error"); error ? reject(error) : resolve(ack!); };
		socket.on("data", (chunk: Buffer) => { try { decoder.push(chunk); } catch { finish(new Error("Windows native ACK was invalid")); } });
		socket.once("end", () => { try { const frame = decoder.finish(); if (frame.kind !== "ack" || frame.id !== expectedId) throw new Error(); finish(undefined, frame); } catch { finish(new Error("Windows native ACK was invalid")); } });
		socket.once("error", () => finish(new Error("Windows native ACK failed")));
	});
}

function probeWindowsNativeEndpoint(endpoint: string) {
	return new Promise<string>((resolve, reject) => {
		const socket = createConnection(endpoint);
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("Windows native endpoint release timed out")); }, 1_000);
		socket.once("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error("Windows native endpoint remained connectable")); });
		socket.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); resolve(error.code ?? "unknown"); });
	});
}

test("Windows-native listener accepts legacy listen then rejects stale epochs and accepts a newer epoch", { skip: process.platform !== "win32", timeout: 30_000 }, async (t) => {
	const root = await mkdtemp(join(os.tmpdir(), "gentle-pi-listen-compat-"));
	const agentHome = join(root, "profile", "agent");
	await mkdir(join(agentHome, "gentle-agents"), { recursive: true });
	const held = await openInitializedHelper(agentHome, { diagnostics: t });
	try {
		const legacy = await held.presence("listen", { sessionId: "legacy", createdAt: 1 });
		assert.equal(legacy.ok, true, "the legacy four-field request remains accepted");
		const record = legacy.result as Record<string, unknown>;
		assert.equal((await held.presence("stop-listener", { record })).ok, true);
		assert.equal((await held.presence("listen", { sessionId: "invalid", createdAt: 2, generation: 1 })).error, "invalid");
		const newer = await held.presence("listen", { sessionId: "newer", createdAt: 3, generation: 2 });
		assert.equal(newer.ok, true, "a newer host epoch follows a legacy allocation");
	} finally { await held.closeInput(); }
});

test("Windows listener source guard publishes only from its Gate-protected readiness transition", async (t) => {
	t.diagnostic("source guard, not native Windows proof");
	const source = await readFile(runtime, "utf8");
	const listenStart = source.indexOf("public static PresenceRecord Listen(");
	const listenEnd = source.indexOf("public static void Acknowledge", listenStart);
	assert.ok(listenStart >= 0 && listenEnd > listenStart, "source guard: listener readiness transition was not found");
	const listen = source.slice(listenStart, listenEnd);
	assert.match(listen, /byte\[\] pipeDescriptor, byte\[\] presenceDescriptor, string sid/);
	const lockStart = listen.indexOf("lock (Gate)");
	const open = listen.indexOf("{", lockStart);
	assert.ok(lockStart >= 0 && open > lockStart, "source guard: listener readiness must acquire Gate");
	let depth = 0, close = -1;
	for (let index = open; index < listen.length; index++) { if (listen[index] === "{") depth++; else if (listen[index] === "}" && --depth === 0) { close = index; break; } }
	assert.ok(close > open, "source guard: listener readiness Gate region was not balanced");
	const guarded = listen.slice(open + 1, close);
	assert.match(guarded, /ArmAccept\(listener\)[\s\S]*?listener\.Publication = PublishOwned\(record\.SessionId, record\.Endpoint, record\.CreatedAt, presenceDescriptor, sid\)[\s\S]*?return record/);
	assert.match(guarded, /catch \{ FailListener\(listener\); throw; \}/);
	const cleanupStart = source.indexOf("static void RemoveListenerPublication(");
	const cleanupEnd = source.indexOf("public static void RemoveOwn", cleanupStart);
	assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, "source guard: listener publication authority was not found");
	const cleanup = source.slice(cleanupStart, cleanupEnd);
	assert.match(cleanup, /OwnedPublication owned = listener\.Publication; listener\.Publication = null;/);
	assert.match(cleanup, /owned == null \|\| !OwnedPublications\.Contains\(owned\)/);
	assert.match(cleanup, /RemoveOwnedPublication\(owned\);/);
	const failureStart = source.indexOf("static void FailListener(");
	const failureEnd = source.indexOf("static void ClosePipe", failureStart);
	const failure = source.slice(failureStart, failureEnd);
	assert.match(failure, /RemoveListenerPublication\(listener\)/);
	assert.doesNotMatch(failure, /RemoveOwn\(/);
});

test("Windows listener failure source guard emits only a fixed post-cleanup generation event", async (t) => {
	t.diagnostic("source guard, not native Windows proof");
	const source = await readFile(runtime, "utf8");
	const reportStart = source.indexOf("static void ReportListenerFailure(");
	const reportEnd = source.indexOf("static void FailListener(", reportStart);
	assert.ok(reportStart >= 0 && reportEnd > reportStart, "source guard: failure reporter was not found");
	const report = source.slice(reportStart, reportEnd);
	assert.match(report, /ThreadPool\.QueueUserWorkItem/);
	assert.match(report, /WriteControl\("\{\\"event\\":\\"listener-failed\\",\\"generation\\":" \+ generation\.ToString\(System\.Globalization\.CultureInfo\.InvariantCulture\) \+ ",\\"error\\":\\"unavailable\\"\}"\)/);
	assert.doesNotMatch(report, /lock\s*\(Gate\)/);
	const failureStart = reportEnd;
	const failureEnd = source.indexOf("static void ClosePipe", failureStart);
	assert.ok(failureEnd > failureStart, "source guard: failed-listener cleanup was not found");
	const failure = source.slice(failureStart, failureEnd);
	assert.match(failure, /RemoveListenerPublication\(listener\)[\s\S]*?foreach \(PipeClient client in listener\.Clients\.ToArray\(\)\) ClosePipe\(client\);[\s\S]*?ReportListenerFailure\(listener\.Generation\);/);
	const stopStart = source.indexOf("public static void StopListener(");
	const stopEnd = source.indexOf("public static void Initialize", stopStart);
	assert.ok(stopEnd > stopStart, "source guard: explicit listener stop was not found");
	assert.doesNotMatch(source.slice(stopStart, stopEnd), /ReportListenerFailure\(/);
});

test("Windows listener source guard retains owned pipe continuity across the last close", async (t) => {
	t.diagnostic("source guard, not native Windows proof");
	const source = await readFile(runtime, "utf8");
	assert.match(source, /public bool Closed, Writing, Accepting;/);
	const closeStart = source.indexOf("static void ClosePipe(");
	const closeEnd = source.indexOf("static void SendEvent", closeStart);
	assert.ok(closeStart >= 0 && closeEnd > closeStart, "source guard: pipe close transition was not found");
	const close = source.slice(closeStart, closeEnd);
	assert.match(close, /listener\.Clients\.Count == 1[\s\S]*?ArmAccept\(listener, client\)[\s\S]*?client\.Pipe\.Dispose/);
	assert.match(close, /!ArmAccept\(listener, null\)\) FailListener\(listener\);/);
	const armStart = source.indexOf("static bool ArmAccept(");
	const armEnd = source.indexOf("static void AcceptPipe", armStart);
	assert.ok(armStart >= 0 && armEnd > armStart, "source guard: accept ownership transition was not found");
	const arm = source.slice(armStart, armEnd);
	assert.match(arm, /candidate != retiring && !candidate\.Closed && candidate\.Accepting/);
	assert.match(arm, /client\.Accepting = true;[\s\S]*?client\.Pipe\.BeginWaitForConnection/);
	const failureStart = source.indexOf("static void FailListener(");
	const failureEnd = source.indexOf("static void ClosePipe", failureStart);
	assert.ok(failureStart >= 0 && failureEnd > failureStart, "source guard: failed-listener cleanup was not found");
	const failure = source.slice(failureStart, failureEnd);
	assert.match(failure, /listener\.Stopped = true;[\s\S]*?RemoveListenerPublication\(listener\)[\s\S]*?ClosePipe/);
	const stopStart = source.indexOf("public static void StopListener(");
	const stopEnd = source.indexOf("public static void Initialize", stopStart);
	assert.ok(stopStart >= 0 && stopEnd > stopStart, "source guard: explicit listener stop was not found");
	const stop = source.slice(stopStart, stopEnd);
	assert.match(stop, /listener\.Stopped = true; try \{ RemoveListenerPublication\(listener\); \} finally \{ foreach \(PipeClient client in listener\.Clients\.ToArray\(\)\) ClosePipe/);
});

test("Windows listener ACK watchdog source guard releases Gate before asynchronous write", async (t) => {
	t.diagnostic("source guard, not native Windows proof");
	const source = await readFile(runtime, "utf8");
	const prepareStart = source.indexOf("static bool PrepareAckLocked(");
	const prepareEnd = source.indexOf("static void BeginAck(", prepareStart);
	assert.ok(prepareStart >= 0 && prepareEnd > prepareStart, "source guard: ACK state transition must be separated from I/O");
	const prepare = source.slice(prepareStart, prepareEnd);
	assert.match(prepare, /client\.Writing = true;/);
	assert.match(prepare, /client\.Timer\.Change\(PipeDeadlineMilliseconds, Timeout\.Infinite\)/);
	const beginStart = prepareEnd;
	const beginEnd = source.indexOf("static void OnPipeTimeout", beginStart);
	assert.ok(beginEnd > beginStart, "source guard: asynchronous ACK dispatch was not found");
	const begin = source.slice(beginStart, beginEnd);
	assert.match(begin, /client\.Pipe\.BeginWrite/);
	assert.doesNotMatch(begin, /lock\s*\(Gate\)[\s\S]*?BeginWrite/);
	const acknowledgeStart = source.indexOf("public static void Acknowledge(");
	const acknowledgeEnd = source.indexOf("public static void StopListener", acknowledgeStart);
	assert.ok(acknowledgeStart >= 0 && acknowledgeEnd > acknowledgeStart, "source guard: acknowledgement entry point was not found");
	const acknowledge = source.slice(acknowledgeStart, acknowledgeEnd);
	assert.match(acknowledge, /PrepareAckLocked\(selected, out ackId\)[\s\S]*?\}\s*BeginAck\(selected, ackId/);
	const timeoutStart = source.indexOf("static void OnPipeTimeout(");
	const timeoutEnd = source.indexOf("public static PresenceRecord Listen", timeoutStart);
	assert.ok(timeoutStart >= 0 && timeoutEnd > timeoutStart, "source guard: ACK watchdog callback was not found");
	const timeout = source.slice(timeoutStart, timeoutEnd);
	assert.match(timeout, /if \(String\.IsNullOrEmpty\(timed\.Id\) \|\| timed\.Writing\) \{ ClosePipe\(timed\); return; \}/);
});

test("Windows-native listener readiness registers callback before publication and ACKs only accepted semantic delivery", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
	let release!: () => void;
	const callbackGate = new Promise<void>((resolve) => { release = resolve; });
	let callbackSeen!: () => void;
	const seen = new Promise<void>((resolve) => { callbackSeen = resolve; });
	await withWindowsNativeListener(async (notification) => {
		assert.deepEqual(notification, { id: "ready-1", senderSessionId: "sender", message: "hello" });
		callbackSeen();
		await callbackGate;
	}, async ({ listener, client }) => {
		assert.equal(listener.status, "active");
		const sent = client.sendNotification("recipient", "hello", { id: "ready-1" });
		void sent.catch(() => {});
		await waitWindowsNativeSignal(seen, "Windows native callback did not begin");
		let settled = false;
		void sent.then(() => { settled = true; }, () => { settled = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(settled, false, "ACK must wait for semantic callback acceptance");
		release();
		assert.deepEqual(await sent, { id: "ready-1", accepted: true });
	});
});

test("Windows-native listener returns a rejected ACK when semantic delivery rejects", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
	await withWindowsNativeListener(async () => { throw new Error("rejected"); }, async ({ client }) => {
		await assert.rejects(client.sendNotification("recipient", "hello", { id: "reject-1" }), (error: unknown) => error instanceof ActiveSessionClientError && error.code === "remote_rejected");
	});
});

test("Windows-native listener isolates one held partial pipe while a parallel complete client succeeds", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
	await withWindowsNativeListener(async () => {}, async ({ listener, client }) => {
		let partial: ReturnType<typeof createConnection> | undefined;
		try {
			partial = await openWindowsNativePipe(listener.record!.endpoint);
			partial.write(Buffer.from('{"version":1,"kind":"notification","id":"partial-1"', "utf8"));
			assert.deepEqual(await client.sendNotification("recipient", "parallel", { id: "parallel-1" }), { id: "parallel-1", accepted: true });
		} finally { partial?.destroy(); }
	});
});

test("Windows-native malformed wire is isolated to its connection and does not stop the helper listener", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
	await withWindowsNativeListener(async () => {}, async ({ listener, client }) => {
		let malformed: ReturnType<typeof createConnection> | undefined;
		try {
			malformed = await openWindowsNativePipe(listener.record!.endpoint);
			malformed.write(Buffer.from('{"version":1,"kind":"notification","id":"malformed-1","senderSessionId":"sender"}\n', "utf8"));
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			assert.deepEqual(await client.sendNotification("recipient", "still-live", { id: "after-malformed-1" }), { id: "after-malformed-1", accepted: true });
		} finally { malformed?.destroy(); }
	});
});

test("Windows-native stop closes active delivery, removes publication, and releases the endpoint", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
	let callbackSeen!: () => void;
	const seen = new Promise<void>((resolve) => { callbackSeen = resolve; });
	await withWindowsNativeListener(async () => {
		callbackSeen();
		await new Promise<void>(() => {});
	}, async ({ listener, client, agentHome }) => {
		const record = listener.record!;
		const token = record.endpoint.slice("\\\\.\\pipe\\gentle-pi-".length);
		const publication = join(agentHome, "gentle-agents", "transport", "presence", `recipient.${token}.json`);
		const pending = client.sendNotification("recipient", "hold", { id: "stop-1" });
		void pending.catch(() => {});
		await waitWindowsNativeSignal(seen, "Windows native stop callback did not begin");
		await listener.close();
		await assert.rejects(pending);
		await assert.rejects(stat(publication));
		assert.equal(listener.status, "closed");
	});
});

test("Windows-native listener restores full partial-frame accept capacity after deadline closure", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
	let callbacks = 0;
	await withWindowsNativeListener(async () => { callbacks++; }, async ({ listener, client }) => {
		const partials: ReturnType<typeof createConnection>[] = [];
		try {
			for (let index = 0; index < 4; index++) {
				const socket = await openWindowsNativePipe(listener.record!.endpoint);
				partials.push(socket);
				socket.write(Buffer.from(`{"version":1,"kind":"notification","id":"capacity-${index}"`, "utf8"));
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 2_250));
			assert.deepEqual(await client.sendNotification("recipient", "after-capacity", { id: "after-capacity-1" }), { id: "after-capacity-1", accepted: true });
			assert.equal(callbacks, 1);
		} finally { for (const socket of partials) socket.destroy(); }
	});
});

test("Windows-native listener returns the exact rejected ACK after its semantic callback executes", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
	let callbacks = 0;
	await withWindowsNativeListener(async () => { callbacks++; throw new Error("rejected"); }, async ({ listener }) => {
		const socket = await openWindowsNativePipe(listener.record!.endpoint);
		try {
			const id = "raw-reject-1";
			const ack = readWindowsNativeAck(socket, id);
			socket.write(encodeNotificationFrame({ version: 1, kind: "notification", id, senderSessionId: "sender", recipientSessionId: "recipient", message: "reject" }));
			const frame = await ack;
			assert.equal(callbacks, 1);
			assert.deepEqual(frame, { version: 1, kind: "ack", id, accepted: false, error: "rejected" });
		} finally { socket.destroy(); }
	});
});

test("Windows-native stop removes publication, settles delivery, and releases its returned endpoint", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
	let callbackSeen!: () => void;
	const seen = new Promise<void>((resolve) => { callbackSeen = resolve; });
	await withWindowsNativeListener(async () => { callbackSeen(); await new Promise<void>(() => {}); }, async ({ listener, client, agentHome }) => {
		const record = listener.record!;
		const token = record.endpoint.slice("\\\\.\\pipe\\gentle-pi-".length);
		const publication = join(agentHome, "gentle-agents", "transport", "presence", `recipient.${token}.json`);
		const pending = client.sendNotification("recipient", "stop", { id: "stop-probe-1" });
		void pending.catch(() => {});
		await waitWindowsNativeSignal(seen, "Windows native endpoint stop callback did not begin");
		await listener.close();
		await assert.rejects(pending);
		await assert.rejects(stat(publication));
		assert.ok(["ENOENT", "ECONNREFUSED"].includes(await probeWindowsNativeEndpoint(record.endpoint)));
	});
});
