import assert from "node:assert/strict";
import test from "node:test";
import {
	CONTRACT_VERSION,
	CONTRIBUTIONS,
	contributionSlot,
	guard,
	readContributionReport,
	readContributions,
	setContributionReporter,
} from "../lib/plugin-contract.ts";
import type { Contribution, ContributionReport, PluginRow } from "../lib/plugin-contract.ts";

const noop = (): void => {};

function reset(): void {
	delete (globalThis as unknown as { [key: symbol]: unknown })[CONTRIBUTIONS];
}

function row(overrides: Partial<PluginRow> = {}): PluginRow {
	return { category: "Acme", label: "Hello", action: noop, ...overrides };
}

function contribution(overrides: Partial<Contribution> = {}): Contribution {
	const owner = overrides.owner ?? "acme";
	return {
		id: `${owner}.hello`,
		owner,
		contract: CONTRACT_VERSION,
		rows: [row()],
		...overrides,
	};
}

/** A deliberately malformed payload, as a foreign package could store it. */
function raw(value: Record<string, unknown>): Contribution {
	return value as unknown as Contribution;
}

test("an absent or empty box reads as an empty list and never throws", () => {
	reset();
	assert.deepEqual(readContributions(), []);
	assert.deepEqual(readContributions({ order: ["acme"] }), []);
	assert.deepEqual([...contributionSlot().keys()], []);
	assert.deepEqual(readContributions(), []);

	reset();
	(globalThis as unknown as { [key: symbol]: unknown })[CONTRIBUTIONS] = { not: "a map" };
	assert.deepEqual(readContributions(), []);
	assert.deepEqual([...contributionSlot().keys()], []);
});

test("the box is a versioned symbol a foreign package can fill without importing this module", () => {
	assert.equal(CONTRACT_VERSION, 1);
	assert.equal(CONTRIBUTIONS, Symbol.for("gentle-pi.contributions/v1"));

	reset();
	(globalThis as unknown as { [key: symbol]: unknown })[Symbol.for("gentle-pi.contributions/v1")] = new Map([
		["acme.plain", { id: "acme.plain", owner: "acme", contract: 1, palette: { command: "acme:plain", group: "Acme" } }],
	]);
	const loaded = readContributions();
	assert.deepEqual(loaded.map((entry) => entry.id), ["acme.plain"]);
	assert.deepEqual(loaded[0].palette, { command: "acme:plain", group: "Acme" });
});

test("a contribution from another contract version is skipped and reported", () => {
	reset();
	const slot = contributionSlot();
	slot.set("acme.v2", contribution({ id: "acme.v2", contract: 2 }));
	slot.set("acme.missing", contribution({ id: "acme.missing", contract: undefined as unknown as number }));
	slot.set("acme.ok", contribution({ id: "acme.ok" }));

	assert.deepEqual(readContributions().map((entry) => entry.id), ["acme.ok"]);
	const skipped = readContributionReport().skipped;
	assert.deepEqual(skipped.map((issue) => [issue.id, issue.code]), [
		["acme.v2", "incompatible-contract"],
		["acme.missing", "incompatible-contract"],
	]);
	assert.match(skipped[0].detail, /contract/);
});

test("ids must be namespaced by their owner and match the slot key", () => {
	reset();
	const slot = contributionSlot();
	slot.set("acme.ok", contribution({ id: "acme.ok", owner: "acme" }));
	slot.set("acme.key", contribution({ id: "acme.other", owner: "acme" }));
	slot.set("acme", contribution({ id: "acme", owner: "acme" }));
	slot.set(".name", contribution({ id: ".name", owner: "" }));
	slot.set("acme.", contribution({ id: "acme.", owner: "acme" }));
	slot.set("other.foreign", contribution({ id: "other.foreign", owner: "acme" }));

	assert.deepEqual(readContributions().map((entry) => entry.id), ["acme.ok"]);
	const skipped = readContributionReport().skipped;
	assert.deepEqual(skipped.map((issue) => issue.id), ["acme.key", "acme", ".name", "acme.", "other.foreign"]);
	assert.ok(skipped.every((issue) => issue.code === "invalid-id"));
});

test("a later set on an existing id replaces it and the reader reports the id", () => {
	reset();
	const slot = contributionSlot();
	slot.set("acme.hello", contribution({ id: "acme.hello", rows: [row({ category: "Old" })] }));
	slot.set("acme.hello", contribution({ id: "acme.hello", rows: [row({ category: "New" })] }));

	const loaded = readContributions();
	assert.equal(loaded.length, 1);
	assert.equal(loaded[0].rows?.[0].category, "New");
	assert.deepEqual(readContributionReport().replaced, ["acme.hello"]);
	assert.deepEqual(readContributionReport().replaced, ["acme.hello"]);
});

test("malformed payloads are dropped and reported while the rest of the contribution loads", () => {
	reset();
	const slot = contributionSlot();
	slot.set("acme.rows", raw({
		id: "acme.rows",
		owner: "acme",
		contract: 1,
		rows: [{ category: "Acme", action: noop }],
		palette: { command: "acme:rows", group: "Acme" },
	}));
	slot.set("acme.sidebar", raw({
		id: "acme.sidebar",
		owner: "acme",
		contract: 1,
		rows: [row()],
		sidebar: { key: "", bottom: "yes", rail: {} },
	}));
	slot.set("acme.palette", raw({
		id: "acme.palette",
		owner: "acme",
		contract: 1,
		rows: [row()],
		sidebar: { key: "acme.sidebar", bottom: true, rail: {} },
		palette: { command: 7, group: "Acme" },
	}));
	slot.set("acme.valid", contribution({ id: "acme.valid" }));

	const loaded = new Map<string, Contribution>(readContributions().map((entry): [string, Contribution] => [entry.id, entry]));
	assert.deepEqual([...loaded.keys()], ["acme.rows", "acme.sidebar", "acme.palette", "acme.valid"]);
	assert.equal(loaded.get("acme.rows")?.rows, undefined);
	assert.deepEqual(loaded.get("acme.rows")?.palette, { command: "acme:rows", group: "Acme" });
	assert.equal(loaded.get("acme.sidebar")?.sidebar, undefined);
	assert.deepEqual(loaded.get("acme.sidebar")?.rows?.map((entry) => entry.category), ["Acme"]);
	assert.equal(loaded.get("acme.palette")?.palette, undefined);
	assert.deepEqual(loaded.get("acme.palette")?.sidebar, { key: "acme.sidebar", bottom: true, rail: {} });
	assert.deepEqual(readContributionReport().skipped.map((issue) => [issue.id, issue.code]), [
		["acme.rows", "malformed-rows"],
		["acme.sidebar", "malformed-sidebar"],
		["acme.palette", "malformed-palette"],
	]);
});

test("repeated reads return the same result and leave stored entries untouched", () => {
	reset();
	const slot = contributionSlot();
	const stored = contribution({ id: "acme.hello", rows: [row()], palette: { command: "acme:hello", group: "Acme" } });
	slot.set(stored.id, stored);

	const first = readContributions();
	const second = readContributions();
	assert.deepEqual(first, second);
	assert.equal(slot.get(stored.id), stored);
	assert.equal(stored.rows?.length, 1);

	first[0].rows?.pop();
	first[0].palette!.group = "Mutated";
	assert.equal(stored.rows?.length, 1);
	assert.equal(stored.palette?.group, "Acme");
	assert.deepEqual(readContributions()[0], second[0]);
});

test("owner order wins over insertion order and stays deterministic", () => {
	reset();
	const slot = contributionSlot();
	for (const id of ["a.one", "b.one", "c.one", "a.two"]) {
		const owner = id.split(".")[0];
		slot.set(id, { id, owner, contract: CONTRACT_VERSION, palette: { command: `${owner}:${id.split(".")[1]}`, group: owner } });
	}
	assert.deepEqual(readContributions().map((entry) => entry.id), ["a.one", "b.one", "c.one", "a.two"]);
	assert.deepEqual(readContributions({ order: ["c", "a"] }).map((entry) => entry.id), ["c.one", "a.one", "a.two", "b.one"]);
	assert.deepEqual(readContributions({ order: ["c", "a", "c", "missing"] }).map((entry) => entry.id), ["c.one", "a.one", "a.two", "b.one"]);
});

test("guard returns the fallback and reports a synchronous failure", () => {
	const errors: unknown[] = [];
	const boom = new Error("sync");
	assert.equal(guard(() => { throw boom; }, "fallback", (error) => errors.push(error)), "fallback");
	assert.deepEqual(errors, [boom]);
	assert.equal(guard(() => "value", "fallback", () => assert.fail("onError must not run")), "value");
});

test("guard returns the fallback and reports a rejected async action", async () => {
	const errors: unknown[] = [];
	const boom = new Error("async");
	assert.equal(await guard(async () => { throw boom; }, "fallback", (error) => errors.push(error)), "fallback");
	assert.deepEqual(errors, [boom]);
	assert.equal(await guard(async () => "value", "fallback", () => assert.fail("onError must not run")), "value");
});

test("the reporter sink receives skips while the default stays silent on stdout", () => {
	reset();
	const reports: ContributionReport[] = [];
	setContributionReporter((report) => reports.push(report));
	contributionSlot().set("acme.v2", contribution({ id: "acme.v2", contract: 2 }));
	readContributions();
	assert.equal(reports.length, 1);
	assert.equal(reports[0].skipped[0].id, "acme.v2");

	setContributionReporter(undefined);
	const writes: string[] = [];
	const original = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		writes.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	try {
		readContributions();
	} finally {
		process.stdout.write = original;
	}
	assert.deepEqual(writes, []);
	assert.equal(reports.length, 1);
});
