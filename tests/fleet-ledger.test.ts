import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FLEET_LOG_MAX, FleetLedger, fleetSlug, loadFleetLedger, type FleetLedgerState } from "../lib/fleet-ledger.ts";

// odd/tasks/fleet-orchestrator.md S5: the fleet ledger lives in code and is
// rendered by code into one general ODD-style document; no model tokens.

// Scratch stays outside the worktree; it is reported, not removed.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gentle-fleet-ledger-")));
let counter = 0;

function harness(options: { write?: (path: string, text: string) => void; onChange?: () => void } = {}) {
	counter += 1;
	const root = join(scratch, `case-${counter}`);
	const cwd = join(root, "project");
	const ledgerPath = join(root, "agent", "gentle-fleet", "sessions", "fleet-1", "ledger.json");
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	const writes: string[] = [];
	const errors: unknown[] = [];
	let clock = Date.parse("2026-11-02T10:00:00.000Z");
	const ledger = new FleetLedger({
		fleetSessionId: "fleet-1",
		cwd,
		ledgerPath,
		now: () => new Date((clock += 1000)),
		schedule: (fn, ms) => {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => { timer.cancelled = true; };
		},
		write: options.write ? (path, text) => { writes.push(path); options.write!(path, text); } : undefined,
		onError: error => errors.push(error),
		onChange: options.onChange,
	});
	const runTimers = () => {
		for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn();
	};
	const readLedger = () => JSON.parse(readFileSync(ledgerPath, "utf8")) as FleetLedgerState;
	return { root, cwd, ledgerPath, ledger, timers, writes, errors, runTimers, readLedger };
}

test("fleetSlug makes a kebab-case, filename-safe slug from a title", () => {
	assert.equal(fleetSlug("Ship the Billing API v2!"), "ship-the-billing-api-v2");
	assert.equal(fleetSlug("  Café & Señal: ../etc/passwd  "), "cafe-senal-etc-passwd");
	assert.equal(fleetSlug("///"), "fleet");
	const long = fleetSlug("word ".repeat(40));
	assert.ok(long.length <= 60 && !long.endsWith("-"), long);
});

test("the ledger renders the general fleet document and persists the ledger JSON", () => {
	const h = harness();
	const path = h.ledger.setObjective("Billing API v2", "Ship the billing API with tests and docs.");
	assert.equal(path, join(h.cwd, "odd", "fleet", "billing-api-v2.md"));
	h.ledger.spawned("api", "Own the API | routes and tests", "/work/api");
	h.ledger.update("api", { status: "working", todo: { done: 1, total: 3, current: "Write routes" }, tokens: 12345, cost: 0.4567, question: null, lastError: null });
	h.ledger.spawned("web", "Own the web front", "/work/web");
	h.ledger.update("web", { status: "waiting-question", todo: null, tokens: 900, cost: 0.01, question: "Pick a database [postgres | sqlite]", lastError: null });
	h.ledger.log("question", "web", "Pick a database [postgres | sqlite]");
	h.ledger.spawned("docs", "Own the docs", "/work/docs");
	h.ledger.update("docs", { status: "exited", todo: null, tokens: 10, cost: 0, question: null, lastError: "model refused" });
	h.ledger.exited("docs", 1, null);
	h.ledger.flush();

	const doc = readFileSync(path, "utf8");
	assert.match(doc, /^# Fleet: Billing API v2$/m);
	assert.match(doc, /^Objective: Ship the billing API with tests and docs\.$/m);
	assert.match(doc, /^Fleet session: `fleet-1`$/m);
	assert.match(doc, /^Updated: 2026-11-02T10:00:\d\d\.000Z$/m);
	assert.match(doc, /^## Members$/m);
	assert.match(doc, /^\| Member \| Owns \| Status \| Progress \| Current task \| New tokens \/ cost \| Waiting on \| Branch \| Worktree \|$/m);
	assert.match(doc, /^\| api \| Own the API \\\| routes and tests \| working \| 1\/3 \| Write routes \| 12\.3k \/ \$0\.46 \| — \| — \| — \|$/m, "pipes in cells are escaped");
	assert.match(doc, /^\| web \| Own the web front \| waiting-question \| — \| — \| 900 \/ \$0\.01 \| Pick a database \[postgres \\\| sqlite\] \| — \| — \|$/m);
	const blockers = doc.slice(doc.indexOf("## Blockers"), doc.indexOf("## Log"));
	assert.match(blockers, /- web: question — Pick a database/);
	assert.match(blockers, /- docs: error — model refused/);
	assert.match(blockers, /- docs: exited with code 1/);
	assert.doesNotMatch(blockers, /- api/);
	const log = doc.slice(doc.indexOf("## Log"));
	const kinds = [...log.matchAll(/^- \S+ · (\w+)/gm)].map(match => match[1]);
	assert.deepEqual(kinds, ["objective", "spawn", "spawn", "question", "spawn", "exit"], "newest last");

	const saved = h.readLedger();
	assert.equal(saved.version, 1);
	assert.equal(saved.fleetSessionId, "fleet-1");
	assert.equal(saved.title, "Billing API v2");
	assert.equal(saved.slug, "billing-api-v2");
	assert.equal(saved.documentPath, path);
	assert.deepEqual(saved.members.map(member => [member.name, member.cwd, member.status]), [["api", "/work/api", "working"], ["web", "/work/web", "waiting-question"], ["docs", "/work/docs", "exited"]]);
	const docs = saved.members[2];
	assert.equal(docs.exitCode, 1);
	assert.match(docs.spawnedAt, /^2026-11-02T10:00:\d\d\.000Z$/);
	assert.match(String(docs.exitedAt), /^2026-11-02T10:00:\d\d\.000Z$/);
	assert.equal(saved.log.length, 6);
	assert.deepEqual(saved.log[3], { at: saved.log[3].at, kind: "question", member: "web", text: "Pick a database [postgres | sqlite]" });
});

test("a burst of changes writes once after the debounce window and flush writes at once", () => {
	const h = harness({ write: () => {} });
	h.ledger.spawned("api", "Own the API", "/w");
	for (let i = 0; i < 20; i++) h.ledger.update("api", { status: "working", todo: { done: i, total: 20, current: null }, tokens: i, cost: 0, question: null, lastError: null });
	h.ledger.log("settle", "api", "idle");
	assert.equal(h.timers.length, 1, "one write window for the whole burst");
	assert.equal(h.timers[0].ms, 1000);
	assert.equal(h.writes.length, 0, "nothing is written inside the window");
	h.runTimers();
	assert.deepEqual(h.writes, [h.ledgerPath, h.ledger.documentPath], "one ledger and one document write");
	h.ledger.log("stop", "api", "stop requested");
	assert.equal(h.timers.length, 1);
	h.ledger.flush();
	assert.equal(h.writes.length, 4, "flush writes the pending change immediately");
	assert.equal(h.timers[0].cancelled, true, "flush cancels the pending window");
	h.ledger.flush();
	assert.equal(h.writes.length, 4, "a flush with nothing pending writes nothing");
});

test("the document is replaced atomically: no temp file stays and a failed write keeps the previous document", () => {
	const h = harness();
	h.ledger.spawned("api", "Own the API", "/w");
	h.ledger.flush();
	const dir = join(h.cwd, "odd", "fleet");
	const before = readFileSync(h.ledger.documentPath, "utf8");
	assert.deepEqual(readdirSync(dir), ["fleet-fleet-1.md"], "default slug from the fleet session id, no temp files");
	chmodSync(dir, 0o500);
	try {
		h.ledger.log("send", "api", "prompt: more work");
		h.ledger.flush();
	} finally {
		chmodSync(dir, 0o700);
	}
	assert.equal(h.errors.length, 1, "the failed write is reported, not thrown");
	assert.equal(readFileSync(h.ledger.documentPath, "utf8"), before, "the previous complete document is kept");
	assert.deepEqual(readdirSync(dir), ["fleet-fleet-1.md"], "no partial or temp file");
});

test("naming the fleet moves the default document to the titled slug", () => {
	const h = harness();
	h.ledger.spawned("api", "Own the API", "/w");
	h.ledger.flush();
	const first = h.ledger.documentPath;
	assert.ok(existsSync(first));
	const second = h.ledger.setObjective("Search revamp", "Rebuild search.");
	h.ledger.flush();
	assert.equal(second, join(h.cwd, "odd", "fleet", "search-revamp.md"));
	assert.equal(existsSync(first), false, "the default document moved");
	assert.match(readFileSync(second, "utf8"), /^# Fleet: Search revamp$/m);
	assert.match(readFileSync(second, "utf8"), /\| api \|/);
});

test(`the log keeps the last ${FLEET_LOG_MAX} entries`, () => {
	const h = harness();
	mkdirSync(h.cwd, { recursive: true });
	for (let i = 0; i < FLEET_LOG_MAX + 25; i++) h.ledger.log("send", "api", `message ${i}`);
	h.ledger.flush();
	const saved = h.readLedger();
	assert.equal(saved.log.length, FLEET_LOG_MAX);
	assert.equal(saved.log[0].text, "message 25");
	assert.equal(saved.log.at(-1)!.text, `message ${FLEET_LOG_MAX + 24}`);
	const doc = readFileSync(h.ledger.documentPath, "utf8");
	assert.equal([...doc.matchAll(/^- \S+ · send/gm)].length, FLEET_LOG_MAX);
});

// --- T4 (S3, L15): worktree and branch per git member, budget warnings.

test("a git member's branch and worktree land in the ledger and the Members table, untruncated", () => {
	const h = harness();
	h.ledger.setObjective("Billing", "Ship billing.");
	const worktree = `/very/long/path/${"segment/".repeat(12)}app.fleet/billing/api`;
	h.ledger.spawned("api", "Own the API", worktree, { path: worktree, branch: "fleet/billing/api" });
	h.ledger.spawned("pub", "Publish the release posts", "/notes");
	h.ledger.flush();
	const doc = readFileSync(h.ledger.documentPath, "utf8");
	assert.ok(doc.includes(`| api | Own the API | starting | — | — | 0 / $0.00 | — | \`fleet/billing/api\` | \`${worktree}\` |\n`), doc);
	assert.match(doc, /^\| pub \| Publish the release posts \| starting \| — \| — \| 0 \/ \$0\.00 \| — \| — \| — \|$/m, "a member outside git has none");
	const saved = h.readLedger();
	assert.deepEqual(saved.members.map(member => [member.name, member.worktree, member.branch]), [["api", worktree, "fleet/billing/api"], ["pub", null, null]]);
});

test("a budget warning becomes a Blockers entry and a budget log entry", () => {
	const h = harness();
	h.ledger.spawned("api", "Own the API", "/w");
	h.ledger.budgetWarning("api", "member api spent $0.80 of its $1.00 budget (80%)");
	h.ledger.budgetWarning(null, "fleet spent $5.00 of its $5.00 budget (100%)");
	h.ledger.flush();
	const doc = readFileSync(h.ledger.documentPath, "utf8");
	const blockers = doc.slice(doc.indexOf("## Blockers"), doc.indexOf("## Log"));
	assert.deepEqual(blockers.split("\n").filter(line => line.startsWith("- ")), [
		"- api: budget — member api spent $0.80 of its $1.00 budget (80%)",
		"- fleet: budget — fleet spent $5.00 of its $5.00 budget (100%)",
	]);
	const log = doc.slice(doc.indexOf("## Log"));
	assert.deepEqual([...log.matchAll(/^- \S+ · (\w+) · (\S+)/gm)].map(match => `${match[1]}:${match[2]}`), ["spawn:api", "budget:api", "budget:fleet"]);
	assert.deepEqual(h.readLedger().budgetWarnings.map(entry => [entry.member, entry.text]), [["api", "member api spent $0.80 of its $1.00 budget (80%)"], [null, "fleet spent $5.00 of its $5.00 budget (100%)"]]);
});

// T3 (S2): standing permissions the human confirmed live in a Grants section;
// a protected dialog the fleet could not relay is a Blocker naming the member.
test("grants and relay blockers render in the document and persist in the ledger", () => {
	const h = harness();
	const path = h.ledger.setObjective("Channel", "Run the channel.");
	h.ledger.flush();
	assert.match(readFileSync(path, "utf8"), /^## Grants\n\nNone\.$/m);
	const first = h.ledger.grant("publish:social", "Publish scheduled posts on X and LinkedIn from the content calendar");
	const second = h.ledger.grant("publish:youtube", "Upload scheduled videos | shorts");
	assert.deepEqual([first.id, second.id], ["g1", "g2"]);
	h.ledger.blocker("web", "protected question cancelled — Allow recognized data-loss command? (no interactive UI to relay it)");
	h.ledger.flush();
	let doc = readFileSync(path, "utf8");
	const grants = doc.slice(doc.indexOf("## Grants"), doc.indexOf("## Log"));
	assert.match(grants, /^- g1 · `publish:social` — Publish scheduled posts on X and LinkedIn from the content calendar \(granted 2026-11-02T10:00:\d\d\.000Z\)$/m);
	assert.match(grants, /^- g2 · `publish:youtube` — Upload scheduled videos \| shorts/m);
	assert.match(doc.slice(doc.indexOf("## Blockers"), doc.indexOf("## Grants")), /^- web: protected question cancelled — Allow recognized data-loss command\? \(no interactive UI to relay it\)$/m);
	assert.deepEqual(h.ledger.grants.map(grant => grant.id), ["g1", "g2"]);
	assert.equal(h.ledger.revoke("g1")?.scope, "publish:social");
	assert.equal(h.ledger.revoke("g1"), undefined, "a revoked grant is gone");
	assert.equal(h.ledger.grant("publish:x", "Post on X").id, "g3", "grant ids are never reused");
	h.ledger.flush();
	doc = readFileSync(path, "utf8");
	assert.doesNotMatch(doc, /g1 ·/);
	const saved = h.readLedger();
	assert.deepEqual(saved.grants.map(grant => [grant.id, grant.scope]), [["g2", "publish:youtube"], ["g3", "publish:x"]]);
	assert.equal(saved.blockers.length, 1);
	assert.deepEqual(saved.log.filter(entry => entry.kind === "grant" || entry.kind === "revoke").map(entry => `${entry.kind}:${entry.text}`), ["grant:g1 publish:social", "grant:g2 publish:youtube", "revoke:g1 publish:social", "grant:g3 publish:x"]);
});

test("an escalated member question is a Blockers entry until it is resolved or its dialog is gone", () => {
	const h = harness();
	const path = h.ledger.setObjective("Escalations", "Ship it.");
	h.ledger.spawned("web", "Own the web front", "/work/web");
	h.ledger.escalate("web", { dialogId: "q1", method: "select", title: "Invite links expire after?", message: "copy and API must match", options: ["7 days", "30 days"] });
	h.ledger.escalate("web", { dialogId: "q2", method: "confirm", title: "Ship today?" });
	h.ledger.flush();
	const blockers = () => { const doc = readFileSync(path, "utf8"); return doc.slice(doc.indexOf("## Blockers"), doc.indexOf("## Grants")); };
	assert.match(blockers(), /^- web: escalated to the human — Invite links expire after\?$/m);
	assert.deepEqual(h.ledger.current.escalations.map(entry => [entry.member, entry.dialogId, entry.method]), [["web", "q1", "select"], ["web", "q2", "confirm"]]);
	assert.match(h.ledger.current.escalations[0].at, /^2026-11-02T10:00:\d\d\.000Z$/);
	assert.equal(h.ledger.resolveEscalation("web", "q1")?.title, "Invite links expire after?");
	assert.equal(h.ledger.resolveEscalation("web", "q1"), undefined, "resolved once");
	// The member answered or dropped q2 (settle, exit, fleet_answer): it leaves too.
	h.ledger.keepEscalations("web", []);
	h.ledger.flush();
	assert.doesNotMatch(blockers(), /escalated/);
	assert.deepEqual(h.readLedger().escalations, []);
	assert.deepEqual(h.ledger.current.log.filter(entry => entry.kind === "escalate").map(entry => entry.text), ["Invite links expire after?", "Ship today?"]);
});

test("every ledger change notifies the listener once, and keeping unchanged escalations notifies nothing", () => {
	let changes = 0;
	const h = harness({ onChange: () => { changes += 1; } });
	h.ledger.spawned("api", "Own the API", "/work/api");
	h.ledger.update("api", { status: "working", todo: null, tokens: 1, cost: 0, question: null, lastError: null });
	h.ledger.log("send", "api", "prompt: add tests");
	assert.equal(changes, 3);
	h.ledger.keepEscalations("api", []);
	assert.equal(changes, 3);
	assert.equal(h.ledger.current.members[0].status, "working");
});

// T6 (S2, S3, S5): a reopened fleet session loads its ledger instead of starting empty.
test("a saved ledger loads back whole and the restored ledger keeps writing the same document", () => {
	const h = harness();
	const document = h.ledger.setObjective("Billing API", "Ship billing.");
	h.ledger.spawned("api", "Own the API", "/work/api", { path: "/work/app.fleet/billing-api/api", branch: "fleet/billing-api/api" });
	h.ledger.update("api", { status: "working", todo: null, tokens: 900, cost: 0.85, question: null, lastError: null });
	h.ledger.budgetWarning("api", "member api spent $0.85 of its $1.00 budget (80%)", 80);
	h.ledger.retire(0.2);
	h.ledger.grant("publish:social", "Publish scheduled posts");
	h.ledger.autoApproved("api", "Allow guarded git push?", "yes");
	h.ledger.escalate("api", { dialogId: "q1", method: "select", title: "Pick a channel", options: ["X", "LinkedIn"] });
	h.ledger.interrupt(["api"]);
	h.ledger.flush();
	const saved = h.readLedger();
	assert.deepEqual(saved.interrupted, ["api"]);
	assert.equal(saved.retiredCost, 0.2);
	assert.equal(saved.budgetWarnings[0].threshold, 80);

	const loaded = loadFleetLedger(h.ledgerPath, "fleet-1");
	assert.ok(loaded);
	assert.deepEqual({ ...loaded, escalations: [] }, { ...saved, escalations: [] });
	assert.deepEqual(loaded.escalations, saved.escalations.map(entry => ({ ...entry, stale: true })), "a restored escalation's dialog closed with its member process");
	assert.equal(loadFleetLedger(h.ledgerPath, "other-session"), undefined, "another fleet session's ledger never loads");
	assert.equal(loadFleetLedger(join(h.root, "missing.json"), "fleet-1"), undefined);

	const writes: string[] = [];
	const restored = new FleetLedger({ fleetSessionId: "fleet-1", cwd: join(h.root, "elsewhere"), ledgerPath: h.ledgerPath, restored: loaded, schedule: () => () => {}, write: (path, text) => { writes.push(path); writeFileSync(path, text); } });
	assert.equal(restored.documentPath, document);
	assert.equal(restored.slug, "billing-api");
	restored.log("resume", null, "fleet reopened");
	restored.flush();
	assert.deepEqual(writes, [h.ledgerPath, document]);
	assert.match(readFileSync(document, "utf8"), /^- g1 · `publish:social`/m);
	restored.keepEscalations("api", []);
	assert.equal(restored.current.escalations.length, 1, "a member's new process never drops a restored escalation");
});

test("a ledger written before resume support loads with empty resume fields, and a corrupt one does not load", () => {
	const h = harness();
	h.ledger.spawned("api", "Own the API", "/work/api");
	h.ledger.flush();
	const { retiredCost: _retired, interrupted: _interrupted, ...older } = h.readLedger();
	writeFileSync(h.ledgerPath, JSON.stringify(older));
	const loaded = loadFleetLedger(h.ledgerPath, "fleet-1");
	assert.deepEqual([loaded?.retiredCost, loaded?.interrupted], [0, []]);
	writeFileSync(h.ledgerPath, "{oops");
	assert.equal(loadFleetLedger(h.ledgerPath, "fleet-1"), undefined);
});

// T8 (L54): the document shows new tokens and cost, not cache-inclusive totals.
test("the fleet document's members table and totals show new tokens and cost", () => {
	const h = harness();
	const path = h.ledger.setObjective("Swipe", "Build the swipe app.");
	h.ledger.spawned("swipe", "Own the app", "/work/swipe");
	h.ledger.update("swipe", { status: "exited", todo: { done: 0, total: 3, current: null }, tokens: 933200, newTokens: 51000, cacheRead: 882200, cost: 1.65, question: null, lastError: null });
	h.ledger.flush();
	const doc = readFileSync(path, "utf8");
	assert.match(doc, /^\| Member \| Owns \| Status \| Progress \| Current task \| New tokens \/ cost \| Waiting on \| Branch \| Worktree \|$/m);
	assert.match(doc, /^\| swipe \| Own the app \| exited \| 0\/3 \| — \| 51\.0k \/ \$1\.65 \| — \| — \| — \|$/m);
	assert.match(doc, /^Totals: 1 members \(0 live\) · 51\.0k new tok · \$1\.65$/m);
	assert.doesNotMatch(doc, /933\.2k/);
	const saved = h.readLedger().members[0];
	assert.deepEqual([saved.newTokens, saved.cacheRead], [51000, 882200], "the breakdown is kept in the ledger");
});

// T9 (S8): an adopted member keeps its own session file in the ledger, so a
// reopened fleet resumes it there; it shows in the document like any member.
test("an adopted member records its session file and adopted flag, logs the adoption and shows like any member", () => {
	const h = harness();
	const path = h.ledger.setObjective("Swipe", "Build the swipe app.");
	h.ledger.spawned("blog", "Adopted session \"Blog\"", "/work/blog", undefined, { sessionFile: "/home/.pi/agent/sessions/--work-blog--/2026_x.jsonl" });
	h.ledger.flush();
	const saved = h.readLedger().members[0];
	assert.deepEqual([saved.sessionFile, saved.adopted, saved.worktree, saved.branch], ["/home/.pi/agent/sessions/--work-blog--/2026_x.jsonl", true, null, null]);
	assert.equal(h.readLedger().log.at(-1)?.kind, "adopt");
	assert.match(readFileSync(path, "utf8"), /^\| blog \| Adopted session "Blog" \| starting \| — \| — \| 0 \/ \$0\.00 \| — \| — \| — \|$/m);
	const loaded = loadFleetLedger(h.ledgerPath, "fleet-1");
	assert.equal(loaded?.members[0].sessionFile, "/home/.pi/agent/sessions/--work-blog--/2026_x.jsonl");
});

test("previous behavior: a spawned member records no session file, and an older ledger without one still loads", () => {
	const h = harness();
	h.ledger.spawned("api", "Own the API", "/work/api");
	h.ledger.flush();
	const saved = h.readLedger();
	assert.deepEqual(Object.keys(saved.members[0]).filter(key => key === "sessionFile" || key === "adopted"), []);
	assert.equal(saved.log.at(-1)?.kind, "spawn");
	writeFileSync(h.ledgerPath, JSON.stringify({ ...saved, members: [{ ...saved.members[0], sessionFile: 42 }] }));
	const loaded = loadFleetLedger(h.ledgerPath, "fleet-1");
	assert.equal(loaded?.members[0].sessionFile, undefined, "a malformed session file is dropped, not trusted");
	assert.equal(loaded?.members[0].name, "api");
});
