import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DESIGN_CANVAS_ASSETS } from "../lib/design-canvas-assets.ts";
import { FakeDocument } from "./support/design-canvas-dom.ts";

// The canvas modules (S1, S3, S4): flat files under assets/design-canvas/, loaded
// as ES modules from canvas.js, wired only by canvas-boot.js.

const ASSET_DIR = fileURLToPath(new URL("../assets/design-canvas/", import.meta.url));
const read = (name: string) => readFileSync(join(ASSET_DIR, name), "utf8");
const MODULES = Object.keys(DESIGN_CANVAS_ASSETS).filter((name) => name.startsWith("canvas-") && name.endsWith(".js"));
// Every browser global the canvas uses, and the usual ways to reach the page.
const BROWSER_GLOBALS = ["window", "document", "self", "globalThis.window", "fetch", "EventSource", "localStorage", "location", "history", "URL", "CSS", "innerWidth", "innerHeight", "setTimeout", "clearTimeout", "requestAnimationFrame", "ResizeObserver", "FileReader", "addEventListener", "navigator"];

/** Imports `names` in a fresh Node process where touching any browser global throws. */
function importWithoutGlobals(names: string[]) {
	const urls = names.map((name) => pathToFileURL(join(ASSET_DIR, name)).href);
	const script = [
		`for (const name of ${JSON.stringify(BROWSER_GLOBALS.filter((name) => !name.includes(".")))}) {`,
		"\tObject.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`touched ${name}`); }, set() { throw new Error(`touched ${name}`); } });",
		"}",
		`for (const url of ${JSON.stringify(urls)}) {`,
		"\ttry { await import(url); console.log(`imported ${url.split(\"/\").pop()}`); } catch (error) { console.log(`failed ${url.split(\"/\").pop()}: ${error.message}`); process.exitCode = 1; }",
		"}",
	].join("\n");
	return spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
}

test("no canvas module touches the DOM or window when it is imported", () => {
	assert.equal(MODULES.length, 13);
	const result = importWithoutGlobals(MODULES);
	assert.equal(result.stderr, "");
	assert.deepEqual(result.stdout.trim().split("\n"), MODULES.map((name) => `imported ${name}`));
	assert.equal(result.status, 0);
	// The guard is real: the entry boots at import and so touches window.
	const entry = importWithoutGlobals(["canvas.js"]);
	assert.equal(entry.stdout.trim(), "failed canvas.js: touched window");
	assert.equal(entry.status, 1);
});

test("canvas.js is the two-line entry and index.html loads it as a module", () => {
	assert.equal(read("canvas.js"), 'import { boot } from "./canvas-boot.js";\nboot(window, document);\n');
	const html = read("index.html");
	assert.match(html, /<script type="module" src="\{\{BASE\}\}assets\/canvas\.js"><\/script>/);
	assert.equal(html.match(/<script\b[^>]*\bsrc=/g)?.length, 1, "canvas.js is the only script the page loads");
	assert.ok(!/\bdefer\b/.test(html), "module scripts are deferred already");
});

test("each module exports init(ctx), and only canvas-boot.js imports its siblings", async () => {
	for (const name of MODULES) {
		const source = read(name);
		const imports = source.match(/^\s*import\b.*$/gm) ?? [];
		if (name === "canvas-boot.js") {
			assert.deepEqual(imports.map((line) => /from "(\.\/[^"]+)"/.exec(line)?.[1]).sort(), MODULES.filter((module) => module !== "canvas-boot.js").map((module) => `./${module}`).sort(), "boot imports every other module");
		} else {
			assert.deepEqual(imports, [], `${name} imports nothing`);
		}
		assert.ok(!/\bimport\s*\(/.test(source), `${name} has no dynamic import`);
		const module = await import(pathToFileURL(join(ASSET_DIR, name)).href);
		const expected = name === "canvas-boot.js" ? "boot" : name === "canvas-store.js" ? "createStore" : "init";
		assert.deepEqual(Object.keys(module), [expected], `${name} exports ${expected}`);
		assert.equal(typeof module[expected], "function");
	}
});

test("canvas-boot.js documents the ctx.actions rule", () => {
	const boot = read("canvas-boot.js").replace(/\n\/\/ ?/g, " ");
	assert.ok(boot.includes("Actions are only complete once every `init` has returned, so no `init` may call another module's action synchronously"));
});

test("boot registers window listeners in main's order, with and without ResizeObserver", async () => {
	const { boot } = await import(pathToFileURL(join(ASSET_DIR, "canvas-boot.js")).href);
	for (const ro of [false, true]) {
		const doc = new FakeDocument();
		doc.getElementById("gd-config").textContent = JSON.stringify({ base: "/t/", slug: null });
		const order: string[] = [];
		const observed: unknown[] = [];
		const win: Record<string, any> = { addEventListener: (type: string) => order.push(type), localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, requestAnimationFrame: () => 0, fetch: () => new Promise(() => {}), EventSource: class { addEventListener() {} }, location: { port: "1" }, URL, history: { replaceState() {} } };
		if (ro) win.ResizeObserver = class { observe(el: unknown) { observed.push(el); } };
		boot(win, doc);
		assert.deepEqual(order, ro ? ["message", "resize", "resize"] : ["message", "resize", "resize", "resize"]);
		assert.deepEqual(observed, ro ? [doc.getElementById("gd-viewport")] : []);
	}
});
