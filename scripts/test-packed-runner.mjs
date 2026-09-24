#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const MAX_NPM_OUTPUT_BYTES = 1024 * 1024;
const MAX_UNHOOKED_REPORT_BYTES = 1024;
const MAX_SDK_LIFECYCLE_CHILD_REPORT_BYTES = 2048;
// Four sequential 30s imports precede the existing 240s lifecycle allowance: two
// 30s session factories, two 40s binds, one 40s registry, three 2s lists, two 15s
// runtime disposals, a 15s observer close, and 9s receipt/scheduling. This finite
// 360s watchdog bounds reporting, not blocked SDK cancellation.
const SDK_LIFECYCLE_PROBE_TIMEOUT_MS = 4 * 30_000 + 2 * 30_000 + 2 * 40_000 + 40_000 + 3 * 2_000 + 2 * 15_000 + 15_000 + 4_000 + 5_000;
const MAX_WINDOWS_STARTUP_TIMING_REPORT_BYTES = 1024;
const MAX_WINDOWS_STARTUP_TIMING_ENVIRONMENT_REPORT_BYTES = 2048;
const MAX_WINDOWS_STARTUP_TIMING_OUTPUT_BYTES = 32 * 1024;
const WINDOWS_STARTUP_TIMING_BUDGET_MS = 25_000;
const WINDOWS_STARTUP_TIMING_CLEANUP_GRACE_MS = 5_000;
const WINDOWS_STARTUP_TIMING_FORCE_CLOSE_GRACE_MS = 2_500;
const WINDOWS_STARTUP_TIMING_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_STARTUP_TIMING_START_REQUEST = '{"requestId":"start-1","operation":"start"}\n';
const WINDOWS_STARTUP_TIMING_ENVIRONMENT_CASE_NAMES = Object.freeze(["baseline", "windows-paths"]);
const WINDOWS_STARTUP_TIMING_ENVIRONMENT_RECEIPT_FLAGS = Object.freeze({
	caseOrder: "baseline-first-fixed",
	sharedState: "shared-owned-home-and-cache",
	confounders: "baseline-first-order-and-cache-effects",
	conclusion: "no-causal-attribution-not-product-ready",
});
export const WINDOWS_STARTUP_TIMING_WINDOWS_PATH_KEYS = Object.freeze([
	"ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
	"CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "PSModulePath",
]);
// Write-Reply uses ConvertTo-Json -Compress on a three-key hashtable. Hashtable
// enumeration order is not an API guarantee, so admit only its six compact key orders.
const WINDOWS_STARTUP_TIMING_VALID_START_REPLIES = new Set([
	'{"requestId":"start-1","ok":true,"result":{"state":"partial"}}',
	'{"requestId":"start-1","result":{"state":"partial"},"ok":true}',
	'{"ok":true,"requestId":"start-1","result":{"state":"partial"}}',
	'{"ok":true,"result":{"state":"partial"},"requestId":"start-1"}',
	'{"result":{"state":"partial"},"requestId":"start-1","ok":true}',
	'{"result":{"state":"partial"},"ok":true,"requestId":"start-1"}',
]);
const WINDOWS_STARTUP_TIMING_REJECTED_START_REPLY = /^\{(?:"requestId":"start-1","ok":false,"error":"(?:unavailable|unsafe|busy|not_found|invalid)"|"requestId":"start-1","error":"(?:unavailable|unsafe|busy|not_found|invalid)","ok":false|"ok":false,"requestId":"start-1","error":"(?:unavailable|unsafe|busy|not_found|invalid)"|"ok":false,"error":"(?:unavailable|unsafe|busy|not_found|invalid)","requestId":"start-1"|"error":"(?:unavailable|unsafe|busy|not_found|invalid)","requestId":"start-1","ok":false|"error":"(?:unavailable|unsafe|busy|not_found|invalid)","ok":false,"requestId":"start-1")\}$/;
const UNHOOKED_STAGES = new Set(["pack", "pack-result", "install", "artifact-check", "import-probe", "post-import-check", "cleanup"]);
const UNHOOKED_ERROR_CODES = new Set(["spawn-failed", "timed-out", "output-limit", "nonzero-exit", "invalid-result", "assertion-failed", "cleanup-failed", "unknown"]);
const SDK_LIFECYCLE_STAGES = new Set(["pack", "pack-result", "install", "artifact-check", "lifecycle-probe", "lifecycle-result", "cleanup"]);
const WINDOWS_STARTUP_TIMING_STAGES = new Set(["pack", "pack-result", "install", "artifact-check", "helper-start", "helper-result", "cleanup"]);
const WINDOWS_STARTUP_TIMING_ERROR_CODES = new Set(["spawn-failed", "timed-out", "invalid-output", "rejected", "stream-failed", "write-failed", "exited", "nonzero-exit", "cleanup-unconfirmed", "environment-invalid", "assertion-failed", "cleanup-failed", "unknown"]);
const WINDOWS_STARTUP_TIMING_OUTCOMES = new Set(["not-attempted", "valid-reply", "rejected", "timed-out", "invalid-output", "spawn-failed", "stream-failed", "write-failed", "exited"]);
const WINDOWS_STARTUP_TIMING_CLEANUP_OUTCOMES = new Set(["not-attempted", "close-observed", "close-unconfirmed", "blocked"]);
const SDK_LIFECYCLE_ERROR_CODES = new Set(["spawn-failed", "timed-out", "unconfirmed-close", "output-limit", "nonzero-exit", "invalid-result", "assertion-failed", "cleanup-failed", "unknown"]);
const SDK_LIFECYCLE_EXTENSION_ERROR_PHASES = new Set(["unobserved", "none", "startup", "shutdown"]);
const SDK_LIFECYCLE_WINDOWS_OBSERVATION_AVAILABILITY = new Set(["not-applicable", "unavailable", "observed"]);
const SDK_LIFECYCLE_WINDOWS_OBSERVATION_PROVENANCE = new Set(["not-applicable", "unavailable", "ambiguous", "owned-instance"]);
const SDK_LIFECYCLE_WINDOWS_OBSERVATION_RESTORATION = new Set(["not-applicable", "not-required", "not-attempted"]);
const SDK_LIFECYCLE_WINDOWS_OBSERVATION_PHASES = new Set(["start", "initialize", "cleanup"]);
const SDK_LIFECYCLE_WINDOWS_OBSERVATION_FAILURE_CLASSES = new Set(["timed-out", "rejected", "unknown"]);
const SDK_LIFECYCLE_WINDOWS_STARTUP_MARKERS = new Set(["script-entered", "native-ready"]);
// This is the complete source-defined diagnostic vocabulary. The receipt never accepts
// a native error code, message, property, or process output as rejection evidence.
const SDK_LIFECYCLE_WINDOWS_OBSERVATION_ERROR_CODES = new Set(["spawn", "stream", "process", "exit", "write", "deadline", "protocol", "start-reply", "stopped", "unwritable", "unknown"]);
const SDK_LIFECYCLE_CHILD_STAGES = new Set(["bootstrap", "sdk-load", "jiti-load", "agents-module-load", "model-runtime", "services", "extensions-validate", "model-availability", "session-create", "session-bind", "presence-two", "dispose-first", "presence-one", "dispose-second", "presence-none", "cleanup"]);
const SDK_LIFECYCLE_CHILD_CHECK_IDS = new Set(["bootstrap-builtins", "bootstrap-agent-home", "bootstrap-directories", "sdk-import", "sdk-exports", "jiti-import", "agents-module-import", "agents-module-export", "settings-untrusted", "settings-default-provider", "settings-default-model", "model-runtime-create", "services-create", "services-settings-manager", "services-project-trusted", "extensions-errors", "extensions-paths", "extensions-hooks", "services-diagnostics", "ambient-skills", "ambient-prompts", "ambient-themes", "ambient-context-files", "model-availability-empty", "session-create", "session-model-unbound", "session-model-invocation-guard", "session-bind", "session-bind-extension-errors", "session-model-bound", "session-ids-distinct", "presence-observer-create", "presence-two-records", "presence-first-model-unbound", "presence-second-model-unbound", "presence-two-extension-errors", "dispose-first", "dispose-first-extension-errors", "presence-one-record", "presence-one-model-unbound", "presence-one-extension-errors", "dispose-second", "dispose-second-extension-errors", "presence-no-records", "presence-none-extension-errors", "cleanup-runtime", "cleanup-observer", "cleanup-extension-errors"]);
const SDK_LIFECYCLE_CHILD_ERROR_CODES = new Set(["assertion-failed", "forbidden-model-invocation", "load-failed", "timed-out", "cleanup-failed", "observation-invalid", "unknown"]);
const SDK_LIFECYCLE_CHILD_CLEANUP_STATUSES = new Set(["complete", "failed"]);
const SDK_LIFECYCLE_CHECK_IDS = new Set([
	"not-attempted", "runner-hosted", "runner-temp", "temporary-root", "project-sdk-version", "pack-command", "pack-metadata", "pack-integrity", "install-command", "packed-assets", "native-artifacts", "sdk-manifest", "sdk-version", "jiti-manifest-owned", "jiti-static-export", "jiti-entry-owned", "jiti-version", "lifecycle-probe-command", "lifecycle-probe-result", "sdk-lifecycle-complete", "cleanup-owned-root-removal",
]);
const WINDOWS_STARTUP_TIMING_CHECK_IDS = new Set([
	"not-attempted", "runner-hosted", "runner-temp", "temporary-root", "project-sdk-version", "pack-command", "pack-metadata", "pack-integrity", "install-command", "packed-assets", "native-artifacts", "installed-helper", "helper-start", "helper-result", "windows-helper-startup-measured", "windows-helper-startup-environment-measured", "cleanup-owned-root-removal",
]);
const UNHOOKED_CHECK_IDS = new Set([
	"not-attempted", "runner-temp", "temporary-root", "project-sdk-version", "pack-command", "pack-metadata", "pack-integrity", "install-command", "import-probe-command", "import-probe-result", "unhooked-imports-complete", "cleanup-owned-root-removal",
	"asset-runtime-windows-session-transport-owned", "asset-runtime-windows-session-transport-hash",
	"asset-lib-windows-session-transport-owned", "asset-lib-windows-session-transport-hash",
	"asset-lib-agents-session-transport-owned", "asset-lib-agents-session-transport-hash",
	"asset-extension-gentle-agents-owned", "asset-extension-gentle-agents-hash",
	"asset-extension-gentle-ai-owned", "asset-extension-gentle-ai-hash",
	"asset-native-review-cli-owned", "asset-native-review-cli-hash",
	"asset-review-integration-v2-owned", "asset-review-integration-v2-hash",
	"asset-installer-gentle-ai-owned", "asset-installer-gentle-ai-hash",
	"asset-installer-tui-mode-setting-owned", "asset-installer-tui-mode-setting-hash",
	"native-package-cache-absent", "native-command-absent", "sdk-manifest-owned", "sdk-version", "jiti-manifest-owned", "jiti-static-export", "jiti-entry-owned", "jiti-version",
	"home-empty", "gentle-pi-agent-empty", "pi-coding-agent-empty", "gentle-pi-config-empty", "xdg-config-empty", "xdg-cache-empty", "xdg-data-empty", "appdata-empty", "local-appdata-empty",
]);

function newUnhookedReceipt() {
	return { checkId: "not-attempted", packVerified: false, installCompleted: false, cleanupCompleted: false };
}

function newSdkLifecycleReceipt() {
	return {
		checkId: "not-attempted", packVerified: false, installCompleted: false, childReceiptObserved: false, sdkLoaded: false,
		extensionErrorCount: null, extensionErrorPhase: "unobserved", modelInvocationCount: null, agentStartEventCount: null, turnStartEventCount: null, sessionsStarted: 0,
		presenceAfterStart: 0, presenceAfterFirstDispose: 0, presenceAfterSecondDispose: 0,
		disposedSessions: 0, windowsRegistryObservation: null, cleanupCompleted: false,
	};
}

function newWindowsStartupTimingReceipt() {
	return {
		checkId: "not-attempted", packVerified: false, installCompleted: false, budgetMs: WINDOWS_STARTUP_TIMING_BUDGET_MS,
		helperStartOutcome: "not-attempted", startElapsedMs: null, lastStartupMarker: null,
		cleanup: "not-attempted", physicalCloseObserved: false, cleanupCompleted: false,
	};
}

function newWindowsStartupTimingEnvironmentCase(name, pathAdditionKeys) {
	if (!WINDOWS_STARTUP_TIMING_ENVIRONMENT_CASE_NAMES.includes(name)) throw new Error("invalid Windows startup environment case");
	return {
		name, pathAdditionKeys, budgetMs: WINDOWS_STARTUP_TIMING_BUDGET_MS,
		helperStartOutcome: "not-attempted", startElapsedMs: null, lastStartupMarker: null,
		cleanup: "not-attempted", physicalCloseObserved: false, failureStage: null, failureCode: null,
	};
}

function selectUnhookedCheck(receipt, checkId) {
	if (!UNHOOKED_CHECK_IDS.has(checkId)) throw new Error("invalid unhooked check identifier");
	receipt.checkId = checkId;
}

function selectSdkLifecycleCheck(receipt, checkId) {
	if (!SDK_LIFECYCLE_CHECK_IDS.has(checkId)) throw new Error("invalid SDK lifecycle check identifier");
	receipt.checkId = checkId;
}

function selectWindowsStartupTimingCheck(receipt, checkId) {
	if (!WINDOWS_STARTUP_TIMING_CHECK_IDS.has(checkId)) throw new Error("invalid Windows startup timing check identifier");
	receipt.checkId = checkId;
}

function isWithin(rootPath, candidatePath) {
	const root = resolve(rootPath);
	const candidate = resolve(candidatePath);
	const remainder = relative(root, candidate);
	return remainder !== "" && !isAbsolute(remainder) && !remainder.split(sep).includes("..");
}

function assertOwnedRegularFile(rootPath, relativePath) {
	const ownedRoot = resolve(rootPath);
	const rootEntry = lstatSync(ownedRoot);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) throw new Error(`refusing unowned package root: ${rootPath}`);
	const path = resolve(ownedRoot, relativePath);
	if (!isWithin(ownedRoot, path)) throw new Error(`path escapes owned root: ${relativePath}`);
	const normalizedRelativePath = relative(ownedRoot, path);
	let current = ownedRoot;
	for (const segment of normalizedRelativePath.split(sep)) {
		current = join(current, segment);
		const entry = lstatSync(current);
		if (entry.isSymbolicLink()) throw new Error(`refusing symbolic link in owned package: ${relativePath}`);
	}
	if (!lstatSync(path).isFile()) throw new Error(`expected regular file: ${relativePath}`);
	return path;
}

function assertEmptyDirectory(path) {
	const entries = readdirSync(path);
	if (entries.length !== 0) throw new Error(`disposable home changed unexpectedly: ${path}`);
}

function safeJson(buffer, description) {
	const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
	if (Buffer.byteLength(text, "utf8") > MAX_NPM_OUTPUT_BYTES) throw new Error(`${description} exceeded 1 MiB`);
	return JSON.parse(text);
}

function validExitStatus(value) {
	return Number.isInteger(value) && value > 0 && value <= 255 ? value : undefined;
}

class UnhookedFailure extends Error {
	constructor(stage, code, exitStatus) {
		super("unhooked packed proof failed");
		this.stage = UNHOOKED_STAGES.has(stage) ? stage : "cleanup";
		this.code = UNHOOKED_ERROR_CODES.has(code) ? code : "unknown";
		this.exitStatus = validExitStatus(exitStatus);
	}
}

class WindowsStartupTimingFailure extends Error {
	constructor(stage, code) {
		super("Windows helper startup timing experiment failed");
		this.stage = WINDOWS_STARTUP_TIMING_STAGES.has(stage) ? stage : "cleanup";
		this.code = WINDOWS_STARTUP_TIMING_ERROR_CODES.has(code) ? code : "unknown";
	}
}

class SdkLifecycleFailure extends Error {
	constructor(stage, code, exitStatus, childReceipt) {
		super("SDK lifecycle packed proof failed");
		this.stage = SDK_LIFECYCLE_STAGES.has(stage) ? stage : "cleanup";
		this.code = SDK_LIFECYCLE_ERROR_CODES.has(code) ? code : "unknown";
		this.exitStatus = validExitStatus(exitStatus);
		this.childStage = "unknown";
		this.childCheckId = "unobserved";
		this.childCleanupStatus = "unobserved";
		this.childFailureCode = "unknown";
		if (childReceipt !== undefined) {
			this.childStage = childReceipt.stage;
			this.childCheckId = childReceipt.checkId;
			this.childCleanupStatus = childReceipt.cleanupStatus;
			this.childFailureCode = childReceipt.childFailureCode;
		}
	}
}

function processFailure(stage, error) {
	const details = error && typeof error === "object" ? error : {};
	const exitStatus = validExitStatus(details.status);
	if (details.code === "ETIMEDOUT") return new UnhookedFailure(stage, "timed-out", exitStatus);
	if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return new UnhookedFailure(stage, "output-limit", exitStatus);
	return new UnhookedFailure(stage, exitStatus === undefined ? "spawn-failed" : "nonzero-exit", exitStatus);
}

function stageFailure(stage, error, invalidResult = false) {
	if (error instanceof UnhookedFailure) return error;
	return new UnhookedFailure(stage, invalidResult ? "invalid-result" : "assertion-failed");
}

function reportUnhookedReceipt(receipt, error) {
	const failure = error instanceof UnhookedFailure ? error : undefined;
	const report = {
		mode: "unhooked-imports",
		status: failure === undefined ? "complete" : "failed",
		checkId: failure === undefined ? "unhooked-imports-complete" : receipt.checkId,
		packVerified: receipt.packVerified,
		installCompleted: receipt.installCompleted,
		cleanupCompleted: receipt.cleanupCompleted,
		...(failure === undefined ? {} : { stage: failure.stage, code: failure.code, ...(failure.exitStatus === undefined ? {} : { exitStatus: failure.exitStatus }) }),
	};
	const line = JSON.stringify(report);
	const boundedLine = Buffer.byteLength(line, "utf8") <= MAX_UNHOOKED_REPORT_BYTES
		? line
		: '{"mode":"unhooked-imports","status":"failed","checkId":"not-attempted","packVerified":false,"installCompleted":false,"cleanupCompleted":false,"stage":"cleanup","code":"unknown"}';
	try { (failure === undefined ? process.stdout : process.stderr).write(`${boundedLine}\n`); } catch { /* Reporting cannot expose a raw secondary error. */ }
	if (failure !== undefined) process.exitCode = failure.exitStatus ?? 1;
}

function reportWindowsStartupTimingReceipt(receipt, error) {
	const failure = error instanceof WindowsStartupTimingFailure ? error : undefined;
	const report = {
		mode: "windows-startup-timing",
		status: failure === undefined ? "complete" : "failed",
		checkId: failure === undefined ? "windows-helper-startup-measured" : receipt.checkId,
		packVerified: receipt.packVerified,
		installCompleted: receipt.installCompleted,
		budgetMs: receipt.budgetMs,
		helperStartOutcome: receipt.helperStartOutcome,
		startElapsedMs: receipt.startElapsedMs,
		lastStartupMarker: receipt.lastStartupMarker,
		cleanup: receipt.cleanup,
		physicalCloseObserved: receipt.physicalCloseObserved,
		cleanupCompleted: receipt.cleanupCompleted,
		...(failure === undefined ? {} : { stage: failure.stage, code: failure.code }),
	};
	const line = JSON.stringify(report);
	const boundedLine = Buffer.byteLength(line, "utf8") <= MAX_WINDOWS_STARTUP_TIMING_REPORT_BYTES
		? line
		: '{"mode":"windows-startup-timing","status":"failed","checkId":"not-attempted","packVerified":false,"installCompleted":false,"budgetMs":25000,"helperStartOutcome":"not-attempted","startElapsedMs":null,"lastStartupMarker":null,"cleanup":"not-attempted","physicalCloseObserved":false,"cleanupCompleted":false,"stage":"cleanup","code":"unknown"}';
	try { (failure === undefined ? process.stdout : process.stderr).write(`${boundedLine}\n`); } catch { /* Reporting cannot expose a raw secondary error. */ }
	if (failure !== undefined) process.exitCode = 1;
}

function reportWindowsStartupTimingEnvironmentReceipt(receipt, error) {
	const failure = error instanceof WindowsStartupTimingFailure ? error : undefined;
	const report = {
		mode: "windows-startup-timing-environment",
		status: failure === undefined ? "complete" : "failed",
		checkId: failure === undefined ? "windows-helper-startup-environment-measured" : receipt.checkId,
		packVerified: receipt.packVerified,
		installCompleted: receipt.installCompleted,
		isolation: "shared-owned-homes-fresh-helper",
		...WINDOWS_STARTUP_TIMING_ENVIRONMENT_RECEIPT_FLAGS,
		allowedPathAdditionKeys: WINDOWS_STARTUP_TIMING_WINDOWS_PATH_KEYS,
		cases: receipt.cases,
		cleanupCompleted: receipt.cleanupCompleted,
		stage: failure?.stage ?? null,
		code: failure?.code ?? null,
	};
	const line = JSON.stringify(report);
	const fallback = JSON.stringify({
		mode: "windows-startup-timing-environment", status: "failed", checkId: receipt.checkId,
		packVerified: receipt.packVerified, installCompleted: receipt.installCompleted,
		isolation: "shared-owned-homes-fresh-helper", ...WINDOWS_STARTUP_TIMING_ENVIRONMENT_RECEIPT_FLAGS,
		allowedPathAdditionKeys: WINDOWS_STARTUP_TIMING_WINDOWS_PATH_KEYS, cases: receipt.cases,
		cleanupCompleted: receipt.cleanupCompleted, stage: failure?.stage ?? "unknown", code: failure?.code ?? "unknown",
	});
	const boundedLine = Buffer.byteLength(line, "utf8") <= MAX_WINDOWS_STARTUP_TIMING_ENVIRONMENT_REPORT_BYTES ? line : fallback;
	try { (failure === undefined ? process.stdout : process.stderr).write(`${boundedLine}\n`); } catch { /* Reporting cannot expose a raw secondary error. */ }
	if (failure !== undefined) process.exitCode = 1;
}

function reportSdkLifecycleReceipt(receipt, error) {
	const failure = error instanceof SdkLifecycleFailure ? error : undefined;
	const report = {
		mode: "sdk-lifecycle",
		status: failure === undefined ? "complete" : "failed",
		checkId: failure === undefined ? "sdk-lifecycle-complete" : receipt.checkId,
		packVerified: receipt.packVerified,
		installCompleted: receipt.installCompleted,
		childReceiptObserved: receipt.childReceiptObserved,
		sdkLoaded: receipt.sdkLoaded,
		extensionErrorCount: receipt.extensionErrorCount,
		extensionErrorPhase: receipt.extensionErrorPhase,
		sessionsStarted: receipt.sessionsStarted,
		presenceAfterStart: receipt.presenceAfterStart,
		presenceAfterFirstDispose: receipt.presenceAfterFirstDispose,
		presenceAfterSecondDispose: receipt.presenceAfterSecondDispose,
		disposedSessions: receipt.disposedSessions,
		modelInvocationCount: receipt.modelInvocationCount,
		agentStartEventCount: receipt.agentStartEventCount,
		turnStartEventCount: receipt.turnStartEventCount,
		windowsRegistryObservation: receipt.windowsRegistryObservation,
		cleanupCompleted: receipt.cleanupCompleted,
		...(failure === undefined ? {} : { stage: failure.stage, code: failure.code, childStage: failure.childStage, childCheckId: failure.childCheckId, childCleanupStatus: failure.childCleanupStatus, ...(failure.childFailureCode === undefined ? {} : { childFailureCode: failure.childFailureCode }), ...(failure.exitStatus === undefined ? {} : { exitStatus: failure.exitStatus }) }),
	};
	const line = JSON.stringify(report);
	const boundedLine = Buffer.byteLength(line, "utf8") <= MAX_UNHOOKED_REPORT_BYTES
		? line
		: '{"mode":"sdk-lifecycle","status":"failed","checkId":"not-attempted","packVerified":false,"installCompleted":false,"childReceiptObserved":false,"sdkLoaded":false,"extensionErrorCount":null,"extensionErrorPhase":"unobserved","sessionsStarted":0,"presenceAfterStart":0,"presenceAfterFirstDispose":0,"presenceAfterSecondDispose":0,"disposedSessions":0,"modelInvocationCount":null,"agentStartEventCount":null,"turnStartEventCount":null,"cleanupCompleted":false,"stage":"cleanup","code":"unknown","childStage":"unknown","childCheckId":"unobserved","childCleanupStatus":"unobserved","childFailureCode":"unknown"}';
	try { (failure === undefined ? process.stdout : process.stderr).write(`${boundedLine}\n`); } catch { /* Reporting cannot expose a raw secondary error. */ }
	if (failure !== undefined) process.exitCode = failure.exitStatus ?? 1;
}

function windowsNpmInvocation() {
	const candidates = [];
	if (process.env.npm_execpath !== undefined && /[\\/]npm[\\/]bin[\\/]npm-cli\.js$/i.test(process.env.npm_execpath)) candidates.push(process.env.npm_execpath);
	for (const executable of new Set([process.execPath, realpathSync(process.execPath)])) candidates.push(join(dirname(executable), "node_modules", "npm", "bin", "npm-cli.js"));
	const installedCli = candidates.find((path) => existsSync(path));
	if (installedCli !== undefined) return { file: process.execPath, prefix: [installedCli] };
	let commandPaths = [];
	try { commandPaths = execFileSync("where.exe", ["npm"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).split(/\r?\n/).filter(Boolean); }
	catch { /* fall through to the explicit resolution error */ }
	for (const path of commandPaths) {
		if (basename(path).toLowerCase() === "npm.exe") return { file: path, prefix: [] };
		const cli = join(dirname(path), "node_modules", "npm", "bin", "npm-cli.js");
		if (existsSync(cli)) return { file: process.execPath, prefix: [cli] };
	}
	throw new Error("could not resolve npm-cli.js without a command shell");
}

function runNpmWithEnv(arguments_, env, options) {
	const invocation = process.platform === "win32" ? windowsNpmInvocation() : { file: "npm", prefix: [] };
	return execFileSync(invocation.file, [...invocation.prefix, ...arguments_], { ...options, env });
}

function runBoundedNpm(stage, arguments_, env, cwd) {
	try {
		return runNpmWithEnv(arguments_, env, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 120000,
			maxBuffer: MAX_NPM_OUTPUT_BYTES,
		});
	} catch (error) {
		throw processFailure(stage, error);
	}
}

function runBoundedProbe(arguments_, env, cwd) {
	try {
		return execFileSync(process.execPath, arguments_, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env,
			timeout: 120000,
			maxBuffer: MAX_NPM_OUTPUT_BYTES,
		});
	} catch (error) {
		throw processFailure("import-probe", error);
	}
}

function runBoundedSdkLifecycleProbe(arguments_, env, cwd) {
	return new Promise((resolveProbe, rejectProbe) => {
		let child;
		let settled = false;
		let outputBytes = 0;
		const stdout = [];
		const stderr = [];
		let timeout;
		let forceKill;
		let closeGrace;
		let stopFailure;
		const lateErrorSink = () => {};
		let onStdout;
		let onStderr;
		let onChildError;
		let onClose;
		const detachOperationalListeners = () => {
			if (!child) return;
			child.stdout?.removeListener("data", onStdout);
			child.stderr?.removeListener("data", onStderr);
			child.removeListener("error", onChildError);
			child.removeListener("close", onClose);
		};
		const releaseUnconfirmedClose = () => {
			if (!child) return;
			detachOperationalListeners();
			const removeLateGuards = () => {
				child?.removeListener("error", lateErrorSink);
				child?.stdout?.removeListener("error", lateErrorSink);
				child?.stderr?.removeListener("error", lateErrorSink);
			};
			child.once("close", removeLateGuards);
			child.on("error", lateErrorSink);
			child.stdout?.on("error", lateErrorSink);
			child.stderr?.on("error", lateErrorSink);
			try { child.stdin?.destroy(); } catch { /* The process is already in bounded forced cleanup. */ }
			try { child.stdout?.destroy(); } catch { /* The process is already in bounded forced cleanup. */ }
			try { child.stderr?.destroy(); } catch { /* The process is already in bounded forced cleanup. */ }
			try { child.unref(); } catch { /* The final receipt reports that close was unconfirmed. */ }
		};
		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (forceKill) clearTimeout(forceKill);
			if (closeGrace) clearTimeout(closeGrace);
			if (error instanceof SdkLifecycleFailure && error.code === "unconfirmed-close") releaseUnconfirmedClose();
			else detachOperationalListeners();
			if (error) rejectProbe(error);
			else resolveProbe(result);
		};
		const requestStop = (failure) => {
			if (stopFailure !== undefined || settled) return;
			stopFailure = failure;
			try { child?.kill(); } catch { /* The close grace below reports an unconfirmed close honestly. */ }
			forceKill = setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* The final grace reports an unconfirmed close honestly. */ } }, 2500);
			closeGrace = setTimeout(() => finish(new SdkLifecycleFailure("lifecycle-probe", "unconfirmed-close")), 5000);
		};
		try {
			child = spawn(process.execPath, arguments_, {
				cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch {
			finish(new SdkLifecycleFailure("lifecycle-probe", "spawn-failed"));
			return;
		}
		const collect = (chunk, destination) => {
			outputBytes += Buffer.byteLength(chunk);
			if (outputBytes > MAX_NPM_OUTPUT_BYTES) requestStop(new SdkLifecycleFailure("lifecycle-probe", "output-limit"));
			else if (destination !== undefined) destination.push(Buffer.from(chunk));
		};
		onStdout = (chunk) => collect(chunk, stdout);
		onStderr = (chunk) => collect(chunk, stderr);
		onChildError = () => requestStop(new SdkLifecycleFailure("lifecycle-probe", "spawn-failed"));
		onClose = (status) => {
			if (settled) return;
			if (stopFailure !== undefined) {
				finish(stopFailure);
				return;
			}
			finish(undefined, { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
		};
		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		child.once("error", onChildError);
		child.once("close", onClose);
		timeout = setTimeout(() => requestStop(new SdkLifecycleFailure("lifecycle-probe", "timed-out")), SDK_LIFECYCLE_PROBE_TIMEOUT_MS);
	});
}

function runWindowsStartupTimingProbe(runtimeScript, env, cwd) {
	return new Promise((resolveProbe) => {
		const observation = { helperStartOutcome: "not-attempted", startElapsedMs: null, lastStartupMarker: null, cleanup: "not-attempted", physicalCloseObserved: false };
		let child;
		let startedAt;
		let startTimer;
		let cleanupTimer;
		let forceCloseTimer;
		let settled = false;
		let startReplyObserved = false;
		let markerOrdinal = 0;
		let output = Buffer.alloc(0);
		let outputBytes = 0;
		let failure;
		const clearTimers = () => {
			if (startTimer) clearTimeout(startTimer);
			if (cleanupTimer) clearTimeout(cleanupTimer);
			if (forceCloseTimer) clearTimeout(forceCloseTimer);
		};
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimers();
			if (observation.cleanup === "close-unconfirmed") {
				const lateErrorSink = () => {};
				child?.on("error", lateErrorSink);
				child?.stdin?.on("error", lateErrorSink);
				child?.stdout?.on("error", lateErrorSink);
				child?.stderr?.on("error", lateErrorSink);
				try { child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref(); } catch { /* The receipt records that physical closure was not observed. */ }
			}
			resolveProbe({ ...observation, failure });
		};
		const setFailure = (stage, code, startOutcome) => {
			if (failure !== undefined) return;
			if (!startReplyObserved && WINDOWS_STARTUP_TIMING_OUTCOMES.has(startOutcome)) observation.helperStartOutcome = startOutcome;
			failure = { stage, code };
		};
		const beginBoundedCleanup = () => {
			if (!child || observation.physicalCloseObserved || cleanupTimer || settled) return;
			cleanupTimer = setTimeout(() => {
				try { child.kill(); } catch { /* The final bounded grace records unconfirmed physical closure. */ }
				forceCloseTimer = setTimeout(() => {
					if (observation.physicalCloseObserved) return;
					observation.cleanup = "close-unconfirmed";
					setFailure("cleanup", "cleanup-unconfirmed", "unknown");
					finish();
				}, WINDOWS_STARTUP_TIMING_FORCE_CLOSE_GRACE_MS);
			}, WINDOWS_STARTUP_TIMING_CLEANUP_GRACE_MS);
		};
		const failAndCleanup = (stage, code, startOutcome) => {
			setFailure(stage, code, startOutcome);
			beginBoundedCleanup();
		};
		const rejectOutput = () => failAndCleanup(startReplyObserved ? "helper-result" : "helper-start", "invalid-output", "invalid-output");
		const observeControlLine = (rawLine) => {
			const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
			if (line === '{"event":"startup-marker","marker":"script-entered"}') {
				if (startReplyObserved || markerOrdinal !== 0) return rejectOutput();
				markerOrdinal = 1; observation.lastStartupMarker = "script-entered"; return;
			}
			if (line === '{"event":"startup-marker","marker":"native-ready"}') {
				if (startReplyObserved || markerOrdinal !== 1) return rejectOutput();
				markerOrdinal = 2; observation.lastStartupMarker = "native-ready"; return;
			}
			if (startReplyObserved) return rejectOutput();
			if (WINDOWS_STARTUP_TIMING_REJECTED_START_REPLY.test(line)) return failAndCleanup("helper-start", "rejected", "rejected");
			if (!WINDOWS_STARTUP_TIMING_VALID_START_REPLIES.has(line) || markerOrdinal !== 2) return rejectOutput();
			const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
			if (!Number.isFinite(elapsedMs) || elapsedMs > WINDOWS_STARTUP_TIMING_BUDGET_MS) return failAndCleanup("helper-start", "timed-out", "timed-out");
			startReplyObserved = true;
			observation.helperStartOutcome = "valid-reply";
			observation.startElapsedMs = elapsedMs;
			if (startTimer) clearTimeout(startTimer);
			// Markers are protocol progress only. This succeeds because the exact start reply is valid.
			beginBoundedCleanup();
		};
		const onStdout = (chunk) => {
			if (!Buffer.isBuffer(chunk) || settled) return failAndCleanup("helper-start", "stream-failed", "stream-failed");
			outputBytes += chunk.length;
			if (outputBytes > MAX_WINDOWS_STARTUP_TIMING_OUTPUT_BYTES) return rejectOutput();
			const combined = output.length === 0 ? chunk : Buffer.concat([output, chunk]);
			let offset = 0;
			for (;;) {
				const newline = combined.indexOf(10, offset);
				if (newline < 0) {
					output = combined.subarray(offset);
					if (output.length > 16_384) rejectOutput();
					return;
				}
				const line = combined.subarray(offset, newline);
				offset = newline + 1;
				if (line.length > 16_385 || (line.length >= 3 && line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf)) return rejectOutput();
				try { observeControlLine(new TextDecoder("utf-8", { fatal: true }).decode(line)); } catch { return rejectOutput(); }
				if (failure !== undefined) return;
			}
		};
		const onClose = (status) => {
			observation.physicalCloseObserved = true;
			observation.cleanup = "close-observed";
			if (output.length !== 0) setFailure(startReplyObserved ? "helper-result" : "helper-start", "invalid-output", "invalid-output");
			if (!startReplyObserved) setFailure("helper-start", "exited", "exited");
			else if (status !== 0) setFailure("helper-result", "nonzero-exit", "unknown");
			finish();
		};
		startedAt = process.hrtime.bigint(); // The measurement begins immediately before the exact spawn invocation.
		try {
			child = spawn(WINDOWS_STARTUP_TIMING_POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", runtimeScript], { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		} catch {
			setFailure("helper-start", "spawn-failed", "spawn-failed");
			finish();
			return;
		}
		child.stdout.on("data", onStdout);
		child.stdout.on("error", () => failAndCleanup(startReplyObserved ? "helper-result" : "helper-start", "stream-failed", "stream-failed"));
		child.stdin.on("error", () => failAndCleanup(startReplyObserved ? "helper-result" : "helper-start", "write-failed", "write-failed"));
		child.stderr.on("error", () => failAndCleanup(startReplyObserved ? "helper-result" : "helper-start", "stream-failed", "stream-failed"));
		child.stderr.resume();
		child.once("error", () => failAndCleanup(startReplyObserved ? "helper-result" : "helper-start", "stream-failed", "stream-failed"));
		child.once("close", onClose);
		startTimer = setTimeout(() => failAndCleanup("helper-start", "timed-out", "timed-out"), WINDOWS_STARTUP_TIMING_BUDGET_MS);
		try { child.stdin.end(WINDOWS_STARTUP_TIMING_START_REQUEST, (error) => { if (error) failAndCleanup(startReplyObserved ? "helper-result" : "helper-start", "write-failed", "write-failed"); }); }
		catch { failAndCleanup("helper-start", "write-failed", "write-failed"); }
	});
}

async function testHookedPackedRunner() {
	const temporary = mkdtempSync(join(tmpdir(), "gentle-pi-packed-runner-"));
	const packDirectory = join(temporary, "pack");
	const installDirectory = join(temporary, "install");
	// Every child inherits only disposable Pi homes, never the operator's settings.
	const agentHome = join(temporary, "agent");
	const piAgentHome = join(temporary, "pi-agent");
	const isolatedEnv = { ...process.env, GENTLE_PI_AGENT_HOME: agentHome, PI_CODING_AGENT_DIR: piAgentHome };
	const runNpm = (arguments_, options) => runNpmWithEnv(arguments_, isolatedEnv, options);
	try {
		mkdirSync(packDirectory);
		mkdirSync(installDirectory);
		mkdirSync(agentHome);
		mkdirSync(piAgentHome);
	const originalSettings = '{ "tuiMode": "regular", "theme": "packed-fixture" }\n';
	writeFileSync(join(agentHome, "settings.json"), originalSettings);
	const packed = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
}));
	if (packed.length !== 1 || typeof packed[0]?.filename !== "string") throw new Error("npm pack did not return one tarball");
	const tarball = join(packDirectory, packed[0].filename);
	writeFileSync(join(installDirectory, "package.json"), JSON.stringify({ name: "gentle-pi-packed-runner-test", private: true }), "utf8");
	runNpm(["install", "--ignore-scripts=false", "--no-audit", "--no-fund", "--package-lock=false", "--omit=dev", "--legacy-peer-deps", tarball], {
		cwd: installDirectory,
		stdio: "inherit",
	});
	// This is an ordinary npm consumer, not Pi's managed global npm directory.
	assert.equal(readFileSync(join(agentHome, "settings.json"), "utf8"), originalSettings);
	assert.deepEqual(readdirSync(agentHome), ["settings.json"]);
	assert.deepEqual(readdirSync(piAgentHome), []);
	assert.equal(existsSync(join(installDirectory, ".pi", "settings.json")), false);
	const packageRoot = join(installDirectory, "node_modules", "gentle-pi");
	assert.ok(existsSync(join(packageRoot, "scripts", "install-tui-mode-setting.mjs")));
	const { nativeReviewAbandonAuthorization } = await import(pathToFileURL(join(packageRoot, "runtime", "native-review-cli.mjs")).href);
	const abandonAuthorization = nativeReviewAbandonAuthorization({
		lineage: "review-abc",
		expectedRevision: "revision-9",
		snapshotIdentity: "snapshot-1",
		capturedLensResults: ["00-risk.json", "01-refuter.json"],
		findingsPresent: true,
		actor: "maintainer",
		reason: "operator_disposition",
	});
	assert.equal(abandonAuthorization, [
		"gentle-ai.review-abandon-authorization/v2",
		"lineage=review-abc",
		"revision=revision-9",
		"snapshot_identity=snapshot-1",
		"reason=operator_disposition",
		"captured_lens_results=00-risk.json,01-refuter.json",
		"findings_present=true",
		"actor=maintainer",
	].join("\n"));
	assert.ok(!abandonAuthorization.includes("evidence_records_present"));
	// Accept prerelease pins too: a stable-only pattern here was a second,
	// silent pin that refused the first prerelease version directory.
	const versions = readdirSync(join(packageRoot, ".gentle-ai"), { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.]*)?$/.test(entry.name));
	if (versions.length !== 1) throw new Error("packed install did not contain exactly one package-local Gentle AI version");
	const executable = join(packageRoot, ".gentle-ai", versions[0].name, process.platform === "win32" ? "gentle-ai.exe" : "gentle-ai");
	const capabilities = JSON.parse(execFileSync(executable, ["review", "capabilities", "--contract", "gentle-ai.review-integration/v2"], { cwd: installDirectory, encoding: "utf8", env: isolatedEnv }));
	// Decode with the PACKED consumer's own decoder rather than comparing the
	// schema string against a list hand-copied into this script. The copy was a
	// second, silent pin: it accepted only `capabilities/v2`, so the moment the
	// pinned provider advertised an additive minor this E2E rejected a pairing
	// that gentle-pi reads correctly, and it would have done so again on the
	// next minor. Using the shipped decoder makes the assertion what it always
	// meant to be — the packed consumer can read the packed provider — and it
	// checks the whole envelope (protocol major/minor, required operations,
	// gates, projections, advertised schemas, mandatory features, and the
	// self-reported executable digest) instead of one string.
	const { decodeReviewCapabilitiesV2 } = await import(pathToFileURL(join(packageRoot, "runtime", "review-integration-v2.mjs")).href);
	const executableDigest = `sha256:${createHash("sha256").update(readFileSync(executable)).digest("hex")}`;
	const decoded = decodeReviewCapabilitiesV2(capabilities, executableDigest);
	if (decoded.contract !== "gentle-ai.review-integration/v2" || decoded.packageVersion !== versions[0].name.slice(1)) throw new Error("package-local Gentle AI returned incompatible capabilities");
	const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
		process.stdout.write(`packed package E2E passed (gentle-pi ${packageManifest.version ?? "unknown"}; Gentle AI ${decoded.packageVersion ?? "unknown"})\n`);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

function isolatedUnhookedEnvironment(temporary) {
	const homes = join(temporary, "homes");
	const home = join(homes, "home");
	const agentHome = join(homes, "gentle-pi-agent");
	const piAgentHome = join(homes, "pi-coding-agent");
	const gentleConfigHome = join(homes, "gentle-pi-config");
	const xdgConfigHome = join(homes, "xdg-config");
	const xdgCacheHome = join(homes, "xdg-cache");
	const xdgDataHome = join(homes, "xdg-data");
	const appData = join(homes, "appdata");
	const localAppData = join(homes, "local-appdata");
	const npmCache = join(temporary, "npm-cache");
	const npmUserConfig = join(temporary, "npm-userconfig");
	const passthrough = ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "PATHEXT", "OS", "CI", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];
	const env = {};
	for (const key of passthrough) if (typeof process.env[key] === "string") env[key] = process.env[key];
	for (const directory of [homes, home, agentHome, piAgentHome, gentleConfigHome, xdgConfigHome, xdgCacheHome, xdgDataHome, appData, localAppData, npmCache]) mkdirSync(directory, { recursive: true });
	Object.assign(env, {
		HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData,
		XDG_CONFIG_HOME: xdgConfigHome, XDG_CACHE_HOME: xdgCacheHome, XDG_DATA_HOME: xdgDataHome,
		TMPDIR: temporary, TMP: temporary, TEMP: temporary,
		GENTLE_PI_AGENT_HOME: agentHome, GENTLE_PI_CONFIG_HOME: gentleConfigHome, PI_CODING_AGENT_DIR: piAgentHome,
		NPM_CONFIG_CACHE: npmCache, npm_config_cache: npmCache, NPM_CONFIG_USERCONFIG: npmUserConfig, npm_config_userconfig: npmUserConfig,
		NPM_CONFIG_TMP: temporary, npm_config_tmp: temporary, NPM_CONFIG_IGNORE_SCRIPTS: "true", npm_config_ignore_scripts: "true",
		NPM_CONFIG_UPDATE_NOTIFIER: "false", npm_config_update_notifier: "false",
	});
	if (process.platform === "win32") {
		env.HOMEDRIVE = home.slice(0, 2);
		env.HOMEPATH = home.slice(2).replaceAll("/", "\\\\");
	}
	return {
		env,
		homes: [
			{ checkId: "home-empty", path: home },
			{ checkId: "gentle-pi-agent-empty", path: agentHome },
			{ checkId: "pi-coding-agent-empty", path: piAgentHome },
			{ checkId: "gentle-pi-config-empty", path: gentleConfigHome },
			{ checkId: "xdg-config-empty", path: xdgConfigHome },
			{ checkId: "xdg-cache-empty", path: xdgCacheHome },
			{ checkId: "xdg-data-empty", path: xdgDataHome },
			{ checkId: "appdata-empty", path: appData },
			{ checkId: "local-appdata-empty", path: localAppData },
		],
	};
}

function isValidatedWindowsMachineRoot(value, leaf) {
	if (typeof value !== "string" || /[\0-\x1f\x7f]/.test(value)) return false;
	const match = new RegExp(`^[A-Za-z]:\\\\${leaf}$`, "i").exec(value);
	return match?.[0] === value;
}

function readCaseInsensitiveEnvironmentValue(source, name) {
	if (!source || typeof source !== "object") return undefined;
	const matches = Object.entries(source).filter(([key]) => key.toLowerCase() === name.toLowerCase()).map(([, value]) => value);
	if (matches.length === 0 || matches.some((value) => typeof value !== "string")) return undefined;
	return matches.every((value) => value === matches[0]) ? matches[0] : undefined;
}

function sameWindowsCanonicalPath(actual, expected) {
	return typeof actual === "string" && win32.normalize(actual).toLowerCase() === win32.normalize(expected).toLowerCase();
}

// This deliberately reads only the named machine roots. It never inherits PSModulePath
// or any profile-derived path, and it returns keys rather than values for receipts.
export function deriveWindowsStartupTimingPathDelta(source) {
	const programFiles = readCaseInsensitiveEnvironmentValue(source, "ProgramFiles");
	const programFilesX86 = readCaseInsensitiveEnvironmentValue(source, "ProgramFiles(x86)");
	const programFilesW6432 = readCaseInsensitiveEnvironmentValue(source, "ProgramW6432");
	const systemRoot = readCaseInsensitiveEnvironmentValue(source, "SystemRoot");
	if (!isValidatedWindowsMachineRoot(programFiles, "Program Files")
		|| !isValidatedWindowsMachineRoot(programFilesX86, "Program Files \\(x86\\)")
		|| !isValidatedWindowsMachineRoot(programFilesW6432, "Program Files")
		|| !isValidatedWindowsMachineRoot(systemRoot, "Windows")) {
		return Object.freeze({ ready: false, pathAdditionKeys: Object.freeze([]), values: Object.freeze({}) });
	}
	const values = Object.freeze({
		ProgramFiles: programFiles,
		"ProgramFiles(x86)": programFilesX86,
		ProgramW6432: programFilesW6432,
		CommonProgramFiles: win32.join(programFiles, "Common Files"),
		"CommonProgramFiles(x86)": win32.join(programFilesX86, "Common Files"),
		CommonProgramW6432: win32.join(programFilesW6432, "Common Files"),
		PSModulePath: [
			win32.join(programFiles, "WindowsPowerShell", "Modules"),
			win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
		].join(";"),
	});
	return Object.freeze({ ready: true, pathAdditionKeys: WINDOWS_STARTUP_TIMING_WINDOWS_PATH_KEYS, values });
}

export function validateWindowsStartupTimingMachinePaths(delta, operations = { lstat: lstatSync, realpath: realpathSync.native }) {
	if (!delta?.ready || delta.pathAdditionKeys !== WINDOWS_STARTUP_TIMING_WINDOWS_PATH_KEYS || Object.keys(delta.values).join("\0") !== WINDOWS_STARTUP_TIMING_WINDOWS_PATH_KEYS.join("\0")) return false;
	const values = delta.values;
	const modulePaths = typeof values.PSModulePath === "string" ? values.PSModulePath.split(";") : [];
	const systemRoot = modulePaths.length === 2 ? win32.dirname(win32.dirname(win32.dirname(win32.dirname(modulePaths[1])))) : undefined;
	const expected = [
		values.ProgramFiles, values["ProgramFiles(x86)"], values.ProgramW6432, systemRoot,
		values.CommonProgramFiles, values["CommonProgramFiles(x86)"], values.CommonProgramW6432, ...modulePaths,
	];
	if (!isValidatedWindowsMachineRoot(values.ProgramFiles, "Program Files")
		|| !isValidatedWindowsMachineRoot(values["ProgramFiles(x86)"], "Program Files \\(x86\\)")
		|| !isValidatedWindowsMachineRoot(values.ProgramW6432, "Program Files")
		|| !isValidatedWindowsMachineRoot(systemRoot, "Windows")
		|| values.CommonProgramFiles !== win32.join(values.ProgramFiles, "Common Files")
		|| values["CommonProgramFiles(x86)"] !== win32.join(values["ProgramFiles(x86)"], "Common Files")
		|| values.CommonProgramW6432 !== win32.join(values.ProgramW6432, "Common Files")
		|| modulePaths[0] !== win32.join(values.ProgramFiles, "WindowsPowerShell", "Modules")
		|| modulePaths[1] !== win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules")) return false;
	try {
		return expected.every((path) => {
			const entry = operations.lstat(path);
			return entry.isDirectory() && !entry.isSymbolicLink() && sameWindowsCanonicalPath(operations.realpath(path), path);
		});
	} catch { return false; }
}

function assertPackResult(packed, packDirectory, receipt) {
	selectUnhookedCheck(receipt, "pack-metadata");
	if (!Array.isArray(packed) || packed.length !== 1 || !packed[0] || typeof packed[0] !== "object") throw new Error("npm pack did not return exactly one package");
	const entry = packed[0];
	if (entry.name !== "gentle-pi" || typeof entry.filename !== "string" || entry.filename !== basename(entry.filename)) throw new Error("npm pack returned an unsafe package identity");
	if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) throw new Error("npm pack did not report a sha512 integrity");
	const tarball = resolve(packDirectory, entry.filename);
	if (!isWithin(packDirectory, tarball)) throw new Error("npm pack tarball escapes the owned pack directory");
	selectUnhookedCheck(receipt, "pack-integrity");
	assertOwnedRegularFile(packDirectory, entry.filename);
	const actualIntegrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
	if (actualIntegrity !== entry.integrity) throw new Error("npm pack tarball integrity does not match its reported identity");
	return { entry, tarball };
}

const HASHED_PACKED_ASSETS = [
	{ ownedCheckId: "asset-runtime-windows-session-transport-owned", hashCheckId: "asset-runtime-windows-session-transport-hash", relativePath: "runtime/windows-session-transport.ps1" },
	{ ownedCheckId: "asset-lib-windows-session-transport-owned", hashCheckId: "asset-lib-windows-session-transport-hash", relativePath: "lib/windows-session-transport.ts" },
	{ ownedCheckId: "asset-lib-agents-session-transport-owned", hashCheckId: "asset-lib-agents-session-transport-hash", relativePath: "lib/agents-session-transport.ts" },
	{ ownedCheckId: "asset-extension-gentle-agents-owned", hashCheckId: "asset-extension-gentle-agents-hash", relativePath: "extensions/gentle-agents.ts" },
	{ ownedCheckId: "asset-extension-gentle-ai-owned", hashCheckId: "asset-extension-gentle-ai-hash", relativePath: "extensions/gentle-ai.ts" },
	{ ownedCheckId: "asset-native-review-cli-owned", hashCheckId: "asset-native-review-cli-hash", relativePath: "runtime/native-review-cli.mjs" },
	{ ownedCheckId: "asset-review-integration-v2-owned", hashCheckId: "asset-review-integration-v2-hash", relativePath: "runtime/review-integration-v2.mjs" },
	{ ownedCheckId: "asset-installer-gentle-ai-owned", hashCheckId: "asset-installer-gentle-ai-hash", relativePath: "scripts/install-gentle-ai.mjs" },
	{ ownedCheckId: "asset-installer-tui-mode-setting-owned", hashCheckId: "asset-installer-tui-mode-setting-hash", relativePath: "scripts/install-tui-mode-setting.mjs" },
];

function assertPackedAssets(packageRoot, receipt) {
	for (const asset of HASHED_PACKED_ASSETS) {
		selectUnhookedCheck(receipt, asset.ownedCheckId);
		const installedPath = assertOwnedRegularFile(packageRoot, asset.relativePath);
		selectUnhookedCheck(receipt, asset.hashCheckId);
		const source = readFileSync(join(root, asset.relativePath));
		const installed = readFileSync(installedPath);
		if (createHash("sha256").update(source).digest("hex") !== createHash("sha256").update(installed).digest("hex")) throw new Error("packed asset bytes differ from this checkout");
	}
}

function assertNoNativeInstallerArtifacts(packageRoot, consumerDirectory, receipt) {
	selectUnhookedCheck(receipt, "native-package-cache-absent");
	if (existsSync(join(packageRoot, ".gentle-ai"))) throw new Error("unhooked install unexpectedly contains a native Gentle AI artifact");
	selectUnhookedCheck(receipt, "native-command-absent");
	const nativeCommand = process.platform === "win32" ? "gentle-ai.cmd" : "gentle-ai";
	if (existsSync(join(consumerDirectory, "node_modules", ".bin", nativeCommand))) throw new Error("unhooked install unexpectedly exposed a native Gentle AI executable");
}

function resolveInstalledJitiStaticEntry(consumerDirectory, sdkPackageJson, sdkVersion, selectCheck, checkIds) {
	selectCheck(checkIds.sdkManifest);
	const checkedSdkPackageJson = assertOwnedRegularFile(consumerDirectory, relative(consumerDirectory, sdkPackageJson));
	const sdkRequire = createRequire(checkedSdkPackageJson);
	selectCheck(checkIds.sdkVersion);
	const installedSdk = safeJson(readFileSync(checkedSdkPackageJson), "installed Pi SDK manifest");
	if (installedSdk.name !== "@earendil-works/pi-coding-agent" || installedSdk.version !== sdkVersion) throw new Error("consumer resolved an unexpected Pi SDK");
	const declaredJiti = installedSdk?.dependencies?.jiti;
	selectCheck(checkIds.jitiManifest);
	const jitiManifest = sdkRequire.resolve("jiti/package.json");
	const checkedJitiPackageJson = assertOwnedRegularFile(consumerDirectory, relative(consumerDirectory, jitiManifest));
	const jitiPackage = safeJson(readFileSync(checkedJitiPackageJson), "jiti package manifest");
	selectCheck(checkIds.jitiStaticExport);
	const staticExport = jitiPackage?.exports?.["./static"];
	if (staticExport === null || typeof staticExport !== "object" || Array.isArray(staticExport)
		|| Object.keys(staticExport).length !== 2 || typeof staticExport.types !== "string" || typeof staticExport.import !== "string") {
		throw new Error("Jiti manifest does not declare the expected static ESM export");
	}
	const jitiPackageRoot = dirname(checkedJitiPackageJson);
	selectCheck(checkIds.jitiEntry);
	const jitiStaticEntry = assertOwnedRegularFile(jitiPackageRoot, relative(jitiPackageRoot, resolve(jitiPackageRoot, staticExport.import)));
	selectCheck(checkIds.jitiVersion);
	if (jitiPackage.name !== "jiti" || typeof declaredJiti !== "string" || jitiPackage.version !== declaredJiti) throw new Error("consumer Jiti does not match the installed Pi SDK runtime dependency");
	return jitiStaticEntry;
}

function unhookedProbeSource(packageRoot, consumerPackageJson, jitiStaticEntry) {
	return `
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
const { createJiti } = await import(pathToFileURL(${JSON.stringify(jitiStaticEntry)}).href);
const jiti = createJiti(pathToFileURL(${JSON.stringify(consumerPackageJson)}).href, { moduleCache: false });
const registrations = { tools: [], commands: [], events: [] };
const events = new Proxy({}, { get(_target, property) { return (..._args) => { registrations.events.push(\`events.\${String(property)}\`); }; } });
const pi = {
  events,
  on(name, _handler) { registrations.events.push(String(name)); },
  registerTool(definition) { registrations.tools.push(String(definition.name)); },
  registerCommand(name, _definition) { registrations.commands.push(String(name)); },
  registerShortcut() {}, registerMessageRenderer() {}, registerEntryRenderer() {}, registerMarkdownTransformer() {},
};
async function register(relativePath) {
  const loaded = await jiti.import(new URL(relativePath, pathToFileURL(${JSON.stringify(`${packageRoot}/`)}).href).href, { default: true });
  const factory = typeof loaded === "function" ? loaded : loaded?.default;
  assert.equal(typeof factory, "function", \`missing default extension factory: \${relativePath}\`);
  await factory(pi);
}
await register("extensions/gentle-agents.ts");
await register("extensions/gentle-ai.ts");
for (const name of ["subagent_list_agents", "subagent_run", "orchestrator_session_id", "orchestrator_list", "orchestrator_send_message", "gentle_review", "gentle_review_capture", "gentle_review_capture_group", "gentle_review_scope"]) assert.ok(registrations.tools.includes(name), \`missing registered tool: \${name}\`);
for (const name of ["gentle:agents", "gentle:status", "gentle:review-mode"]) assert.ok(registrations.commands.includes(name), \`missing registered command: \${name}\`);
assert.ok(registrations.events.includes("session_start"), "expected session_start registration");
assert.ok(registrations.events.includes("session_shutdown"), "expected session_shutdown registration");
process.stdout.write(JSON.stringify({ tools: registrations.tools.sort(), commands: registrations.commands.sort(), loader: "Jiti from @earendil-works/pi-coding-agent dependency" }));
`;
}

function isSdkLifecycleChildStageCheck(stage, checkId) {
	const stageChecks = {
		"bootstrap": ["bootstrap-builtins", "bootstrap-agent-home", "bootstrap-directories"],
		"sdk-load": ["sdk-import", "sdk-exports"],
		"jiti-load": ["jiti-import"],
		"agents-module-load": ["agents-module-import", "agents-module-export"],
		"model-runtime": ["model-runtime-create"],
		"services": ["settings-untrusted", "settings-default-provider", "settings-default-model", "services-create", "services-settings-manager", "services-project-trusted"],
		"extensions-validate": ["extensions-errors", "extensions-paths", "extensions-hooks", "services-diagnostics", "ambient-skills", "ambient-prompts", "ambient-themes", "ambient-context-files"],
		"model-availability": ["model-availability-empty"],
		"session-create": ["session-create", "session-model-unbound"],
		"session-bind": ["session-model-unbound", "session-model-invocation-guard", "session-bind", "session-bind-extension-errors", "session-model-bound", "session-ids-distinct"],
		"presence-two": ["presence-observer-create", "presence-two-records", "presence-first-model-unbound", "presence-second-model-unbound", "presence-two-extension-errors"],
		"dispose-first": ["dispose-first", "dispose-first-extension-errors"],
		"presence-one": ["presence-one-record", "presence-one-model-unbound", "presence-one-extension-errors"],
		"dispose-second": ["dispose-second", "dispose-second-extension-errors"],
		"presence-none": ["presence-no-records", "presence-none-extension-errors"],
		"cleanup": ["cleanup-runtime", "cleanup-observer", "cleanup-extension-errors"],
	};
	return SDK_LIFECYCLE_CHILD_STAGES.has(stage) && SDK_LIFECYCLE_CHILD_CHECK_IDS.has(checkId) && stageChecks[stage].includes(checkId);
}

function parseWindowsRegistryObservation(value) {
	if (value === null) return null;
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
	const keys = ["availability", "provenance", "restoration", "startCalls", "initializeCalls", "cleanupCalls", "firstFailurePhase", "firstFailureClass", "firstFailureCode", "lastStartupMarker"];
	if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return undefined;
	const observation = value;
	if (observation.lastStartupMarker !== null && !SDK_LIFECYCLE_WINDOWS_STARTUP_MARKERS.has(observation.lastStartupMarker)) return undefined;
	if (!SDK_LIFECYCLE_WINDOWS_OBSERVATION_AVAILABILITY.has(observation.availability) || !SDK_LIFECYCLE_WINDOWS_OBSERVATION_PROVENANCE.has(observation.provenance) || !SDK_LIFECYCLE_WINDOWS_OBSERVATION_RESTORATION.has(observation.restoration)) return undefined;
	const nullDetails = ["startCalls", "initializeCalls", "cleanupCalls", "firstFailurePhase", "firstFailureClass", "firstFailureCode", "lastStartupMarker"];
	if (observation.availability !== "observed") {
		if ((observation.availability === "not-applicable" && (observation.provenance !== "not-applicable" || observation.restoration !== "not-applicable")) || (observation.availability === "unavailable" && (!["unavailable", "ambiguous"].includes(observation.provenance) || !["not-required", "not-attempted"].includes(observation.restoration))) || nullDetails.some((key) => observation[key] !== null)) return undefined;
		return Object.freeze({ ...observation });
	}
	if (observation.provenance !== "owned-instance" || observation.restoration !== "not-required") return undefined;
	for (const key of ["startCalls", "initializeCalls", "cleanupCalls"]) if (!Number.isInteger(observation[key]) || observation[key] < 0 || observation[key] > 1) return undefined;
	if (observation.startCalls !== 1 || observation.cleanupCalls !== 1 || (observation.initializeCalls !== 0 && observation.initializeCalls !== 1)) return undefined;
	const failureFields = [observation.firstFailurePhase, observation.firstFailureClass, observation.firstFailureCode];
	if (failureFields.every((field) => field === null)) return observation.initializeCalls === 1 ? Object.freeze({ ...observation }) : undefined;
	if (!SDK_LIFECYCLE_WINDOWS_OBSERVATION_PHASES.has(observation.firstFailurePhase) || !SDK_LIFECYCLE_WINDOWS_OBSERVATION_FAILURE_CLASSES.has(observation.firstFailureClass) || !SDK_LIFECYCLE_WINDOWS_OBSERVATION_ERROR_CODES.has(observation.firstFailureCode) || ((observation.firstFailureClass === "timed-out") !== (observation.firstFailureCode === "deadline"))) return undefined;
	return Object.freeze({ ...observation });
}

function parseSdkLifecycleChildReceipt(stdout, stderr) {
	if (!Buffer.isBuffer(stdout) || !Buffer.isBuffer(stderr) || stdout.length === 0 || stdout.length > MAX_SDK_LIFECYCLE_CHILD_REPORT_BYTES || stderr.length !== 0) return undefined;
	let parsed;
	try { parsed = JSON.parse(stdout.toString("utf8")); } catch { return undefined; }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) return undefined;
	const has = (key) => Object.prototype.hasOwnProperty.call(parsed, key);
	const progressKeys = ["sdkLoaded", "extensionErrorCount", "extensionErrorPhase", "modelInvocationCount", "agentStartEventCount", "turnStartEventCount", "sessionsStarted", "presenceAfterStart", "presenceAfterFirstDispose", "presenceAfterSecondDispose", "disposedSessions", "windowsRegistryObservation"];
	const baseKeys = ["status", "stage", "checkId", "cleanupStatus"];
	if (!has("status") || !has("stage") || !has("checkId") || !has("cleanupStatus") || !SDK_LIFECYCLE_CHILD_STAGES.has(parsed.stage) || !SDK_LIFECYCLE_CHILD_CHECK_IDS.has(parsed.checkId) || !isSdkLifecycleChildStageCheck(parsed.stage, parsed.checkId) || !SDK_LIFECYCLE_CHILD_CLEANUP_STATUSES.has(parsed.cleanupStatus)) return undefined;
	const allowed = new Set([...baseKeys, ...progressKeys, "code"]);
	if (Object.keys(parsed).some((key) => !allowed.has(key))) return undefined;
	if (parsed.status !== "complete" && parsed.status !== "failed") return undefined;
	if (parsed.status === "complete") {
		const completeKeys = new Set([...baseKeys, ...progressKeys]);
		if (Object.keys(parsed).length !== completeKeys.size || Object.keys(parsed).some((key) => !completeKeys.has(key)) || parsed.stage !== "presence-none" || parsed.checkId !== "presence-none-extension-errors" || parsed.cleanupStatus !== "complete") return undefined;
	} else if (!has("code") || !SDK_LIFECYCLE_CHILD_ERROR_CODES.has(parsed.code)) return undefined;
	if (has("sdkLoaded") && parsed.sdkLoaded !== true) return undefined;
	const extensionObserved = has("extensionErrorCount") || has("extensionErrorPhase");
	if (extensionObserved && (!has("extensionErrorCount") || !has("extensionErrorPhase") || !Number.isInteger(parsed.extensionErrorCount) || parsed.extensionErrorCount < 0 || parsed.extensionErrorCount > 2 || !SDK_LIFECYCLE_EXTENSION_ERROR_PHASES.has(parsed.extensionErrorPhase) || parsed.extensionErrorPhase === "unobserved")) return undefined;
	const invocationObserved = has("modelInvocationCount") || has("agentStartEventCount") || has("turnStartEventCount");
	if (invocationObserved && (!has("modelInvocationCount") || !has("agentStartEventCount") || !has("turnStartEventCount") || !Number.isInteger(parsed.modelInvocationCount) || !Number.isInteger(parsed.agentStartEventCount) || !Number.isInteger(parsed.turnStartEventCount) || parsed.modelInvocationCount < 0 || parsed.modelInvocationCount > 2 || parsed.agentStartEventCount < 0 || parsed.agentStartEventCount > 2 || parsed.turnStartEventCount < 0 || parsed.turnStartEventCount > 2)) return undefined;
	if (parsed.status === "failed" && parsed.code === "forbidden-model-invocation" && (!invocationObserved || parsed.modelInvocationCount === 0)) return undefined;
	const windowsRegistryObservation = has("windowsRegistryObservation") ? parseWindowsRegistryObservation(parsed.windowsRegistryObservation) : undefined;
	if (has("windowsRegistryObservation") && windowsRegistryObservation === undefined) return undefined;
	if (parsed.status === "complete" && (windowsRegistryObservation === undefined || windowsRegistryObservation === null || !((windowsRegistryObservation.availability === "not-applicable" && windowsRegistryObservation.restoration === "not-applicable") || (windowsRegistryObservation.availability === "observed" && windowsRegistryObservation.provenance === "owned-instance" && windowsRegistryObservation.restoration === "not-required" && windowsRegistryObservation.startCalls === 1 && windowsRegistryObservation.initializeCalls === 1 && windowsRegistryObservation.cleanupCalls === 1 && windowsRegistryObservation.firstFailurePhase === null && windowsRegistryObservation.firstFailureClass === null && windowsRegistryObservation.firstFailureCode === null && windowsRegistryObservation.lastStartupMarker === "native-ready")))) return undefined;
	for (const key of ["sessionsStarted", "presenceAfterStart", "presenceAfterFirstDispose", "presenceAfterSecondDispose", "disposedSessions"]) {
		if (has(key) && (!Number.isInteger(parsed[key]) || parsed[key] < 0 || parsed[key] > 2)) return undefined;
	}
	if (parsed.status === "complete" && (parsed.sdkLoaded !== true || parsed.extensionErrorCount !== 0 || parsed.extensionErrorPhase !== "none" || parsed.modelInvocationCount !== 0 || parsed.agentStartEventCount !== 0 || parsed.turnStartEventCount !== 0 || parsed.sessionsStarted !== 2 || parsed.presenceAfterStart !== 2 || parsed.presenceAfterFirstDispose !== 1 || parsed.presenceAfterSecondDispose !== 0 || parsed.disposedSessions !== 2)) return undefined;
	const receipt = { status: parsed.status, stage: parsed.stage, checkId: parsed.checkId, cleanupStatus: parsed.cleanupStatus };
	if (parsed.status === "failed") receipt.childFailureCode = parsed.code;
	if (has("sdkLoaded")) receipt.sdkLoaded = true;
	if (extensionObserved) {
		receipt.extensionErrorCount = parsed.extensionErrorCount;
		receipt.extensionErrorPhase = parsed.extensionErrorPhase;
	}
	if (invocationObserved) {
		receipt.modelInvocationCount = parsed.modelInvocationCount;
		receipt.agentStartEventCount = parsed.agentStartEventCount;
		receipt.turnStartEventCount = parsed.turnStartEventCount;
	}
	for (const key of ["sessionsStarted", "presenceAfterStart", "presenceAfterFirstDispose", "presenceAfterSecondDispose", "disposedSessions"]) if (has(key)) receipt[key] = parsed[key];
	if (has("windowsRegistryObservation")) receipt.windowsRegistryObservation = windowsRegistryObservation;
	return receipt;
}

function mergeSdkLifecycleChildProgress(receipt, childReceipt) {
	receipt.childReceiptObserved = true;
	if (childReceipt.sdkLoaded !== undefined) receipt.sdkLoaded = childReceipt.sdkLoaded;
	if (childReceipt.extensionErrorCount !== undefined) {
		receipt.extensionErrorCount = childReceipt.extensionErrorCount;
		receipt.extensionErrorPhase = childReceipt.extensionErrorPhase;
	}
	if (childReceipt.modelInvocationCount !== undefined) receipt.modelInvocationCount = childReceipt.modelInvocationCount;
	if (childReceipt.agentStartEventCount !== undefined) receipt.agentStartEventCount = childReceipt.agentStartEventCount;
	if (childReceipt.turnStartEventCount !== undefined) receipt.turnStartEventCount = childReceipt.turnStartEventCount;
	if (childReceipt.sessionsStarted !== undefined) receipt.sessionsStarted = childReceipt.sessionsStarted;
	if (childReceipt.presenceAfterStart !== undefined) receipt.presenceAfterStart = childReceipt.presenceAfterStart;
	if (childReceipt.presenceAfterFirstDispose !== undefined) receipt.presenceAfterFirstDispose = childReceipt.presenceAfterFirstDispose;
	if (childReceipt.presenceAfterSecondDispose !== undefined) receipt.presenceAfterSecondDispose = childReceipt.presenceAfterSecondDispose;
	if (childReceipt.disposedSessions !== undefined) receipt.disposedSessions = childReceipt.disposedSessions;
	if (childReceipt.windowsRegistryObservation !== undefined) receipt.windowsRegistryObservation = childReceipt.windowsRegistryObservation;
}

function sdkLifecycleProbeSource(packageRoot, consumerPackageJson, jitiStaticEntry) {
	return `
// One bind permits default start (30s), initialize (2s), and listen (2s); its
// remaining 6s covers SDK lifecycle/error observation. Listen owns publication.
const SDK_LIFECYCLE_WINDOWS_BIND_DEADLINE_MS = 30_000 + 2_000 + 2_000 + 6_000;
// A registry failure may need default start/initialize, shutdown (2s), two 500ms
// cleanup graces, and phase-event propagation before this verification watchdog expires.
const SDK_LIFECYCLE_WINDOWS_REGISTRY_DEADLINE_MS = 30_000 + 2_000 + 2_000 + 2 * 500 + 5_000;
const SDK_LIFECYCLE_WINDOWS_LIST_DEADLINE_MS = 2_000;
const progress = {};
let childStage = "bootstrap";
let childCheckId = "bootstrap-builtins";
let primaryFailure;
let cleanupFailure;
let completedCheckpoint;
let cleanupStatus = "complete";
let firstRuntime;
let secondRuntime;
let firstInvocationGuard;
    let secondInvocationGuard;
    let observer;
        let windowsRegistryObservation;
let extensionErrorPhase = "startup";
let extensionErrorCount = 0;
let extensionErrorsActive = true;
let extensionLifecycleObserved = false;
let assert;
let mkdirSync;
let join;
let pathToFileURL;
    let settingsManager;
const checkpoint = (stage, checkId) => { childStage = stage; childCheckId = checkId; };
const recordCleanupFailure = (checkId) => {
  cleanupStatus = "failed";
  if (cleanupFailure === undefined) cleanupFailure = { stage: "cleanup", checkId, code: "cleanup-failed" };
};
const FORBIDDEN_MODEL_INVOCATION = "forbidden-model-invocation";
    const OBSERVATION_INVALID = "observation-invalid";
    const failureCode = (error, fallback = "assertion-failed") => error?.childReceiptCode === FORBIDDEN_MODEL_INVOCATION ? FORBIDDEN_MODEL_INVOCATION : error?.childReceiptCode === OBSERVATION_INVALID ? OBSERVATION_INVALID : error?.childReceiptCode === "timed-out" ? "timed-out" : error?.childReceiptCode === "load-failed" ? "load-failed" : fallback;
const load = async (operation) => {
  try { return await operation; } catch { throw { childReceiptCode: "load-failed" }; }
};
const within = async (operation, milliseconds) => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject({ childReceiptCode: "timed-out" }), milliseconds); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const newWindowsRegistryObservation = (availability, provenance, restoration) => ({ availability, provenance, restoration, startCalls: null, initializeCalls: null, cleanupCalls: null, firstFailurePhase: null, firstFailureClass: null, firstFailureCode: null, lastStartupMarker: null });
    const createWindowsRegistryObservation = (PhaseSequence) => {
      if (process.platform === "win32") return new PhaseSequence();
      return { observe() { return undefined; }, startupSucceeded: true, cleanupComplete: true, admitsFullSuccess: true, snapshot: () => newWindowsRegistryObservation("not-applicable", "not-applicable", "not-applicable") };
    };
    const recordExtensionError = () => {
  if (!extensionErrorsActive) return;
  extensionLifecycleObserved = true;
  extensionErrorCount = Math.min(2, extensionErrorCount + 1);
  progress.extensionErrorCount = extensionErrorCount;
  progress.extensionErrorPhase = extensionErrorPhase;
};
const assertNoExtensionErrors = () => assert.equal(extensionErrorCount, 0, "packaged extension lifecycle error");
const confirmNoExtensionErrors = () => {
  assertNoExtensionErrors();
  if (!extensionLifecycleObserved) return;
  progress.extensionErrorCount = 0;
  progress.extensionErrorPhase = "none";
};
const disposeRuntime = async (runtime, settingsManager, invocationGuard, disposeStage, runtimeCheckId, extensionCheckId) => {
  if (!runtime) return;
      const stableDisposeStage = disposeStage;
      const stableRuntimeCheckId = runtimeCheckId;
      const stableExtensionCheckId = extensionCheckId;
      checkpoint(stableDisposeStage, stableRuntimeCheckId);
      extensionErrorPhase = "shutdown";
      let completedDisposal = false;
      try {
  assertNoConfiguredModel(runtime, settingsManager, "session must remain unconfigured through disposal");
        try {
          await within(runtime.dispose(), 15000);
        } catch (error) {
          invocationGuard.assertNotInvoked("session-bind", "session-model-invocation-guard");
          throw error;
        }
  checkpoint(stableDisposeStage, stableExtensionCheckId);
  confirmNoExtensionErrors();
  invocationGuard.assertNotInvoked("session-bind", "session-model-invocation-guard");
      invocationGuard.detachAfterSuccessfulDispose();
      progress.disposedSessions = (progress.disposedSessions ?? 0) + 1;
      completedDisposal = true;
      } finally {
        if (!completedDisposal) { /* Keep the deny stream guard and observer attached until process exit. */ }
      }
};
const INERT_DEFAULT_MODEL = {
      id: "unknown",
      name: "unknown",
      api: "unknown",
      provider: "unknown",
      baseUrl: "",
      reasoning: false,
      input: [],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      maxTokens: 0,
    };
    const assertNeutralInitializedSessionHistory = (runtime, description) => {
      // getEntries excludes the SDK session header; a new session adds neutral initialization metadata after the pre-creation no-restored-history assertion.
      const entries = runtime.session.sessionManager.getEntries();
      assert.equal(entries.length, 1, description + ": session history after creation must contain only neutral SDK initialization metadata");
      const [entry] = entries;
      assert.equal(entry.type, "thinking_level_change", description + ": session history after creation must not contain restored messages, model changes, or custom entries");
      assert.equal(entry.thinkingLevel, "off", description + ": neutral SDK initialization metadata must set thinking level off");
      const context = runtime.session.sessionManager.buildSessionContext();
      assert.deepEqual(context.messages, [], description + ": neutral SDK initialization metadata must not add context messages");
      assert.equal(context.model, null, description + ": neutral SDK initialization metadata must not select a model");
    };
    const assertNoConfiguredModel = (runtime, settingsManager, description) => {
      assertNeutralInitializedSessionHistory(runtime, description);
      assert.equal(settingsManager.getDefaultProvider(), undefined, description + ": in-memory settings must have no default provider");
      assert.equal(settingsManager.getDefaultModel(), undefined, description + ": in-memory settings must have no default model");
      assert.equal(runtime.services.modelRuntime.getAvailableSnapshot().length, 0, description + ": owned empty auth and model paths must expose no available models");
      assert.deepEqual(runtime.session.model, INERT_DEFAULT_MODEL, description + ": session must expose the SDK inert no-configured-model sentinel");
    };
    const installForbiddenModelInvocationGuard = (runtime) => {
      const agent = runtime.session.agent;
            if (progress.modelInvocationCount === undefined) progress.modelInvocationCount = 0;
          if (progress.agentStartEventCount === undefined) progress.agentStartEventCount = 0;
          if (progress.turnStartEventCount === undefined) progress.turnStartEventCount = 0;
      const guardedStreamFunction = (..._args) => {
        progress.modelInvocationCount = Math.min(2, progress.modelInvocationCount + 1);
        throw { childReceiptCode: FORBIDDEN_MODEL_INVOCATION };
      };
      const unsubscribe = agent.subscribe((event) => {
        if (event.type === "agent_start") progress.agentStartEventCount = Math.min(2, progress.agentStartEventCount + 1);
        if (event.type === "turn_start") progress.turnStartEventCount = Math.min(2, progress.turnStartEventCount + 1);
      });
      agent.streamFunction = guardedStreamFunction;
      return {
        assertNotInvoked: (stage, checkId) => {
          if (progress.modelInvocationCount !== 0) {
              checkpoint(stage, checkId);
              throw { childReceiptCode: FORBIDDEN_MODEL_INVOCATION };
            }
          if (progress.agentStartEventCount !== 0 || progress.turnStartEventCount !== 0) {
              checkpoint(stage, checkId);
              throw { childReceiptCode: "assertion-failed" };
            }
        },
        detachAfterSuccessfulDispose: () => {
          unsubscribe();
        },
      };
    };
    const bindRuntime = async (runtime, settingsManager, invocationGuard) => {
  checkpoint("session-bind", "session-model-unbound");
  assertNoConfiguredModel(runtime, settingsManager, "session must not configure a model before binding");
  checkpoint("session-bind", "session-bind");
  extensionErrorPhase = "startup";
  extensionLifecycleObserved = true;
  await within(runtime.session.bindExtensions({ mode: "json", onError: recordExtensionError }), SDK_LIFECYCLE_WINDOWS_BIND_DEADLINE_MS);
  checkpoint("session-bind", "session-bind-extension-errors");
      invocationGuard.assertNotInvoked("session-bind", "session-model-invocation-guard");
  confirmNoExtensionErrors();
  checkpoint("session-bind", "session-model-bound");
  assertNoConfiguredModel(runtime, settingsManager, "session must remain unconfigured after JSON lifecycle startup");
  progress.sessionsStarted = (progress.sessionsStarted ?? 0) + 1;
};
try {
  checkpoint("bootstrap", "bootstrap-builtins");
  const [assertModule, fsModule, pathModule, urlModule] = await load(Promise.all([import("node:assert/strict"), import("node:fs"), import("node:path"), import("node:url")]));
  assert = assertModule.default;
  ({ mkdirSync } = fsModule);
  ({ join } = pathModule);
  ({ pathToFileURL } = urlModule);
  checkpoint("bootstrap", "bootstrap-agent-home");
  const agentHome = process.env.GENTLE_PI_AGENT_HOME;
  assert.equal(typeof agentHome, "string");
  checkpoint("bootstrap", "bootstrap-directories");
  const probeRoot = join(process.cwd(), "sdk-lifecycle-probe");
  const cwd = join(probeRoot, "cwd");
  const sessionRoot = join(probeRoot, "sessions");
  const modelRoot = join(probeRoot, "model-runtime");
  for (const path of [probeRoot, cwd, sessionRoot, modelRoot, agentHome, join(agentHome, "gentle-agents")]) mkdirSync(path, { recursive: true });
  checkpoint("sdk-load", "sdk-import");
  const sdk = await within(load(import("@earendil-works/pi-coding-agent")), 30000);
  progress.sdkLoaded = true;
  checkpoint("sdk-load", "sdk-exports");
  const { createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } = sdk;
  for (const value of [createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager]) assert.equal(typeof value, "function", "SDK lifecycle export is unavailable");
  checkpoint("jiti-load", "jiti-import");
  const { createJiti } = await within(load(import(pathToFileURL(${JSON.stringify(jitiStaticEntry)}).href)), 30000);
  assert.equal(typeof createJiti, "function", "Jiti static export is unavailable");
  const jiti = createJiti(pathToFileURL(${JSON.stringify(consumerPackageJson)}).href, { moduleCache: false });
  const agentsExtensionPath = join(${JSON.stringify(packageRoot)}, "extensions", "gentle-agents.ts");
  const gentleAiExtensionPath = join(${JSON.stringify(packageRoot)}, "extensions", "gentle-ai.ts");
  checkpoint("agents-module-load", "agents-module-import");
  const { createDefaultSessionTransport } = await within(load(jiti.import(pathToFileURL(agentsExtensionPath).href)), 30000);
  checkpoint("agents-module-load", "agents-module-export");
  assert.equal(typeof createDefaultSessionTransport, "function", "packaged agents transport export is unavailable");
      const { WindowsSessionRegistryPhaseSequence } = await within(load(jiti.import(pathToFileURL(join(${JSON.stringify(packageRoot)}, "lib", "windows-session-transport.ts")).href)), 30000);
      assert.equal(typeof WindowsSessionRegistryPhaseSequence, "function", "packaged Windows phase sequence export is unavailable");
  const expectedExtensionPaths = [agentsExtensionPath, gentleAiExtensionPath];
  checkpoint("services", "settings-untrusted");
  settingsManager = SettingsManager.inMemory({}, { projectTrusted: false });
  assert.equal(settingsManager.isProjectTrusted(), false, "in-memory settings must keep project discovery untrusted");
  checkpoint("services", "settings-default-provider");
  assert.equal(settingsManager.getDefaultProvider(), undefined, "in-memory settings must have no default provider");
  checkpoint("services", "settings-default-model");
  assert.equal(settingsManager.getDefaultModel(), undefined, "in-memory settings must have no default model");
  const createRuntime = (name) => async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
    checkpoint("session-create", "session-create");
    assert.equal(sessionManager.getEntries().length, 0, "new SDK session must not restore prior entries");
    checkpoint("model-runtime", "model-runtime-create");
    const runtimeRoot = join(modelRoot, name);
    mkdirSync(runtimeRoot, { recursive: true });
    const modelRuntime = await within(ModelRuntime.create({
      authPath: join(runtimeRoot, "auth.json"),
      modelsPath: join(runtimeRoot, "models.json"),
      modelsStorePath: join(runtimeRoot, "models-store.json"),
      refreshOnCreate: false,
    }), 30000);
    checkpoint("services", "services-create");
    const services = await within(createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: agentHome,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        additionalExtensionPaths: expectedExtensionPaths,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    }), 30000);
    checkpoint("services", "services-settings-manager");
    assert.strictEqual(services.settingsManager, settingsManager, "services must retain the shared untrusted settings manager");
    checkpoint("services", "services-project-trusted");
    assert.equal(services.settingsManager.isProjectTrusted(), false, "services must keep project discovery untrusted");
    checkpoint("extensions-validate", "extensions-errors");
    const loaded = services.resourceLoader.getExtensions();
    assert.equal(loaded.errors.length, 0, "packaged extension load must not report errors");
    checkpoint("extensions-validate", "extensions-paths");
    assert.deepEqual(loaded.extensions.map((extension) => extension.resolvedPath), expectedExtensionPaths, "only the two packaged extensions may load");
    checkpoint("extensions-validate", "extensions-hooks");
    assert.deepEqual(loaded.extensions.map((extension) => extension.handlers.has("session_start") && extension.handlers.has("session_shutdown")), [true, true], "both packaged extensions must expose lifecycle hooks");
    checkpoint("extensions-validate", "services-diagnostics");
    assert.equal(services.diagnostics.length, 0, "packaged extension service setup must not report errors");
    checkpoint("extensions-validate", "ambient-skills");
    assert.deepEqual(services.resourceLoader.getSkills().skills, [], "ambient skills must stay disabled");
    checkpoint("extensions-validate", "ambient-prompts");
    assert.deepEqual(services.resourceLoader.getPrompts().prompts, [], "ambient prompts must stay disabled");
    checkpoint("extensions-validate", "ambient-themes");
    assert.deepEqual(services.resourceLoader.getThemes().themes, [], "ambient themes must stay disabled");
    checkpoint("extensions-validate", "ambient-context-files");
    assert.deepEqual(services.resourceLoader.getAgentsFiles().agentsFiles, [], "ambient context files must stay disabled");
    checkpoint("model-availability", "model-availability-empty");
    assert.equal(modelRuntime.getAvailableSnapshot().length, 0, "owned empty auth and model paths must expose no available models");
    checkpoint("session-create", "session-create");
    const created = await within(createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, noTools: "all" }), 30000);
    checkpoint("session-create", "session-model-unbound");
    const runtime = { ...created, services, diagnostics: services.diagnostics };
        assertNoConfiguredModel(runtime, settingsManager, "new SDK session");
        const invocationGuard = installForbiddenModelInvocationGuard(runtime);
        if (name === "first") firstInvocationGuard = invocationGuard;
        else secondInvocationGuard = invocationGuard;
    return runtime;
  };
  checkpoint("session-create", "session-create");
  firstRuntime = await within(createAgentSessionRuntime(createRuntime("first"), {
    cwd,
    agentDir: agentHome,
    sessionManager: SessionManager.create(cwd, join(sessionRoot, "first")),
  }), 30000);
  await bindRuntime(firstRuntime, settingsManager, firstInvocationGuard);
  checkpoint("session-create", "session-create");
  secondRuntime = await within(createAgentSessionRuntime(createRuntime("second"), {
    cwd,
    agentDir: agentHome,
    sessionManager: SessionManager.create(cwd, join(sessionRoot, "second")),
  }), 30000);
  await bindRuntime(secondRuntime, settingsManager, secondInvocationGuard);
  checkpoint("session-bind", "session-ids-distinct");
  const firstId = firstRuntime.session.sessionId;
  const secondId = secondRuntime.session.sessionId;
  assert.notEqual(firstId, secondId, "SDK must create distinct real session IDs");
  checkpoint("presence-two", "presence-observer-create");
  windowsRegistryObservation = createWindowsRegistryObservation(WindowsSessionRegistryPhaseSequence);
      let windowsRegistryFailure;
      try {
        observer = await within(createDefaultSessionTransport(process.platform).createRegistry(agentHome, (event) => windowsRegistryObservation.observe(event)), SDK_LIFECYCLE_WINDOWS_REGISTRY_DEADLINE_MS);
          } catch (error) {
            windowsRegistryFailure = error;
      } finally {
        progress.windowsRegistryObservation = windowsRegistryObservation.snapshot();
      }
  if (windowsRegistryFailure !== undefined) throw windowsRegistryFailure;
      if (!windowsRegistryObservation.startupSucceeded) throw { childReceiptCode: OBSERVATION_INVALID };
      checkpoint("presence-two", "presence-two-records");
  const started = await within(observer.listActivations(), SDK_LIFECYCLE_WINDOWS_LIST_DEADLINE_MS);
  assert.deepEqual(started.map((record) => record.sessionId).sort(), [firstId, secondId].sort(), "default transport must advertise both SDK sessions");
  progress.presenceAfterStart = started.length;
  checkpoint("presence-two", "presence-first-model-unbound");
  assertNoConfiguredModel(firstRuntime, settingsManager, "first session must remain unconfigured through presence lifecycle");
      firstInvocationGuard.assertNotInvoked("session-bind", "session-model-invocation-guard");
  checkpoint("presence-two", "presence-second-model-unbound");
  assertNoConfiguredModel(secondRuntime, settingsManager, "second session must remain unconfigured through presence lifecycle");
      secondInvocationGuard.assertNotInvoked("session-bind", "session-model-invocation-guard");
  checkpoint("presence-two", "presence-two-extension-errors");
  confirmNoExtensionErrors();
  checkpoint("dispose-first", "dispose-first");
  await disposeRuntime(firstRuntime, settingsManager, firstInvocationGuard, "dispose-first", "dispose-first", "dispose-first-extension-errors");
  firstRuntime = undefined;
  checkpoint("presence-one", "presence-one-record");
  const afterFirstDispose = await within(observer.listActivations(), SDK_LIFECYCLE_WINDOWS_LIST_DEADLINE_MS);
  assert.deepEqual(afterFirstDispose.map((record) => record.sessionId), [secondId], "disposing one runtime must withdraw only its presence");
  progress.presenceAfterFirstDispose = afterFirstDispose.length;
  checkpoint("presence-one", "presence-one-model-unbound");
  assertNoConfiguredModel(secondRuntime, settingsManager, "surviving session must remain unconfigured after peer withdrawal");
      secondInvocationGuard.assertNotInvoked("session-bind", "session-model-invocation-guard");
  checkpoint("presence-one", "presence-one-extension-errors");
  confirmNoExtensionErrors();
  checkpoint("dispose-second", "dispose-second");
  await disposeRuntime(secondRuntime, settingsManager, secondInvocationGuard, "dispose-second", "dispose-second", "dispose-second-extension-errors");
  secondRuntime = undefined;
  checkpoint("presence-none", "presence-no-records");
  const afterSecondDispose = await within(observer.listActivations(), SDK_LIFECYCLE_WINDOWS_LIST_DEADLINE_MS);
  assert.deepEqual(afterSecondDispose, [], "disposing both runtimes must withdraw both presence records");
  progress.presenceAfterSecondDispose = afterSecondDispose.length;
  checkpoint("presence-none", "presence-none-extension-errors");
  confirmNoExtensionErrors();
  completedCheckpoint = { stage: childStage, checkId: childCheckId };
} catch (error) {
  primaryFailure = { stage: childStage, checkId: childCheckId, code: failureCode(error) };
} finally {
  checkpoint("cleanup", "cleanup-runtime");
  try { await disposeRuntime(firstRuntime, settingsManager, firstInvocationGuard, "cleanup", "cleanup-runtime", "cleanup-runtime"); } catch { recordCleanupFailure("cleanup-runtime"); }
  try { await disposeRuntime(secondRuntime, settingsManager, secondInvocationGuard, "cleanup", "cleanup-runtime", "cleanup-runtime"); } catch { recordCleanupFailure("cleanup-runtime"); }
  checkpoint("cleanup", "cleanup-observer");
  try { await within(Promise.resolve(observer?.close?.()), 15000); } catch { recordCleanupFailure("cleanup-observer"); }
      try {
        if (windowsRegistryObservation !== undefined) {
          progress.windowsRegistryObservation = windowsRegistryObservation.snapshot();
          if (!windowsRegistryObservation.cleanupComplete || (primaryFailure === undefined && !windowsRegistryObservation.admitsFullSuccess)) recordCleanupFailure("cleanup-observer");
        }
      } catch { recordCleanupFailure("cleanup-observer"); }
  checkpoint("cleanup", "cleanup-extension-errors");
  try { assertNoExtensionErrors(); } catch { recordCleanupFailure("cleanup-extension-errors"); }
  extensionErrorsActive = false;
  if (primaryFailure === undefined && cleanupFailure !== undefined) primaryFailure = cleanupFailure;
}
const report = {
  status: primaryFailure === undefined ? "complete" : "failed",
  stage: primaryFailure?.stage ?? completedCheckpoint?.stage ?? childStage,
  checkId: primaryFailure?.checkId ?? completedCheckpoint?.checkId ?? childCheckId,
  cleanupStatus,
  ...progress,
  ...(primaryFailure === undefined ? {} : { code: primaryFailure.code }),
};
const line = JSON.stringify(report);
const boundedLine = Buffer.byteLength(line, "utf8") <= ${MAX_SDK_LIFECYCLE_CHILD_REPORT_BYTES}
  ? line
  : '{"status":"failed","stage":"cleanup","checkId":"cleanup-runtime","cleanupStatus":"failed","code":"unknown"}';
try { process.stdout.write(boundedLine); } catch { process.exitCode = 1; }
if (boundedLine !== line || primaryFailure !== undefined) process.exitCode = 1;
`;
}

async function testSdkLifecyclePackedSession() {
	const receipt = newSdkLifecycleReceipt();
	let temporary;
	let stage = "pack";
	let failure;
	try {
		selectSdkLifecycleCheck(receipt, "runner-hosted");
		if (process.env.RUNNER_ENVIRONMENT !== "github-hosted") throw new SdkLifecycleFailure("pack", "assertion-failed");
		selectSdkLifecycleCheck(receipt, "runner-temp");
		const runnerTemp = process.env.RUNNER_TEMP;
		if (typeof runnerTemp !== "string" || runnerTemp.length === 0) throw new SdkLifecycleFailure("pack", "assertion-failed");
		selectSdkLifecycleCheck(receipt, "temporary-root");
		temporary = mkdtempSync(join(resolve(runnerTemp), "gentle-pi-sdk-lifecycle-"));
		const packDirectory = join(temporary, "pack");
		const consumerDirectory = join(temporary, "consumer");
		mkdirSync(packDirectory);
		mkdirSync(consumerDirectory);
		const { env } = isolatedUnhookedEnvironment(temporary);
		Object.assign(env, { GENTLE_PI_AGENTS: "1", PI_OFFLINE: "1" });
		selectSdkLifecycleCheck(receipt, "project-sdk-version");
		const manifest = safeJson(readFileSync(join(root, "package.json")), "project package manifest");
		const sdkVersion = manifest?.devDependencies?.["@earendil-works/pi-coding-agent"];
		if (sdkVersion !== "0.85.1") throw new Error("SDK lifecycle probe requires the project-pinned Pi SDK");
		selectSdkLifecycleCheck(receipt, "pack-command");
		const packed = safeJson(runBoundedNpm("pack", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory], env, root), "npm pack output");
		stage = "pack-result";
		selectSdkLifecycleCheck(receipt, "pack-metadata");
		const { tarball } = assertPackResult(packed, packDirectory, { checkId: "pack-metadata" });
		selectSdkLifecycleCheck(receipt, "pack-integrity");
		receipt.packVerified = true;
		stage = "install";
		selectSdkLifecycleCheck(receipt, "install-command");
		writeFileSync(join(consumerDirectory, "package.json"), JSON.stringify({ name: "gentle-pi-sdk-lifecycle-proof", private: true, dependencies: { "@earendil-works/pi-coding-agent": sdkVersion } }), "utf8");
		runBoundedNpm("install", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--omit=dev", "--legacy-peer-deps", tarball, `@earendil-works/pi-coding-agent@${sdkVersion}`], env, consumerDirectory);
		receipt.installCompleted = true;
		stage = "artifact-check";
		const packageRoot = join(consumerDirectory, "node_modules", "gentle-pi");
		selectSdkLifecycleCheck(receipt, "packed-assets");
		assertPackedAssets(packageRoot, { checkId: "asset-runtime-windows-session-transport-owned" });
		selectSdkLifecycleCheck(receipt, "native-artifacts");
		assertNoNativeInstallerArtifacts(packageRoot, consumerDirectory, { checkId: "native-package-cache-absent" });
		const sdkPackageJson = join(consumerDirectory, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
		const jitiStaticEntry = resolveInstalledJitiStaticEntry(consumerDirectory, sdkPackageJson, sdkVersion, (checkId) => selectSdkLifecycleCheck(receipt, checkId), {
			sdkManifest: "sdk-manifest", sdkVersion: "sdk-version", jitiManifest: "jiti-manifest-owned",
			jitiStaticExport: "jiti-static-export", jitiEntry: "jiti-entry-owned", jitiVersion: "jiti-version",
		});
		stage = "lifecycle-probe";
		selectSdkLifecycleCheck(receipt, "lifecycle-probe-command");
		const probe = await runBoundedSdkLifecycleProbe(["--input-type=module", "--eval", sdkLifecycleProbeSource(packageRoot, join(consumerDirectory, "package.json"), jitiStaticEntry)], env, consumerDirectory);
		stage = "lifecycle-result";
		selectSdkLifecycleCheck(receipt, "lifecycle-probe-result");
		const lifecycle = parseSdkLifecycleChildReceipt(probe.stdout, probe.stderr);
		if (lifecycle === undefined) throw new Error("SDK lifecycle probe returned an invalid receipt");
		mergeSdkLifecycleChildProgress(receipt, lifecycle);
		if (probe.status !== 0) throw new SdkLifecycleFailure("lifecycle-probe", "nonzero-exit", probe.status, lifecycle);
		if (lifecycle.status !== "complete") throw new SdkLifecycleFailure("lifecycle-probe", "nonzero-exit", undefined, lifecycle);
		selectSdkLifecycleCheck(receipt, "sdk-lifecycle-complete");
	} catch (error) {
		if (error instanceof SdkLifecycleFailure) failure = error;
		else if (error instanceof UnhookedFailure) failure = new SdkLifecycleFailure(stage, error.code, error.exitStatus);
		else failure = new SdkLifecycleFailure(stage, stage === "lifecycle-result" ? "invalid-result" : "assertion-failed");
	}
	if (temporary !== undefined) {
		try {
			if (failure === undefined) selectSdkLifecycleCheck(receipt, "cleanup-owned-root-removal");
			rmSync(temporary, { recursive: true, force: true });
			receipt.cleanupCompleted = !existsSync(temporary);
			if (!receipt.cleanupCompleted) throw new Error("owned temporary root remains after cleanup");
		} catch {
			if (failure === undefined) failure = new SdkLifecycleFailure("cleanup", "cleanup-failed");
		}
	}
	return { receipt, failure };
}

async function testWindowsStartupTimingPackedHelper() {
	const receipt = newWindowsStartupTimingReceipt();
	let temporary;
	let stage = "pack";
	let failure;
	try {
		selectWindowsStartupTimingCheck(receipt, "runner-hosted");
		if (process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.platform !== "win32") throw new WindowsStartupTimingFailure("pack", "assertion-failed");
		selectWindowsStartupTimingCheck(receipt, "runner-temp");
		const runnerTemp = process.env.RUNNER_TEMP;
		if (typeof runnerTemp !== "string" || runnerTemp.length === 0) throw new WindowsStartupTimingFailure("pack", "assertion-failed");
		selectWindowsStartupTimingCheck(receipt, "temporary-root");
		temporary = mkdtempSync(join(resolve(runnerTemp), "gentle-pi-windows-startup-timing-"));
		const packDirectory = join(temporary, "pack");
		const consumerDirectory = join(temporary, "consumer");
		mkdirSync(packDirectory);
		mkdirSync(consumerDirectory);
		const { env } = isolatedUnhookedEnvironment(temporary);
		Object.assign(env, { GENTLE_PI_AGENTS: "1", PI_OFFLINE: "1" });
		selectWindowsStartupTimingCheck(receipt, "project-sdk-version");
		const manifest = safeJson(readFileSync(join(root, "package.json")), "project package manifest");
		const sdkVersion = manifest?.devDependencies?.["@earendil-works/pi-coding-agent"];
		if (sdkVersion !== "0.85.1") throw new Error("Windows startup timing probe requires the project-pinned Pi SDK");
		selectWindowsStartupTimingCheck(receipt, "pack-command");
		const packed = safeJson(runBoundedNpm("pack", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory], env, root), "npm pack output");
		stage = "pack-result";
		selectWindowsStartupTimingCheck(receipt, "pack-metadata");
		const { tarball } = assertPackResult(packed, packDirectory, { checkId: "pack-metadata" });
		selectWindowsStartupTimingCheck(receipt, "pack-integrity");
		receipt.packVerified = true;
		stage = "install";
		selectWindowsStartupTimingCheck(receipt, "install-command");
		writeFileSync(join(consumerDirectory, "package.json"), JSON.stringify({ name: "gentle-pi-windows-startup-timing", private: true, dependencies: { "@earendil-works/pi-coding-agent": sdkVersion } }), "utf8");
		runBoundedNpm("install", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--omit=dev", "--legacy-peer-deps", tarball, `@earendil-works/pi-coding-agent@${sdkVersion}`], env, consumerDirectory);
		receipt.installCompleted = true;
		stage = "artifact-check";
		const packageRoot = join(consumerDirectory, "node_modules", "gentle-pi");
		selectWindowsStartupTimingCheck(receipt, "packed-assets");
		assertPackedAssets(packageRoot, { checkId: "asset-runtime-windows-session-transport-owned" });
		selectWindowsStartupTimingCheck(receipt, "native-artifacts");
		assertNoNativeInstallerArtifacts(packageRoot, consumerDirectory, { checkId: "native-package-cache-absent" });
		selectWindowsStartupTimingCheck(receipt, "installed-helper");
		const installedHelper = assertOwnedRegularFile(packageRoot, "runtime/windows-session-transport.ps1");
		stage = "helper-start";
		selectWindowsStartupTimingCheck(receipt, "helper-start");
		const measured = await runWindowsStartupTimingProbe(installedHelper, env, consumerDirectory);
		receipt.helperStartOutcome = measured.helperStartOutcome;
		receipt.startElapsedMs = measured.startElapsedMs;
		receipt.lastStartupMarker = measured.lastStartupMarker;
		receipt.cleanup = measured.cleanup;
		receipt.physicalCloseObserved = measured.physicalCloseObserved;
		stage = "helper-result";
		selectWindowsStartupTimingCheck(receipt, "helper-result");
		if (measured.failure !== undefined) throw new WindowsStartupTimingFailure(measured.failure.stage, measured.failure.code);
		if (measured.helperStartOutcome !== "valid-reply" || measured.startElapsedMs === null || measured.lastStartupMarker !== "native-ready" || measured.cleanup !== "close-observed" || !measured.physicalCloseObserved) throw new WindowsStartupTimingFailure("helper-result", "assertion-failed");
		selectWindowsStartupTimingCheck(receipt, "windows-helper-startup-measured");
	} catch (error) {
		if (error instanceof WindowsStartupTimingFailure) failure = error;
		else if (error instanceof UnhookedFailure) failure = new WindowsStartupTimingFailure(stage, error.code);
		else failure = new WindowsStartupTimingFailure(stage, "assertion-failed");
	}
	if (temporary !== undefined) {
		try {
			if (failure === undefined) selectWindowsStartupTimingCheck(receipt, "cleanup-owned-root-removal");
			rmSync(temporary, { recursive: true, force: true });
			receipt.cleanupCompleted = !existsSync(temporary);
			if (!receipt.cleanupCompleted) throw new Error("owned temporary root remains after cleanup");
		} catch {
			if (failure === undefined) failure = new WindowsStartupTimingFailure("cleanup", "cleanup-failed");
		}
	}
	return { receipt, failure };
}

async function testWindowsStartupTimingEnvironmentExperiment() {
	const receipt = { checkId: "not-attempted", packVerified: false, installCompleted: false, cases: [], cleanupCompleted: false };
	let temporary;
	let stage = "pack";
	let failure;
	try {
		selectWindowsStartupTimingCheck(receipt, "runner-hosted");
		if (process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.platform !== "win32") throw new WindowsStartupTimingFailure("pack", "assertion-failed");
		selectWindowsStartupTimingCheck(receipt, "runner-temp");
		const runnerTemp = process.env.RUNNER_TEMP;
		if (typeof runnerTemp !== "string" || runnerTemp.length === 0) throw new WindowsStartupTimingFailure("pack", "assertion-failed");
		selectWindowsStartupTimingCheck(receipt, "temporary-root");
		temporary = mkdtempSync(join(resolve(runnerTemp), "gentle-pi-windows-startup-environment-"));
		const packDirectory = join(temporary, "pack");
		const consumerDirectory = join(temporary, "consumer");
		mkdirSync(packDirectory);
		mkdirSync(consumerDirectory);
		// Both cases retain this exact existing minimal isolation environment; only
		// the treatment receives the validated, fixed Windows path-key delta.
		const { env: isolatedEnv } = isolatedUnhookedEnvironment(temporary);
		Object.assign(isolatedEnv, { GENTLE_PI_AGENTS: "1", PI_OFFLINE: "1" });
		const pathDelta = deriveWindowsStartupTimingPathDelta(process.env);
		const treatmentPathDelta = validateWindowsStartupTimingMachinePaths(pathDelta) ? pathDelta : undefined;
		selectWindowsStartupTimingCheck(receipt, "project-sdk-version");
		const manifest = safeJson(readFileSync(join(root, "package.json")), "project package manifest");
		const sdkVersion = manifest?.devDependencies?.["@earendil-works/pi-coding-agent"];
		if (sdkVersion !== "0.85.1") throw new Error("Windows startup environment experiment requires the project-pinned Pi SDK");
		selectWindowsStartupTimingCheck(receipt, "pack-command");
		const packed = safeJson(runBoundedNpm("pack", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory], isolatedEnv, root), "npm pack output");
		stage = "pack-result";
		selectWindowsStartupTimingCheck(receipt, "pack-metadata");
		const { tarball } = assertPackResult(packed, packDirectory, { checkId: "pack-metadata" });
		selectWindowsStartupTimingCheck(receipt, "pack-integrity");
		receipt.packVerified = true;
		stage = "install";
		selectWindowsStartupTimingCheck(receipt, "install-command");
		writeFileSync(join(consumerDirectory, "package.json"), JSON.stringify({ name: "gentle-pi-windows-startup-environment", private: true, dependencies: { "@earendil-works/pi-coding-agent": sdkVersion } }), "utf8");
		runBoundedNpm("install", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--omit=dev", "--legacy-peer-deps", tarball, `@earendil-works/pi-coding-agent@${sdkVersion}`], isolatedEnv, consumerDirectory);
		receipt.installCompleted = true;
		stage = "artifact-check";
		const packageRoot = join(consumerDirectory, "node_modules", "gentle-pi");
		selectWindowsStartupTimingCheck(receipt, "packed-assets");
		assertPackedAssets(packageRoot, { checkId: "asset-runtime-windows-session-transport-owned" });
		selectWindowsStartupTimingCheck(receipt, "native-artifacts");
		assertNoNativeInstallerArtifacts(packageRoot, consumerDirectory, { checkId: "native-package-cache-absent" });
		selectWindowsStartupTimingCheck(receipt, "installed-helper");
		const installedHelper = assertOwnedRegularFile(packageRoot, "runtime/windows-session-transport.ps1");
		for (const name of WINDOWS_STARTUP_TIMING_ENVIRONMENT_CASE_NAMES) {
			const isTreatment = name === "windows-paths";
			const caseReceipt = newWindowsStartupTimingEnvironmentCase(name, isTreatment && treatmentPathDelta !== undefined ? treatmentPathDelta.pathAdditionKeys : []);
			receipt.cases.push(caseReceipt);
			if (isTreatment && receipt.cases[0].physicalCloseObserved !== true) {
				caseReceipt.cleanup = "blocked";
				caseReceipt.failureStage = "cleanup";
				caseReceipt.failureCode = "cleanup-unconfirmed";
				break;
			}
			if (isTreatment && treatmentPathDelta === undefined) {
				caseReceipt.failureStage = "helper-start";
				caseReceipt.failureCode = "environment-invalid";
				if (failure === undefined) failure = new WindowsStartupTimingFailure("helper-start", "environment-invalid");
				continue;
			}
			stage = "helper-start";
			selectWindowsStartupTimingCheck(receipt, "helper-start");
			const measured = await runWindowsStartupTimingProbe(installedHelper, isTreatment ? Object.assign({}, isolatedEnv, treatmentPathDelta.values) : isolatedEnv, consumerDirectory);
			caseReceipt.helperStartOutcome = measured.helperStartOutcome;
			caseReceipt.startElapsedMs = measured.startElapsedMs;
			caseReceipt.lastStartupMarker = measured.lastStartupMarker;
			caseReceipt.cleanup = measured.cleanup;
			caseReceipt.physicalCloseObserved = measured.physicalCloseObserved;
			stage = "helper-result";
			selectWindowsStartupTimingCheck(receipt, "helper-result");
			if (!WINDOWS_STARTUP_TIMING_CLEANUP_OUTCOMES.has(caseReceipt.cleanup)) throw new WindowsStartupTimingFailure("helper-result", "assertion-failed");
			if (measured.failure !== undefined) {
				caseReceipt.failureStage = measured.failure.stage;
				caseReceipt.failureCode = measured.failure.code;
				if (failure === undefined) failure = new WindowsStartupTimingFailure(measured.failure.stage, measured.failure.code);
			} else if (measured.helperStartOutcome !== "valid-reply" || measured.startElapsedMs === null || measured.lastStartupMarker !== "native-ready" || measured.cleanup !== "close-observed" || !measured.physicalCloseObserved) {
				caseReceipt.failureStage = "helper-result";
				caseReceipt.failureCode = "assertion-failed";
				if (failure === undefined) failure = new WindowsStartupTimingFailure("helper-result", "assertion-failed");
			}
		}
		if (receipt.cases.length !== 2) throw new WindowsStartupTimingFailure("helper-result", "assertion-failed");
		if (failure === undefined) selectWindowsStartupTimingCheck(receipt, "windows-helper-startup-environment-measured");
	} catch (error) {
		if (failure === undefined) {
			if (error instanceof WindowsStartupTimingFailure) failure = error;
			else if (error instanceof UnhookedFailure) failure = new WindowsStartupTimingFailure(stage, error.code);
			else failure = new WindowsStartupTimingFailure(stage, "assertion-failed");
		}
	}
	if (temporary !== undefined) {
		try {
			if (failure === undefined) selectWindowsStartupTimingCheck(receipt, "cleanup-owned-root-removal");
			rmSync(temporary, { recursive: true, force: true });
			receipt.cleanupCompleted = !existsSync(temporary);
			if (!receipt.cleanupCompleted) throw new Error("owned temporary root remains after cleanup");
		} catch {
			if (failure === undefined) failure = new WindowsStartupTimingFailure("cleanup", "cleanup-failed");
		}
	}
	return { receipt, failure };
}

async function testUnhookedPackedImports() {
	const receipt = newUnhookedReceipt();
	let temporary;
	let stage = "pack";
	let failure;
	try {
		selectUnhookedCheck(receipt, "runner-temp");
		const runnerTemp = process.env.RUNNER_TEMP;
		if (typeof runnerTemp !== "string" || runnerTemp.length === 0) throw new Error("RUNNER_TEMP is required");
		selectUnhookedCheck(receipt, "temporary-root");
		temporary = mkdtempSync(join(resolve(runnerTemp), "gentle-pi-packed-unhooked-"));
		const packDirectory = join(temporary, "pack");
		const consumerDirectory = join(temporary, "consumer");
		mkdirSync(packDirectory);
		mkdirSync(consumerDirectory);
		const { env, homes } = isolatedUnhookedEnvironment(temporary);
		selectUnhookedCheck(receipt, "project-sdk-version");
		const manifest = safeJson(readFileSync(join(root, "package.json")), "project package manifest");
		const sdkVersion = manifest?.devDependencies?.["@earendil-works/pi-coding-agent"];
		if (sdkVersion !== "0.85.1") throw new Error("unhooked probe requires the project-pinned Pi SDK");
		selectUnhookedCheck(receipt, "pack-command");
		const packOutput = runBoundedNpm("pack", ["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory], env, root);
		stage = "pack-result";
		selectUnhookedCheck(receipt, "pack-metadata");
		const packed = safeJson(packOutput, "npm pack output");
		const { tarball } = assertPackResult(packed, packDirectory, receipt);
		receipt.packVerified = true;
		stage = "install";
		selectUnhookedCheck(receipt, "install-command");
		writeFileSync(join(consumerDirectory, "package.json"), JSON.stringify({ name: "gentle-pi-unhooked-import-proof", private: true, dependencies: { "@earendil-works/pi-coding-agent": sdkVersion } }), "utf8");
		runBoundedNpm("install", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--omit=dev", "--legacy-peer-deps", tarball, `@earendil-works/pi-coding-agent@${sdkVersion}`], env, consumerDirectory);
		receipt.installCompleted = true;
		stage = "artifact-check";
		const packageRoot = join(consumerDirectory, "node_modules", "gentle-pi");
		assertPackedAssets(packageRoot, receipt);
		assertNoNativeInstallerArtifacts(packageRoot, consumerDirectory, receipt);
		const sdkPackageJson = join(consumerDirectory, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
		const jitiStaticEntry = resolveInstalledJitiStaticEntry(consumerDirectory, sdkPackageJson, sdkVersion, (checkId) => selectUnhookedCheck(receipt, checkId), {
			sdkManifest: "sdk-manifest-owned", sdkVersion: "sdk-version", jitiManifest: "jiti-manifest-owned",
			jitiStaticExport: "jiti-static-export", jitiEntry: "jiti-entry-owned", jitiVersion: "jiti-version",
		});
		// The child calls only default factories on this inert recorder; it never invokes registered tools or event handlers.
		for (const home of homes) {
			selectUnhookedCheck(receipt, home.checkId);
			assertEmptyDirectory(home.path);
		}
		stage = "import-probe";
		selectUnhookedCheck(receipt, "import-probe-command");
		const probe = runBoundedProbe(["--input-type=module", "--eval", unhookedProbeSource(packageRoot, join(consumerDirectory, "package.json"), jitiStaticEntry)], env, consumerDirectory);
		selectUnhookedCheck(receipt, "import-probe-result");
		safeJson(probe, "unhooked registration probe output");
		stage = "post-import-check";
		assertNoNativeInstallerArtifacts(packageRoot, consumerDirectory, receipt);
		for (const home of homes) {
			selectUnhookedCheck(receipt, home.checkId);
			assertEmptyDirectory(home.path);
		}
	} catch (error) {
		failure = stageFailure(stage, error, stage === "pack-result" || stage === "import-probe");
	}
	if (temporary !== undefined) {
		try {
			if (failure === undefined) selectUnhookedCheck(receipt, "cleanup-owned-root-removal");
			rmSync(temporary, { recursive: true, force: true });
			receipt.cleanupCompleted = !existsSync(temporary);
			if (!receipt.cleanupCompleted) throw new Error("owned temporary root remains after cleanup");
		} catch {
			if (failure === undefined) failure = new UnhookedFailure("cleanup", "cleanup-failed");
		}
	}
	return { receipt, failure };
}

function sameEntrypointPath(left, right, platform) {
	return platform === "win32"
		? win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
		: left === right;
}

export function decidePackedRunnerEntrypoint(scriptPath, argvEntry, platform, operations = { resolvePath: resolve, realpath: realpathSync.native }) {
	const importDecision = Object.freeze({ identity: "import", runModes: false, exitCode: null });
	if (typeof argvEntry !== "string" || argvEntry.length === 0) return importDecision;
	let resolvedScript;
	let resolvedEntry;
	try {
		resolvedScript = operations.resolvePath(scriptPath);
		resolvedEntry = operations.resolvePath(argvEntry);
	} catch { return importDecision; }
	try {
		const sameIdentity = sameEntrypointPath(operations.realpath(resolvedScript), operations.realpath(resolvedEntry), platform);
		return sameIdentity
			? Object.freeze({ identity: "main", runModes: true, exitCode: null })
			: importDecision;
	} catch {
		// A lexical identity is enough to identify only the direct CLI itself; a
		// foreign importer with an unresolvable argv entry remains completely inert.
		return sameEntrypointPath(resolvedScript, resolvedEntry, platform)
			? Object.freeze({ identity: "direct-unresolved", runModes: false, exitCode: 1 })
			: importDecision;
	}
}

const entrypoint = decidePackedRunnerEntrypoint(fileURLToPath(import.meta.url), process.argv[1], process.platform);
if (entrypoint.exitCode !== null) {
	process.exitCode = entrypoint.exitCode;
} else if (entrypoint.runModes && process.argv.includes("--unhooked-imports")) {
	const { receipt, failure } = await testUnhookedPackedImports();
	reportUnhookedReceipt(receipt, failure);
} else if (entrypoint.runModes && process.argv.includes("--sdk-lifecycle")) {
	const { receipt, failure } = await testSdkLifecyclePackedSession();
	reportSdkLifecycleReceipt(receipt, failure);
} else if (entrypoint.runModes && process.argv.includes("--windows-startup-timing")) {
	const { receipt, failure } = await testWindowsStartupTimingPackedHelper();
	reportWindowsStartupTimingReceipt(receipt, failure);
} else if (entrypoint.runModes && process.argv.includes("--windows-startup-timing-environment")) {
	const { receipt, failure } = await testWindowsStartupTimingEnvironmentExperiment();
	reportWindowsStartupTimingEnvironmentReceipt(receipt, failure);
} else if (entrypoint.runModes) {
	await testHookedPackedRunner();
}
