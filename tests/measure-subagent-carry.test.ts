import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/measure-subagent-carry.mjs", import.meta.url));

interface Entry {
	when: string;
	role: "toolResult" | "assistant";
	text?: string;
	tokens?: number;
}

function transcript(home: string, child: string, entries: Entry[]): void {
	const dir = join(home, "gentle-agents", "sessions", child);
	mkdirSync(dir, { recursive: true });
	const lines = entries.map((entry) =>
		JSON.stringify({
			timestamp: entry.when,
			message:
				entry.role === "toolResult"
					? { role: "toolResult", content: entry.text ?? "" }
					: { role: "assistant", usage: { totalTokens: entry.tokens ?? 0 } },
		}),
	);
	writeFileSync(join(dir, "session.jsonl"), `${lines.join("\n")}\n`);
}

const measure = (home: string, days: number): { children: number; uniqueToolResultBytes: number; carryLoadBytes: number } =>
	JSON.parse(
		execFileSync(process.execPath, [script, "--home", home, "--days", String(days), "--json"], { encoding: "utf8" }),
	);

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

test("the window selects which children are reported and the carry spans each full transcript", () => {
	const home = mkdtempSync(join(tmpdir(), "carry-measure-"));
	try {
		transcript(home, "recent", [
			{ when: daysAgo(10), role: "toolResult", text: "x".repeat(1000) },
			{ when: daysAgo(1), role: "assistant", tokens: 5 },
		]);
		transcript(home, "stale", [
			{ when: daysAgo(12), role: "assistant", tokens: 5 },
			{ when: daysAgo(11), role: "toolResult", text: "y".repeat(500) },
			{ when: daysAgo(10), role: "assistant", tokens: 5 },
		]);

		// Persisted timestamps are ISO strings, so a numeric cast leaves the window
		// inert and reports both children for any --days value.
		const week = measure(home, 7);
		assert.equal(week.children, 1);

		// The window chooses who is reported, not which entries count: the tool result
		// that predates it was still in context, so the later call re-reads it.
		assert.equal(week.uniqueToolResultBytes, 1000);
		assert.equal(week.carryLoadBytes, 1000);

		// Widening the window past the stale child's last activity reports it whole.
		const fortnight = measure(home, 15);
		assert.equal(fortnight.children, 2);
		assert.equal(fortnight.uniqueToolResultBytes, 1500);
		assert.equal(fortnight.carryLoadBytes, 1500);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
