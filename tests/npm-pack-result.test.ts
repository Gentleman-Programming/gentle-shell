import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNpmPackResult, parseNpmPackResult } from "../scripts/npm-pack-result.mjs";

const entry = {
	name: "gentle-pi", filename: "gentle-pi-4.0.0.tgz",
	files: [{ path: "assets/sounds/success.wav", size: 13272 }],
	integrity: "sha512-fixture",
};

test("npm 11 array preserves tarball filename and file records", () => {
	assert.deepEqual(parseNpmPackResult(JSON.stringify([entry])), [entry]);
});

test("npm 12 named map preserves tarball filename and file records", () => {
	assert.deepEqual(parseNpmPackResult(JSON.stringify({ "gentle-pi": entry })), [entry]);
});

test("rejects empty and multiple results when exactly one tarball is expected", () => {
	const other = { ...entry, name: "other", filename: "other.tgz" };
	for (const value of [[], {}, [entry, other], { "gentle-pi": entry, other }]) {
		assert.throws(() => normalizeNpmPackResult(value), /exactly one package/);
	}
});

test("rejects arbitrary objects, malformed records and npm error envelopes", () => {
	for (const value of [
		null, false, 7, "output", { error: { code: "EFAIL", summary: "pack failed" } },
		{ "gentle-pi": null }, { "gentle-pi": [] }, { wrong: entry },
		{ "gentle-pi": entry, invalid: null }, [null], [[]], [{}],
		[{ ...entry, name: "" }], [{ ...entry, filename: " " }],
		[{ ...entry, files: null }], [{ ...entry, files: [] }],
		[{ ...entry, files: [null] }], [{ ...entry, files: [{ path: "" }] }],
		[{ ...entry, files: ["file.wav"] }],
	]) assert.throws(() => normalizeNpmPackResult(value), /npm pack/);
});

test("invalid JSON and npm errors are not silently converted to a pack result", () => {
	assert.throws(() => parseNpmPackResult("npm ERR! pack failed"), SyntaxError);
	assert.throws(() => parseNpmPackResult('{"error":{"code":"EFAIL"}}'), /npm pack/);
});
