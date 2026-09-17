import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENTS = join(ROOT, "assets", "agents");
const ASSETS = join(ROOT, "assets");

// SDD phase executors installed to ~/.pi/agent/agents/ by installSddAssets.
// Each carries its own effective prompt; none inherits the parent workflow.
const SDD_PREFIX = "sdd-";

// Strict-output agents that must remain untouched by Key Learnings: the
// Judgment Day roles (`jd-*`) and the review lens roles (`review-*`). Derived
// from the agents actually on disk rather than hardcoded, so retiring one
// (as #320 did to `review-refuter.md` and `review-validator.md`) cannot break
// this guard with an ENOENT instead of a real assertion.
const STRICT_JSON_PREFIX = /^(jd-|review-)/;

// Canonical semantics every Key Learnings section must encode.
const KL_SEMANTICS: Array<[string, RegExp]> = [
	["heading `## Key Learnings`", /`## Key Learnings`/],
	["1–5 numbered items", /1[–-]5 numbered/],
	["standalone factual sentence", /standalone factual sentence/],
	["at least 20 characters", /at least 20 characters/],
	["at least 4 words", /at least 4 words/],
	["final report text only", /final (?:report|response) text only/],
	["Engram extracts and persists", /Engram[^\n]*automatically extracts[^\n]*persists/i],
	["executor does not parse", /do(?:es)? not parse/],
	["passive-capture tool wording", /passive.capture/i],
	["omit when no reusable learning", /[Oo]mit[^\n]*no reusable learning/],
	["separate from mem_save", /separate from[^\n]*mem_save/],
];

function readSection(source: string, heading: string): string | null {
	const lines = source.split(/\r?\n/);
	const start = lines.findIndex((l) => /^#{1,6}\s+/.test(l) && l.replace(/^#{1,6}\s+/, "").trim() === heading);
	if (start === -1) return null;
	const level = lines[start].match(/^(#{1,6})/)![1].length;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const m = lines[i].match(/^(#{1,6})\s+/);
		if (m && m[1].length <= level) { end = i; break; }
	}
	return lines.slice(start, end).join("\n").trim();
}

function agentFiles(): string[] {
	return readdirSync(AGENTS).filter((f) => f.endsWith(".md")).sort();
}

function sddAgents(): string[] {
	return agentFiles().filter((f) => f.startsWith(SDD_PREFIX));
}

function strictJsonAgents(): string[] {
	return agentFiles().filter((f) => STRICT_JSON_PREFIX.test(f));
}

test("every SDD phase executor carries an effective `## Key Learnings Closing` section with full semantics", () => {
	const agents = sddAgents();
	assert.ok(agents.length >= 12, `expected >=12 SDD agents, found ${agents.length}`);
	const missing: string[] = [];
	const failed: string[] = [];
	for (const file of agents) {
		const source = readFileSync(join(AGENTS, file), "utf8");
		const section = readSection(source, "Key Learnings Closing");
		if (section === null) { missing.push(file); continue; }
		for (const [label, regex] of KL_SEMANTICS) {
			if (!regex.test(section)) failed.push(`${file}: ${label}`);
		}
	}
	assert.deepEqual(missing, [], "every SDD agent must carry a `## Key Learnings Closing` section");
	assert.deepEqual(failed, [], "every section must encode all canonical semantics");
});

test("no SDD phase executor infers Key Learnings through `standard phase envelope` alone", () => {
	for (const file of sddAgents()) {
		const source = readFileSync(join(AGENTS, file), "utf8");
		const section = readSection(source, "Key Learnings Closing");
		assert.ok(section, `${file} must have a direct Key Learnings Closing section`);
	}
});

test("SDD executor coverage is exhaustive against actual agent files", () => {
	const actual = sddAgents();
	// Allowlist: the 13 known phase executors. A new sdd-*.md without a
	// Key Learnings Closing section fails the first test; this test proves
	// the allowlist matches reality so coverage cannot silently drift.
	const expected = [
		"sdd-apply.md", "sdd-archive.md", "sdd-design.md", "sdd-explore.md",
		"sdd-init.md", "sdd-onboard.md", "sdd-proposal.md", "sdd-remediate.md", "sdd-research.md",
		"sdd-spec.md", "sdd-status.md", "sdd-tasks.md",
		"sdd-verify.md",
	];
	assert.deepEqual(actual, expected, "SDD agent set must match the known allowlist");
});

test("generic delegation contract instructs the same `## Key Learnings` closing block", () => {
	const delegation = readFileSync(join(ASSETS, "orchestrator-delegation.md"), "utf8");
	const section = readSection(delegation, "Key Learnings closing block");
	assert.ok(section, "orchestrator-delegation.md must have a Key Learnings closing block section");
	for (const [label, regex] of KL_SEMANTICS) {
		assert.match(section, regex, `delegation missing semantic: ${label}`);
	}
	assert.match(section, /native `Agent`/, "must cover native Agent fallback");
	assert.match(section, /strict JSON/i, "must exclude strict-JSON agents");
	assert.match(section, /layers on after/, "must state the block layers on after the envelope");
});

test("sdd-orchestrator-workflow documents routing, not executor authority", () => {
	const workflow = readFileSync(join(ASSETS, "sdd-orchestrator-workflow.md"), "utf8");
	const section = readSection(workflow, "Key Learnings closing block (routing)");
	assert.ok(section, "workflow must document Key Learnings routing");
	assert.match(section, /installed SDD phase executor agent.*carries the effective.*contract/i);
	assert.match(section, /documents routing only and is not the executor authority/);
});

test("provider ownership: no Pi TypeScript runtime parses Key Learnings or invokes passive-capture tools", () => {
	const roots = ["lib", "extensions", "scripts", "runtime"];
	const forbidden: Array<[string, RegExp]> = [
		["Key Learnings parser", /Key Learnings/i],
		["key_learnings token", /key_learnings/i],
		["passive-capture tool invocation", /mem_capture_passive|capture_passive|passive_capture/i],
	];
	const failures: string[] = [];
	for (const root of roots) {
		const absRoot = join(ROOT, root);
		if (!existsSync(absRoot)) continue;
		for (const file of listCodeFiles(absRoot)) {
			const text = readFileSync(file, "utf8");
			for (const [label, regex] of forbidden) {
				if (regex.test(text)) failures.push(`${relative(ROOT, file)}: ${label}`);
			}
		}
	}
	assert.deepEqual(failures, [], "Pi must not parse Key Learnings or invoke passive-capture tools");
});

// Recursive walker over a provider root. Replaces the previous direct-children
// scan so nested `.ts`/`.mjs` runtime code cannot evade the ownership guard.
// Directories are recursed; only regular `.ts`/`.mjs` files are yielded;
// symlinks (file or directory) are never followed, preventing loops and
// external traversal. Output is sorted for deterministic failure messages.
// Fail-closed: traversal/read errors propagate so a forbidden file under an
// unreadable directory cannot silently evade the guard.
function listCodeFiles(rootDir: string): string[] {
	const out: string[] = [];
	const stack: string[] = [rootDir];
	while (stack.length > 0) {
		const dir = stack.pop()!;
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (e.isSymbolicLink()) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) stack.push(full);
			else if (e.isFile() && /\.(ts|mjs)$/.test(e.name)) out.push(full);
		}
	}
	return out.sort();
}

test("listCodeFiles recurses nested code, ignores non-code files, and skips symlinks", () => {
	const tmp = mkdtempSync(join(tmpdir(), "kl-walker-"));
	try {
		const nested = join(tmp, "a", "b");
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, "leak.ts"), "Key Learnings leak\n");
		writeFileSync(join(tmp, "a", "leak.mjs"), "key_learnings\n");
		writeFileSync(join(tmp, "a", "notes.md"), "Key Learnings in prose\n");
		writeFileSync(join(tmp, "a", "data.json"), '{"k":"Key Learnings"}\n');
		const files = listCodeFiles(tmp);
		assert.ok(files.some((f) => f.endsWith("leak.ts")), "nested .ts must be discovered");
		assert.ok(files.some((f) => f.endsWith("leak.mjs")), "shallow .mjs must be discovered");
		assert.ok(!files.some((f) => f.endsWith(".md")), "non-code .md must be ignored");
		assert.ok(!files.some((f) => f.endsWith(".json")), "non-code .json must be ignored");
		// Symlink controls: skip when the platform rejects symlink creation.
		const dirLink = join(tmp, "link-dir");
		const fileLink = join(tmp, "link-file.ts");
		let symlinksSupported = true;
		try {
			symlinkSync(join(tmp, "a"), dirLink, "dir");
			symlinkSync(join(tmp, "a", "leak.mjs"), fileLink, "file");
		} catch {
			symlinksSupported = false;
		}
		if (symlinksSupported) {
			const walked = listCodeFiles(tmp);
			assert.ok(!walked.includes(fileLink), "symlinked .ts file must not be followed");
			assert.ok(!walked.some((f) => f === dirLink || f.startsWith(dirLink + sep)), "symlinked directory must not be traversed");
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("strict review and Judgment Day agents do not gain Key Learnings or trailing-prose instruction", () => {
	const strict = strictJsonAgents();
	// A derived list can go empty and pass vacuously, which would assert
	// nothing. Require both strict-output role families to still be covered
	// without pinning an exact count that the next retirement would re-break.
	assert.ok(strict.some((f) => f.startsWith("jd-")), "Judgment Day agents must be covered by this guard");
	assert.ok(strict.some((f) => f.startsWith("review-")), "review lens agents must be covered by this guard");
	const failures: string[] = [];
	for (const file of strict) {
		const source = readFileSync(join(AGENTS, file), "utf8");
		for (const regex of [/Key Learnings/i, /key_learnings/i, /trailing prose/i]) {
			if (regex.test(source)) failures.push(`${file}: ${regex.source}`);
		}
	}
	assert.deepEqual(failures, [], "strict-JSON/ledger agents must remain untouched");
});

test("the canonical Key Learnings heading has no trailing colon in any asset", () => {
	for (const file of sddAgents()) {
		const source = readFileSync(join(AGENTS, file), "utf8");
		assert.match(source, /`## Key Learnings`/, `${file} must reference the canonical heading`);
		assert.doesNotMatch(source, /`## Key Learnings:`/, `${file} must not use a trailing colon`);
	}
	const delegation = readFileSync(join(ASSETS, "orchestrator-delegation.md"), "utf8");
	assert.doesNotMatch(delegation, /`## Key Learnings:`/);
});

test("modified SDD agents are packaged and installed by the existing installer", () => {
	const verifier = readFileSync(join(ROOT, "scripts", "verify-package-files.mjs"), "utf8");
	const expected = [
		"assets/agents/sdd-apply.md", "assets/agents/sdd-archive.md",
		"assets/agents/sdd-design.md", "assets/agents/sdd-explore.md",
		"assets/agents/sdd-init.md", "assets/agents/sdd-onboard.md",
		"assets/agents/sdd-proposal.md", "assets/agents/sdd-research.md",
		"assets/agents/sdd-spec.md", "assets/agents/sdd-status.md",
		"assets/agents/sdd-tasks.md",
		"assets/agents/sdd-verify.md",
	];
	for (const path of expected) {
		assert.match(verifier, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${path} must be in the package verifier`);
	}
});
