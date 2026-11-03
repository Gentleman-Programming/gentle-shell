import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { isFinished, TASK_STATUS } from "./agents-protocol.ts";
import { renderThreadItem, type AgentsThreadTheme } from "./agents-thread-view.ts";
import { taskHeader } from "./agents-view.ts";
import { measureAgentsViewLayout } from "./agents-view-layout.ts";
import { AGENTS_GLYPH, formatElapsed } from "./agents-widget.ts";
import type { FleetMemberSubagent } from "./fleet-member.ts";

// The fleet controller's members-and-subagents modal (odd/tasks/fleet-orchestrator.md
// T10, S9): like /gentle:agents, a list on the left and the selected task's
// thread on the right, but grouped by fleet member, each with its own
// subagents as its gentle-agents activity widget last showed them. Read-only:
// a member's subagents belong to that member's orchestrator. It reads the
// members on every frame, so a repaint is all a member push needs.

/** What the modal reads from a fleet member; FleetMember fits it as is. */
export interface FleetAgentsMember {
	readonly name: string;
	readonly status: string;
	readonly objective?: string;
	readonly todo?: { done: number; total: number; current: string | null };
	readonly lastTool?: string;
	subagents(): readonly FleetMemberSubagent[];
}

export interface FleetAgentsViewDeps {
	theme: AgentsThreadTheme;
	rows: number | (() => number);
	members(): readonly FleetAgentsMember[];
	now(): number;
	onClose(): void;
	requestRender(): void;
}

type Row =
	| { key: string; kind: "member"; member: FleetAgentsMember; subagents: readonly FleetMemberSubagent[] }
	| { key: string; kind: "task"; member: FleetAgentsMember; subagent: FleetMemberSubagent };

const ROLE = { FRAME: "border", TITLE: "customMessageLabel", SELECTED: "accent", NAME: "text", META: "dim", KEY: "accent", EMPTY: "dim" } as const;
const STATUS_ROLE: Record<string, string> = { [TASK_STATUS.WAITING]: "warning", [TASK_STATUS.FAILED]: "error", [TASK_STATUS.TIMED_OUT]: "error" };
const KEYS = [["j/k", "select"], ["ctrl+j/k", "scroll"], ["f", "follow"], ["esc", "close"]] as const;

function rule(length: number): string {
	return "─".repeat(Math.max(0, length));
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const active = (subagents: readonly FleetMemberSubagent[]) => subagents.filter(({ task }) => !isFinished(task.status)).length;

export class FleetAgentsView implements Component {
	private readonly deps: FleetAgentsViewDeps;
	private selectedKey: string | undefined;
	private details = false;
	private scroll = 0;
	private follow = true;
	private lastWidth = 80;

	constructor(deps: FleetAgentsViewDeps) {
		this.deps = deps;
	}

	handleInput(data: string): void {
		const narrow = this.isNarrow();
		if (matchesKey(data, Key.escape)) {
			if (narrow && this.details) this.setDetails(false);
			else this.deps.onClose();
			return;
		}
		if (data === "q" || data === "w") return this.deps.onClose();
		if (narrow && (data === "\t" || matchesKey(data, Key.enter))) return this.setDetails(!this.details);
		if (narrow && this.details && (data === "j" || data === "k" || matchesKey(data, Key.down) || matchesKey(data, Key.up))) return this.scrollBy(data === "j" || matchesKey(data, Key.down) ? 1 : -1);
		if (data === "j" || matchesKey(data, Key.down)) this.move(1);
		else if (data === "k" || matchesKey(data, Key.up)) this.move(-1);
		else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("j"))) this.scrollBy(this.pageRows());
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("k"))) this.scrollBy(-this.pageRows());
		else if (data === "f") {
			this.follow = true;
			this.deps.requestRender();
		}
	}

	render(width: number): string[] {
		const layout = this.layout(width);
		this.lastWidth = layout.width;
		if (layout.width === 0 || layout.height === 0) return [];
		if (layout.mode === "fallback") return [fit("× Fleet agents · esc closes", layout.width)];
		const theme = this.deps.theme;
		const rows = this.rows();
		const selected = this.selected(rows);
		const inner = layout.width - 2;
		const subagents = rows.flatMap((row) => (row.kind === "member" ? row.subagents : []));
		const members = rows.filter((row) => row.kind === "member").length;
		const title = truncateToWidth(`${AGENTS_GLYPH} Fleet agents · ${plural(members, "member")} · ${active(subagents)} active ${active(subagents) === 1 ? "subagent" : "subagents"}`, Math.max(0, inner - 4), "…");
		const top = theme.fg(ROLE.FRAME, "╭─ ") + theme.fg(ROLE.TITLE, title) + theme.fg(ROLE.FRAME, ` ${rule(inner - visibleWidth(title) - 3)}╮`);
		const listStart = this.listStart(rows, selected, layout.bodyRows);
		const list = (index: number) => this.listLine(rows, listStart + index, selected);
		const showDetails = layout.mode === "panes" || this.details;
		const detail = showDetails ? this.detailLines(selected, layout.bodyRows, layout.threadWidth) : [];
		const frame = (text: string) => theme.fg(ROLE.FRAME, text);
		const body: string[] = [];
		for (let row = 0; row < layout.bodyRows; row += 1) {
			if (layout.mode === "panes") body.push(`${frame("│")} ${fit(list(row), layout.listWidth)} ${frame("│")} ${fit(detail[row] ?? "", layout.threadWidth)}${frame("│")}`);
			else body.push(`${frame("│")} ${fit(this.details ? detail[row] ?? "" : list(row), layout.listWidth)} ${frame("│")}`);
		}
		const keys = layout.mode === "narrow" ? [KEYS[0], ["tab", this.details ? "back" : "details"] as const, ...KEYS.slice(1)] : KEYS;
		const footer = keys.map(([key, label]) => `${theme.fg(ROLE.KEY, key)} ${theme.fg(ROLE.META, label)}`).join("   ");
		return [top, ...body, `${frame("│")} ${fit(footer, inner - 2)} ${frame("│")}`, frame(`╰${rule(inner)}╯`)];
	}

	invalidate(): void {}

	private layout(width: number) {
		const rows = typeof this.deps.rows === "function" ? this.deps.rows() : this.deps.rows;
		return measureAgentsViewLayout(width, rows);
	}

	private isNarrow(): boolean {
		return this.layout(this.lastWidth).mode !== "panes";
	}

	private pageRows(): number {
		return Math.max(1, this.layout(this.lastWidth).bodyRows - 1);
	}

	private rows(): Row[] {
		const rows: Row[] = [];
		for (const member of this.deps.members()) {
			const subagents = member.subagents();
			rows.push({ key: `member:${member.name}`, kind: "member", member, subagents });
			for (const subagent of subagents) rows.push({ key: `task:${member.name}:${subagent.task.id}`, kind: "task", member, subagent });
		}
		return rows;
	}

	// The selection follows its key across pushes; a vanished one falls back
	// to the first subagent, else the first member.
	private selected(rows: readonly Row[]): Row | undefined {
		const current = rows.find((row) => row.key === this.selectedKey);
		if (current) return current;
		const next = rows.find((row) => row.kind === "task") ?? rows[0];
		this.selectedKey = next?.key;
		this.scroll = 0;
		this.follow = true;
		return next;
	}

	private move(delta: number): void {
		const rows = this.rows();
		const index = rows.findIndex((row) => row.key === this.selected(rows)?.key);
		const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
		if (!next || next.key === this.selectedKey) return;
		this.selectedKey = next.key;
		this.scroll = 0;
		this.follow = true;
		this.deps.requestRender();
	}

	private setDetails(details: boolean): void {
		this.details = details;
		this.deps.requestRender();
	}

	private listStart(rows: readonly Row[], selected: Row | undefined, height: number): number {
		const index = selected ? rows.indexOf(selected) : 0;
		return Math.max(0, Math.min(index - Math.floor(height / 2), rows.length - height));
	}

	private listLine(rows: readonly Row[], index: number, selected: Row | undefined): string {
		const theme = this.deps.theme;
		if (rows.length === 0) return index === 0 ? theme.fg(ROLE.EMPTY, "no members yet") : "";
		const row = rows[index];
		if (!row) return "";
		const marker = row === selected ? theme.fg(ROLE.SELECTED, "▸") : " ";
		const nameRole = row === selected ? ROLE.SELECTED : ROLE.NAME;
		if (row.kind === "member") return `${marker} ${theme.fg(nameRole, row.member.name)} ${theme.fg(ROLE.META, this.memberState(row.member, row.subagents))}`;
		const { task } = row.subagent;
		const elapsed = task.startedAt === null ? "" : `  ${theme.fg(ROLE.META, formatElapsed((task.endedAt ?? this.deps.now()) - task.startedAt))}`;
		return `${marker}  ${theme.fg(ROLE.META, "└")} ${theme.fg(nameRole, task.agent)} ${theme.fg(STATUS_ROLE[task.status] ?? ROLE.META, `· ${task.status}`)}${elapsed}`;
	}

	private memberState(member: FleetAgentsMember, subagents: readonly FleetMemberSubagent[]): string {
		const todo = member.todo ? ` · todo ${member.todo.done}/${member.todo.total}` : "";
		return `· ${member.status}${todo} · ${subagents.length === 0 ? "no subagents" : plural(subagents.length, "subagent")}`;
	}

	private detailLines(selected: Row | undefined, rows: number, width: number): string[] {
		const theme = this.deps.theme;
		if (!selected) return [];
		if (selected.kind === "member") {
			const { member, subagents } = selected;
			return [
				theme.fg(ROLE.NAME, `${member.name} ${this.memberState(member, subagents)}`),
				...(member.objective ? [theme.fg(ROLE.META, `objective: ${member.objective}`)] : []),
				...(member.todo?.current ? [theme.fg(ROLE.META, `current: ${member.todo.current}`)] : []),
				...(member.lastTool ? [theme.fg(ROLE.META, `last tool: ${member.lastTool}`)] : []),
				"",
				theme.fg(ROLE.EMPTY, subagents.length === 0 ? "no subagents yet" : `${plural(subagents.length, "subagent")} · ${active(subagents)} active`),
			].map((line) => truncateToWidth(line, width, "…"));
		}
		const head = this.taskHead(selected.subagent, width);
		const lines = this.threadLines(selected.subagent, width);
		if (lines.length === 0) return [...head, theme.fg(ROLE.EMPTY, "waiting for the first event")];
		const maxScroll = Math.max(0, lines.length - Math.max(0, rows - head.length));
		if (this.follow) this.scroll = maxScroll;
		const start = Math.min(this.scroll, maxScroll);
		return [...head, ...lines.slice(start, start + rows - head.length)];
	}

	// Label, agent, status and elapsed (the /gentle:agents header), then the last step.
	private taskHead({ task }: FleetMemberSubagent, width: number): string[] {
		const theme = this.deps.theme;
		return [
			theme.fg(ROLE.META, taskHeader(task, this.deps.now())),
			theme.fg(ROLE.NAME, task.label),
			...(task.lastStep ? [theme.fg(ROLE.META, `last step: ${task.lastStep}`)] : []),
			...(task.error ? [theme.fg("error", task.error)] : []),
		].map((line) => truncateToWidth(line, width, "…"));
	}

	private threadLines({ thread }: FleetMemberSubagent, width: number): string[] {
		const dropped = thread.dropped > 0 ? [this.deps.theme.fg(ROLE.META, `… ${thread.dropped} earlier items not kept`)] : [];
		return [...dropped, ...thread.items.flatMap((item) => renderThreadItem(item, this.deps.theme, width))];
	}

	private scrollBy(delta: number): void {
		const rows = this.rows();
		const selected = this.selected(rows);
		if (selected?.kind !== "task") return;
		const layout = this.layout(this.lastWidth);
		const total = this.threadLines(selected.subagent, layout.threadWidth).length;
		const maxScroll = Math.max(0, total - Math.max(0, layout.bodyRows - this.taskHead(selected.subagent, layout.threadWidth).length));
		this.follow = false;
		this.scroll = Math.max(0, Math.min(maxScroll, Math.min(this.scroll, maxScroll) + delta));
		this.deps.requestRender();
	}
}
