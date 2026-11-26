import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TestContext } from "node:test";

// The chat mod imports host modules ("herdr", "gpui-kit", "gpui-base") that only exist inside the
// Herdr app. Copy the real mod files, point those imports at chainable stubs, and import ui.js, so
// the shipped helpers are what runs. These are stubbed host modules, not a real Herdr.
const MOD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "herdr", "mods", "gentle-chat");
const HOST_MODULES = ["herdr", "gpui-kit", "gpui-base"];

function stubSource(names: string[]): string {
	const chain = "const chain = () => new Proxy(function () {}, { get: () => chain(), apply: () => chain(), construct: () => chain() });";
	return [chain, ...names.map((name) => `export const ${name} = (..._args) => chain();`)].join("\n");
}

let loads = 0;

export async function loadChatUi(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "chat-ui-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	cpSync(MOD, dir, { recursive: true });
	const files = readdirSync(dir).filter((name) => name.endsWith(".js"));
	const wanted = new Map<string, Set<string>>(HOST_MODULES.map((name) => [name, new Set<string>()]));
	for (const file of files) {
		for (const match of readFileSync(join(dir, file), "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
			for (const name of match[1].split(",").map((n) => n.trim()).filter(Boolean)) wanted.get(match[2])?.add(name);
		}
	}
	const urls = new Map<string, string>();
	for (const [name, names] of wanted) urls.set(name, "data:text/javascript," + encodeURIComponent(stubSource([...names])));
	for (const file of files) {
		let source = readFileSync(join(dir, file), "utf8");
		for (const [name, url] of urls) source = source.replaceAll(`from "${name}"`, `from "${url}"`);
		writeFileSync(join(dir, file), source);
	}
	return import(`${pathToFileURL(join(dir, "ui.js")).href}?load=${++loads}`);
}
