import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ExecutionOutcome =
	| "pass" | "fail_assertion" | "fail_setup" | "skipped"
	| "unmatched" | "timeout" | "aborted" | "unsupported_runner" | "error";

export interface ExecutionCaptureOptions {
	testFile: string;
	testName: string;
	sourceFile?: string;
	candidateCommit?: string;
	callerMetadata?: Record<string, unknown>;
	timeoutMs?: number;
	maxBufferBytes?: number;
	signal?: AbortSignal;
	runner?: string;
}

export interface SecurityExecutionReceipt {
	id: string;
	timestamp: string;
	runner: string;
	supported: boolean;
	callerMetadata: Record<string, unknown>;
	targetedTest: { file: string; testName: string };
	provenance: {
		testContentSha256: string | "unavailable";
		postTestContentSha256: string | "unavailable";
		sourceContentSha256?: string | "unavailable";
		postSourceContentSha256?: string | "unavailable";
		claimedCandidateCommit?: string | "unavailable";
		observedRevision: "unavailable";
	};
	processExit: { code: number | null; signal: NodeJS.Signals | null };
	execution: {
		observedOutcome: ExecutionOutcome;
		durationMs?: number;
		assertionFailure?: { message?: string; operator?: string; actual?: unknown; expected?: unknown; code?: string };
		failureReason?: string;
		failureType?: string;
		eventsObserved: number;
		truncated: boolean;
	};
	verdict: { isAssertionRed: false; isGreen: false; failClosed: true; validationState: "unvalidated_capture" };
}

export default async function* customReporter(source: AsyncIterable<any>) {
	for await (const ev of source) {
		const t = ev?.type;
		if (t === "test:pass" || t === "test:fail" || t === "test:summary") {
			yield JSON.stringify({ type: t, data: ev?.data }) + "\n";
		} else if (t === "test:stdout" || t === "test:stderr") {
			yield JSON.stringify({ type: t, bytes: ev?.data?.message ? Buffer.byteLength(String(ev.data.message)) : 0 }) + "\n";
		}
	}
}

function fileSha256(p: string): string | "unavailable" {
	try { return createHash("sha256").update(readFileSync(p)).digest("hex"); }
	catch { return "unavailable"; }
}

function isSafePositiveInt(v: unknown): boolean {
	return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

export async function captureNodeTestExecution(opts: ExecutionCaptureOptions): Promise<SecurityExecutionReceipt> {
	const id = randomUUID(), timestamp = new Date().toISOString(), runner = opts.runner ?? "node:test";
	const callerMetadata = { ...(opts.callerMetadata ?? {}) };
	const resolvedTest = path.resolve(opts.testFile), resolvedSrc = opts.sourceFile !== undefined ? path.resolve(opts.sourceFile) : undefined;
	const targetedTest = { file: resolvedTest, testName: opts.testName };
	const preTestSha = fileSha256(resolvedTest), preSrcSha = resolvedSrc !== undefined ? fileSha256(resolvedSrc) : undefined;
	const claimed = opts.candidateCommit && /^[0-9a-f]{7,40}$/i.test(opts.candidateCommit)
		? opts.candidateCommit : opts.candidateCommit !== undefined ? "unavailable" : undefined;

	const makeProvenance = (postTest: string | "unavailable", postSrc: string | "unavailable" | undefined) => ({
		testContentSha256: preTestSha, postTestContentSha256: postTest,
		...(resolvedSrc !== undefined && { sourceContentSha256: preSrcSha ?? "unavailable", postSourceContentSha256: postSrc ?? "unavailable" }),
		...(claimed !== undefined && { claimedCandidateCommit: claimed }),
		observedRevision: "unavailable" as const,
	});

	const fail = (
		observedOutcome: ExecutionOutcome, supported = true,
		processExit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null },
		postTest: string | "unavailable" = "unavailable", postSrc: string | "unavailable" | undefined = "unavailable", truncated = false,
	): SecurityExecutionReceipt => ({
		id, timestamp, runner, supported, callerMetadata, targetedTest,
		provenance: makeProvenance(postTest, postSrc), processExit,
		execution: { observedOutcome, eventsObserved: 0, truncated },
		verdict: { isAssertionRed: false, isGreen: false, failClosed: true, validationState: "unvalidated_capture" },
	});

	if (opts.timeoutMs !== undefined && !isSafePositiveInt(opts.timeoutMs)) return fail("error");
	if (opts.maxBufferBytes !== undefined && !isSafePositiveInt(opts.maxBufferBytes)) return fail("error");
	if (runner !== "node:test") return fail("unsupported_runner", false);
	if (opts.signal?.aborted) return fail("aborted");
	if (preTestSha === "unavailable" || (resolvedSrc !== undefined && preSrcSha === "unavailable")) return fail("error");

	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	const maxBytes = opts.maxBufferBytes ?? 512 * 1024;
	const detached = process.platform !== "win32";
	const cp = spawn(process.execPath, [
		"--experimental-strip-types", "--test",
		`--test-reporter=${fileURLToPath(import.meta.url)}`,
		`--test-name-pattern=^${opts.testName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
		"--", resolvedTest,
	], { stdio: ["ignore", "pipe", "pipe"], env, detached });

	const stdoutChunks: Buffer[] = [];
	let stdoutBytes = 0, stderrBytes = 0, wasTimeout = false, wasAborted = false, truncated = false, terminated = false;
	const terminate = () => {
		if (terminated) return;
		terminated = true;
		cp.stdout.destroy(); cp.stderr.destroy();
		if (detached && cp.pid && Number.isSafeInteger(cp.pid) && cp.pid > 0) {
			try { process.kill(-cp.pid, "SIGKILL"); return; } catch {}
		}
		cp.kill("SIGKILL");
	};
	const onAbort = () => { wasAborted = true; terminate(); };
	if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => { wasTimeout = true; terminate(); }, opts.timeoutMs ?? 5000);

	cp.stdout.on("data", (c: Buffer) => {
		stdoutBytes += c.length;
		if (stdoutBytes > maxBytes) { truncated = true; terminate(); } else stdoutChunks.push(c);
	});
	cp.stderr.on("data", (c: Buffer) => {
		stderrBytes += c.length;
		if (stderrBytes > maxBytes) { truncated = true; terminate(); }
	});

	let exitCode: number | null = null, exitSig: NodeJS.Signals | null = null;
	try {
		await new Promise<void>((r) => { cp.once("close", (c, s) => { exitCode = c; exitSig = s; r(); }); cp.once("error", () => r()); });
	} finally {
		clearTimeout(timer);
		if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
	}

	const processExit = { code: exitCode, signal: exitSig };
	const postTestSha = fileSha256(resolvedTest);
	const postSrcSha = resolvedSrc !== undefined ? fileSha256(resolvedSrc) : undefined;

	if (wasTimeout) return fail("timeout", true, processExit, postTestSha, postSrcSha);
	if (wasAborted) return fail("aborted", true, processExit, postTestSha, postSrcSha);
	if (truncated) return fail("error", true, processExit, postTestSha, postSrcSha, true);
	if (postTestSha !== preTestSha || (resolvedSrc !== undefined && postSrcSha !== preSrcSha)) {
		return fail("error", true, processExit, postTestSha, postSrcSha);
	}

	const stdout = Buffer.concat(stdoutChunks).toString("utf8");
	let target: any, durationMs: number | undefined, eventsObserved = 0, rootSummary: any, hasGlobalFail = false, userBytes = 0;
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			const ev = JSON.parse(line);
			eventsObserved++;
			if (ev.type === "test:stdout" || ev.type === "test:stderr") {
				userBytes += ev.bytes ?? 0;
				if (userBytes > maxBytes) truncated = true;
			} else if (ev.type === "test:pass" || ev.type === "test:fail") {
				if (ev.data?.name === opts.testName) target = ev;
				else if (ev.type === "test:fail") hasGlobalFail = true;
			} else if (ev.type === "test:summary" && !ev.data?.file) rootSummary = ev.data;
		} catch {}
	}
	if (truncated) return fail("error", true, processExit, postTestSha, postSrcSha, true);

	let observedOutcome: ExecutionOutcome = "unmatched", failureReason: string | undefined, failureType: string | undefined;
	let assertionFailure: { message?: string; operator?: string; actual?: unknown; expected?: unknown; code?: string } | undefined;

	if (target) {
		durationMs = target.data?.details?.duration_ms;
		if (target.type === "test:pass") {
			const isSkip = target.data?.skip !== undefined && target.data?.skip !== false;
			if (isSkip) observedOutcome = "skipped";
			else if (exitCode === 0 && !hasGlobalFail && rootSummary?.success !== false) observedOutcome = "pass";
			else observedOutcome = "error";
		} else if (target.type === "test:fail") {
			failureType = target.data?.details?.error?.failureType;
			const cause = target.data?.details?.error?.cause;
			if (failureType === "testCodeFailure" && cause?.code === "ERR_ASSERTION" && !hasGlobalFail) {
				observedOutcome = "fail_assertion";
				assertionFailure = { message: cause?.message, operator: cause?.operator, actual: cause?.actual, expected: cause?.expected, code: cause?.code };
			} else {
				observedOutcome = "fail_setup";
				failureReason = cause?.message ?? target.data?.details?.error?.message ?? "Non-assertion failure";
			}
		}
	}

	return {
		id, timestamp, runner, supported: true, callerMetadata, targetedTest,
		provenance: makeProvenance(postTestSha, postSrcSha), processExit,
		execution: {
			observedOutcome, ...(durationMs !== undefined && { durationMs }),
			...(assertionFailure && { assertionFailure }), ...(failureReason && { failureReason }),
			...(failureType && { failureType }), eventsObserved, truncated: false,
		},
		verdict: { isAssertionRed: false, isGreen: false, failClosed: true, validationState: "unvalidated_capture" },
	};
}
