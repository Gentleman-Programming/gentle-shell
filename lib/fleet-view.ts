import { formatTokens } from "./shell-bar.ts";
import { renderGauge } from "./shell-gauge.ts";

// Fleet TUI view model (odd/tasks/fleet-orchestrator.md T5-U1, S4/S5/S7):
// the chosen 05-calm-deck artboard as plain data. Built only from the ledger
// snapshot (lib/fleet-ledger.ts) plus the live extras the controller tracks
// per member (lib/fleet-member.ts); no Pi runtime. One focal item at a time,
// ranked by what moves the objective, and lenses over the same member rows.

export type FleetLens = "flows" | "map" | "costs" | "log";
export type FleetDensity = "light" | "normal" | "power";
export const FLEET_LENSES: readonly FleetLens[] = ["flows", "map", "costs", "log"];
export const FLEET_DENSITIES: readonly FleetDensity[] = ["light", "normal", "power"];

export function nextDensity(density: FleetDensity): FleetDensity {
	return FLEET_DENSITIES[(FLEET_DENSITIES.indexOf(density) + 1) % FLEET_DENSITIES.length];
}

export interface FleetViewDialog {
	id: string;
	method: string;
	title: string;
	message?: string;
	options?: string[];
	/** A protected class code relays to the human (FleetMemberDialog.protected). */
	relayed?: boolean;
	/** When the dialog arrived; ties in the attention queue go oldest first. */
	at?: string;
}

/** FleetLedgerMember fields plus the controller's live extras for that member. */
export interface FleetViewMember {
	name: string;
	objective: string;
	cwd?: string;
	status: string;
	todo: { done: number; total: number; current: string | null } | null;
	tokens: number;
	cost: number;
	question: string | null;
	lastError: string | null;
	worktree?: string | null;
	branch?: string | null;
	exitCode?: number | null;
	exitSignal?: string | null;
	spawnedAt?: string;
	exitedAt?: string | null;
	lastTool?: string;
	thinking?: string;
	dialogs?: FleetViewDialog[];
	prefixTokens?: number;
	cacheRead?: number;
	/** Defaults to the name prefix before the first "-". */
	front?: string;
	/** A branch or PR the member reported ready (not tracked by the ledger yet). */
	review?: { label: string; at: string };
}

export interface FleetViewLogEntry {
	at: string;
	kind: string;
	member: string | null;
	text: string;
}

/** A member question the fleet chose to bring to the human. */
export interface FleetViewEscalation {
	member: string;
	title: string;
	message?: string;
	options?: string[];
	/** The member dialog's method; a confirm offers Yes and No. */
	method?: string;
	/** The member dialog the fleet brought to the human. */
	dialogId?: string;
	at: string;
}

export interface FleetViewSnapshot {
	title: string | null;
	objective: string | null;
	members: FleetViewMember[];
	log: FleetViewLogEntry[];
	escalations?: FleetViewEscalation[];
	budgets?: { fleetUsd?: number | null; memberUsd?: number | null };
	controller?: { tokens: number; cost: number };
	documentPath?: string;
	/** The controller's own next step; otherwise the first working member's current todo. */
	nextStep?: string;
	/** When the fleet expects to report next, e.g. "around 14:40". */
	nextUpdate?: string;
	/** The controller's live permission mode (lib/permission-mode-policy.ts). */
	permission?: string;
}

export type FleetMemberViewState = "needs-you" | "blocked" | "working" | "waiting" | "done";

const GROUPS: { key: FleetMemberViewState; label: string; open: boolean }[] = [
	{ key: "needs-you", label: "Needs you", open: true },
	{ key: "blocked", label: "Blocked", open: true },
	{ key: "working", label: "Working", open: true },
	{ key: "waiting", label: "Waiting on others", open: false },
	{ key: "done", label: "Done", open: false },
];
const STATE: Record<FleetMemberViewState, { glyph: string; label: string; tone: string | null }> = {
	"needs-you": { glyph: "◆", label: "waiting on you", tone: "warning" },
	blocked: { glyph: "✕", label: "blocked", tone: "error" },
	working: { glyph: "●", label: "working", tone: null },
	waiting: { glyph: "◇", label: "waiting on others", tone: null },
	done: { glyph: "✓", label: "done", tone: null },
};
const STATION: Record<FleetMemberViewState, string> = { "needs-you": "◆", blocked: "✕", working: "◉", waiting: "◇", done: "●" };
const TRACK_STATIONS_MAX = 12;
const NAME_TEXT_MAX = 120;
/** Fronts that get a member hue in power density (system.md per-front hue rule). */
export const FLEET_FRONT_HUES = 3;

const relayedDialogs = (m: FleetViewMember) => (m.dialogs ?? []).filter((dialog) => dialog.relayed);
const frontOf = (m: FleetViewMember) => m.front ?? m.name.split("-")[0];
const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const oneLine = (text: string, max = NAME_TEXT_MAX) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function stoppedByFleet(m: FleetViewMember, log: FleetViewLogEntry[]): boolean {
	return log.some((entry) => entry.kind === "stop" && entry.member === m.name && (!m.spawnedAt || entry.at >= m.spawnedAt));
}

export function memberState(m: FleetViewMember, snapshot: FleetViewSnapshot): FleetMemberViewState {
	if (relayedDialogs(m).length > 0 || (snapshot.escalations ?? []).some((entry) => entry.member === m.name)) return "needs-you";
	if (m.status === "exited") return !stoppedByFleet(m, snapshot.log) && (m.exitCode !== 0 || m.lastError) ? "blocked" : "done";
	if (m.status === "idle" && m.lastError) return "blocked";
	return m.status === "starting" || m.status === "working" ? "working" : "waiting";
}

function ordered(snapshot: FleetViewSnapshot): { member: FleetViewMember; state: FleetMemberViewState }[] {
	const states = snapshot.members.map((member) => ({ member, state: memberState(member, snapshot) }));
	return GROUPS.flatMap((group) => states.filter((entry) => entry.state === group.key));
}

export interface FleetObjectiveProgress {
	title: string;
	objective: string | null;
	/** False until the fleet states its objective (fleet_objective). */
	stated: boolean;
	done: number;
	total: number;
	percent: number;
	frontsDone: number;
	frontsTotal: number;
	nextStep: string | null;
}

export function objectiveProgress(snapshot: FleetViewSnapshot): FleetObjectiveProgress {
	const done = snapshot.members.reduce((sum, m) => sum + (m.todo?.done ?? 0), 0);
	const total = snapshot.members.reduce((sum, m) => sum + (m.todo?.total ?? 0), 0);
	const fronts = [...new Set(snapshot.members.map(frontOf))];
	const frontsDone = fronts.filter((front) => snapshot.members.filter((m) => frontOf(m) === front).every((m) => memberState(m, snapshot) === "done")).length;
	const working = ordered(snapshot).find((entry) => entry.state === "working" && entry.member.todo?.current);
	const nextStep = snapshot.nextStep ?? (working ? `${working.member.todo.current} (${working.member.name})` : null);
	return { title: snapshot.title ?? "Untitled fleet", objective: snapshot.objective, stated: snapshot.title !== null, done, total, percent: percent(done, total), frontsDone, frontsTotal: fronts.length, nextStep };
}

export type FocalKind = "decision" | "blocker" | "review" | "nothing";

export interface FocalItem {
	id: string;
	kind: FocalKind;
	tag: string;
	title: string;
	ask: string;
	why: string;
	options: string[];
	members: string[];
	at: string | null;
	/** The member dialog a decision answers: a relayed one, or one the fleet escalated. */
	dialogId?: string;
}

export interface AttentionQueue {
	/** Exactly one item: the first ranked one, or "nothing". */
	focal: FocalItem;
	/** How many ranked items wait after the focal one ("then: N more"). */
	more: number;
	items: FocalItem[];
}

const RANK: Record<FocalKind, number> = { decision: 0, blocker: 1, review: 2, nothing: 3 };

function dialogOptions(dialog: { method?: string; options?: string[] }): string[] {
	if (dialog.options?.length) return dialog.options;
	return dialog.method === "confirm" ? ["Yes", "No"] : ["Type an answer…"];
}

function lastLogAt(snapshot: FleetViewSnapshot, member: string, kinds: string[]): string | null {
	return snapshot.log.filter((entry) => entry.member === member && kinds.includes(entry.kind)).at(-1)?.at ?? null;
}

export function attentionQueue(snapshot: FleetViewSnapshot): AttentionQueue {
	const items: FocalItem[] = [];
	const decision = (m: FleetViewMember, source: { title: string; message?: string; options?: string[]; method?: string; at?: string }, id: string, why: string, dialogId?: string) =>
		items.push({
			id, kind: "decision", tag: "Your call", title: oneLine(source.title), ask: `${m.name} asks: ${oneLine(source.title)}`,
			why: source.message ? oneLine(source.message) : why, options: dialogOptions(source), members: [m.name],
			at: source.at ?? lastLogAt(snapshot, m.name, ["question", "relay"]) ?? m.spawnedAt ?? null, ...(dialogId ? { dialogId } : {}),
		});
	for (const m of snapshot.members) {
		for (const dialog of relayedDialogs(m)) decision(m, dialog, `decision:${m.name}:${dialog.id}`, "Only you can answer this one; the fleet cannot.", dialog.id);
		(snapshot.escalations ?? []).forEach((entry, index) => {
			if (entry.member === m.name) decision(m, entry, `decision:${m.name}:escalation-${index}`, "The fleet brought this to you; it is outside its authority.", entry.dialogId);
		});
	}
	for (const m of snapshot.members) {
		if (memberState(m, snapshot) !== "blocked") continue;
		const failure = m.lastError ?? `exited with code ${m.exitCode ?? "none"}${m.exitSignal ? ` (${m.exitSignal})` : ""}`;
		items.push({
			id: `blocker:${m.name}`, kind: "blocker", tag: "Blocked", title: `${m.name} stopped`, ask: `${m.name} stopped: ${oneLine(failure)}`,
			why: m.objective ? oneLine(`It owns: ${m.objective}`) : "Its front cannot move until this is handled.",
			options: ["Respawn it with the failing output", "I'll take it", "Drop it from this objective"],
			members: [m.name], at: m.exitedAt ?? lastLogAt(snapshot, m.name, ["exit", "settle"]) ?? m.spawnedAt ?? null,
		});
	}
	// TODO(U2): the ledger does not record "ready for review" yet; the controller
	// must set `review` on a member when it reports a PR or a branch ready.
	const reviews = snapshot.members.filter((m) => m.review).sort((a, b) => a.review.at.localeCompare(b.review.at));
	if (reviews.length > 0) {
		items.push({
			id: "review", kind: "review", tag: "Ready for review", title: reviews.length === 1 ? `${reviews[0].review.label} from ${reviews[0].name}` : `${reviews.length} ready to review`,
			ask: `${reviews.map((m) => `${m.review.label} ${m.name}`).join(" · ")} ${reviews.length === 1 ? "is" : "are"} ready. Merging stays with you.`,
			why: "Merged early, they keep the other branches small.", options: ["List them with their branches", "Later: bring them back at the next wake"],
			members: reviews.map((m) => m.name), at: reviews[0].review.at,
		});
	}
	// Stable: rank first, then oldest first (unknown times last); equal times keep member order.
	const byTime = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b));
	const ranked = items.map((item, index) => ({ item, index }))
		.sort((a, b) => RANK[a.item.kind] - RANK[b.item.kind] || byTime(a.item.at, b.item.at) || a.index - b.index)
		.map((entry) => entry.item);
	const idle = snapshot.members.length === 0;
	const nothing: FocalItem = {
		id: "nothing", kind: "nothing", tag: "Nothing needs you", title: idle ? "Nothing needs you yet" : "Nothing needs you",
		ask: idle ? "No member is working yet." : `The fleet keeps going${snapshot.nextUpdate ? `; next update ${snapshot.nextUpdate}` : ""}.`, why: "", options: [], members: [], at: null,
	};
	return { focal: ranked[0] ?? nothing, more: Math.max(0, ranked.length - 1), items: ranked };
}

export interface LensCell {
	key: string;
	text: string;
	/** Theme role; the renderer defaults to `text`. */
	role?: string;
	/** Percent for a gauge cell, painted with the shared gauge. */
	gauge?: number;
	/** Fixed width, right-aligned, so the column lines up. */
	width?: number;
	/** Free text that takes the room left in the row and is cut first. */
	flex?: boolean;
}

export interface LensRow {
	name: string;
	state: FleetMemberViewState;
	glyph: string;
	label: string;
	focal: boolean;
	/** Glyph tone (warning/error) from normal density on. */
	tone: string | null;
	/** Front hue index in power density; null otherwise or for unhued fronts. */
	hue: number | null;
	cells: LensCell[];
}

export interface LensGroup {
	key: FleetMemberViewState;
	label: string;
	count: number;
	/** 05 opens the attention groups and folds Waiting on others and Done. */
	open: boolean;
	summary: string | null;
	focal: boolean;
	rows: LensRow[];
}

export interface LensView {
	lens: FleetLens;
	density: FleetDensity;
	focal: FocalItem;
	head: string[];
	groups: LensGroup[];
	/** With no members: the lens's one short empty line; null otherwise. */
	empty: string | null;
}

function task(m: FleetViewMember, state: FleetMemberViewState, snapshot: FleetViewSnapshot): string {
	if (state === "needs-you") return oneLine(relayedDialogs(m)[0]?.title ?? (snapshot.escalations ?? []).find((entry) => entry.member === m.name)?.title ?? "waiting on you");
	if (state === "blocked") return oneLine(m.lastError ?? `exited with code ${m.exitCode ?? "none"}`);
	if (state === "working") return oneLine(m.todo?.current ?? (m.lastTool ? `last tool ${m.lastTool}` : "starting"));
	if (state === "done") return m.review ? `${m.review.label} ready for review` : "done";
	const asked = (m.dialogs ?? [])[0];
	return asked ? oneLine(`asked the fleet: ${asked.title}`) : "waiting for the fleet";
}

function track(m: FleetViewMember, state: FleetMemberViewState): string {
	const total = m.todo?.total ?? 0;
	if (total === 0) return "○ no todo yet";
	const done = Math.min(m.todo.done, total);
	const stations = Array.from({ length: total }, (_, i) => (i < done ? "●" : i === done ? STATION[state] : "○"));
	const shown = stations.length > TRACK_STATIONS_MAX ? [...stations.slice(0, TRACK_STATIONS_MAX - 1), `+${stations.length - TRACK_STATIONS_MAX + 1}`] : stations;
	return [...shown, state === "done" ? "●" : "□"].join("━");
}

const time = (iso: string | null | undefined) => (iso ? iso.slice(11, 16) : "--:--");
// Two decimals, like the fleet document and the member digest.
const usd = (value: number) => `$${value.toFixed(2)}`;

function cells(lens: FleetLens, density: FleetDensity, m: FleetViewMember, state: FleetMemberViewState, focal: FocalItem, isFocal: boolean, snapshot: FleetViewSnapshot, maxCost: number): LensCell[] {
	const progress: LensCell = { key: "progress", text: m.todo ? `${m.todo.done}/${m.todo.total}` : "–", role: "muted", width: 5 };
	if (lens === "flows") {
		const lead = isFocal ? { key: "pointer", text: `→ ${focal.tag.toLowerCase()}, above the input`, role: "accent", flex: true } : { key: "task", text: task(m, state, snapshot), flex: true };
		if (density === "light") return isFocal ? [lead] : [];
		if (density === "normal") return [lead];
		return [{ key: "gauge", text: "", gauge: percent(m.todo?.done ?? 0, m.todo?.total ?? 0) }, progress, lead, { key: "cost", text: usd(m.cost), width: 7 }];
	}
	if (lens === "map") {
		const station: LensCell = { key: "station", text: state === "working" || state === "needs-you" ? oneLine(m.todo?.current ?? task(m, state, snapshot)) : task(m, state, snapshot), role: "muted", flex: true };
		return density === "light" ? [{ key: "track", text: track(m, state) }, progress] : [{ key: "track", text: track(m, state) }, progress, station];
	}
	if (lens === "costs") {
		return [
			{ key: "cost", text: usd(m.cost), width: 7 },
			{ key: "tokens", text: formatTokens(m.tokens), width: 6 },
			{ key: "cached", text: m.cacheRead !== undefined && m.tokens > 0 ? `${percent(m.cacheRead, m.tokens)}%` : "–", role: "muted", width: 5 },
			{ key: "share", text: "", gauge: percent(m.cost, maxCost) },
		];
	}
	// Budget entries carry spend; they stay in the costs lens.
	const last = snapshot.log.filter((entry) => entry.member === m.name && entry.kind !== "budget").at(-1);
	return [{ key: "time", text: time(last?.at), role: "muted", width: 5 }, { key: "event", text: last ? oneLine(`${last.kind}: ${last.text}`) : "no events yet", flex: true }];
}

// An empty fleet shows one short line per lens (05, T5-U3); the context
// line joins it from normal density on.
const EMPTY_LINES: Record<FleetLens, string> = { flows: "No members yet", map: "No map yet", costs: "No spend yet", log: "No events yet" };

function emptyHeads(lens: FleetLens, density: FleetDensity, snapshot: FleetViewSnapshot): string[] {
	if (density === "light") return [];
	const status = fleetStatus(snapshot);
	return [{
		flows: "the fleet spawns members for the objective",
		map: "stations appear as members take todos",
		costs: `spent $${status.spentUsd.toFixed(2)}${status.budgetUsd ? ` of $${status.budgetUsd.toFixed(2)}` : " · no fleet budget set"}`,
		log: snapshot.documentPath ?? "the fleet document starts with the objective",
	}[lens]];
}

function heads(lens: FleetLens, density: FleetDensity, snapshot: FleetViewSnapshot, rows: { member: FleetViewMember; state: FleetMemberViewState }[]): string[] {
	if (snapshot.members.length === 0) return emptyHeads(lens, density, snapshot);
	const count = (state: FleetMemberViewState) => rows.filter((entry) => entry.state === state).length;
	const progress = objectiveProgress(snapshot);
	if (lens === "flows") {
		const live = snapshot.members.filter((m) => m.status !== "exited").length;
		return [
			"what each member is doing, attention first",
			`${count("needs-you")} needs you · ${count("blocked")} blocked · ${count("working")} working · ${count("waiting")} waiting · ${count("done")} done`,
			`${live} of ${snapshot.members.length} live`,
		];
	}
	if (lens === "map") {
		return [
			"● done ◉ now ◆ you ✕ blocked ◇ waiting ○ pending □ PR",
			`${progress.percent}% of the plan · ${progress.done}/${progress.total} todos${progress.nextStep ? ` · next: ${progress.nextStep}` : ""}`,
			"one line per member, one station per todo",
		];
	}
	if (lens === "costs") {
		const status = fleetStatus(snapshot);
		const budget = status.budgetUsd
			? `budget ${renderGauge(percent(status.spentUsd, status.budgetUsd))} $${status.spentUsd.toFixed(2)} of $${status.budgetUsd.toFixed(2)} · ${percent(status.spentUsd, status.budgetUsd)}% · $${Math.max(0, status.budgetUsd - status.spentUsd).toFixed(2)} left`
			: `spent $${status.spentUsd.toFixed(2)} · no fleet budget set`;
		const tokens = snapshot.members.reduce((sum, m) => sum + m.tokens, snapshot.controller?.tokens ?? 0);
		const known = snapshot.members.filter((m) => m.cacheRead !== undefined);
		const cached = known.length ? ` · ${percent(known.reduce((sum, m) => sum + m.cacheRead, 0), known.reduce((sum, m) => sum + m.tokens, 0))}% cached` : "";
		const fronts = [...new Set(snapshot.members.map(frontOf))].map((front) => `${front} ${snapshot.members.filter((m) => frontOf(m) === front).reduce((sum, m) => sum + m.cost, 0).toFixed(2)}`);
		return [budget, `tokens ${formatTokens(tokens)}${cached}`, `fronts $ ${fronts.join(" · ")}`];
	}
	const blockers = rows.filter((entry) => entry.state === "blocked").map((entry) => entry.member.name);
	return [
		`odd.md · ${progress.title}`,
		`blockers: ${blockers.length ? blockers.join(" · ") : "none"} · ${count("waiting")} waiting on others`,
		`${snapshot.documentPath ?? "odd/fleet/<slug>.md"} · written by code`,
	];
}

export function lensRows(lens: FleetLens, density: FleetDensity, snapshot: FleetViewSnapshot, queue: AttentionQueue = attentionQueue(snapshot)): LensView {
	const rows = ordered(snapshot);
	const focalNames = new Set(queue.focal.members);
	const maxCost = Math.max(0, ...snapshot.members.map((m) => m.cost));
	// Hues mark the first fronts in spawn order; with three members or fewer, each member gets one.
	const hued = snapshot.members.length <= FLEET_FRONT_HUES ? snapshot.members.map((m) => m.name) : [...new Set(snapshot.members.map(frontOf))].slice(0, FLEET_FRONT_HUES);
	const groups = GROUPS.map((group): LensGroup => {
		const members = rows.filter((entry) => entry.state === group.key);
		const done = members.reduce((sum, entry) => sum + (entry.member.todo?.done ?? 0), 0);
		const total = members.reduce((sum, entry) => sum + (entry.member.todo?.total ?? 0), 0);
		const cost = members.reduce((sum, entry) => sum + entry.member.cost, 0);
		const summary = density === "light" ? null : lens === "map" ? `${done}/${total} todos` : lens === "costs" ? usd(cost) : null;
		return {
			key: group.key, label: group.label, count: members.length, open: group.open, summary,
			focal: members.some((entry) => focalNames.has(entry.member.name)),
			rows: members.map(({ member, state }) => {
				const hue = hued.indexOf(snapshot.members.length <= FLEET_FRONT_HUES ? member.name : frontOf(member));
				return {
					name: member.name, state, glyph: STATE[state].glyph, label: STATE[state].label, focal: focalNames.has(member.name),
					tone: density === "light" ? null : STATE[state].tone, hue: density === "power" && hue >= 0 ? hue : null,
					cells: cells(lens, density, member, state, queue.focal, focalNames.has(member.name), snapshot, maxCost),
				};
			}),
		};
	}).filter((group) => group.count > 0);
	return { lens, density, focal: queue.focal, head: heads(lens, density, snapshot, rows), groups, empty: snapshot.members.length === 0 ? EMPTY_LINES[lens] : null };
}

export interface FleetStatus {
	live: number;
	members: number;
	/** "1 decision · 1 blocked · 3 reviews", or "nothing needs you". */
	queue: string;
	spentUsd: number;
	budgetUsd: number | null;
	/** One status segment for a permission mode that changes what code approves; null otherwise. */
	permission: string | null;
}

export function fleetStatus(snapshot: FleetViewSnapshot, queue: AttentionQueue = attentionQueue(snapshot)): FleetStatus {
	const decisions = queue.items.filter((item) => item.kind === "decision").length;
	const blockers = queue.items.filter((item) => item.kind === "blocker").length;
	const reviews = queue.items.find((item) => item.kind === "review")?.members.length ?? 0;
	const parts = [
		decisions ? `${decisions} decision${decisions === 1 ? "" : "s"}` : "",
		blockers ? `${blockers} blocked` : "",
		reviews ? `${reviews} review${reviews === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	return {
		live: snapshot.members.filter((m) => m.status !== "exited").length,
		members: snapshot.members.length,
		queue: parts.length ? parts.join(" · ") : "nothing needs you",
		spentUsd: snapshot.members.reduce((sum, m) => sum + m.cost, snapshot.controller?.cost ?? 0),
		budgetUsd: snapshot.budgets?.fleetUsd ?? null,
		// Under the controller's Super YOLO, code approves members' guarded prompts (T3).
		permission: snapshot.permission === "super-yolo" ? "super-yolo: auto-approves guarded prompts" : null,
	};
}

/** Where the fleet keys act: anywhere, outside the editor, in the editor, or in the focal bar. */
export type FleetKeyScope = "global" | "outside-input" | "input" | "focal-bar";

export interface FleetViewKey {
	keys: string[];
	action: string;
	scope: FleetKeyScope;
	/** A Pi default action on the same key; the fleet takes it only `when`. */
	sharesPiAction?: string;
	when?: string;
}

// Keys from 05-calm-deck and design/system.md, in Pi's keybindings.json
// spelling. None takes a Pi default except tab, which Pi uses for autocomplete
// (docs/keybindings.md `tui.input.tab`); the fleet takes it only as stated.
// Letters never act in the input (a message may start with them): from the
// input, alt+1-4 pick a lens, alt+z zooms and alt+m changes the density. No
// function keys: they need fn on most Mac keyboards (user, T5-U3). Pi binds
// alt+z to undo only on WSL (docs/keybindings.md `tui.editor.undo`).
export const FLEET_VIEW_KEYS: readonly FleetViewKey[] = [
	{ keys: ["alt+1"], action: "lens.flows", scope: "global" },
	{ keys: ["alt+2"], action: "lens.map", scope: "global" },
	{ keys: ["alt+3"], action: "lens.costs", scope: "global" },
	{ keys: ["alt+4"], action: "lens.log", scope: "global" },
	{ keys: ["f"], action: "lens.flows", scope: "outside-input" },
	{ keys: ["m"], action: "lens.map", scope: "outside-input" },
	{ keys: ["$"], action: "lens.costs", scope: "outside-input" },
	{ keys: ["l"], action: "lens.log", scope: "outside-input" },
	{ keys: ["alt+m"], action: "density.next", scope: "global" },
	{ keys: ["tab"], action: "focal.toggle", scope: "input", sharesPiAction: "tui.input.tab", when: "a focal item exists and no autocomplete is open; otherwise Pi's tab runs" },
	{ keys: ["1", "2", "3", "4"], action: "focal.answer", scope: "focal-bar" },
	{ keys: ["alt+z"], action: "zoom.toggle", scope: "global", sharesPiAction: "tui.editor.undo", when: "always in the fleet controller; Pi binds alt+z to undo only on WSL, where the deck takes it over" },
	{ keys: ["z"], action: "zoom.toggle", scope: "outside-input" },
	{ keys: ["?"], action: "help", scope: "outside-input" },
];
