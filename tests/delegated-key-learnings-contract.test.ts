import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readDelegationDetail } from "./support/orchestrator-modules.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENTS = join(ROOT, "assets", "agents");
const ASSETS = join(ROOT, "assets");

// Strict-output agents that must remain untouched by Key Learnings: the
// Judgment Day roles (`jd-*`) and the review lens roles (`review-*`). Derived
// from the agents actually on disk rather than hardcoded, so retiring one
// (as #320 did to `review-refuter.md` and `review-validator.md`) cannot break
// this guard with an ENOENT instead of a real assertion.
const STRICT_JSON_PREFIX = /^(jd-|review-)/;

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

function strictJsonAgents(): string[] {
	return agentFiles().filter((f) => STRICT_JSON_PREFIX.test(f));
}

// S8 (harness-continuity T8): the generic mandatory `## Key Learnings` closing
// ritual is retired in favor of memory-owned learning (workers save validated
// facts through Engram when given a project). Neither the delegation modules,
// the full-delegation card, nor the generic agent bodies may instruct it.
const GENERIC_AGENTS = ["gentle-ai-explore.md", "gentle-ai-worker.md", "gentle-ai-verify.md"];

test("S8: the delegation contract no longer instructs a mandatory `## Key Learnings` closing block", () => {
	const delegation = readDelegationDetail();
	assert.equal(readSection(delegation, "Key Learnings closing block"), null, "the Key Learnings closing block section must be retired");
	assert.doesNotMatch(delegation, /Key Learnings/, "no delegation module may instruct the Key Learnings ritual");
	const card = readFileSync(join(ASSETS, "orchestrator-full-delegation-card.md"), "utf8");
	assert.doesNotMatch(card, /Key Learnings/, "the full-delegation card must not carry the ritual");
});

test("S8: generic agents keep their Return contract without the Key Learnings ritual; the worker keeps memory-owned learning", () => {
	for (const file of GENERIC_AGENTS) {
		const source = readFileSync(join(AGENTS, file), "utf8");
		assert.doesNotMatch(source, /Key Learnings/, `${file} must not mention the retired ritual`);
	}
	const worker = readFileSync(join(AGENTS, "gentle-ai-worker.md"), "utf8");
	const memory = readSection(worker, "Memory safety");
	assert.ok(memory, "the worker keeps its Memory safety section");
	assert.match(memory, /Use `mem_save` only when the parent supplies a validated project name/);
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
