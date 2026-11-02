import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// gentle-shell#2686: on network-mounted workspaces a single unbounded recursive
// scan (`grep -r … .`) over raw `bash` cost up to 24.8 minutes (21–75× SMB I/O),
// and six such calls turned a trivial verification into a 49.6-minute wait. The
// dedicated `grep`/`find` tools honour `.gitignore` and never walk `.git`, and a
// bounded scan is faster even on local disks (0.06 s vs 1.8 s on an 8.7 MB repo),
// so the bound is unconditional: it never depends on the model detecting a
// network mount. Like the other prompt contracts here, this pins instruction
// delivery, not model adherence.
// These are instruction-delivery contracts, not proof of model adherence.

const read = (relative: string): string => readFileSync(join(import.meta.dirname, "..", relative), "utf8");
const verify = read("assets/agents/gentle-ai-verify.md");
const worker = read("assets/agents/gentle-ai-worker.md");

function containsAll(text: string, clauses: readonly string[], label: string): void {
	const folded = text.toLowerCase();
	for (const clause of clauses) assert.ok(folded.includes(clause.toLowerCase()), `${label} is missing: ${clause}`);
}

for (const [label, prompt] of [["verify", verify], ["worker", worker]] as const) {
	test(`${label}: prefers the dedicated tools over raw bash grep`, () => {
		containsAll(prompt, [
			"prefer the dedicated `grep`/`find` tools over raw `bash` grep",
			"they honour `.gitignore` and never walk `.git`",
		], `${label} search bounds`);
	});

	test(`${label}: forbids unbounded recursive scans`, () => {
		containsAll(prompt, [
			"Never run an unbounded recursive scan (`grep -r … .`, `find .` from the workspace root)",
			"bound to source directories and pass `--exclude-dir={.git,vendor,node_modules}`",
		], `${label} search bounds`);
	});
}
