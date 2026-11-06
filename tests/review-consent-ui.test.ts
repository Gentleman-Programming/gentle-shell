import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ReviewConsentComponent } from "../lib/review-consent-component.ts";
import { formatReviewConsentUi } from "../lib/review-consent-ui.ts";
import { decodeReviewConsentV3 } from "../lib/review-integration-v2.ts";

function consent() {
	const path = join(process.cwd(), "tests", "fixtures", "devbinary", "consent-v3.captured.json");
	const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	raw.agent = "pi";
	return formatReviewConsentUi(decodeReviewConsentV3(raw, "pi"));
}

function createComponent(
	rows: number,
	selected: number[] = [],
	cancelled: number[] = [],
	content = consent().content,
) {
	return new ReviewConsentComponent({
		content,
		theme: { fg: (_color, text) => text, bold: (text) => text },
		keybindings: undefined,
		terminalRows: () => rows,
		onSelect: (index) => selected.push(index),
		onCancel: () => cancelled.push(1),
	});
}

function joined(lines: string[]): string {
	return lines.join(" ").replaceAll("→ ", "").replace(/\s+/g, " ");
}

function assertBounded(lines: string[], width: number, height: number): void {
	assert.ok(lines.length <= height, `${width}x${height} must fit its terminal`);
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
}

test("primary consent is compact by default and opens exact details only with D", () => {
	const base = consent().content;
	const content = {
		...base,
		headline: "Review this change now?",
		reason: "This is the exact provider reason.",
		actions: [
			{ label: "Review this change", effect: "Reviews only this change; delivery stays separate." },
			{ label: "Skip this time", effect: "Skips only this change; no preference is saved." },
			{ label: "Review and allow this session", effect: "Reviews this change and permits later session reviews." },
		] as typeof base.actions,
	};
	const selected: number[] = [];
	const component = createComponent(24, selected, [], content);
	const primary = component.render(80);
	assertBounded(primary, 80, 24);
	assert.deepEqual(component.render(80), primary, "80x24 is stable without terminal-height padding");
	assert.deepEqual(createComponent(40, [], [], content).render(80), primary, "80x40 keeps the same compact primary content");
	assert.ok(primary.length >= 9 && primary.length <= 12, "the concise fixture keeps its provider reason within the primary row budget");
	assert.ok(joined(primary).includes(content.headline));
	assert.ok(joined(primary).includes(content.reason), "the exact provider reason is visible without opening details");
	assert.ok(!joined(primary).includes("CONTEXT"));
	assert.ok(!joined(primary).includes("Provider headline:"));
	for (const action of content.actions) assert.ok(joined(primary).includes(action.label));
	assert.ok(joined(primary).includes(content.actions[0].effect));
	assert.ok(!joined(primary).includes(content.actions[1].effect));
	assert.match(joined(primary), /Enter confirm.*Esc cancel.*D details/);
	component.handleInput("d");
	const details = component.render(80);
	assert.ok(joined(details).includes("Details (read-only)"));
	assert.ok(joined(details).includes(content.reason));
	assert.ok(joined(details).includes("Provider headline:"));
	component.handleInput("\r");
	assert.deepEqual(selected, [], "details cannot confirm");
	component.handleInput("D");
	component.handleInput("\r");
	assert.deepEqual(selected, [], "returning to main recomputes its visible-confirm guard");
	component.render(80);
	component.handleInput("\r");
	assert.deepEqual(selected, [0]);
});

test("context and complete effects precede enabled consent, while short terminals stay safe", () => {
	const selected: number[] = [];
	const full = createComponent(24, selected);
	const initial = full.render(80);
	const content = consent().content;
	assertBounded(initial, 80, 24);
	for (const text of [content.headline, content.actions[0].effect]) {
		assert.ok(joined(initial).includes(text), `initial screen preserves ${text}`);
	}
	assert.ok(joined(initial).includes(content.reason), "primary keeps the exact provider reason visible");
	assert.ok(!joined(initial).includes("CONTEXT"), "primary has no permanent context block");
	full.handleInput("\r");
	assert.deepEqual(selected, [0], "a complete visible grant may be confirmed");

	for (const width of [20, 40, 80]) {
		const shortSelected: number[] = [];
		const cancelled: number[] = [];
		const short = createComponent(7, shortSelected, cancelled);
		const view = short.render(width);
		assertBounded(view, width, 7);
		assert.ok(joined(view).includes("Action 1/3"), "safe view names the unavailable action without partial labels");
		assert.ok(joined(view).includes("Resize; Esc cancel; Enter off"), "safe view explains disabled confirmation");
		short.handleInput("\r");
		short.handleInput("\u001b");
		assert.deepEqual(shortSelected, [], "compact screens never hide effects then confirm");
		assert.deepEqual(cancelled, [1], "compact screens retain cancellation");
	}

	const tiny = createComponent(4);
	const tinyView = tiny.render(20);
	assertBounded(tinyView, 20, 4);
	assert.ok(joined(tinyView).includes("Resize; Esc cancel; Enter off"), "tiny fallback leads with resize and cancellation guidance");
	const oneRowCancelled: number[] = [];
	const oneRow = createComponent(1, [], oneRowCancelled);
	assert.ok(joined(oneRow.render(20)).includes("Resize; Esc cancel"), "one-row fallback leads with resize and cancellation guidance");
	oneRow.handleInput("\u001b");
	assert.deepEqual(oneRowCancelled, [1], "one-row fallback retains cancellation");
});

test("primary preserves provider risk reasons without paraphrasing", () => {
	const base = consent().content;
	for (const reason of [
		"These changes may affect execution; review can help detect problems.",
		"Security-sensitive changes need an authoritative review decision.",
		"Behavior updates may warrant review before delivery.",
	]) {
		const primary = createComponent(24, [], [], { ...base, reason }).render(80);
		assert.ok(joined(primary).includes(reason), `80x24 shows the exact provider reason: ${reason}`);
		assert.ok(!joined(primary).includes("Reason:"), "primary does not add a context label around the reason");
	}
});

test("selection anchors fitting effects despite long context and invalidates rapid confirmation", () => {
	const base = consent().content;
	const content = {
		...base,
		headline: "Question?",
		reason: "long provider context ".repeat(200),
		actions: [
			{ label: "one", effect: "one effect" },
			{ label: "two", effect: "two effect" },
			{ label: "three", effect: "three effect" },
		] as typeof base.actions,
	};
	const anchorActions = (width: number) => {
		const selected: number[] = [];
		const component = createComponent(24, selected, [], content);
		assert.ok(!joined(component.render(width)).includes("long provider context"), `${width}x24 keeps provider context in details`);
		assert.ok(joined(component.render(width)).includes(content.actions[0].effect), `${width}x24 keeps the selected consequence visible`);
		component.handleInput("\r");
		assert.deepEqual(selected, [0], "a separately visible complete action may confirm without scrolling the long context");
		for (const [input, index, effect] of [
			["\u001b[A", 0, content.actions[0].effect],
			["\u001b[B", 1, content.actions[1].effect],
			["\u001b[B", 2, content.actions[2].effect],
		] as const) {
			component.handleInput(input);
			const before = [...selected];
			component.handleInput("\r");
			assert.deepEqual(selected, before, "rapid navigation invalidates confirmation");
			assert.ok(joined(component.render(width)).includes(effect), `choice ${index + 1} anchors at ${width} columns`);
			component.handleInput("\r");
			assert.equal(selected.at(-1), index);
		}
		return { component, selected };
	};
	const { component, selected } = anchorActions(80);
	anchorActions(40);
	component.handleInput("d");
	assert.ok(joined(component.render(80)).includes("long provider context"), "D opens complete provider context");
	component.handleInput("D");
	component.handleInput("\u001b[A");
	component.render(60);
	assert.ok(joined(component.render(80)).includes(content.actions[1].effect), "resize back anchors the selected consequence");

	component.handleInput("d");
	const details = component.render(12);
	assertBounded(details, 12, 24);
	component.handleInput("\r");
	assert.deepEqual(selected, [0, 0, 1, 2], "details never confirm a hidden action");
	let sawOffPath = false;
	for (let row = 0; row < 200; row += 1) {
		sawOffPath ||= joined(component.render(12)).includes("Off-path");
		component.handleInput("\u001b[6~");
	}
	assert.ok(sawOffPath, "long fixture off-path details remain reachable");
	const risk = createComponent(40);
	risk.render(12);
	risk.handleInput("d");
	let sawRiskEvidence = false;
	for (let row = 0; row < 200; row += 1) {
		const riskDetails = risk.render(12);
		assertBounded(riskDetails, 12, 40);
		sawRiskEvidence ||= joined(riskDetails).includes("Risk evidence:");
		risk.handleInput("\u001b[B");
	}
	assert.ok(sawRiskEvidence, "context scrolling exposes risk-evidence headings at twelve columns");
	const original = consent().content;
	const shortContent = {
		...original,
		reason: "short provider context",
		value: "short provider value",
		actions: [
			{ label: "one", effect: "one" },
			{ label: "two", effect: "two" },
			{ label: "three", effect: "three" },
		] as typeof original.actions,
	};
	assertBounded(createComponent(40, [], [], shortContent).render(12), 12, 40);

	const oneLineDetails = createComponent(4);
	oneLineDetails.render(20);
	oneLineDetails.handleInput("d");
	const before = oneLineDetails.render(20);
	oneLineDetails.handleInput("\u001b[6~");
	assert.notDeepEqual(oneLineDetails.render(20), before, "one-line details still page forward");

	const resized = createComponent(7);
	resized.render(80);
	resized.handleInput("\u001b[B");
	resized.handleInput("\u001b[B");
	const resizedView = resized.render(20);
	assertBounded(resizedView, 20, 7);
	assert.ok(joined(resizedView).includes("Action 3/3"), "resize keeps the selected action identifiable without partial labels");
	assert.ok(joined(resizedView).includes("Resize; Esc cancel; Enter off"), "resize disables hidden confirmation with guidance");
});

test("fixed title separates an enormous provider context from anchored consent actions", () => {
	const base = consent().content;
	const content = {
		...base,
		headline: "ENORMOUS PROVIDER HEADLINE: review authority for a frozen candidate needs explicit consent before any reviewer can inspect immutable evidence, with no summary substituted by Pi.",
		reason: "The provider requires an explicit decision because the frozen candidate changes review-sensitive behavior and the user must see the complete reason before choosing.",
		value: "A bounded review can identify candidate-caused defects while preserving ordinary repository delivery decisions and no automatic approval.",
		evidence: [
			"Risk evidence: the candidate changes authority-bearing review behavior.",
			"Risk evidence: the provider recorded a scoped immutable target identity.",
		],
		offPathNote: "OFF PATH UNIQUE: cancellation declines this prompt only and does not change the review switch.",
		actions: [
			{ label: "Grant this frozen candidate review", effect: "GRANT UNIQUE: starts only this provider-bound review for the frozen candidate; it creates no delivery approval or standing permission." },
			{ label: "Decline this frozen candidate review", effect: "DECLINE UNIQUE: declines only this candidate; no review starts and no preference is saved." },
			{ label: "Grant one Pi-session review permission", effect: "SESSION UNIQUE: runs this exact provider grant, then permits later fresh validated candidates only for this Pi session and canonical repository identity; it grants no verdict, delivery, or cross-repository authority." },
		] as typeof base.actions,
	};
	const selected: number[] = [];
	const component = createComponent(24, selected, [], content);
	const initial = component.render(80);
	assertBounded(initial, 80, 24);
	assert.equal(initial[0], "Review consent", "the visual title is app-owned and never becomes the provider headline");
	assert.ok(!initial.includes("CONTEXT"), "provider fields are absent from the default primary");
	assert.ok(!joined(initial).includes("Provider headline:"), "the provider headline is not a primary option");
	assert.ok(joined(initial).includes("GRANT UNIQUE"), "the selected action's complete consequence is readable beside the context viewport");
	component.handleInput("d");
	for (let row = 0; row < 200; row += 1) component.handleInput("\u001b[6~");
	const scrolled = component.render(80);
	assertBounded(scrolled, 80, 24);
	assert.equal(scrolled[0], "Details (read-only)", "details use their own fixed read-only title");
	assert.ok(scrolled.includes("Details (read-only)"), "details retain a read-only heading while scrolling");
	assert.ok(joined(scrolled).includes("OFF PATH UNIQUE"), "the complete provider context is recoverable through its viewport");
	component.handleInput("\r");
	assert.deepEqual(selected, [], "context details cannot confirm an action");
	component.handleInput("D");
	component.handleInput("\u001b[B");
	const second = component.render(80);
	assert.ok(joined(second).includes("DECLINE UNIQUE"), "navigation anchors each selected action's exact consequence");
	component.handleInput("\r");
	assert.deepEqual(selected, [1], "a rendered complete selected action remains confirmable after context recovery");

	const tallComponent = createComponent(40, [], [], content);
	tallComponent.render(80);
	tallComponent.handleInput("\u001b[B");
	tallComponent.handleInput("\u001b[B");
	const tall = tallComponent.render(80);
	assertBounded(tall, 80, 40);
	assert.equal(tall[0], "Review consent", "80x40 keeps the same fixed brief title");
	assert.ok(joined(tall).includes("SESSION UNIQUE"), "80x40 exposes the realistic session-permission consequence in the action area");
});

test("fixed title uses a heading token without recoloring context or selection", () => {
	const foregrounds: Array<{ color: string; text: string }> = [];
	const component = new ReviewConsentComponent({
		content: consent().content,
		theme: {
			fg: (color, text) => {
				foregrounds.push({ color, text });
				return text;
			},
			bold: (text) => `**${text}**`,
		},
		keybindings: undefined,
		terminalRows: () => 24,
		onSelect: () => {},
		onCancel: () => {},
	});
	const lines = component.render(80);
	assert.equal(lines[0], "**Review consent**", "fixed title retains bold styling");
	assert.deepEqual(foregrounds.find(({ text }) => text === "**Review consent**"), {
		color: "mdHeading",
		text: "**Review consent**",
	}, "fixed title uses the heading semantic token");
	assert.ok(foregrounds.some(({ color, text }) => color === "accent" && text.startsWith("→ 1.")), "selected action remains accent styled");
	assert.ok(!foregrounds.some(({ text }) => text.startsWith("Provider headline:")), "common body remains unstyled");
});

test("oversized selected consequences stay complete in read-only context without enabling consent", () => {
	const base = consent().content;
	const effects = [
		"OVERSIZED ONE BEGIN " + "one-context-token ".repeat(140) + "OVERSIZED_ONE_COMPLETE_END",
		"OVERSIZED TWO BEGIN " + "two-context-token ".repeat(140) + "OVERSIZED_TWO_COMPLETE_END",
		"OVERSIZED THREE BEGIN " + "three-context-token ".repeat(140) + "OVERSIZED_THREE_COMPLETE_END",
	] as const;
	const content = {
		...base,
		actions: [
			{ label: "Oversized grant action", effect: effects[0] },
			{ label: "Oversized decline action", effect: effects[1] },
			{ label: "Oversized session action", effect: effects[2] },
		] as typeof base.actions,
	};
	for (const rows of [24, 40]) {
		const selected: number[] = [];
		const component = createComponent(rows, selected, [], content);
		const initial = component.render(80);
		assertBounded(initial, 80, rows);
		assert.ok(joined(initial).includes("Action 1/3 needs its full effect"), `${rows} rows uses safe action guidance for an oversized effect`);
		component.handleInput("\r");
		assert.deepEqual(selected, [], `${rows} rows never confirms a hidden oversized effect`);
		component.handleInput("d");
		let sawActionConsequences = false;
		const visited = new Set<string>();
		for (let page = 0; page < 700; page += 1) {
			const view = component.render(80);
			assertBounded(view, 80, rows);
			const text = joined(view);
			sawActionConsequences ||= text.includes("Action consequences");
			for (const marker of ["OVERSIZED ONE BEGIN", "OVERSIZED_ONE_COMPLETE_END", "OVERSIZED TWO BEGIN", "OVERSIZED_TWO_COMPLETE_END", "OVERSIZED THREE BEGIN", "OVERSIZED_THREE_COMPLETE_END"]) {
				if (text.includes(marker)) visited.add(marker);
			}
			component.handleInput("\u001b[B");
		}
		assert.ok(sawActionConsequences, `${rows} rows labels read-only action consequences in context`);
		assert.deepEqual([...visited].sort(), ["OVERSIZED ONE BEGIN", "OVERSIZED_ONE_COMPLETE_END", "OVERSIZED THREE BEGIN", "OVERSIZED_THREE_COMPLETE_END", "OVERSIZED TWO BEGIN", "OVERSIZED_TWO_COMPLETE_END"].sort(), `${rows} rows exposes every oversized effect boundary through context paging`);
		const afterDetails = component.render(80);
		assert.ok(afterDetails.includes("Details (read-only)"), `${rows} rows retains a read-only details heading while paging`);
		component.handleInput("\r");
		assert.deepEqual(selected, [], `${rows} rows keeps details read-only after paging`);
	}
});
