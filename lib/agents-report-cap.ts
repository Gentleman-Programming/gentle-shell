// Gentle Agents report cap (P9b).
//
// A finished child's report is pushed into the parent's conversation (the
// background completion message, or the task-mode subagent_run and
// subagent_continue result) and stays there for the rest of the session.
// This module bounds that delivered copy only: the stored task result, the
// task file, and subagent_result keep the full text. Under the cap the report
// is returned unchanged, so every path stays byte-identical.

export const DEFAULT_REPORT_MAX_BYTES = 16_384;
/** A cut moves to a line boundary when one lies within this many bytes of it (see lineWindowBytes). */
export const REPORT_LINE_WINDOW_BYTES = 512;
/** Over the cap, the last bytes of the report (at most this many) follow the truncation line. */
export const REPORT_TAIL_BYTES = 2_048;

/** The line-boundary search window for a cut of `budget` bytes: at most 512, and at most a quarter of the budget, so a small cap cannot shrink a cut to a few bytes. */
export const lineWindowBytes = (budget: number): number => Math.min(REPORT_LINE_WINDOW_BYTES, budget >> 2);

export interface CappedReport {
	text: string;
	truncated: boolean;
	reportBytes: number;
	deliveredBytes: number;
}

const encoder = new TextEncoder();
const utf8Bytes = (value: string): number => encoder.encode(value).length;

// Byte length of one code point as TextEncoder writes it; a lone surrogate
// becomes U+FFFD (3 bytes), and a pair is one 4-byte code point.
function codePointBytes(codePoint: number): number {
	if (codePoint < 0x80) return 1;
	if (codePoint < 0x800) return 2;
	if (codePoint < 0x10000) return 3;
	return 4;
}

/** The longest prefix of `value` whose UTF-8 encoding fits `maxBytes`, never splitting a code point or a surrogate pair. */
export function utf8Head(value: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	for (const char of value) {
		const size = codePointBytes(char.codePointAt(0)!);
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += char.length;
	}
	return value.slice(0, end);
}

/** The longest suffix of `value` whose UTF-8 encoding fits `maxBytes`, never splitting a code point or a surrogate pair. */
export function utf8Tail(value: string, maxBytes: number): string {
	let bytes = 0;
	let start = value.length;
	while (start > 0) {
		const low = value.charCodeAt(start - 1);
		const pair = start >= 2 && low >= 0xdc00 && low <= 0xdfff && value.charCodeAt(start - 2) >= 0xd800 && value.charCodeAt(start - 2) <= 0xdbff;
		const size = pair ? 4 : codePointBytes(low);
		if (bytes + size > maxBytes) break;
		bytes += size;
		start -= pair ? 2 : 1;
	}
	return value.slice(start);
}

// Agents whose whole answer must be one JSON document: the Judgment Day roles (`jd-*`) and the review lens
// roles (`review-*`). The same rule as STRICT_JSON_PREFIX in the delegation contract test, which keeps the
// closing-block instruction out of these agents.
const STRICT_JSON_AGENT = /^(jd-|review-)/;
export const isStrictJsonAgent = (agent: string): boolean => STRICT_JSON_AGENT.test(agent);

// One valid JSON object or array after trimming, optionally inside one fenced block: cutting it would
// deliver invalid JSON, so it is never truncated.
function singleJsonDocument(report: string): boolean {
	const body = report.trim().replace(/^```[\w-]*\n([\s\S]*)\n```$/, "$1").trim();
	if (!/^[[{]/.test(body)) return false;
	try { JSON.parse(body); return true; } catch { return false; }
}

// The head: up to `maxBytes`, moved back to the last line break when one lies in the final window.
function head(source: string, maxBytes: number): string {
	const cut = utf8Head(source, maxBytes);
	const newline = cut.lastIndexOf("\n");
	return newline >= 0 && utf8Bytes(cut.slice(newline)) <= lineWindowBytes(maxBytes) ? cut.slice(0, newline) : cut;
}

// The tail: the last REPORT_TAIL_BYTES at most, starting after the first line break in the opening window
// when there is one, otherwise at a code point boundary. The text is not inspected beyond line breaks.
function tail(source: string): string {
	const cut = utf8Tail(source, REPORT_TAIL_BYTES);
	const newline = cut.indexOf("\n");
	return newline >= 0 && utf8Bytes(cut.slice(0, newline + 1)) <= lineWindowBytes(REPORT_TAIL_BYTES) ? cut.slice(newline + 1) : cut;
}

/** Bound the report delivered into the parent's context: its head, a truncation line, then the end of the report. The full text stays available through subagent_result. */
export function capReport(report: string, maxBytes: number, taskId: string, agent = ""): CappedReport {
	const reportBytes = utf8Bytes(report);
	const whole = { text: report, truncated: false, reportBytes, deliveredBytes: reportBytes };
	if (reportBytes <= maxBytes || isStrictJsonAgent(agent) || singleJsonDocument(report)) return whole;
	const first = head(report, maxBytes);
	const firstBytes = utf8Bytes(first);
	// What the head leaves out fits the tail allowance: deliver everything, so head and tail never overlap.
	if (reportBytes - firstBytes <= REPORT_TAIL_BYTES) return whole;
	const last = tail(report);
	const lastBytes = utf8Bytes(last);
	const notice = `Report truncated: the first ${firstBytes} and the last ${lastBytes} of ${reportBytes} bytes were delivered. Call subagent_result with task_id ${taskId} for the full text.`;
	return { text: `${first}\n\n${notice}\n\n${last}`, truncated: true, reportBytes, deliveredBytes: firstBytes + lastBytes };
}

/** Additive details for the UI: the existing fields stay as they are, and nothing is added under the cap. */
export function withReportCap(details: Record<string, unknown>, capped: CappedReport): Record<string, unknown> {
	if (!capped.truncated) return details;
	const agents = (details.gentleAgents ?? {}) as Record<string, unknown>;
	return { ...details, gentleAgents: { ...agents, reportTruncated: true, reportBytes: capped.reportBytes, reportDeliveredBytes: capped.deliveredBytes } };
}
