import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { gentlePiConfigHome } from "../lib/agent-home.ts";
import { resolveAgentHomeDirectory } from "../lib/agent-model-resolution.ts";
import type { PiCommand, ProcessControl, Spawn } from "../lib/agents-runner.ts";
import { readFleetConfig } from "../lib/fleet-config.ts";
import { buildFleetSnapshot, DECK_WIDGET_KEY, FleetDeck } from "../lib/fleet-deck.ts";
import { autoApproval, describeResponse, type DialogResponse } from "../lib/fleet-dialogs.ts";
import { FleetLedger, loadFleetLedger, type FleetMemberFields } from "../lib/fleet-ledger.ts";
import { buildMemberLaunch, FleetMember, latestMemberSessionFile, type FleetMemberDialog, type FleetMemberEvent } from "../lib/fleet-member.ts";
import { fleetRole } from "../lib/fleet-role.ts";
import type { FocalItem } from "../lib/fleet-view.ts";
import { createMemberWorktree, reattachMemberWorktree, runGit, type GitExec } from "../lib/fleet-worktree.ts";
import type { PermissionMode } from "../lib/permission-mode-policy.ts";
import { isInteractiveMode } from "../lib/rpc-host.ts";
import { discoverYoloUiAdapter } from "../lib/yolo-session-policy.ts";

// Gentle Fleet controller (odd/tasks/fleet-orchestrator.md, F0-F1, F3). Active
// only in the session `gentle-shell fleet` starts: it spawns full
// headless Gentle Shell members (each git member in its own worktree), tracks
// them in code, keeps the fleet ledger and its general document current by
// code, and wakes the controller model with one coalesced digest when a member
// settles, asks or exits. The human's fleet.json sets the live-member limit
// and optional budgets; crossed budget thresholds ride the next digest.
// F2 (S2): the fleet answers member dialogs with fleet_answer; protected
// classes (lib/fleet-dialogs.ts) go by code to the human through this
// session's own UI, fail closed without one, and under the controller's
// Super YOLO code approves the guard, permission and access classes, audited.
// F4 (S4, S7): in the TUI the calm deck (lib/fleet-deck.ts) shows the fleet;
// rpc and print keep the one-line digest widget.
// F5 (T6): reopening the controller session (Pi's --continue, --resume or
// --session) loads its ledger; members that stopped with it resume only when
// the human says so on the deck, in their own session file and worktree.

export const FLEET_DIGEST_MESSAGE_TYPE = "gentle-fleet.digest";
export const FLEET_WAKE_WINDOW_MS = 1500;
const WIDGET_KEY = DECK_WIDGET_KEY;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const FLEET_INSPECT_LINES = 40;
const INSPECT_LINES_MAX = 200;
const LOG_TEXT_MAX = 120;
const DIGEST_TITLE_MAX = 120;
const DIGEST_MESSAGE_MAX = 160;
const DIGEST_OPTION_MAX = 40;
const DIGEST_OPTIONS_SHOWN = 10;
const DIGEST_LINE_MAX = 700;
// Budget thresholds in percent, highest first: a jump past both warns once.
const BUDGET_THRESHOLDS = [100, 80];

// Live E2E (L8): the controller prefix is mostly tool schemas, and peer/session
// tools invited needless calls. The controller only coordinates, reads and
// remembers; members and normal sessions keep every tool. Memory is narrowed
// to recall and record (T2b, L27): the 24 memory schemas were ~14k chars.
const CONTROLLER_TOOLS = new Set([
	"read", "grep", "find", "ls", "ask_user_question", "ask_user_choice",
	"mem_search", "mem_context", "mem_get_observation", "mem_save", "mem_current_project",
]);

export function isControllerTool(name: string): boolean {
	return name.startsWith("fleet_") || CONTROLLER_TOOLS.has(name);
}

export interface FleetDeps {
	spawn: Spawn;
	schedule(fn: () => void, ms: number): () => void;
	pi?: PiCommand;
	home: string;
	agentHome?: string;
	process?: ProcessControl;
	now?(): Date;
	/** Atomic text write for the ledger and the fleet document. */
	writeFile?(path: string, text: string): void;
	/** gentle-pi config home holding the human's fleet.json. */
	configHome?: string;
	git: GitExec;
	/** This controller session's live permission mode; default: the yolo host channel. */
	permissionMode?(ctx: ExtensionContext): Promise<PermissionMode>;
}

const defaultDeps = (): FleetDeps => ({
	spawn: (command, args, options) => spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: options.detached }),
	schedule: (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
	home: os.homedir(),
	git: runGit,
});

function text(value: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: value }], details: { gentleFleet: details } };
}

/** The deck's 1-4 on a relayed dialog: only offered options and yes/no are answerable there. */
function deckResponse(dialog: FleetMemberDialog, option: number): DialogResponse | undefined {
	if (dialog.method === "confirm") return option <= 1 ? { confirmed: option === 0 } : undefined;
	const value = dialog.method === "select" ? dialog.options?.[option] : undefined;
	return value === undefined ? undefined : { value };
}

/** Tokens and spend of this controller session's own requests; new tokens leave cache reads out (T8). */
function controllerUsage(ctx: ExtensionContext): { tokens: number; cost: number; newTokens: number; cacheRead: number } | undefined {
	try {
		let tokens = 0, cost = 0, newTokens = 0, cacheRead = 0;
		for (const entry of ctx.sessionManager.getEntries() as Array<{ type?: string; message?: { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } } } }>) {
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			const usage = entry.message.usage;
			tokens += usage?.totalTokens ?? 0;
			cost += usage?.cost?.total ?? 0;
			newTokens += (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
			cacheRead += usage?.cacheRead ?? 0;
		}
		return { tokens, cost, newTokens, cacheRead };
	} catch {
		return undefined;
	}
}

function oneLine(value: string, max: number): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function questionLine(dialog: { title: string; options?: string[] }): string {
	return `${dialog.title}${dialog.options?.length ? ` [${dialog.options.join(" | ")}]` : ""}`;
}

/** Everything the controller needs to answer without an inspect call, bounded. */
function fleetQuestionLine(dialog: FleetMemberDialog): string {
	const options = dialog.options ?? [];
	const shown = options.slice(0, DIGEST_OPTIONS_SHOWN).map((option, index) => `${index + 1}. ${oneLine(option, DIGEST_OPTION_MAX)}`);
	if (options.length > shown.length) shown.push(`… ${options.length - shown.length} more`);
	const line = `  question ${dialog.id} (${dialog.method}) for the fleet: ${oneLine(dialog.title, DIGEST_TITLE_MAX)}${dialog.message ? ` — ${oneLine(dialog.message, DIGEST_MESSAGE_MAX)}` : ""}${shown.length ? ` [${shown.join(" | ")}]` : ""} → fleet_answer`;
	return line.length > DIGEST_LINE_MAX ? `${line.slice(0, DIGEST_LINE_MAX - 1)}…` : line;
}

/** The highest threshold `spent` newly reaches; marks it and every lower one seen. */
function crossedThreshold(spent: number, budget: number | undefined, seen: Set<number>): number | undefined {
	if (budget === undefined) return undefined;
	const hit = BUDGET_THRESHOLDS.find(threshold => spent >= budget * threshold / 100);
	if (hit === undefined || seen.has(hit)) return undefined;
	for (const threshold of BUDGET_THRESHOLDS) if (threshold <= hit) seen.add(threshold);
	return hit;
}

function ledgerFields(member: FleetMember): FleetMemberFields {
	return {
		status: member.status,
		todo: member.todo ?? null,
		tokens: member.usage.totalTokens,
		newTokens: member.newTokens,
		cacheRead: member.usage.cacheRead,
		cost: member.usage.cost,
		question: member.dialogs[0] ? questionLine(member.dialogs[0]) : null,
		lastError: member.lastError ?? null,
	};
}

export default function gentleFleet(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env, overrides: Partial<FleetDeps> = {}): void {
	if (fleetRole(env) !== "controller") return;
	const deps: FleetDeps = { ...defaultDeps(), ...overrides };
	const agentHome = resolveAgentHomeDirectory({ env, home: deps.home, agentHome: overrides.agentHome, homeOverridden: overrides.home !== undefined });
	// Read at load for the tool description, again at session start and before
	// every spawn so the human's edits apply without a restart.
	const configHome = deps.configHome ?? gentlePiConfigHome(env);
	let config = readFleetConfig(configHome);
	const members = new Map<string, FleetMember>();
	let ctxRef: ExtensionContext | undefined;
	// Members of a reopened fleet waiting on the human's resume answer.
	let pendingResume: string[] = [];
	let fleetSessionId = "unknown";
	const pending = new Map<string, FleetMemberEvent[]>();
	let cancelWake: (() => void) | undefined;
	let closed = false;
	let ledger: FleetLedger | undefined;
	let reportedWriteError = false;
	// Budget state of this fleet session: thresholds already warned, warnings
	// waiting for the next digest. Spend, retired spend included, is the ledger's.
	const fleetThresholds = new Set<number>();
	const memberThresholds = new WeakMap<FleetMember, Set<number>>();
	const pendingBudget: string[] = [];
	// What code did with each protected dialog, for the digest line.
	const relayNotes = new WeakMap<FleetMemberDialog, string>();
	// The human answers one relayed dialog at a time.
	let humanQueue: Promise<void> = Promise.resolve();
	// The relayed dialog the human is answering now; the deck's 1-4 can answer it too.
	// `focus` is the relay dialog's component, read right after Pi focused it.
	let activeRelay: { member: FleetMember; dialog: FleetMemberDialog; answer(response: DialogResponse): void; focus?: unknown } | undefined;
	const dialogArrivals = new WeakMap<FleetMemberDialog, string>();
	let deck: FleetDeck | undefined;
	let unmountDeck: (() => void) | undefined;
	// The controller's live permission mode, for the deck's status line.
	let permission: PermissionMode = "normal";
	let stopObservingMode: (() => void) | undefined;
	const readPermissionMode = deps.permissionMode ?? (async (ctx: ExtensionContext): Promise<PermissionMode> => {
		const adapter = await discoverYoloUiAdapter(pi, ctx);
		if (!adapter) return "normal";
		try { return (await adapter.readMode?.()) ?? "normal"; } finally { adapter.dispose(); }
	});

	const sessionPath = (...parts: string[]) => join(agentHome, "gentle-fleet", "sessions", fleetSessionId, ...parts);
	// The same fleet session id finds its saved ledger: a reopened fleet continues from it.
	const ensureLedger = (cwd: string) => ledger ??= new FleetLedger({
		fleetSessionId,
		cwd,
		ledgerPath: sessionPath("ledger.json"),
		restored: loadFleetLedger(sessionPath("ledger.json"), fleetSessionId),
		schedule: deps.schedule,
		now: deps.now,
		write: deps.writeFile,
		// Only the deck: in rpc every setWidget is an RPC event, and member changes already refresh it.
		onChange: () => deck?.invalidate(),
		onError: error => {
			if (reportedWriteError) return;
			reportedWriteError = true;
			ctxRef?.ui.notify(`Gentle Fleet could not write its ledger or fleet document: ${error instanceof Error ? error.message : String(error)}`, "warning");
		},
	});

	const isCurrent = (member: FleetMember) => members.get(member.name) === member;
	const fleetSpend = () => {
		const state = ledger?.current;
		return state ? state.members.reduce((sum, member) => sum + member.cost, state.retiredCost) : 0;
	};
	const warnBudget = (member: string | null, text: string, threshold: number) => {
		pendingBudget.push(text);
		ledger?.budgetWarning(member, text, threshold);
	};
	// Thresholds the ledger already warned for the fleet (null) or one member since its spawn.
	const warnedThresholds = (member: string | null, since?: string) => new Set((ledger?.current.budgetWarnings ?? [])
		.filter(warning => warning.member === member && (since === undefined || warning.at >= since))
		.map(warning => warning.threshold ?? Number(/\((\d+)%\)/.exec(warning.text)?.[1]))
		.filter(threshold => BUDGET_THRESHOLDS.includes(threshold)));
	// Cost is information (L15): a crossed threshold is reported once, nothing stops.
	const checkBudgets = (member: FleetMember) => {
		const seen = memberThresholds.get(member) ?? new Set<number>();
		memberThresholds.set(member, seen);
		const memberHit = crossedThreshold(member.usage.cost, config.memberBudgetUsd, seen);
		if (memberHit !== undefined) warnBudget(member.name, `member ${member.name} spent $${member.usage.cost.toFixed(2)} of its $${config.memberBudgetUsd!.toFixed(2)} budget (${memberHit}%)${memberHit === 100 ? "; it keeps working" : ""}`, memberHit);
		const spent = fleetSpend();
		const fleetHit = crossedThreshold(spent, config.fleetBudgetUsd, fleetThresholds);
		if (fleetHit !== undefined) warnBudget(null, `fleet spent $${spent.toFixed(2)} of its $${config.fleetBudgetUsd!.toFixed(2)} budget (${fleetHit}%)${fleetHit === 100 ? "; fleet_spawn refuses new members" : ""}`, fleetHit);
	};
	const track = (member: FleetMember) => {
		if (!isCurrent(member)) return;
		ledger?.update(member.name, ledgerFields(member));
		ledger?.keepEscalations(member.name, member.dialogs.map(dialog => dialog.id));
		checkBudgets(member);
	};

	// Only ever removes tools: another extension may have disabled one of the
	// allowed tools on purpose (ask_user_choice outside the TUI), and the
	// allowlist must not bring it back.
	const restrictTools = () => {
		const allowed = new Set(pi.getAllTools().filter(tool => tool.exposure !== "hidden" && isControllerTool(tool.name)).map(tool => tool.name));
		const active = pi.getActiveTools();
		const next = active.filter(name => allowed.has(name));
		if (next.length === active.length) return;
		pi.setActiveTools(next);
	};

	// Print mode, no UI, or rpc without the interactive host signal: nobody to ask.
	const canAskHuman = (ctx: ExtensionContext | undefined): ctx is ExtensionContext => ctx?.hasUI === true && isInteractiveMode(ctx.mode, env);

	const askDialog = async (ctx: ExtensionContext, member: FleetMember, dialog: FleetMemberDialog, signal: AbortSignal): Promise<DialogResponse> => {
		const title = `Fleet member "${member.name}": ${dialog.relay?.title ?? dialog.title}`;
		switch (dialog.method) {
			case "select": {
				const options = dialog.options ?? [];
				const value = await ctx.ui.select(title, options, { signal });
				return value !== undefined && options.includes(value) ? { value } : { cancelled: true };
			}
			case "confirm":
				return { confirmed: (await ctx.ui.confirm(title, dialog.relay?.message ?? "", { signal })) === true };
			case "input": {
				const value = await ctx.ui.input(title, dialog.relay?.placeholder, { signal });
				return value === undefined ? { cancelled: true } : { value };
			}
			case "editor": {
				const value = await ctx.ui.editor(title, dialog.relay?.prefill);
				return value === undefined ? { cancelled: true } : { value };
			}
			default:
				return { cancelled: true };
		}
	};

	// The human answers in the dialog or with the deck's 1-4, whichever comes
	// first; the other is dismissed. Both feed the same relay step below.
	const askHuman = async (ctx: ExtensionContext, member: FleetMember, dialog: FleetMemberDialog): Promise<DialogResponse> => {
		const dismiss = new AbortController();
		const fromDeck = new Promise<DialogResponse>(resolve => {
			activeRelay = { member, dialog, answer: resolve };
		});
		const relay = activeRelay!;
		// Pi focuses its dialog synchronously, before the first await in askDialog.
		const asked = askDialog(ctx, member, dialog, dismiss.signal);
		relay.focus = deck?.focused();
		refreshWidget();
		try { return await Promise.race([asked, fromDeck]); }
		finally {
			activeRelay = undefined;
			dismiss.abort();
		}
	};

	const cancelProtected = (member: FleetMember, dialog: FleetMemberDialog, reason: string) => {
		if (!member.respond(dialog.id, { cancelled: true })) return;
		relayNotes.set(dialog, `cancelled by code: ${reason}`);
		ledger?.blocker(member.name, `protected question cancelled — ${oneLine(dialog.title, LOG_TEXT_MAX)} (${reason})`);
		track(member);
	};

	// The model never answers a protected dialog: code approves it under the
	// controller's Super YOLO when its class allows, else asks the human, else
	// cancels it. Never an approval without one of the two.
	const handleProtected = async (member: FleetMember, dialog: FleetMemberDialog) => {
		const ctx = ctxRef;
		const approval = autoApproval({ method: dialog.method, title: dialog.relay?.title ?? dialog.title, message: dialog.relay?.message, options: dialog.options });
		if (approval && ctx) {
			let mode: PermissionMode = "normal";
			try { mode = await readPermissionMode(ctx); } catch { /* unreadable mode is not Super YOLO */ }
			if (mode === "super-yolo" && isCurrent(member) && member.respond(dialog.id, approval)) {
				const answer = describeResponse(approval);
				relayNotes.set(dialog, `auto-approved by code under the controller's Super YOLO with ${answer}`);
				ledger?.autoApproved(member.name, dialog.title, answer);
				track(member);
				return;
			}
		}
		if (!isCurrent(member) || !member.hasDialog(dialog.id)) return;
		if (!canAskHuman(ctx)) {
			cancelProtected(member, dialog, "no interactive UI to relay it to the human");
			return;
		}
		humanQueue = humanQueue.then(async () => {
			if (!isCurrent(member) || !member.hasDialog(dialog.id)) return;
			let response: DialogResponse;
			try { response = await askHuman(ctx, member, dialog); }
			catch {
				cancelProtected(member, dialog, "the relay to the human failed");
				return;
			}
			const title = oneLine(dialog.title, LOG_TEXT_MAX);
			if (!isCurrent(member) || !member.respond(dialog.id, response)) {
				ledger?.log("relay", member.name, `the human's answer to "${title}" arrived after the dialog closed`);
				return;
			}
			relayNotes.set(dialog, `answered by the human (relayed by code) with ${describeResponse(response)}`);
			ledger?.log("answer", member.name, `human answered (relayed by the fleet) "${title}": ${describeResponse(response)}`);
			track(member);
		}).catch(() => {});
	};

	const dialogDigestLine = (dialog: FleetMemberDialog) => dialog.protected
		? `  protected question ${dialog.id} (${dialog.method}) ${relayNotes.get(dialog) ?? "relayed to the human by code"}: ${oneLine(dialog.title, DIGEST_TITLE_MAX)}`
		: fleetQuestionLine(dialog);

	const refreshWidget = () => {
		if (deck) {
			deck.invalidate();
			return;
		}
		const ui = ctxRef?.hasUI ? ctxRef.ui : undefined;
		if (!ui) return;
		ui.setWidget(WIDGET_KEY, members.size === 0 ? undefined : [...members.values()].map(member => member.digest()));
	};

	// The fleet model reads the human's deck choices as their own words.
	const tellFleet = (message: string) => {
		try { void Promise.resolve(pi.sendUserMessage(message, ctxRef?.isIdle?.() === false ? { deliverAs: "followUp" } : undefined)).catch(() => {}); }
		catch { /* a closed session takes no message */ }
	};

	const answerFocal = (item: FocalItem, option: number): string | undefined => {
		const choice = item.options[option];
		const name = item.members[0];
		if (item.id === "resume") {
			if (pendingResume.length === 0) return "Nothing waits to resume.";
			if (option === 0) resumeMembers();
			else keepStopped();
			return undefined;
		}
		if (!item.dialogId) {
			tellFleet(`The human chose "${choice}" for: ${item.ask}`);
			return undefined;
		}
		const member = members.get(name);
		const dialog = member?.dialogs.find(entry => entry.id === item.dialogId);
		// Asked before the fleet stopped: the dialog closed with that process, the fleet relays the answer.
		const earlier = ledger?.current.escalations.find(entry => entry.member === name && entry.dialogId === item.dialogId && entry.stale);
		if (earlier && !dialog) {
			const title = oneLine(earlier.title, LOG_TEXT_MAX);
			ledger!.resolveEscalation(name, earlier.dialogId);
			if (!earlier.options?.length && earlier.method !== "confirm") {
				ctxRef?.ui.setEditorText(`Answer for ${name}'s earlier question "${title}": `);
				return undefined;
			}
			ledger!.log("answer", name, `human answered escalated "${title}": ${choice} (sent to the fleet; asked before the fleet stopped)`);
			tellFleet(`The human answered ${name}'s escalated question ${earlier.dialogId} ("${title}") from before the fleet stopped: ${choice}. That dialog closed with the member's process; send the answer with fleet_send when ${name} runs.`);
			return undefined;
		}
		if (!member || !dialog) return "That question is no longer open.";
		if (dialog.protected) {
			// Only through the relay, and only the dialog it is asking now.
			if (activeRelay?.member !== member || activeRelay.dialog !== dialog) return "Answer the open question first: the fleet asks you one at a time.";
			const response = deckResponse(dialog, option);
			if (!response) return "This question needs a typed answer: answer it in its dialog.";
			activeRelay.answer(response);
			return undefined;
		}
		const escalation = ledger?.current.escalations.find(entry => entry.member === name && entry.dialogId === dialog.id);
		if (!escalation) return "The fleet handles that question; it is not waiting on you.";
		if (!dialog.options?.length && dialog.method !== "confirm") {
			ctxRef?.ui.setEditorText(`Answer for ${name}'s question ${dialog.id} ("${oneLine(dialog.title, LOG_TEXT_MAX)}"): `);
			return undefined;
		}
		ledger!.resolveEscalation(name, dialog.id);
		ledger!.log("answer", name, `human answered escalated "${oneLine(dialog.title, LOG_TEXT_MAX)}": ${choice} (sent to the fleet)`);
		tellFleet(`The human answered ${name}'s escalated question ${dialog.id} ("${oneLine(dialog.title, LOG_TEXT_MAX)}"): ${choice}. Answer the member with fleet_answer.`);
		return undefined;
	};

	const deckSnapshot = () => buildFleetSnapshot({
		ledger: ensureLedger(ctxRef?.cwd ?? process.cwd()).current,
		live: name => members.get(name),
		arrivedAt: dialog => dialogArrivals.get(dialog as FleetMemberDialog),
		budgets: { fleetUsd: config.fleetBudgetUsd, memberUsd: config.memberBudgetUsd },
		controller: ctxRef ? controllerUsage(ctxRef) : undefined,
		permission,
		resume: pendingResume,
	});

	const refreshPermission = async (ctx: ExtensionContext) => {
		const mounted = deck;
		let mode: PermissionMode = "normal";
		try { mode = await readPermissionMode(ctx); } catch { /* unreadable mode shows as normal */ }
		// A remounted deck (new session) reads its own mode.
		if (!mounted || deck !== mounted || mode === permission) return;
		permission = mode;
		mounted.invalidate();
	};

	// The deck needs Pi's terminal UI; rpc and print keep the digest widget.
	const mountDeck = (ctx: ExtensionContext) => {
		unmountDeck?.();
		unmountDeck = undefined;
		stopObservingMode?.();
		stopObservingMode = undefined;
		permission = "normal";
		deck = undefined;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		deck = new FleetDeck({
			snapshot: deckSnapshot,
			answer: answerFocal,
			relayDialog: () => activeRelay && (activeRelay.dialog.method === "select" || activeRelay.dialog.method === "confirm") ? activeRelay.focus : undefined,
		});
		unmountDeck = deck.mount(ctx.ui);
		void refreshPermission(ctx);
		// /gentle:mode changes repaint the status line; tests inject the mode instead.
		if (!deps.permissionMode) void discoverYoloUiAdapter(pi, ctx).then(adapter => {
			if (!adapter) return;
			if (ctxRef !== ctx || !deck) { adapter.dispose(); return; }
			stopObservingMode?.();
			const stop = adapter.observe(() => void refreshPermission(ctx));
			stopObservingMode = () => { stop(); adapter.dispose(); };
		}).catch(() => {});
	};

	const flushWake = () => {
		cancelWake = undefined;
		if (pending.size === 0) return;
		const lines = ["Fleet update (code-built digest):"];
		for (const [name, events] of pending) {
			const member = members.get(name);
			if (!member) continue;
			lines.push(`- ${member.digest()}`);
			for (const event of events) {
				if (event.kind === "dialog") lines.push(dialogDigestLine(event.dialog));
				if (event.kind === "exit") lines.push(`  exited (code ${event.code ?? "none"}${event.signal ? `, ${event.signal}` : ""})`);
			}
		}
		for (const warning of pendingBudget.splice(0)) lines.push(`budget: ${warning}`);
		pending.clear();
		pi.sendMessage({ customType: FLEET_DIGEST_MESSAGE_TYPE, content: lines.join("\n"), display: true, details: { gentleFleet: { members: [...members.keys()] } } }, { deliverAs: "followUp", triggerTurn: true });
	};

	const onMemberEvent = (member: FleetMember, event: FleetMemberEvent) => {
		// A member from a previous session is forgotten and wakes nothing.
		if (!isCurrent(member)) return;
		track(member);
		if (event.kind === "settled") ledger?.log("settle", member.name, member.digest());
		if (event.kind === "dialog") {
			dialogArrivals.set(event.dialog, (deps.now?.() ?? new Date()).toISOString());
			ledger?.log("question", member.name, questionLine(event.dialog));
		}
		if (event.kind === "exit") ledger?.exited(member.name, event.code, event.signal);
		if (closed) return;
		pending.set(member.name, [...(pending.get(member.name) ?? []), event]);
		cancelWake ??= deps.schedule(flushWake, FLEET_WAKE_WINDOW_MS);
		if (event.kind === "dialog" && event.dialog.protected) void handleProtected(member, event.dialog).catch(() => {});
	};

	const liveCount = () => [...members.values()].filter(member => member.live).length;

	const startMember = (name: string, objective: string, launch: ReturnType<typeof buildMemberLaunch>, extra: { worktree?: { path: string; branch: string }; usage?: { totalTokens: number; cost: number; newTokens?: number; cacheRead?: number } } = {}) => {
		const member = new FleetMember({
			name,
			objective,
			launch,
			...extra,
			spawn: deps.spawn,
			schedule: deps.schedule,
			process: deps.process,
			onEvent: onMemberEvent,
			onChange: changed => {
				refreshWidget();
				track(changed);
			},
		});
		members.set(name, member);
		return member;
	};

	// The human's [1] on the resume question: each member reattaches to its own
	// worktree and session file, within the member limit and the fleet budget.
	// A missing worktree or session file is a blocker; nothing is created.
	const resumeMembers = () => {
		const fleetLedger = ledger;
		if (!fleetLedger) return;
		config = readFleetConfig(configHome);
		const resumed: string[] = [];
		const refused: string[] = [];
		for (const name of pendingResume.splice(0)) {
			const record = fleetLedger.current.members.find(member => member.name === name);
			if (!record || members.get(name)?.live) continue;
			const sessionDir = sessionPath(name);
			const sessionFile = latestMemberSessionFile(sessionDir);
			const spent = fleetSpend();
			const reason = (record.worktree ? reattachMemberWorktree({ path: record.worktree, git: deps.git }) : undefined)
				?? (!existsSync(record.cwd) ? `working directory ${record.cwd} is missing`
				: !sessionFile ? `no session file in ${sessionDir}`
				: liveCount() >= config.maxLiveMembers ? `the fleet runs at most ${config.maxLiveMembers} live members (maxLiveMembers in ${config.path})`
				: config.fleetBudgetUsd !== undefined && spent >= config.fleetBudgetUsd ? `the fleet spent $${spent.toFixed(2)} of its $${config.fleetBudgetUsd.toFixed(2)} budget`
				: undefined);
			if (reason || !sessionFile) {
				fleetLedger.notResumed(name, `not resumed: ${reason}`);
				refused.push(`${name} (${reason})`);
				continue;
			}
			const member = startMember(name, record.objective, buildMemberLaunch({ env, cwd: record.cwd, sessionDir, sessionFile, pi: deps.pi }), {
				...(record.worktree && record.branch ? { worktree: { path: record.worktree, branch: record.branch } } : {}),
				// A ledger from before T8 kept only the cache-inclusive total (same fallback as the document).
				usage: { totalTokens: record.tokens, cost: record.cost, newTokens: record.newTokens ?? record.tokens, cacheRead: record.cacheRead ?? 0 },
			});
			memberThresholds.set(member, warnedThresholds(name, record.spawnedAt));
			fleetLedger.resumed(name);
			member.start();
			track(member);
			resumed.push(name);
		}
		refreshWidget();
		if (resumed.length === 0 && refused.length === 0) return;
		const lines = ["Fleet resumed (code-built):"];
		if (resumed.length > 0) lines.push(`- resumed ${resumed.join(", ")}: each continues its own session and waits; send it work with fleet_send.`);
		if (refused.length > 0) lines.push(`- not resumed: ${refused.join("; ")}.`);
		pi.sendMessage({ customType: FLEET_DIGEST_MESSAGE_TYPE, content: lines.join("\n"), display: true, details: { gentleFleet: { resumed, members: [...members.keys()] } } }, { deliverAs: "followUp", triggerTurn: true });
	};

	// The human's [2]: the members stay stopped and the ledger says so.
	const keepStopped = () => {
		for (const name of pendingResume.splice(0)) ledger?.notResumed(name);
		refreshWidget();
	};
	const memberOrError = (name: unknown) => {
		const member = typeof name === "string" ? members.get(name) : undefined;
		return member ?? `No fleet member named "${String(name)}". Members: ${[...members.keys()].join(", ") || "none"}.`;
	};

	const stopAll = () => {
		cancelWake?.();
		cancelWake = undefined;
		pending.clear();
		// A reopened fleet asks before resuming these; members stopped on purpose stay stopped.
		ledger?.interrupt([...members.values()].filter(member => member.live && !member.stopping).map(member => member.name));
		for (const member of members.values()) member.stop();
		ledger?.flush();
	};

	pi.on("session_start", (_event, ctx) => {
		// A new session (new, resume, fork) starts its own fleet: the previous
		// session's members are stopped and forgotten so they cannot wake it.
		// A session with a saved ledger is that fleet reopened.
		stopAll();
		members.clear();
		ledger = undefined;
		pendingResume = [];
		reportedWriteError = false;
		fleetThresholds.clear();
		pendingBudget.length = 0;
		ctxRef = ctx;
		config = readFleetConfig(configHome);
		if (config.ignored.length > 0) ctx.ui.notify(`Gentle Fleet ignored invalid values in ${config.path} and uses the defaults for: ${config.ignored.join(", ")}.`, "warning");
		closed = false;
		fleetSessionId = ctx.sessionManager.getSessionId() || fleetSessionId;
		const fleetLedger = ensureLedger(ctx.cwd);
		for (const threshold of warnedThresholds(null)) fleetThresholds.add(threshold);
		// Live when the controller stopped: interrupted on purpose, or still live after a crash.
		const { members: saved, interrupted } = fleetLedger.current;
		pendingResume = saved.filter(member => interrupted.includes(member.name) || member.status !== "exited").map(member => member.name);
		if (pendingResume.length > 0) fleetLedger.awaitResume(pendingResume);
		restrictTools();
		mountDeck(ctx);
		refreshWidget();
	});

	// Tools registered or activated after session start (late extensions, MCP)
	// are dropped again before the next request; an unchanged set is left alone.
	// The launch passes --no-skills, but Pi still lists the skills of the
	// gentle-pi package the launcher loads with -e (docs/cli.md: explicit paths
	// still load); the controller never uses them (L35).
	pi.on("before_agent_start", event => {
		restrictTools();
		const options = (event as { systemPromptOptions?: { skills?: unknown[] } } | undefined)?.systemPromptOptions;
		if (options && Array.isArray(options.skills) && options.skills.length > 0) options.skills = [];
	});

	// The controller's own spend shows in the Costs lens.
	pi.on("turn_end", (_event, ctx) => {
		deck?.invalidate();
		if (deck && ctx) void refreshPermission(ctx);
	});

	pi.on("session_shutdown", () => {
		closed = true;
		stopAll();
		unmountDeck?.();
		unmountDeck = undefined;
		stopObservingMode?.();
		stopObservingMode = undefined;
		deck = undefined;
	});

	pi.registerTool({
		name: "fleet_objective",
		label: "Fleet objective",
		description: "Name the fleet and state its objective. Call it first. Returns the path of the fleet document, which code keeps current.",
		parameters: Type.Object({
			title: Type.String({ description: "Short fleet title; it names the fleet document." }),
			objective: Type.String({ description: "The fleet objective with scope and acceptance criteria." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const { title, objective } = params as { title: string; objective: string };
			if (!title?.trim() || !objective?.trim()) return text("Error: title and objective are required.", { error: "missing objective" });
			const fleetLedger = ensureLedger(ctx.cwd);
			const documentPath = fleetLedger.setObjective(title, objective);
			fleetLedger.flush();
			return text(`Fleet objective set. Fleet document: ${documentPath}`, { documentPath });
		},
	});

	pi.registerTool({
		name: "fleet_spawn",
		label: "Fleet spawn",
		description: `Start a new full Gentle Shell member session for one long, independent front and send it its objective. Always pass the member's own project directory as cwd (create: true for a new project). Costs a full session prefix (~124k tokens); prefer fleet_send to an existing member. At most ${config.maxLiveMembers} live members (maxLiveMembers in the human's fleet.json). Refused once the fleet budget is spent.`,
		parameters: Type.Object({
			name: Type.String({ description: "Short member name: lowercase letters, digits and dashes." }),
			objective: Type.String({ description: "The member's objective with scope, acceptance criteria and non-goals." }),
			cwd: Type.String({ description: "The member's own project directory: absolute, or relative to this session's cwd. The member works there, never in this session's directory." }),
			create: Type.Optional(Type.Boolean({ description: "true for a new project: when cwd does not exist, create it (mkdir -p only, no git init) and run the member there." })),
			model: Type.Optional(Type.String({ description: "Optional provider/model for the member." })),
			worktree: Type.Optional(Type.Boolean({ description: "Inside a git repository the member works in its own new worktree on branch fleet/<fleet>/<member> by default; false runs it in the cwd." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const { name, objective, cwd, create, model, worktree } = params as { name: string; objective: string; cwd?: string; create?: boolean; model?: string; worktree?: boolean };
			if (!NAME_PATTERN.test(name)) return text(`Error: member name "${name}" must match ${NAME_PATTERN.source}.`, { error: "invalid name" });
			if (!objective?.trim()) return text("Error: objective is required.", { error: "missing objective" });
			// The member reads its objective as its first prompt: a leading "/" would run as a command.
			if (/^\s*\//.test(objective)) return text("Error: fleet_spawn sends instructions, not slash commands.", { error: "slash command" });
			// T8 (L54): a member without its own directory ran in the controller's repository.
			if (typeof cwd !== "string" || !cwd.trim()) return text("Error: cwd is required: pass the member's own project directory (create: true for a new project).", { error: "missing cwd" });
			if (members.get(name)?.live) return text(`Error: member "${name}" is already live; use fleet_send.`, { error: "duplicate" });
			config = readFleetConfig(configHome);
			if (liveCount() >= config.maxLiveMembers) return text(`Error: the fleet runs at most ${config.maxLiveMembers} live members (maxLiveMembers in ${config.path}). Send the work to an existing member or stop one first.`, { error: "cap" });
			const spent = fleetSpend();
			if (config.fleetBudgetUsd !== undefined && spent >= config.fleetBudgetUsd) {
				return text(`Error: the fleet spent $${spent.toFixed(2)} of its $${config.fleetBudgetUsd.toFixed(2)} budget (fleetBudgetUsd in ${config.path}). Existing members keep working: send them work with fleet_send, or ask the human to raise the budget.`, { error: "fleet budget" });
			}
			const requestedCwd = isAbsolute(cwd) ? cwd : resolve(ctx.cwd, cwd);
			const exists = existsSync(requestedCwd);
			if (exists && !statSync(requestedCwd).isDirectory()) return text(`Error: ${requestedCwd} is not a directory.`, { error: "cwd" });
			if (!exists && create !== true) return text(`Error: ${requestedCwd} does not exist. Pass the member's existing project directory as cwd, or create: true to start a new project there.`, { error: "missing directory" });
			const fleetLedger = ensureLedger(ctx.cwd);
			// Refusals happen before any side effect; a created directory or worktree is never removed.
			if (!exists) {
				try { mkdirSync(requestedCwd, { recursive: true }); }
				catch (error) { return text(`Error: could not create ${requestedCwd}: ${error instanceof Error ? error.message : String(error)}`, { error: "cwd" }); }
			}
			const prepared = worktree === false ? undefined : createMemberWorktree({ cwd: requestedCwd, fleetSlug: fleetLedger.slug, member: name, git: deps.git });
			if (prepared?.kind === "refused") return text(`Error: could not give member "${name}" its own worktree: ${prepared.message}`, { error: "worktree" });
			const created = prepared?.kind === "created" ? prepared.worktree : undefined;
			const memberWorktree = created ? { path: created.path, branch: created.branch } : undefined;
			const memberCwd = created?.cwd ?? requestedCwd;
			const sessionDir = join(agentHome, "gentle-fleet", "sessions", fleetSessionId, name);
			try { mkdirSync(sessionDir, { recursive: true }); }
			catch (error) { return text(`Error: could not create ${sessionDir}: ${error instanceof Error ? error.message : String(error)}`, { error: "session dir" }); }
			// A respawned name, or one still waiting on the resume question, keeps its spend in the fleet's.
			fleetLedger.retire(fleetLedger.current.members.find(record => record.name === name)?.cost ?? 0);
			if (pendingResume.includes(name)) {
				pendingResume = pendingResume.filter(entry => entry !== name);
				fleetLedger.settleResume(name);
			}
			const member = startMember(name, objective, buildMemberLaunch({ env, cwd: memberCwd, sessionDir, model, pi: deps.pi }), memberWorktree ? { worktree: memberWorktree } : {});
			fleetLedger.spawned(name, objective, memberCwd, memberWorktree);
			member.start();
			member.prompt(objective);
			track(member);
			refreshWidget();
			const where = created ? `${memberCwd} on new branch ${created.branch} (worktree of ${created.repo})` : exists ? memberCwd : `${memberCwd} (new project directory)`;
			return text(`Spawned fleet member "${name}" in ${where}. Its digest arrives when it settles, asks a question or exits.`, { name, cwd: memberCwd, ...(memberWorktree ? { worktree: memberWorktree.path, branch: memberWorktree.branch } : {}) });
		},
	});

	pi.registerTool({
		name: "fleet_send",
		label: "Fleet send",
		description: "Send an instruction to a live member; never a slash command. mode prompt (default) queues a new request; mode steer redirects the current run.",
		parameters: Type.Object({
			name: Type.String({ description: "Member name." }),
			message: Type.String({ description: "The instruction for the member." }),
			mode: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("steer")])),
		}),
		async execute(_id, params) {
			const { name, message, mode } = params as { name: string; message: string; mode?: "prompt" | "steer" };
			// A member slash command could change its settings without any dialog (L37 A5).
			if (/^\s*\//.test(message ?? "")) return text("Error: fleet_send sends instructions, not slash commands.", { error: "slash command" });
			const member = memberOrError(name);
			if (typeof member === "string") return text(`Error: ${member}`, { error: "unknown member" });
			if (!member.live) return text(`Error: member "${name}" has exited.`, { error: "exited" });
			const sent = mode === "steer" ? member.steer(message) : member.prompt(message);
			if (!sent) return text(`Error: member "${name}" is stopping and takes no new messages.`, { error: "stopping" });
			ledger?.log("send", name, `${mode ?? "prompt"}: ${oneLine(message, LOG_TEXT_MAX)}`);
			return text(`Sent to "${name}" (${mode ?? "prompt"}).`, { name });
		},
	});

	pi.registerTool({
		name: "fleet_status",
		label: "Fleet status",
		description: "One digest line per member. Pass a name only when you need that member's bounded detail.",
		parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Member name for detail." })) }),
		async execute(_id, params) {
			const { name } = params as { name?: string };
			if (name !== undefined) {
				const member = memberOrError(name);
				return typeof member === "string" ? text(`Error: ${member}`, { error: "unknown member" }) : text(member.detail(), { name });
			}
			const lines = members.size === 0 ? ["No fleet members."] : [...members.values()].map(member => member.digest());
			const grants = ledger?.grants ?? [];
			if (grants.length > 0) lines.push(`Standing permissions: ${grants.map(grant => `${grant.id} ${grant.scope} — ${oneLine(grant.description, 80)}`).join("; ")}`);
			return text(lines.join("\n"));
		},
	});

	pi.registerTool({
		name: "fleet_stop",
		label: "Fleet stop",
		description: "Stop a member session (its session file is kept).",
		parameters: Type.Object({ name: Type.String({ description: "Member name." }) }),
		async execute(_id, params) {
			const { name } = params as { name: string };
			const member = memberOrError(name);
			if (typeof member === "string") return text(`Error: ${member}`, { error: "unknown member" });
			if (member.live && !member.stopping) ledger?.log("stop", name, "stop requested");
			member.stop();
			return text(`Stopping "${name}".`, { name });
		},
	});

	pi.registerTool({
		name: "fleet_inspect",
		label: "Fleet inspect",
		description: `A member's bounded detail plus its recent activity (tools, replies, questions) and its ODD feature document path. No transcript. lines defaults to ${FLEET_INSPECT_LINES}, at most ${INSPECT_LINES_MAX}.`,
		parameters: Type.Object({
			name: Type.String({ description: "Member name." }),
			lines: Type.Optional(Type.Integer({ minimum: 1, maximum: INSPECT_LINES_MAX, description: "Activity lines to return." })),
		}),
		async execute(_id, params) {
			const { name, lines } = params as { name: string; lines?: number };
			const member = memberOrError(name);
			if (typeof member === "string") return text(`Error: ${member}`, { error: "unknown member" });
			const count = Math.min(INSPECT_LINES_MAX, Math.max(1, Math.floor(lines ?? FLEET_INSPECT_LINES)));
			return text(member.inspect(count), { name, ...(member.featureDoc ? { featureDoc: member.featureDoc } : {}) });
		},
	});
	pi.registerTool({
		name: "fleet_answer",
		label: "Fleet answer",
		description: "Answer a member's pending question on the human's behalf (default: its oldest). select: an offered option or its number; confirm: yes or no; input/editor: the text; cancel: true dismisses it; escalate: true brings it to the human instead, whose answer arrives as a user message. Protected questions are relayed to the human by code and refused here.",
		parameters: Type.Object({
			name: Type.String({ description: "Member name." }),
			answer: Type.Optional(Type.String({ description: "The answer." })),
			dialog: Type.Optional(Type.String({ description: "Question id from the digest; defaults to the oldest pending one." })),
			cancel: Type.Optional(Type.Boolean({ description: "Dismiss the question instead of answering it." })),
			escalate: Type.Optional(Type.Boolean({ description: "Bring the question to the human: it is outside your authority." })),
		}),
		async execute(_id, params) {
			const { name, answer, dialog, cancel, escalate } = params as { name: string; answer?: string; dialog?: string; cancel?: boolean; escalate?: boolean };
			const member = memberOrError(name);
			if (typeof member === "string") return text(`Error: ${member}`, { error: "unknown member" });
			if (escalate === true) {
				// The deck is where the human answers it; rpc and print have none.
				if (!deck) return text("Error: the human has no fleet deck in this mode; ask them with ask_user_question or ask_user_choice.", { error: "no deck" });
				const pending = dialog === undefined ? member.dialogs[0] : member.dialogs.find(entry => entry.id === dialog);
				if (!pending) return text(`Error: no pending dialog${dialog === undefined ? "" : ` "${dialog}"`} for ${name}.`, { error: "answer refused" });
				const title = oneLine(pending.title, LOG_TEXT_MAX);
				if (pending.protected) return text(`Error: dialog ${pending.id} ("${title}") is relayed to the human by code already.`, { error: "answer refused" });
				if (ledger?.current.escalations.some(entry => entry.member === name && entry.dialogId === pending.id)) return text(`Error: ${name}'s question ${pending.id} is already with the human.`, { error: "answer refused" });
				ensureLedger(ctxRef?.cwd ?? process.cwd()).escalate(name, { dialogId: pending.id, method: pending.method, title: pending.title, ...(pending.message ? { message: pending.message } : {}), ...(pending.options ? { options: pending.options } : {}) });
				return text(`Brought ${name}'s ${pending.method} "${title}" to the human; their answer arrives as a user message. Then answer it with fleet_answer.`, { name, dialog: pending.id });
			}
			if (cancel !== true && typeof answer !== "string") return text("Error: give an answer or cancel: true.", { error: "missing answer" });
			const result = member.answer(cancel === true ? { cancel: true } : { answer: answer! }, dialog);
			if ("error" in result) return text(`Error: ${result.error}`, { error: "answer refused" });
			const shown = describeResponse(result.response);
			const title = oneLine(result.dialog.title, LOG_TEXT_MAX);
			ledger?.log("answer", name, `fleet answered "${title}": ${shown}`);
			track(member);
			return text(`Answered ${name}'s ${result.dialog.method} "${title}" with ${"cancelled" in result.response ? "cancel" : `"${shown}"`}.`, { name, dialog: result.dialog.id });
		},
	});

	pi.registerTool({
		name: "fleet_grant",
		label: "Fleet grant",
		description: "Record a standing permission the human explicitly asked for (e.g. publishing scheduled posts) in the fleet document. The human confirms it in this session's UI. Grants never cover consent, credential, security or destructive prompts.",
		parameters: Type.Object({
			scope: Type.String({ description: "Short scope key, e.g. publish:social." }),
			description: Type.String({ description: "What the fleet may do without asking, in the human's terms." }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const { scope, description } = params as { scope: string; description: string };
			if (!scope?.trim() || !description?.trim()) return text("Error: scope and description are required.", { error: "missing grant" });
			if (!canAskHuman(ctx)) return text("Error: fleet_grant needs the human's confirmation in an interactive fleet UI; nothing was recorded.", { error: "no ui" });
			const confirmed = await ctx.ui.confirm(`Grant the fleet a standing permission for ${oneLine(scope, LOG_TEXT_MAX)}?`, `${description.trim()}\n\nThe fleet will act within this scope without asking you. Grants never cover consent, credential, security-permission or destructive prompts: those always reach you.`);
			if (confirmed !== true) return text("The human declined; nothing was recorded.", { error: "declined" });
			const fleetLedger = ensureLedger(ctx.cwd);
			const grant = fleetLedger.grant(scope, description);
			fleetLedger.flush();
			return text(`Recorded standing permission ${grant.id} for ${grant.scope}. Fleet document: ${fleetLedger.documentPath}`, { grant: grant.id });
		},
	});

	pi.registerTool({
		name: "fleet_revoke",
		label: "Fleet revoke",
		description: "Remove a standing permission by id after the human confirms it in this session's UI.",
		parameters: Type.Object({ id: Type.String({ description: "Grant id, e.g. g1." }) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const { id } = params as { id: string };
			const grant = ledger?.grants.find(entry => entry.id === id);
			if (!grant) return text(`Error: no standing permission ${id}. Grants: ${ledger?.grants.map(entry => entry.id).join(", ") || "none"}.`, { error: "unknown grant" });
			if (!canAskHuman(ctx)) return text("Error: fleet_revoke needs the human's confirmation in an interactive fleet UI; the grant stays.", { error: "no ui" });
			const confirmed = await ctx.ui.confirm(`Revoke standing permission ${grant.id}?`, `${grant.scope} — ${grant.description}`);
			if (confirmed !== true) return text("The human declined; the grant stays.", { error: "declined" });
			ledger!.revoke(grant.id);
			ledger!.flush();
			return text(`Revoked standing permission ${grant.id} (${grant.scope}).`, { grant: grant.id });
		},
	});
}
