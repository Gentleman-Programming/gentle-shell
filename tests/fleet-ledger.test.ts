import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FLEET_LOG_MAX, FleetLedger, fleetSlug, type FleetLedgerState } from "../lib/fleet-ledger.ts";

// odd/tasks/fleet-orchestrator.md S5: the fleet ledger lives in code and is
// rendered by code into one general ODD-style document; no model tokens.

// Scratch stays outside the worktree; it is reported, not removed.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gentle-fleet-ledger-")));
let counter = 0;

function harness(options: { write?: (path: string, text: string) => void } = {}) {
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
	assert.match(doc, /^\| Member \| Owns \| Status \| Progress \| Current task \| Tokens \/ cost \| Waiting on \| Branch \| Worktree \|$/m);
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
