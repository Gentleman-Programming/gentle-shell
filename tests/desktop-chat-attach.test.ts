import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

// The chat mod imports host modules ("herdr", "gpui-kit", "gpui-base") that only exist inside the
// Herdr app. Copy the real mod files, point those imports at chainable stubs, and import ui.js, so
// the shipped helper is what runs.
const MOD = join(dirname(fileURLToPath(import.meta.url)), "..", "herdr", "mods", "gentle-chat");
const HOST_MODULES = ["herdr", "gpui-kit", "gpui-base"];

function stubSource(names: string[]): string {
	const chain = "const chain = () => new Proxy(function () {}, { get: () => chain(), apply: () => chain(), construct: () => chain() });";
	return [chain, ...names.map((name) => `export const ${name} = (..._args) => chain();`)].join("\n");
}

let loads = 0;
async function loadUi(t: test.TestContext, home: string) {
	const dir = mkdtempSync(join(tmpdir(), "chat-attach-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	cpSync(MOD, dir, { recursive: true });
	const files = readdirSync(dir).filter((name) => name.endsWith(".js"));
	const wanted = new Map<string, Set<string>>(HOST_MODULES.map((name) => [name, new Set<string>()]));
	for (const file of files) {
		for (const match of readFileSync(join(dir, file), "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
			wanted.get(match[2])?.forEach(() => {});
			for (const name of match[1].split(",").map((n) => n.trim()).filter(Boolean)) wanted.get(match[2])?.add(name);
		}
	}
	const urls = new Map<string, string>();
	for (const [name, names] of wanted) {
		const extra = name === "herdr" ? [] : [];
		urls.set(name, "data:text/javascript," + encodeURIComponent(stubSource([...names, ...extra].filter((n) => !(name === "herdr" && n === "home")))
			+ (name === "herdr" ? "\nexport const home = () => globalThis.__chatAttachHome;" : "")));
	}
	for (const file of files) {
		let source = readFileSync(join(dir, file), "utf8");
		for (const [name, url] of urls) source = source.replaceAll(`from "${name}"`, `from "${url}"`);
		writeFileSync(join(dir, file), source);
	}
	const g = globalThis as Record<string, unknown>;
	g.__chatAttachHome = home;
	t.after(() => { delete g.__chatAttachHome; });
	return import(`${pathToFileURL(join(dir, "ui.js")).href}?load=${++loads}`);
}

test("should paste the clipboard image with alt+v on a Windows host", async (t) => {
	const ui = await loadUi(t, "C:/Users/dev");
	assert.equal(ui.pasteImageKey(), "alt+v");
	assert.equal(ui.isWindowsHost(), true);
});

test("should recognize a Windows home written with backslashes", async (t) => {
	const ui = await loadUi(t, "C:\\Users\\dev");
	assert.equal(ui.isWindowsHost(), true);
	assert.equal(ui.pasteImageKey(), "alt+v");
});

test("should paste the clipboard image with ctrl+v on a POSIX host", async (t) => {
	for (const home of ["/home/dev", "/Users/dev"]) {
		const ui = await loadUi(t, home);
		assert.equal(ui.pasteImageKey(), "ctrl+v", home);
		assert.equal(ui.isWindowsHost(), false, home);
	}
});

test("should default to ctrl+v when the host reports no home", async (t) => {
	const ui = await loadUi(t, undefined as unknown as string);
	assert.equal(ui.pasteImageKey(), "ctrl+v");
});

test("should name the platform's paste key in the attach tooltip", async (t) => {
	const windows = await loadUi(t, "C:/Users/dev");
	assert.match(windows.attachTooltip(), /alt\+v/i);
	const posix = await loadUi(t, "/home/dev");
	assert.match(posix.attachTooltip(), /ctrl\+v/i);
});
