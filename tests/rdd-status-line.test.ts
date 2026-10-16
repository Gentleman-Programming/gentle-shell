import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import {
	NATIVE_REVIEW_ERROR_CODE,
	NATIVE_REVIEW_MODE_OPERATION,
	NATIVE_REVIEW_OPERATION,
	NativeReviewCliError,
	NATIVE_REVIEW_MODE_SOURCE,
	type NativeReviewCli,
	type NativeReviewModeRequest,
	type NativeReviewModeResult,
	type NativeReviewModeStatus,
} from "../lib/native-review-cli.ts";

// ---------------------------------------------------------------------------
// gentle-pi#661: the always-on parent prompt renders a second status line,
// `Receipt-driven development: on|off (decided by <source>)`, next to
// `Background subagent policy`, sourced from the native review mode status
// reader (`gentle-ai review mode status --json`, schema
// `gentle-ai.rdd-mode-status/v1`, decoded to `NativeReviewModeStatus`).
//
// `getOrchestratorPrompt`/`renderOrchestratorPrompt` stay synchronous and
// default `rddStatusLine` to the "unknown (native status unavailable)" line
// -- the longest of the three renderable forms -- so a no-argument call IS
// the worst case the canonical 8 KiB budget in
// tests/orchestrator-budget.test.ts measures, not a smaller placeholder
// production later exceeds. Production (before_agent_start) still resolves
// and passes the real on/off/unknown line through `resolveRddStatusLine`,
// bounded by `RDD_STATUS_TIMEOUT_MS` and memoized per cwd for
// `RDD_STATUS_MEMO_TTL_MS` so a hung or repeatedly-invoked native reader
// cannot stall or repeatedly respawn on every session/agent-start build.
// ---------------------------------------------------------------------------

const {
	renderRddStatusLine,
	pinRddStatusLine,
	resolveRddModeStatus,
	resolveRddStatusLine,
	getOrchestratorPrompt,
	clearRddStatusMemoForTesting,
	RDD_STATUS_TIMEOUT_MS,
	RDD_STATUS_MEMO_TTL_MS,
} = __testing;

function fakeReviewMode(
	result: NativeReviewModeResult | (() => never) | (() => Promise<never>),
): Pick<NativeReviewCli, "reviewMode"> {
	return {
		async reviewMode(_request: NativeReviewModeRequest): Promise<NativeReviewModeResult> {
			if (typeof result === "function") return result();
			return result;
		},
	};
}

function modeResult(effective: "on" | "off", source: (typeof NATIVE_REVIEW_MODE_SOURCE)[keyof typeof NATIVE_REVIEW_MODE_SOURCE]): NativeReviewModeResult {
	return {
		operation: NATIVE_REVIEW_MODE_OPERATION.STATUS,
		scope: "global",
		status: {
			global: source === NATIVE_REVIEW_MODE_SOURCE.GLOBAL ? effective : "",
			cloneLocal: source === NATIVE_REVIEW_MODE_SOURCE.CLONE_LOCAL ? effective : "",
			effective,
			source,
		},
	};
}

// A counting wrapper for memo tests: counts how many times reviewMode is
// actually invoked, independent of how many times resolveRddModeStatus is
// called.
function countingReviewMode(result: NativeReviewModeResult): { cli: Pick<NativeReviewCli, "reviewMode">; calls: () => number } {
	let calls = 0;
	return {
		cli: {
			async reviewMode(_request: NativeReviewModeRequest): Promise<NativeReviewModeResult> {
				calls += 1;
				return result;
			},
		},
		calls: () => calls,
	};
}

test("renderRddStatusLine renders the fail-closed unknown line for an unresolved status", () => {
	assert.equal(
		renderRddStatusLine(undefined),
		"Receipt-driven development: unknown (native status unavailable)",
	);
});

test("renderRddStatusLine renders the effective mode and deciding source", () => {
	assert.equal(
		renderRddStatusLine({ global: "on", cloneLocal: "", effective: "on", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL }),
		"Receipt-driven development: on (decided by global)",
	);
	assert.equal(
		renderRddStatusLine({ global: "off", cloneLocal: "", effective: "off", source: NATIVE_REVIEW_MODE_SOURCE.DEFAULT }),
		"Receipt-driven development: off (decided by default)",
	);
});

test("synthetic default-ON status renders and is injected without a Shell default override", async () => {
	clearRddStatusMemoForTesting();
	const result = modeResult("on", NATIVE_REVIEW_MODE_SOURCE.DEFAULT);
	assert.deepEqual(result.status, { global: "", cloneLocal: "", effective: "on", source: "default" });
	const expected = "Receipt-driven development: on (decided by default)";
	assert.equal(renderRddStatusLine(result.status), expected);
	const line = await resolveRddStatusLine(fakeReviewMode(result), "/repo-synthetic-default-on");
	assert.equal(line, expected);
	assert.ok(getOrchestratorPrompt(process.cwd(), undefined, line).includes(expected));
});

test("renderRddStatusLine fails closed to unknown for a malformed or partial status object", () => {
	// A bad upstream decode, a future field rename, or a hand-built fixture
	// must never render an unrecognized value verbatim -- the render boundary
	// validates independently of the type signature.
	const malformed: readonly NativeReviewModeStatus[] = [
		{} as NativeReviewModeStatus,
		{ effective: "maybe" } as unknown as NativeReviewModeStatus,
		{ effective: "on" } as NativeReviewModeStatus, // missing source
		{ effective: "on", source: "not-a-real-source" } as unknown as NativeReviewModeStatus,
		{ global: "on", cloneLocal: "", effective: "ON", source: NATIVE_REVIEW_MODE_SOURCE.GLOBAL } as unknown as NativeReviewModeStatus,
		null as unknown as NativeReviewModeStatus,
	];
	for (const status of malformed) {
		assert.equal(
			renderRddStatusLine(status),
			"Receipt-driven development: unknown (native status unavailable)",
			`expected unknown line for ${JSON.stringify(status)}`,
		);
	}
});

test("resolveRddModeStatus reads the on status from a stubbed native reviewMode reader", async () => {
	clearRddStatusMemoForTesting();
	const status = await resolveRddModeStatus(fakeReviewMode(modeResult("on", NATIVE_REVIEW_MODE_SOURCE.CLONE_LOCAL)), "/repo-on");
	assert.deepEqual(status, {
		global: "",
		cloneLocal: "on",
		effective: "on",
		source: "clone_local",
	});
});

test("resolveRddModeStatus reads the off status from a stubbed native reviewMode reader", async () => {
	clearRddStatusMemoForTesting();
	const status = await resolveRddModeStatus(fakeReviewMode(modeResult("off", NATIVE_REVIEW_MODE_SOURCE.GLOBAL)), "/repo-off");
	assert.equal(status?.effective, "off");
	assert.equal(status?.source, "global");
});

test("resolveRddModeStatus resolves to undefined when the native review CLI wrapper is null or absent", async () => {
	for (const wrapper of [undefined, null] as const) {
		clearRddStatusMemoForTesting();
		const status = await resolveRddModeStatus(wrapper, "/repo-no-wrapper");
		assert.equal(status, undefined, `expected undefined for a ${wrapper === null ? "null" : "missing"} wrapper`);
	}
});

test("resolveRddModeStatus resolves to undefined when the native reviewMode call rejects", async () => {
	clearRddStatusMemoForTesting();
	const status = await resolveRddModeStatus(
		fakeReviewMode(() => {
			throw new Error("native process failed");
		}),
		"/repo-rejecting",
	);
	assert.equal(status, undefined);
});

test("resolveRddModeStatus resolves to undefined within the deadline when reviewMode never settles", async () => {
	// gentle-pi#661 native-review escalation: a hung `gentle-ai` child must
	// not stall session start. resolveRddModeStatus races the call against
	// its own abort listener, so this holds even for a stub reviewMode that
	// itself ignores the passed `signal`, as a real hung child process would
	// eventually be killed and reject via its own signal handling.
	clearRddStatusMemoForTesting();
	const neverSettling = fakeReviewMode(() => new Promise<never>(() => {}));
	const deadlineMs = 150;
	const start = Date.now();
	const keepalive = setTimeout(() => {}, deadlineMs + 2000);
	try {
		const status = await resolveRddModeStatus(neverSettling, "/repo-hung", AbortSignal.timeout(deadlineMs));
		const elapsed = Date.now() - start;
		assert.equal(status, undefined);
		assert.ok(elapsed < deadlineMs + 1000, `expected the read to resolve near the ${deadlineMs}ms deadline, took ${elapsed}ms`);
	} finally {
		clearTimeout(keepalive);
	}
});

test("resolveRddModeStatus memoizes a resolved status per cwd for RDD_STATUS_MEMO_TTL_MS", async () => {
	clearRddStatusMemoForTesting();
	const { cli, calls } = countingReviewMode(modeResult("on", NATIVE_REVIEW_MODE_SOURCE.GLOBAL));
	const cwd = "/repo-memo-hit";
	const first = await resolveRddModeStatus(cli, cwd);
	const second = await resolveRddModeStatus(cli, cwd);
	assert.deepEqual(first, second);
	assert.equal(calls(), 1, "a second call within the TTL must reuse the memoized status, not respawn the native reader");
});

test("resolveRddModeStatus re-reads once the memoized status expires", async () => {
	clearRddStatusMemoForTesting();
	const { cli, calls } = countingReviewMode(modeResult("on", NATIVE_REVIEW_MODE_SOURCE.GLOBAL));
	const cwd = "/repo-memo-expiry";
	let clock = 1_000_000;
	const now = () => clock;
	await resolveRddModeStatus(cli, cwd, undefined, now);
	assert.equal(calls(), 1);
	clock += RDD_STATUS_MEMO_TTL_MS + 1;
	await resolveRddModeStatus(cli, cwd, undefined, now);
	assert.equal(calls(), 2, "a call after the TTL elapses must re-read rather than reuse the stale memo");
});

test("resolveRddModeStatus memoizes independently per cwd", async () => {
	clearRddStatusMemoForTesting();
	const { cli, calls } = countingReviewMode(modeResult("on", NATIVE_REVIEW_MODE_SOURCE.GLOBAL));
	await resolveRddModeStatus(cli, "/repo-a");
	await resolveRddModeStatus(cli, "/repo-b");
	assert.equal(calls(), 2, "distinct cwds must not share a memo entry");
});

test("resolveRddStatusLine renders on, off, and unavailable from the stubbed native reader", async () => {
	clearRddStatusMemoForTesting();
	assert.equal(
		await resolveRddStatusLine(fakeReviewMode(modeResult("on", NATIVE_REVIEW_MODE_SOURCE.GLOBAL)), "/repo-line-on"),
		"Receipt-driven development: on (decided by global)",
	);
	assert.equal(
		await resolveRddStatusLine(fakeReviewMode(modeResult("off", NATIVE_REVIEW_MODE_SOURCE.DEFAULT)), "/repo-line-off"),
		"Receipt-driven development: off (decided by default)",
	);
	for (const source of [NATIVE_REVIEW_MODE_SOURCE.GLOBAL, NATIVE_REVIEW_MODE_SOURCE.CLONE_LOCAL]) {
		assert.equal(
			await resolveRddStatusLine(fakeReviewMode(modeResult("off", source)), `/repo-line-off-${source}`),
			`Receipt-driven development: off (decided by ${source})`,
		);
	}
	assert.equal(
		await resolveRddStatusLine(undefined, "/repo-line-unknown"),
		"Receipt-driven development: unknown (native status unavailable)",
	);
});

test("RDD_STATUS_TIMEOUT_MS is a small, positive bounded-deadline constant", () => {
	assert.equal(typeof RDD_STATUS_TIMEOUT_MS, "number");
	assert.ok(RDD_STATUS_TIMEOUT_MS > 0 && RDD_STATUS_TIMEOUT_MS <= 10_000);
});

test("getOrchestratorPrompt renders the resolved RDD status line next to the background policy line", () => {
	const cwd = process.cwd();
	for (const line of [
		"Receipt-driven development: on (decided by global)",
		"Receipt-driven development: off (decided by default)",
		"Receipt-driven development: unknown (native status unavailable)",
	]) {
		const rendered = getOrchestratorPrompt(cwd, undefined, line);
		assert.ok(rendered.includes(line), `rendered prompt missing RDD status line: ${line}`);
		assert.match(rendered, /Background subagent policy: (?:on|off) \(capability: (?:ready|absent)\)/);
	}
});

test("getOrchestratorPrompt defaults to the worst-case unknown RDD status line (budget-critical path)", () => {
	// gentle-pi#661 follow-up: the no-argument default must BE the worst case
	// the byte budget in tests/orchestrator-budget.test.ts measures, so a
	// caller that never resolves a status renders the longest line rather
	// than none at all.
	const rendered = getOrchestratorPrompt();
	assert.ok(rendered.includes("Receipt-driven development: unknown (native status unavailable)"));
});

test("the prompt cache key distinguishes on, off, and unknown so each renders a distinct prompt", () => {
	const cwd = process.cwd();
	const on = getOrchestratorPrompt(cwd, undefined, "Receipt-driven development: on (decided by global)");
	const off = getOrchestratorPrompt(cwd, undefined, "Receipt-driven development: off (decided by default)");
	const unknown = getOrchestratorPrompt(cwd, undefined, "Receipt-driven development: unknown (native status unavailable)");
	const none = getOrchestratorPrompt(cwd);
	assert.notEqual(on, off);
	assert.notEqual(off, unknown);
	assert.notEqual(on, unknown);
	// The no-argument default renders the same worst-case "unknown" line, so
	// it is the same prompt as the explicit unknown-line call.
	assert.equal(none, unknown);
	// Re-rendering the same status line returns the memoized prompt.
	assert.equal(
		getOrchestratorPrompt(cwd, undefined, "Receipt-driven development: on (decided by global)"),
		on,
	);
});

test("the on and off renders are never longer than the unknown (worst-case) render", () => {
	// Every renderable NativeReviewModeSource crossed with on/off must stay at
	// or under the "unknown (native status unavailable)" line's length, since
	// the budget is sized against that one worst case. Sourced from the
	// exported NATIVE_REVIEW_MODE_SOURCE constants, not a literal list, so a
	// future source addition is exercised automatically.
	const cwd = process.cwd();
	const unknownLine = "Receipt-driven development: unknown (native status unavailable)";
	const unknownBytes = Buffer.byteLength(getOrchestratorPrompt(cwd, undefined, unknownLine), "utf8");
	for (const source of Object.values(NATIVE_REVIEW_MODE_SOURCE)) {
		for (const effective of ["on", "off"] as const) {
			const line = renderRddStatusLine({ global: effective, cloneLocal: "", effective, source });
			const bytes = Buffer.byteLength(getOrchestratorPrompt(cwd, undefined, line), "utf8");
			assert.ok(
				bytes <= unknownBytes,
				`"${line}" rendered ${bytes} B, longer than the unknown-line render at ${unknownBytes} B`,
			);
		}
	}
});

// gentle-shell#1029: the rendered RDD line is part of the cached system-prompt
// prefix. A re-read after the TTL that fails or times out must not flip a
// known on/off line to "unknown" and back: the last successfully read status
// stays until the native reader reports a different status.
test("resolveRddModeStatus keeps the last known status when a later re-read fails", async () => {
	clearRddStatusMemoForTesting();
	const cwd = "/repo-sticky-status";
	let clock = 1_000_000;
	const now = () => clock;
	let fail = false;
	let calls = 0;
	const cli: Pick<NativeReviewCli, "reviewMode"> = {
		async reviewMode() {
			calls += 1;
			if (fail) throw new Error("native review CLI unavailable");
			return modeResult("on", NATIVE_REVIEW_MODE_SOURCE.GLOBAL);
		},
	};
	const first = await resolveRddModeStatus(cli, cwd, undefined, now);
	assert.equal(first?.effective, "on");
	fail = true;
	clock += RDD_STATUS_MEMO_TTL_MS + 1;
	const second = await resolveRddModeStatus(cli, cwd, undefined, now);
	assert.equal(calls, 2, "the expired memo must still trigger a re-read");
	assert.deepEqual(second, first, "a failed re-read must keep the last known status, not render unknown");
	assert.equal(
		await resolveRddStatusLine(cli, cwd, undefined, now),
		"Receipt-driven development: on (decided by global)",
	);
});

test("resolveRddModeStatus still follows a real status change after a re-read", async () => {
	clearRddStatusMemoForTesting();
	const cwd = "/repo-status-change";
	let clock = 1_000_000;
	const now = () => clock;
	let effective: "on" | "off" = "on";
	const cli: Pick<NativeReviewCli, "reviewMode"> = {
		async reviewMode() { return modeResult(effective, NATIVE_REVIEW_MODE_SOURCE.GLOBAL); },
	};
	assert.equal((await resolveRddModeStatus(cli, cwd, undefined, now))?.effective, "on");
	effective = "off";
	clock += RDD_STATUS_MEMO_TTL_MS + 1;
	assert.equal((await resolveRddModeStatus(cli, cwd, undefined, now))?.effective, "off");
});

test("resolveRddModeStatus stays unknown when no status was ever read", async () => {
	clearRddStatusMemoForTesting();
	const cli = fakeReviewMode(() => { throw new Error("never available"); });
	assert.equal(await resolveRddModeStatus(cli, "/repo-never-known"), undefined);
});

// gentle-shell#2250: the one-shot unavailable notice must name the cause so a
// user on a slow or foreign-owned filesystem can tell a timeout from a native
// refusal instead of reading a generic "absent, timed out, or failed".
function captureNotices(): { ctx: { hasUI: true; ui: { notify(message: string, level: string): void } }; messages: string[] } {
	const messages: string[] = [];
	return { ctx: { hasUI: true, ui: { notify(message: string) { messages.push(message); } } }, messages };
}

test("the unavailable notice names the native failure and its stderr", async () => {
	clearRddStatusMemoForTesting();
	const { ctx, messages } = captureNotices();
	const cli = fakeReviewMode(() => {
		throw new NativeReviewCliError(NATIVE_REVIEW_ERROR_CODE.NON_ZERO, NATIVE_REVIEW_OPERATION.MODE, true, false, "native process failed", {
			operation: NATIVE_REVIEW_OPERATION.MODE,
			error_code: NATIVE_REVIEW_ERROR_CODE.NON_ZERO,
			exit_code: 1,
			timed_out: false,
			output_limit_exceeded: false,
			stderr: "fatal: detected dubious ownership in repository",
		});
	});
	assert.equal(await resolveRddModeStatus(cli, "/repo-native-failure", undefined, Date.now, ctx as never), undefined);
	assert.equal(messages.length, 1);
	assert.match(messages[0], /status is unavailable: native `gentle-ai review mode status` failed \(non-zero, exit 1\): fatal: detected dubious ownership in repository\./);
	assert.match(messages[0], /keeps the last known status/);
});

test("the unavailable notice reports a timeout distinctly", async () => {
	clearRddStatusMemoForTesting();
	const { ctx, messages } = captureNotices();
	const keepalive = setTimeout(() => {}, 2000);
	try {
		await resolveRddModeStatus(fakeReviewMode(() => new Promise<never>(() => {})), "/repo-timeout", AbortSignal.timeout(50), Date.now, ctx as never);
	} finally {
		clearTimeout(keepalive);
	}
	assert.equal(messages.length, 1);
	assert.match(messages[0], new RegExp(`status is unavailable: native \`gentle-ai review mode status\` did not answer within ${RDD_STATUS_TIMEOUT_MS} ms\.`));
});

test("the unavailable notice reports an absent native review CLI", async () => {
	clearRddStatusMemoForTesting();
	const { ctx, messages } = captureNotices();
	await resolveRddModeStatus(null, "/repo-absent", undefined, Date.now, ctx as never);
	assert.equal(messages.length, 1);
	assert.match(messages[0], /status is unavailable: the native gentle-ai review CLI is not available\./);
});

test("the unavailable notice still fires only once per session", async () => {
	clearRddStatusMemoForTesting();
	const { ctx, messages } = captureNotices();
	const cli = fakeReviewMode(() => { throw new Error("boom"); });
	await resolveRddModeStatus(cli, "/repo-once-a", undefined, Date.now, ctx as never);
	await resolveRddModeStatus(cli, "/repo-once-b", undefined, Date.now, ctx as never);
	assert.equal(messages.length, 1);
	assert.match(messages[0], /status is unavailable: boom\./);
});

test("pinRddStatusLine keeps the session's first line until the off state changes (#2195)", () => {
	const unknown = "Receipt-driven development: unknown (native status unavailable)";
	const onGlobal = "Receipt-driven development: on (decided by global)";
	const onClone = "Receipt-driven development: on (decided by clone)";
	const off = "Receipt-driven development: off (decided by clone)";
	const offGlobal = "Receipt-driven development: off (decided by global)";
	assert.equal(pinRddStatusLine(undefined, onGlobal), onGlobal, "the first render of a session is the resolved line");
	assert.equal(pinRddStatusLine(unknown, onGlobal), unknown, "unknown to on keeps the cached prompt prefix");
	assert.equal(pinRddStatusLine(onGlobal, unknown), onGlobal, "on to unknown keeps the cached prompt prefix");
	assert.equal(pinRddStatusLine(onGlobal, onClone), onGlobal, "a deciding-source change alone keeps the prefix");
	assert.equal(pinRddStatusLine(off, offGlobal), off, "a source change while off keeps the prefix");
	assert.equal(pinRddStatusLine(onGlobal, off), off, "turning RDD off re-renders, since it drops the review contract");
	assert.equal(pinRddStatusLine(unknown, off), off, "unknown to off re-renders");
	assert.equal(pinRddStatusLine(off, onGlobal), onGlobal, "turning RDD back on re-renders");
	assert.equal(pinRddStatusLine(off, unknown), unknown, "off to unknown re-renders, since unknown keeps the review contract");
});
