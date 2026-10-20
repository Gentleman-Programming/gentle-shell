import { isKeyRelease, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Work, WorkSession } from "./gentle-works.ts";
import { renderPaletteCard, renderPaletteSelection, type CommandPaletteTheme } from "./command-palette.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

export type WorksResult = { action: "close" | "create" } | { action: "inspect" | "edit" | "link"; id: string };
export function safeWorkText(text: string): string {
	return sanitizeTerminalText(text).replace(/[\t\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
}
export function observeActivity(work: Work, current?: WorkSession, idle?: boolean): { state: "unknown" | "waiting" | "running"; observedAt?: string } {
	if (!current || !work.session || current.id !== work.session.id || current.file !== work.session.file || typeof idle !== "boolean") return { state: "unknown" };
	return { state: idle ? "waiting" : "running", observedAt: new Date().toISOString() };
}

/** A disposable screen: no runtime subscriptions, I/O, or persistent mutations. */
export class WorksView {
	private selected = 0;
	private offset = 0;
	private finished = false;
	private pageSize = 12;
	private detailLength = 0;
	private works: readonly Work[];
	private done: (result: WorksResult) => void;
	private theme?: CommandPaletteTheme;
	private detail?: Work;
	private lines: string[];
	private rows: () => number;
	constructor(works: readonly Work[], done: (result: WorksResult) => void, theme?: CommandPaletteTheme, detail?: Work, lines: string[] = [], rows: () => number = () => 24) {
		this.works = works; this.done = done; this.theme = theme;
		this.detail = detail; this.lines = lines; this.rows = rows;
	}
	invalidate() {}
	private finish(result: WorksResult) { this.finished = true; this.done(result); }
	handleInput(data: string) {
		if (this.finished || isKeyRelease(data)) return;
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) return this.finish({ action: "close" });
		if (this.detail) {
			if (data === "e" || data === "l") return this.finish({ action: data === "e" ? "edit" : "link", id: this.detail.id });
			const step = matchesKey(data, "pageDown") ? this.pageSize : matchesKey(data, "pageUp") ? -this.pageSize : matchesKey(data, "down") || data === "j" ? 1 : matchesKey(data, "up") || data === "k" ? -1 : 0;
			this.offset = Math.max(0, Math.min(Math.max(0, this.detailLength - this.pageSize), this.offset + step));
		} else {
			if (matchesKey(data, "down") || data === "j") this.selected = Math.min(this.works.length, this.selected + 1);
			if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
			if (matchesKey(data, "enter")) this.finish(this.selected === 0 ? { action: "create" } : { action: "inspect", id: this.works[this.selected - 1].id });
		}
	}
	render(width: number): string[] {
		if (width <= 0) return [];
		const inner = Math.max(1, width - 4);
		const height = Math.max(1, Math.floor(this.rows()) - 7);
		this.pageSize = height;
		const title = this.detail ? `Work · ${safeWorkText(this.detail.title).replace(/\n/g, " ")}` : "Works · durable objectives";
		const footer = this.detail ? "↑/↓ scroll · PgUp/PgDn · e edit · l link current · esc back" : "↑/↓ move · enter open · esc close";
		let body: string[];
		if (this.detail) {
			const wrapped = this.lines.flatMap(line => wrapTextWithAnsi(safeWorkText(line), inner));
			this.detailLength = wrapped.length;
			this.offset = Math.min(this.offset, Math.max(0, wrapped.length - height));
			body = wrapped.slice(this.offset, this.offset + height);
		} else {
			const labels = ["Create work + link current session", ...this.works.map(work => `${safeWorkText(work.title)} · ${work.status} · ${safeWorkText(work.branch ?? "branch unknown")} · ${safeWorkText(work.worktree ?? "location unknown")}`)];
			const start = Math.max(0, this.selected - height + 1);
			body = labels.slice(start, start + height).map((label, i) => renderPaletteSelection(label.replace(/\n/g, " "), inner, start + i === this.selected, this.theme));
			if (!this.works.length) body.push("No works yet");
		}
		const content = [this.theme ? this.theme.fg("accent", title) : title, ...body, footer];
		return (width < 5 ? content : renderPaletteCard(content, width, this.theme)).map(line => truncateToWidth(line, width, "", true));
	}
}
