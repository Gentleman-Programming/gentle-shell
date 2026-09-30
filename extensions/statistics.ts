// Statistics overlay and command (epic #1, I8).
//
// A full-screen panel without a core change: the supported route is the
// overlay, `ctx.ui.custom(..., { overlay: true })`, and the command needs no
// core change because `pi.registerCommand` is listed by Pi's `/` menu. The one
// core touch is a single additive row in `COMMAND_PALETTE_CATALOG` so the
// command is discoverable from the `alt+k` palette; `buildCommandPaletteGroups`
// drops that row when the command is not registered, so it merges safely.
//
// Non-blocking: the overlay renders a cached snapshot and never recomputes an
// aggregate per frame. Events invalidate the cache; the next open or an
// explicit refresh rebuilds it off the render path.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withOverlayRepaint } from "../lib/overlay-repaint.ts";
import { billableEnabled, buildBillableReport, collectBillableSessions, defaultBillableRange, readBillableConfig, type BillableConfig, type BillableRange, type BillableSessionInput } from "../lib/billable-hours.ts";
import { aggregateUsage, type UsageAggregate } from "../lib/session-aggregate.ts";
import { exportBillableCsv, exportBillableJson, exportBillableMarkdown, exportStatisticsCsv, exportStatisticsJson, exportStatisticsMarkdown } from "../lib/session-export.ts";
import { parseTranscriptLine, readTranscript, type TranscriptTaskIdentity, type TranscriptUsageRecord } from "../lib/session-transcript.ts";
import { readTimeline, type Timeline } from "../lib/session-timeline.ts";
import { buildStatisticsModel, StatisticsView, type StatisticsStyle } from "../lib/statistics-view.ts";

/** Distinct from `gentle:usage`, which owns provider subscription quota. */
export const STATISTICS_COMMAND_NAME = "gentle:statistics";
export const STATISTICS_COMMAND_DESCRIPTION = "Show this session's statistics: cost, subagents, models and the time split. Distinct from /gentle:usage (subscription quota).";
/** A period report: the hours, the rate and the amount, next to the measured API cost. */
export const BILLABLE_COMMAND_NAME = "gentle:billable";
export const BILLABLE_COMMAND_DESCRIPTION = "Export a billable-hours report for a period (default: the last 7 days). Pass --days N to widen it. Rate, currency and rounding come from GENTLE_BILLABLE_RATE/CURRENCY/ROUNDING.";

export interface StatisticsSnapshot {
	readonly aggregate: UsageAggregate;
	readonly timeline: Timeline | null;
	readonly generatedAt: number;
}

export interface StatisticsDeps {
	readonly home?: string;
	readonly agentHome?: string;
	readonly now?: () => number;
	/** Override the snapshot computation (tests, or a future cache source). */
	readonly computeSnapshot?: (ctx: ExtensionContext) => Promise<StatisticsSnapshot>;
	/** Override the export side effect (tests). Returns the path shown to the user. */
	readonly exportSnapshot?: (snapshot: StatisticsSnapshot) => Promise<string>;
	/** Billable config (tests, or a caller that resolved it elsewhere). */
	readonly billableConfig?: BillableConfig;
	/** Resolved billable opt-in (tests). Defaults to `billableEnabled(process.env)`. */
	readonly billableEnabled?: boolean;
	/** Override the billable collection (tests). */
	readonly collectBillable?: (options: { agentHome: string; range: BillableRange }) => Promise<BillableSessionInput[]>;
}

function defaultAgentHome(deps: StatisticsDeps): string {
	return deps.agentHome ?? process.env.GENTLE_PI_AGENT_HOME ?? process.env.PI_CODING_AGENT_DIR ?? join(deps.home ?? homedir(), ".pi", "agent");
}

/** Map the in-memory session entries through I3's parser, so the numbers are the reader's own. */
function recordsFromEntries(entries: readonly unknown[], sessionId: string): TranscriptUsageRecord[] {
	const records: TranscriptUsageRecord[] = [];
	for (const entry of entries) {
		let raw: string;
		try {
			raw = JSON.stringify(entry);
		} catch {
			continue;
		}
		const result = parseTranscriptLine(raw, { source: "parent", sessionId, transcriptPath: "" });
		if (result.kind === "usage") records.push(result.record);
	}
	return records;
}

function taskIdentity(task: Record<string, unknown>): TranscriptTaskIdentity {
	return {
		taskId: String(task.id ?? "unknown"),
		agent: String(task.agent ?? "unknown"),
		label: String(task.label ?? ""),
		status: String(task.status ?? "unknown"),
		turns: typeof task.turns === "number" ? task.turns : 0,
		toolCalls: typeof task.toolCalls === "number" ? task.toolCalls : 0,
		startedAt: typeof task.startedAt === "number" ? task.startedAt : null,
		endedAt: typeof task.endedAt === "number" ? task.endedAt : null,
		model: String(task.model ?? "unknown"),
		...(typeof task.thinking === "string" ? { thinking: task.thinking } : {}),
	};
}

/** Read this session's finished subagents from the task files and their child transcripts. */
async function recordsFromTasks(agentHome: string, sessionId: string): Promise<TranscriptUsageRecord[]> {
	const dir = join(agentHome, "gentle-agents", "tasks");
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const records: TranscriptUsageRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		let task: Record<string, unknown>;
		try {
			task = (JSON.parse(await readFile(join(dir, name), "utf8")) as { task?: Record<string, unknown> }).task ?? {};
		} catch {
			continue;
		}
		if (task.parentSessionId !== sessionId || typeof task.sessionPath !== "string") continue;
		try {
			const read = await readTranscript(task.sessionPath, { source: "subagent", task: taskIdentity(task) });
			records.push(...read.records);
		} catch {
			/* a missing child transcript is skipped, never fatal */
		}
	}
	return records;
}

function themeStyle(theme: { fg(role: string, text: string): string }): StatisticsStyle {
	return { title: (text) => theme.fg("accent", text), frame: (text) => theme.fg("dim", text), dim: (text) => theme.fg("dim", text), accent: (text) => theme.fg("accent", text) };
}

export default function statistics(pi: ExtensionAPI, deps: StatisticsDeps = {}): void {
	const now = deps.now ?? (() => Date.now());
	const agentHome = defaultAgentHome(deps);
	const billableOn = deps.billableEnabled ?? billableEnabled(process.env);
	let cached: StatisticsSnapshot | undefined;

	const compute = async (ctx: ExtensionContext): Promise<StatisticsSnapshot> => {
		if (deps.computeSnapshot) return deps.computeSnapshot(ctx);
		const sessionId = ctx.sessionManager.getSessionId() ?? "";
		const sessionFile = ctx.sessionManager.getSessionFile();
		const parent = recordsFromEntries(ctx.sessionManager.getEntries(), sessionId);
		const children = await recordsFromTasks(agentHome, sessionId);
		const aggregate = aggregateUsage([...parent, ...children], { now });
		const timeline = sessionFile ? await readTimeline(sessionFile) : null;
		return { aggregate, timeline, generatedAt: now() };
	};

	const snapshotFor = async (ctx: ExtensionContext): Promise<StatisticsSnapshot> => {
		if (!cached) cached = await compute(ctx);
		return cached;
	};

	const exportSnapshot = async (snapshot: StatisticsSnapshot): Promise<string> => {
		if (deps.exportSnapshot) return deps.exportSnapshot(snapshot);
		const dir = join(agentHome, "gentle-statistics", "exports");
		await mkdir(dir, { recursive: true });
		const stamp = new Date(snapshot.generatedAt).toISOString().replace(/[:.]/g, "-");
		const base = join(dir, `statistics-${stamp}`);
		await writeFile(`${base}.md`, exportStatisticsMarkdown(snapshot.aggregate, { generatedAt: snapshot.generatedAt }), "utf8");
		await writeFile(`${base}.csv`, exportStatisticsCsv(snapshot.aggregate), "utf8");
		await writeFile(`${base}.json`, exportStatisticsJson(snapshot.aggregate, { generatedAt: snapshot.generatedAt }), "utf8");
		return `${base}.md`;
	};

	const invalidate = () => {
		cached = undefined;
	};
	pi.on("turn_end", invalidate);
	pi.on("agent_end", invalidate);
	pi.on("session_start", invalidate);

	const openOverlay = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The statistics panel requires TUI mode.", "warning");
			return;
		}
		let current: StatisticsSnapshot | undefined;
		let model = buildStatisticsModel(aggregateUsage([], { now: () => now() }), null, now());
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const close = withOverlayRepaint(tui, done);
				const view = new StatisticsView({
					getModel: () => model,
					style: themeStyle(theme),
					rows: () => Math.max(0, tui.terminal.rows),
					onClose: () => close(),
					...(billableOn ? { onBillable: () => { void runBillable(ctx, ""); } } : {}),
					onExport: () => {
						void (async () => {
							if (!current) return;
							try {
								const path = await exportSnapshot(current);
								ctx.ui.notify(`Statistics exported to ${path}`, "info");
							} catch {
								ctx.ui.notify("Statistics export failed.", "warning");
							}
						})();
					},
					onRefresh: () => {
						void (async () => {
							invalidate();
							try {
								current = await snapshotFor(ctx);
								model = buildStatisticsModel(current.aggregate, current.timeline, current.generatedAt);
							} catch {
								/* keep the previous model on a failed refresh */
							}
							tui.requestRender();
						})();
					},
				});
				void (async () => {
					try {
						current = await snapshotFor(ctx);
						model = buildStatisticsModel(current.aggregate, current.timeline, current.generatedAt);
					} catch {
						/* the empty panel is shown; a snapshot failure never crashes the session */
					}
					tui.requestRender();
				})();
				return view;
			},
			{ overlay: true, overlayOptions: { margin: 1 } },
		);
	};

	const runBillable = async (ctx: ExtensionContext, args: string): Promise<void> => {
		const days = /--days[= ](\d+)/.exec(args);
		const range = defaultBillableRange(now(), days ? Number(days[1]) : 7);
		const config = deps.billableConfig ?? readBillableConfig(process.env);
		try {
			const sessions = await (deps.collectBillable ?? collectBillableSessions)({ agentHome, range });
			const report = buildBillableReport(sessions, config, range, now());
			const dir = join(agentHome, "gentle-statistics", "exports");
			await mkdir(dir, { recursive: true });
			const stamp = new Date(report.generatedAt).toISOString().replace(/[:.]/g, "-");
			const base = join(dir, `billable-${stamp}`);
			await writeFile(`${base}.md`, exportBillableMarkdown(report, { generatedAt: report.generatedAt }), "utf8");
			await writeFile(`${base}.csv`, exportBillableCsv(report), "utf8");
			await writeFile(`${base}.json`, exportBillableJson(report), "utf8");
			ctx.ui.notify(`Billable report: ${report.totals.sessions} session(s), ${report.totals.billableMs / 3_600_000}h → ${base}.md`, "info");
		} catch {
			ctx.ui.notify("Billable report failed.", "warning");
		}
	};

	pi.registerCommand(STATISTICS_COMMAND_NAME, {
		description: STATISTICS_COMMAND_DESCRIPTION,
		handler: async (_args, ctx) => openOverlay(ctx),
	});
	if (billableOn) {
		pi.registerCommand(BILLABLE_COMMAND_NAME, {
			description: BILLABLE_COMMAND_DESCRIPTION,
			handler: async (args, ctx) => runBillable(ctx, args),
		});
	}
}
