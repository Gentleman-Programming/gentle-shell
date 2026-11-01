import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHerdrAgentExtension } from "../extensions/gentle-herdr-agent.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Request = { id: string; method: string; params: Record<string, unknown> };

function harness(overrides: NodeJS.ProcessEnv = {}) {
	const handlers = new Map<string, Handler>();
	const events = new Map<string, (data: any) => void>();
	const requests: Request[] = [];
	let idle = true;
	createHerdrAgentExtension({
		env: {
			HERDR_ENV: "1", HERDR_PANE_ID: "pane-1", HERDR_SOCKET_PATH: "/herdr.sock",
			GENTLE_SHELL_HERDR_REPORTER: "1", ...overrides,
		},
		send: async (request) => { requests.push(request as Request); },
	})({
		on: (name: string, fn: Handler) => handlers.set(name, fn),
		events: { on: (name: string, fn: (data: any) => void) => { events.set(name, fn); return () => events.delete(name); } },
	} as unknown as ExtensionAPI);
	const ctx = (mode = "tui") => ({
		mode, isIdle: () => idle,
		sessionManager: { getSessionFile: () => "/sessions/root.jsonl", getSessionId: () => "root" },
	}) as unknown as ExtensionContext;
	return {
		requests, handlers, events,
		setIdle: (value: boolean) => { idle = value; },
		fire: async (name: string, event: unknown = {}, context = ctx()) => { await handlers.get(name)?.(event, context); },
		emit: (name: string, data: unknown) => events.get(name)?.(data),
		ctx,
	};
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const summary = (requests: Request[]) => requests.map(({ method, params }) => [method, params.source, params.agent, params.state, params.message]);

test("Gentle Shell reports its own Herdr agent identity, session and lifecycle states", async () => {
	const h = harness();
	await h.fire("session_start", { reason: "startup" });
	await settle();
	assert.deepEqual(h.requests[0], {
		id: h.requests[0].id, method: "pane.report_agent_session",
		params: { pane_id: "pane-1", source: "gentle-shell", agent: "gentle-shell", seq: h.requests[0].params.seq,
			session_start_source: "startup", agent_session_path: "/sessions/root.jsonl" },
	});
	assert.deepEqual(h.requests[1].params, { pane_id: "pane-1", source: "gentle-shell", agent: "gentle-shell",
		state: "idle", message: undefined, seq: h.requests[1].params.seq, agent_session_path: "/sessions/root.jsonl" });
	assert.ok((h.requests[1].params.seq as number) > (h.requests[0].params.seq as number));
	h.setIdle(false);
	await h.fire("agent_start");
	h.emit("herdr:blocked", { active: true, label: "Waiting for a choice" });
	await settle();
	h.emit("herdr:blocked", { active: false });
	h.setIdle(true);
	await h.fire("agent_settled");
	await settle(); await settle();
	assert.deepEqual(summary(h.requests).filter(([method]) => method === "pane.report_agent").map(([, , , state, message]) => [state, message]), [
		["idle", undefined], ["working", undefined], ["blocked", "Waiting for a choice"], ["working", undefined], ["idle", undefined],
	]);
	for (const request of h.requests) {
		assert.equal(request.params.source, "gentle-shell");
		assert.equal(request.params.agent, "gentle-shell");
	}
	const seqs = h.requests.map((request) => request.params.seq as number);
	assert.deepEqual([...seqs].sort((a, b) => a - b), seqs);
});

test("Gentle Shell Herdr reporter stays silent without the launcher handoff, outside Herdr, in children and headless modes", async () => {
	for (const overrides of [{ GENTLE_SHELL_HERDR_REPORTER: undefined }, { GENTLE_SHELL_HERDR_REPORTER: "0" },
		{ HERDR_ENV: undefined }, { HERDR_PANE_ID: "" }, { HERDR_SOCKET_PATH: "" }, { GENTLE_PI_AGENTS_CHILD: "1" }]) {
		const h = harness(overrides);
		assert.equal(h.handlers.size, 0, JSON.stringify(overrides));
	}
	for (const mode of ["rpc", "json", "print"]) {
		const h = harness();
		await h.fire("session_start", { reason: "startup" }, h.ctx(mode));
		await h.fire("agent_start", {}, h.ctx(mode));
		h.emit("herdr:blocked", { active: true, label: "x" });
		await settle();
		assert.deepEqual(h.requests, [], mode);
	}
});

test("Gentle Shell Herdr reporter keeps only the latest queued state while a report is in flight", async () => {
	const requests: Request[] = [];
	let release: (() => void) | undefined;
	const handlers = new Map<string, Handler>();
	createHerdrAgentExtension({
		env: { HERDR_ENV: "1", HERDR_PANE_ID: "p", HERDR_SOCKET_PATH: "/s", GENTLE_SHELL_HERDR_REPORTER: "1" },
		send: (request) => {
			requests.push(request as Request);
			return (request as Request).method === "pane.report_agent" && requests.length === 2
				? new Promise<void>((resolve) => { release = resolve; }) : Promise.resolve();
		},
	})({ on: (name: string, fn: Handler) => handlers.set(name, fn), events: { on: () => () => {} } } as unknown as ExtensionAPI);
	let idle = true;
	const ctx = { mode: "tui", isIdle: () => idle, sessionManager: { getSessionFile: () => undefined, getSessionId: () => "id-1" } } as unknown as ExtensionContext;
	await handlers.get("session_start")!({ reason: "startup" }, ctx);
	await settle();
	idle = false; await handlers.get("agent_start")!({}, ctx);
	idle = true; await handlers.get("agent_settled")!({}, ctx);
	idle = false; await handlers.get("agent_start")!({}, ctx);
	release?.();
	await settle(); await settle();
	const states = requests.filter((request) => request.method === "pane.report_agent").map((request) => request.params.state);
	assert.deepEqual(states, ["idle", "working"]);
	assert.equal(requests.at(-1)?.params.agent_session_id, "id-1");
});
