import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveAgentHomeDirectory } from "../lib/agent-model-resolution.ts";
import type { PiCommand, ProcessControl, Spawn } from "../lib/agents-runner.ts";
import { FleetLedger, type FleetMemberFields } from "../lib/fleet-ledger.ts";
import { buildMemberLaunch, FleetMember, type FleetMemberEvent } from "../lib/fleet-member.ts";
import { fleetRole } from "../lib/fleet-role.ts";

// Gentle Fleet controller (odd/tasks/fleet-orchestrator.md, F0-F1). Active only
// in the session `gentle-shell orchestrator` starts: it spawns full headless
// Gentle Shell members, tracks them in code, keeps the fleet ledger and its
// general document current by code, and wakes the controller model with one
// coalesced digest when a member settles, asks or exits.

export const FLEET_MEMBER_CAP = 3;
export const FLEET_DIGEST_MESSAGE_TYPE = "gentle-fleet.digest";
export const FLEET_WAKE_WINDOW_MS = 1500;
const WIDGET_KEY = "gentle-fleet";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const FLEET_INSPECT_LINES = 40;
const INSPECT_LINES_MAX = 200;
const LOG_TEXT_MAX = 120;

// Live E2E (L8): the controller prefix is mostly tool schemas, and peer/session
// tools invited needless calls. The controller only coordinates, reads and
// remembers; members and normal sessions keep every tool.
const CONTROLLER_TOOLS = new Set(["read", "grep", "find", "ls", "ask_user_question", "ask_user_choice"]);

export function isControllerTool(name: string): boolean {
	return name.startsWith("fleet_") || name.startsWith("mem_") || CONTROLLER_TOOLS.has(name);
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
}

const defaultDeps = (): FleetDeps => ({
	spawn: (command, args, options) => spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: options.detached }),
	schedule: (fn, ms) => {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
	home: os.homedir(),
});

function text(value: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: value }], details: { gentleFleet: details } };
}

function oneLine(value: string, max: number): string {
	const line = value.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function questionLine(dialog: { title: string; options?: string[] }): string {
	return `${dialog.title}${dialog.options?.length ? ` [${dialog.options.join(" | ")}]` : ""}`;
}

function ledgerFields(member: FleetMember): FleetMemberFields {
	return {
		status: member.status,
		todo: member.todo ?? null,
		tokens: member.usage.totalTokens,
		cost: member.usage.cost,
		question: member.dialogs[0] ? questionLine(member.dialogs[0]) : null,
		lastError: member.lastError ?? null,
	};
}

export default function gentleFleet(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env, overrides: Partial<FleetDeps> = {}): void {
	if (fleetRole(env) !== "controller") return;
	const deps: FleetDeps = { ...defaultDeps(), ...overrides };
	const agentHome = resolveAgentHomeDirectory({ env, home: deps.home, agentHome: overrides.agentHome, homeOverridden: overrides.home !== undefined });
	const members = new Map<string, FleetMember>();
	let ctxRef: ExtensionContext | undefined;
	let fleetSessionId = "unknown";
	const pending = new Map<string, FleetMemberEvent[]>();
	let cancelWake: (() => void) | undefined;
	let closed = false;
	let ledger: FleetLedger | undefined;
	let reportedWriteError = false;

	const ensureLedger = (cwd: string) => ledger ??= new FleetLedger({
		fleetSessionId,
		cwd,
		ledgerPath: join(agentHome, "gentle-fleet", "sessions", fleetSessionId, "ledger.json"),
		schedule: deps.schedule,
		now: deps.now,
		write: deps.writeFile,
		onError: error => {
			if (reportedWriteError) return;
			reportedWriteError = true;
			ctxRef?.ui.notify(`Gentle Fleet could not write its ledger or fleet document: ${error instanceof Error ? error.message : String(error)}`, "warning");
		},
	});

	const isCurrent = (member: FleetMember) => members.get(member.name) === member;
	const track = (member: FleetMember) => {
		if (isCurrent(member)) ledger?.update(member.name, ledgerFields(member));
	};

	const restrictTools = () => {
		const allowed = pi.getAllTools().filter(tool => tool.exposure !== "hidden" && isControllerTool(tool.name)).map(tool => tool.name);
		const active = pi.getActiveTools();
		if (active.length === allowed.length && active.every(name => allowed.includes(name))) return;
		pi.setActiveTools(allowed);
	};

	const refreshWidget = () => {
		const ui = ctxRef?.hasUI ? ctxRef.ui : undefined;
		if (!ui) return;
		ui.setWidget(WIDGET_KEY, members.size === 0 ? undefined : [...members.values()].map(member => member.digest()));
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
				if (event.kind === "dialog") lines.push(`  question for the human (${event.dialog.method}): ${event.dialog.title}${event.dialog.message ? ` — ${event.dialog.message}` : ""}${event.dialog.options?.length ? ` [${event.dialog.options.join(" | ")}]` : ""}`);
				if (event.kind === "exit") lines.push(`  exited (code ${event.code ?? "none"}${event.signal ? `, ${event.signal}` : ""})`);
			}
		}
		pending.clear();
		pi.sendMessage({ customType: FLEET_DIGEST_MESSAGE_TYPE, content: lines.join("\n"), display: true, details: { gentleFleet: { members: [...members.keys()] } } }, { deliverAs: "followUp", triggerTurn: true });
	};

	const onMemberEvent = (member: FleetMember, event: FleetMemberEvent) => {
		// A member from a previous session is forgotten and wakes nothing.
		if (!isCurrent(member)) return;
		track(member);
		if (event.kind === "settled") ledger?.log("settle", member.name, member.digest());
		if (event.kind === "dialog") ledger?.log("question", member.name, questionLine(event.dialog));
		if (event.kind === "exit") ledger?.exited(member.name, event.code, event.signal);
		if (closed) return;
		pending.set(member.name, [...(pending.get(member.name) ?? []), event]);
		cancelWake ??= deps.schedule(flushWake, FLEET_WAKE_WINDOW_MS);
	};

	const liveCount = () => [...members.values()].filter(member => member.live).length;
	const memberOrError = (name: unknown) => {
		const member = typeof name === "string" ? members.get(name) : undefined;
		return member ?? `No fleet member named "${String(name)}". Members: ${[...members.keys()].join(", ") || "none"}.`;
	};

	const stopAll = () => {
		cancelWake?.();
		cancelWake = undefined;
		pending.clear();
		for (const member of members.values()) member.stop();
		ledger?.flush();
	};

	pi.on("session_start", (_event, ctx) => {
		// A new session (new, resume, fork) starts its own fleet: the previous
		// session's members are stopped and forgotten so they cannot wake it.
		stopAll();
		members.clear();
		ledger = undefined;
		reportedWriteError = false;
		ctxRef = ctx;
		closed = false;
		fleetSessionId = ctx.sessionManager.getSessionId() || fleetSessionId;
		ensureLedger(ctx.cwd);
		restrictTools();
		refreshWidget();
	});

	// Tools registered or activated after session start (late extensions, MCP)
	// are dropped again before the next request; an unchanged set is left alone.
	pi.on("before_agent_start", () => {
		restrictTools();
	});

	pi.on("session_shutdown", () => {
		closed = true;
		stopAll();
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
		description: `Start a new full Gentle Shell member session for one long, independent front and send it its objective. Costs a full session prefix (~124k tokens); prefer fleet_send to an existing member. At most ${FLEET_MEMBER_CAP} live members.`,
		parameters: Type.Object({
			name: Type.String({ description: "Short member name: lowercase letters, digits and dashes." }),
			objective: Type.String({ description: "The member's objective with scope, acceptance criteria and non-goals." }),
			cwd: Type.Optional(Type.String({ description: "Working directory; defaults to this session's cwd." })),
			model: Type.Optional(Type.String({ description: "Optional provider/model for the member." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			const { name, objective, cwd, model } = params as { name: string; objective: string; cwd?: string; model?: string };
			if (!NAME_PATTERN.test(name)) return text(`Error: member name "${name}" must match ${NAME_PATTERN.source}.`, { error: "invalid name" });
			if (!objective?.trim()) return text("Error: objective is required.", { error: "missing objective" });
			if (members.get(name)?.live) return text(`Error: member "${name}" is already live; use fleet_send.`, { error: "duplicate" });
			if (liveCount() >= FLEET_MEMBER_CAP) return text(`Error: the fleet runs at most ${FLEET_MEMBER_CAP} live members. Send the work to an existing member or stop one first.`, { error: "cap" });
			const memberCwd = cwd ? (isAbsolute(cwd) ? cwd : resolve(ctx.cwd, cwd)) : ctx.cwd;
			const sessionDir = join(agentHome, "gentle-fleet", "sessions", fleetSessionId, name);
			try { mkdirSync(sessionDir, { recursive: true }); }
			catch (error) { return text(`Error: could not create ${sessionDir}: ${error instanceof Error ? error.message : String(error)}`, { error: "session dir" }); }
			const member = new FleetMember({
				name,
				objective,
				launch: buildMemberLaunch({ env, cwd: memberCwd, sessionDir, model, pi: deps.pi }),
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
			ensureLedger(ctx.cwd).spawned(name, objective, memberCwd);
			member.start();
			member.prompt(objective);
			track(member);
			refreshWidget();
			return text(`Spawned fleet member "${name}" in ${memberCwd}. Its digest arrives when it settles, asks a question or exits.`, { name, cwd: memberCwd });
		},
	});

	pi.registerTool({
		name: "fleet_send",
		label: "Fleet send",
		description: "Send work to a live member. mode prompt (default) queues a new request; mode steer redirects the current run.",
		parameters: Type.Object({
			name: Type.String({ description: "Member name." }),
			message: Type.String({ description: "The instruction for the member." }),
			mode: Type.Optional(Type.Union([Type.Literal("prompt"), Type.Literal("steer")])),
		}),
		async execute(_id, params) {
			const { name, message, mode } = params as { name: string; message: string; mode?: "prompt" | "steer" };
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
			return text(members.size === 0 ? "No fleet members." : [...members.values()].map(member => member.digest()).join("\n"));
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
}
