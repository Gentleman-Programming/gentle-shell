import { renameSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFileAtomicallySync } from "./agent-profiles.ts";

// Fleet ledger (odd/tasks/fleet-orchestrator.md S5): the fleet's state of
// record, kept in code and rendered by code into one general ODD-style
// document under `<controller cwd>/odd/fleet/<slug>.md`. No model tokens are
// spent on it; the controller model only reads the path.

export const FLEET_LOG_MAX = 200;
export const FLEET_WRITE_WINDOW_MS = 1000;
const TEXT_MAX = 160;
const CELL_MAX = 80;
const SLUG_MAX = 60;

export type FleetLogKind = "objective" | "spawn" | "send" | "settle" | "question" | "exit" | "stop";

export interface FleetLedgerMember {
	name: string;
	objective: string;
	cwd: string;
	status: string;
	todo: { done: number; total: number; current: string | null } | null;
	tokens: number;
	cost: number;
	/** Pending question, one line with its options. */
	question: string | null;
	lastError: string | null;
	exitCode: number | null;
	exitSignal: string | null;
	spawnedAt: string;
	exitedAt: string | null;
}

export type FleetMemberFields = Pick<FleetLedgerMember, "status" | "todo" | "tokens" | "cost" | "question" | "lastError">;

export interface FleetLogEntry {
	at: string;
	kind: FleetLogKind;
	member: string | null;
	text: string;
}

export interface FleetLedgerState {
	version: 1;
	fleetSessionId: string;
	title: string | null;
	objective: string | null;
	slug: string;
	documentPath: string;
	updatedAt: string;
	members: FleetLedgerMember[];
	log: FleetLogEntry[];
}

export interface FleetLedgerOptions {
	fleetSessionId: string;
	/** Controller cwd; the document goes under `<cwd>/odd/fleet/`. */
	cwd: string;
	ledgerPath: string;
	schedule(fn: () => void, ms: number): () => void;
	now?(): Date;
	/** Atomic text write; defaults to temp file + rename. */
	write?(path: string, text: string): void;
	windowMs?: number;
	onError?(error: unknown): void;
}

function oneLine(value: string, max: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cell(value: string | null | undefined): string {
	const text = value ? oneLine(value, CELL_MAX) : "";
	return text ? text.replace(/\|/g, "\\|") : "—";
}

function tokens(value: number): string {
	return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/** Kebab-case and filename-safe; "fleet" when nothing usable remains. */
export function fleetSlug(text: string): string {
	const slug = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug.slice(0, SLUG_MAX).replace(/-+$/, "") || "fleet";
}

export function renderFleetDocument(state: FleetLedgerState): string {
	const live = state.members.filter(member => member.status !== "exited").length;
	const totalTokens = state.members.reduce((sum, member) => sum + member.tokens, 0);
	const totalCost = state.members.reduce((sum, member) => sum + member.cost, 0);
	const lines = [
		`# Fleet: ${state.title ?? "untitled"}`,
		"",
		`Objective: ${state.objective ?? "not set yet (fleet_objective)"}`,
		`Fleet session: \`${state.fleetSessionId}\``,
		`Updated: ${state.updatedAt}`,
		`Totals: ${state.members.length} members (${live} live) · ${tokens(totalTokens)} tok · $${totalCost.toFixed(2)}`,
		"",
		"<!-- Written by the gentle-fleet controller from its ledger; manual edits are overwritten. -->",
		"",
		"## Members",
		"",
	];
	if (state.members.length === 0) lines.push("No members yet.");
	else {
		lines.push("| Member | Owns | Status | Progress | Current task | Tokens / cost | Waiting on |", "|---|---|---|---|---|---|---|");
		for (const member of state.members) {
			const progress = member.todo ? `${member.todo.done}/${member.todo.total}` : null;
			lines.push(`| ${cell(member.name)} | ${cell(member.objective)} | ${cell(member.status)} | ${cell(progress)} | ${cell(member.todo?.current)} | ${tokens(member.tokens)} / $${member.cost.toFixed(2)} | ${cell(member.question)} |`);
		}
	}
	const blockers: string[] = [];
	for (const member of state.members) {
		if (member.question) blockers.push(`- ${member.name}: question — ${oneLine(member.question, TEXT_MAX)}`);
		if (member.lastError) blockers.push(`- ${member.name}: error — ${oneLine(member.lastError, TEXT_MAX)}`);
		if (member.exitedAt && member.exitCode !== null && member.exitCode !== 0) blockers.push(`- ${member.name}: exited with code ${member.exitCode}`);
	}
	lines.push("", "## Blockers", "", ...(blockers.length > 0 ? blockers : ["None."]), "", "## Log", "");
	if (state.log.length === 0) lines.push("No entries yet.");
	for (const entry of state.log) lines.push(`- ${entry.at} · ${entry.kind} · ${entry.member ?? "fleet"} — ${entry.text}`);
	return `${lines.join("\n")}\n`;
}

export class FleetLedger {
	private readonly options: FleetLedgerOptions;
	private readonly state: FleetLedgerState;
	private cancelWrite: (() => void) | undefined;
	private writtenDocument: string | undefined;

	constructor(options: FleetLedgerOptions) {
		this.options = options;
		const slug = fleetSlug(`fleet-${options.fleetSessionId}`);
		this.state = {
			version: 1,
			fleetSessionId: options.fleetSessionId,
			title: null,
			objective: null,
			slug,
			documentPath: this.pathFor(slug),
			updatedAt: this.now(),
			members: [],
			log: [],
		};
	}

	get documentPath(): string {
		return this.state.documentPath;
	}

	/** Names the fleet; returns the document path, which follows the title. */
	setObjective(title: string, objective: string): string {
		this.state.title = oneLine(title, TEXT_MAX);
		this.state.objective = objective.trim();
		this.state.slug = fleetSlug(title);
		this.state.documentPath = this.pathFor(this.state.slug);
		this.log("objective", null, this.state.title);
		return this.state.documentPath;
	}

	spawned(name: string, objective: string, cwd: string): void {
		const record: FleetLedgerMember = {
			name, objective: objective.trim(), cwd, status: "starting", todo: null, tokens: 0, cost: 0,
			question: null, lastError: null, exitCode: null, exitSignal: null, spawnedAt: this.now(), exitedAt: null,
		};
		const index = this.state.members.findIndex(member => member.name === name);
		if (index >= 0) this.state.members[index] = record;
		else this.state.members.push(record);
		this.log("spawn", name, oneLine(objective, TEXT_MAX));
	}

	update(name: string, fields: FleetMemberFields): void {
		const member = this.state.members.find(entry => entry.name === name);
		if (!member) return;
		Object.assign(member, fields);
		this.changed();
	}

	exited(name: string, code: number | null, signal: string | null): void {
		const member = this.state.members.find(entry => entry.name === name);
		if (member) Object.assign(member, { status: "exited", question: null, exitCode: code, exitSignal: signal, exitedAt: this.now() });
		this.log("exit", name, `code ${code ?? "none"}${signal ? `, ${signal}` : ""}`);
	}

	log(kind: FleetLogKind, member: string | null, text: string): void {
		this.state.log.push({ at: this.now(), kind, member, text: oneLine(text, TEXT_MAX) });
		if (this.state.log.length > FLEET_LOG_MAX) this.state.log.splice(0, this.state.log.length - FLEET_LOG_MAX);
		this.changed();
	}

	/** Writes a pending change now (tool results, shutdown). */
	flush(): void {
		if (!this.cancelWrite) return;
		this.cancelWrite();
		this.cancelWrite = undefined;
		this.writeNow();
	}

	// The first change opens one write window; later changes ride along.
	private changed(): void {
		this.cancelWrite ??= this.options.schedule(() => {
			this.cancelWrite = undefined;
			this.writeNow();
		}, this.options.windowMs ?? FLEET_WRITE_WINDOW_MS);
	}

	private writeNow(): void {
		this.state.updatedAt = this.now();
		const write = this.options.write ?? writeJsonFileAtomicallySync;
		try { write(this.options.ledgerPath, `${JSON.stringify(this.state, null, "\t")}\n`); }
		catch (error) { this.options.onError?.(error); }
		const path = this.state.documentPath;
		// Naming the fleet moves the default-slug document instead of leaving a stale copy.
		if (this.writtenDocument && this.writtenDocument !== path) {
			try { renameSync(this.writtenDocument, path); } catch { /* the old document is gone */ }
		}
		try {
			write(path, renderFleetDocument(this.state));
			this.writtenDocument = path;
		} catch (error) { this.options.onError?.(error); }
	}

	private pathFor(slug: string): string {
		return join(this.options.cwd, "odd", "fleet", `${slug}.md`);
	}

	private now(): string {
		return (this.options.now?.() ?? new Date()).toISOString();
	}
}
