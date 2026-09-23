import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSidebarBanner } from "../lib/shell-sidebar-banner.ts";

const plain = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
test("sidebar heading is only the centered literal product label", () => {
	const label = "✿ Gentle Shell ✿";
	for (const width of [0, 1, 8, 11, 15, 16, 17, 20, 21, 30, 45, 46, 80]) {
		const lines = renderSidebarBanner(plain, width);
		const space = width - visibleWidth(label);
		assert.deepEqual(lines, space >= 0 ? [" ".repeat(Math.floor(space / 2)) + label + " ".repeat(Math.ceil(space / 2))] : []);
		assert.ok(lines.every((line) => visibleWidth(line) === width));
	}
});

test("heading uses the current theme on every render", () => {
	let palette = "dark";
	const theme = { ...plain, fg: (role: string, text: string) => `<${palette}:${role}>${text}` };
	assert.equal(renderSidebarBanner(theme, 46)[0].trim(), "<dark:accent>✿ <dark:text>Gentle Shell <dark:accent>✿");
	palette = "light";
	assert.equal(renderSidebarBanner(theme, 46)[0].trim(), "<light:accent>✿ <light:text>Gentle Shell <light:accent>✿");
});
