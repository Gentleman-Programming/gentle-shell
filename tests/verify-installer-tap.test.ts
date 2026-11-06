import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = readFileSync(new URL("./installer-windows-bootstrap.test.ts", import.meta.url), "utf8");
const names = [...source.matchAll(/^test\(("native Windows(?:[^"\\]|\\.)*")\s*,/gm)].map((match) => JSON.parse(match[1]) as string);
const modes = JSON.parse(`[${/^const probeModes = \[([^\]]*)\] as const;$/m.exec(source)![1]}]`) as string[];
names.push(...modes.map((mode) => `native Windows: pre-Node production process primitive ${mode}`));
assert.equal(names.length, 38);

// Node's TAP reporter escapes backslashes in test names.
const tapNames = names.map((name) => name.replaceAll("\\", "\\\\"));
function tap(results = tapNames.map((name, i) => `ok ${i + 1} - ${name}`)) {
	return [`TAP version 13`, ...results, `ok ${results.length + 1} - other platform # SKIP unavailable`,
		`1..${results.length + 1}`, `# tests ${results.length + 1}`, `# suites 0`, `# pass ${results.length}`,
		`# fail 0`, `# cancelled 0`, `# skipped 1`, `# todo 0`, `# duration_ms 1.2`, ""].join("\n");
}
function verify(input: string) {
	return spawnSync(process.execPath, ["scripts/verify-installer-tap.mjs"], { input, encoding: "utf8" });
}

test("accepts every native pass even with an unrelated platform skip", () => {
	const input = tap().replace("ok 1 - ", "# Subtest: native fixture\n  ---\n  duration_ms: 1\n  ...\nok 1 - ");
	const result = verify(input.replaceAll("\n", "\r\n"));
	assert.equal(result.status, 0, result.stderr);
});

const cases: [string, (input: string) => string][] = [
	["missing native result", (s) => s.replace(` - ${names[0]}\n`, " - unrelated replacement\n")],
	["duplicate native result", (s) => s.replace(` - ${names[1]}\n`, ` - ${names[0]}\n`)],
	["native skip", (s) => s.replace(` - ${names[0]}\n`, ` - ${names[0]} # SKIP unavailable\n`)],
	["native TODO", (s) => s.replace(` - ${names[0]}\n`, ` - ${names[0]} # TODO later\n`)],
	["native failure", (s) => s.replace(`ok 1 - ${names[0]}`, `not ok 1 - ${names[0]}`)],
	["missing final summary", (s) => s.slice(0, s.indexOf("# tests"))],
	["missing plan", (s) => s.replace(/^1\.\.\d+\n/m, "")],
	["duplicate plan", (s) => s.replace(/^(1\.\.\d+)\n/m, "$1\n$1\n")],
	["duplicate summary", (s) => s + s.slice(s.indexOf("# tests"))],
	["truncated final line", (s) => s.slice(0, -1)],
	["inconsistent plan", (s) => s.replace("1..39", "1..40")],
	["inconsistent summary", (s) => s.replace("# tests 39", "# tests 40")],
	["unaccounted skip", (s) => s.replace("# pass 38", "# pass 39").replace("# skipped 1", "# skipped 0")],
	["duplicate partial summary", (s) => s.replace("1..39\n", "# tests 39\n1..39\n")],
	["duplicate header", (s) => s.replace("1..39\n", "TAP version 13\n1..39\n")],
	["duplicate result number", (s) => s.replace("ok 2 - ", "ok 1 - ")],
	["unexpected failure", (s) => s.replace("# fail 0", "# fail 1")],
	["unexpected TODO", (s) => s.replace("# todo 0", "# todo 1")],
	["unexpected cancellation", (s) => s.replace("# cancelled 0", "# cancelled 1")],
	["malformed result", (s) => s.replace("ok 2 - ", "okay 2 - ")],
];
for (const [label, mutate] of cases) {
	test(`rejects ${label}`, () => {
		const result = verify(mutate(tap()));
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /installer TAP:/);
	});
}
