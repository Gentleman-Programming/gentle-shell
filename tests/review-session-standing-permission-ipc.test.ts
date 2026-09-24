import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { AGENT_MODE, type AgentDefinition } from "../lib/agents-config.ts";
import { AgentRunner, type ChildLike, type TaskRequest } from "../lib/agents-runner.ts";
import { TaskStore } from "../lib/agents-protocol.ts";

const REPOSITORY_ID = `sha256:${"a".repeat(64)}`;
const OTHER_REPOSITORY_ID = `sha256:${"b".repeat(64)}`;

import {
	CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SYMBOL,
	ChildStandingReviewPermissionClient,
	createChildStandingReviewPermissionClient,
	ParentStandingReviewPermissionBroker,
} from "../lib/review-session-standing-permission-ipc.ts";

function pair() {
	const childToParent = new PassThrough();
	const parentToChild = new PassThrough();
	return {
		child: { readable: parentToChild, writable: childToParent },
		parent: { readable: childToParent, writable: parentToChild },
		close() {
			childToParent.destroy();
			parentToChild.destroy();
		},
	};
}

type Fd3StdioMode = "pipe" | "overlapped";

type WindowsFd3DiagnosticTrace = {
	stdioMode: Fd3StdioMode;
	childClientAttached: boolean | "unknown";
	childRequestAttemptCount: number;
	childSettlement: "not-attempted" | "settled-true" | "settled-false" | "unknown";
	childResponseObserved: "unknown-without-production-instrumentation";
	childTimeoutObserved: "unknown-without-production-instrumentation";
	parentRawDataChunkCount: number;
	parentAuthorizationCallbackCount: number;
	parentWriteCallback: "unknown-without-production-instrumentation";
	parentWriteErrorCode: "unknown-without-production-instrumentation";
	parentFd3Cleanup: "not-needed" | "deadline-termination-requested" | "deadline-confirmed-close" | "deadline-unconfirmed-after-grace";
	childClose: "pending" | "observed" | "unconfirmed-after-grace";
	fd3Close: "pending" | "observed" | "unconfirmed-after-grace";
	probeResult: "pending" | "completed" | "spawn-failure" | "child-error" | "child-exit-nonzero" | "parse-failure" | "stream-error" | "deadline-unconfirmed";
	capturedOutput: "within-4096-byte-bound" | "truncated-at-4096-bytes";
	childExit: "unknown" | "zero" | "nonzero" | "error";
};

type ProductionChildOptions = {
	maxRequests?: number;
	closeChannel?: boolean;
	withoutChannel?: boolean;
	stdioMode?: Fd3StdioMode;
	childDeadlineMs?: number;
	childCloseGraceMs?: number;
	diagnosticTrace?: WindowsFd3DiagnosticTrace;
};

const productionFd3StdioMode: Fd3StdioMode = process.platform === "win32" ? "overlapped" : "pipe";

function windowsFd3DiagnosticTrace(stdioMode: Fd3StdioMode): WindowsFd3DiagnosticTrace {
	return {
		stdioMode,
		childClientAttached: "unknown",
		childRequestAttemptCount: 0,
		childSettlement: "unknown",
		childResponseObserved: "unknown-without-production-instrumentation",
		childTimeoutObserved: "unknown-without-production-instrumentation",
		parentRawDataChunkCount: 0,
		parentAuthorizationCallbackCount: 0,
		parentWriteCallback: "unknown-without-production-instrumentation",
		parentWriteErrorCode: "unknown-without-production-instrumentation",
		parentFd3Cleanup: "not-needed",
		childClose: "pending",
		fd3Close: "pending",
		probeResult: "pending",
		capturedOutput: "within-4096-byte-bound",
		childExit: "unknown",
	};
}

async function productionChild(requests: number, authorize: () => boolean, options: ProductionChildOptions = {}): Promise<boolean[]> {
	const moduleUrl = new URL("../lib/review-session-standing-permission-ipc.ts", import.meta.url).href;
	const diagnostic = options.diagnosticTrace !== undefined;
	const source = `
		import { createChildStandingReviewPermissionClient } from ${JSON.stringify(moduleUrl)};
		const client = createChildStandingReviewPermissionClient();
		const answers = [];
		const trace = {
			childClientAttached: client !== undefined,
			childRequestAttemptCount: 0,
			childSettlement: "not-attempted",
			childResponseObserved: "unknown-without-production-instrumentation",
			childTimeoutObserved: "unknown-without-production-instrumentation",
		};
		for (let index = 0; index < ${requests}; index += 1) {
			trace.childRequestAttemptCount += 1;
			const answer = await client?.requestAuthorization(${JSON.stringify(REPOSITORY_ID)}) ?? false;
			answers.push(answer);
			trace.childSettlement = answer ? "settled-true" : "settled-false";
		}
		client?.close();
		process.stdout.write(JSON.stringify(${diagnostic} ? { answers, trace } : answers));
	`;
	const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source], {
		env: { ...process.env, GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_PARENT_PERMISSION_FD: "3" },
		stdio: options.withoutChannel ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", options.stdioMode ?? productionFd3StdioMode],
	});
	const pipe = child.stdio[3];
	const trace = options.diagnosticTrace;
	const onParentData = () => { if (trace !== undefined) trace.parentRawDataChunkCount += 1; };
	if (trace !== undefined && pipe !== null && pipe !== undefined) pipe.on("data", onParentData);
	const parentAuthorize = trace === undefined
		? authorize
		: () => {
			trace.parentAuthorizationCallbackCount += 1;
			return authorize();
		};
	const broker = pipe === null || pipe === undefined
		? undefined
		: new ParentStandingReviewPermissionBroker({ readable: pipe, writable: pipe }, parentAuthorize, options);
	if (options.closeChannel && pipe !== null && pipe !== undefined) {
		broker?.close();
		pipe.destroy();
	}
	let stdout = "";
	let stderr = "";
	if (trace === undefined) {
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		return new Promise((resolve, reject) => child.once("exit", (code) => {
			broker?.close();
			if (code !== 0) reject(new Error(`child exited ${code}: ${stderr}`));
			else resolve(JSON.parse(stdout) as boolean[]);
		}));
	}

	const diagnosticTrace = trace;
	const outputLimitBytes = 4_096;
	let stdoutBytes = 0;
	let stderrBytes = 0;
	let cleanupStarted = false;
	let settled = false;
	let deadline: NodeJS.Timeout | undefined;
	let closeGrace: NodeJS.Timeout | undefined;
	const appendBounded = (current: string, chunk: Buffer, currentBytes: number): { value: string; bytes: number } => {
		if (currentBytes >= outputLimitBytes) {
			diagnosticTrace.capturedOutput = "truncated-at-4096-bytes";
			return { value: current, bytes: currentBytes };
		}
		const accepted = chunk.subarray(0, outputLimitBytes - currentBytes);
		if (accepted.length !== chunk.length) diagnosticTrace.capturedOutput = "truncated-at-4096-bytes";
		return { value: current + accepted.toString("utf8"), bytes: currentBytes + accepted.length };
	};
	const onStdoutData = (chunk: Buffer) => {
		const captured = appendBounded(stdout, chunk, stdoutBytes);
		stdout = captured.value;
		stdoutBytes = captured.bytes;
	};
	const onStderrData = (chunk: Buffer) => {
		const captured = appendBounded(stderr, chunk, stderrBytes);
		stderr = captured.value;
		stderrBytes = captured.bytes;
	};
	child.stdout.on("data", onStdoutData);
	child.stderr.on("data", onStderrData);

	return new Promise((resolve) => {
		const removeOperationalListeners = () => {
			child.off("exit", onChildExit);
			child.off("close", onChildClose);
			child.stdout.off("data", onStdoutData);
			child.stderr.off("data", onStderrData);
			pipe?.off("close", onFd3Close);
			if (pipe !== null && pipe !== undefined) pipe.off("data", onParentData);
		};
		const removeInertErrorGuards = () => {
			child.off("error", onChildError);
			child.stdout.off("error", onStreamError);
			child.stderr.off("error", onStreamError);
			pipe?.off("error", onStreamError);
		};
		const finish = (answers: boolean[], retainInertErrorGuards = false) => {
			if (settled) return;
			settled = true;
			if (deadline !== undefined) clearTimeout(deadline);
			if (closeGrace !== undefined) clearTimeout(closeGrace);
			removeOperationalListeners();
			if (retainInertErrorGuards) child.once("close", removeInertErrorGuards);
			else removeInertErrorGuards();
			broker?.close();
			resolve(answers);
		};
		const parseCompletedAnswers = (): boolean[] | undefined => {
			if (diagnosticTrace.capturedOutput !== "within-4096-byte-bound") return undefined;
			try {
				const result = JSON.parse(stdout) as { answers?: unknown; trace?: Partial<WindowsFd3DiagnosticTrace> };
				if (!Array.isArray(result.answers) || !result.answers.every((answer) => typeof answer === "boolean")) return undefined;
				diagnosticTrace.childClientAttached = result.trace?.childClientAttached === true;
				diagnosticTrace.childRequestAttemptCount = typeof result.trace?.childRequestAttemptCount === "number" ? result.trace.childRequestAttemptCount : 0;
				diagnosticTrace.childSettlement = result.trace?.childSettlement === "settled-true" || result.trace?.childSettlement === "settled-false"
					? result.trace.childSettlement
					: "unknown";
				return result.answers;
			} catch {
				return undefined;
			}
		};
		const finishFromChildClose = () => {
			if (settled) return;
			if (diagnosticTrace.childExit === "nonzero" || diagnosticTrace.childExit === "error") {
				diagnosticTrace.probeResult = diagnosticTrace.childExit === "error" ? "child-error" : "child-exit-nonzero";
				finish([]);
				return;
			}
			const answers = parseCompletedAnswers();
			if (answers === undefined) {
				diagnosticTrace.probeResult = "parse-failure";
				finish([]);
				return;
			}
			if (diagnosticTrace.probeResult === "pending") diagnosticTrace.probeResult = "completed";
			finish(answers);
		};
		const finishIfPhysicalCleanupConfirmed = () => {
			if (!cleanupStarted || diagnosticTrace.childClose !== "observed" || diagnosticTrace.fd3Close !== "observed") return;
			diagnosticTrace.parentFd3Cleanup = "deadline-confirmed-close";
			finishFromChildClose();
		};
		const onChildExit = (code: number | null) => {
			diagnosticTrace.childExit = code === 0 ? "zero" : "nonzero";
		};
		const onChildClose = (code: number | null) => {
			diagnosticTrace.childClose = "observed";
			if (diagnosticTrace.childExit === "unknown") diagnosticTrace.childExit = code === 0 ? "zero" : "nonzero";
			if (cleanupStarted) finishIfPhysicalCleanupConfirmed();
			else finishFromChildClose();
		};
		const onFd3Close = () => {
			diagnosticTrace.fd3Close = "observed";
			finishIfPhysicalCleanupConfirmed();
		};
		const onChildError = () => {
			diagnosticTrace.childExit = "error";
			if (diagnosticTrace.probeResult === "pending") diagnosticTrace.probeResult = "child-error";
		};
		const onStreamError = () => {
			if (diagnosticTrace.probeResult === "pending") diagnosticTrace.probeResult = "stream-error";
		};
		const startDeadlineCleanup = () => {
			if (settled || cleanupStarted) return;
			cleanupStarted = true;
			diagnosticTrace.parentFd3Cleanup = "deadline-termination-requested";
			broker?.close();
			pipe?.destroy();
			try { child.kill(); } catch { /* The owned child may already have exited. */ }
			closeGrace = setTimeout(() => {
				if (diagnosticTrace.childClose === "pending") diagnosticTrace.childClose = "unconfirmed-after-grace";
				if (diagnosticTrace.fd3Close === "pending") diagnosticTrace.fd3Close = "unconfirmed-after-grace";
				if (diagnosticTrace.fd3Close !== "observed") diagnosticTrace.parentFd3Cleanup = "deadline-unconfirmed-after-grace";
				diagnosticTrace.probeResult = "deadline-unconfirmed";
				finish([], true);
			}, options.childCloseGraceMs ?? 250);
		};

		child.once("exit", onChildExit);
		child.once("close", onChildClose);
		child.on("error", onChildError);
		child.stdout.on("error", onStreamError);
		child.stderr.on("error", onStreamError);
		pipe?.once("close", onFd3Close);
		pipe?.on("error", onStreamError);
		deadline = setTimeout(startDeadlineCleanup, options.childDeadlineMs ?? 6_000);
	});
}

test("the production child fd3 client gets grant, revocation, closure, denial, and request bounds from its parent broker", async () => {
	let calls = 0;
	assert.deepEqual(await productionChild(2, () => ++calls === 1), [true, false], "the parent rechecks authorization for each request");
	assert.deepEqual(await productionChild(1, () => false), [false], "a child without a grant is denied");
	assert.deepEqual(await productionChild(2, () => true, { maxRequests: 1 }), [true, false], "the parent caps requests per child channel");
	assert.deepEqual(await productionChild(1, () => true, { closeChannel: true }), [false], "a closed fd3 channel fails closed without crashing the child");
	assert.deepEqual(await productionChild(1, () => true, { withoutChannel: true }), [false], "a marked normal process without fd3 fails closed without crashing");
});

test("fresh Jiti moduleCache:false reloads share fd3 structurally and reject stale terminal callbacks", async () => {
	const ipcUrl = new URL("../lib/review-session-standing-permission-ipc.ts", import.meta.url).href;
	const extensionUrl = new URL("../extensions/gentle-ai.ts", import.meta.url).href;
	const source = `
		import { createJiti } from "jiti";
		import { fileURLToPath } from "node:url";
		const ipcPath = fileURLToPath(${JSON.stringify(ipcUrl)});
		const extensionPath = fileURLToPath(${JSON.stringify(extensionUrl)});
		const firstLoader = createJiti(import.meta.url, { moduleCache: false });
		const firstExtension = await firstLoader.import(extensionPath, { default: true });
		const firstIpc = await firstLoader.import(ipcPath, { default: false });
		const shutdowns = [];
		const pi = { on(name, handler) { if (name === "session_shutdown") shutdowns.push(handler); }, registerTool() {}, registerCommand() {}, events: { emit() {} } };
		const context = { cwd: process.cwd(), sessionManager: { getSessionId: () => "child" }, ui: { setStatus() {} } };
		firstExtension(pi);
		const staleShutdown = shutdowns.at(-1);
		const client = firstIpc.createChildStandingReviewPermissionClient();
		const answers = [await client?.requestAuthorization(${JSON.stringify(REPOSITORY_ID)}) ?? false];
		staleShutdown({ reason: "reload" }, context);
		const secondLoader = createJiti(import.meta.url, { moduleCache: false });
		const secondExtension = await secondLoader.import(extensionPath, { default: true });
		const secondIpc = await secondLoader.import(ipcPath, { default: false });
		secondExtension(pi);
		const activeShutdown = shutdowns.at(-1);
		answers.push(await secondIpc.createChildStandingReviewPermissionClient()?.requestAuthorization(${JSON.stringify(REPOSITORY_ID)}) ?? false);
		staleShutdown({ reason: "new" }, context);
		answers.push(await client?.requestAuthorization(${JSON.stringify(REPOSITORY_ID)}) ?? false);
		activeShutdown({ reason: "new" }, context);
		answers.push(await client?.requestAuthorization(${JSON.stringify(REPOSITORY_ID)}) ?? false);
		process.stdout.write(JSON.stringify({ answers, classIdentityDiffers: firstIpc.ChildStandingReviewPermissionClient !== secondIpc.ChildStandingReviewPermissionClient }));
	`;
	const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", source], {
		env: { ...process.env, GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_PARENT_PERMISSION_FD: "3" },
		stdio: ["ignore", "pipe", "pipe", productionFd3StdioMode],
	});
	const pipe = child.stdio[3];
	assert.ok(pipe);
	const broker = new ParentStandingReviewPermissionBroker({ readable: pipe, writable: pipe }, () => true);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
	child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
	const result = await new Promise<{ answers: boolean[]; classIdentityDiffers: boolean }>((resolve, reject) => child.once("exit", (code) => {
		broker.close();
		if (code !== 0) reject(new Error(`Jiti reload child exited ${code}: ${stderr}`));
		else resolve(JSON.parse(stdout) as { answers: boolean[]; classIdentityDiffers: boolean });
	}));
	assert.equal(result.classIdentityDiffers, true, "fresh Jiti loaders must re-evaluate the IPC class");
	assert.deepEqual(result.answers, [true, true, true, false], "reload shares one client, stale owners cannot close it, and terminal shutdown closes it");
});

test("an incompatible process registry fails closed rather than replacing ownership", () => {
	const globalRegistry = globalThis as Record<symbol, unknown>;
	const previous = globalRegistry[CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SYMBOL];
	try {
		globalRegistry[CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SYMBOL] = { schema: "wrong" };
		assert.equal(createChildStandingReviewPermissionClient({ GENTLE_PI_AGENTS_CHILD: "1", GENTLE_PI_AGENTS_PARENT_PERMISSION_FD: "3" }), undefined);
	} finally {
		if (previous === undefined) delete globalRegistry[CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SYMBOL];
		else globalRegistry[CHILD_STANDING_REVIEW_PERMISSION_REGISTRY_SYMBOL] = previous;
	}
});

test("a package-owned child receives one parent-session authorization only after the parent checks its live task", async () => {
	const channel = pair();
	let live = true;
	const broker = new ParentStandingReviewPermissionBroker(channel.parent, async (repositoryIdentity) => live && repositoryIdentity === REPOSITORY_ID);
	const child = new ChildStandingReviewPermissionClient(channel.child, { timeoutMs: 25 });
	assert.equal(await child.requestAuthorization(REPOSITORY_ID), true);
	assert.equal(await child.requestAuthorization(OTHER_REPOSITORY_ID), false, "the task broker rejects a child target outside its repository");
	assert.equal(await child.requestAuthorization("sha256:malformed"), false, "a malformed identity cannot reach the parent broker");
	live = false;
	assert.equal(await child.requestAuthorization(REPOSITORY_ID), false, "each request rechecks the live parent task and grant");
	child.close();
	broker.close();
	channel.close();
});

test("the parent bounds each child channel before an untrusted request stream can keep asking", async () => {
	const channel = pair();
	const broker = new ParentStandingReviewPermissionBroker(channel.parent, async () => true, { maxRequests: 1 });
	const child = new ChildStandingReviewPermissionClient(channel.child, { timeoutMs: 25 });
	assert.equal(await child.requestAuthorization(REPOSITORY_ID), true);
	assert.equal(await child.requestAuthorization(REPOSITORY_ID), false, "the broker rejects requests beyond its fixed per-task bound");
	child.close();
	broker.close();
	channel.close();
});

test("a broken, timed-out, or malformed parent-owned channel fails closed", async () => {
	const channel = pair();
	const broker = new ParentStandingReviewPermissionBroker(channel.parent, async () => true);
	const child = new ChildStandingReviewPermissionClient(channel.child, { timeoutMs: 1 });
	broker.close();
	assert.equal(await child.requestAuthorization(REPOSITORY_ID), false, "a closed broker cannot grant");
	channel.close();
	assert.equal(await child.requestAuthorization(REPOSITORY_ID), false, "an orphaned channel cannot grant");
	child.close();
});

test("the authorization wire carries no candidate data or provider consent vectors", async () => {
	const channel = pair();
	const seen: string[] = [];
	channel.parent.readable.on("data", (chunk: Buffer) => seen.push(chunk.toString("utf8")));
	const broker = new ParentStandingReviewPermissionBroker(channel.parent, async () => true);
	const child = new ChildStandingReviewPermissionClient(channel.child, { timeoutMs: 25 });
	assert.equal(await child.requestAuthorization(REPOSITORY_ID), true);
	assert.equal(seen.length, 1);
	assert.match(seen[0]!, /"type":"standing-review-permission-request"/);
	assert.match(seen[0]!, new RegExp(REPOSITORY_ID));
	assert.doesNotMatch(seen[0]!, /consent|candidate|lineage|workspace|commonDir|path/i);
	child.close();
	broker.close();
	channel.close();
});

test("a child disconnect during a pending parent response cannot crash the broker process", async () => {
	class ChildDisconnectedOutput extends Writable {
		private disconnected = false;

		disconnect(): void {
			this.disconnected = true;
		}

		_write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
			callback(this.disconnected ? Object.assign(new Error("child pipe reset"), { code: "ECONNRESET" }) : null);
		}
	}

	const childToParent = new PassThrough();
	const parentToChild = new ChildDisconnectedOutput();
	let calls = 0;
	let releaseAuthorization: ((granted: boolean) => void) | undefined;
	let signalAuthorizationStarted: () => void = () => {};
	const authorizationStarted = new Promise<void>((resolve) => { signalAuthorizationStarted = resolve; });
	const broker = new ParentStandingReviewPermissionBroker(
		{ readable: childToParent, writable: parentToChild },
		() => new Promise<boolean>((resolve) => {
			calls += 1;
			releaseAuthorization = resolve;
			signalAuthorizationStarted();
		}),
	);
	let uncaught: Error | undefined;
	const observeUncaught = (error: Error) => { uncaught = error; };
	process.on("uncaughtException", observeUncaught);
	try {
		childToParent.write(`${JSON.stringify({ type: "standing-review-permission-request", id: "disconnect", repositoryIdentity: REPOSITORY_ID })}\n`);
		await authorizationStarted;
		parentToChild.disconnect();
		releaseAuthorization?.(true);
		await new Promise((resolve) => setTimeout(resolve, 25));
		childToParent.write(`${JSON.stringify({ type: "standing-review-permission-request", id: "after-disconnect", repositoryIdentity: REPOSITORY_ID })}\n`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(calls, 1, "the closed broker does not accept more work after a child pipe error");
		assert.equal(uncaught, undefined, "the parent's late write error is handled by the broker, not process-wide");
	} finally {
		process.off("uncaughtException", observeUncaught);
		broker.close();
		childToParent.destroy();
		parentToChild.destroy();
	}
});

test("AgentRunner delivers real fd3 authorization rechecks through its permission launch", { timeout: 15_000 }, async () => {
	const PROBE_DEADLINE_MS = 12_000;
	const CLOSE_GRACE_MS = 750;
	const moduleUrl = new URL("../lib/review-session-standing-permission-ipc.ts", import.meta.url).href;
	const source = `
		import { createChildStandingReviewPermissionClient } from ${JSON.stringify(moduleUrl)};
		const client = createChildStandingReviewPermissionClient();
		const answers = [];
		for (let index = 0; index < 2; index += 1) answers.push(await client?.requestAuthorization(${JSON.stringify(REPOSITORY_ID)}) ?? false);
		client?.close();
		process.stdout.write(JSON.stringify({ answers, fixtureArgs: process.argv.slice(1) }));
	`;
	const agent: AgentDefinition = { name: "permission-fixture", description: "test", filePath: "/test.md", scope: "global", instructions: "", model: undefined, thinking: undefined, mode: undefined, tools: [] };
	const store = new TaskStore();
	let authorizationCalls = 0;
	let child: ReturnType<typeof spawn> | undefined;
	let childStdout: ReturnType<typeof spawn>["stdout"] | undefined;
	let taskId: string | undefined;
	let closeObserved = false;
	let terminating = false;
	let launchFailure: Error | undefined;
	let childFailure: Error | undefined;
	let terminationFailure: Error | undefined;
	let deadline: NodeJS.Timeout | undefined;
	let grace: NodeJS.Timeout | undefined;
	let stdout = "";
	let stdoutBytes = 0;
	let stdoutTruncated = false;
	let finishProbe!: (result: { closeObserved: boolean; failure: Error | undefined }) => void;
	const probe = new Promise<{ closeObserved: boolean; failure: Error | undefined }>((resolve) => { finishProbe = resolve; });
	let probeFinished = false;
	let runner: AgentRunner;
	const clearTimers = () => {
		if (deadline !== undefined) clearTimeout(deadline);
		if (grace !== undefined) clearTimeout(grace);
		deadline = undefined;
		grace = undefined;
	};
	const releaseOwnedReferences = () => {
		const unref = (value: unknown) => {
			if (value !== null && typeof value === "object" && "unref" in value && typeof value.unref === "function") value.unref();
		};
		child?.unref();
		unref(child?.channel);
		unref(child?.stdout);
		unref(child?.stderr);
		for (const stream of child?.stdio ?? []) unref(stream);
	};
	const finish = (result: { closeObserved: boolean; failure: Error | undefined }) => {
		if (probeFinished) return;
		probeFinished = true;
		clearTimers();
		finishProbe(result);
	};
	const onStdout = (chunk: Buffer | string) => {
		if (stdoutBytes >= 4_096) {
			stdoutTruncated = true;
			return;
		}
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const captured = bytes.subarray(0, 4_096 - stdoutBytes);
		if (captured.length !== bytes.length) stdoutTruncated = true;
		stdout += captured.toString("utf8");
		stdoutBytes += captured.length;
	};
	const removeOperationalListeners = () => {
		child?.off("error", onChildError);
		child?.off("close", onChildClose);
		childStdout?.off("data", onStdout);
	};
	const retainLateCloseGuard = () => {
		const suppressLateStreamError = () => {};
		child?.once("close", () => {
			closeObserved = true;
			releaseOwnedReferences();
		});
		child?.once("error", suppressLateStreamError);
		childStdout?.once("error", suppressLateStreamError);
		child?.stderr?.once("error", suppressLateStreamError);
		for (const stream of child?.stdio ?? []) stream?.once("error", suppressLateStreamError);
	};
	const terminate = (failure: Error) => {
		if (terminating || closeObserved) return;
		terminating = true;
		terminationFailure ??= failure;
		clearTimers();
		if (!taskId || !runner.cancel(taskId)) {
			try { child?.kill(); } catch { /* The owned child may already have exited. */ }
		}
		if (closeObserved) return;
		grace = setTimeout(() => {
			if (closeObserved) return;
			removeOperationalListeners();
			releaseOwnedReferences();
			retainLateCloseGuard();
			finish({ closeObserved: false, failure });
		}, CLOSE_GRACE_MS);
	};
	const onChildError = (error: Error) => {
		childFailure ??= error;
		terminate(error);
	};
	const onChildClose = () => {
		closeObserved = true;
		removeOperationalListeners();
		releaseOwnedReferences();
		finish({ closeObserved: true, failure: childFailure ?? terminationFailure });
	};
	runner = new AgentRunner(store, { maxConcurrency: 1, stallTimeoutMs: 10_000 }, {
		spawn: (command, args, options) => {
			try {
				child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: options.detached, stdio: options.stdio });
			} catch (error) {
				launchFailure = error instanceof Error ? error : new Error(String(error));
				throw error;
			}
			childStdout = child.stdout;
			if (childStdout === null) {
				launchFailure = new Error("AgentRunner child stdout is required");
				queueMicrotask(() => terminate(launchFailure!));
			} else childStdout.on("data", onStdout);
			child.once("error", onChildError);
			child.once("close", onChildClose);
			deadline = setTimeout(() => terminate(new Error(`owned child startup/handshake probe exceeded ${PROBE_DEADLINE_MS}ms`)), PROBE_DEADLINE_MS);
			return child as unknown as ChildLike;
		},
		now: Date.now,
		schedule: (fn, ms) => {
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		},
		pi: { command: process.execPath, args: ["--experimental-strip-types", "--input-type=module", "--eval", source, "--"] },
	}, { askUser: async () => ({ cancelled: true }) });
	const request: TaskRequest = {
		agent,
		prompt: "permission fixture",
		label: undefined,
		context: undefined,
		mode: AGENT_MODE.BACKGROUND,
		cwd: process.cwd(),
		parentSessionId: "test",
		model: undefined,
		thinking: undefined,
		sessionDir: "/tmp",
		resumeSessionPath: undefined,
		env: {},
		authorizeParentStandingReviewPermission: () => ++authorizationCalls === 1,
	};
	try {
		const task = runner.run(request);
		taskId = task.id;
		await new Promise((resolve) => setImmediate(resolve));
		assert.ifError(launchFailure);
		assert.ok(child, "AgentRunner must own the real child launch");
		const result = await probe;
		assert.equal(result.closeObserved, true, result.failure?.message ?? "owned child close was unconfirmed after bounded cleanup");
		assert.ifError(result.failure);
		assert.equal(stdoutTruncated, false, "child stdout capture remains within 4096 bytes");
		const output = (() => {
			try { return JSON.parse(stdout) as { answers?: unknown; fixtureArgs?: unknown }; }
			catch (error) { assert.fail(`could not parse bounded child stdout: ${error instanceof Error ? error.message : String(error)}`); }
		})();
		assert.deepEqual(output.answers, [true, false], "the real child receives one grant and one rechecked denial through AgentRunner");
		assert.ok(Array.isArray(output.fixtureArgs) && output.fixtureArgs.includes("--mode") && output.fixtureArgs.includes("rpc"), "the spawn adapter forwards Runner-appended arguments after Node's -- boundary");
		assert.equal(authorizationCalls, 2, "AgentRunner invokes its parent callback for both child requests");
	} finally {
		if (!closeObserved) terminate(new Error("test cleanup requested owned child termination"));
		await probe;
	}
});

if (process.platform === "win32") {
	test("diagnostic: fd3 production child compares pipe and overlapped without inferring a pipe denial", { timeout: 15_000 }, async (t) => {
		const results: Array<{ answers: boolean[] | undefined; trace: WindowsFd3DiagnosticTrace }> = [];
		for (const stdioMode of ["pipe", "overlapped"] as const) {
			const trace = windowsFd3DiagnosticTrace(stdioMode);
			let answers: boolean[] | undefined;
			try {
				answers = await productionChild(1, () => true, { stdioMode, childDeadlineMs: 6_000, childCloseGraceMs: 250, diagnosticTrace: trace });
			} catch {
				trace.probeResult = "spawn-failure";
			}
			t.diagnostic(JSON.stringify(trace));
			results.push({ answers, trace });
		}
		const overlapped = results.find((result) => result.trace.stdioMode === "overlapped");
		assert.deepEqual(overlapped?.answers, [true], "overlapped must carry a production-client grant from the direct parent broker");
		assert.equal(overlapped?.trace.childClientAttached, true, "the production child must attach its fd3 client");
		assert.equal(overlapped?.trace.childRequestAttemptCount, 1, "the production child must attempt one synthetic request");
		assert.ok((overlapped?.trace.parentRawDataChunkCount ?? 0) > 0, "the parent must receive child request data without assuming stream chunk framing");
		assert.equal(overlapped?.trace.parentAuthorizationCallbackCount, 1, "the direct parent broker must authorize one request");
		assert.equal(overlapped?.trace.probeResult, "completed", "the overlapped probe must close and parse cleanly");
	});
}
