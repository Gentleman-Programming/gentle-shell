import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { VisualCustomizeView, type CustomizeInline, type CustomizeRow } from "../lib/visual-customize-view.ts";
import { CommandPalette } from "../lib/command-palette.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { TuiAltScreen, visibleWidth, type Terminal, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { getThemeByName, Theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const theme = { fg: (_role: string, text: string) => text };

test("child screen opens from a row and Escape returns without closing", async () => {
 let closed = 0;
 const view = new VisualCustomizeView({ rows: [{ category: "Sections", label: "Configure tabs", action: () => {}, children: ["MAIN", "GIT · coming soon", "TREE · coming soon", "PROFILE · coming soon", "MEMORY · coming soon", "STATS · coming soon"].map(label => ({ label, action: () => {} })) }], theme, requestRender() {}, onClose() { closed++; } });
 view.render(100); view.handleInput("\x1b[C"); view.handleInput("\r"); await new Promise(resolve => setImmediate(resolve));
 const frame = view.render(100).join("\n");
 for (const label of ["MAIN", "GIT · coming soon", "TREE · coming soon", "PROFILE · coming soon", "MEMORY · coming soon", "STATS · coming soon"]) assert.ok(frame.includes(label), label);
 view.handleInput("\x1b"); assert.equal(closed, 0); assert.match(view.render(100).join("\n"), /Configure tabs/);
});
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
 const profile = { name: "Desk", themeName: "Light Theme", animationPolicy: "potato" as const, banner: { showRose: false, showTextLogo: true, color: "cyan" as const }, visual: { statusPlacement: "hidden" as const, headerPlacement: "below-input" as const, density: "compact" as const, surface: "tinted" as const, visibility: { changes: false, rdd: false, agents: true, todo: false, usageCost: true, modelDetails: false, contextWarning: false, stats: false } } };
 const view = new VisualCustomizeView({ rows: [], theme, requestRender: () => {}, onClose: () => {}, profiles: {
  list: () => [profile], save: (name, replace) => { events.push(`save:${name}:${replace}`); }, apply: (name) => { events.push(`apply:${name}`); }, delete: (name) => { events.push(`delete:${name}`); }, reset: () => { events.push("reset"); },
 } });
 view.handleInput("p");
 assert.match(view.render(100).join("\n"), /Light Theme/);
 assert.match(view.render(100).join("\n"), /potato.*cyan/);
 assert.match(view.render(100).join("\n"), /hidden.*below-input.*compact/);
 assert.match(view.render(100).join("\n"), /changes:off.*rdd:off.*agents:on.*todo:off.*usageCost:on.*modelDetails:off/);
 assert.match(view.render(120).join("\n"), /changes:off.*rdd:off.*agents:on.*todo:off.*usageCost:on.*modelDetails:off.*contextWarning:off/);
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
	const profile = { name: "Desk", themeName: "Light", animationPolicy: "potato" as const, banner: { showRose: false, showTextLogo: true, color: "cyan" as const }, visual: { statusPlacement: "hidden" as const, headerPlacement: "below-input" as const, density: "compact" as const, surface: "tinted" as const, visibility: { changes: false, rdd: false, agents: true, todo: false, usageCost: true, modelDetails: false, contextWarning: false, stats: false } } };
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
	const base = { themeName: "Light", animationPolicy: "potato" as const, banner: { showRose: false, showTextLogo: true, color: "cyan" as const }, visual: { statusPlacement: "hidden" as const, headerPlacement: "below-input" as const, density: "compact" as const, surface: "tinted" as const, visibility: { changes: false, rdd: false, agents: true, todo: false, usageCost: true, modelDetails: false, contextWarning: false, stats: false } } };
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
	const base = { name: "Desk", themeName: "Light", animationPolicy: "potato" as const, banner: { showRose: false, showTextLogo: true, color: "cyan" as const }, visual: { statusPlacement: "hidden" as const, headerPlacement: "below-input" as const, density: "compact" as const, surface: "tinted" as const, visibility: { changes: false, rdd: false, agents: true, todo: false, usageCost: true, modelDetails: false, contextWarning: false, stats: false } } };
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
	const profile = { name, themeName: "dark", animationPolicy: "quality" as const, banner: { showRose: true, showTextLogo: true, color: "pink" as const }, visual: { statusPlacement: "auto" as const, headerPlacement: "top" as const, density: "comfortable" as const, surface: "tinted" as const, visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true, stats: false } } };
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
	let catalog = [{ name: "First", themeName: "dark", animationPolicy: "quality" as const, banner: { showRose: true, showTextLogo: true, color: "pink" as const }, visual: { statusPlacement: "auto" as const, headerPlacement: "top" as const, density: "comfortable" as const, surface: "tinted" as const, visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true, stats: false } } }];
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
	const original = { name: "Desk", themeName: "dark", animationPolicy: "quality" as const, banner: { showRose: true, showTextLogo: true, color: "pink" as const }, visual: { statusPlacement: "auto" as const, headerPlacement: "top" as const, density: "comfortable" as const, surface: "tinted" as const, visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true, stats: false } } };
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
	const profile = { name, themeName: "dark", animationPolicy: "quality" as const, banner: { showRose: true, showTextLogo: true, color: "pink" as const }, visual: { statusPlacement: "auto" as const, headerPlacement: "top" as const, density: "comfortable" as const, surface: "tinted" as const, visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true, stats: false } } };
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

test("inline audio paths wrap fully at 80 columns and submit their exact value", async () => {
	const prompt = "Local audio path (WAV/OGG/FLAC, absolute, no URLs)";
	for (const length of [23, 24, 103, 175]) {
		const value = `C:/${"a".repeat(length - 7)}.wav`;
		assert.equal(value.length, length);
		const submitted: string[] = [];
		const view = inlineView(async inline => {
			const result = await inline.input({ prompt, value: "" });
			if (result !== undefined) submitted.push(result);
		});
		view.render(80); view.handleInput("\r"); await tick();
		view.handleInput(`\x1b[200~${value}\x1b[201~`);
		const frame = view.render(80);
		const content = frame.map(line => line.slice(2, -2).trimEnd()).join("");
		assert.ok(content.includes(`${prompt}: ${value}▏`), "every input character and cursor must be visible in order");
		assert.ok(frame.length <= 12);
		assert.ok(frame.every(line => visibleWidth(line) === 80));
		assert.doesNotMatch(frame.join("\n"), /Value too wide|Needs \d+ columns/);
		assert.deepEqual(submitted, [], "rendering must not submit");
		view.handleInput("\r"); await tick();
		assert.deepEqual(submitted, [value]);
	}
});

test("inline overflow reports sufficient room, rejects Enter and remains editable", async () => {
	const submitted: string[] = [];
	const value = "a".repeat(222); // Path: + cursor makes 229 cells; three 76-cell lines hold 228.
	const view = inlineView(async inline => {
		const result = await inline.input({ prompt: "Path", value });
		if (result !== undefined) submitted.push(result);
	});
	view.render(80); view.handleInput("\r"); await tick();
	const frame = view.render(80);
	assert.match(frame.join("\n"), /Needs 233 columns for one line · Esc cancel/);
	assert.ok(frame.every(line => visibleWidth(line) === 80));
	assert.ok(frame.length <= 12);
	view.handleInput("\r"); await tick();
	assert.deepEqual(submitted, []);
	view.handleInput("\x7f");
	view.render(80); view.handleInput("\r"); await tick();
	assert.deepEqual(submitted, [value.slice(0, -1)]);
});

test("wrapped inline values refuse a height shrink before Enter and submit after recovery", async () => {
	let height = 12;
	const submitted: string[] = [];
	const value = "x".repeat(100);
	const view = inlineView(async inline => {
		const result = await inline.input({ prompt: "Path", value });
		if (result !== undefined) submitted.push(result);
	}, { rowsAvailable: () => height });
	view.render(80); view.handleInput("\r"); await tick();
	view.render(80);
	height = 8;
	view.handleInput("\r"); await tick();
	assert.deepEqual(submitted, [], "Enter must recheck live height, not the previous three-line render");
	const shortFrame = view.render(80);
	assert.ok(shortFrame.length <= 8);
	assert.match(shortFrame.join("\n"), /Needs 111 columns for one line/);
	height = 12;
	view.render(80); view.handleInput("\r"); await tick();
	assert.deepEqual(submitted, [value]);
});

test("inline wrapping keeps wide graphemes intact and single-line submission unchanged", async () => {
	for (const value of ["/local/a.wav", "界👩‍💻e\u0301".repeat(16)]) {
		const submitted: string[] = [];
		const view = inlineView(async inline => {
			const result = await inline.input({ prompt: "Path", value });
			if (result !== undefined) submitted.push(result);
		});
		view.render(80); view.handleInput("\r"); await tick();
		const frame = view.render(80);
		assert.ok(frame.every(line => visibleWidth(line) === 80));
		const content = frame.map(line => line.slice(2, -2).trimEnd()).join("");
		assert.ok(content.includes(`Path: ${value}▏`));
		view.handleInput("\r"); await tick();
		assert.deepEqual(submitted, [value]);
	}
});

test("inline key capture returns the next raw key, and Esc cancels it without closing the card", async () => {
	const seen: (string | undefined)[] = [];
	let closed = false;
	const view = inlineView(async inline => { seen.push(await inline.capture("Press the new key for Command palette")); }, { onClose: () => { closed = true; } });
	view.render(76);
	view.handleInput("\r");
	await tick();
	assert.match(view.render(76).join("\n"), /Press the new key for Command palette · Esc cancel/);
	view.handleInput("\x1bj");
	await tick();
	assert.deepEqual(seen, ["\x1bj"]);
	view.handleInput("\r");
	await tick();
	view.handleInput("\x1b");
	await tick();
	assert.deepEqual(seen, ["\x1bj", undefined]);
	assert.equal(closed, false, "Esc only cancels the capture");
	view.handleInput("\x1b");
	assert.equal(closed, true, "a second Esc closes the card as usual");
});

test("a Keymaps row shows its own footer hint", () => {
	const view = new VisualCustomizeView({ rows: [{ category: "Keymaps", label: "Command palette: alt+k", keyhint: "Enter assign · ⌫ disable · r default · Esc close", action: () => {} }], theme, rowsAvailable: () => 14, requestRender: () => {}, onClose: () => {} });
	view.handleInput("\r");
	assert.match(view.render(90).join("\n"), /Enter assign · ⌫ disable · r default · Esc close/);
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

function settingsView(applied: string[] = []) {
	const state = { density: "comfortable", status: "auto" };
	const choice = (setting: string, key: "density" | "status", value: string, hint: string): CustomizeRow => ({
		category: "Layout",
		label: () => `${setting}: ${value}${state[key] === value ? " (current)" : ""}`,
		choice: { setting, value, current: () => state[key] === value, hint },
		preview: () => ({ title: `${setting} · ${value}`, sample: `line one ${value}\nline two` }),
		action: () => { state[key] = value; applied.push(`${setting}=${value}`); },
	});
	const rows: CustomizeRow[] = [
		...["auto", "right", "bottom"].map((value) => choice("Status placement", "status", value, "Where Status lives")),
		...["comfortable", "compact", "minimal"].map((value) => choice("Density", "density", value, "Space between sections")),
		{ category: "Layout", label: "Reset layout", action: () => { applied.push("reset"); } },
	];
	const view = new VisualCustomizeView({ rows, theme, requestRender() {}, rowsAvailable: () => 24, onClose() {} });
	// The user sees the card before the first key.
	view.render(100);
	view.handleInput("\x1b[C");
	return { view, state, applied };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("choices of one setting share a line: the current one is marked, without repeating the setting name", () => {
	const { view } = settingsView();
	const lines = view.render(100);
	const status = lines.filter((line) => line.includes("Status placement") && /[●○]/.test(line));
	assert.equal(status.length, 1, "one line for the setting");
	assert.match(status[0]!, /▸ Status placement\s+● auto\s+○ right\s+○ bottom/);
	assert.match(lines.find((line) => line.includes("Density"))!, /Density\s+● comfortable\s+○ compact\s+○ minimal/);
	assert.ok(lines.some((line) => line.includes("Reset layout")), "plain rows stay rows");
	assert.ok(!lines.join("\n").includes("(current)"), "no (current) suffix");
	assert.ok(lines.some((line) => line.includes("Layout · 1/3")), "the position counts settings, not choices");
	assert.ok(lines.some((line) => line.includes("Status placement — Where Status lives")), "the focused setting is described");
	assert.ok(lines.some((line) => line.includes("line one auto")) && lines.some((line) => line.includes("line two")), "multi-line previews keep every line");
	for (const line of lines) assert.equal(visibleWidth(line), 100);
});

test("↑/↓ move between settings; ←/→ change the value and apply it at once; ← on the first choice returns to the categories", async () => {
	const { view, state, applied } = settingsView();
	view.handleInput("\x1b[C");
	await settle();
	assert.equal(state.status, "right");
	assert.deepEqual(applied, ["Status placement=right"]);
	view.handleInput("\x1b[C");
	await settle();
	view.handleInput("\x1b[C");
	await settle();
	assert.equal(state.status, "bottom", "→ stops at the last choice");
	assert.equal(applied.length, 2);
	view.handleInput("\x1b[B");
	assert.match(view.render(100).find((line) => line.includes("Density"))!, /▸ Density/, "↓ goes to the next setting, not the next choice");
	view.handleInput("\x1b[D");
	await settle();
	assert.equal(state.density, "comfortable", "← on the first choice applies nothing");
	assert.ok(view.render(100).some((line) => /▸ Layout/.test(line)), "and returns focus to the categories");
	view.handleInput("\x1b[C");
	view.handleInput("\x1b[B");
	view.handleInput("\r");
	await settle();
	assert.equal(applied.at(-1), "reset", "plain rows still apply on Enter");
});

test("focus() selects a row by label without applying it", () => {
	const { view, applied } = settingsView();
	assert.equal(view.focus("Density: minimal"), true);
	assert.deepEqual(applied, []);
	assert.match(view.render(100).find((line) => line.includes("Density") && /[●○›]/.test(line))!, /▸ Density\s+● comfortable\s+○ compact\s+› minimal/, "the cursor shows where it is when it is not on the current value");
	assert.equal(view.focus("No such row"), false);
});

test("a setting too wide for the pane shows only the selected choice with arrows", () => {
	const { view } = settingsView();
	const line = view.render(44).find((row) => row.includes("Status placement"))!;
	assert.match(line, /‹ auto › 1\/3/);
	assert.equal(visibleWidth(line), 44);
});

test("arrows never apply a setting while the card is too small to show its controls", async () => {
	const applied: string[] = [];
	let rows = 3;
	const view = new VisualCustomizeView({
		rows: [
			{ category: "Layout", label: "Status: auto", choice: { setting: "Status", value: "auto", current: () => true }, action: () => { applied.push("auto"); } },
			{ category: "Layout", label: "Status: right", choice: { setting: "Status", value: "right", current: () => false }, action: () => { applied.push("right"); } },
		],
		theme, requestRender() {}, rowsAvailable: () => rows, onClose() {},
	});
	view.handleInput("\x1b[C");
	assert.deepEqual(view.render(90), ["Customization", "Enlarge terminal"]);
	view.handleInput("\x1b[C");
	await settle();
	assert.deepEqual(applied, [], "→ applies nothing behind 'Enlarge terminal'");
	rows = 24;
	view.render(90);
	view.handleInput("\x1b[C");
	await settle();
	assert.deepEqual(applied, ["right"], "once the controls show, → applies");
	view.handleInput("\t");
	assert.match(view.render(90).join("\n"), /↑\/↓ categories|→ open|Tab panes/, "the categories pane does not advertise setting keys");
	assert.doesNotMatch(view.render(90).join("\n"), /←\/→ change/);
});


test("deferred choices share Layout's line without applying permissions on arrows", async () => {
 const writes: string[] = [];
 let current = "normal";
 const rows: CustomizeRow[] = ["normal", "auto", "yolo", "super-yolo"].map(value => ({
  category: "Editor", label: `Session permissions: ${value}`,
  choice: { setting: "Session permissions", value, current: () => current === value, applyOnMove: false },
  preview: () => ({ title: value, sample: value === "auto" ? "extra inference cost; hard safety and consent remain" : "session only" }),
  action: () => { current = value; writes.push(value); },
 }));
 const view = new VisualCustomizeView({ rows, theme, requestRender() {}, rowsAvailable: () => 24, onClose() {} });
 view.render(140); view.handleInput("\x1b[C"); view.handleInput("\x1b[C");
 await settle();
 assert.equal(current, "normal"); assert.deepEqual(writes, [], "navigation writes nothing");
 const lines = view.render(140);
 assert.equal(lines.filter(line => line.includes("Session permissions") && /[●○›]/.test(line)).length, 1);
 assert.match(lines.join("\n"), /● normal.*› auto/);
 assert.match(lines.join("\n"), /extra inference cost; hard safety and consent remain/);
 assert.match(lines.join("\n"), /Enter apply/);
 view.handleInput("\r"); await settle();
 assert.equal(current, "auto"); assert.deepEqual(writes, ["auto"]);
 view.handleInput("\x1b[C"); view.handleInput("\x1b"); await settle();
 assert.deepEqual(writes, ["auto"], "canceling a different preview grants nothing");
});

test("inline notification choices retain their sound keys instead of advertising profiles", () => {
 const view = new VisualCustomizeView({ rows: [{ category: "Notifications", label: "Success",
  choice: { setting: "Success", value: "silence", current: () => true, applyOnMove: false },
  keyhint: "←/→ choose · Enter apply · f sound · p test · Esc close", action() {},
 }], theme, requestRender() {}, rowsAvailable: () => 24, onClose() {} });
 view.render(120); view.handleInput("\x1b[C");
 const rendered = view.render(120).join("\n");
 assert.match(rendered, /f sound · p test/); assert.doesNotMatch(rendered, /p profiles/);
});

// Pointer coordinates are component-local terminal cells, not string indices.
function point(frame: string[], text: string): { x: number; y: number } {
	const y = frame.findIndex(line => line.includes(text));
	assert.ok(y >= 0, `missing ${JSON.stringify(text)} in ${frame.join("\n")}`);
	const line = frame[y]!;
	return { x: visibleWidth(line.slice(0, line.indexOf(text))), y };
}
function pointer(frame: string[], x: number, y: number, button: TuiMouseEvent["button"] = "left", type: TuiMouseEvent["type"] = "click"): TuiMouseEvent {
	return { type, button, x, y, screenX: x + 9, screenY: y + 4, width: visibleWidth(frame[0]!), height: frame.length, shift: false, alt: false, ctrl: false };
}
function click(view: VisualCustomizeView, frame: string[], text: string, button: TuiMouseEvent["button"] = "left"): TuiMouseEventResult | undefined {
	const { x, y } = point(frame, text);
	return (view as unknown as { handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined }).handleMouse(pointer(frame, x, y, button));
}

test("nested Configure tabs aligns indented and uses the same idle and selected roles as settings", () => {
 const roles = { fg: (role: string, text: string) => `\x1b[${role === "text" ? 31 : role === "muted" ? 32 : 33}m${text}\x1b[39m` };
 const view = new VisualCustomizeView({ rows: [
  { category: "Sections", label: "Tabs: shown", choice: { setting: "Tabs", value: "shown", current: () => true }, action() {} },
  { category: "Sections", label: "Configure tabs", indent: 2, action() {} },
 ], theme: roles, requestRender() {}, onClose() {} });
 view.focus("Tabs: shown"); let frame = view.render(100).join("\n");
 assert.match(frame, /\x1b\[31mTabs/); assert.match(frame, /\x1b\[32m  Configure tabs\s*\x1b\[39m/);
 view.focus("Configure tabs"); frame = view.render(100).join("\n");
 assert.match(frame, /\x1b\[31m  Configure tabs\s*\x1b\[39m/);
 assert.match(frame, /\x1b\[32mTabs/);
});

test("tabs child click and narrow navigation leave unavailable entries inert and restore focus", () => {
 for (const width of [100, 36]) {
  let calls = 0, closed = 0;
  const children: CustomizeRow[] = ["MAIN · available", ...["GIT", "TREE", "PROFILE", "MEMORY", "STATS"].map(x => `${x} · coming soon`)].map(label => ({ label, inert: true, action: () => { calls++; } }));
  const view = new VisualCustomizeView({ rows: [{ category: "Sections", label: "Other", action() {} }, { category: "Sections", label: "Configure tabs", children, action() {} }, { category: "Layout", label: "Layout setting", action() {} }], theme, requestRender() {}, onClose() { closed++; } });
  view.focus("Configure tabs"); let frame = view.render(width);
  assert.ok(click(view, frame, "Configure tabs")?.handled);
  frame = view.render(width); assert.match(frame.join("\n"), /Tabs · Esc back/);
  for (let i = 0; i < children.length; i++) {
   frame = view.render(width); const label = children[i]!.label as string;
   assert.ok(frame.join("\n").includes(label));
   assert.equal(click(view, frame, label), undefined);
   view.handleInput("\r"); view.handleInput("\x1b[B");
  }
  view.handleInput("\t"); view.handleInput("\x1b[C");
  assert.match(view.render(width).join("\n"), /Tabs · Esc back/);
  view.handleInput("\x1b"); assert.equal(closed, 0);
  assert.match(view.render(width).join("\n"), /▸ Configure tabs/);
  assert.equal(calls, 0);
 }
});

test("mouse selects categories, activates plain rows and explicitly applies visible choices", async () => {
	const effects: string[] = [];
	let selected = "one";
	const rows: CustomizeRow[] = [
		{ category: "Animations", label: "Speed", action: () => { effects.push("speed"); } },
		{ category: "Layout", label: "Reset layout", action: () => { effects.push("reset"); } },
		...["one", "界two", "three"].map(value => ({ category: "Layout" as const, label: value,
			choice: { setting: "Mode", value, current: () => selected === value, applyOnMove: false },
			action: () => { selected = value; effects.push(value); } })),
	];
	const view = new VisualCustomizeView({ rows, theme, rowsAvailable: () => 12, requestRender() {}, onClose() {} });
	let frame = view.render(110);
	assert.equal(click(view, frame, "Layout")?.handled, true);
	assert.deepEqual(effects, [], "category selection never applies");
	frame = view.render(110);
	assert.equal(click(view, frame, "Reset layout")?.handled, true);
	await tick();
	assert.deepEqual(effects, ["reset"]);
	frame = view.render(110);
	assert.equal(click(view, frame, "界two")?.handled, true);
	await tick();
	assert.equal(selected, "界two");
	assert.deepEqual(effects, ["reset", "界two"], "click is an explicit apply even for deferred choices");
	frame = view.render(110);
	for (const button of ["right", "middle"] as const) click(view, frame, "three", button);
	const handler = view as unknown as { handleMouse(event: TuiMouseEvent): unknown };
	for (const [x, y] of [[0, 0], [109, 0], [109, frame.length - 1], [2, 2], [108, 4]]) handler.handleMouse(pointer(frame, x!, y!));
	await tick();
	assert.deepEqual(effects, ["reset", "界two"], "non-primary clicks and blank or border cells do nothing");
});

test("mouse tracks scrolled rows and narrow categories and choices without hitting clipped values", async () => {
	const effects: string[] = [];
	const choices: CustomizeRow[] = ["auto", "right", "bottom"].map(value => ({ category: "Layout", label: value,
		choice: { setting: "Status placement", value, current: () => value === "auto", applyOnMove: false }, action: () => { effects.push(value); } }));
	const view = new VisualCustomizeView({ rows: [
		{ category: "Animations", label: "Speed", action() {} },
		...choices,
		...Array.from({ length: 9 }, (_, index): CustomizeRow => ({ category: "Layout", label: `Row ${index}`, action: () => { effects.push(`row:${index}`); } })),
	], theme, rowsAvailable: () => 8, requestRender() {}, onClose() {} });
	let frame = view.render(36);
	click(view, frame, "Layout");
	frame = view.render(36);
	assert.match(frame.join("\n"), /‹ auto ›/);
	click(view, frame, "›");
	await tick();
	assert.deepEqual(effects, [], "narrow arrows retain deferred keyboard navigation");
	frame = view.render(36);
	assert.match(frame.join("\n"), /‹ right ›/);
	click(view, frame, "right");
	await tick();
	assert.deepEqual(effects, ["right"], "only the visible value is explicitly applied");
	assert.equal(view.focus("Row 8"), true);
	frame = view.render(36);
	assert.match(frame.join("\n"), /Row 7[\s\S]*Row 8/);
	click(view, frame, "Row 7");
	await tick();
	assert.deepEqual(effects, ["right", "row:7"], "the painted scrolled row, not its original index, runs");

	const clipped: CustomizeRow = { category: "Layout", label: "wide", choice: { setting: "a very long setting name", value: "unseen choice value", current: () => true }, action: () => { effects.push("clipped"); } };
	const small = new VisualCustomizeView({ rows: [clipped], theme, rowsAvailable: () => 8, requestRender() {}, onClose() {} });
	frame = small.render(22);
	assert.doesNotMatch(frame.join("\n"), /unseen choice value/);
	const line = frame.findIndex(value => value.includes("a very"));
	const handler = small as unknown as { handleMouse(event: TuiMouseEvent): unknown };
	handler.handleMouse(pointer(frame, 20, line));
	await tick();
	assert.deepEqual(effects, ["right", "row:7"], "a clipped value cannot be activated");
});

test("mouse ignores stale dimensions, hidden rows, invalidation and pending tasks", async () => {
	let height = 12, visible = true;
	let release!: () => void;
	const effects: string[] = [];
	const view = new VisualCustomizeView({ rows: [
		{ label: "Slow", action: () => { effects.push("slow"); return new Promise<void>(resolve => { release = resolve; }); } },
		{ label: "Hidden later", visible: () => visible, action: () => { effects.push("hidden"); } },
	], theme, rowsAvailable: () => height, requestRender() {}, onClose() {} });
	let frame = view.render(80);
	const handler = view as unknown as { handleMouse(event: TuiMouseEvent): unknown };
	const target = point(frame, "Hidden later");
	height = 5;
	handler.handleMouse(pointer(frame, target.x, target.y));
	height = 12;
	handler.handleMouse({ ...pointer(frame, target.x, target.y), width: 79 });
	visible = false;
	handler.handleMouse(pointer(frame, target.x, target.y));
	assert.deepEqual(effects, [], "a resized or hidden target cannot act using a stale frame");
	visible = true;
	frame = view.render(80);
	view.invalidate();
	click(view, frame, "Hidden later");
	assert.deepEqual(effects, [], "invalidated geometry cannot act");
	frame = view.render(80);
	click(view, frame, "Slow");
	frame = view.render(80);
	click(view, frame, "Hidden later");
	assert.deepEqual(effects, ["slow"], "an unfinished action owns the view");
	release(); await tick();
	frame = view.render(80);
	click(view, frame, "Hidden later"); await tick();
	assert.deepEqual(effects, ["slow", "hidden"]);
});

test("mouse confirms only the visible yes control, never another row or a hidden prompt", async () => {
	let height = 12;
	const answers: boolean[] = [];
	const view = inlineView(async inline => { answers.push(await inline.confirm("Proceed?")); }, { rowsAvailable: () => height });
	let frame = view.render(80);
	click(view, frame, "Field row"); await tick();
	frame = view.render(80);
	click(view, frame, "Field row");
	click(view, frame, "y yes", "right");
	assert.deepEqual(answers, [], "neither another row nor a right click answers consent");
	click(view, frame, "y yes"); await tick();
	assert.deepEqual(answers, [true]);
	frame = view.render(80); click(view, frame, "Field row"); await tick();
	frame = view.render(80);
	height = 4;
	click(view, frame, "y yes"); await tick();
	assert.deepEqual(answers, [true], "a confirmation hidden by an unrendered resize cannot be accepted");
	view.handleInput("n"); await tick();
	assert.deepEqual(answers, [true, false]);
});

test("confirmation message text is not mistaken for its yes or cancel controls", async () => {
	const answers: boolean[] = [];
	const view = inlineView(async inline => { answers.push(await inline.confirm("Does y yes mean cancel?")); });
	let frame = view.render(80);
	click(view, frame, "Field row"); await tick();
	frame = view.render(80);
	click(view, frame, "y yes");
	click(view, frame, "cancel");
	await tick();
	assert.deepEqual(answers, [], "the words in the question are not consent controls");
	const y = frame.findIndex(line => line.includes("Does y yes"));
	const x = visibleWidth(frame[y]!.slice(0, frame[y]!.lastIndexOf("y yes")));
	(view as unknown as { handleMouse(event: TuiMouseEvent): unknown }).handleMouse(pointer(frame, x, y));
	await tick();
	assert.deepEqual(answers, [true], "only the actual yes instruction grants consent");
});

test("profile confirmation mouse yes retains target fingerprint and visible-prompt guards", async () => {
	const profile = { name: "Desk y yes", themeName: "dark", animationPolicy: "quality" as const, banner: { showRose: true, showTextLogo: true, color: "pink" as const }, visual: { statusPlacement: "auto" as const, headerPlacement: "top" as const, density: "comfortable" as const, surface: "tinted" as const, visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true, stats: false } } };
	let catalog = [profile];
	const effects: string[] = [];
	const view = new VisualCustomizeView({ rows: [], theme, rowsAvailable: () => 12, requestRender() {}, onClose() {}, profiles: {
		list: () => catalog, save() {}, apply: name => { effects.push(name); }, delete() {}, reset() {},
	} });
	view.handleInput("p"); view.handleInput("a");
	let frame = view.render(80);
	click(view, frame, "y yes"); await tick();
	assert.deepEqual(effects, [], "a profile name containing yes cannot authorize itself");
	const confirm = () => {
		const y = frame.findIndex(line => line.includes("Confirm apply"));
		const x = visibleWidth(frame[y]!.slice(0, frame[y]!.lastIndexOf("y yes")));
		(view as unknown as { handleMouse(event: TuiMouseEvent): unknown }).handleMouse(pointer(frame, x, y));
	};
	catalog = [{ ...profile, themeName: "light" }];
	confirm(); await tick();
	assert.deepEqual(effects, [], "changed profile content is refused");
	catalog = [profile]; view.handleInput("a"); frame = view.render(80);
	confirm(); await tick();
	assert.deepEqual(effects, ["Desk y yes"]);
});

test("centered fullscreen overlay receives a real SGR click in local coordinates", async () => {
	let input: ((data: string) => void) | undefined;
	const terminal: Terminal = {
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write() {}, get columns() { return 120; }, get rows() { return 30; }, get kittyProtocolActive() { return false; }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
	};
	const effects: string[] = [];
	const view = new VisualCustomizeView({ rows: [{ label: "Apply this", action: () => { effects.push("applied"); } }], theme, rowsAvailable: () => 12, requestRender() {}, onClose() {} });
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	const overlay = tui.showOverlay(view, { anchor: "center", width: 80, maxHeight: 12 });
	tui.start(); tui.renderNow(true);
	try {
		const frame = view.render(80);
		const bounds = overlay.getBounds();
		assert.ok(bounds && bounds.col > 0 && bounds.row > 0);
		const target = point(frame, "Apply this");
		const x = bounds.col + target.x + 1, y = bounds.row + target.y + 1;
		input?.(`\x1b[<0;${x};${y}M`);
		input?.(`\x1b[<0;${x};${y}m`);
		await tick();
		assert.deepEqual(effects, ["applied"]);
	} finally { tui.stop(); }
});

// Independent permission and consent boundary regressions.
function boundaryMouseEvent(frame: string[], text: string, delta = 0, type: TuiMouseEvent["type"] = "click"): TuiMouseEvent {
	const y = frame.findIndex(line => line.includes(text));
	assert.ok(y >= 0, `Missing ${text}: ${frame.join("\n")}`);
	const x = visibleWidth(frame[y]!.slice(0, frame[y]!.indexOf(text))) + delta;
	return { type, button: "left", x, y, screenX: x, screenY: y, width: visibleWidth(frame[0]!), height: frame.length, shift: false, alt: false, ctrl: false };
}

test("permission mouse press, preview arrows, explicit values, and hidden stale targets preserve write boundaries", async t => {
	const directory = mkdtempSync(join(tmpdir(), "mouse-permission-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	for (const width of [44, 80, 160]) {
		const path = join(directory, `state-${width}.json`);
		writeFileSync(path, '{"mode":"NORMAL"}\n');
		const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex");
		const before = hash();
		let mode = "NORMAL", visible = true, height = 12;
		const rows: CustomizeRow[] = ["NORMAL", "AUTO (beta)", "YOLO", "SUPER-YOLO"].map(value => ({
			category: "Editor", label: `Session permissions: ${value}`, visible: () => visible,
			choice: { setting: "Session permissions", value, current: () => value === mode, applyOnMove: false },
			action: () => { mode = value; writeFileSync(path, JSON.stringify({ mode })); },
		}));
		const view = new VisualCustomizeView({ rows, theme, rowsAvailable: () => height, requestRender() {}, onClose() {} });
		view.render(width); view.focus("Session permissions: NORMAL");
		let frame = view.render(width);
		view.handleMouse(boundaryMouseEvent(frame, "NORMAL", 0, "press"));
		assert.equal(hash(), before, "press alone grants nothing");
		if (frame.some(line => line.includes("‹ NORMAL ›"))) view.handleMouse(boundaryMouseEvent(frame, "›"));
		else { view.handleMouse(boundaryMouseEvent(frame, "Session permissions")); view.handleInput("\x1b[C"); }
		await tick(); assert.equal(hash(), before, "preview movement grants nothing");
		frame = view.render(width);
		view.handleMouse(boundaryMouseEvent(frame, "AUTO (beta)")); await tick();
		assert.equal(mode, "AUTO (beta)");
		const committed = hash();
		frame = view.render(width);
		const stale = boundaryMouseEvent(frame, "AUTO (beta)");
		visible = false; view.handleMouse(stale); assert.equal(hash(), committed);
		visible = true; height = 3; view.handleMouse(stale); assert.equal(hash(), committed);
		height = 12; view.dispose(); view.handleMouse(stale); assert.equal(hash(), committed);
	}
});

test("inline input and capture block permission mouse targets until keyboard cancellation", async () => {
	for (const kind of ["input", "capture"] as const) {
		let applied = 0;
		const view = new VisualCustomizeView({ rows: [
			{ label: "Open modal", action: async inline => {
				if (kind === "input") await inline.input({ prompt: "Name", value: "sample" });
				else await inline.capture("Press a key");
			} },
			{ label: "Elevate permission", action: () => { applied++; } },
		], theme, rowsAvailable: () => 12, requestRender() {}, onClose() {} });
		let frame = view.render(80);
		view.handleMouse(boundaryMouseEvent(frame, "Open modal")); await tick();
		frame = view.render(80);
		assert.equal(view.handleMouse(boundaryMouseEvent(frame, "Elevate permission")), undefined);
		assert.equal(applied, 0);
		view.handleInput("\x1b"); await tick();
		frame = view.render(80); view.handleMouse(boundaryMouseEvent(frame, "Elevate permission")); await tick();
		assert.equal(applied, 1);
	}
});

test("inline consent accepts each painted yes cell but neither adjacent cell", async () => {
	for (const delta of [-1, 0, 1, 2, 3, 4, 5]) {
		const answers: boolean[] = [];
		const view = new VisualCustomizeView({ rows: [{ label: "Proceed", action: async inline => { answers.push(await inline.confirm("Change permission?")); } }], theme, rowsAvailable: () => 12, requestRender() {}, onClose() {} });
		let frame = view.render(80); view.handleMouse(boundaryMouseEvent(frame, "Proceed")); await tick();
		frame = view.render(80); view.handleMouse(boundaryMouseEvent(frame, "y yes", delta)); await tick();
		assert.deepEqual(answers, delta >= 0 && delta < 5 ? [true] : []);
		view.dispose(); await tick();
	}
});

const hoverTheme = {
	fg: (role: string, text: string) => role === "warning" ? `\x1b[33m${text}\x1b[39m` : text,
	bg: (_role: string, text: string) => `\x1b[44m${text}\x1b[49m`,
};
const warning = (text: string) => `\x1b[33m${text}\x1b[39m`;
function move(view: VisualCustomizeView, frame: string[], text: string): TuiMouseEventResult | undefined {
	const { x, y } = point(frame, text);
	return view.handleMouse(pointer(frame, x, y, "none", "move"));
}
function plain(frame: string[]): string[] { return frame.map(stripAnsi); }

test("hover paints exactly the existing category, setting, value and plain-row targets without changing selection", () => {
	const actions: string[] = [];
	const rows: CustomizeRow[] = [
		{ category: "Editor", label: "Reset settings", action: () => { actions.push("reset"); } },
		... ["NORMAL", "AUTO"].map(value => ({ category: "Editor" as const, label: value,
			choice: { setting: "Permissions", value, current: () => value === "NORMAL", applyOnMove: false },
			action: () => { actions.push(value); } })),
		{ category: "Layout", label: "Other", action: () => { actions.push("other"); } },
	];
	const view = new VisualCustomizeView({ rows, theme: hoverTheme, rowsAvailable: () => 12, requestRender() {}, onClose() {} });
	let frame = view.render(100);
	const original = plain(frame);
	for (const [target, painted] of [["Layout", "Layout"], ["Permissions", "Permissions"], ["AUTO", "○ AUTO"], ["Reset settings", "Reset settings"]]) {
		assert.equal(move(view, frame, target!)?.render, true, target);
		frame = view.render(100);
		assert.ok(frame.join("\n").includes(warning(painted!)), `hover ${target} uses warning on its hit span`);
		assert.deepEqual(plain(frame), original, "hover must not move focus, change preview, or alter text");
		assert.deepEqual(actions, [], "hover must not apply any action or permission");
		assert.equal(move(view, frame, target!)?.render, false, "repeated motion does not redraw");
	}
	const blank = pointer(frame, 2, 0, "none", "move");
	assert.equal(view.handleMouse(blank)?.render, true);
	frame = view.render(100);
	assert.ok(!frame.join("\n").includes("\x1b[33m"), "blank card cells clear hover");
	assert.equal(view.handleMouse(blank)?.render, false);
	assert.deepEqual(actions, []);
	view.handleInput("\x1b[C"); view.handleInput("\r");
	assert.deepEqual(actions, ["reset"], "keyboard activation remains unchanged");
});

test("compact arrows and values hover independently, while clipped choices and headings are not targets", () => {
	const actions: string[] = [];
	const view = new VisualCustomizeView({ rows: ["normal", "elevated"].map(value => ({
		category: "Editor", label: value, choice: { setting: "Permission mode", value, current: () => value === "normal", applyOnMove: false },
		action: () => { actions.push(value); },
	})), theme: hoverTheme, rowsAvailable: () => 12, requestRender() {}, onClose() {} });
	let frame = view.render(36);
	assert.match(plain(frame).join("\n"), /‹ normal ›/);
	assert.equal(move(view, frame, "normal")?.render, true);
	frame = view.render(36);
	assert.ok(frame.join("\n").includes(warning("normal")));
	assert.equal(move(view, frame, "›")?.render, true);
	frame = view.render(36);
	assert.ok(frame.join("\n").includes(warning("›")));
	assert.equal(move(view, frame, "Editor ·")?.render, true);
	frame = view.render(36);
	assert.ok(!frame.join("\n").includes("\x1b[33m"));
	assert.deepEqual(actions, []);
	click(view, frame, "›");
	frame = view.render(36);
	assert.match(plain(frame).join("\n"), /‹ elevated ›/);
	assert.deepEqual(actions, [], "the compact deferred arrow still previews only");

	const clipped = new VisualCustomizeView({ rows: [{ category: "Editor", label: "long", choice: {
		setting: "A long setting name", value: "an unseen permission", current: () => true,
	}, action: () => { actions.push("hidden"); } }], theme: hoverTheme, rowsAvailable: () => 8, requestRender() {}, onClose() {} });
	frame = clipped.render(22);
	assert.doesNotMatch(plain(frame).join("\n"), /an unseen permission/);
	const line = frame.findIndex(value => value.includes("A long"));
	clipped.handleMouse(pointer(frame, 20, line, "none", "move"));
	assert.ok(!clipped.render(22).join("\n").includes("\x1b[33m"));
	assert.deepEqual(actions, []);
});

test("hover clears on keyboard, focus, resize, invalidation, disposal and stale row identity", () => {
	let height = 12, visible = true;
	const actions: string[] = [];
	const rows: CustomizeRow[] = [
		{ label: "First", action: () => { actions.push("first"); } },
		{ label: "Second", visible: () => visible, action: () => { actions.push("second"); } },
	];
	const view = new VisualCustomizeView({ rows, theme: hoverTheme, rowsAvailable: () => height, requestRender() {}, onClose() {} });
	let frame = view.render(80);
	const hoverFirst = () => { move(view, frame, "First"); frame = view.render(80); assert.ok(frame.join("\n").includes(warning("First"))); };
	hoverFirst(); view.handleInput("\x1b[B"); frame = view.render(80);
	assert.ok(!frame.join("\n").includes("\x1b[33m"));
	hoverFirst(); assert.equal(view.focus("Second"), true); frame = view.render(80);
	assert.ok(!frame.join("\n").includes("\x1b[33m"));
	hoverFirst(); frame = view.render(79);
	assert.ok(!frame.join("\n").includes("\x1b[33m"), "width resize clears hover");
	frame = view.render(80); hoverFirst(); height = 11; frame = view.render(80);
	assert.ok(!frame.join("\n").includes("\x1b[33m"), "height resize clears hover");
	height = 12; frame = view.render(80); hoverFirst(); view.invalidate(); frame = view.render(80);
	assert.ok(!frame.join("\n").includes("\x1b[33m"));
	hoverFirst(); const stale = pointer(frame, point(frame, "First").x, point(frame, "First").y, "none", "move");
	rows[0] = { label: "Other", action: () => { actions.push("other"); } };
	view.handleMouse(stale); frame = view.render(80);
	assert.ok(!frame.join("\n").includes("\x1b[33m"), "a different row cannot inherit stale hover");
	move(view, frame, "Second"); frame = view.render(80); visible = false;
	view.handleMouse(pointer(frame, point(frame, "Second").x, point(frame, "Second").y, "none", "move"));
	frame = view.render(80);
	assert.ok(!frame.join("\n").includes("\x1b[33m"), "hidden rows cannot retain hover");
	move(view, frame, "Other"); view.dispose(); frame = view.render(80);
	assert.ok(!frame.join("\n").includes("\x1b[33m"));
	assert.deepEqual(actions, []);
});

test("inline consent hover is presentation only and its actual yes and cancel spans retain their guards", async () => {
	const answers: boolean[] = [];
	const view = new VisualCustomizeView({ rows: [
		{ label: "Proceed", action: async inline => { answers.push(await inline.confirm("Change permission?")); } },
		{ label: "Other action", action: () => { throw new Error("modal guard bypassed"); } },
	], theme: hoverTheme, rowsAvailable: () => 12, requestRender() {}, onClose() {} });
	let frame = view.render(80); click(view, frame, "Proceed"); await tick();
	frame = view.render(80);
	const prompt = frame;
	move(view, frame, "Other action"); frame = view.render(80);
	assert.deepEqual(frame, prompt, "the blocked row is not hoverable during consent");
	assert.equal(move(view, frame, "y yes")?.render, true);
	frame = view.render(80);
	assert.ok(frame.join("\n").includes(warning("y yes")));
	assert.deepEqual(answers, []);
	move(view, frame, "cancel"); frame = view.render(80);
	assert.ok(frame.join("\n").includes(warning("cancel")));
	assert.deepEqual(answers, []);
	click(view, frame, "cancel"); await tick();
	assert.deepEqual(answers, [false]);
	frame = view.render(80); click(view, frame, "Proceed"); await tick();
	frame = view.render(80); move(view, frame, "y yes"); frame = view.render(80);
	click(view, frame, "y yes"); await tick();
	assert.deepEqual(answers, [false, true]);
});

test("profile confirmation hover does not grant consent or defeat changed identity", async () => {
	const profile = { name: "Desk", themeName: "dark", animationPolicy: "quality" as const, banner: { showRose: true, showTextLogo: true, color: "pink" as const }, visual: { statusPlacement: "auto" as const, headerPlacement: "top" as const, density: "comfortable" as const, surface: "tinted" as const, visibility: { changes: true, rdd: true, agents: true, todo: true, usageCost: true, modelDetails: true, contextWarning: true, stats: false } } };
	let catalog = [profile];
	const effects: string[] = [];
	const view = new VisualCustomizeView({ rows: [], theme: hoverTheme, rowsAvailable: () => 12, requestRender() {}, onClose() {}, profiles: {
		list: () => catalog, save() {}, apply: name => { effects.push(name); }, delete() {}, reset() {},
	} });
	view.handleInput("p"); view.handleInput("a");
	let frame = view.render(80);
	move(view, frame, "y yes"); frame = view.render(80);
	assert.ok(frame.join("\n").includes(warning("y yes")));
	assert.deepEqual(effects, []);
	catalog = [{ ...profile, themeName: "light" }];
	click(view, frame, "y yes"); await tick();
	assert.deepEqual(effects, [], "hover and click cannot accept a changed fingerprint");
	assert.match(plain(view.render(80)).join("\n"), /Profile changed/);
});

test("real fullscreen SGR motion clears inside the card, documents outside-overlay dispatch, and preserves clicks", async t => {
	let input: ((data: string) => void) | undefined;
	const terminal: Terminal = {
		start(onInput) { input = onInput; }, stop() {}, async drainInput() {}, write() {}, get columns() { return 120; }, get rows() { return 30; }, get kittyProtocolActive() { return false; }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
	};
	const effects: string[] = [], received: TuiMouseEvent[] = [];
	const view = new VisualCustomizeView({ rows: [{ label: "Apply this", action: () => { effects.push("applied"); } }], theme: hoverTheme, rowsAvailable: () => 12, requestRender() {}, onClose() {} });
	const wrapper = { render: (width: number) => view.render(width), invalidate: () => view.invalidate(), handleInput: (data: string) => view.handleInput(data), handleMouse: (event: TuiMouseEvent) => { received.push(event); return view.handleMouse(event); } };
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
	const overlay = tui.showOverlay(wrapper, { anchor: "center", width: 80, maxHeight: 12 });
	tui.start(); tui.renderNow(true);
	try {
		let frame = view.render(80);
		const bounds = overlay.getBounds();
		assert.ok(bounds && bounds.col > 0 && bounds.row > 0);
		const target = point(frame, "Apply this");
		const send = (code: number, x: number, y: number, release = false) => input?.(`\x1b[<${code};${x + 1};${y + 1}${release ? "m" : "M"}`);
		send(35, bounds.col + target.x, bounds.row + target.y);
		frame = view.render(80);
		assert.ok(frame.join("\n").includes(warning("Apply this")), "SGR motion reaches the view");
		const beforeOutside = received.length;
		send(35, bounds.col - 1, bounds.row + target.y);
		assert.equal(received.length, beforeOutside, "the native driver does not send outside-overlay motion to the overlay");
		frame = view.render(80);
		assert.ok(frame.join("\n").includes(warning("Apply this")), "outside leave cannot be observed by this view");
		t.diagnostic("TuiAltScreen outside-overlay SGR motion is not dispatched to the centered overlay; hover remains until re-entry or lifecycle clear.");
		send(35, bounds.col + 1, bounds.row);
		frame = view.render(80);
		assert.ok(!frame.join("\n").includes("\x1b[33m"), "blank in-card motion clears hover");
		send(0, bounds.col + target.x, bounds.row + target.y);
		send(0, bounds.col + target.x, bounds.row + target.y, true);
		await tick();
		assert.deepEqual(effects, ["applied"]);
	} finally { tui.stop(); }
});

test("inline and profile consent labels visibly change from text to warning only on hover", async () => {
	const piTheme = getThemeByName("dark");
	assert.ok(piTheme);
	const answers: boolean[] = [];
	const inline = new VisualCustomizeView({ rows: [{ label: "Proceed", action: async bridge => { answers.push(await bridge.confirm("Change permission?")); } }], theme: piTheme, rowsAvailable: () => 12, requestRender() {}, onClose() {} });
	let frame = inline.render(80); click(inline, frame, "Proceed"); await tick();
	frame = inline.render(80);
	assert.ok(frame.join("\n").includes(piTheme.fg("text", "y yes")), "idle yes must differ from the warning prompt");
	assert.ok(frame.join("\n").includes(piTheme.fg("text", "cancel")));
	move(inline, frame, "y yes"); frame = inline.render(80);
	assert.ok(frame.join("\n").includes(piTheme.fg("warning", "y yes")));
	assert.ok(frame.join("\n").includes(piTheme.fg("text", "cancel")));
	assert.deepEqual(answers, []);
	inline.handleInput("n"); await tick();
	assert.deepEqual(answers, [false]);

	let resets = 0;
	const profiles = new VisualCustomizeView({ rows: [], theme: piTheme, rowsAvailable: () => 12, requestRender() {}, onClose() {}, profiles: {
		list: () => [], save() {}, apply() {}, delete() {}, reset: () => { resets++; },
	} });
	profiles.handleInput("p"); profiles.handleInput("z"); frame = profiles.render(80);
	assert.ok(frame.join("\n").includes(piTheme.fg("text", "cancel")));
	move(profiles, frame, "cancel"); frame = profiles.render(80);
	assert.ok(frame.join("\n").includes(piTheme.fg("warning", "cancel")));
	assert.equal(resets, 0);
	profiles.handleInput("n");
	assert.equal(resets, 0);
});

test("hover preserves ANSI background and restores terminal color after the card border", () => {
	const piTheme = getThemeByName("dark");
	assert.ok(piTheme);
	const view = new VisualCustomizeView({ rows: [{ label: "Selected", action() {} }], theme: piTheme, rowsAvailable: () => 12, requestRender() {}, onClose() {} });
	let frame = view.render(80);
	const row = point(frame, "Selected").y;
	const before = frame[row]!;
	const background = before.match(/\x1b\[48;(?:2;\d+;\d+;\d+|5;\d+)m/)?.[0];
	assert.ok(background, "the focused row has a truecolor or 256-color background");
	move(view, frame, "Selected"); frame = view.render(80);
	const after = frame[row]!;
	assert.equal(stripAnsi(after), stripAnsi(before));
	assert.ok(after.indexOf(background) >= 0 && after.indexOf(background) < after.indexOf("Selected"), "hover preserves the exact rendered background");
	assert.ok(after.indexOf("\x1b[49m", after.indexOf("Selected")) > after.indexOf("Selected"));
	assert.ok(after.endsWith("\x1b[39m"), "the right border must not leak foreground color to the next line");
});

test("busy rows cannot acquire hover, and become hoverable after the task settles", async () => {
	let release!: () => void;
	const effects: string[] = [];
	const view = new VisualCustomizeView({ rows: [
		{ label: "Slow", action: () => { effects.push("slow"); return new Promise<void>(resolve => { release = resolve; }); } },
		{ label: "Other", action: () => { effects.push("other"); } },
	], theme: hoverTheme, rowsAvailable: () => 12, requestRender() {}, onClose() {} });
	let frame = view.render(80); click(view, frame, "Slow");
	frame = view.render(80); move(view, frame, "Other"); frame = view.render(80);
	assert.ok(!frame.join("\n").includes(warning("Other")));
	assert.deepEqual(effects, ["slow"]);
	release(); await tick(); frame = view.render(80);
	move(view, frame, "Other"); frame = view.render(80);
	assert.ok(frame.join("\n").includes(warning("Other")));
	assert.deepEqual(effects, ["slow"]);
});

test("wide target cells and same-object label drift retain geometry and identity guards", () => {
	let label = "界two";
	const effects: string[] = [];
	const view = new VisualCustomizeView({ rows: [{ label: () => label, action: () => { effects.push(label); } }], theme: hoverTheme, rowsAvailable: () => 12, requestRender() {}, onClose() {} });
	let frame = view.render(80);
	const initial = plain(frame), location = point(frame, label);
	view.handleMouse(pointer(frame, location.x + 1, location.y, "none", "move"));
	frame = view.render(80);
	assert.ok(frame.join("\n").includes(warning("界two")), "both cells of a wide grapheme share the target");
	assert.deepEqual(plain(frame), initial);
	label = "界six";
	frame = view.render(80);
	assert.ok(!frame.join("\n").includes("\x1b[33m"), "a changed label must not inherit hover at the same coordinates");
	assert.deepEqual(effects, []);
});

test("actual Customize ANSI fixtures for parent visual capture", t => {
	const piTheme = getThemeByName("dark");
	assert.ok(piTheme);
	for (const [width, height] of [[100, 24], [36, 12], [76, 5]] as const) {
		const view = new VisualCustomizeView({ rows: [{ category: "Editor", label: "Permission mode", action() {} }], theme: piTheme, rowsAvailable: () => height, requestRender() {}, onClose() {} });
		const before = view.render(width);
		move(view, before, "Permission mode");
		const after = view.render(width);
		assert.deepEqual(plain(after), plain(before));
		assert.notDeepEqual(after, before, "hover must change actual themed ANSI output");
		t.diagnostic(`ANSI_FIXTURE ${JSON.stringify({ width, height, before, after })}`);
	}
});
