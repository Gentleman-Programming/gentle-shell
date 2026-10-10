import assert from "node:assert/strict";
import { test } from "node:test";
import { VisualCustomizeView, type CustomizeInline, type CustomizeRow } from "../lib/visual-customize-view.ts";
import { CommandPalette } from "../lib/command-palette.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName, Theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const theme = { fg: (_role: string, text: string) => text };
type FoldableRow = CustomizeRow & { visible?: () => boolean; keyhint?: string };

test("Customize shares Commands card geometry, header and focused-row style at wide, narrow and short sizes", () => {
	for (const [width, height] of [[100, 24], [36, 12], [76, 5]] as const) {
		const palette = new CommandPalette([{ title: "Settings", items: [{ command: "x", label: "Choice" }] }], () => {}, theme, () => height);
		const view = new VisualCustomizeView({ rows: [
			{ category: "Animations", label: "Quality", action: () => {} },
			{ category: "Themes", label: "Dark", preview: () => ({ title: "Dark", sample: "█ #123456" }), action: () => {} },
		], theme, rowsAvailable: () => height, requestRender: () => {}, onClose: () => {} });
		const commands = palette.render(width), customize = view.render(width);
		assert.equal(customize[0], commands[0]);
		assert.equal(customize.at(-1), commands.at(-1));
		assert.ok(customize.every(line => visibleWidth(line) === width));
		assert.ok(customize.length <= height);
		assert.match(customize.join("\n"), /Customization.*esc/);
		assert.match(customize.join("\n"), /▸ Animations/);
		if (height > 5) {
			view.handleInput("\x1b[C");
			assert.match(view.render(width).join("\n"), /▸ Quality/);
		}
	}
});

test("focused category and control use Commands selectedBg bar without mutating a preview", () => {
	const events: string[] = [];
	const highlighted = { fg: (_role: string, value: string) => value, bg: (_role: string, value: string) => `\x1b[44m${value}\x1b[49m` };
	const view = new VisualCustomizeView({ rows: [
		{ category: "Themes", label: "Installed theme", preview: () => ({ title: "source", sample: "█ #112233" }), action: () => { events.push("theme"); } },
	], theme: highlighted, requestRender: () => {}, onClose: () => {} });
	assert.match(view.render(76).join("\n"), /\x1b\[44m\s+Themes/);
	view.handleInput("\x1b[C");
	const frame = view.render(76).join("\n");
	assert.match(frame, /\x1b\[44m\s+Installed theme/);
	assert.match(frame, /Preview · source[\s\S]*█ #112233/);
	assert.deepEqual(events, []);
});

test("profiles retain Commands card geometry at wide, narrow and short heights", () => {
	for (const [width, height] of [[100, 24], [36, 12], [76, 6]] as const) {
		const view = new VisualCustomizeView({ rows: [], theme, rowsAvailable: () => height, requestRender: () => {}, onClose: () => {}, profiles: { list: () => [], save: () => {}, apply: () => {}, delete: () => {}, reset: () => {} } });
		view.handleInput("p");
		const frame = view.render(width);
		assert.match(frame[0] ?? "", /^╭─+╮$/);
		assert.match(frame.at(-1) ?? "", /^╰─+╯$/);
		assert.ok(frame.length <= height && frame.every(line => visibleWidth(line) === width));
	}
});

test("customization view renders with Pi's real Theme instance", () => {
	const piTheme = getThemeByName("dark");
	assert.ok(piTheme instanceof Theme);
	const view = new VisualCustomizeView({ rows: [{ label: "Theme: dark", action: () => {} }], theme: piTheme, requestRender: () => {}, onClose: () => {} });
	assert.match(view.render(80).join("\n"), /Theme: dark/);
});

test("customization view navigates, activates and closes on Escape", () => {
	const actions: string[] = [];
	let closed = 0;
	const view = new VisualCustomizeView({ rows: [{ label: "Rose: on", action: () => { actions.push("rose"); } }, { label: "Reset defaults", action: () => { actions.push("reset"); } }], theme, requestRender: () => {}, onClose: () => { closed++; } });
	assert.match(view.render(40).join("\n"), /Rose: on/);
	view.handleInput("\x1b[B");
	view.handleInput("\r");
	assert.deepEqual(actions, ["reset"]);
	view.handleInput("\x1b");
	assert.equal(closed, 1);
});

test("view handles empty rows, narrow and zero widths without invalid selection", () => {
	const view = new VisualCustomizeView({ rows: [], theme, rowsAvailable: () => 8, requestRender: () => {}, onClose: () => {} });
	view.handleInput("\x1b[A");
	view.handleInput("\x1b[B");
	view.handleInput("\r");
	assert.match(view.render(30).join("\n"), /No settings available/);
	for (const width of [0, 1, 4]) assert.ok(view.render(width).every((line) => visibleWidth(line) <= Math.max(0, width)));
});

test("tiny terminal heights never display settings beyond available rows", () => {
	let height = 0;
	const view = new VisualCustomizeView({ rows: [{ label: "Secret setting", action: () => {} }], theme, rowsAvailable: () => height, requestRender: () => {}, onClose: () => {} });
	assert.deepEqual(view.render(40), []);
	height = 1;
	assert.equal(view.render(40).length, 1);
	assert.doesNotMatch(view.render(40).join("\n"), /Secret setting/);
	height = 2;
	assert.equal(view.render(40).length, 2);
	assert.doesNotMatch(view.render(40).join("\n"), /Secret setting/);
	view.handleInput("\r");
	view.handleInput("\x1b");
});


test("profile name submission never accepts a hidden field at heights 3–5, including after errors and resize", async () => {
	for (const height of [3, 4, 5]) for (const withError of [false, true]) {
		let available = 12;
		const saved: string[] = [];
		const view = new VisualCustomizeView({ rows: [], theme, rowsAvailable: () => available, requestRender: () => {}, onClose: () => {}, profiles: {
			list: () => [], save: name => { if (name === "cause-error") throw new Error("write failed"); saved.push(name); }, apply: () => {}, delete: () => {}, reset: () => {},
		} });
		view.handleInput("p");
		if (withError) { view.render(76); view.handleInput("s"); view.handleInput("cause-error\r"); await new Promise<void>(resolve => setImmediate(resolve)); }
		view.handleInput("s"); view.handleInput("Hidden");
		available = height;
		const frame = view.render(76).join("\n");
		const visible = frame.includes("New profile name: Hidden▏");
		view.handleInput("\r");
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(saved, visible ? ["Hidden"] : [], `height=${height}, error=${withError}: hidden profile input must not save`);
	}
});

test("profile preview and cancel never apply; keyboard name and confirmations require deliberate input", async () => {
 const events: string[] = [];
 const profile = { name: "Desk", themeName: "Light Theme", animationPolicy: "potato" as const, banner: { showRose: false, showTextLogo: true, color: "cyan" as const }, visual: { statusPlacement: "hidden" as const, headerPlacement: "below-input" as const, density: "compact" as const, visibility: { changes: false, rdd: false, agents: true, todo: false, usageCost: true, modelDetails: false } } };
 const view = new VisualCustomizeView({ rows: [], theme, requestRender: () => {}, onClose: () => {}, profiles: {
  list: () => [profile], save: (name, replace) => { events.push(`save:${name}:${replace}`); }, apply: (name) => { events.push(`apply:${name}`); }, delete: (name) => { events.push(`delete:${name}`); }, reset: () => { events.push("reset"); },
 } });
 view.handleInput("p");
 assert.match(view.render(100).join("\n"), /Light Theme/);
 assert.match(view.render(100).join("\n"), /potato.*cyan/);
 assert.match(view.render(100).join("\n"), /hidden.*below-input.*compact/);
 assert.match(view.render(100).join("\n"), /changes:off.*rdd:off.*agents:on.*todo:off.*usageCost:on.*modelDetails:off/);
 view.handleInput("a"); view.handleInput("\x1b");
 assert.deepEqual(events, []);
 view.handleInput("p"); view.handleInput("s"); view.handleInput("New"); view.handleInput("\x7f"); view.handleInput("w\r");
 assert.deepEqual(events, ["save:New:false"]);
 await new Promise<void>(resolve => setImmediate(resolve));
 view.handleInput("r"); view.handleInput("\x1b"); view.handleInput("d"); view.handleInput("n");
 assert.deepEqual(events, ["save:New:false"]);
 view.handleInput("r"); assert.match(view.render(100).join("\n"), /Confirm replace Desk\? y yes/); view.handleInput("y");
 assert.deepEqual(events, ["save:New:false", "save:Desk:true"]);
 await new Promise<void>(resolve => setImmediate(resolve));
 view.handleInput("a"); assert.match(view.render(100).join("\n"), /Confirm apply Desk\? y yes/); view.handleInput("y");
 assert.deepEqual(events, ["save:New:false", "save:Desk:true", "apply:Desk"]);
 await new Promise<void>(resolve => setImmediate(resolve));
 view.handleInput("z"); assert.match(view.render(100).join("\n"), /Confirm reset catalog\? y yes/); view.handleInput("y");
 assert.deepEqual(events.at(-1), "reset");
});

test("profile confirmation stays visible at six rows for every destructive or applying action", async () => {
	const events: string[] = [];
	const profile = { name: "Desk", themeName: "Light", animationPolicy: "potato" as const, banner: { showRose: false, showTextLogo: true, color: "cyan" as const }, visual: { statusPlacement: "hidden" as const, headerPlacement: "below-input" as const, density: "compact" as const, visibility: { changes: false, rdd: false, agents: true, todo: false, usageCost: true, modelDetails: false } } };
	const view = new VisualCustomizeView({ rows: [], theme, rowsAvailable: () => 6, requestRender: () => {}, onClose: () => {}, profiles: {
		list: () => [profile], save: (name, replace) => { events.push(`save:${name}:${replace}`); }, apply: (name) => { events.push(`apply:${name}`); }, delete: (name) => { events.push(`delete:${name}`); }, reset: () => { events.push("reset"); },
	} });
	view.handleInput("p");
	for (const [key, label, result] of [["r", "replace Desk", "save:Desk:true"], ["a", "apply Desk", "apply:Desk"], ["d", "delete Desk", "delete:Desk"], ["z", "reset catalog", "reset"]]) {
		view.handleInput(key!);
		const lines = view.render(100);
		assert.ok(lines.length <= 6);
		assert.ok(lines.some(line => line.includes(`Confirm ${label}? y yes`)), `${label} must be visible`);
		view.handleInput("y");
		assert.equal(events.at(-1), result);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
});

test("profile confirmation captures selected name across catalog mutation and cancels vanished targets", async () => {
	const events: string[] = [];
	const base = { themeName: "Light", animationPolicy: "potato" as const, banner: { showRose: false, showTextLogo: true, color: "cyan" as const }, visual: { statusPlacement: "hidden" as const, headerPlacement: "below-input" as const, density: "compact" as const, visibility: { changes: false, rdd: false, agents: true, todo: false, usageCost: true, modelDetails: false } } };
	let catalog = [{ ...base, name: "Desk" }, { ...base, name: "Mobile" }];
	const view = new VisualCustomizeView({ rows: [], theme, rowsAvailable: () => 6, requestRender: () => {}, onClose: () => {}, profiles: {
		list: () => catalog, save: (name, replace) => { events.push(`save:${name}:${replace}`); }, apply: (name) => { events.push(`apply:${name}`); }, delete: (name) => { events.push(`delete:${name}`); }, reset: () => { events.push("reset"); },
	} });
	view.handleInput("p");
	for (const [key, result] of [["r", "save:Desk:true"], ["a", "apply:Desk"], ["d", "delete:Desk"]]) {
		catalog = [{ ...base, name: "Desk" }, { ...base, name: "Mobile" }];
		view.handleInput(key!);
		assert.match(view.render(100).join("\n"), /Confirm .* Desk\? y yes/);
		catalog.unshift({ ...base, name: "Inserted" });
		view.handleInput("y");
		assert.equal(events.at(-1), result);
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	view.handleInput("j"); view.handleInput("d");
	assert.match(view.render(100).join("\n"), /Confirm delete Desk\? y yes/);
	catalog = [{ ...base, name: "Mobile" }];
	view.handleInput("y");
	assert.deepEqual(events, ["save:Desk:true", "apply:Desk", "delete:Desk"]);
});

test("unrendered or clipped confirmations cannot be accepted", () => {
	const events: string[] = [];
	let height = 6;
	const base = { name: "Desk", themeName: "Light", animationPolicy: "potato" as const, banner: { showRose: false, showTextLogo: true, color: "cyan" as const }, visual: { statusPlacement: "hidden" as const, headerPlacement: "below-input" as const, density: "compact" as const, visibility: { changes: false, rdd: false, agents: true, todo: false, usageCost: true, modelDetails: false } } };
	const view = new VisualCustomizeView({ rows: [], theme, rowsAvailable: () => height, requestRender: () => {}, onClose: () => {}, profiles: {
		list: () => [base], save: () => {}, apply: () => {}, delete: () => { events.push("delete"); }, reset: () => { events.push("reset"); },
	} });
	view.handleInput("p"); view.handleInput("d"); view.handleInput("y");
	assert.deepEqual(events, []);
	view.handleInput("d"); assert.doesNotMatch(view.render(5).join("\n"), /y yes/); view.handleInput("y");
	assert.deepEqual(events, []);
	view.handleInput("z"); view.render(100); height = 0; view.handleInput("y");
	assert.deepEqual(events, []);
});

test("profile confirmations cannot execute after an unrendered resize hides full identity and yes", () => {
	const name = "A".repeat(64);
	const profile = { name, themeName: "dark", animationPolicy: "quality" as const, banner: { showRose: true, showTextLogo: true, color: "pink" as const }, visual: { statusPlacement: "auto" as const, headerPlacement: "top" as const, density: "comfortable" as const, visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true } } };
	for (const [key, action] of [["a", "apply"], ["d", "delete"], ["r", "replace"], ["z", "reset"]] as const) {
		for (const width of [100, 36]) for (const shortHeight of [1, 2]) {
			let height = 12;
			const effects: string[] = [];
			const view = new VisualCustomizeView({ rows: [], theme, rowsAvailable: () => height, requestRender: () => {}, onClose: () => {}, profiles: {
				list: () => [profile], save: (value, replace) => { effects.push(`save:${value}:${replace}`); },
				apply: value => { effects.push(`apply:${value}`); }, delete: value => { effects.push(`delete:${value}`); }, reset: () => { effects.push("reset"); },
			} });
			view.handleInput("p"); view.handleInput(key);
			const frame = view.render(width).join("\n");
			assert.match(frame, /Confirm /);
			assert.match(frame, /y yes/);
			assert.ok(frame.replace(/\x1b\[[0-9;]*m|\s|[│╭╮╰╯─]/g, "").includes(name) || action === "reset", "full target identity must be visible before resizing");
			height = shortHeight;
			view.handleInput("y"); // Deliberately no render after resize.
			assert.deepEqual(effects, [], `${action} at ${width} columns, ${shortHeight} rows must fail closed`);
		}
	}
});

test("profile confirmation refuses a changed target identity without another render", () => {
	let catalog = [{ name: "First", themeName: "dark", animationPolicy: "quality" as const, banner: { showRose: true, showTextLogo: true, color: "pink" as const }, visual: { statusPlacement: "auto" as const, headerPlacement: "top" as const, density: "comfortable" as const, visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true } } }];
	const effects: string[] = [];
	const view = new VisualCustomizeView({ rows: [], theme, rowsAvailable: () => 12, requestRender: () => {}, onClose: () => {}, profiles: { list: () => catalog, save: () => {}, apply: name => { effects.push(name); }, delete: () => {}, reset: () => {} } });
	view.handleInput("p"); view.handleInput("a");
	assert.match(view.render(100).join("\n"), /Confirm apply First\? y yes/);
	catalog = [{ ...catalog[0]!, name: "Second" }];
	view.handleInput("y");
	assert.deepEqual(effects, []);
});

test("main controls require a visible selected row at the last rendered width and current height", async () => {
	let height = 12;
	const actions: string[] = [];
	const view = new VisualCustomizeView({ rows: [{ category: "Reset", label: "Reset defaults", action: () => { actions.push("reset"); } }], theme, rowsAvailable: () => height, requestRender: () => {}, onClose: () => {} });
	view.handleInput("\x1b[C");
	view.handleInput("\r");
	assert.deepEqual(actions, [], "unrendered control cannot apply");
	view.render(76);
	for (const width of [0, 1, 4, 6]) {
		view.render(width);
		view.handleInput("\r");
		view.handleInput(" ");
		assert.deepEqual(actions, [], `hidden control activated at ${width} columns`);
	}
	view.render(76);
	height = 2; // Resize without rerendering before activation.
	view.handleInput("\r");
	view.handleInput(" ");
	assert.deepEqual(actions, [], "hidden control activated after an unrendered height change");
	height = 12;
	view.render(76);
	view.handleInput(" ");
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(actions, ["reset"], "visible Space selection still applies");
});

test("profile confirmation refuses same-name content drift for apply, replace and delete", () => {
	const original = { name: "Desk", themeName: "dark", animationPolicy: "quality" as const, banner: { showRose: true, showTextLogo: true, color: "pink" as const }, visual: { statusPlacement: "auto" as const, headerPlacement: "top" as const, density: "comfortable" as const, visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true } } };
	for (const key of ["a", "r", "d"]) {
		let catalog = [original];
		const effects: string[] = [];
		const view = new VisualCustomizeView({ rows: [], theme, rowsAvailable: () => 12, requestRender: () => {}, onClose: () => {}, profiles: {
			list: () => catalog, save: () => { effects.push("replace"); }, apply: () => { effects.push("apply"); }, delete: () => { effects.push("delete"); }, reset: () => {},
		} });
		view.handleInput("p"); view.handleInput(key);
		assert.match(view.render(76).join("\n"), /Confirm /);
		catalog = [{ ...original, themeName: "light" }];
		view.handleInput("y");
		assert.deepEqual(effects, [], `${key} must not use a changed profile`);
		assert.match(view.render(76).join("\n"), /changed|choose again/i);
	}
});

test("category panel renders bounded wide and narrow frames with independent navigation", async () => {
	const actions: string[] = [];
	let height = 14;
	const categories = ["Animations", "Banner", "Themes", "Layout", "Sections", "Profiles", "Reset"] as const;
	const rows = categories.flatMap(category => Array.from({ length: category === "Banner" ? 12 : 2 }, (_, i) => ({ category, label: `${category} option ${i} (current)`, action: () => { actions.push(`${category}:${i}`); } })));
	const view = new VisualCustomizeView({ rows, theme, rowsAvailable: () => height, requestRender: () => {}, onClose: () => {} });
	const wide = view.render(76);
	assert.ok(wide.length <= height && wide.length < 20);
	assert.ok(wide.every(line => visibleWidth(line) <= 76));
	assert.match(wide.join("\n"), /Animations.*Animations option 0/);
	assert.match(wide.join("\n"), /Banner/);
	assert.match(wide.join("\n"), /Preview unavailable/);
	view.handleInput("\x1b[B"); // Move the category cursor, not the controls cursor.
	assert.match(view.render(76).join("\n"), /Banner option 0/);
	view.handleInput("\x1b[C"); view.handleInput("\x1b[B"); view.handleInput("\r");
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.deepEqual(actions, ["Banner:1"]);
	height = 7;
	for (let i = 0; i < 10; i++) view.handleInput("\x1b[B");
	const short = view.render(76);
	assert.ok(short.length <= 7 && short.every(line => visibleWidth(line) <= 76));
	assert.match(short.join("\n"), /Banner option 11/);
	assert.match(short.join("\n"), /Esc/);
	const narrow = view.render(36);
	assert.ok(narrow.length <= 7 && narrow.every(line => visibleWidth(line) <= 36));
	assert.match(narrow.join("\n"), /Banner/);
	assert.doesNotMatch(narrow.join("\n"), /Animations option/);
	view.handleInput("\x1b[D");
	assert.match(view.render(36).join("\n"), /category|Categories/i);
});

test("long profile confirmation displays complete identity and yes instruction before accepting", async () => {
	const name = "A".repeat(64);
	const events: string[] = [];
	const profile = { name, themeName: "dark", animationPolicy: "quality" as const, banner: { showRose: true, showTextLogo: true, color: "pink" as const }, visual: { statusPlacement: "auto" as const, headerPlacement: "top" as const, density: "comfortable" as const, visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true } } };
	let height = 8;
	const view = new VisualCustomizeView({ rows: [], theme, rowsAvailable: () => height, requestRender: () => {}, onClose: () => {}, profiles: { list: () => [profile], save: () => {}, apply: value => { events.push(value); }, delete: () => {}, reset: () => {} } });
	view.handleInput("p");
	for (const width of [76, 36]) {
		view.handleInput("a");
		const frame = view.render(width);
		assert.ok(frame.every(line => visibleWidth(line) <= width));
		assert.match(frame.join("\n"), /Confirm apply/);
		assert.ok(frame.join("").replace(/\x1b\[[0-9;]*m|\s|[│╭╮╰╯─]/g, "").includes(name), `the full target identity must be readable across wrapped lines: ${JSON.stringify(frame)}`);
		assert.match(frame.join("\n"), /y yes/);
		view.handleInput("y");
		assert.deepEqual(events, Array.from({ length: width === 76 ? 1 : 2 }, () => name));
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	height = 2;
	view.handleInput("a"); view.render(36); view.handleInput("y");
	assert.equal(events.length, 2, "a confirmation that cannot fit must not authorize mutation");
});

test("Tab switches categories and controls in both directions", () => {
	const view = new VisualCustomizeView({ rows: [{ category: "Animations", label: "Speed", action: () => {} }, { category: "Banner", label: "Rose", action: () => {} }], theme, requestRender: () => {}, onClose: () => {} });
	view.handleInput("\t"); view.handleInput("\x1b[B");
	assert.match(view.render(76).join("\n"), /▸ Speed/);
	view.handleInput("\t"); view.handleInput("\x1b[B");
	assert.match(view.render(76).join("\n"), /▸ Banner/);
	assert.match(view.render(76).join("\n"), /│ ▸ Rose/);
});

test("short terminal never activates a control whose selected row is invisible", () => {
	let calls = 0;
	const view = new VisualCustomizeView({ rows: [{ category: "Reset", label: "Reset defaults", action: () => { calls++; } }], theme, rowsAvailable: () => 5, requestRender: () => {}, onClose: () => {} });
	view.handleInput("\x1b[C");
	const frame = view.render(76);
	assert.ok(frame.some(line => line.includes("▸ Reset defaults")), "the active control must be visible at five available rows");
	view.handleInput("\r");
	assert.equal(calls, 1);
});

test("rows without a read-only sample never claim a visual preview", () => {
	const view = new VisualCustomizeView({ rows: [{ category: "Layout", label: "Status placement: right (current)", action: () => {} }, { category: "Layout", label: "Density: compact", action: () => {} }], theme, requestRender: () => {}, onClose: () => {} });
	view.handleInput("\x1b[C"); view.handleInput("\x1b[B");
	const frame = view.render(76).join("\n");
	assert.doesNotMatch(frame, /Preview ·/);
	assert.match(frame, /Preview unavailable/);
});

test("Editor category is keyboard reachable in narrow and short layouts; preview never applies", async () => {
	for (const [width, height] of [[76, 12], [36, 12], [36, 5]] as const) {
		const effects: string[] = [];
		const view = new VisualCustomizeView({ rows: [
			{ category: "Animations", label: "Quality", action: () => {} },
			{ category: "Editor", label: "Vim: enable", preview: () => ({ title: "Vim preference", sample: "preference: off · effective: off" }), action: () => { effects.push("on"); } },
			{ category: "Editor", label: "Vim: disable", action: () => { effects.push("off"); } },
		], theme, rowsAvailable: () => height, requestRender: () => {}, onClose: () => {} });
		view.render(width);
		view.handleInput("\x1b[B"); // Editor category
		if (width < 60) assert.match(view.render(width).join("\n"), /Editor/);
		view.handleInput("\x1b[C");
		const frame = view.render(width);
		assert.ok(frame.every(line => visibleWidth(line) <= width));
		assert.match(frame.join("\n"), /Vim: enable/);
		if (height >= 11) assert.match(frame.join("\n"), /preference: off/);
		assert.deepEqual(effects, []);
		view.handleInput(" "); await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual(effects, ["on"]);
	}
});

test("selected layout and section controls change a genuine schematic without applying", () => {
	const changes: string[] = [];
	const view = new VisualCustomizeView({ rows: [
		{ category: "Layout", label: "Status: bottom", preview: () => ({ title: "Status at bottom", sample: "┌ header ┐  editor  └ status ┘" }), action: () => { changes.push("bottom"); } },
		{ category: "Layout", label: "Status: hidden", preview: () => ({ title: "Status hidden", sample: "┌ header ┐  editor  (no side rail)" }), action: () => { changes.push("hidden"); } },
		{ category: "Sections", label: "Changes: hidden", preview: () => ({ title: "Changes hidden", sample: "[Agents] [TODO] [Usage]" }), action: () => { changes.push("sections"); } },
	], theme, requestRender: () => {}, onClose: () => {} });
	view.handleInput("\x1b[C");
	assert.match(view.render(76).join("\n"), /Preview · Status at bottom[\s\S]*└ status ┘/);
	view.handleInput("\x1b[B");
	assert.match(view.render(76).join("\n"), /Preview · Status hidden[\s\S]*no side rail/);
	view.handleInput("\x1b[D"); view.handleInput("\x1b[B"); view.handleInput("\x1b[C");
	assert.match(view.render(36).join("\n"), /Preview · Changes hidden[\s\S]*Agents/);
	assert.deepEqual(changes, []);
});

test("under four available rows refuses invisible control activation", () => {
	let calls = 0;
	const view = new VisualCustomizeView({ rows: [{ category: "Reset", label: "Reset", action: () => { calls++; } }], theme, rowsAvailable: () => 3, requestRender: () => {}, onClose: () => {} });
	view.handleInput("\x1b[C"); view.render(76); view.handleInput("\r");
	assert.equal(calls, 0);
});

test("view awaits async actions, reports errors and repaints after completion", async () => {
	let release!: () => void;
	let renders = 0;
	const errors: string[] = [];
	const view = new VisualCustomizeView({ rows: [{ label: "Save", action: () => new Promise<void>((_resolve, reject) => { release = () => reject(new Error("write failed")); }) }], theme, requestRender: () => { renders++; }, onError: (error) => { errors.push(error.message); }, onClose: () => {} });
	view.render(76);
	view.handleInput("\r");
	view.handleInput("\r");
	release();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(errors, ["write failed"]);
	assert.ok(renders >= 2);
});

// --- inline bridge (direct rows, no nested native dialogs) --------------------

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function inlineView(action: (inline: CustomizeInline) => void | Promise<void>, options: { rowsAvailable?: () => number; onClose?: () => void } = {}) {
	return new VisualCustomizeView({ rows: [{ label: "Field row", action }], theme, rowsAvailable: options.rowsAvailable ?? (() => 12), requestRender: () => {}, onClose: options.onClose ?? (() => {}) });
}

test("Notifications header reads Audio notifications while other panes read Customization", () => {
	const view = new VisualCustomizeView({ rows: [
		{ category: "Animations", label: "Speed", action: () => {} },
		{ category: "Notifications", label: "Audio notifications: off", action: () => {} },
	], theme, requestRender: () => {}, onClose: () => {} });
	assert.equal(view.title(), "Customization");
	assert.match(view.render(76).join("\n"), /Customization.*esc/);
	view.handleInput("\x1b[B");
	assert.equal(view.title(), "Audio notifications");
	assert.match(view.render(76).join("\n"), /Audio notifications.*esc/);
});

test("inline field accepts typed, pasted and Kitty input, submits on Enter and cancels with Escape without closing", async () => {
	let closed = 0;
	const submitted: string[] = [];
	const view = inlineView(async inline => {
		const value = await inline.input({ prompt: "Path", value: "" });
		if (value !== undefined) submitted.push(value);
	}, { onClose: () => { closed++; } });
	view.render(76);
	view.handleInput("\r");
	await tick();
	assert.match(view.render(76).join("\n"), /Path:/);
	view.handleInput("a");
	view.handleInput("\x1b[200~b c\x1b[201~");
	view.handleInput("\x1b[100u");
	assert.match(view.render(76).join("\n"), /Path: ab cd/);
	view.handleInput("\x1b");
	await tick();
	assert.equal(closed, 0, "first Escape cancels the field, not the whole card");
	assert.deepEqual(submitted, []);
	assert.doesNotMatch(view.render(76).join("\n"), /Path:/);
	view.handleInput("\x1b");
	assert.equal(closed, 1, "second Escape closes the card");
});

test("inline field submits a visible value and drops invisible resizes without writing", async () => {
	let height = 12;
	const submitted: string[] = [];
	const view = inlineView(async inline => {
		const value = await inline.input({ prompt: "Path", value: "" });
		if (value !== undefined) submitted.push(value);
	}, { rowsAvailable: () => height });
	view.render(76);
	view.handleInput("\r");
	await tick();
	view.handleInput("/local/a.wav");
	view.render(76);
	view.handleInput("\r");
	await tick();
	assert.deepEqual(submitted, ["/local/a.wav"]);

	const hidden = inlineView(async inline => {
		const value = await inline.input({ prompt: "Path", value: "x" });
		if (value !== undefined) submitted.push(value);
	}, { rowsAvailable: () => height });
	hidden.render(76);
	hidden.handleInput("\r");
	await tick();
	height = 3; // Resize below the preview area without another render.
	hidden.handleInput("\r");
	await tick();
	assert.deepEqual(submitted, ["/local/a.wav"], "an Enter that cannot see the field must not submit");
});

test("inline confirmation accepts only a fully visible yes and resolves false otherwise", async () => {
	let height = 12;
	const seen: boolean[] = [];
	const view = inlineView(async inline => { seen.push(await inline.confirm("Replace invalid audio configuration? The existing file is malformed or unreadable.")); }, { rowsAvailable: () => height });
	view.render(76);
	view.handleInput("\r");
	await tick();
	assert.match(view.render(76).join("\n"), /y yes/);
	view.handleInput("n");
	await tick();
	assert.deepEqual(seen, [false]);

	const second = inlineView(async inline => { seen.push(await inline.confirm("Replace invalid audio configuration? The existing file is malformed or unreadable.")); }, { rowsAvailable: () => height });
	second.render(76);
	second.handleInput("\r");
	await tick();
	second.handleInput("y");
	await tick();
	assert.deepEqual(seen, [false, true]);

	const short = inlineView(async inline => { seen.push(await inline.confirm("Replace invalid audio configuration? The existing file is malformed or unreadable.")); }, { rowsAvailable: () => 5 });
	short.render(76);
	short.handleInput("\r");
	await tick();
	short.handleInput("y");
	await tick();
	assert.deepEqual(seen, [false, true, false], "a confirmation with no visible yes must fail closed");
});

test("dispose resolves a pending inline field as cancelled without writing", async () => {
	let observed: CustomizeInline | undefined;
	const submitted: string[] = [];
	const view = inlineView(async inline => {
		observed = inline;
		const value = await inline.input({ prompt: "Path", value: "" });
		if (value !== undefined) submitted.push(value);
	});
	view.render(76);
	view.handleInput("\r");
	await tick();
	view.dispose();
	await tick();
	assert.deepEqual(submitted, []);
	assert.equal(observed!.disposed, true, "the bridge signals disposal so rows cannot persist");
	view.handleInput("\x1b");
	assert.deepEqual(submitted, [], "a disposed view ignores further input");
});

test("row key shortcuts run before panel shortcuts and are ignored outside the controls pane", () => {
	const keys: string[] = [];
	const view = new VisualCustomizeView({ rows: [{ category: "Notifications", label: "event", action: () => {}, key: (data) => { if (data === "p") { keys.push("p"); return true; } return false; } }],
		theme, requestRender: () => {}, onClose: () => {}, profiles: { list: () => [], save: () => {}, apply: () => {}, delete: () => {}, reset: () => {} } });
	view.render(76);
	// Categories pane: the row key is not consulted, so the panel handles p.
	view.handleInput("p");
	assert.deepEqual(keys, []);
	view.handleInput("\x1b");
	view.handleInput("\x1b[C");
	view.handleInput("p");
	assert.deepEqual(keys, ["p"], "the highlighted row consumes p instead of opening profiles");
});

test("Notifications non-event controls consume p without opening visual profiles and keep the audio title", () => {
	const listed: string[] = [];
	const rows: CustomizeRow[] = [
		{ category: "Notifications", label: "Audio notifications: on", action: () => {} },
		{ category: "Notifications", label: "Audio: unmuted", action: () => {} },
		{ category: "Notifications", label: "Advanced: show per-event exceptions", action: () => {} },
	];
	const view = new VisualCustomizeView({ rows, theme, requestRender: () => {}, onClose: () => {}, profiles: { list: () => { listed.push("list"); return []; }, save: () => {}, apply: () => {}, delete: () => {}, reset: () => {} } });
	view.render(76);
	view.handleInput("\x1b[C");
	for (let i = 0; i < rows.length; i++) {
		view.handleInput("p");
		const frame = view.render(76).join("\n");
		assert.equal(view.title(), "Audio notifications", `non-event row ${i} must keep the audio title`);
		assert.match(frame, /Audio notifications/, `non-event row ${i} must stay on the audio card`);
		assert.doesNotMatch(frame, /Visual profiles/, `non-event row ${i} must not open the profile pane`);
		if (i < rows.length - 1) view.handleInput("\x1b[B");
	}
	assert.deepEqual(listed, [], "the profile catalog must never be listed from Notifications controls");
});

test("p still opens visual profiles from a non-Notifications control", () => {
	const listed: string[] = [];
	const view = new VisualCustomizeView({ rows: [{ category: "Themes", label: "Dark", action: () => {} }], theme, requestRender: () => {}, onClose: () => {}, profiles: { list: () => { listed.push("list"); return []; }, save: () => {}, apply: () => {}, delete: () => {}, reset: () => {} } });
	view.render(76);
	view.handleInput("\x1b[C");
	view.handleInput("p");
	assert.match(view.render(76).join("\n"), /Visual profiles/);
	assert.equal(listed.length, 1);
});

test("the Notifications card footer is audio-specific and never advertises visual profiles", () => {
	const profiles = { list: () => [], save: () => {}, apply: () => {}, delete: () => {}, reset: () => {} };
	const view = new VisualCustomizeView({ rows: [
		{ category: "Animations", label: "Speed", action: () => {} },
		{ category: "Notifications", label: "Audio notifications: off", action: () => {} },
	], theme, requestRender: () => {}, onClose: () => {}, rowsAvailable: () => 24, profiles });
	view.handleInput("\x1b[B");
	view.handleInput("\x1b[C");
	for (const width of [60, 80]) {
		const frame = view.render(width).join("\n");
		assert.match(frame, /Tab panes · Enter change · p test · Esc close/, `basic audio footer at width ${width}`);
		assert.doesNotMatch(frame, /f WAV/, `basic audio footer must not advertise file editing at width ${width}`);
		assert.doesNotMatch(frame, /p profiles/, `audio footer must not advertise profiles at width ${width}`);
	}
	const other = new VisualCustomizeView({ rows: [{ category: "Themes", label: "Dark", action: () => {} }], theme, requestRender: () => {}, onClose: () => {}, rowsAvailable: () => 24, profiles });
	other.handleInput("\x1b[C");
	assert.match(other.render(80).join("\n"), /p profiles/, "other categories keep the profiles hint");
});

test("an async row key task holds busy until it settles and releases it after a rejection", async () => {
	const errors: Error[] = [];
	const keyed: string[] = [];
	let actions = 0;
	const view = new VisualCustomizeView({ rows: [{
		category: "Notifications", label: "Async row", action: () => { actions++; },
		key: data => { if (data === "f") { keyed.push("f"); return Promise.reject(new Error("key failed")); } return false; },
	}], theme, requestRender: () => {}, onClose: () => {}, onError: error => errors.push(error), rowsAvailable: () => 12 });
	view.render(76);
	view.handleInput("\x1b[C");
	view.handleInput("f");
	view.handleInput("f");
	assert.deepEqual(keyed, ["f"], "a second key is ignored while the async task is busy");
	await tick(); await tick();
	assert.equal(errors.length, 1, "a rejected key surfaces through onError");
	assert.equal(errors[0]?.message, "key failed");
	view.handleInput("\r");
	await tick();
	assert.equal(actions, 1, "busy is released after the rejected key task settles");
});

test("a visible() false row is unreachable and its action or key is never invoked", async () => {
	const actions: string[] = [];
	const keys: string[] = [];
	let advanced = false;
	const rows: FoldableRow[] = [
		{ category: "Notifications" as const, label: "Basic", action: () => { actions.push("basic"); } },
		{ category: "Notifications" as const, label: "Hidden detail", visible: () => advanced, action: () => { actions.push("hidden"); }, key: (data: string) => { keys.push(data); return true; } },
	];
	const view = new VisualCustomizeView({ rows, theme, rowsAvailable: () => 12, requestRender: () => {}, onClose: () => {} });
	view.render(76);
	view.handleInput("\x1b[C");
	for (let i = 0; i < 3; i++) { view.handleInput("\x1b[B"); assert.doesNotMatch(view.render(76).join("\n"), /Hidden detail/, "a collapsed row must not render"); }
	view.handleInput("\r");
	view.handleInput("f");
	view.handleInput("p");
	await tick();
	assert.ok(!actions.includes("hidden"), "a hidden row action must never run");
	assert.deepEqual(keys, [], "a hidden row key must never run");
	advanced = true;
	assert.match(view.render(76).join("\n"), /Hidden detail/, "expanding reveals the row");
});

test("selection clamps to a visible row after a collapse", async () => {
	const actions: string[] = [];
	let advanced = true;
	const rows: FoldableRow[] = [
		{ category: "Notifications" as const, label: "Basic", action: () => { actions.push("basic"); } },
		{ category: "Notifications" as const, label: "Advanced", visible: () => advanced, action: () => { actions.push("advanced"); } },
	];
	const view = new VisualCustomizeView({ rows, theme, rowsAvailable: () => 12, requestRender: () => {}, onClose: () => {} });
	view.render(76);
	view.handleInput("\x1b[C");
	view.handleInput("\x1b[B");
	assert.match(view.render(76).join("\n"), /\u25b8 Advanced/);
	advanced = false;
	assert.doesNotMatch(view.render(76).join("\n"), /Advanced/);
	view.handleInput("\r");
	await tick();
	assert.deepEqual(actions, ["basic"], "the collapsed selection clamps to the visible row");
});

test("a throwing visible() callback hides its row instead of exposing it", async () => {
	const actions: string[] = [];
	const rows: FoldableRow[] = [
		{ category: "Notifications" as const, label: "Boom", visible: () => { throw new Error("boom"); }, action: () => { actions.push("boom"); } },
		{ category: "Notifications" as const, label: "Safe", action: () => { actions.push("safe"); } },
	];
	const view = new VisualCustomizeView({ rows, theme, rowsAvailable: () => 12, requestRender: () => {}, onClose: () => {} });
	view.render(76);
	view.handleInput("\x1b[C");
	assert.doesNotMatch(view.render(76).join("\n"), /Boom/, "a row whose visibility check throws must fail closed");
	view.handleInput("\r");
	await tick();
	assert.deepEqual(actions, ["safe"], "the throwing row must never be activated");
});

test("the audio footer drops f WAV when the selected row has no keyhint and advertises it when it does", () => {
	const view = new VisualCustomizeView({ rows: [
		{ category: "Notifications", label: "Audio notifications: off", action: () => {} },
		{ category: "Notifications", label: "Success: success tone", action: () => {}, keyhint: "Tab panes · Enter change · f WAV · p test · Esc close" },
	] as FoldableRow[], theme, rowsAvailable: () => 24, requestRender: () => {}, onClose: () => {}, profiles: { list: () => [], save: () => {}, apply: () => {}, delete: () => {}, reset: () => {} } });
	view.handleInput("\x1b[C");
	const basic = view.render(80).join("\n");
	assert.match(basic, /Tab panes · Enter change · p test · Esc close/, "a row with no keyhint keeps the audio footer without a WAV hint");
	assert.doesNotMatch(basic, /f WAV/, "the default audio footer must not advertise file editing");
	view.handleInput("\x1b[B");
	const advanced = view.render(80).join("\n");
	assert.match(advanced, /Tab panes · Enter change · f WAV · p test · Esc close/, "a row with a keyhint advertises the WAV key");
});
