import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveAgentHomeDirectory } from "../lib/agent-model-resolution.ts";
import type { PiCommand, ProcessControl, Spawn } from "../lib/agents-runner.ts";
import { buildMemberLaunch, FleetMember, type FleetMemberEvent } from "../lib/fleet-member.ts";
import { fleetRole } from "../lib/fleet-role.ts";

// Gentle Fleet controller (odd/tasks/fleet-orchestrator.md, F0). Active only
// in the session `gentle-shell orchestrator` starts: it spawns full headless
// Gentle Shell members, tracks them in code, and wakes the controller model
// with one coalesced digest when a member settles, asks or exits.

export const FLEET_MEMBER_CAP = 3;
export const FLEET_DIGEST_MESSAGE_TYPE = "gentle-fleet.digest";
export const FLEET_WAKE_WINDOW_MS = 1500;
const WIDGET_KEY = "gentle-fleet";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface FleetDeps {
	spawn: Spawn;
	schedule(fn: () => void, ms: number): () => void;
	pi?: PiCommand;
	home: string;
	agentHome?: string;
	process?: ProcessControl;
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
		if (closed || members.get(member.name) !== member) return;
		pending.set(member.name, [...(pending.get(member.name) ?? []), event]);
		cancelWake ??= deps.schedule(flushWake, FLEET_WAKE_WINDOW_MS);
	};

	const liveCount = () => [...members.values()].filter(member => member.live).length;
	const memberOrError = (name: unknown) => {
		const member = typeof name === "string" ? members.get(name) : undefined;
		return member ?? `No fleet member named "${String(name)}". Members: ${[...members.keys()].join(", ") || "none"}.`;
	};

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		closed = false;
		fleetSessionId = ctx.sessionManager.getSessionId() || fleetSessionId;
		refreshWidget();
	});

	pi.on("session_shutdown", () => {
		closed = true;
		cancelWake?.();
		cancelWake = undefined;
		pending.clear();
		for (const member of members.values()) member.stop();
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
				onChange: refreshWidget,
			});
			members.set(name, member);
			member.start();
			member.prompt(objective);
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
			member.stop();
			return text(`Stopping "${name}".`, { name });
		},
	});
}
