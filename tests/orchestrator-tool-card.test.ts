import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { orchestratorToolRenderers } from "../lib/orchestrator-tool-card.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";

const theme = { fg: (_role: string, text: string) => text, bg: (_role: string, text: string) => `\x1b[48;2;20;20;20m${text}\x1b[49m` };
interface Example {
	kind: Parameters<typeof orchestratorToolRenderers>[0];
	args: Record<string, unknown>;
	result: { content: Array<{ type: string; text: string }>; details?: unknown };
	summary: RegExp;
}
const cases: Example[] = [
	{ kind: "session" as const, args: { subject: "Inspect Windows", state: { objective: "Read-only VM inspection" } }, result: { content: [{ type: "text", text: "Active session ID: stable-routing-id\nCurrent alias: Recover Alan changes" }], details: { gentleAgents: { senderSessionId: "stable-routing-id", alias: "Recover Alan changes" } } }, summary: /Current alias: Recover Alan changes/ },
	{ kind: "consult" as const, args: { recipient_session_id: "peer-id" }, result: { content: [{ type: "text", text: '{"status":"available","authority":"none"}' }], details: { gentleAgents: { receipt: { status: "available", authority: "none" } } } }, summary: /available.*not an owner reply/i },
	{ kind: "list" as const, args: {}, result: { content: [{ type: "text", text: "Advertised sessions (reachability is unknown):\n- peer-id" }], details: { gentleAgents: { candidates: [{ sessionId: "peer-id" }] } } }, summary: /1 advertised session.*reachability unknown/i },
];

function card(entry: Example, expanded: boolean, partial = false) {
	const renderer = orchestratorToolRenderers(entry.kind, (open) => open ? "collapse" : "expand");
	const context = { args: entry.args, state: {}, expanded, isPartial: partial };
	const call = renderer.renderCall(entry.args, theme, context);
	const result = renderer.renderResult(entry.result, { expanded, isPartial: partial }, theme, context);
	return { render: (width: number) => [...call.render(width), ...result.render(width)], invalidate() { call.invalidate(); result.invalidate(); } };
}

test("orchestrator cards replace JSON calls with semantic headings and useful summaries", () => {
	for (const entry of cases) {
		const compact = stripAnsi(card(entry, false).render(140).join("\n"));
		assert.match(compact, entry.summary);
		assert.doesNotMatch(compact, /\{"|stable-routing-id|peer-id|Read-only VM inspection/);
		assert.match(compact, /expand/);
		const expanded = stripAnsi(card(entry, true).render(140).join("\n"));
		assert.notEqual(compact, expanded);
		assert.doesNotMatch(expanded, /Arguments:|Result details:|\{"|^\s*[{}]\s*$/m);
		assert.ok(expanded.includes(entry.kind === "session" ? "Routing ID:" : entry.kind === "consult" ? "Status:" : "without recent metadata"));
		assert.match(expanded, /collapse/);
	}
	const identity = stripAnsi(card(cases[0], true).render(140).join("\n"));
	assert.match(identity, /Requested subject: Inspect Windows/);
	assert.match(identity, /Existing alias preserved/);
	assert.match(identity, /stable-routing-id/);
	assert.match(identity, /Read-only VM inspection/);
});

test("discovery overview uses one row per recorded session and groups unknown sessions", () => {
	const entry: Example = {
		...cases[2],
		result: {
			content: [{ type: "text", text: "Advertised sessions: raw-output-must-not-repeat" }],
			details: { gentleAgents: { candidates: [
				{ sessionId: "known-id", label: "API team", freshness: "recent", reachability: "unknown", workspace: "/work/api", tasks: [{ id: "task-1", label: "Check login", status: "running", workspace: "/work/task" }], scope: { host: { root: "/repo/api" }, complete: false, omittedTasks: 2 } },
				{ sessionId: "unknown-id", freshness: "unknown", reachability: "unknown" },
				{ sessionId: "stale-id", freshness: "stale", reachability: "unknown", label: "Old alias must stay hidden", workspace: "/stale-workspace" },
			] } },
		},
	};
	const before = structuredClone(entry);
	const output = stripAnsi(card(entry, true).render(140).join("\n"));
	assert.match(output, /API team\s+known-id\s+api\s+1/);
	assert.match(output, /2 without recent metadata/);
	assert.match(output, /Detail: consult\(full ID\)/);
	assert.doesNotMatch(output, /Session ID:|Check login|Complete:|Omitted tasks:|\/work\/api|unknown-id|stale-id|Arguments:|raw-output-must-not-repeat|recorded catalog: unknown|Old alias|stale-workspace|[{}]/);
	assert.deepEqual(entry, before);
});

test("consultation, classified work, and missing-detail JSON become labelled rows with safety limits", () => {
	const examples: Example[] = [
		{ ...cases[1], result: { content: [{ type: "text", text: '{"status":"available","authority":"none"}' }], details: { gentleAgents: { receipt: { status: "available", ownerReply: false, authority: "none", snapshot: { label: "API team", state: { state: { objective: "Verify login" } } }, unknowns: ["reachability"], omissions: ["private-context"], digest: "technical-digest" } } } } },
		{ ...cases[2], args: { filter: { area: "Auth" } }, result: { content: [{ type: "text", text: '{"matches":[]}' }], details: { gentleAgents: { workSearch: { matches: [{ sessionId: "peer-id", work: { area: "Auth", tags: ["Review"] } }], coverage: { exhaustive: false, omittedMatches: 2 }, ownerReply: false, authority: "none" } } } } },
		{ ...cases[1], result: { content: [{ type: "text", text: '{"status":"unavailable","code":"not-ready"}' }] } },
	];
	const outputs = examples.map(entry => stripAnsi(card(entry, true).render(140).join("\n")));
	for (const output of outputs) assert.doesNotMatch(output, /[{}]|"status"|"matches"|Arguments:|Result details:/);
	assert.match(outputs[0], /Objective: Verify login/);
	assert.match(outputs[0], /Owner reply: no/);
	assert.match(outputs[0], /Authority: none/);
	assert.match(outputs[0], /Unknowns:/);
	assert.match(outputs[0], /private-context/);
	assert.doesNotMatch(outputs[0], /technical-digest/);
	assert.match(outputs[1], /Auth/);
	assert.match(outputs[1], /non-exhaustive/);
	assert.match(outputs[1], /2 matches omitted/);
	assert.match(outputs[1], /No authority/);
	assert.match(outputs[2], /Code: not-ready/);
});

test("targeted discovery retains full identity and concise unknown repository limits", () => {
	const peers = [
		{ sessionId: "no-scope", label: "Workspace only", freshness: "recent", workspace: "/work" },
		{ sessionId: "no-identity", label: "Non-Git workspace", freshness: "recent", scope: { host: { root: null, cloneHash: null, resolvedAt: 1, source: "recorded-workspace/git" }, complete: true } },
	];
	for (const peer of peers) {
		const entry: Example = { ...cases[2], args: { recipient_session_id: peer.sessionId }, result: { content: [], details: { gentleAgents: { candidates: [peer] } } } };
		const output = stripAnsi(card(entry, true).render(140).join("\n"));
		assert.ok(output.includes(`Session ID: ${peer.sessionId}`));
		assert.match(output, peer.sessionId === "no-scope" ? /Repository scope: unknown/ : /Repository identity: unknown/);
		assert.doesNotMatch(output, /Root: null|Clone hash: null|[{}]/);
	}
});

test("expanded discovery has a fixed height even with dozens of rich records and narrow terminals", () => {
	const previous = cardStyle();
	const peers = Array.from({ length: 40 }, (_, index) => ({
		sessionId: `01a10f0e-b0aa-72f1-951e-${String(index).padStart(12, "0")}`,
		label: `API 团队 ${index} ${"long label ".repeat(8)}`, freshness: index < 9 ? "unknown" : "recent", reachability: "unknown",
		workspace: `/home/devel/projects/${"long-parent/".repeat(20)}worktree-${index}`,
		tasks: Array.from({ length: 8 }, (_, task) => ({ id: `task-${task}`, label: "Verbose task must not be dumped", workspace: "/hidden/task/workspace", status: "running" })), omitted: 2,
		catalog: { tasks: [{ label: "Duplicated catalog must not appear" }], registered: Array(8).fill("/very/long/registered/worktree/path") },
	}));
	const entry: Example = { ...cases[2], result: { content: [], details: { gentleAgents: { candidates: peers } } } };
	const before = structuredClone(entry);
	try {
		for (const style of Object.values(CARD_STYLE)) {
			setCardStyle(style);
			for (const width of [140, 80, 48, 24, 8, 1, 0, 140]) {
				const view = card(entry, true);
				const rows = view.render(width);
				assert.ok(rows.length <= 16, `${style}/${width}: ${rows.length} physical rows`);
				for (const row of rows) assert.ok(visibleWidth(row) <= width);
				if (style === CARD_STYLE.FLOAT && width === 140) assert.ok(rows.some(row => stripAnsi(row).trimStart().startsWith("▎")), "exercise real float chrome, not its no-background fallback");
				if (width === 140) {
					const output = stripAnsi(rows.join("\n"));
					assert.match(output, /9 without recent metadata/);
					assert.match(output, /25 more recorded sessions/);
					assert.match(output, /worktree-9\s+8\+/);
					assert.doesNotMatch(output, /Verbose task|Duplicated catalog|registered\/worktree|long-parent|Session ID:|ownership guarantee/);
				}
			}
		}
	} finally { setCardStyle(previous); }
	assert.deepEqual(entry, before);
});

test("classified-work overviews are also bounded and do not dump descriptors or coverage trees", () => {
	const matches = Array.from({ length: 30 }, (_, index) => ({ sessionId: `peer-${index}`, label: `Auth task ${index}`, taskId: `task-${index}`, work: { area: "Auth", topic: "Login", tags: Array(8).fill("Verbose tag must stay hidden") } }));
	const entry: Example = { ...cases[2], args: { filter: { area: "Auth" } }, result: { content: [], details: { gentleAgents: { workSearch: { matches, coverage: { exhaustive: false, omittedMatches: 2, unexaminedPeers: 3 }, ownerReply: false, authority: "none" } } } } };
	for (const width of [140, 80, 48, 24, 1, 0]) {
		const rows = card(entry, true).render(width);
		assert.ok(rows.length <= 16, `width ${width}: ${rows.length} rows`);
		for (const row of rows) assert.ok(visibleWidth(row) <= width);
		if (width === 140) {
			const output = stripAnsi(rows.join("\n"));
			assert.match(output, /Auth\/Login/);
			assert.match(output, /24 more work matches/);
			assert.match(output, /2 matches omitted/);
			assert.match(output, /3 peers not scanned/);
			assert.doesNotMatch(output, /Verbose tag|Coverage:|Work search:|Owner reply:/);
		}
	}
});

test("overview colors create hierarchy without changing text, column widths, or height", () => {
	const colors: Record<string, number> = { accent: 34, toolTitle: 35, dim: 90, muted: 37, syntaxNumber: 36, warning: 33 };
	const calls: Array<{ role: string; value: string }> = [];
	const colored = {
		...theme,
		fg: (role: string, value: string) => { calls.push({ role, value }); return `\x1b[${colors[role] ?? 39}m${value}\x1b[39m`; },
		bold: (value: string) => `\x1b[1m${value}\x1b[22m`,
	};
	const entry: Example = { ...cases[2], result: { content: [], details: { gentleAgents: { candidates: [
		{ sessionId: "peer-1", label: "API 团队", workspace: "/work/api", freshness: "recent", tasks: [{}, {}, {}] },
		{ sessionId: "peer-2", label: "No tasks", freshness: "recent", tasks: [] },
		{ sessionId: "peer-3", label: "Unknown count", freshness: "recent" },
		{ sessionId: "hidden-peer", freshness: "unknown" },
	] } } } };
	const renderer = orchestratorToolRenderers("list", open => open ? "collapse" : "expand");
	const context = { args: entry.args, state: {}, expanded: true, isPartial: false };
	const call = renderer.renderCall(entry.args, colored, context);
	const result = renderer.renderResult(entry.result, { expanded: true, isPartial: false }, colored, context);
	const previous = cardStyle();
	try {
		for (const style of Object.values(CARD_STYLE)) {
			setCardStyle(style);
			for (const width of [140, 80, 48, 24, 8, 1, 0, 140]) {
				calls.length = 0;
				const rows = [...call.render(width), ...result.render(width)];
				assert.deepEqual(rows.map(stripAnsi), card(entry, true).render(width).map(stripAnsi));
				assert.ok(rows.length <= 16);
				for (const row of rows) assert.ok(visibleWidth(row) <= width);
				if (width === 140) {
					const output = rows.join("\n");
					assert.ok(output.includes("\x1b[34mAPI 团队\x1b[39m"));
					assert.ok(output.includes("\x1b[90mpeer-1\x1b[39m"));
					assert.ok(calls.some(call => call.role === "toolTitle" && call.value === "Alias"));
					assert.ok(calls.some(call => call.role === "syntaxNumber" && call.value === "3"));
					assert.ok(calls.some(call => call.role === "muted" && call.value === "0"));
					assert.ok(calls.some(call => call.role === "warning" && call.value === "?"));
					assert.ok(calls.some(call => call.role === "muted" && call.value.includes("without recent metadata")));
					assert.ok(!calls.some(call => call.role === "success"), "colors must not suggest confirmed live reachability");
				}
			}
		}
	} finally { setCardStyle(previous); }
});

test("session identity highlights alias and subject without changing content or wrapping", () => {
	let accent = 34;
	const colors: Record<string, number> = { muted: 37, dim: 90 };
	const colored = { ...theme, fg: (role: string, value: string) => `\x1b[${role === "accent" ? accent : colors[role] ?? 39}m${value}\x1b[39m` };
	const entry: Example = { ...cases[0], args: { subject: "Inspeccionar Windows — demo 团队" }, result: { content: [], details: { gentleAgents: { alias: "Prueba visual", senderSessionId: "01a11f31-f3a7-71e9-ba8a-4649a0cf8c11" } } } };
	const before = structuredClone(entry);
	const previous = cardStyle();
	try {
		for (const style of Object.values(CARD_STYLE)) {
			setCardStyle(style);
			for (const expanded of [false, true]) {
				const renderer = orchestratorToolRenderers("session", open => open ? "collapse" : "expand");
				const context = { args: entry.args, state: {}, expanded, isPartial: false };
				const call = renderer.renderCall(entry.args, colored, context);
				const result = renderer.renderResult(entry.result, { expanded, isPartial: false }, colored, context);
				for (const width of [140, 80, 48, 24, 8, 1, 0, 140]) {
					const rows = [...call.render(width), ...result.render(width)];
					assert.deepEqual(rows.map(stripAnsi), card(entry, expanded).render(width).map(stripAnsi));
					for (const row of rows) assert.ok(visibleWidth(row) <= width);
					if (width === 140) {
						const output = rows.join("\n");
						assert.ok(output.includes("\x1b[37mCurrent alias: \x1b[39m\x1b[34mPrueba visual\x1b[39m"));
						assert.ok(output.includes("\x1b[37mExisting alias preserved; subject does not rename it.\x1b[39m"));
						if (expanded) {
							assert.ok(output.includes("\x1b[90m01a11f31-f3a7-71e9-ba8a-4649a0cf8c11\x1b[39m"));
							assert.ok(output.includes("\x1b[34mInspeccionar Windows — demo 团队\x1b[39m"));
						}
					}
				}
				accent = 35;
				result.invalidate();
				assert.ok(result.render(140).join("\n").includes("\x1b[35mPrueba visual\x1b[39m"));
				accent = 34;
			}
		}
	} finally { setCardStyle(previous); }
	assert.deepEqual(entry, before);
});

test("session identity preserves main's separate task aliases and human session name", () => {
	const entry: Example = { ...cases[0], args: { subject: "Inspect project" }, result: { content: [], details: { gentleAgents: { alias: "Demo session", sessionName: "Demo session", currentAlias: "Inspect project", initialAlias: "First task", senderSessionId: "stable-routing-id" } } } };
	const compact = stripAnsi(card(entry, false).render(140).join("\n"));
	assert.match(compact, /Current alias: Inspect project/);
	assert.match(compact, /Session name: Demo session/);
	assert.doesNotMatch(compact, /Current alias: Demo session|Existing alias preserved/);
	const expanded = stripAnsi(card(entry, true).render(140).join("\n"));
	assert.match(expanded, /Initial alias: First task/);
	assert.match(expanded, /Session name preserved; subject updates task aliases/);
	assert.match(expanded, /Routing ID: stable-routing-id/);
	assert.doesNotMatch(expanded, /Requested subject: Inspect project/);
	for (const expanded of [false, true]) {
		const unknown: Example = { ...entry, result: { content: [], details: { gentleAgents: { alias: "Demo session", sessionName: "Demo session", currentAlias: null, initialAlias: null } } } };
		const output = stripAnsi(card(unknown, expanded).render(140).join("\n"));
		assert.match(output, /Current alias: unknown/);
		assert.doesNotMatch(output, /Current alias: Demo session|Current alias: Inspect project/);
		if (expanded) assert.match(output, /Initial alias: unknown/);
	}
});

test("classified-work limits use warning rather than success colors", () => {
	const calls: Array<{ role: string; value: string }> = [];
	const colors = { ...theme, fg: (role: string, value: string) => { calls.push({ role, value }); return value; } };
	const result = { content: [], details: { gentleAgents: { workSearch: { matches: [{ sessionId: "peer-1", label: "Auth task", work: { area: "Auth" } }], coverage: { omittedMatches: 2 }, source: { status: "unavailable", reason: "source-unclassified" } } } } };
	const component = orchestratorToolRenderers("list", () => "collapse").renderResult(result, { expanded: true, isPartial: false }, colors, { args: { filter: {} }, state: {} });
	component.render(140);
	assert.ok(calls.some(call => call.role === "warning" && call.value === "2 matches omitted"));
	assert.ok(calls.some(call => call.role === "warning" && call.value.includes("Source unavailable")));
	assert.ok(calls.some(call => call.role === "accent" && call.value === "Auth task"));
	assert.ok(!calls.some(call => call.role === "success"));
});

test("overview styles are recomputed on render after a theme changes", () => {
	let accent = 34;
	const changing = { ...theme, fg: (role: string, value: string) => role === "accent" ? `\x1b[${accent}m${value}\x1b[39m` : value };
	const entry: Example = { ...cases[2], result: { content: [], details: { gentleAgents: { candidates: [{ sessionId: "peer-1", label: "API team", freshness: "recent", tasks: [] }] } } } };
	const context = { args: {}, state: {}, expanded: true, isPartial: false };
	const component = orchestratorToolRenderers("list", () => "collapse").renderResult(entry.result, { expanded: true, isPartial: false }, changing, context);
	const before = component.render(140);
	assert.ok(before.join("\n").includes("\x1b[34mAPI team\x1b[39m"));
	accent = 31;
	component.invalidate();
	const after = component.render(140);
	assert.ok(after.join("\n").includes("\x1b[31mAPI team\x1b[39m"));
	assert.deepEqual(before.map(stripAnsi), after.map(stripAnsi));
});

test("legacy JSON keys that match object prototypes render as data, never as label functions", () => {
	const entry: Example = { ...cases[1], result: { content: [{ type: "text", text: '{"status":"unavailable","constructor":"Visible constructor","__proto__":{"prototype":"Visible prototype"}}' }] } };
	const output = stripAnsi(card(entry, true).render(140).join("\n"));
	assert.match(output, /Constructor: Visible constructor/);
	assert.match(output, /Prototype: Visible prototype/);
	assert.doesNotMatch(output, /[{}]/);
});

test("nested readable data remains sanitized and width-safe with Unicode", () => {
	const unsafe = "\x1b]52;c;clipboard\x07\x1b[31mAPI 团队 e\u0301\x1b[0m\r\u0000";
	const entry: Example = { ...cases[1], result: { content: [{ type: "text", text: "ignored serialization" }], details: { gentleAgents: { receipt: { status: "available", snapshot: { [unsafe]: unsafe }, unknowns: [unsafe] } } } } };
	const previous = cardStyle();
	try {
		for (const style of Object.values(CARD_STYLE)) {
			setCardStyle(style);
			const view = card(entry, true);
			for (const width of [140, 60, 24, 8, 1, 0, 140]) {
				view.invalidate();
				const rows = view.render(width);
				for (const row of rows) assert.ok(visibleWidth(row) <= width);
				const output = stripAnsi(rows.join("\n"));
				assert.doesNotMatch(output, /clipboard|\x1b|\r|\u0000/);
				if (width === 140) assert.match(output, /API 团队 e\u0301/);
			}
		}
	} finally { setCardStyle(previous); }
});

test("pending requests and withdrawn state are readable without empty argument blocks", () => {
	for (const args of [{}, { subject: "Inspect Windows", state: null }]) {
		const renderer = orchestratorToolRenderers("session", () => "collapse");
		const output = stripAnsi(renderer.renderCall(args, theme, { args, state: {}, expanded: true, isPartial: true }).render(140).join("\n"));
		assert.doesNotMatch(output, /Arguments:|[{}]/);
		if ("state" in args) assert.match(output, /State: withdrawn/);
	}
});

test("the same completed row expands and collapses without stale detail or headings", () => {
	for (const entry of cases) {
		const renderer = orchestratorToolRenderers(entry.kind, open => open ? "collapse" : "expand");
		const context = { args: entry.args, state: {}, expanded: false, isPartial: false };
		const snapshots: string[] = [];
		for (const expanded of [false, true, false]) {
			context.expanded = expanded;
			const call = renderer.renderCall(entry.args, theme, context);
			const result = renderer.renderResult(entry.result, { expanded, isPartial: false }, theme, context);
			call.invalidate(); result.invalidate();
			snapshots.push(stripAnsi([...call.render(140), ...result.render(140)].join("\n")));
		}
		assert.equal(snapshots[0], snapshots[2]);
		assert.notEqual(snapshots[0], snapshots[1]);
		assert.doesNotMatch(snapshots[2], /Arguments:|Result details:/);
	}
});

test("identity without a requested subject or with a matching alias does not claim a preserved mismatch", () => {
	for (const args of [{}, { subject: "Recover Alan changes" }, { state: null }]) {
		const output = stripAnsi(card({ ...cases[0], args }, true).render(140).join("\n"));
		assert.doesNotMatch(output, /Existing alias preserved/);
	}
});

test("error and partial cards do not claim successful consultation or discovery", () => {
	for (const entry of cases) {
		const renderer = orchestratorToolRenderers(entry.kind, () => "expand");
		const context = { args: entry.args, state: {}, isPartial: true, expanded: false };
		const call = renderer.renderCall(entry.args, theme, context);
		assert.match(stripAnsi(call.render(120).join("\n")), /running/);
		const result = renderer.renderResult({ content: [{ type: "text", text: "Error: not ready" }], details: { error: "not ready" } }, { expanded: false, isPartial: false }, theme, context);
		const failed = stripAnsi([...call.render(120), ...result.render(120)].join("\n"));
		assert.match(failed, /Error: not ready/);
		assert.doesNotMatch(failed, /running|Current alias:|advertised sessions|available ·/);
	}
});

test("successful-looking partial results never display a final status or count", () => {
	for (const entry of cases.slice(1)) {
		const output = stripAnsi(card(entry, false, true).render(140).join("\n"));
		assert.match(output, /Receiving partial result/);
		assert.doesNotMatch(output, entry.summary);
	}
});

test("work search and detail-less stored results remain useful", () => {
	const renderer = orchestratorToolRenderers("list", () => "expand");
	const context = { args: { filter: {} }, state: {}, expanded: false, isPartial: false };
	const result = renderer.renderResult({ content: [{ type: "text", text: '{"matches":[]}' }], details: { gentleAgents: { workSearch: { matches: [] } } } }, { expanded: false, isPartial: false }, theme, context);
	assert.match(stripAnsi(result.render(140).join("\n")), /0 work matches.*non-exhaustive/i);
	const legacy = renderer.renderResult({ content: [{ type: "text", text: "No other sessions are currently advertised." }] }, { expanded: true, isPartial: false }, theme, context);
	assert.match(stripAnsi(legacy.render(140).join("\n")), /No other sessions/);
});

test("expanded cards preserve payloads, sanitize terminal text, and resize in both styles", () => {
	const previous = cardStyle();
	try {
		for (const style of Object.values(CARD_STYLE)) {
			setCardStyle(style);
			for (const entry of cases) for (const expanded of [false, true]) {
				const view = card(entry, expanded);
				for (const width of [140, 80, 24, 8, 2, 1, 0, 140]) {
					view.invalidate();
					const rows = view.render(width);
					for (const row of rows) assert.ok(visibleWidth(row) <= width);
					if (!width) assert.deepEqual(rows, []);
				}
			}
		}
		const unsafe = "\x1b]52;c;clipboard\x07Visible\r\u0000";
		const view = card({ ...cases[0], result: { content: [{ type: "text", text: unsafe }], details: { gentleAgents: { alias: unsafe, senderSessionId: "stable-routing-id" } } } }, true);
		const text = stripAnsi(view.render(140).join("\n"));
		assert.match(text, /Visible/);
		assert.doesNotMatch(text, /\x1b|\r|\u0000/);
	} finally { setCardStyle(previous); }
});
