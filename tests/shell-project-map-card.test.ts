import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CARD_STYLE, cardInnerWidth, cardStyle, renderCard, setCardStyle } from "../lib/shell-card.ts";
import {
	PROJECT_MAP_EXPANDED,
	PROJECT_MAP_OVERLAY_UNAVAILABLE,
	projectMapCardDescriptor,
	projectMapCardState,
	toggleProjectMapGroup,
	type ProjectMapCollapseState,
	type ProjectMapGroup,
} from "../lib/shell-project-map-view.ts";
import {
	PROJECT_MAP_RAIL_KEY,
	projectMapCardBottom,
	projectMapCardRail,
	renderProjectMapCard,
	type ProjectMapCardSession,
} from "../lib/shell-project-map-card.ts";

const theme = { fg: (_color: string, text: string) => text };
const floatTheme = { ...theme, bg: (_color: string, text: string) => `\x1b[48;2;20;20;20m${text}\x1b[49m` };

for (const style of [CARD_STYLE.FLOAT, CARD_STYLE.NEON]) {
	test(`${style} panel markers, selection and reveal follow the painted geometry`, () => {
		const previous = cardStyle();
		setCardStyle(style);
		try {
			withArtifact(JSON.stringify(map()), (path) => {
				const current = session();
				const explained: string[] = [];
				const revealed: number[] = [];
				const id = "capability-with-an-unbreakable-identifier";
				const rail = projectMapCardRail(path, floatTheme, current, "alt+m", (row) => revealed.push(row), undefined,
					(value) => explained.push(value));
				for (const width of [9, 20, 56]) {
					const lines = rail.render(width);
					assert.ok(lines.every((line) => visibleWidth(line) <= width));
				}
				const lines = rail.render(56);
				const row = lines.findIndex((line) => line.includes("? ✓"));
				const margin = style === CARD_STYLE.FLOAT ? 1 : 0;
				const click = (x: number, y = row) => rail.handleMouse?.({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 56, height: lines.length, shift: false, alt: false, ctrl: false });
				assert.deepEqual(click(4 + margin), { handled: true });
				assert.deepEqual(explained, [id]);
				assert.deepEqual(current.selected, []);
				assert.equal(click(10, 0), undefined);
				assert.deepEqual(click(10), { handled: true, render: true });
				const selected = rail.render(56);
				assert.deepEqual(revealed, [selected.findIndex((line) => line.includes("▸ ? ✓"))]);
				rail.render(56);
				assert.equal(revealed.length, 1);
				const group = selected.findIndex((line) => line.includes("Product capabilities"));
				assert.deepEqual(click(10, group), { handled: true, render: true });
				assert.deepEqual(current.toggled, ["capabilities"]);
			});
		} finally {
			setCardStyle(previous);
		}
	});
}

function map(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: "gentle-shell.project-map/v1",
		project: { id: "example-shop", name: "Example Shop" },
		approval: { state: "draft" },
		foundations: [{ id: "repository-tooling", outcome: "Tooling is declared.", state: "done" }],
		capabilities: [{ id: "capability-with-an-unbreakable-identifier", outcome: "A deliberately long diagnostic-capable outcome.", foundationRefs: [], dependsOn: [], contracts: [], featureDocs: [], surfaces: ["web"], state: "done" }],
		...overrides,
	};
}

function session(initial: ProjectMapCollapseState = PROJECT_MAP_EXPANDED): ProjectMapCardSession & { toggled: ProjectMapGroup[]; selected: Array<string | undefined> } {
	let current = initial;
	let selection: string | undefined;
	const toggled: ProjectMapGroup[] = [];
	const selected: Array<string | undefined> = [];
	return {
		collapse: () => current,
		selection: () => selection,
		toggle(group) {
			toggled.push(group);
			current = toggleProjectMapGroup(current, group);
		},
		select(id) {
			selection = id;
			selected.push(id);
		},
		toggled,
		selected,
	};
}

function withArtifact(text: string | null, run: (path: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "project-map-card-"));
	try {
		const path = join(directory, "project-map.json");
		if (text !== null) writeFileSync(path, text, "utf8");
		run(path);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

for (const style of [CARD_STYLE.FLOAT, CARD_STYLE.NEON]) {
	test(`${style} folding removes hit targets and retains themed marker offsets`, () => {
		const previous = cardStyle();
		setCardStyle(style);
		try {
			const base = (map().capabilities as Array<Record<string, unknown>>)[0]!;
			const capabilities = Array.from({ length: 12 }, (_, index) => ({ ...base, id: `row-${String(index).padStart(2, "0")}`, outcome: `Row ${index}`, state: index < 2 ? "done" : "planned" }));
			withArtifact(JSON.stringify(map({ capabilities })), (path) => {
				const current = session();
				const explained: string[] = [], revealed: number[] = [];
				const painted: Array<{ role: string; text: string }> = [];
				const recording = { ...floatTheme, fg: (role: string, text: string) => { painted.push({ role, text }); return `\x1b[32m${text}\x1b[39m`; } };
				const rail = projectMapCardRail(path, recording, current, undefined, (row) => revealed.push(row), undefined,
					(id) => explained.push(id));
				rail.render(80);
				capabilities.push({ ...base, id: "row-12", outcome: "Row 12", state: "planned" });
				writeFileSync(path, JSON.stringify(map({ capabilities })));
				const lines = rail.render(80);
				const plain = lines.map((line) => line.replace(/\x1b\[[\d;]*m/g, ""));
				const summary = plain.findIndex((line) => line.includes("✓ 2 done"));
				const row = plain.findIndex((line) => line.includes("Row 2"));
				assert.ok(summary > 0 && row === summary + 1);
				const click = (x: number, y: number) => rail.handleMouse?.({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 80, height: lines.length, shift: false, alt: false, ctrl: false });
				assert.equal(click(4, summary), undefined, "the done summary has no stale row target");
				const margin = style === CARD_STYLE.FLOAT ? 1 : 0;
				assert.deepEqual(click(4 + margin, row), { handled: true });
				assert.deepEqual(explained, ["row-02"]);
				assert.deepEqual(click(10, row), { handled: true, render: true });
				assert.deepEqual(current.selected, ["row-02"]);
				rail.render(80);
				assert.deepEqual(revealed, [row]);
				assert.ok(painted.some(({ role, text }) => role === "text" && text === "Row 2"));
				assert.ok(painted.some(({ role, text }) => role === "muted" && text === "?"));
				capabilities.push({ ...base, id: "row-13", outcome: "Row 13", state: "planned" });
				writeFileSync(path, JSON.stringify(map({ capabilities })));
				const overflow = rail.render(80).findIndex((line) => line.includes("2 more"));
				assert.ok(overflow > row);
				assert.equal(click(4 + margin, overflow), undefined, "overflow has no explain target");
				assert.equal(click(10, overflow), undefined, "overflow has no selection target");
				assert.equal(click(10, overflow + 1), undefined, "old trailing row targets were cleared");
			});
		} finally {
			setCardStyle(previous);
		}
	});
}

test("composes the ready descriptor through renderCard", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const state = projectMapCardState(path, PROJECT_MAP_OVERLAY_UNAVAILABLE);
		const descriptor = projectMapCardDescriptor(state, undefined, undefined, cardInnerWidth(48));
		const actual = renderProjectMapCard(path, theme, 48, true);
		assert.deepEqual(actual, renderCard(descriptor, theme, 48, { expanded: true }));
		assert.ok(actual.join("\n").includes(descriptor.title));
		assert.ok(actual.join("\n").includes(descriptor.subtitle));
		assert.equal(descriptor.tone, "info");
		// The descriptor at its default budget carries the document's label in full; the narrow
		// render truncates that label, while click metadata retains the identifier.
		assert.ok(projectMapCardDescriptor(state).body.join("\n").includes("A deliberately long diagnostic-capable outcome."));
		assert.ok(actual.join("\n").includes("A deliberately"));
		assert.ok(actual.join("\n").includes("…"));
	});
});

test("renders empty and invalid artifacts distinctly without throwing", () => {
	withArtifact(null, (empty) => {
		withArtifact(JSON.stringify({ version: "gentle-shell.project-map/v1", project: { id: "example-shop", name: "" }, capabilities: [] }), (invalid) => {
			const emptyLines = renderProjectMapCard(empty, theme, 48, true);
			const invalidLines = renderProjectMapCard(invalid, theme, 48, true);
			assert.doesNotThrow(() => emptyLines);
			assert.doesNotThrow(() => invalidLines);
			assert.notDeepEqual(emptyLines, invalidLines);
			// The owner's decision: with nothing to show, the card is its title and nothing else.
			assert.match(emptyLines.join("\n"), /Project Map/);
			assert.doesNotMatch(emptyLines.join("\n"), /no map|no functional points|No FP work units/);
			assert.match(invalidLines.join("\n"), /invalid/);
		});
	});
});

test("clips every card line to the requested boundary width", () => {
	const longIdentifier = `capability-${"x".repeat(280)}`;
	withArtifact(JSON.stringify(map({
		project: { id: "example-shop", name: "p".repeat(300) },
		capabilities: [{ id: longIdentifier, outcome: "A deliberately long outcome.", foundationRefs: [], dependsOn: [], contracts: [], featureDocs: [], surfaces: ["web"], state: "done" }],
	})), (path) => {
		for (const width of [1, 12]) {
			for (const expanded of [true, false]) {
				// renderCard enforces clipping here; shell-card.test.ts verifies its boundary behavior.
				for (const line of renderProjectMapCard(path, theme, width, expanded)) {
					assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} exceeds ${width}: ${line}`);
				}
			}
		}
	});
});

test("rail digest follows rendered diagnostics but ignores unrendered map fields", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const rail = projectMapCardRail(path, theme, session());
		const before = rail.digest!();
		writeFileSync(path, JSON.stringify(map({ project: { id: "changed-id", name: "Example Shop" } })), "utf8");
		assert.equal(rail.digest!(), before);
		writeFileSync(path, JSON.stringify({ version: "unsupported-one" }), "utf8");
		const firstInvalid = rail.digest!();
		const firstMessage = projectMapCardDescriptor(projectMapCardState(path)).body.join("\n");
		writeFileSync(path, JSON.stringify({ version: "unsupported-two" }), "utf8");
		const secondMessage = projectMapCardDescriptor(projectMapCardState(path)).body.join("\n");
		assert.notEqual(secondMessage, firstMessage, "the invalid diagnostics differ in their rendered message");
		assert.notEqual(rail.digest!(), firstInvalid);
	});
});

test("the rail is expanded while the bottom card is one collapsed body line", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const rail = projectMapCardRail(path, theme, session());
		const bottom = projectMapCardBottom(path, theme);
		assert.equal(PROJECT_MAP_RAIL_KEY, "project-map");
		assert.ok(rail.render(48).length > 3);
		assert.equal(bottom.render(48).length, 3);
	});
});

test("the rail reads session collapse state and its digest follows a toggle", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const current = session({ foundations: true, capabilities: false });
		const rail = projectMapCardRail(path, theme, current);
		assert.equal(rail.render(80).join("\n").includes("repository-tooling"), false);
		const before = rail.digest!();
		current.toggle("capabilities");
		assert.notEqual(rail.digest!(), before);
	});
});

test("a click on a group header toggles only that group", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const current = session();
		const rail = projectMapCardRail(path, theme, current);
		const lines = rail.render(80);
		const header = lines.findIndex((line) => line.includes("Foundations"));
		const row = lines.findIndex((line) => line.includes("repository-tooling"));
		assert.deepEqual(rail.handleMouse?.({ type: "click", button: "left", x: 2, y: header, screenX: 2, screenY: header, width: 80, height: lines.length, shift: false, alt: false, ctrl: false }), { handled: true, render: true });
		assert.deepEqual(current.toggled, ["foundations"]);
		assert.equal(rail.handleMouse?.({ type: "click", button: "left", x: 2, y: row, screenX: 2, screenY: row, width: 80, height: lines.length, shift: false, alt: false, ctrl: false }), undefined);
		assert.equal(rail.handleMouse?.({ type: "press", button: "left", x: 2, y: header, screenX: 2, screenY: header, width: 80, height: lines.length, shift: false, alt: false, ctrl: false }), undefined);
		assert.equal(rail.handleMouse?.({ type: "click", button: "left", x: 2, y: lines.length + 1, screenX: 2, screenY: lines.length + 1, width: 80, height: lines.length, shift: false, alt: false, ctrl: false }), undefined);
		assert.deepEqual(current.toggled, ["foundations"]);
	});
});

test("capability clicks select, clear, and reveal only the selected row", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const current = session();
		const revealed: number[] = [];
		const rail = projectMapCardRail(path, theme, current, undefined, (line) => revealed.push(line));
		// The document's label is painted, while a click still selects by identifier.
		const lines = rail.render(56);
		const row = lines.findIndex((line) => line.includes("A deliberately"));
		const click = () => rail.handleMouse?.({ type: "click", button: "left", x: 2, y: row, screenX: 2, screenY: row, width: 56, height: lines.length, shift: false, alt: false, ctrl: false });
		assert.deepEqual(click(), { handled: true, render: true });
		assert.deepEqual(current.selected, ["capability-with-an-unbreakable-identifier"]);
		const selectedRow = rail.render(56).findIndex((line) => line.includes("▸ ? ✓"));
		assert.deepEqual(revealed, [selectedRow], "reveal receives the rendered selected-row line");
		assert.deepEqual(click(), { handled: true, render: true });
		assert.deepEqual(current.selected, ["capability-with-an-unbreakable-identifier", undefined]);
		assert.deepEqual(revealed, [selectedRow], "clearing selection has no selected row to reveal");
		assert.equal(rail.handleMouse?.({ type: "click", button: "left", x: 2, y: lines.length - 1, screenX: 2, screenY: lines.length - 1, width: 56, height: lines.length, shift: false, alt: false, ctrl: false }), undefined);
	});
});

// Explaining a capability is not selecting it: the marker has its own target, and a click that
// lands on it must not change what the Inspector shows.
test("the marker explains a capability while the rest of the row still selects it", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const current = session();
		const explained: string[] = [];
		const rail = projectMapCardRail(path, theme, current, undefined, undefined, undefined, (id) => explained.push(id));
		const lines = rail.render(56);
		const header = lines.findIndex((line) => line.includes("Product capabilities"));
		const bodyEnd = lines.length - 1;
		const row = lines.map((line, index) => ({ line, index })).find((entry) => entry.index > header && entry.index < bodyEnd && entry.line.includes("? "))!.index;
		const click = (x: number) => rail.handleMouse?.({ type: "click", button: "left", x, y: row, screenX: x, screenY: row, width: 56, height: lines.length, shift: false, alt: false, ctrl: false });
		// The marker is two body columns in, and the frame spends two columns before the body.
		assert.deepEqual(click(4), { handled: true }, "the marker is handled, and nothing repaints");
		assert.deepEqual(explained, ["capability-with-an-unbreakable-identifier"]);
		assert.deepEqual(current.selected, [], "explaining does not select");
		assert.deepEqual(click(10), { handled: true, render: true });
		assert.deepEqual(current.selected, ["capability-with-an-unbreakable-identifier"], "the rest of the row still selects");
	});
});

test("a selection change made outside the rail reveals on the next render", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const current = session();
		const revealed: number[] = [];
		const rail = projectMapCardRail(path, theme, current, undefined, (line) => revealed.push(line));
		rail.render(20);
		assert.deepEqual(revealed, [], "the first render reveals nothing");
		current.select("capability-with-an-unbreakable-identifier");
		const selectedRow = rail.render(20).findIndex((line) => line.includes("▸ ? ✓"));
		assert.deepEqual(revealed, [selectedRow], "the render after an external selection reveals its row");
		rail.render(20);
		assert.deepEqual(revealed, [selectedRow], "an unchanged selection does not reveal again");
	});
});

test("a capability row is one rendered line, and that line selects it", () => {
	const base = map();
	const capability = (base.capabilities as Array<Record<string, unknown>>)[0]!;
	const longId = `capability-${"x".repeat(53)}`;
	assert.equal(longId.length, 64);
	withArtifact(JSON.stringify(map({ capabilities: [{ ...capability, id: longId }] })), (path) => {
		const probe = session();
		const rail = projectMapCardRail(path, theme, probe);
		const lines = rail.render(46);
		const row = lines.findIndex((line) => line.includes("? ✓ "));
		assert.ok(row > 0, "the capability row renders its markers and label on its own line");
		assert.equal(lines.filter((line) => line.includes("? ✓ ")).length, 1, "the row is not spread over several lines");
		const result = rail.handleMouse?.({ type: "click", button: "left", x: 2, y: row, screenX: 2, screenY: row, width: 46, height: lines.length, shift: false, alt: false, ctrl: false });
		assert.deepEqual(result, { handled: true, render: true });
		assert.deepEqual(probe.selected, [longId]);
	});
});

test("a project named like a group does not make the title clickable", () => {
	withArtifact(JSON.stringify(map({ project: { id: "foundations", name: "▾ Foundations 1/1" } })), (path) => {
		const current = session();
		const rail = projectMapCardRail(path, theme, current);
		const lines = rail.render(80);
		assert.ok(lines[0]?.includes("Foundations"), "the subtitle carries the project name");
		assert.equal(rail.handleMouse?.({ type: "click", button: "left", x: 2, y: 0, screenX: 2, screenY: 0, width: 80, height: lines.length, shift: false, alt: false, ctrl: false }), undefined);
		assert.deepEqual(current.toggled, []);
	});
});

test("an invalid artifact diagnostic never becomes a group click target", () => {
	withArtifact(JSON.stringify({ version: "▾ Foundations 1/1" }), (path) => {
		const current = session();
		const rail = projectMapCardRail(path, theme, current);
		const lines = rail.render(80);
		const row = lines.findIndex((line) => line.includes("▾ Foundations 1/1"));
		assert.ok(row > 0, `the diagnostic renders the injected text: ${lines.join("\\n")}`);
		assert.equal(rail.handleMouse?.({ type: "click", button: "left", x: 2, y: row, screenX: 2, screenY: row, width: 80, height: lines.length, shift: false, alt: false, ctrl: false }), undefined);
		assert.deepEqual(current.toggled, []);
	});
});

test("the bottom uses the summary line and stays non-interactive", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const bottom = projectMapCardBottom(path, theme);
		assert.match(bottom.render(80).join("\n"), /1\/1 foundations · 1\/1 capabilities/);
		assert.equal(bottom.handleMouse, undefined);
	});
});

test("the bottom leaves the empty body blank and renders one invalid diagnostic line", () => {
	withArtifact(null, (empty) => {
		const bottom = projectMapCardBottom(empty, theme);
		const lines = bottom.render(80);
		assert.equal(lines.length, 2, "only the card frame remains without body rows");
		assert.match(lines[0]!, /Project Map/);
		assert.doesNotMatch(lines[0]!, /no map|no functional points/);
		assert.doesNotMatch(lines.join("\n"), /No Project Map at|\/gentle:/);
		assert.equal(bottom.handleMouse, undefined);
	});
	withArtifact(JSON.stringify({ version: "gentle-shell.project-map/v1", project: { id: "example-shop", name: "" }, capabilities: [] }), (invalid) => {
		const bottom = projectMapCardBottom(invalid, theme);
		const lines = bottom.render(80);
		assert.equal(lines.length, 3);
		assert.ok(lines[1]?.includes("The Project Map artifact is not valid:"));
		assert.equal(lines[1]?.includes("$.project.name"), false);
		assert.equal(bottom.handleMouse, undefined);
	});
});

test("the rail shows the collapse hint when it fits", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		assert.match(projectMapCardRail(path, theme, session(), "alt+m").render(80)[0], /alt\+m/);
	});
});

test("the unavailable overlay contributes no rendered rows", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const lines = renderProjectMapCard(path, theme, 48, true).join("\n").toLowerCase();
		for (const term of ["claim", "lease", "heartbeat", "worktree", "session"]) assert.equal(lines.includes(term), false);
	});
});

/** The read-only block another surface may stack below the card. */
function detail(lines: () => string[], digest = () => "detail"): { lines(width: number): string[]; digest(): string } {
	return { lines: () => lines(), digest };
}

test("a card detail paints below the card's own lines and leaves them untouched", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const plain = projectMapCardRail(path, theme, session()).render(46);
		const stacked = projectMapCardRail(path, theme, session(), undefined, undefined, detail(() => ["▸ catalog"])).render(46);
		assert.deepEqual(stacked.slice(0, plain.length), plain, "the card's own lines are unchanged");
		assert.deepEqual(stacked.slice(plain.length), ["▸ catalog"]);
	});
});

test("a detail that paints nothing adds no row at all", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const plain = projectMapCardRail(path, theme, session()).render(46);
		assert.deepEqual(projectMapCardRail(path, theme, session(), undefined, undefined, detail(() => [])).render(46), plain);
	});
});

test("the rail digest follows the detail's own digest so a changed detail repaints", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		let version = "one";
		const rail = projectMapCardRail(path, theme, session(), undefined, undefined, detail(() => ["▸ catalog"], () => version));
		const before = rail.digest!();
		assert.equal(rail.digest!(), before, "an unchanged detail reuses the prepared rail");
		version = "two";
		assert.notEqual(rail.digest!(), before, "a changed detail must repaint the rail");
	});
});

test("a detail row is never the card's click, and the card's own rows keep their indices", () => {
	withArtifact(JSON.stringify(map()), (path) => {
		const current = session();
		const rail = projectMapCardRail(path, theme, current, undefined, undefined, detail(() => ["▸ catalog", "  Merchants can publish a catalog."]));
		const lines = rail.render(46);
		const click = (y: number) => rail.handleMouse?.({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 46, height: lines.length, shift: false, alt: false, ctrl: false });
		const header = lines.findIndex((line) => line.includes("Foundations"));
		assert.ok(header >= 0);
		assert.deepEqual(click(header), { handled: true, render: true }, "the card's own row still answers at its own index");
		assert.deepEqual(current.toggled, ["foundations"]);
		for (let y = lines.length - 2; y < lines.length; y++) {
			assert.equal(click(y), undefined, `the detail row ${y} is read-only`);
		}
	});
});
