import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	OPAQUE_PI_REVIEWER_ARGV,
	OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE,
	OpaquePiReviewerTransportError,
	extractPiAssistantText,
	resolvePiLaunch,
	runOpaquePiReviewer,
} from "../lib/opaque-pi-reviewer-adapter.ts";

const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
	const stdin = Buffer.concat(chunks);
	if (process.env.OPAQUE_PI_STDIN_CAPTURE) fs.writeFileSync(process.env.OPAQUE_PI_STDIN_CAPTURE, stdin);
	const mode = process.env.OPAQUE_PI_MODE || "ok";
	const log = {
		argv,
		cwd: process.cwd(),
		entries_before: fs.readdirSync(process.cwd()),
		entries_after: fs.readdirSync(process.cwd()),
	};
	if (process.env.OPAQUE_PI_LOG) fs.appendFileSync(process.env.OPAQUE_PI_LOG, JSON.stringify(log) + "\\n");
	if (mode === "break-cleanup" || process.env.OPAQUE_PI_BREAK_CLEANUP === "true") {
		fs.chmodSync(path.dirname(process.cwd()), 0o500);
	}
	if (mode === "empty") process.exit(0);
	if (mode === "hang") { setTimeout(() => process.exit(0), 10_000); return; }
	if (mode === "nonzero") { process.stderr.write("opaque pi failed\\n"); process.exit(7); }
	process.stdout.write(Buffer.from(process.env.OPAQUE_PI_OUTPUT_B64 || "", "base64"));
});
`;

const PROMPT_BYTES = Buffer.concat([
	Buffer.from("opaque prompt\r\n\u0000", "utf8"),
	Buffer.from([0x01, 0xff, 0xfe, 0x00]),
]);
const DEFAULT_OUTPUT_TEXT = "opaque output\r\n\u03b5 \u2014 unicode stays intact\n";

const OUTPUT_BYTES = piEventStream(
	...userTurn("opaque prompt"),
	...assistantTurn([{ type: "text", text: DEFAULT_OUTPUT_TEXT }]),
);

interface OpaqueHarness {
	directory: string;
	pi: string;
	logPath: string;
	stdinCapturePath: string;
	environment: NodeJS.ProcessEnv;
}

interface OpaquePiLog {
	argv: string[];
	cwd: string;
	entries_before: string[];
	entries_after: string[];
}

function harness(t: test.TestContext, overrides: Record<string, string> = {}): OpaqueHarness {
	const directory = mkdtempSync(join(tmpdir(), "gentle-pi-opaque-reviewer-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const pi = join(directory, "pi");
	writeFileSync(pi, FAKE_PI);
	chmodSync(pi, 0o755);
	const logPath = join(directory, "pi.log");
	const stdinCapturePath = join(directory, "stdin.bin");
	return {
		directory,
		pi,
		logPath,
		stdinCapturePath,
		environment: {
			...process.env,
			OPAQUE_PI_LOG: logPath,
			OPAQUE_PI_STDIN_CAPTURE: stdinCapturePath,
			OPAQUE_PI_OUTPUT_B64: OUTPUT_BYTES.toString("base64"),
			...overrides,
		},
	};
}

function readLog(path: string): OpaquePiLog[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as OpaquePiLog);
}

// The reviewer child runs `pi --mode json`, so its stdout is a newline-
// delimited pi event stream. These helpers build the minimal stream shapes the
// extraction has to understand, including the shapes behind the empty-output
// field reports (#1140: a reviewer that answers with a tool call writes zero
// usable bytes in text mode and exits 0 in silence).
function piEventStream(...events: readonly unknown[]): Buffer {
	return Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
}

function userTurn(text: string): unknown[] {
	const message = { role: "user", content: [{ type: "text", text }] };
	return [
		{ type: "message_start", message },
		{ type: "message_end", message },
	];
}

function assistantTurn(parts: readonly Record<string, unknown>[], reviewerModel?: string): unknown[] {
	const content = parts.map((part) => ({ ...part }));
	const message: Record<string, unknown> = { role: "assistant", content };
	if (reviewerModel !== undefined) message.model = reviewerModel;
	return [
		{ type: "message_start", message },
		{ type: "message_end", message },
		{ type: "agent_end", messages: [message] },
	];
}

async function rejectsWithTransportError(
	promise: Promise<unknown>,
	kind: (typeof OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE)[keyof typeof OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE],
): Promise<OpaquePiReviewerTransportError> {
	let caught: OpaquePiReviewerTransportError | undefined;
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(error instanceof OpaquePiReviewerTransportError, `expected OpaquePiReviewerTransportError, received ${String(error)}`);
		caught = error;
		return error.kind === kind;
	});
	return caught!;
}

// #1140/#1156: the child runs `pi --mode json` and the transport emits the
// final assistant text of that event stream. The prompt side stays byte-
// verbatim; the output side is pi's own envelope, so a silent or unintelligible
// run becomes a typed, evidenced failure instead of zero bytes and exit 0.
const OUTPUT_TEXT = "opaque output\r\n\u03b5 \u2014 unicode stays intact\nsecond assistant text part";

function eventStreamFor(text: string): Buffer {
	return piEventStream(
		...userTurn("opaque prompt"),
		...assistantTurn([{ type: "text", text }], "pi-test-model"),
		{ type: "agent_settled" },
	);
}

test("the opaque adapter streams the prompt verbatim and emits the pi event stream's final assistant text", async (t) => {
	const fixture = harness(t, { OPAQUE_PI_OUTPUT_B64: eventStreamFor(OUTPUT_TEXT).toString("base64") });
	const result = await runOpaquePiReviewer(PROMPT_BYTES, {
		piExecutable: fixture.pi,
		environment: fixture.environment,
		timeoutMs: 10_000,
	});

	assert.equal(result.promptByteLength, PROMPT_BYTES.length);
	assert.equal(result.stdoutByteLength, Buffer.byteLength(OUTPUT_TEXT));
	assert.deepEqual(result.stdout, Buffer.from(OUTPUT_TEXT, "utf8"));
	assert.deepEqual(readFileSync(fixture.stdinCapturePath), PROMPT_BYTES);

	const calls = readLog(fixture.logPath);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]!.argv, [...OPAQUE_PI_REVIEWER_ARGV]);
	assert.deepEqual(calls[0]!.entries_before, []);
	assert.deepEqual(calls[0]!.entries_after, []);
	assert.notEqual(calls[0]!.cwd, process.cwd());
	assert.equal(existsSync(calls[0]!.cwd), false, "the empty scratch directory is removed after success");
});

test("the extraction mirrors the pi event stream: every assistant text part in order, nothing else", () => {
	const streamed = piEventStream(
		...userTurn("prompt"),
		...assistantTurn([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "first " }], "pi-a"),
		...assistantTurn([{ type: "text", text: "second" }], "pi-b"),
	);
	const extracted = extractPiAssistantText(streamed);
	assert.equal(extracted.kind, "text");
	if (extracted.kind === "text") assert.equal(extracted.text, "first second");

	const single = extractPiAssistantText(eventStreamFor("{\"findings\": []}"));
	assert.equal(single.kind, "text");
	if (single.kind === "text") assert.equal(single.text, "{\"findings\": []}");

	// A stream pi could not have produced is not silently passed through.
	assert.equal(extractPiAssistantText(Buffer.from("garbage, not an event stream", "utf8")).kind, "none");
	assert.equal(extractPiAssistantText(Buffer.alloc(0)).kind, "none");
});

test("a silent or unintelligible reviewer run fails typed with the evidence the event stream carries", async (t) => {
	const fixture = harness(t);

	const silent = await rejectsWithTransportError(
		runOpaquePiReviewer(PROMPT_BYTES, { piExecutable: fixture.pi, environment: { ...fixture.environment, OPAQUE_PI_MODE: "empty" }, timeoutMs: 10_000 }),
		OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.EMPTY_OUTPUT,
	);
	assert.equal(silent.evidence?.stdoutKind, "no-output");

	const unintelligible = await rejectsWithTransportError(
		runOpaquePiReviewer(PROMPT_BYTES, { piExecutable: fixture.pi, environment: { ...fixture.environment, OPAQUE_PI_OUTPUT_B64: Buffer.from("not json at all", "utf8").toString("base64") }, timeoutMs: 10_000 }),
		OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.EMPTY_OUTPUT,
	);
	assert.equal(unintelligible.evidence?.stdoutKind, "not-a-pi-event-stream");
	assert.match(unintelligible.message, /no assistant text|not a pi event stream|no output/i);

	const textless = await rejectsWithTransportError(
		runOpaquePiReviewer(PROMPT_BYTES, { piExecutable: fixture.pi, environment: { ...fixture.environment, OPAQUE_PI_OUTPUT_B64: piEventStream(...userTurn("prompt"), { type: "agent_settled" }).toString("base64") }, timeoutMs: 10_000 }),
		OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.EMPTY_OUTPUT,
	);
	assert.equal(textless.evidence?.stdoutKind, "no-assistant-text");
});

test("a reviewer run that spent its turn on a tool call reports that in the evidence instead of vanishing", async (t) => {
	const fixture = harness(t, {
		OPAQUE_PI_OUTPUT_B64: piEventStream(
			...userTurn("prompt"),
			...assistantTurn([{ type: "toolCall", id: "call_1", name: "bash" }], "nan/deepseek-v4-flash"),
		).toString("base64"),
	});
	const error = await rejectsWithTransportError(
		runOpaquePiReviewer(PROMPT_BYTES, { piExecutable: fixture.pi, environment: fixture.environment, timeoutMs: 10_000 }),
		OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.EMPTY_OUTPUT,
	);
	assert.equal(error.evidence?.stdoutKind, "no-assistant-text");
	assert.equal(error.evidence?.toolCallAttempted, true);
	assert.equal(error.evidence?.reviewerModel, "nan/deepseek-v4-flash");
	assert.match(error.message, /tool call/i);
	assert.match(error.message, /nan\/deepseek-v4-flash/);
});

test("a tool-call attempt followed by text still yields the text", async (t) => {
	const fixture = harness(t, {
		OPAQUE_PI_OUTPUT_B64: piEventStream(
			...userTurn("prompt"),
			...assistantTurn([{ type: "toolCall", id: "call_1", name: "bash" }]),
			...assistantTurn([{ type: "text", text: "{\"verdict\": \"pass\"}" }], "nan/glm5.3-flash"),
		).toString("base64"),
	});
	const result = await runOpaquePiReviewer(PROMPT_BYTES, { piExecutable: fixture.pi, environment: fixture.environment, timeoutMs: 10_000 });
	assert.deepEqual(result.stdout, Buffer.from("{\"verdict\": \"pass\"}", "utf8"));
});

test("caller-owned launch arguments ride the frozen argv verbatim and are validated before spawn", async (t) => {
	const fixture = harness(t, { OPAQUE_PI_OUTPUT_B64: eventStreamFor("ok").toString("base64") });
	await runOpaquePiReviewer(PROMPT_BYTES, {
		piExecutable: fixture.pi,
		environment: fixture.environment,
		timeoutMs: 10_000,
		extraArguments: ["--model", "nan/glm5.3-flash", "-e", "/abs/auth-adapter.ts"],
	});
	const calls = readLog(fixture.logPath);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]!.argv, [...OPAQUE_PI_REVIEWER_ARGV, "--model", "nan/glm5.3-flash", "-e", "/abs/auth-adapter.ts"]);

	await assert.rejects(
		runOpaquePiReviewer(PROMPT_BYTES, { piExecutable: fixture.pi, environment: fixture.environment, timeoutMs: 10_000, extraArguments: ["--model", ""] }),
		/non-empty/,
	);
	await assert.rejects(
		runOpaquePiReviewer(PROMPT_BYTES, { piExecutable: fixture.pi, environment: fixture.environment, timeoutMs: 10_000, extraArguments: [42 as unknown as string] }),
		/non-empty/,
	);
});

test("the opaque adapter returns typed transport errors for launch, nonzero, empty, timeout, and cancellation", async (t) => {
	const fixture = harness(t);
	await rejectsWithTransportError(
		runOpaquePiReviewer(PROMPT_BYTES, { piExecutable: join(fixture.directory, "missing-pi"), environment: fixture.environment, timeoutMs: 10_000 }),
		OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.LAUNCH_FAILED,
	);

	const nonzero = await rejectsWithTransportError(
		runOpaquePiReviewer(PROMPT_BYTES, { piExecutable: fixture.pi, environment: { ...fixture.environment, OPAQUE_PI_MODE: "nonzero" }, timeoutMs: 10_000 }),
		OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.NONZERO_EXIT,
	);
	assert.equal(nonzero.exitCode, 7);
	assert.deepEqual(nonzero.stderr, Buffer.from("opaque pi failed\n"));

	await rejectsWithTransportError(
		runOpaquePiReviewer(PROMPT_BYTES, { piExecutable: fixture.pi, environment: { ...fixture.environment, OPAQUE_PI_MODE: "empty" }, timeoutMs: 10_000 }),
		OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.EMPTY_OUTPUT,
	);

	const timedOut = await rejectsWithTransportError(
		runOpaquePiReviewer(PROMPT_BYTES, { piExecutable: fixture.pi, environment: { ...fixture.environment, OPAQUE_PI_MODE: "hang" }, timeoutMs: 300 }),
		OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.TIMED_OUT,
	);
	assert.equal(timedOut.timedOut, true);

	const controller = new AbortController();
	const cancellation = runOpaquePiReviewer(PROMPT_BYTES, {
		piExecutable: fixture.pi,
		environment: { ...fixture.environment, OPAQUE_PI_MODE: "hang" },
		timeoutMs: 10_000,
		signal: controller.signal,
	});
	setTimeout(() => controller.abort(), 100).unref();
	const cancelled = await rejectsWithTransportError(cancellation, OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.CANCELLED);
	assert.equal(cancelled.cancelled, true);
});

test("the opaque adapter leaves no prompt or result file in scratch and reports cleanup failure as transport-only", async (t) => {
	const fixture = harness(t);
	const scratchParent = mkdtempSync(join(tmpdir(), "gentle-pi-opaque-reviewer-cleanup-"));
	const originalTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = scratchParent;
	try {
		const error = await rejectsWithTransportError(
			runOpaquePiReviewer(PROMPT_BYTES, {
				piExecutable: fixture.pi,
				environment: { ...fixture.environment, OPAQUE_PI_MODE: "break-cleanup" },
				timeoutMs: 10_000,
			}),
			OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.CLEANUP_FAILED,
		);
		assert.match(error.message, /scratch directory/i);
	} finally {
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
		chmodSync(scratchParent, 0o700);
		rmSync(scratchParent, { recursive: true, force: true });
	}
});

test("the opaque adapter preserves primary nonzero and timeout errors when scratch cleanup also fails", async (t) => {
	const fixture = harness(t);
	const scratchParent = mkdtempSync(join(tmpdir(), "gentle-pi-opaque-reviewer-primary-failure-"));
	const originalTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = scratchParent;
	try {
		const nonzero = await rejectsWithTransportError(
			runOpaquePiReviewer(PROMPT_BYTES, {
				piExecutable: fixture.pi,
				environment: { ...fixture.environment, OPAQUE_PI_MODE: "nonzero", OPAQUE_PI_BREAK_CLEANUP: "true" },
				timeoutMs: 10_000,
			}),
			OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.NONZERO_EXIT,
		);
		assert.equal(nonzero.exitCode, 7);
		assert.deepEqual(nonzero.stderr, Buffer.from("opaque pi failed\n"));
		chmodSync(scratchParent, 0o700);

		const timedOut = await rejectsWithTransportError(
			runOpaquePiReviewer(PROMPT_BYTES, {
				piExecutable: fixture.pi,
				environment: { ...fixture.environment, OPAQUE_PI_MODE: "hang", OPAQUE_PI_BREAK_CLEANUP: "true" },
				timeoutMs: 300,
			}),
			OPAQUE_PI_REVIEWER_TRANSPORT_FAILURE.TIMED_OUT,
		);
		assert.equal(timedOut.timedOut, true);
	} finally {
		if (originalTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmpdir;
		chmodSync(scratchParent, 0o700);
		rmSync(scratchParent, { recursive: true, force: true });
	}
});

test("the opaque adapter has no review lifecycle imports or identifiers", () => {
	const adapterPath = fileURLToPath(new URL("../lib/opaque-pi-reviewer-adapter.ts", import.meta.url));
	const source = readFileSync(adapterPath, "utf8");
	assert.doesNotMatch(source, /review-integration|gentle-ai|materialize|submit/i);
	// The guard reads source, not strings: the one lifecycle-shaped word the
	// transport may spell is pi's own quoted wire key for the selection the
	// child reports in its events (#1140). It is data there, never an
	// identifier, so it is stripped before the scan.
	const withoutWireKeys = source.replaceAll('"model"', '""');
	for (const identifier of ["lineage", "target", "revision", "receipt", "lens", "order", "subject", "schema", "capture", "submission", "status", "model", "provider", "profile"]) {
		assert.doesNotMatch(withoutWireKeys, new RegExp(`\\b${identifier}\\b`, "i"), `adapter must not contain lifecycle identifier ${identifier}`);
	}
});

// #468 / #519: on Windows a bare `pi` resolves to pi.cmd, pi.ps1, or a POSIX
// shim, none of which Node can spawn with shell:false (EINVAL or ENOENT). The
// relay already runs inside Pi, so the host's own JavaScript entry is spawned
// through process.execPath instead. Other platforms keep today's exact shape.
test("the Pi launch shape spawns the host entry through process.execPath on win32 and stays byte-identical elsewhere", () => {
	const host = {
		execPath: "C:\\Program Files\\nodejs\\node.exe",
		entry: "C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js",
	};
	const windows = resolvePiLaunch(undefined, "win32", host);
	assert.deepEqual(windows, { file: host.execPath, arguments: [host.entry, ...OPAQUE_PI_REVIEWER_ARGV] });
	assert.notEqual(windows.file, "pi");
	assert.equal(windows.arguments.includes("pi"), false);
	for (const platform of ["linux", "darwin", "freebsd"] as const) {
		assert.deepEqual(resolvePiLaunch(undefined, platform, host), { file: "pi", arguments: [...OPAQUE_PI_REVIEWER_ARGV] }, platform);
		assert.deepEqual(resolvePiLaunch("/opt/pi/bin/pi", platform, host), { file: "/opt/pi/bin/pi", arguments: [...OPAQUE_PI_REVIEWER_ARGV] }, platform);
	}
	assert.deepEqual(resolvePiLaunch("C:\\tools\\pi.exe", "win32", host), { file: "C:\\tools\\pi.exe", arguments: [...OPAQUE_PI_REVIEWER_ARGV] });
	for (const entry of [undefined, "", "cli.js", "dist/bundle/cli.js"]) {
		assert.throws(() => resolvePiLaunch(undefined, "win32", { execPath: host.execPath, entry }), /host entry/, `entry ${JSON.stringify(entry)} must fail closed instead of spawning a bare pi`);
	}
});

test("the default Pi launch resolves from the running host process", () => {
	const launch = resolvePiLaunch(undefined);
	if (process.platform === "win32") {
		assert.deepEqual(launch, { file: process.execPath, arguments: [process.argv[1]!, ...OPAQUE_PI_REVIEWER_ARGV] });
	} else {
		assert.deepEqual(launch, { file: "pi", arguments: [...OPAQUE_PI_REVIEWER_ARGV] });
	}
});
