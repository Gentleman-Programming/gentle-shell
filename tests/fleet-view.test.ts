import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	FLEET_DENSITIES,
	FLEET_LENSES,
	FLEET_VIEW_KEYS,
	attentionQueue,
	lensRows,
	objectiveProgress,
	type FleetViewSnapshot,
} from "../lib/fleet-view.ts";
import { EXPIRY, EXPIRY_OPTIONS, at, inkwellFleet, member } from "./support/fleet-view-fixture.ts";


const rowsOf = (snapshot: FleetViewSnapshot, lens: (typeof FLEET_LENSES)[number], density: (typeof FLEET_DENSITIES)[number]) =>
	lensRows(lens, density, snapshot).groups.flatMap((group) => group.rows);

test("objectiveProgress sums todos across members, rounds the percent and counts finished fronts", () => {
	const progress = objectiveProgress(inkwellFleet());
	assert.equal(progress.title, "Team workspaces for Inkwell");
	assert.deepEqual([progress.done, progress.total, progress.percent], [46, 93, 49]);
	assert.deepEqual([progress.frontsDone, progress.frontsTotal], [0, 5]);
	// Next step: the current todo of the first working member, unless the controller names one.
	assert.equal(progress.nextStep, "Add invite token table migration (api-migration)");
	assert.equal(objectiveProgress({ ...inkwellFleet(), nextStep: "invite token table" }).nextStep, "invite token table");

	const docsOnly = inkwellFleet();
	for (const m of docsOnly.members.filter((entry) => entry.front === "docs")) Object.assign(m, { status: "exited", exitCode: 0 });
	assert.equal(objectiveProgress(docsOnly).frontsDone, 1);
	assert.deepEqual(objectiveProgress({ title: null, objective: null, members: [], log: [] }), {
		title: "Untitled fleet", objective: null, done: 0, total: 0, percent: 0, frontsDone: 0, frontsTotal: 0, nextStep: null,
	});
});

test("attentionQueue ranks a decision, then a blocking failure, then reviews, with one focal item and then: N more", () => {
	const queue = attentionQueue(inkwellFleet());
	assert.deepEqual(queue.items.map((item) => item.kind), ["decision", "blocker", "review"]);
	assert.equal(queue.focal, queue.items[0]);
	assert.equal(queue.more, 2);
	assert.equal(queue.focal.title, EXPIRY);
	assert.deepEqual(queue.focal.members, ["web-invite-flow"]);
	assert.deepEqual(queue.focal.options, EXPIRY_OPTIONS);
	// The blocker is older (14:16) than the decision (14:18); rank still wins over age.
	assert.deepEqual(queue.items[1].members, ["billing-seats"]);
	// Reviews collapse into one item, oldest first.
	assert.deepEqual(queue.items[2].members, ["seed-data", "design-tokens", "docs-changelog"]);
});

test("attentionQueue breaks ties by oldest first and keeps member order for equal times", () => {
	const snapshot = inkwellFleet();
	const consent = { id: "api-roles-d1", method: "confirm", title: "Allow the destructive command: git reset --hard?", relayed: true, at: at(10) };
	snapshot.members.find((m) => m.name === "api-roles").dialogs = [consent];
	const queue = attentionQueue(snapshot);
	assert.deepEqual(queue.items.map((item) => item.members[0]), ["api-roles", "web-invite-flow", "billing-seats", "seed-data"]);
	assert.deepEqual(queue.items[0].options, ["Yes", "No"]);

	consent.at = at(18);
	assert.deepEqual(attentionQueue(snapshot).items.slice(0, 2).map((item) => item.members[0]), ["web-invite-flow", "api-roles"]);
});

test("resolving the focal item promotes the next one until nothing needs the user", () => {
	const snapshot = inkwellFleet();
	snapshot.escalations = [];
	const asker = snapshot.members.find((m) => m.name === "web-invite-flow");
	Object.assign(asker, { status: "working", dialogs: [], question: null });
	let queue = attentionQueue(snapshot);
	assert.equal(queue.focal.kind, "blocker");
	assert.equal(queue.more, 1);

	// The fleet respawned the failed member.
	Object.assign(snapshot.members.find((m) => m.name === "billing-seats"), { status: "working", exitCode: null, exitedAt: null, lastError: null });
	queue = attentionQueue(snapshot);
	assert.equal(queue.focal.kind, "review");
	assert.equal(queue.more, 0);

	for (const m of snapshot.members) delete m.review;
	queue = attentionQueue(snapshot);
	assert.equal(queue.focal.kind, "nothing");
	assert.equal(queue.more, 0);
	assert.deepEqual(queue.items, []);
	assert.match(queue.focal.ask, /next update around 14:40, when the invite token table lands/);
	assert.doesNotMatch(attentionQueue({ ...snapshot, nextUpdate: undefined }).focal.ask, /next update/);
});

test("a member is blocked when it failed, and done when it exited cleanly or the fleet stopped it", () => {
	const snapshot = inkwellFleet();
	const idle = snapshot.members.find((m) => m.name === "docs-api-ref");
	idle.lastError = "prompt failed: model overloaded";
	const stopped = snapshot.members.find((m) => m.name === "security-review");
	Object.assign(stopped, { status: "exited", exitCode: null, exitSignal: "SIGTERM", exitedAt: at(20) });
	snapshot.log.push({ at: at(19), kind: "stop", member: "security-review", text: "stopped by the fleet" });
	const crashed = snapshot.members.find((m) => m.name === "mobile-layout");
	Object.assign(crashed, { status: "exited", exitCode: null, exitSignal: "SIGKILL", exitedAt: at(21) });
	const states = Object.fromEntries(rowsOf(snapshot, "flows", "normal").map((row) => [row.name, row.state]));
	assert.equal(states["docs-api-ref"], "blocked");
	assert.equal(states["security-review"], "done");
	assert.equal(states["mobile-layout"], "blocked");
	assert.equal(states["billing-seats"], "blocked");
	assert.equal(states["seed-data"], "done");
});

test("every lens and density shows the same member rows in the same attention-first order", () => {
	const snapshot = inkwellFleet();
	const view = lensRows("flows", "light", snapshot);
	assert.deepEqual(view.groups.map((group) => [group.label, group.count]), [["Needs you", 1], ["Blocked", 1], ["Working", 10], ["Waiting on others", 5], ["Done", 3]]);
	const order = rowsOf(snapshot, "flows", "light").map((row) => row.name);
	assert.equal(order.length, 20);
	assert.deepEqual(order.slice(0, 3), ["web-invite-flow", "billing-seats", "api-migration"]);
	for (const lens of FLEET_LENSES) for (const density of FLEET_DENSITIES) {
		assert.deepEqual(rowsOf(snapshot, lens, density).map((row) => row.name), order, `${lens}/${density}`);
	}
});

test("the focal member is marked in every lens and the mark follows promotion", () => {
	const snapshot = inkwellFleet();
	for (const lens of FLEET_LENSES) {
		assert.deepEqual(rowsOf(snapshot, lens, "light").filter((row) => row.focal).map((row) => row.name), ["web-invite-flow"], lens);
	}
	snapshot.escalations = [];
	Object.assign(snapshot.members[0], { status: "working", dialogs: [] });
	for (const lens of FLEET_LENSES) {
		assert.deepEqual(rowsOf(snapshot, lens, "normal").filter((row) => row.focal).map((row) => row.name), ["billing-seats"], lens);
	}
});

test("density picks the fields per row as 05 describes", () => {
	const snapshot = inkwellFleet();
	const keys = (lens: (typeof FLEET_LENSES)[number], density: (typeof FLEET_DENSITIES)[number], name: string) =>
		rowsOf(snapshot, lens, density).find((row) => row.name === name).cells.map((cell) => cell.key);
	assert.deepEqual(keys("flows", "light", "web-invite-flow"), ["pointer"]);
	assert.deepEqual(keys("flows", "light", "api-migration"), []);
	assert.deepEqual(keys("flows", "normal", "api-migration"), ["task"]);
	assert.deepEqual(keys("flows", "normal", "web-invite-flow"), ["pointer"]);
	assert.deepEqual(keys("flows", "power", "api-migration"), ["gauge", "progress", "task", "cost"]);
	assert.deepEqual(keys("map", "light", "api-migration"), ["track", "progress"]);
	assert.deepEqual(keys("map", "normal", "api-migration"), ["track", "progress", "station"]);
	for (const density of FLEET_DENSITIES) {
		assert.deepEqual(keys("costs", density, "api-migration"), ["cost", "tokens", "cached", "share"]);
		assert.deepEqual(keys("log", density, "api-migration"), ["time", "event"]);
	}
	assert.equal(rowsOf(snapshot, "flows", "normal").find((row) => row.name === "api-migration").cells[0].text, "Add invite token table migration");
	// Warning and error tones start at normal; front hues only in power.
	const row = (density: (typeof FLEET_DENSITIES)[number], name: string) => rowsOf(snapshot, "flows", density).find((entry) => entry.name === name);
	assert.equal(row("light", "billing-seats").tone, null);
	assert.equal(row("normal", "billing-seats").tone, "error");
	assert.equal(row("normal", "web-invite-flow").tone, "warning");
	assert.equal(row("normal", "api-migration").hue, null);
	assert.equal(typeof row("power", "api-migration").hue, "number");
	// Group aggregates appear from normal on.
	assert.equal(lensRows("map", "light", snapshot).groups[2].summary, null);
	assert.equal(lensRows("map", "normal", snapshot).groups[2].summary, "26/58 todos");
});

test("costs appear only in the costs lens and in power density", () => {
	const snapshot = inkwellFleet();
	const COST_KEYS = new Set(["cost", "tokens", "cached", "share"]);
	for (const lens of FLEET_LENSES) for (const density of FLEET_DENSITIES) {
		const view = lensRows(lens, density, snapshot);
		const texts = [...view.head, ...view.groups.map((group) => group.summary ?? ""), ...view.groups.flatMap((group) => group.rows.flatMap((row) => row.cells.map((cell) => cell.text)))];
		const keys = view.groups.flatMap((group) => group.rows.flatMap((row) => row.cells.map((cell) => cell.key)));
		const shows = keys.some((key) => COST_KEYS.has(key)) || texts.some((text) => text.includes("$"));
		if (shows) assert.ok(lens === "costs" || density === "power", `${lens}/${density} shows no costs`);
		if (lens === "costs" || (lens === "flows" && density === "power")) assert.ok(shows, `${lens}/${density} shows costs`);
	}
	assert.match(lensRows("costs", "light", snapshot).head[0], /\$\d+\.\d\d of \$40\.00/);
});

// Pi's default bindings, quoted from node_modules/@earendil-works/pi-coding-agent/docs/keybindings.md.
const PI_DOC_LINES = [
	"| `app.exit` | `ctrl+d` | Exit (when editor empty) |",
	"| `app.thinking.toggle` | `ctrl+t` | Collapse or expand thinking blocks |",
	"| `app.model.select` | `ctrl+l` | Open model selector |",
	"| `tui.input.tab` | `tab` | Tab or autocomplete |",
];

test("fleet keys never take one of Pi's default bindings, except the declared tab share", () => {
	const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@earendil-works", "pi-coding-agent", "docs", "keybindings.md"), "utf8");
	for (const line of PI_DOC_LINES) assert.ok(doc.split("\n").includes(line), `keybindings.md still has: ${line}`);
	const reserved = new Map<string, string[]>();
	for (const line of doc.split("\n")) {
		const match = /^\| `([\w.]+)` \| (.+?) \| /.exec(line);
		if (!match) continue;
		for (const [, key] of match[2].matchAll(/`([^`]+)`/g)) reserved.set(key.toLowerCase(), [...(reserved.get(key.toLowerCase()) ?? []), match[1]]);
	}
	assert.ok(reserved.get("ctrl+d")?.includes("app.exit"));
	const shares: string[] = [];
	for (const binding of FLEET_VIEW_KEYS) for (const key of binding.keys) {
		const taken = reserved.get(key.toLowerCase()) ?? [];
		if (binding.sharesPiAction) {
			assert.deepEqual(taken, [binding.sharesPiAction], `${key} declares the Pi action it shares`);
			assert.ok(binding.when, `${key} says when the fleet takes it`);
			shares.push(key);
		} else assert.deepEqual(taken, [], `${key} (${binding.action}) is free in Pi`);
	}
	assert.deepEqual([...new Set(shares)], ["tab"]);
	const all = FLEET_VIEW_KEYS.flatMap((binding) => binding.keys);
	for (const key of ["f1", "f2", "f3", "f4", "f", "m", "$", "l", "alt+m", "tab", "1", "2", "3", "4", "z", "?"]) assert.ok(all.includes(key), key);
});
