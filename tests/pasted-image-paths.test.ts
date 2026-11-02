import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePathTokens, readPastedImagePaths } from "../lib/pasted-image-paths.ts";

// Herdr hands a clipboard image to a terminal on another machine as a temp-file
// path, and dropped or file-manager-copied images arrive as quoted paths. Those
// pastes must become chips instead of text.

const PNG_2X1 = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);

type Files = Record<string, Uint8Array>;

function filesystem(files: Files, home = "/home/devel") {
	return {
		home,
		readFile: (path: string) => {
			const bytes = files[path];
			if (!bytes) throw new Error(`ENOENT: ${path}`);
			return bytes;
		},
		isFile: (path: string) => path in files,
	};
}

test("a bare image path from Herdr's clipboard bridge becomes an image", () => {
	const options = filesystem({ "/tmp/client-1-clipboard-99.png": PNG_2X1 });
	assert.deepEqual(
		readPastedImagePaths("/tmp/client-1-clipboard-99.png", options).map((image) => image.mimeType),
		["image/png"],
	);
});

test("Herdr's quoted paths keep spaces and become one chip per file", () => {
	const options = filesystem({
		"/tmp/herdr paste/a.png": PNG_2X1,
		"/tmp/herdr paste/b.jpg": JPEG,
	});
	const images = readPastedImagePaths("'/tmp/herdr paste/a.png' '/tmp/herdr paste/b.jpg' ", options);
	assert.deepEqual(images.map((image) => image.mimeType), ["image/png", "image/jpeg"]);
});

test("an escaped quote inside a quoted path stays part of the name", () => {
	const options = filesystem({ "/tmp/it's/one.gif": GIF });
	assert.deepEqual(readPastedImagePaths("'/tmp/it'\\''s/one.gif'", options).map((image) => image.mimeType), ["image/gif"]);
});

test("newline-separated paths, ~ and file:// URLs resolve", () => {
	const options = filesystem({
		"/home/devel/shot.webp": WEBP,
		"/tmp/other.png": PNG_2X1,
	});
	const pasted = `${"/tmp/other.png"}\n~/shot.webp`;
	assert.deepEqual(readPastedImagePaths(pasted, options).map((image) => image.mimeType), ["image/png", "image/webp"]);
	assert.deepEqual(
		readPastedImagePaths("file:///tmp/other.png", options).map((image) => image.mimeType),
		["image/png"],
	);
});

test("text, a sentence mentioning a path, or a mix with it stays Pi's paste", () => {
	const options = filesystem({ "/tmp/shot.png": PNG_2X1 });
	assert.deepEqual(readPastedImagePaths("", options), []);
	assert.deepEqual(readPastedImagePaths("look at /tmp/shot.png please", options), []);
	assert.deepEqual(readPastedImagePaths("/tmp/shot.png and more", options), []);
	assert.deepEqual(readPastedImagePaths("/tmp/shot.png\n/tmp/missing.png", options), []);
});

test("missing files, non-image extensions and foreign bytes are not images", () => {
	const notAnImage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
	const options = filesystem({
		"/tmp/missing.png": PNG_2X1,
		"/tmp/notes.txt": PNG_2X1,
		"/tmp/fake.png": notAnImage,
		"relative/shot.png": PNG_2X1,
	});
	assert.deepEqual(readPastedImagePaths("/tmp/absent.png", options), []);
	assert.deepEqual(readPastedImagePaths("/tmp/notes.txt", options), []);
	assert.deepEqual(readPastedImagePaths("/tmp/fake.png", options), []);
	assert.deepEqual(readPastedImagePaths("relative/shot.png", options), []);
});

test("a paste of more than eight paths stays Pi's paste", () => {
	const files: Files = {};
	const tokens: string[] = [];
	for (let index = 0; index < 9; index += 1) {
		files[`/tmp/${index}.png`] = PNG_2X1;
		tokens.push(`/tmp/${index}.png`);
	}
	assert.deepEqual(readPastedImagePaths(tokens.join(" "), filesystem(files)), []);
	assert.equal(readPastedImagePaths(tokens.slice(0, 8).join(" "), filesystem(files)).length, 8);
});

test("token parsing handles single quotes, double quotes, escapes and newlines", () => {
	assert.deepEqual(parsePathTokens("'a b.png' \"c d.png\" e\\ f.png"), ["a b.png", "c d.png", "e f.png"]);
	assert.deepEqual(parsePathTokens("\n/tmp/a.png\n\n/tmp/b.png\r\n"), ["/tmp/a.png", "/tmp/b.png"]);
	assert.deepEqual(parsePathTokens("'/tmp/it'\\''s.png'"), ["/tmp/it's.png"]);
});

test("an oversized file is rejected before its bytes are read", () => {
	// A sparse file keeps this cheap while still exceeding the 64 MiB cap.
	const directory = mkdtempSync(join(tmpdir(), "gentle-pasted-path-"));
	const path = join(directory, "huge.png");
	writeFileSync(path, PNG_2X1);
	truncateSync(path, 64 * 1024 * 1024 + 1);
	assert.deepEqual(readPastedImagePaths(path, {}), []);
	rmSync(directory, { recursive: true, force: true });
});
