#!/usr/bin/env node
// Regenerates assets/migrations/agent-body-history.json: the sha256 of every
// body (text after the frontmatter) each packaged agent has had in git
// history. Installation uses it to keep refreshing package agents whose
// frontmatter was edited locally. Run after changing any assets/agents file.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const agentsDir = join(root, "assets", "agents");
const output = join(root, "assets", "migrations", "agent-body-history.json");

// Mirrors agentBody() in lib/agent-assets.ts.
function agentBody(content) {
	if (!content.startsWith("---\n")) return content;
	const endIndex = content.indexOf("\n---", 4);
	return endIndex === -1 ? content : content.slice(endIndex);
}

const hash = (content) => createHash("sha256").update(agentBody(content)).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const bodies = {};
for (const file of readdirSync(agentsDir).filter((name) => name.endsWith(".md")).sort()) {
	const path = `assets/agents/${file}`;
	const hashes = new Set([hash(readFileSync(join(agentsDir, file), "utf8"))]);
	for (const commit of git("log", "--format=%H", "--", path).split("\n").filter(Boolean)) {
		try {
			hashes.add(hash(git("show", `${commit}:${path}`)));
		} catch {
			// The commit deleted or renamed the file; it has no body to record.
		}
	}
	bodies[`agents/${file}`] = [...hashes].sort();
}

writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, bodies }, null, 2)}\n`);
console.log(`agent body history: ${Object.values(bodies).flat().length} hashes for ${Object.keys(bodies).length} agents`);
