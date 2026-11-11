#!/usr/bin/env node
// Updates assets/migrations/agent-body-history.json: the sha256 of every body
// (text after the frontmatter) each packaged agent has shipped with.
// Installation uses it to keep refreshing package agents whose frontmatter was
// edited locally. Run after changing any assets/agents file.
//
// The file is append-only. Git history from HEAD is not a complete record of
// shipped bodies: a squash merge leaves the bodies of the branch's own commits
// unreachable (#2970 recorded bodies from commits that only exist on its
// branch), yet an installation may still carry one. Recorded hashes are
// therefore always kept and only new bodies are added.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

// An existing file that cannot be read as a history must stop the run: writing
// over it would lose every recorded hash.
function readRecorded() {
	if (!existsSync(output)) return {};
	const parsed = JSON.parse(readFileSync(output, "utf8"));
	const bodies = parsed?.bodies;
	if (
		parsed?.schemaVersion !== 1 ||
		typeof bodies !== "object" ||
		bodies === null ||
		Array.isArray(bodies) ||
		!Object.values(bodies).every((hashes) => Array.isArray(hashes) && hashes.every((h) => typeof h === "string"))
	) {
		throw new Error("unexpected shape (schemaVersion 1 with string arrays under bodies)");
	}
	return bodies;
}

let recorded;
try {
	recorded = readRecorded();
} catch (error) {
	console.error(`cannot read ${output}: ${error.message}; not rewriting it`);
	process.exit(1);
}

const found = {};
for (const file of readdirSync(agentsDir).filter((name) => name.endsWith(".md")).sort()) {
	const path = `assets/agents/${file}`;
	const hashes = new Set([hash(readFileSync(join(agentsDir, file), "utf8"))]);
	for (const commit of git("log", "--format=%H", "--", path).split("\n").filter(Boolean)) {
		// A commit that deleted or renamed the file has no body to record. Any
		// other git failure (missing objects in a partial clone) must fail loudly
		// instead of writing a truncated history.
		if (git("ls-tree", commit, "--", path).trim() === "") continue;
		hashes.add(hash(git("show", `${commit}:${path}`)));
	}
	found[`agents/${file}`] = hashes;
}

const bodies = {};
let kept = 0;
let added = 0;
let notInHistory = 0;
for (const key of [...new Set([...Object.keys(recorded), ...Object.keys(found)])].sort()) {
	const known = new Set(recorded[key] ?? []);
	const fromHistory = found[key] ?? new Set();
	kept += known.size;
	for (const h of known) if (!fromHistory.has(h)) notInHistory++;
	for (const h of fromHistory) if (!known.has(h)) added++;
	bodies[key] = [...new Set([...known, ...fromHistory])].sort();
}

writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, bodies }, null, 2)}\n`);
console.log(
	`agent body history: ${Object.values(bodies).flat().length} hashes for ${Object.keys(bodies).length} agents (kept ${kept}, added ${added}, kept although not in git history ${notInHistory})`,
);
