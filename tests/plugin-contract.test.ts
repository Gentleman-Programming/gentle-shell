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
import type { Contribution, ContributionReport, PluginPaletteCommand, PluginRow } from "../lib/plugin-contract.ts";

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

test("a later set for an existing id is refused: the first payload wins and the duplicate is reported", () => {
	reset();
	const slot = contributionSlot();
	const first = contribution({ id: "acme.hello", rows: [row({ category: "First" })], palette: { command: "acme:hello", group: "First" } });
	const second = contribution({ id: "acme.hello", rows: [row({ category: "Second" })], palette: { command: "acme:hello", group: "Second" } });
	slot.set("acme.hello", first);
	slot.set("acme.hello", second);

	assert.equal(slot.get("acme.hello"), first, "the first contribution stays in the box");
	const loaded = readContributions();
	assert.equal(loaded.length, 1);
	assert.equal(loaded[0].rows?.[0].category, "First");
	assert.equal(loaded[0].palette?.group, "First");

	const report = readContributionReport();
	assert.deepEqual(report.replaced, ["acme.hello"]);
	assert.deepEqual(report.skipped.map((entry) => [entry.id, entry.code]), [["acme.hello", "duplicate-id"]]);
	assert.match(report.skipped[0].detail, /first/);
	assert.deepEqual(readContributionReport(), report, "repeated reads report the same refusal");
});

test("re-setting the same stored entry still reports the id as replaced without a duplicate-id issue", () => {
	reset();
	const slot = contributionSlot();
	const stored = contribution({ id: "acme.hello", rows: [row({ category: "Only" })] });
	slot.set("acme.hello", stored);
	slot.set("acme.hello", stored);

	const loaded = readContributions();
	assert.equal(loaded.length, 1);
	assert.equal(loaded[0].rows?.[0].category, "Only");
	const report = readContributionReport();
	assert.deepEqual(report.replaced, ["acme.hello"]);
	assert.deepEqual(report.skipped, []);
});

test("the documented session_start guard registers once and reports no duplicate", () => {
	reset();
	// gentle-pi claims the box while it loads, before any session starts.
	contributionSlot();

	const answered: number[] = [];
	const sessionStart = (session: number): void => {
		const holder = globalThis as unknown as { [key: symbol]: unknown };
		const box = holder[CONTRIBUTIONS] instanceof Map
			? (holder[CONTRIBUTIONS] as Map<string, Contribution>)
			: new Map<string, Contribution>();
		holder[CONTRIBUTIONS] = box;
		// The guard the documentation teaches, copied from its example.
		if (box.has("acme.hello")) return;
		box.set("acme.hello", contribution({
			id: "acme.hello",
			rows: [row({ action: () => { answered.push(session); } })],
		}));
	};

	sessionStart(1);
	const first = readContributions();
	const firstReport = readContributionReport();
	sessionStart(2);
	const second = readContributions();
	const secondReport = readContributionReport();

	assert.deepEqual([firstReport, secondReport], [
		{ skipped: [], replaced: [] },
		{ skipped: [], replaced: [] },
	], "the guarded pattern never produces a duplicate-id refusal");
	assert.deepEqual(first.map((entry) => entry.id), ["acme.hello"]);
	assert.deepEqual(second.map((entry) => entry.id), ["acme.hello"]);
	second[0].rows?.[0].action();
	assert.deepEqual(answered, [1], "the first session_start's payload is the one that answers");
});

test("a payload getter that throws is an invalid-contribution report, never an exception", () => {
	reset();
	const slot = contributionSlot();
	slot.set("acme.rows", raw({
		id: "acme.rows",
		owner: "acme",
		contract: 1,
		get rows(): PluginRow[] {
			throw new Error("rows getter");
		},
	}));
	slot.set("acme.palette", raw({
		id: "acme.palette",
		owner: "acme",
		contract: 1,
		rows: [row()],
		get palette(): unknown {
			throw new Error("palette getter");
		},
	}));
	slot.set("acme.row", raw({
		id: "acme.row",
		owner: "acme",
		contract: 1,
		rows: [{
			category: "Acme",
			label: "Hi",
			action: noop,
			get visible(): boolean {
				throw new Error("visible getter");
			},
		}],
	}));
	slot.set("acme.ok", contribution({ id: "acme.ok", palette: { command: "acme:ok", group: "Acme" } }));

	let loaded: Contribution[] = [];
	assert.doesNotThrow(() => {
		loaded = readContributions();
	});
	assert.deepEqual(loaded.map((entry) => entry.id), ["acme.ok"]);

	// A palette reader reads these fields directly: every stored payload is plain data.
	assert.doesNotThrow(() => {
		for (const entry of loaded) {
			void entry.id;
			void entry.owner;
			void entry.contract;
			for (const entryRow of entry.rows ?? []) {
				void entryRow.category;
				void entryRow.label;
				void entryRow.preview;
				void entryRow.choice;
				void entryRow.visible;
				void entryRow.action;
			}
			void entry.palette?.command;
			void entry.palette?.group;
			void entry.sidebar?.key;
			void entry.sidebar?.bottom;
			void entry.sidebar?.rail;
		}
	});
	assert.deepEqual(readContributionReport().skipped.map((entry) => [entry.id, entry.code]), [
		["acme.rows", "invalid-contribution"],
		["acme.palette", "invalid-contribution"],
		["acme.row", "invalid-contribution"],
	]);
});

test("a missing, empty or whitespace-only palette group loads with the palette payload intact", () => {
	reset();
	const slot = contributionSlot();
	const palettes: Array<[string, PluginPaletteCommand]> = [
		["acme.missing", { command: "acme:missing" }],
		["acme.empty", { command: "acme:empty", group: "" }],
		["acme.blank", { command: "acme:blank", group: " \t " }],
	];
	for (const [id, palette] of palettes) slot.set(id, { id, owner: "acme", contract: CONTRACT_VERSION, palette });

	const loaded = readContributions();
	assert.deepEqual(
		loaded.map((entry) => entry.palette),
		palettes.map(([, palette]) => ({ ...palette })),
	);
	assert.deepEqual(readContributionReport().skipped, []);
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

test("a row stored as a class instance keeps the prototype callbacks the contract declared", () => {
	reset();
	// A class instance passes validation (its methods are callable through the
	// prototype), so the copy must carry those fields explicitly: spreading the
	// row would silently drop `action`, `preview`, `visible` and `current`.
	class Choice {
		setting = "Switch";
		value = "on";
		current(): boolean { return true; }
	}
	class Row {
		category = "Acme";
		label = "Class row";
		choice = new Choice();
		action(): void {}
		visible(): boolean { return true; }
		preview(): { title: string; sample: string } { return { title: "Title", sample: "Sample" }; }
	}
	const instance = new Row();
	const slot = contributionSlot();
	slot.set("acme.classy", { id: "acme.classy", owner: "acme", contract: CONTRACT_VERSION, rows: [instance as unknown as PluginRow] });

	const row = readContributions()[0]!.rows![0]!;
	assert.equal(row.category, "Acme");
	assert.equal(row.label, "Class row");
	assert.equal(row.action, instance.action, "the prototype action survives the copy");
	assert.equal(row.preview, instance.preview, "the prototype preview survives the copy");
	assert.equal(row.visible, instance.visible, "the prototype visible survives the copy");
	assert.equal(row.choice?.current, instance.choice.current, "the prototype current survives the copy");
	assert.deepEqual(row.choice, { setting: "Switch", value: "on", current: instance.choice.current });
	assert.deepEqual(readContributionReport().skipped, []);
});

test("a plain-object row keeps every declared field, hint and applyOnMove included", () => {
	reset();
	// The previous behaviour of the copy: every optional field the contract
	// declares survives, including the ones the adapter only reads.
	const stored = contribution({
		id: "acme.plain",
		rows: [row({
			preview: () => ({ title: "Plain", sample: "Plain sample" }),
			visible: () => true,
			choice: { setting: "Switch", value: "on", current: () => false, hint: "A hint", applyOnMove: true },
		})],
	});
	contributionSlot().set(stored.id, stored);
	const copied = readContributions()[0]!.rows![0]!;
	assert.equal(copied.label, "Hello");
	assert.equal(copied.action, stored.rows![0]!.action);
	assert.deepEqual(copied.preview!(), { title: "Plain", sample: "Plain sample" });
	assert.equal(copied.visible?.(), true);
	assert.deepEqual({ ...copied.choice, current: copied.choice!.current() }, {
		setting: "Switch", value: "on", current: false, hint: "A hint", applyOnMove: true,
	});
	assert.equal(stored.rows![0]!.choice!.hint, "A hint", "the stored entry is untouched");
});
