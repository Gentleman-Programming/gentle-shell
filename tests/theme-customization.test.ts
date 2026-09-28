import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourcePalettePreview } from "../lib/theme-customization.ts";

test("installed source palette resolves vars without activating a theme", (t) => {
	const root = mkdtempSync(join(tmpdir(), "theme-preview-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = join(root, "theme.json");
	const document = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json", import.meta.url), "utf8"));
	writeFileSync(source, JSON.stringify({ ...document, name: "dark", vars: { ...document.vars, previewAccent: "#123456" }, colors: { ...document.colors, accent: "previewAccent" } }));
	const alias = join(root, "alias.json");
	symlinkSync(source, alias);
	const preview = sourcePalettePreview("dark", alias);
	assert.match(preview.title, /dark.*source palette/);
	assert.match(preview.sample, /48;2;18;52;86m/); // The accent swatch is a background; text is foreground.
	assert.match(preview.sample, /38;2;/);
	assert.match(preview.sample, /sample text/);
});

test("preview fails closed for missing, mismatched, malformed and oversized sources", (t) => {
	const root = mkdtempSync(join(tmpdir(), "theme-preview-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "theme.json");
	assert.throws(() => sourcePalettePreview("dark", undefined));
	writeFileSync(path, JSON.stringify({ name: "wrong", colors: { accent: "#abcdef", text: "#000000" } }));
	assert.throws(() => sourcePalettePreview("dark", path));
	writeFileSync(path, "not json");
	assert.throws(() => sourcePalettePreview("dark", path));
	writeFileSync(path, " ".repeat(256_001));
	assert.throws(() => sourcePalettePreview("dark", path));
});

test("source palette supports indexed colors and rejects unresolved references", (t) => {
	const root = mkdtempSync(join(tmpdir(), "theme-preview-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const path = join(root, "theme.json");
	writeFileSync(path, JSON.stringify({ name: "dark", colors: { accent: 42, text: 255 } }));
	assert.match(sourcePalettePreview("dark", path).sample, /48;5;42m.*38;5;255m/);
	writeFileSync(path, JSON.stringify({ name: "dark", vars: { a: "b", b: "a" }, colors: { accent: "a", text: "#ffffff" } }));
	assert.throws(() => sourcePalettePreview("dark", path));
});
