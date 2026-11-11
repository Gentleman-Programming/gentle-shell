// Gentle Agents report cap (P9b).
//
// A finished child's report is pushed into the parent's conversation (the
// background completion message, or the task-mode subagent_run and
// subagent_continue result) and stays there for the rest of the session.
// This module bounds that delivered copy only: the stored task result, the
// task file, and subagent_result keep the full text. Under the cap the report
// is returned unchanged, so every path stays byte-identical.

export const DEFAULT_REPORT_MAX_BYTES = 16_384;
/** A cut moves back to the last line break when one lies in this many final bytes. */
export const REPORT_LINE_WINDOW_BYTES = 512;
/** A closing `## Key Learnings` block up to this size is delivered whole after the notice. */
export const KEY_LEARNINGS_EXTRA_BYTES = 2_048;

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

// Agents whose whole answer must be one JSON document: the Judgment Day roles (`jd-*`) and the review lens
// roles (`review-*`). The same rule as STRICT_JSON_PREFIX in tests/delegated-key-learnings-contract.test.ts,
// which keeps the Key Learnings closing instruction out of these agents.
const STRICT_JSON_AGENT = /^(jd-|review-)/;
export const isStrictJsonAgent = (agent: string): boolean => STRICT_JSON_AGENT.test(agent);

// One valid JSON object or array after trimming, optionally inside one fenced block: cutting it would
// deliver invalid JSON, so it is never truncated.
function singleJsonDocument(report: string): boolean {
	const body = report.trim().replace(/^```[\w-]*\n([\s\S]*)\n```$/, "$1").trim();
	if (!/^[[{]/.test(body)) return false;
	try { JSON.parse(body); return true; } catch { return false; }
}

// The report's closing `## Key Learnings` block: the last such heading at a
// line start outside a code fence, with no other level-2 heading after it.
function closingKeyLearnings(report: string): number | undefined {
	let start: number | undefined, offset = 0, fence: string | undefined;
	for (const line of report.split("\n")) {
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) fence = fence ? undefined : marker;
		else if (!fence && line.startsWith("## ")) start = /^## Key Learnings/.test(line) ? offset : undefined;
		offset += line.length + 1;
	}
	return start;
}

function head(source: string, maxBytes: number): string {
	const cut = utf8Head(source, maxBytes);
	const newline = cut.lastIndexOf("\n");
	return newline >= 0 && utf8Bytes(cut.slice(newline)) <= REPORT_LINE_WINDOW_BYTES ? cut.slice(0, newline) : cut;
}

/** Bound the report delivered into the parent's context; the full text stays available through subagent_result. */
export function capReport(report: string, maxBytes: number, taskId: string, agent = ""): CappedReport {
	const reportBytes = utf8Bytes(report);
	if (reportBytes <= maxBytes || isStrictJsonAgent(agent) || singleJsonDocument(report)) return { text: report, truncated: false, reportBytes, deliveredBytes: reportBytes };
	const learningsStart = closingKeyLearnings(report);
	const learnings = learningsStart === undefined ? undefined : report.slice(learningsStart);
	const keep = learnings !== undefined && utf8Bytes(learnings) <= KEY_LEARNINGS_EXTRA_BYTES ? learnings : undefined;
	const body = keep === undefined ? report : report.slice(0, learningsStart);
	// The body fits and the closing block fits its allowance: nothing is lost.
	if (keep !== undefined && utf8Bytes(body) <= maxBytes) return { text: report, truncated: false, reportBytes, deliveredBytes: reportBytes };
	const delivered = head(body, maxBytes);
	const deliveredBytes = utf8Bytes(delivered);
	const notice = `Report truncated: the first ${deliveredBytes} of ${reportBytes} bytes were delivered${keep === undefined ? "" : ", followed by its closing ## Key Learnings block"}. Call subagent_result with task_id ${taskId} for the full text.`;
	return { text: `${delivered}\n\n${notice}${keep === undefined ? "" : `\n\n${keep}`}`, truncated: true, reportBytes, deliveredBytes };
}

/** Additive details for the UI: the existing fields stay as they are, and nothing is added under the cap. */
export function withReportCap(details: Record<string, unknown>, capped: CappedReport): Record<string, unknown> {
	if (!capped.truncated) return details;
	const agents = (details.gentleAgents ?? {}) as Record<string, unknown>;
	return { ...details, gentleAgents: { ...agents, reportTruncated: true, reportBytes: capped.reportBytes, reportDeliveredBytes: capped.deliveredBytes } };
}
