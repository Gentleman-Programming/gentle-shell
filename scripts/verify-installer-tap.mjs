import { readFileSync } from "node:fs";

function fail(message) { throw new Error(message); }

try {
	// Keep the inventory tied to the actual top-level declarations and parameter modes.
	const source = readFileSync(new URL("../tests/installer-windows-bootstrap.test.ts", import.meta.url), "utf8");
	const names = [...source.matchAll(/^test\(("native Windows(?:[^"\\]|\\.)*")\s*,/gm)].map((match) => JSON.parse(match[1]));
	const modesSource = /^const probeModes = \[([^\]]*)\] as const;$/m.exec(source);
	if (!modesSource || !/^for \(const mode of probeModes\) \{\n\ttest\(`native Windows: pre-Node production process primitive \$\{mode\}`/m.test(source)) fail("native mode declarations changed");
	const modes = JSON.parse(`[${modesSource[1]}]`);
	if (!Array.isArray(modes) || modes.some((mode) => typeof mode !== "string")) fail("invalid native modes");
	names.push(...modes.map((mode) => `native Windows: pre-Node production process primitive ${mode}`));
	if (names.length !== 38 || new Set(names).size !== 38) fail("expected 38 unique native declarations");

	const text = readFileSync(0, "utf8").replaceAll("\r\n", "\n");
	if (!text.startsWith("TAP version 13\n") || !text.endsWith("\n") || [...text.matchAll(/^TAP version 13$/gm)].length !== 1) fail("missing or duplicate TAP header, or missing final newline");
	const plans = [...text.matchAll(/^1\.\.(\d+)$/gm)];
	const summaries = [...text.matchAll(/^# tests (\d+)\n# suites (\d+)\n# pass (\d+)\n# fail (\d+)\n# cancelled (\d+)\n# skipped (\d+)\n# todo (\d+)\n# duration_ms ([\d.]+)\n/gm)];
	if (plans.length !== 1 || summaries.length !== 1 || summaries[0].index <= plans[0].index || summaries[0].index + summaries[0][0].length !== text.length) fail("missing, duplicate or incomplete plan/summary");
	for (const field of ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo", "duration_ms"]) {
		if ([...text.matchAll(new RegExp(`^# ${field} `, "gm"))].length !== 1) fail(`duplicate or missing summary field: ${field}`);
	}
	const results = [...text.matchAll(/^(ok|not ok) (\d+) - (.+)$/gm)];
	const [tests, suites, pass, failed, cancelled, skipped, todo] = summaries[0].slice(1, 8).map(Number);
	const topLevelSkips = results.filter((result) => /\s+# SKIP\b/i.test(result[3])).length;
	if (failed || cancelled || todo || pass < 38 || tests !== pass + skipped || results.length !== Number(plans[0][1]) || results.length > tests + suites || topLevelSkips > skipped || results.length - topLevelSkips > pass + suites) fail("inconsistent TAP accounting");
	if (results.some((result, index) => Number(result[2]) !== index + 1 || result.index >= plans[0].index || result[1] !== "ok")) fail("invalid TAP results");
	// Node's TAP reporter escapes backslashes in names before printing them.
	const seen = new Map(names.map((name) => [name.replaceAll("\\", "\\\\"), 0]));
	for (const result of results) {
		const name = result[3];
		if (seen.has(name)) seen.set(name, seen.get(name) + 1);
		else if (name.startsWith("native Windows")) fail(`unexpected or non-passing native result: ${name}`);
	}
	for (const [name, count] of seen) if (count !== 1) fail(`expected one native PASS: ${name} (found ${count})`);
	// Top-level output consists of results, plan, header and comments. Nested TAP is indented.
	for (const line of text.split("\n")) {
		if (line && !line.startsWith(" ") && line !== "TAP version 13" && !line.startsWith("#") && !/^(?:ok|not ok) \d+ - .+$/.test(line) && !/^1\.\.\d+$/.test(line)) fail(`malformed top-level line: ${line}`);
	}
	console.log("installer TAP: 38 native passes, zero native skips");
} catch (error) {
	console.error(`installer TAP: ${error.message}`);
	process.exitCode = 1;
}
