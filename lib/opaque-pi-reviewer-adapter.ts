import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

export const OPAQUE_PI_REVIEWER_ARGV = Object.freeze([
	"--print",
	// #1140: text mode turns a run that spent its turn on a tool call into zero
	// bytes and exit 0. JSON mode emits pi's own event stream, so the transport
	// can always tell a silent child from an assistant answer, and can recover
	// the answer text even when tool calls interleaved with it.
	"--mode", "json",
	"--no-session",
	"--no-tools",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
	"--no-approve",
] as const);

export const OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE = {
	SCRATCH_FAILED: "scratch-failed",
	LAUNCH_FAILED: "launch-failed",
	CANCELLED: "cancelled",
	TIMED_OUT: "timed-out",
	NONZERO_EXIT: "nonzero-exit",
	EMPTY_OUTPUT: "empty-output",
	CLEANUP_FAILED: "cleanup-failed",
} as const;
export type OpaquePiReviewerTransportFailureKind = (typeof OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE)[keyof typeof OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE];

export interface OpaquePiReviewerOptions {
	readonly piExecutable?: string;
	readonly environment?: NodeJS.ProcessEnv;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
	/**
	 * Caller-owned tokens appended verbatim after the frozen argv (spawn keeps
	 * shell:false, so every token is one argv entry). The adapter never
	 * interprets them; its caller owns their meaning and validation.
	 */
	readonly extraArguments?: readonly string[];
}

export interface OpaquePiReviewerResult {
	readonly stdout: Buffer;
	readonly promptByteLength: number;
	readonly stdoutByteLength: number;
}

export interface OpaquePiReviewerTransportDetails {
	readonly exitCode?: number | null;
	readonly stderr?: Buffer;
	readonly timedOut?: boolean;
	readonly cancelled?: boolean;
	/** Wall time for a launched Pi process; absent when no process was launched. */
	readonly elapsedMs?: number;
	/** The bound applied to a launched Pi process; absent when no process was launched. */
	readonly timeoutMs?: number;
	/** What the child's output stream revealed when no assistant answer could be recovered. */
	readonly evidence?: PiReviewOutputEvidence;
}

export class OpaquePiReviewerTransportError extends Error {
	readonly kind: OpaquePiReviewerTransportFailureKind;
	readonly exitCode: number | null;
	readonly stderr: Buffer;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	readonly elapsedMs: number | null;
	readonly timeoutMs: number | null;
	readonly evidence: PiReviewOutputEvidence | undefined;

	constructor(kind: OpaquePiReviewerTransportFailureKind, message: string, details: OpaquePiReviewerTransportDetails = {}) {
		super(message);
		this.name = "OpaquePiReviewerTransportError";
		this.kind = kind;
		this.exitCode = details.exitCode ?? null;
		this.stderr = details.stderr ?? Buffer.alloc(0);
		this.timedOut = details.timedOut ?? false;
		this.cancelled = details.cancelled ?? false;
		this.elapsedMs = details.elapsedMs ?? null;
		this.timeoutMs = details.timeoutMs ?? null;
		this.evidence = details.evidence;
	}
}

interface OpaquePiProcessResult {
	readonly stdout: Buffer;
	readonly stderr: Buffer;
	readonly exitCode: number | null;
	readonly timedOut: boolean;
	readonly cancelled: boolean;
	readonly elapsedMs: number;
	readonly timeoutMs: number;
}

const DEFAULT_OPAQUE_PI_TIMEOUT_MS = 600_000;

export interface PiLaunch {
	readonly file: string;
	readonly arguments: readonly string[];
}

interface PiHostProcess {
	readonly execPath: string;
	readonly entry: string | undefined;
}

/**
 * The exact spawn shape for the fresh Pi process. A bare `pi` on Windows
 * resolves to pi.cmd, pi.ps1, or a POSIX shim, none of which Node can spawn
 * with shell:false (EINVAL or ENOENT). This adapter already runs inside Pi, so
 * on win32 the host's own JavaScript entry is spawned through the host's
 * process.execPath instead; a shell is never enabled. Every other platform,
 * and every explicit launcher, keeps the exact shape it always had.
 */
export function resolvePiLaunch(
	piExecutable: string | undefined,
	platform: NodeJS.Platform = process.platform,
	host: PiHostProcess = { execPath: process.execPath, entry: process.argv[1] },
	extraArguments: readonly string[] = [],
): PiLaunch {
	const arguments_ = [...OPAQUE_PI_REVIEWER_ARGV, ...extraArguments];
	if (piExecutable !== undefined) return { file: piExecutable, arguments: arguments_ };
	if (platform !== "win32") return { file: "pi", arguments: arguments_ };
	if (typeof host.entry !== "string" || host.entry.length === 0 || !(platform === "win32" ? win32 : posix).isAbsolute(host.entry)) {
		throw new Error(`Pi host entry could not be resolved from the running process (received ${JSON.stringify(host.entry ?? null)}); a bare pi launcher cannot be spawned on Windows without a shell`);
	}
	return { file: host.execPath, arguments: [host.entry, ...arguments_] };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The child runs `pi --mode json`, so its stdout is a newline-delimited pi
// event stream. The transport's output is the assistant text of that stream —
// the same bytes an interactive run would have rendered — and everything else
// about the stream becomes typed evidence. A run whose turn was spent on a
// tool call therefore reports what happened (which reviewer selection ran,
// that a tool call was attempted) instead of exiting 0 in silence (#1140).
// ---------------------------------------------------------------------------

export interface PiReviewOutputEvidence {
	readonly stdoutKind: "no-output" | "not-a-pi-event-stream" | "no-assistant-text";
	/** The reviewer selection the child itself reported in its events, when it named one. */
	readonly reviewerModel?: string;
	readonly toolCallAttempted?: boolean;
}

export type PiReviewExtraction =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "none"; readonly evidence: PiReviewOutputEvidence };

interface PiEventMessagePart {
	type?: unknown;
	text?: unknown;
}

interface PiEventMessage {
	role?: unknown;
	content?: unknown;
}

interface PiEventEnvelope {
	type?: unknown;
	message?: unknown;
}

function parsePiEventLines(stdout: Buffer): PiEventEnvelope[] | undefined {
	const lines = stdout.toString("utf8").split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0) return undefined;
	const events: PiEventEnvelope[] = [];
	for (const line of lines) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return undefined;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		events.push(parsed as PiEventEnvelope);
	}
	return events;
}

export function extractPiAssistantText(stdout: Buffer): PiReviewExtraction {
	if (stdout.length === 0) return { kind: "none", evidence: { stdoutKind: "no-output" } };
	const events = parsePiEventLines(stdout);
	if (events === undefined) return { kind: "none", evidence: { stdoutKind: "not-a-pi-event-stream" } };
	const parts: string[] = [];
	let reviewerModel: string | undefined;
	let toolCallAttempted = false;
	for (const event of events) {
		// The final content of one assistant message lives in its end event;
		// start and update events repeat or stream the same parts.
		if (event.type !== "message_end") continue;
		const message = event.message;
		if (!message || typeof message !== "object" || Array.isArray(message)) continue;
		const candidate = message as PiEventMessage;
		if (candidate.role !== "assistant") continue;
		// The event envelope names the selection the child itself ran with the wire
		// key pi uses for it; read as quoted data, never as an identifier.
		const reported = (candidate as Record<string, unknown>)["model"];
		if (typeof reported === "string" && reported.length > 0 && reviewerModel === undefined) reviewerModel = reported;
		if (!Array.isArray(candidate.content)) continue;
		for (const part of candidate.content as PiEventMessagePart[]) {
			if (!part || typeof part !== "object") continue;
			if (typeof part.type === "string" && part.type.startsWith("tool")) toolCallAttempted = true;
			if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
		}
	}
	const text = parts.join("");
	if (text.length === 0) {
		return {
			kind: "none",
			evidence: {
				stdoutKind: "no-assistant-text",
				...(reviewerModel === undefined ? {} : { reviewerModel }),
				...(toolCallAttempted ? { toolCallAttempted } : {}),
			},
		};
	}
	return { kind: "text", text };
}

function emptyOutputMessage(evidence: PiReviewOutputEvidence): string {
	const details = [`stdout kind: ${evidence.stdoutKind}`];
	if (evidence.reviewerModel !== undefined) details.push(`reviewer selection: ${evidence.reviewerModel}`);
	if (evidence.toolCallAttempted) details.push("a tool call was attempted");
	return `Pi process produced no assistant text (${details.join("; ")})`;
}

function runPiProcess(prompt: Buffer, scratchDirectory: string, options: OpaquePiReviewerOptions): Promise<OpaquePiProcessResult> {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		let launch: PiLaunch;
		try {
			launch = resolvePiLaunch(options.piExecutable, process.platform, { execPath: process.execPath, entry: process.argv[1] }, options.extraArguments ?? []);
		} catch (error) {
			reject(error);
			return;
		}
		const child = spawn(launch.file, [...launch.arguments], {
			cwd: scratchDirectory,
			env: options.environment ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const timeoutMs = options.timeoutMs ?? DEFAULT_OPAQUE_PI_TIMEOUT_MS;
		let timedOut = false;
		let cancelled = false;
		let settled = false;
		const timer = timeoutMs > 0
			? setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeoutMs)
			: undefined;
		timer?.unref();
		const cancel = () => {
			cancelled = true;
			child.kill("SIGKILL");
		};
		const clear = () => {
			if (timer !== undefined) clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
		};

		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clear();
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clear();
			resolve({
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
				exitCode: code,
				timedOut,
				cancelled,
				elapsedMs: Date.now() - startedAt,
				timeoutMs,
			});
		});
		if (options.signal?.aborted) cancel();
		else options.signal?.addEventListener("abort", cancel, { once: true });
		child.stdin.on("error", () => undefined);
		child.stdin.end(prompt);
	});
}

/** Runs raw prompt bytes through one fixed, isolated Pi process. */
export async function runOpaquePiReviewer(prompt: Buffer, options: OpaquePiReviewerOptions = {}): Promise<OpaquePiReviewerResult> {
	if (options.signal?.aborted) {
		throw new OpaquePiReviewerTransportError(
			OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.CANCELLED,
			"Pi process was cancelled before launch",
			{ cancelled: true },
		);
	}
	if (options.extraArguments !== undefined && options.extraArguments.some((token) => typeof token !== "string" || token.length === 0)) {
		throw new TypeError("Pi reviewer launch arguments must all be non-empty strings");
	}

	let scratchDirectory: string | undefined;
	let primaryFailure = false;
	try {
		try {
			scratchDirectory = await mkdtemp(join(tmpdir(), "gentle-pi-opaque-reviewer-"));
			await chmod(scratchDirectory, 0o700);
		} catch (error) {
			throw new OpaquePiReviewerTransportError(
				OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.SCRATCH_FAILED,
				`Pi scratch directory could not be prepared: ${errorMessage(error)}`,
			);
		}

		let processResult: OpaquePiProcessResult;
		try {
			processResult = await runPiProcess(prompt, scratchDirectory, options);
		} catch (error) {
			if (options.signal?.aborted) {
				throw new OpaquePiReviewerTransportError(
					OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.CANCELLED,
					"Pi process was cancelled",
					{ cancelled: true },
				);
			}
			throw new OpaquePiReviewerTransportError(
				OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.LAUNCH_FAILED,
				`Pi process could not start: ${errorMessage(error)}`,
			);
		}
		const timing = {
			elapsedMs: processResult.elapsedMs,
			timeoutMs: processResult.timeoutMs,
		};
		if (processResult.timedOut) {
			throw new OpaquePiReviewerTransportError(
				OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.TIMED_OUT,
				"Pi process timed out",
				{ exitCode: processResult.exitCode, stderr: processResult.stderr, timedOut: true, ...timing },
			);
		}
		if (processResult.cancelled) {
			throw new OpaquePiReviewerTransportError(
				OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.CANCELLED,
				"Pi process was cancelled",
				{ exitCode: processResult.exitCode, stderr: processResult.stderr, cancelled: true, ...timing },
			);
		}
		if (processResult.exitCode !== 0) {
			throw new OpaquePiReviewerTransportError(
				OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.NONZERO_EXIT,
				"Pi process failed",
				{ exitCode: processResult.exitCode, stderr: processResult.stderr, ...timing },
			);
		}
		const extraction = extractPiAssistantText(processResult.stdout);
		if (extraction.kind === "none") {
			throw new OpaquePiReviewerTransportError(
				OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.EMPTY_OUTPUT,
				emptyOutputMessage(extraction.evidence),
				{ exitCode: 0, stderr: processResult.stderr, evidence: extraction.evidence, ...timing },
			);
		}
		const stdout = Buffer.from(extraction.text, "utf8");
		return {
			stdout,
			promptByteLength: prompt.length,
			stdoutByteLength: stdout.length,
		};
	} catch (error) {
		primaryFailure = true;
		throw error;
	} finally {
		if (scratchDirectory !== undefined) {
			try {
				await rm(scratchDirectory, { recursive: true, force: true });
			} catch (error) {
				if (!primaryFailure) {
					throw new OpaquePiReviewerTransportError(
						OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.CLEANUP_FAILED,
						`Pi scratch directory cleanup failed: ${errorMessage(error)}`,
					);
				}
			}
		}
	}
}
