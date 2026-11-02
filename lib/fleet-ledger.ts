import { readFileSync, renameSync } from "node:fs";
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

export type FleetLogKind = "objective" | "spawn" | "send" | "settle" | "question" | "exit" | "stop" | "budget" | "answer" | "relay" | "grant" | "revoke" | "auto-approve" | "escalate" | "resume";
export const FLEET_AUTO_APPROVALS_MAX = 200;
const GRANT_TEXT_MAX = 300;

export interface FleetLedgerMember {
	name: string;
	objective: string;
	cwd: string;
	status: string;
	todo: { done: number; total: number; current: string | null } | null;
	/** Every token of the member's requests, cache reads included. */
	tokens: number;
	/** Input, output and cache-write tokens: what the document shows (T8, L54). Absent in older ledgers. */
	newTokens?: number;
	cacheRead?: number;
	cost: number;
	/** Pending question, one line with its options. */
	question: string | null;
	lastError: string | null;
	/** The member's own worktree and branch when it works in a git repository. */
	worktree: string | null;
	branch: string | null;
	exitCode: number | null;
	exitSignal: string | null;
	spawnedAt: string;
	exitedAt: string | null;
}

export type FleetMemberFields = Pick<FleetLedgerMember, "status" | "todo" | "tokens" | "newTokens" | "cacheRead" | "cost" | "question" | "lastError">;

export interface FleetLogEntry {
	at: string;
	kind: FleetLogKind;
	member: string | null;
	text: string;
}

export interface FleetBudgetWarning {
	at: string;
	/** null for the fleet budget. */
	member: string | null;
	text: string;
	/** The crossed threshold in percent; a resumed fleet never warns it again. */
	threshold?: number;
}

/** A standing permission the human confirmed (S2): it covers model-answerable questions only. */
export interface FleetGrant {
	id: string;
	scope: string;
	description: string;
	grantedAt: string;
}

/** A Blockers entry for one member event, such as a protected dialog code could not relay. */
export interface FleetBlockerNote {
	at: string;
	member: string;
	text: string;
}

/** A member question the fleet brought to the human (fleet_answer escalate); the human's answer goes to the fleet. */
export interface FleetEscalation {
	at: string;
	member: string;
	dialogId: string;
	method: string;
	title: string;
	message?: string;
	options?: string[];
	/** Asked by a member process that stopped with the fleet: its dialog is closed, the question is not. */
	stale?: boolean;
}

/** One protected dialog code approved under the controller's Super YOLO. */
export interface FleetAutoApproval {
	at: string;
	member: string;
	title: string;
	answer: string;
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
	/** One entry per crossed budget threshold; shown under Blockers. */
	budgetWarnings: FleetBudgetWarning[];
	blockers: FleetBlockerNote[];
	grants: FleetGrant[];
	/** Grant ids are never reused, even after a revoke. */
	nextGrantId: number;
	/** Audit of code approvals under the controller's Super YOLO, newest last. */
	autoApprovals: FleetAutoApproval[];
	/** Member questions waiting on the human, oldest first. */
	escalations: FleetEscalation[];
	log: FleetLogEntry[];
	/** Spend of members a respawn replaced; the fleet budget keeps counting it. */
	retiredCost: number;
	/** Members that were live when their controller stopped: a reopened fleet asks before resuming them. */
	interrupted: string[];
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
	/** Any state change, before the write window: the fleet deck refreshes from it. */
	onChange?(): void;
	/** A saved ledger of this fleet session (loadFleetLedger): the fleet continues from it. */
	restored?: FleetLedgerState;
}

function oneLine(value: string, max: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cell(value: string | null | undefined): string {
	const text = value ? oneLine(value, CELL_MAX) : "";
	return text ? text.replace(/\|/g, "\\|") : "—";
}

// Paths and branches are never truncated: a cut path cannot be opened.
function code(value: string | null): string {
	return value ? `\`${value.replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|")}\`` : "—";
}

function tokens(value: number): string {
	return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

// A ledger written before T8 kept only the cache-inclusive total.
const newTokensOf = (member: FleetLedgerMember) => member.newTokens ?? member.tokens;

/** Kebab-case and filename-safe; "fleet" when nothing usable remains. */
export function fleetSlug(text: string): string {
	const slug = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return slug.slice(0, SLUG_MAX).replace(/-+$/, "") || "fleet";
}

export function renderFleetDocument(state: FleetLedgerState): string {
	const live = state.members.filter(member => member.status !== "exited").length;
	const totalTokens = state.members.reduce((sum, member) => sum + newTokensOf(member), 0);
	const totalCost = state.members.reduce((sum, member) => sum + member.cost, 0);
	const lines = [
		`# Fleet: ${state.title ?? "untitled"}`,
		"",
		`Objective: ${state.objective ?? "not set yet (fleet_objective)"}`,
		`Fleet session: \`${state.fleetSessionId}\``,
		`Updated: ${state.updatedAt}`,
		`Totals: ${state.members.length} members (${live} live) · ${tokens(totalTokens)} new tok · $${totalCost.toFixed(2)}`,
		"",
		"<!-- Written by the gentle-fleet controller from its ledger; manual edits are overwritten. -->",
		"",
		"## Members",
		"",
	];
	if (state.members.length === 0) lines.push("No members yet.");
	else {
		lines.push("| Member | Owns | Status | Progress | Current task | New tokens / cost | Waiting on | Branch | Worktree |", "|---|---|---|---|---|---|---|---|---|");
		for (const member of state.members) {
			const progress = member.todo ? `${member.todo.done}/${member.todo.total}` : null;
			lines.push(`| ${cell(member.name)} | ${cell(member.objective)} | ${cell(member.status)} | ${cell(progress)} | ${cell(member.todo?.current)} | ${tokens(newTokensOf(member))} / $${member.cost.toFixed(2)} | ${cell(member.question)} | ${code(member.branch)} | ${code(member.worktree)} |`);
		}
	}
	const blockers: string[] = [];
	for (const member of state.members) {
		if (member.question) blockers.push(`- ${member.name}: question — ${oneLine(member.question, TEXT_MAX)}`);
		if (member.lastError) blockers.push(`- ${member.name}: error — ${oneLine(member.lastError, TEXT_MAX)}`);
		if (member.exitedAt && member.exitCode !== null && member.exitCode !== 0) blockers.push(`- ${member.name}: exited with code ${member.exitCode}`);
	}
	for (const warning of state.budgetWarnings) blockers.push(`- ${warning.member ?? "fleet"}: budget — ${oneLine(warning.text, TEXT_MAX)}`);
	for (const note of state.blockers) blockers.push(`- ${note.member}: ${note.text}`);
	for (const entry of state.escalations) blockers.push(`- ${entry.member}: escalated to the human — ${oneLine(entry.title, TEXT_MAX)}`);
	const grants = state.grants.map(grant => `- ${grant.id} · ${code(grant.scope)} — ${grant.description} (granted ${grant.grantedAt})`);
	lines.push("", "## Blockers", "", ...(blockers.length > 0 ? blockers : ["None."]), "", "## Grants", "", ...(grants.length > 0 ? grants : ["None."]));
	if (state.autoApprovals.length > 0) {
		lines.push("", "## Auto-approvals", "", "Protected dialogs code approved under the controller's Super YOLO:", "");
		for (const approval of state.autoApprovals) lines.push(`- ${approval.at} · ${approval.member} — ${approval.title} → ${approval.answer}`);
	}
	lines.push("", "## Log", "");
	if (state.log.length === 0) lines.push("No entries yet.");
	for (const entry of state.log) lines.push(`- ${entry.at} · ${entry.kind} · ${entry.member ?? "fleet"} — ${entry.text}`);
	return `${lines.join("\n")}\n`;
}

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

/**
 * The saved ledger of one fleet session, or undefined when there is none or it
 * is unreadable. Fields added after a ledger was written get empty values.
 */
export function loadFleetLedger(path: string, fleetSessionId: string): FleetLedgerState | undefined {
	let state: FleetLedgerState;
	try { state = JSON.parse(readFileSync(path, "utf8")) as FleetLedgerState; } catch { return undefined; }
	if (state?.version !== 1 || state.fleetSessionId !== fleetSessionId || typeof state.slug !== "string" || typeof state.documentPath !== "string") return undefined;
	if (![state.members, state.budgetWarnings, state.blockers, state.grants, state.autoApprovals, state.escalations, state.log].every(isArray)) return undefined;
	return {
		...state,
		retiredCost: typeof state.retiredCost === "number" && Number.isFinite(state.retiredCost) ? state.retiredCost : 0,
		interrupted: isArray(state.interrupted) ? state.interrupted.filter((name): name is string => typeof name === "string") : [],
		escalations: state.escalations.map(entry => ({ ...entry, stale: true })),
	};
}

export class FleetLedger {
	private readonly options: FleetLedgerOptions;
	private readonly state: FleetLedgerState;
	private cancelWrite: (() => void) | undefined;
	private writtenDocument: string | undefined;

	constructor(options: FleetLedgerOptions) {
		this.options = options;
		if (options.restored) {
			this.state = options.restored;
			// The document stays where it was; naming the fleet later moves it.
			this.writtenDocument = options.restored.documentPath;
			return;
		}
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
			budgetWarnings: [],
			blockers: [],
			grants: [],
			nextGrantId: 1,
			autoApprovals: [],
			escalations: [],
			log: [],
			retiredCost: 0,
			interrupted: [],
		};
	}

	get documentPath(): string {
		return this.state.documentPath;
	}

	/** The live state, read-only, for the fleet deck. */
	get current(): Readonly<FleetLedgerState> {
		return this.state;
	}

	get grants(): readonly FleetGrant[] {
		return this.state.grants;
	}

	/** The fleet's slug; it names member branches and worktrees too. */
	get slug(): string {
		return this.state.slug;
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

	spawned(name: string, objective: string, cwd: string, worktree?: { path: string; branch: string }): void {
		const record: FleetLedgerMember = {
			name, objective: objective.trim(), cwd, status: "starting", todo: null, tokens: 0, cost: 0,
			question: null, lastError: null, worktree: worktree?.path ?? null, branch: worktree?.branch ?? null,
			exitCode: null, exitSignal: null, spawnedAt: this.now(), exitedAt: null,
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

	/** A crossed budget threshold: a Blockers entry and a log entry. */
	budgetWarning(member: string | null, text: string, threshold?: number): void {
		this.state.budgetWarnings.push({ at: this.now(), member, text: oneLine(text, TEXT_MAX), ...(threshold === undefined ? {} : { threshold }) });
		this.log("budget", member, text);
	}

	/** A respawn replaced a member: its spend stays in the fleet's. */
	retire(cost: number): void {
		if (cost <= 0) return;
		this.state.retiredCost += cost;
		this.changed();
	}

	/**
	 * The controller stopped these live members (session end or switch). Their
	 * escalations outlive the closed dialogs: the human can still answer them.
	 */
	interrupt(names: readonly string[]): void {
		if (names.length === 0) return;
		this.state.interrupted = [...new Set([...this.state.interrupted, ...names])];
		for (const entry of this.state.escalations) if (names.includes(entry.member)) entry.stale = true;
		this.changed();
	}

	/** A reopened fleet waits for the human: these members show as stopped, nothing restarts. */
	awaitResume(names: readonly string[]): void {
		this.state.interrupted = [...names];
		for (const member of this.state.members) if (names.includes(member.name)) Object.assign(member, { status: "stopped", question: null });
		this.log("resume", null, `fleet reopened; ${names.length} member${names.length === 1 ? " was" : "s were"} live: ${names.join(", ")}`);
	}

	/** The resume question is settled for this member (resumed, kept stopped or refused). */
	settleResume(name: string): void {
		this.state.interrupted = this.state.interrupted.filter(entry => entry !== name);
		this.changed();
	}

	/** A member continues its own session in a new process. */
	resumed(name: string): void {
		const member = this.state.members.find(entry => entry.name === name);
		if (member) Object.assign(member, { status: "starting", question: null, lastError: null, exitCode: null, exitSignal: null, exitedAt: null });
		this.settleResume(name);
		this.log("resume", name, "resumed in its own session");
	}

	/** Not resumed: kept stopped by the human (a fleet stop), or refused with a reason (a blocker). */
	notResumed(name: string, reason?: string): void {
		const member = this.state.members.find(entry => entry.name === name);
		if (member) Object.assign(member, { status: "exited", question: null, exitedAt: member.exitedAt ?? this.now(), ...(reason ? { lastError: reason } : {}) });
		this.settleResume(name);
		if (reason) this.blocker(name, reason);
		else this.log("stop", name, "kept stopped by the human when the fleet reopened");
	}

	/** Records a standing permission; call only after the human confirmed it. */
	grant(scope: string, description: string): FleetGrant {
		const grant: FleetGrant = { id: `g${this.state.nextGrantId}`, scope: oneLine(scope, TEXT_MAX), description: oneLine(description, GRANT_TEXT_MAX), grantedAt: this.now() };
		this.state.nextGrantId += 1;
		this.state.grants.push(grant);
		this.log("grant", null, `${grant.id} ${grant.scope}`);
		return grant;
	}

	revoke(id: string): FleetGrant | undefined {
		const index = this.state.grants.findIndex(grant => grant.id === id);
		if (index < 0) return undefined;
		const [grant] = this.state.grants.splice(index, 1);
		this.log("revoke", null, `${grant.id} ${grant.scope}`);
		return grant;
	}

	blocker(member: string, text: string): void {
		this.state.blockers.push({ at: this.now(), member, text: oneLine(text, GRANT_TEXT_MAX) });
		this.changed();
	}

	autoApproved(member: string, title: string, answer: string): void {
		this.state.autoApprovals.push({ at: this.now(), member, title: oneLine(title, TEXT_MAX), answer: oneLine(answer, CELL_MAX) });
		if (this.state.autoApprovals.length > FLEET_AUTO_APPROVALS_MAX) this.state.autoApprovals.splice(0, this.state.autoApprovals.length - FLEET_AUTO_APPROVALS_MAX);
		this.log("auto-approve", member, `${oneLine(title, CELL_MAX)} → ${answer}`);
	}

	escalate(member: string, dialog: Omit<FleetEscalation, "at" | "member">): void {
		this.state.escalations.push({ at: this.now(), member, ...dialog, title: oneLine(dialog.title, TEXT_MAX) });
		this.log("escalate", member, dialog.title);
	}

	/** The human answered an escalation; it leaves the queue. */
	resolveEscalation(member: string, dialogId: string): FleetEscalation | undefined {
		const index = this.state.escalations.findIndex(entry => entry.member === member && entry.dialogId === dialogId);
		if (index < 0) return undefined;
		const [entry] = this.state.escalations.splice(index, 1);
		this.changed();
		return entry;
	}

	/** Drops a member's escalations whose dialog is no longer pending. */
	keepEscalations(member: string, pendingDialogIds: readonly string[]): void {
		const kept = this.state.escalations.filter(entry => entry.member !== member || entry.stale || pendingDialogIds.includes(entry.dialogId));
		if (kept.length === this.state.escalations.length) return;
		this.state.escalations = kept;
		this.changed();
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
		this.options.onChange?.();
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
