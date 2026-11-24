import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { encodeQr, renderQrTerminal, type QrMatrix } from "../lib/tower-qr.ts";

// The fixtures in tests/fixtures/tower-qr/ pin the module matrix encodeQr()
// returns for the three Gentle Tower URL shapes (loopback, LAN address, and a
// 63-character path). Each fixture was decoded back to its URL by an
// independent decoder (jsQR) in a scratch directory outside the repository,
// with the module matrix scaled to raw RGBA pixels; the observation is
// recorded in the task log. `#` is a dark module, `.` a light one.

const fixturesDir = new URL("../tests/fixtures/tower-qr/", import.meta.url);
interface Fixture { name: string; text: string; version: number; ecl: string; mask: number; size: number; rows: string[] }
const fixtures: Fixture[] = readdirSync(fixturesDir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(new URL(f, fixturesDir), "utf8")) as Fixture);

const HALF_BLOCKS = new Set([" ", "▀", "▄", "█"]);

/** Reads the half-block terminal lines back into module rows (dark = true), quiet zone removed. */
function modulesFromLines(lines: string[], quiet: number): boolean[][] {
	const width = lines[0].length - 2 * quiet;
	const rows: boolean[][] = [];
	for (let y = 0; y < lines.length * 2; y++) {
		const line = lines[Math.floor(y / 2)];
		const top = y % 2 === 0;
		const row: boolean[] = [];
		for (let x = 0; x < width; x++) {
			const glyph = line[x + quiet];
			row.push(glyph === "█" || (top ? glyph === "▀" : glyph === "▄"));
		}
		rows.push(row);
	}
	return rows.slice(quiet, quiet + width);
}

test("the three URL fixtures are present and are tower URLs", () => {
	assert.deepEqual(fixtures.map((f) => f.name), ["lan", "long-path", "loopback"]);
	for (const f of fixtures) {
		assert.match(f.text, /^http:\/\/[0-9.]+:[0-9]+\/[A-Za-z0-9_-]+\/$/);
		assert.equal(f.ecl, "M");
		assert.equal(f.size, f.version * 4 + 17);
		assert.equal(f.rows.length, f.size);
		assert.ok(f.rows.every((r) => r.length === f.size && /^[#.]+$/.test(r)));
	}
	assert.match(fixtures.find((f) => f.name === "loopback")!.text, /^http:\/\/127\.0\.0\.1:/);
	assert.match(fixtures.find((f) => f.name === "lan")!.text, /^http:\/\/192\.168\./);
	const long = fixtures.find((f) => f.name === "long-path")!;
	assert.equal(new URL(long.text).pathname.length, 63, "the path (with both slashes) is 63 characters");
});

test("encodeQr pins the module matrix of every fixture at error correction level M", () => {
	for (const f of fixtures) {
		const qr = encodeQr(f.text);
		assert.deepEqual([qr.size, qr.version, qr.ecl, qr.mask], [f.size, f.version, f.ecl, f.mask], f.name);
		assert.equal(qr.modules.length, f.size * f.size);
		const rows = Array.from({ length: f.size }, (_, y) => Array.from({ length: f.size }, (_, x) => (qr.modules[y * f.size + x] ? "#" : ".")).join(""));
		assert.deepEqual(rows, f.rows, f.name);
	}
});

test("the longest possible tower URL still fits at level M under version 10", () => {
	// 7 + "255.255.255.255:65535" (21) + a 63-character path = 91 characters.
	const text = `http://255.255.255.255:65535/${"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".slice(0, 61)}/`;
	assert.equal(text.length, 91);
	const qr = encodeQr(text);
	assert.equal(qr.ecl, "M");
	assert.ok(qr.version <= 10, `version ${qr.version}`);
	assert.equal(qr.size, qr.version * 4 + 17);
});

test("encodeQr refuses text that no QR Code can carry", () => {
	assert.throws(() => encodeQr("x".repeat(4000)), RangeError);
});

test("renderQrTerminal draws half blocks with a two-module quiet zone and the fixture's modules", () => {
	for (const f of fixtures) {
		const qr: QrMatrix = { ...encodeQr(f.text) };
		const lines = renderQrTerminal(qr);
		const width = f.size + 4;
		assert.equal(lines.length, Math.ceil((f.size + 4) / 2), f.name);
		for (const line of lines) {
			assert.equal(line.length, width, f.name);
			assert.ok([...line].every((g) => HALF_BLOCKS.has(g)), `${f.name}: only space, ▀, ▄, █`);
		}
		// The quiet zone: two light module rows on every side.
		assert.equal(lines[0].trim(), "", `${f.name}: top quiet rows`);
		assert.equal(lines[lines.length - 1].trim(), "", `${f.name}: bottom quiet row`);
		assert.ok(lines.every((l) => l.startsWith("  ") && l.endsWith("  ")), `${f.name}: side quiet columns`);
		// The symbol itself: the finder pattern's dark ring starts at module (2, 2) of the padded grid.
		assert.equal(lines[1][2], "█", `${f.name}: the top-left finder's corner is dark`);
		assert.deepEqual(modulesFromLines(lines, 2), f.rows.map((r) => [...r].map((c) => c === "#")), f.name);
	}
});

test("a rendered QR keeps its modules when the quiet zone width changes", () => {
	const f = fixtures.find((x) => x.name === "loopback")!;
	const qr = encodeQr(f.text);
	const lines = renderQrTerminal(qr, { quiet: 4 });
	assert.equal(lines.length, Math.ceil((f.size + 8) / 2));
	assert.ok(lines.every((l) => l.length === f.size + 8 && l.startsWith("    ") && l.endsWith("    ")));
	assert.deepEqual(modulesFromLines(lines, 4), f.rows.map((r) => [...r].map((c) => c === "#")));
});
