import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import type { TUI } from "@earendil-works/pi-tui";
import { CONTRIBUTIONS, CONTRACT_VERSION, contributionSlot, readContributionReport } from "../lib/plugin-contract.ts";
import type { Contribution, PluginRail } from "../lib/plugin-contract.ts";
import { PLUGINS_SCHEMA } from "../lib/plugin-order.ts";
import {
	installContributedSidebar,
	readSidebarContributionReport,
	SIDEBAR_SECTION_KEYS,
	sidebarPart,
	sidebarSectionOrder,
	sidebarState,
} from "../lib/shell-sidebar.ts";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";

// Canary for the sidebar read point (spec S2/S5/S9): a refactor that drops the
// plugin seam makes these tests fail, while an empty box stays a no-op.

const NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function reset(): void {
	delete (globalThis as unknown as { [key: symbol]: unknown })[CONTRIBUTIONS];
}

function fixture(columns = 140) {
	const root = { render: () => ["transcript"], invalidate() {}, [NODE]: () => ({ type: "vstack", entries: [] }) };
	const host = { mode: "fullscreen", terminal: { columns }, layoutRoot: root, requestRender() {} };
	return { host, tui: host as unknown as TUI, root };
}

// The public rail type is what a plugin author writes against: a `render` is
// enough, `digest` and `invalidate` stay optional, and the runtime shape check
// below still decides what installs.
function pluginRail(name: string): PluginRail {
	return { render: () => [`${name} card`], invalidate() {} };
}

function contribute(key: string, name = "notes", owner = "acme"): Contribution {
	return {
		id: `${owner}.${name}`,
		owner,
		contract: CONTRACT_VERSION,
		sidebar: { key, bottom: false, rail: pluginRail(name) },
	};
}

test("a contributed section reaches the painted rail through the layout's own prepare path", (t) => {
	reset();
	t.after(reset);
	const f = fixture();
	// The contribution is only in the box: nothing installs the rail by hand, so
	// dropping the layout's prepare path leaves the parts map and the rail empty.
	contributionSlot().set("acme.notes", contribute("plugin:acme:notes"));
	sidebarPart(f.tui, "footer", { render: () => ["Status"], invalidate() {} });

	t.after(installSidebar(f.tui, theme));
	const text = renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n");
	assert.ok(sidebarState(f.tui).parts.has("plugin:acme:notes"), "the layout installs the contributed rail into the shared parts map");
	const footer = text.indexOf("Status");
	const contributed = text.indexOf("notes card");
	assert.ok(footer >= 0 && contributed >= 0, `both sections paint: ${text}`);
	assert.ok(footer < contributed, `the contributed section paints after the known ones: ${text}`);
	assert.deepEqual([...sidebarState(f.tui).parts.keys()], ["footer", "plugin:acme:notes"], "the core sections stay first");
});

test("a throwing plugin digest is reported and the section still paints", (t) => {
	reset();
	t.after(reset);
	const f = fixture();
	const contribution: Contribution = {
		id: "acme.notes",
		owner: "acme",
		contract: CONTRACT_VERSION,
		sidebar: {
			key: "plugin:acme:notes",
			bottom: false,
			rail: {
				render: () => ["notes card"],
				invalidate() {},
				digest: () => {
					throw new Error("digest exploded");
				},
			},
		},
	};
	contributionSlot().set("acme.notes", contribution);
	sidebarPart(f.tui, "footer", { render: () => ["Status"], invalidate() {} });

	t.after(installSidebar(f.tui, theme));
	const text = renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n");
	assert.ok(text.includes("notes card"), `a broken digest does not change what paints: ${text}`);
	assert.deepEqual(readSidebarContributionReport().skipped.map((issue) => [issue.id, issue.code, issue.detail]), [
		["acme.notes", "invalid-contribution", "digest exploded"],
	]);
});

test("a report written by this module evaluation is readable from the next one", async (t) => {
	reset();
	t.after(reset);
	const f = fixture();
	// Pi evaluates every extension with `moduleCache: false`: `/gentle:plugins`
	// can hold another instance of this module, so the report must live in the
	// process-wide slot, not in module-local state.
	contributionSlot().set("acme.notes", contribute("todo"));
	installContributedSidebar(f.tui);
	const report = readSidebarContributionReport();
	assert.deepEqual(report.skipped.map((issue) => issue.id), ["acme.notes"]);

	// A distinct module instance, exactly like a second extension evaluation.
	const isolatedUrl = new URL(`../lib/shell-sidebar.ts?isolated=${process.pid}-${Date.now()}`, import.meta.url).href;
	const isolated = await import(isolatedUrl);
	assert.notEqual(isolated.readSidebarContributionReport, readSidebarContributionReport, "the second evaluation is a separate instance");
	assert.deepEqual(isolated.readSidebarContributionReport().skipped.map((issue) => issue.id), ["acme.notes"]);

	// Reads stay copies: a caller cannot mutate the shared report.
	const copy = isolated.readSidebarContributionReport();
	copy.skipped.push({ id: "acme.tampered", code: "invalid-contribution", detail: "tampered" });
	copy.replaced.push("acme.tampered");
	assert.deepEqual(readSidebarContributionReport(), report);
});

test("a contribution claiming a core key is rejected and reported, leaving the core order and part intact", (t) => {
	reset();
	t.after(reset);
	const f = fixture();
	const coreRail = { render: () => ["Todo card"], invalidate() {} };
	sidebarPart(f.tui, "todo", { render: () => ["todo"], invalidate() {} }, coreRail);
	contributionSlot().set("acme.notes", contribute("todo"));
	contributionSlot().set("acme.other", contribute("acme:other", "other"));

	const applied = installContributedSidebar(f.tui);
	assert.deepEqual(applied.keys, []);
	assert.deepEqual(applied.rejected.map((issue) => [issue.id, issue.code]), [
		["acme.notes", "malformed-sidebar"],
		["acme.other", "malformed-sidebar"],
	]);
	assert.deepEqual(readSidebarContributionReport().skipped.map((issue) => issue.id), ["acme.notes", "acme.other"]);
	assert.equal(sidebarState(f.tui).parts.get("todo"), coreRail, "a plugin never replaces a core part");
	assert.deepEqual(sidebarSectionOrder(applied.keys), [...SIDEBAR_SECTION_KEYS]);
});

test("editing owner order changes the next painted frame", (t) => {
	reset();
	const home = mkdtempSync(join(tmpdir(), "gentle-sidebar-order-"));
	const previous = process.env.GENTLE_PI_CONFIG_HOME;
	// The layout reads the real config home, so the declared order comes from
	// this scratch directory and an edit is visible without a reload.
	process.env.GENTLE_PI_CONFIG_HOME = home;
	t.after(() => {
		reset();
		if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	});
	const f = fixture();
	// Registration order never changes: only plugins.json decides the paint order.
	contributionSlot().set("zeta.notes", contribute("plugin:zeta:notes", "notes", "zeta"));
	contributionSlot().set("acme.other", contribute("plugin:acme:other", "other", "acme"));
	sidebarPart(f.tui, "footer", { render: () => ["Status"], invalidate() {} });

	const declared = (order: readonly string[]): void => {
		writeFileSync(join(home, "plugins.json"), `${JSON.stringify({ schema: PLUGINS_SCHEMA, order })}\n`);
	};
	const painted = () => {
		const text = renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n");
		return { text, acme: text.indexOf("other card"), zeta: text.indexOf("notes card") };
	};

	t.after(installSidebar(f.tui, theme));
	declared(["acme"]);
	const acmeFirst = painted();
	assert.ok(acmeFirst.acme >= 0 && acmeFirst.zeta >= 0, `both sections paint: ${acmeFirst.text}`);
	assert.ok(acmeFirst.acme < acmeFirst.zeta, `plugins.json names acme first: ${acmeFirst.text}`);

	declared(["zeta"]);
	const zetaFirst = painted();
	assert.ok(zetaFirst.acme >= 0 && zetaFirst.zeta >= 0, `both sections still paint: ${zetaFirst.text}`);
	assert.ok(zetaFirst.zeta < zetaFirst.acme, `the next frame follows the edited file: ${zetaFirst.text}`);
});

test("an order read happens only while the box declares a sidebar", (t) => {
	reset();
	t.after(reset);
	const f = fixture();
	const home = mkdtempSync(join(tmpdir(), "gentle-sidebar-order-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	// The injected home is the only thing the order reader resolves, so a getter
	// makes the read itself observable with no file, FIFO or non-portable trick:
	// a frame that must not read the order never touches it.
	let reads = 0;
	const options = {
		get gentlePiConfigHome(): string {
			reads++;
			return home;
		},
	};

	// A non-empty box whose contribution declares no sidebar payload cannot be
	// reordered by plugins.json, so an ordinary frame pays no I/O for it.
	contributionSlot().set("acme.rows", { id: "acme.rows", owner: "acme", contract: CONTRACT_VERSION, rows: [{ category: "Plugins", label: "Row", action() {} }] });
	assert.deepEqual(installContributedSidebar(f.tui, options).keys, []);
	assert.equal(reads, 0, "no sidebar contribution: the order is never read");

	// A throwing `sidebar` property counts as "no sidebar" too; validation reports it.
	const broken = { id: "acme.broken", owner: "acme", contract: CONTRACT_VERSION } as unknown as Contribution;
	Object.defineProperty(broken, "sidebar", { enumerable: true, get() { throw new Error("sidebar exploded"); } });
	contributionSlot().set("acme.broken", broken);
	installContributedSidebar(f.tui, options);
	assert.equal(reads, 0, "a throwing sidebar property does not force a read");
	assert.deepEqual(readContributionReport().skipped.map((issue) => [issue.id, issue.detail]), [["acme.broken", "reading the contribution threw"]]);

	contributionSlot().set("zeta.notes", contribute("plugin:zeta:notes", "notes", "zeta"));
	assert.deepEqual(installContributedSidebar(f.tui, options).keys, ["plugin:zeta:notes"]);
	assert.equal(reads, 1, "a declared sidebar reads the order once");
});

test("an unchanged frame is memoised, before and after an owner reorder", (t) => {
	reset();
	const home = mkdtempSync(join(tmpdir(), "gentle-sidebar-memo-"));
	const previous = process.env.GENTLE_PI_CONFIG_HOME;
	process.env.GENTLE_PI_CONFIG_HOME = home;
	t.after(() => {
		reset();
		if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
		else process.env.GENTLE_PI_CONFIG_HOME = previous;
		rmSync(home, { recursive: true, force: true });
	});
	const f = fixture();
	const renders: Record<"acme" | "zeta" | "footer", number> = { acme: 0, zeta: 0, footer: 0 };
	for (const owner of ["acme", "zeta"] as const) {
		contributionSlot().set(`${owner}.notes`, {
			id: `${owner}.notes`,
			owner,
			contract: CONTRACT_VERSION,
			sidebar: {
				key: `plugin:${owner}:notes`,
				bottom: false,
				rail: {
					render: () => {
						renders[owner]++;
						return [`${owner} card`];
					},
					invalidate() {},
				},
			},
		});
	}
	sidebarPart(f.tui, "footer", {
		render: () => {
			renders.footer++;
			return ["Status"];
		},
		invalidate() {},
	});

	const declared = (order: readonly string[]): void => {
		writeFileSync(join(home, "plugins.json"), `${JSON.stringify({ schema: PLUGINS_SCHEMA, order })}\n`);
	};
	const painted = (): string => renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n");

	t.after(installSidebar(f.tui, theme));
	declared(["acme", "zeta"]);
	const first = painted();
	const afterFirst = { ...renders };
	const repeat = painted();
	// Comparing the section sequence must not turn a steady frame into a repaint:
	// the second frame reuses every prepared section, footer included.
	assert.deepEqual(renders, afterFirst, "a frame with nothing changed re-renders no section");
	assert.equal(repeat, first, "a frame with nothing changed paints identically");

	declared(["zeta", "acme"]);
	const reordered = painted();
	assert.ok(first.indexOf("acme card") >= 0 && first.indexOf("acme card") < first.indexOf("zeta card"), `the first order paints: ${first}`);
	assert.ok(reordered.indexOf("zeta card") < reordered.indexOf("acme card"), `the edited order paints: ${reordered}`);
	const afterReorder = { ...renders };
	const stable = painted();
	assert.deepEqual(renders, afterReorder, "the repainted rail is memoised again on the frame after it");
	assert.equal(stable, reordered, "the settled order paints identically on the next frame");
});

test("a namespaced key with unusual characters still paints", (t) => {
	reset();
	t.after(reset);
	const f = fixture();
	// The contract namespaces keys, it does not restrict them: anything after
	// `plugin:<owner>:` that cannot be confused with a core slot must paint.
	const owner = "a+[]";
	const key = `plugin:${owner}:x|,`;
	contributionSlot().set(`${owner}.unusual`, contribute(key, "unusual", owner));

	t.after(installSidebar(f.tui, theme));
	assert.deepEqual(installContributedSidebar(f.tui).keys, [key]);
	assert.ok(sidebarState(f.tui).parts.has(key), "the unusual key is installed into the shared parts map");
	const text = renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n");
	assert.match(text, /unusual card/, `the unusual section reaches the painted rail: ${text}`);
});

test("an empty contribution box computes exactly the known order and installs nothing", () => {
	reset();
	const f = fixture();
	const applied = installContributedSidebar(f.tui);
	assert.deepEqual(applied, { keys: [], rejected: [] });
	assert.deepEqual(sidebarSectionOrder(applied.keys), [...SIDEBAR_SECTION_KEYS]);
	assert.deepEqual([...sidebarState(f.tui).parts.keys()], []);
	assert.deepEqual(readSidebarContributionReport().skipped, []);
});

test("a frozen rail paints instead of tripping the guard's own forwarding", (t) => {
	reset();
	t.after(reset);
	const f = fixture();
	// A frozen rail is a legal `PluginRail`; a forwarding proxy that answers a
	// fresh function for a non-writable, non-configurable property throws on the
	// Proxy invariants before any guard runs and disables the whole layout.
	contributionSlot().set("acme.frozen", {
		id: "acme.frozen",
		owner: "acme",
		contract: CONTRACT_VERSION,
		sidebar: { key: "plugin:acme:frozen", bottom: false, rail: Object.freeze({ render: () => ["frozen card"] }) },
	});
	sidebarPart(f.tui, "footer", { render: () => ["Status"], invalidate() {} });

	t.after(installSidebar(f.tui, theme));
	const text = renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n");
	assert.ok(text.includes("frozen card"), `a frozen rail still paints: ${text}`);
	assert.ok(text.includes("Status"), `the rest of the rail still paints: ${text}`);
	assert.deepEqual(readSidebarContributionReport().skipped, [], "a frozen rail is legal, so nothing is refused");
});

test("a rail render that is not a synchronous array of strings is refused, and the rest of the sidebar paints", (t) => {
	reset();
	t.after(reset);
	const f = fixture();
	const set = (name: string, rail: unknown): void => {
		contributionSlot().set(`acme.${name}`, {
			id: `acme.${name}`,
			owner: "acme",
			contract: CONTRACT_VERSION,
			sidebar: { key: `plugin:acme:${name}`, bottom: false, rail: rail as PluginRail },
		});
	};
	set("number", { render: () => 7 });
	set("promise", { render: () => Promise.resolve(["async card"]) });
	set("rows", { render: () => ["ok row", 7] });
	set("healthy", { render: () => ["healthy card"] });
	sidebarPart(f.tui, "footer", { render: () => ["Status"], invalidate() {} });

	t.after(installSidebar(f.tui, theme));
	const text = renderLayoutFrame(f.root, 140, 20, () => {}).lines.join("\n");
	assert.ok(text.includes("healthy card"), `a well-formed section still paints: ${text}`);
	assert.ok(text.includes("Status"), `the sidebar is not disabled by one bad rail: ${text}`);
	assert.ok(!text.includes("ok row"), `a rail with a non-string row paints nothing: ${text}`);
	assert.ok(!text.includes("async card"), `a promise cannot fill the synchronous rail: ${text}`);
	const refused = readSidebarContributionReport().skipped.filter((issue) => issue.id.startsWith("acme."));
	assert.deepEqual(refused.map((issue) => issue.id).sort(), ["acme.number", "acme.promise", "acme.rows"]);
	assert.ok(refused.every((issue) => issue.code === "invalid-contribution"), "each refusal is reported as an invalid contribution");
});

test("a rejected promise from a rail's invalidate or digest is reported, never left unhandled", async (t) => {
	reset();
	t.after(reset);
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	const f = fixture();
	const rail = {
		render: () => ["notes card"],
		invalidate: () => Promise.reject(new Error("invalidate exploded")),
		digest: () => Promise.reject(new Error("digest exploded")),
	} as unknown as PluginRail;
	contributionSlot().set("acme.notes", {
		id: "acme.notes",
		owner: "acme",
		contract: CONTRACT_VERSION,
		sidebar: { key: "plugin:acme:notes", bottom: false, rail },
	});
	assert.deepEqual(installContributedSidebar(f.tui).keys, ["plugin:acme:notes"]);
	const part = sidebarState(f.tui).parts.get("plugin:acme:notes");
	assert.ok(part, "the rail is installed");
	part.invalidate?.();
	// The digest slot is synchronous, so a thenable answer cannot fill it.
	assert.equal(part.digest?.(), undefined);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(unhandled, [], "both rejections are observed by the seam");
	assert.deepEqual(readSidebarContributionReport().skipped.map((issue) => issue.detail).sort(), ["digest exploded", "invalidate exploded"]);
});
