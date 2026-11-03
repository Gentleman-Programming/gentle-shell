import assert from "node:assert/strict";
import test from "node:test";
import { installPagePaint, pageColors, paintPageRow } from "../lib/shell-page.ts";

const FG = "\x1b[38;2;64;66;72m";
const light = { appearance: "light", getFgAnsi: (token: string) => (token === "text" ? FG : ""), getColorMode: () => "truecolor" };
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

test("only a light theme gets a painted page: dark themes keep the terminal background", () => {
	assert.equal(pageColors({ ...light, appearance: "dark" }), undefined);
	assert.equal(pageColors({}), undefined);
	const page = pageColors(light)!;
	assert.equal(page.fg, FG, "default-colored text takes the theme's text color");
	assert.match(page.bg, /^\x1b\[48;2;\d+;\d+;\d+m$/);
	assert.equal(pageColors({ ...light, getColorMode: () => "256color" })!.bg, "\x1b[48;5;255m");
});

test("a page row fills the width and re-arms only what each reset cleared", () => {
	const page = pageColors(light)!;
	const card = "\x1b[48;5;194m";
	const row = paintPageRow(`plain ${card}card \x1b[31mred\x1b[39m still card\x1b[49m after`, 40, page);
	assert.equal(strip(row).length, 40, "the row is padded to the full width");
	assert.ok(row.startsWith(page.bg + page.fg), "the row opens on the page");
	assert.ok(row.includes(`\x1b[39m${page.fg} still card`), "a foreground reset brings back the page text color");
	assert.ok(!row.includes(`\x1b[39m${page.bg}`), "a foreground reset keeps the card background");
	assert.ok(row.includes(`\x1b[49m${page.bg} after`), "a background reset brings back the page");
	assert.ok(paintPageRow("a\x1b[0mb", 4, page).includes(`\x1b[0m${page.bg}${page.fg}b`), "a full reset re-arms both");
	assert.ok(paintPageRow("a\x1b[mb", 4, page).includes(`\x1b[m${page.bg}${page.fg}b`));
	// Color components equal to 0 are not resets.
	assert.equal(paintPageRow("\x1b[38;2;0;0;0mx", 1, page), `${page.bg}${page.fg}\x1b[38;2;0;0;0mx\x1b[0m`);
	assert.equal(paintPageRow("\x1b[48;5;0mx", 1, page), `${page.bg}${page.fg}\x1b[48;5;0mx\x1b[0m`);
	assert.equal(paintPageRow("", 3, page), `${page.bg}${page.fg}   \x1b[0m`, "an empty row is still painted");
});

test("the page paint wraps the fullscreen render only, follows theme changes and uninstalls", () => {
	let theme: object = light;
	const calls: string[][] = [];
	const tui = {
		applyLineResets: (lines: string[]) => lines.map((line) => `${line}\x1b[0m`),
		doRender() { calls.push(this.applyLineResets(["hi"])); },
		terminal: { columns: 6 },
	};
	const uninstall = installPagePaint(tui, () => theme);
	assert.deepEqual(tui.applyLineResets(["doc"]), ["doc\x1b[0m"], "the scrollback document dump stays unpainted");
	tui.doRender();
	assert.equal(strip(calls[0]![0]!), "hi    ");
	assert.ok(calls[0]![0]!.startsWith("\x1b[48;2;"));
	theme = { appearance: "dark" };
	tui.doRender();
	assert.deepEqual(calls[1], ["hi\x1b[0m"], "switching to a dark theme stops painting");
	theme = light;
	uninstall();
	tui.doRender();
	assert.deepEqual(calls[2], ["hi\x1b[0m"], "uninstall restores the render");
	assert.equal(installPagePaint({}, () => light)(), undefined, "a host without the fullscreen renderer is left alone");
});
