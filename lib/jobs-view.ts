// Background jobs overlay (`/gentle:jobs`): this session's jobs beside the
// selected job's command, status, output file, and output tail. It shares the
// Agents overlay geometry and roles so both read as one family, but stays a
// small standalone view: jobs have no peers, groups, or threads.

import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { JobRecord } from "./background-jobs.ts";
import { formatJobDuration, JOB_GLYPH, jobOutcome } from "./background-jobs-tools.ts";
import { measureAgentsViewLayout, type AgentsViewMode } from "./agents-view-layout.ts";
import { createNativePointerScope } from "./native-pointer-region.ts";
import { paintHoverable } from "./shell-hover.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

export interface JobsViewDeps {
	theme: { fg(role: string, text: string): string };
	rows: () => number;
	/** This session's jobs; the view sorts a copy by activity and recency. */
	jobs: () => JobRecord[];
	now: () => number;
	onStop(job: JobRecord): void;
	onClose(): void;
	requestRender(): void;
}

const ROLE = { FRAME: "border", TITLE: "customMessageLabel", SELECTED: "accent", NAME: "text", META: "dim", KEY: "accent", KEY_TEXT: "dim", EMPTY: "dim" } as const;
const REFRESH_MS = 1000;
const TARGET = { JOB: "job", DETAILS: "details", STOP: "stop", CLOSE: "close" } as const;
type TargetKind = (typeof TARGET)[keyof typeof TARGET];

interface PointerTarget {
	kind: TargetKind;
	key: string;
	id?: string;
	x: number;
	y: number;
	width: number;
}

interface FooterKeys {
	entries: Array<[string, string]>;
	gap: string;
}

interface PointerLayout {
	width: number;
	height: number;
	sourceHeight: number;
	mode: AgentsViewMode;
	details: boolean;
	selectedId: string | undefined;
	selectedRunning: boolean;
	listScroll: number;
	rowIds: string[];
	targets: PointerTarget[];
}

const EMPTY_COMPONENT: Component = { render: () => [], invalidate() {} };
const keyText = ([key, label]: [string, string]) => label ? `${key} ${label}` : key;
const keyTarget = (key: string): TargetKind | undefined =>
	key === "tab" || key === "←" || key === "→" ? TARGET.DETAILS
		: key === "s" ? TARGET.STOP : key === "q" || key === "×" ? TARGET.CLOSE : undefined;

function glyph(job: JobRecord): [string, string] {
	if (job.status === "running") return [job.kind === "monitor" ? "◉" : "◐", "accent"];
	if (job.status === "stopped") return ["–", "dim"];
	if (job.status === "exited" && job.exitCode === 0) return ["✓", "success"];
	return ["✗", "error"];
}

const rule = (length: number) => "─".repeat(Math.max(0, length));
const fit = (text: string, width: number) => {
	const clipped = truncateToWidth(text, Math.max(0, width), "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};
const clean = (text: string) => sanitizeTerminalText(text).replace(/\s+/g, " ");

export class JobsView {
	private readonly deps: JobsViewDeps;
	private selectedId: string | undefined;
	private details = false;
	private listScroll = 0;
	private closed = false;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly pointerScope = createNativePointerScope();
	private readonly pointerObserver = this.pointerScope.createMouseObserver(() => this.deps.requestRender());
	private readonly pointerRegion = this.pointerScope.wrap(EMPTY_COMPONENT, {
		onHover: (event) => this.hover(event),
		onLeave: () => { this.hovered = undefined; },
		onPress: (event) => this.press(event),
		onClick: (event) => this.click(event),
	});
	private pointerLayout: PointerLayout | undefined;
	private hovered: string | undefined;
	private pressed: string | undefined;

	constructor(deps: JobsViewDeps) {
		this.deps = deps;
		// Elapsed time and the output tail move while a job runs.
		this.timer = setInterval(() => {
			if (this.deps.jobs().some((job) => job.status === "running")) this.deps.requestRender();
		}, REFRESH_MS);
		this.timer.unref?.();
	}

	dispose(): void {
		this.closed = true;
		this.pointerLayout = undefined;
		this.pressed = undefined;
		this.pointerScope.dispose();
		clearInterval(this.timer);
	}

	invalidate(): void {
		this.clearPointerLayout();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		this.pointerObserver.beforeMouse(event);
		try {
			const layout = this.pointerLayout;
			if (!layout || !this.pointerLayoutIsCurrent(layout, event)) {
				const hovered = this.hovered !== undefined;
				this.clearPointerLayout();
				if (hovered) this.deps.requestRender();
				return undefined;
			}
			if (!this.targetAt(event)) return undefined;
			return this.pointerRegion.handleMouse(event);
		} finally {
			this.pointerObserver.afterMouse(event);
		}
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const jobs = this.orderedJobs();
		const index = Math.max(0, jobs.findIndex((job) => job.id === this.selected(jobs)?.id));
		if (data === "q") this.close();
		else if (matchesKey(data, Key.escape)) {
			if (this.details) this.details = false;
			else this.close();
		} else if (data === "\t" || matchesKey(data, Key.enter)) this.details = !this.details;
		else if (data === "j" || matchesKey(data, Key.down)) this.selectedId = jobs[Math.min(jobs.length - 1, index + 1)]?.id;
		else if (data === "k" || matchesKey(data, Key.up)) this.selectedId = jobs[Math.max(0, index - 1)]?.id;
		else if (data === "s") {
			const job = this.selected(jobs);
			if (job?.status === "running") this.deps.onStop(job);
		} else return;
		this.clearPointerLayout();
		this.deps.requestRender();
	}

	render(width: number): string[] {
		const layout = measureAgentsViewLayout(width, this.deps.rows(), this.details);
		if (layout.width === 0 || layout.height === 0) {
			this.clearPointerLayout();
			return [];
		}
		const { theme } = this.deps;
		if (layout.mode === "fallback") {
			const close: PointerTarget = { kind: TARGET.CLOSE, key: TARGET.CLOSE, x: 0, y: 0, width: 1 };
			this.rememberLayout({ width: layout.width, height: 1, sourceHeight: layout.height, mode: layout.mode, details: this.details, selectedId: undefined, selectedRunning: false, listScroll: 0, rowIds: [], targets: [close] });
			return [paintHoverable(theme, "×", this.hovered === close.key) + fit(" Close Jobs", layout.width - 1)];
		}
		const jobs = this.orderedJobs();
		const selected = this.selected(jobs);
		this.followSelection(jobs, selected, layout.bodyRows);
		const rowIds = layout.mode === "panes" || !this.details ? jobs.slice(this.listScroll, this.listScroll + layout.bodyRows).map((job) => job.id) : [];
		const targets: PointerTarget[] = rowIds.map((id, row) => ({ kind: TARGET.JOB, key: JSON.stringify([TARGET.JOB, id]), id, x: layout.listX, y: row + 1, width: layout.listWidth }));
		const inner = layout.width - 2;
		const keys = this.fittingKeys(selected, layout.mode === "narrow", inner - 2);
		let offset = 0;
		for (const [key, label] of keys.entries) {
			const kind = keyTarget(key);
			const textWidth = visibleWidth(keyText([key, label]));
			if (kind) targets.push({ kind, key: JSON.stringify([kind, kind === TARGET.CLOSE ? undefined : selected?.id]), id: selected?.id, x: 2 + offset, y: layout.footerY!, width: textWidth });
			offset += textWidth + visibleWidth(keys.gap);
		}
		this.rememberLayout({ width: layout.width, height: layout.height, sourceHeight: layout.height, mode: layout.mode, details: this.details, selectedId: selected?.id, selectedRunning: selected?.status === "running", listScroll: this.listScroll, rowIds, targets });
		const running = jobs.filter((job) => job.status === "running").length;
		const title = truncateToWidth(`${JOB_GLYPH} Jobs · ${running} running · ${jobs.length - running} finished`, Math.max(0, inner - 4), "…");
		const top = theme.fg(ROLE.FRAME, "╭─ ") + theme.fg(ROLE.TITLE, title) + theme.fg(ROLE.FRAME, ` ${rule(inner - visibleWidth(title) - 3)}╮`);
		const list = this.listLines(jobs, selected, layout.listWidth, layout.bodyRows);
		const detail = selected ? this.detailLines(selected, layout.bodyRows) : [theme.fg(ROLE.EMPTY, "No background jobs in this session."), theme.fg(ROLE.EMPTY, "The agent starts them with bash_background or monitor.")];
		const bar = theme.fg(ROLE.FRAME, "│");
		const body: string[] = [];
		for (let row = 0; row < layout.bodyRows; row += 1) {
			if (layout.mode === "panes") body.push(`${bar} ${fit(list[row] ?? "", layout.listWidth)} ${bar} ${fit(detail[row] ?? "", layout.threadWidth)}${bar}`);
			else body.push(`${bar} ${fit((this.details ? detail : list)[row] ?? "", layout.listWidth)} ${bar}`);
		}
		const footer = keys.entries.map(([key, label]) => {
			const kind = keyTarget(key);
			const hovered = kind !== undefined && this.hovered === JSON.stringify([kind, kind === TARGET.CLOSE ? undefined : selected?.id]);
			return paintHoverable(theme, key, hovered, ROLE.KEY) + (label ? ` ${paintHoverable(theme, label, hovered, ROLE.KEY_TEXT)}` : "");
		}).join(keys.gap);
		return [top, ...body, `${bar} ${fit(footer, inner - 2)} ${bar}`, theme.fg(ROLE.FRAME, `╰${rule(inner)}╯`)];
	}

	private orderedJobs(): JobRecord[] {
		return [...this.deps.jobs()].sort((a, b) =>
			Number(b.status === "running") - Number(a.status === "running") || b.startedAt - a.startedAt);
	}

	private close(): void {
		this.deps.onClose();
	}

	private selected(jobs: JobRecord[]): JobRecord | undefined {
		const selected = jobs.find((job) => job.id === this.selectedId) ?? jobs[0];
		this.selectedId = selected?.id;
		return selected;
	}

	private elapsed(job: JobRecord): string {
		return formatJobDuration((job.endedAt ?? this.deps.now()) - job.startedAt);
	}

	private followSelection(jobs: JobRecord[], selected: JobRecord | undefined, rows: number): void {
		const index = jobs.findIndex((job) => job.id === selected?.id);
		if (index < this.listScroll) this.listScroll = index;
		else if (index >= this.listScroll + rows) this.listScroll = index - rows + 1;
		this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, jobs.length - rows)));
	}

	private listLines(jobs: JobRecord[], selected: JobRecord | undefined, width: number, rows: number): string[] {
		const { theme } = this.deps;
		if (jobs.length === 0) return [theme.fg(ROLE.EMPTY, "No jobs")];
		return jobs.slice(this.listScroll, this.listScroll + rows).map((job) => {
			const [mark, role] = glyph(job);
			const elapsed = this.elapsed(job);
			const isSelected = job.id === selected?.id;
			const hovered = this.hovered === JSON.stringify([TARGET.JOB, job.id]);
			const name = fit(`${isSelected ? "›" : " "} ${mark} ${clean(job.label)}`, Math.max(0, width - visibleWidth(elapsed) - 1));
			return `${paintHoverable(theme, name, hovered, isSelected ? ROLE.SELECTED : role === "accent" ? ROLE.NAME : role)} ${paintHoverable(theme, elapsed, hovered, ROLE.META)}`;
		});
	}

	private detailLines(job: JobRecord, rows: number): string[] {
		const { theme } = this.deps;
		const head = [
			theme.fg(ROLE.TITLE, `${clean(job.label)} · ${job.id}`),
			`${theme.fg(ROLE.META, "Command")} ${clean(job.command)}`,
			`${theme.fg(ROLE.META, "Status ")} ${clean(jobOutcome(job))} · ${this.elapsed(job)}${job.kind === "monitor" ? ` · ${job.events ?? 0} event${job.events === 1 ? "" : "s"}` : ""}`,
			`${theme.fg(ROLE.META, "Output ")} ${clean(job.outputPath)}`,
			"",
		];
		const room = Math.max(0, rows - head.length - 1);
		const tail = job.tail.slice(-room).map((line) => sanitizeTerminalText(line));
		return [...head, theme.fg(ROLE.META, tail.length > 0 ? "Last output" : "No output yet."), ...tail];
	}

	private keys(selected: JobRecord | undefined, narrow: boolean): Array<[string, string]> {
		const keys: Array<[string, string]> = [["↑↓", "move"]];
		if (narrow && selected) keys.push(["tab", this.details ? "list" : "details"]);
		if (selected?.status === "running") keys.push(["s", "Stop"]);
		keys.push(["q", "close"]);
		return keys;
	}

	private fittingKeys(selected: JobRecord | undefined, narrow: boolean, width: number): FooterKeys {
		const entries = this.keys(selected, narrow);
		if (visibleWidth(entries.map(keyText).join("   ")) <= width) return { entries, gap: "   " };
		const actions = entries.filter(([key]) => keyTarget(key) !== undefined);
		if (visibleWidth(actions.map(keyText).join(" ")) <= width) return { entries: actions, gap: " " };
		const compact: Array<[string, string]> = [];
		if (narrow && selected) compact.push([this.details ? "←" : "→", ""]);
		if (selected?.status === "running") compact.push(["s", "Stop"]);
		compact.push(["×", ""]);
		const shown = new Set<string>();
		let used = 0;
		// Navigation and close take priority if there is not room for Stop.
		for (const key of ["×", this.details ? "←" : "→", "s"]) {
			const pair = compact.find(([candidate]) => candidate === key);
			if (!pair) continue;
			const size = visibleWidth(keyText(pair)) + (shown.size ? 1 : 0);
			if (used + size <= width) {
				shown.add(key);
				used += size;
			}
		}
		return { entries: compact.filter(([key]) => shown.has(key)), gap: " " };
	}

	private clearPointerLayout(): void {
		this.pointerLayout = undefined;
		this.pointerScope.invalidate();
		this.hovered = undefined;
	}

	private rememberLayout(next: PointerLayout): void {
		const previous = this.pointerLayout;
		if (previous && (previous.width !== next.width || previous.height !== next.height || previous.sourceHeight !== next.sourceHeight || previous.mode !== next.mode || previous.details !== next.details || previous.selectedId !== next.selectedId || previous.selectedRunning !== next.selectedRunning || previous.listScroll !== next.listScroll || JSON.stringify(previous.rowIds) !== JSON.stringify(next.rowIds) || JSON.stringify(previous.targets) !== JSON.stringify(next.targets))) this.pointerScope.invalidate();
		this.pointerLayout = next;
		this.pointerRegion.render(next.width);
	}

	private pointerLayoutIsCurrent(layout: PointerLayout, event: TuiMouseEvent): boolean {
		const live = measureAgentsViewLayout(event.width, this.deps.rows(), this.details);
		const height = live.mode === "fallback" ? Math.min(1, live.height) : live.height;
		if (event.width !== layout.width || event.height !== layout.height || live.width !== layout.width || height !== layout.height || live.height !== layout.sourceHeight || live.mode !== layout.mode || this.details !== layout.details || event.x < 0 || event.x >= layout.width || event.y < 0 || event.y >= layout.height) return false;
		if (live.mode === "fallback") return true;
		const jobs = this.orderedJobs();
		const selected = jobs.find((job) => job.id === this.selectedId) ?? jobs[0];
		if (selected?.id !== layout.selectedId || (selected?.status === "running") !== layout.selectedRunning || this.listScroll !== layout.listScroll) return false;
		const rowIds = live.mode === "panes" || !this.details ? jobs.slice(layout.listScroll, layout.listScroll + live.bodyRows).map((job) => job.id) : [];
		return rowIds.length === layout.rowIds.length && rowIds.every((id, index) => id === layout.rowIds[index]);
	}

	private targetAt(event: TuiMouseEvent): PointerTarget | undefined {
		return this.pointerLayout?.targets.find((target) => event.y === target.y && event.x >= target.x && event.x < target.x + target.width);
	}

	private hover(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const target = this.targetAt(event);
		if (!target) return undefined;
		const changed = this.hovered !== target.key;
		this.hovered = target.key;
		return { handled: true, render: changed };
	}

	private press(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const target = this.targetAt(event);
		if (event.button !== "left" || !target) return undefined;
		this.pressed = target.key;
		return { handled: true, render: false };
	}

	private click(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const target = this.targetAt(event);
		if (event.button !== "left" || !target) return undefined;
		const pressed = this.pressed;
		this.pressed = undefined;
		if (pressed !== undefined && pressed !== target.key) return { handled: true, render: false };
		if (target.kind === TARGET.JOB) {
			this.selectedId = target.id;
			if (this.pointerLayout?.mode === "narrow") this.details = true;
		} else if (target.kind === TARGET.DETAILS) this.details = !this.details;
		else if (target.kind === TARGET.STOP) {
			// The rendered control and the press both identify this exact job.
			const current = this.deps.jobs().find((job) => job.id === target.id);
			if (!current || current.status !== "running") return { handled: true, render: false };
			this.deps.onStop(current);
		} else this.close();
		this.clearPointerLayout();
		return { handled: true, render: true };
	}
}
