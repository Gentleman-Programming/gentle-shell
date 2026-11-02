import type { FleetViewMember, FleetViewSnapshot } from "../../lib/fleet-view.ts";

// The 05-calm-deck fleet (design/fleet-tui/05-calm-deck.html) as the ledger
// and the controller would hand it over: 20 members, five fronts, one
// escalated decision, one failed member and three branches ready for review.

export const at = (minute: number): string => `2026-11-02T14:${String(minute).padStart(2, "0")}:00.000Z`;

type Row = [name: string, front: string, state: "ask" | "fail" | "work" | "idle" | "done", done: number, total: number, current: string | null, tokK: number, firstK: number, owns: string];
const ROWS: Row[] = [
	["web-invite-flow", "web", "ask", 2, 6, "Invite dialog with expiring link", 96, 20.4, "apps/web/src/invites"],
	["billing-seats", "platform", "fail", 1, 4, "Sync Stripe quantity on member join", 74, 20.2, "apps/api/src/billing"],
	["api-migration", "api", "work", 3, 7, "Add invite token table migration", 182, 20.1, "prisma/"],
	["api-invites", "api", "work", 2, 6, "POST /workspaces/:id/invites", 121, 20.3, "apps/api/src/invites"],
	["e2e-tests", "quality", "work", 3, 8, "Switch keeps the open note", 143, 20.6, "e2e/"],
	["web-switcher", "web", "work", 5, 6, "Persist last workspace per device", 102, 20.4, "apps/web/src/workspaces"],
	["api-roles", "api", "work", 4, 5, "Owner transfer endpoint", 88, 20.3, "apps/api/src/members"],
	["sync-realtime", "platform", "work", 1, 6, "Scope channels by workspace", 91, 20.2, "apps/api/src/realtime"],
	["web-settings", "web", "work", 2, 5, "Members table with role select", 64, 20.4, "apps/web/src/settings"],
	["perf-audit", "quality", "work", 2, 5, "Index (workspace_id, updated_at)", 58, 20.1, "perf/"],
	["i18n-strings", "platform", "work", 3, 6, "ICU plurals for member counts", 47, 20.0, "apps/web/src/i18n"],
	["audit-log", "api", "work", 1, 4, "Log invite created, accepted, revoked", 33, 20.1, "apps/api/src/events"],
	["docs-guides", "docs", "idle", 4, 4, null, 41, 19.8, "docs/guides"],
	["docs-api-ref", "docs", "idle", 2, 3, "Invites endpoints reference", 29, 19.8, "docs/api"],
	["web-empty-states", "web", "idle", 1, 4, "Invite teammates call to action", 39, 20.4, "apps/web/src/workspaces/empty"],
	["security-review", "quality", "idle", 0, 3, "Review invite token storage", 22, 19.9, "docs/security"],
	["mobile-layout", "web", "idle", 2, 3, "Verify on iOS Safari", 26, 20.4, "apps/web/src/styles"],
	["docs-changelog", "docs", "done", 2, 2, null, 12, 19.8, "CHANGELOG.md"],
	["design-tokens", "platform", "done", 3, 3, null, 18, 19.9, "packages/ui"],
	["seed-data", "platform", "done", 3, 3, null, 15, 19.8, "prisma/seed.ts"],
];
const REVIEWS: Record<string, [label: string, minute: number]> = { "docs-changelog": ["PR #412", 21], "design-tokens": ["PR #409", 12], "seed-data": ["PR #410", 9] };
export const EXPIRY = "Invite links: expire after 7 days or 30 days?";
export const EXPIRY_OPTIONS = ["7 days", "30 days", "Never (revoke)", "Type an answer…"];

export function member([name, front, state, done, total, current, tokK, firstK, owns]: Row): FleetViewMember {
	const tokens = Math.max(tokK, Math.ceil(firstK + 4)) * 1000;
	const status = { ask: "waiting-question", fail: "exited", work: "working", idle: "idle", done: "exited" }[state];
	const m: FleetViewMember = {
		name, front, objective: `Owns ${owns}`, cwd: "/work/inkwell", status, todo: { done, total, current },
		tokens, cost: Math.round((0.2 + 0.0057 * (tokens / 1000 - firstK)) * 100) / 100,
		question: null, lastError: null, worktree: `/work/inkwell.fleet/team-workspaces/${name}`, branch: `fleet/team-workspaces/${name}`,
		exitCode: null, exitSignal: null, spawnedAt: at(3), exitedAt: null,
		lastTool: "read", prefixTokens: firstK * 1000, cacheRead: Math.round(0.9 * (tokens - firstK * 1000)), dialogs: [],
	};
	if (state === "ask") {
		m.question = `${EXPIRY} [${EXPIRY_OPTIONS.join(" | ")}]`;
		m.dialogs = [{ id: "web-invite-flow-d1", method: "select", title: EXPIRY, options: EXPIRY_OPTIONS, at: at(18) }];
	}
	if (state === "fail") Object.assign(m, { exitCode: 1, exitedAt: at(16), lastError: "exit 1 · 3 tests failing: Stripe mock lacks subscriptions.update quantity" });
	if (state === "done") Object.assign(m, { exitCode: 0, exitedAt: at(REVIEWS[name][1]), review: { label: REVIEWS[name][0], at: at(REVIEWS[name][1]) } });
	return m;
}

export function inkwellFleet(): FleetViewSnapshot {
	const members = ROWS.map(member);
	return {
		title: "Team workspaces for Inkwell",
		objective: "Add team workspaces to Inkwell: API, web app and docs. Email invite links, no SSO yet.",
		members,
		log: [
			...members.map((m) => ({ at: at(3), kind: "spawn", member: m.name, text: m.objective })),
			{ at: at(16), kind: "exit", member: "billing-seats", text: "code 1" },
			{ at: at(18), kind: "question", member: "web-invite-flow", text: EXPIRY },
		],
		escalations: [{ member: "web-invite-flow", title: EXPIRY, message: "Dialog copy and API default must match; also unblocks 2 members.", options: EXPIRY_OPTIONS, at: at(18) }],
		budgets: { fleetUsd: 40, memberUsd: null },
		controller: { tokens: 41_000, cost: 0.34 },
		documentPath: "/work/inkwell/odd/fleet/team-workspaces-for-inkwell.md",
		nextUpdate: "around 14:40, when the invite token table lands",
	};
}
