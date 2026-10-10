import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-theme.ts";
import {
	CARD_TONE, cardAwaitingResult, cardBodyRows, cardBottom, cardInnerWidth, cardLine, cardRunningLine, cardTop,
	floatRows, markCardResult, type CardRowContext, type CardTheme, type CardTone,
} from "./shell-card.ts";

type Operation = "session" | "consult" | "list";
type Result = { content: Array<{ type: string; text?: string }>; details?: unknown };
interface Context extends CardRowContext {
	args?: Record<string, unknown>;
	expanded?: boolean;
	isError?: boolean;
	state?: { orchestratorFailed?: boolean };
}
const clean = (value: unknown): string => typeof value === "string" ? sanitizeTerminalText(value) : "";
const line = (value: unknown): string => clean(value).replace(/\s+/gu, " ").trim();
const text = (result: Result): string => clean(result.content.filter(part => part.type === "text").map(part => part.text ?? "").join("\n"));
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hiddenFields = new Set(["schema", "digest", "publication"]);
const fieldLabels: Record<string, string> = {
	sessionId: "Session ID", senderSessionId: "Sender session", recipientSessionId: "Recipient session",
	targetSessionId: "Target session", id: "ID", cwd: "Workspace",
};
function label(key: string): string {
	const named = Object.hasOwn(fieldLabels, key) ? fieldLabels[key]
		: line(key).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim().toLowerCase().replace(/^./u, char => char.toUpperCase());
	return named.replace(/\bid\b/gi, "ID");
}
const section = (title: string, rows: string[]): string[] => rows.length ? ["", `${title}:`, ...rows] : [];

/** Format plain tool data as labelled rows, never as JSON or executable terminal text. */
export function readableDataRows(value: unknown, indent = ""): string[] {
	const fields = record(value);
	const unknownRepository = Object.hasOwn(fields, "root") && Object.hasOwn(fields, "cloneHash")
		&& (fields.root === null || fields.cloneHash === null);
	return [...(unknownRepository ? [`${indent}Repository identity: unknown`] : []), ...Object.entries(fields).flatMap(([key, entry]) => {
		if (hiddenFields.has(key) || entry === undefined || entry === null) return [];
		const heading = `${indent}${label(key)}:`;
		if (key === "cursor") return [`${indent}Continuation token: provided`];
		if (Array.isArray(entry)) {
			const rows = entry.flatMap((item, index) => {
				if (item !== null && typeof item === "object") {
					const { label: itemLabel, ...fields } = record(item);
					return [`${indent}  ${index + 1}.${line(itemLabel) ? ` ${line(itemLabel)}` : ""}`, ...readableDataRows(fields, `${indent}    `)];
				}
				return item === null ? [] : [`${indent}  • ${line(String(item))}`];
			});
			return rows.length ? [heading, ...rows] : [];
		}
		if (typeof entry === "object") {
			const rows = readableDataRows(entry, `${indent}  `);
			return rows.length ? [heading, ...rows] : [];
		}
		const shown = typeof entry === "boolean" ? entry ? "yes" : "no" : clean(String(entry));
		return shown ? [`${heading} ${shown}`] : [];
	})];
}

function parsedOutput(result: Result): unknown {
	const body = text(result);
	try { return JSON.parse(body); } catch { return body; }
}

function requestRows(args: unknown): string[] {
	const input = record(args);
	return readableDataRows(input.state === null ? { ...input, state: "withdrawn" } : input);
}

/** Prefer structured data over its duplicated model-facing serialization. */
export function expandedToolRows(args: unknown, result: Result): string[] {
	const data = record(record(result.details).gentleAgents);
	const output = Object.keys(data).length ? data : parsedOutput(result);
	return [...section("Request", requestRows(args)), ...section("Details", typeof output === "string" ? output.split("\n") : readableDataRows(output)),
		...result.content.filter(part => part.type !== "text").map(part => `Attachment: ${line(part.type)}`)];
}

function discoveredSessionRows(candidates: unknown[]): string[] {
	const missing = candidates.filter(candidate => record(candidate).freshness !== "recent").length;
	return [...(missing ? [`Metadata unavailable for ${missing} session${missing === 1 ? "" : "s"}; no current context inferred.`, ""] : []),
		...candidates.flatMap((candidate, index) => {
			const peer = record(candidate);
			const { sessionId, label: peerLabel, reachability, freshness, ...context } = peer;
			const recent = freshness === "recent";
			return [`${index + 1}. ${recent && line(peerLabel) ? line(peerLabel) : "Session"}`,
				`  Session ID: ${line(sessionId)}`, ...(recent ? [
					...(!Object.keys(record(context.scope)).length ? ["  Repository scope: unknown"] : []),
					...readableDataRows(context, "  "),
				] : []), ""];
		})];
}

const OVERVIEW_LIMIT = 6;
interface OverviewRow { name: string; id: string; context: string; tasks: string }
interface OverviewTheme extends CardTheme { bold?(value: string): string }
const shortId = (value: unknown): string => {
	const id = line(value);
	return visibleWidth(id) <= 13 ? id : `${Array.from(id).slice(0, 8).join("")}…${Array.from(id).slice(-4).join("")}`;
};
const workspaceName = (value: unknown): string => line(value).split(/[\\/]/).filter(Boolean).at(-1) || line(value) || "—";
const positiveCount = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;

/** One physical row per item, including on narrow terminals; expansion is not an unbounded dump. */
function overviewTable(rows: OverviewRow[], width: number, work: boolean, theme: OverviewTheme): string[] {
	const cell = (value: string, columns: number, role: string, heading: boolean) => {
		const clipped = truncateToWidth(value, columns, "…");
		const styled = theme.fg(heading ? "toolTitle" : role, clipped);
		return (heading && theme.bold ? theme.bold(styled) : styled) + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
	};
	const format = (row: OverviewRow, heading = false) => {
		if (width < 40) {
			const styled = truncateToWidth(`${theme.fg(heading ? "toolTitle" : "dim", row.id)} ${theme.fg(heading ? "toolTitle" : "accent", row.name)}`, width, "…");
			return heading && theme.bold ? theme.bold(styled) : styled;
		}
		const name = (columns: number) => cell(row.name, columns, "accent", heading);
		const id = cell(row.id, 13, "dim", heading);
		if (width < 64) return `${name(width - 15)}  ${id}`;
		const nameWidth = Math.min(36, width - (work ? 37 : 44));
		const tasksRole = row.tasks === "?" ? "warning" : row.tasks === "0" ? "muted" : "syntaxNumber";
		return `${name(nameWidth)}  ${id}  ${cell(row.context, 20, "muted", heading)}${work ? "" : `  ${cell(row.tasks, 5, tasksRole, heading)}`}`;
	};
	return rows.length ? [format({ name: "Alias", id: "ID (short)", context: work ? "Work" : "Workspace", tasks: "Tasks" }, true), ...rows.slice(0, OVERVIEW_LIMIT).map(row => format(row))] : [];
}

function discoveryOverviewRows(candidates: unknown[], width: number, theme: OverviewTheme): string[] {
	const recent = candidates.map(record).filter(peer => peer.freshness === "recent");
	const rows = recent.map(peer => {
		const catalog = record(peer.catalog);
		const tasks = Array.isArray(peer.tasks) ? peer.tasks : Array.isArray(catalog.tasks) ? catalog.tasks : undefined;
		const omitted = Array.isArray(peer.tasks) ? peer.omitted : catalog.omittedTasks;
		return { name: line(peer.label) || "Unnamed", id: shortId(peer.sessionId), context: workspaceName(peer.workspace), tasks: tasks ? `${tasks.length}${positiveCount(omitted) ? "+" : ""}` : "?" };
	});
	return [...overviewTable(rows, width, false, theme),
		...(recent.length > OVERVIEW_LIMIT ? [theme.fg("muted", `+${recent.length - OVERVIEW_LIMIT} more recorded sessions`)] : []),
		...(candidates.length > recent.length ? [theme.fg("muted", `${candidates.length - recent.length} without recent metadata`)] : []),
		theme.fg("dim", "Detail: consult(full ID)")];
}

function workOverviewRows(search: Record<string, unknown>, width: number, theme: OverviewTheme): string[] {
	const matches = (Array.isArray(search.matches) ? search.matches : []).map(record);
	const rows = matches.map(match => {
		const work = record(match.work);
		return { name: line(match.label) || line(match.taskId) || "Work item", id: shortId(match.sessionId), context: [line(work.area), line(work.topic)].filter(Boolean).join("/") || "—", tasks: "" };
	});
	const coverage = record(search.coverage);
	const limits = [positiveCount(coverage.omittedMatches) && `${coverage.omittedMatches} matches omitted`, positiveCount(coverage.unexaminedPeers) && `${coverage.unexaminedPeers} peers not scanned`, positiveCount(coverage.unknownContext) && `${coverage.unknownContext} unknown contexts`].filter(Boolean).join(" · ");
	const source = record(search.source);
	return [...overviewTable(rows, width, true, theme), ...(matches.length > OVERVIEW_LIMIT ? [theme.fg("muted", `+${matches.length - OVERVIEW_LIMIT} more work matches`)] : []),
		...(limits ? [theme.fg("warning", limits)] : []), ...(source.status === "unavailable" ? [theme.fg("warning", `Source unavailable: ${line(source.reason) || "unknown"}`)] : []),
		theme.fg("dim", "No authority · detail: consult(full ID)")];
}

function overviewSummary(row: string, theme: CardTheme): string {
	const count = /^(\d+)(.*)$/.exec(row);
	return count ? theme.fg(count[1] === "0" ? "muted" : "syntaxNumber", count[1]) + theme.fg("muted", count[2]) : theme.fg("muted", row);
}

const taskIdentity = (data: Record<string, unknown>): boolean => Object.hasOwn(data, "sessionName") || Object.hasOwn(data, "currentAlias") || Object.hasOwn(data, "initialAlias");

function identityBodyRows(rows: string[], tone: CardTone, theme: CardTheme, width: number, expanded: boolean): string[] {
	// Wrap plain text before coloring: ANSI can otherwise add empty rows at narrow widths.
	const wrapped = rows.flatMap(row => row.split("\n").flatMap(source => {
		const field = /^(Current alias|Initial alias|Session name|Routing ID|Requested subject): (.*)$/.exec(source);
		let offset = 0;
		return (source === "" ? [""] : wrapTextWithAnsi(source, cardInnerWidth(width))).map(fragment => {
			if (!field) return source === "Existing alias preserved; subject does not rename it." || source === "Session name preserved; subject updates task aliases." ? theme.fg("muted", fragment) : fragment;
			const start = source.indexOf(fragment, offset);
			offset = start + fragment.length;
			const labelLength = Math.max(0, Math.min(fragment.length, field[1].length + 2 - start));
			const role = field[1] === "Routing ID" ? "dim" : field[2] === "unknown" ? "muted" : "accent";
			return theme.fg("muted", fragment.slice(0, labelLength)) + theme.fg(role, fragment.slice(labelLength));
		});
	}));
	return (expanded ? wrapped : wrapped.slice(0, 3)).map(row => cardLine(row, tone, theme, width));
}

function summary(operation: Operation, args: Record<string, unknown>, result: Result, failed: boolean): string[] {
	const body = text(result);
	if (failed) return [line(body) || "Operation failed"];
	const data = record(record(result.details).gentleAgents);
	if (operation === "session" && typeof data.alias === "string") {
		if (taskIdentity(data)) {
			const name = line(data.sessionName) || line(data.alias) || "unnamed";
			const rows = [`Current alias: ${line(data.currentAlias) || "unknown"}`, `Session name: ${name}`];
			if (line(args.subject) && name !== "unnamed" && name !== line(args.subject)) rows.push("Session name preserved; subject updates task aliases.");
			return rows;
		}
		const rows = [`Current alias: ${line(data.alias) || "unnamed"}`];
		if (line(data.alias) && line(args.subject) && line(args.subject) !== line(data.alias)) rows.push("Existing alias preserved; subject does not rename it.");
		return rows;
	}
	if (operation === "consult") {
		const receipt = record(data.receipt ?? parsedOutput(result));
		if (typeof receipt.status === "string") {
			const code = line(receipt.code) || (Array.isArray(receipt.unknowns) ? line(receipt.unknowns[0]) : "");
			return [`${line(receipt.status)}${code ? ` (${code})` : ""} · not an owner reply; authority none`];
		}
	}
	if (operation === "list") {
		const work = record(data.workSearch);
		if (Array.isArray(work.matches)) return [`${work.matches.length} work matches · non-exhaustive; reachability unknown`];
		if (Array.isArray(data.candidates)) return [`${data.candidates.length} advertised session${data.candidates.length === 1 ? "" : "s"} · reachability unknown`];
	}
	const parsed = parsedOutput(result);
	return [typeof parsed === "string" ? line(body.split("\n").find(row => row.trim())) || "No output" : readableDataRows(parsed)[0] || "No output"];
}

export function orchestratorToolRenderers(operation: Operation, hint: (expanded: boolean) => string) {
	const title = operation === "session" ? "Session identity" : operation === "consult" ? "Consult orchestrator" : "Discover orchestrators";
	return {
		renderShell: "self" as const,
		renderCall(args: Record<string, unknown>, theme: CardTheme, context: Context) {
			return {
				render(width: number) {
					if (width <= 0) return [];
					const pending = cardAwaitingResult(context);
					const tone = context.isError || context.state?.orchestratorFailed ? CARD_TONE.ERROR : CARD_TONE.INFO;
					const subtitle = operation === "session" ? (line(args.subject) ? `Subject: ${line(args.subject)}` : "This session")
						: operation === "consult" ? line(args.kind) || "metadata"
						: Object.hasOwn(args, "filter") ? "Classified work" : args.recipient_session_id ? "Selected session" : "Advertised sessions";
					return floatRows(tone, theme, width, inner => ({
						head: [cardTop({ title, subtitle, body: [], tone, glyph: "🤖" }, theme, inner, hint(!!context.expanded))],
						...(pending ? {
							body: [...(context.expanded ? cardBodyRows(requestRows(args), tone, theme, inner, { expanded: true }) : []), cardRunningLine(tone, theme, inner)],
							bottom: cardBottom(tone, theme, inner),
						} : {}),
					}));
				},
				invalidate() {},
			};
		},
		renderResult(result: Result, options: { expanded: boolean; isPartial?: boolean }, theme: CardTheme, context: Context) {
			const failed = !!record(result.details).error || !!context.isError;
			if (!options.isPartial) markCardResult(context.state);
			if (context.state) context.state.orchestratorFailed = failed;
			const tone = failed ? CARD_TONE.ERROR : CARD_TONE.INFO;
			const args = context.args ?? {};
			const data = record(record(result.details).gentleAgents);
			const discoveryOverview = operation === "list" && !failed && !args.recipient_session_id && Array.isArray(data.candidates);
			const workOverview = operation === "list" && !failed && Array.isArray(record(data.workSearch).matches);
			const overview = options.expanded && (discoveryOverview || workOverview);
			const body = options.isPartial && !failed ? ["Receiving partial result…"] : summary(operation, args, result, failed);
			if (options.expanded && !overview) {
				if (operation === "session" && typeof data.alias === "string" && !failed) {
					if (taskIdentity(data)) body.push(`Initial alias: ${line(data.initialAlias) || "unknown"}`);
					if (line(data.senderSessionId)) body.push(`Routing ID: ${line(data.senderSessionId)}`);
					if (line(args.subject) && (!taskIdentity(data) || line(args.subject) !== line(data.currentAlias))) body.push(`Requested subject: ${line(args.subject)}`);
					body.push(...(args.state === null ? ["Published state: withdrawn"] : section("Published state", readableDataRows(args.state))));
				} else if (operation === "list" && Array.isArray(data.candidates) && !failed) {
					body.push(...section("Request", requestRows(args)), ...section("Sessions", discoveredSessionRows(data.candidates)));
				} else if (operation === "consult" && data.receipt !== undefined && !failed) {
					body.push(...section("Request", requestRows(args)), ...section("Published context / advice", readableDataRows(data.receipt)));
				} else if (!Object.keys(data).length && typeof parsedOutput(result) === "string") {
					body.splice(0, body.length, ...section("Request", requestRows(args)), ...text(result).split("\n"));
				} else {
					body.push(...expandedToolRows(args, result));
				}
			}
			return {
				render(width: number) {
					if (width <= 0) return [];
					return floatRows(tone, theme, width, inner => {
						const columns = cardInnerWidth(inner);
						const summaries = discoveryOverview || workOverview ? body.map(row => overviewSummary(row, theme)) : body;
						const rows = overview ? [...summaries, ...(discoveryOverview ? discoveryOverviewRows(data.candidates as unknown[], columns, theme) : workOverviewRows(record(data.workSearch), columns, theme))]
							.map(row => truncateToWidth(row, columns, "…")) : summaries;
						return {
							afterHeading: true,
							body: operation === "session" && !failed && typeof data.alias === "string"
								? identityBodyRows(body, tone, theme, inner, options.expanded)
								: cardBodyRows(rows, tone, theme, inner, { expanded: options.expanded, previewRows: 3 }),
							bottom: cardBottom(tone, theme, inner),
						};
					});
				},
				invalidate() {},
			};
		},
	};
}
