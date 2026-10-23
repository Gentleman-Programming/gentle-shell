import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installPackageAssets, type PackageAssetOwner } from "../lib/agent-assets.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SDD_KEYS = [
	...["sync", "apply", "archive", "design", "explore", "init", "onboard", "proposal",
		"remediate", "research", "spec", "status", "tasks", "verify"].map(name => `agents/sdd-${name}.md`),
	"chains/sdd-full.chain.md", "chains/sdd-plan.chain.md", "chains/sdd-verify.chain.md",
	"gentle-ai/support/sdd-status-contract.md",
];
const DELEGATION_KEYS = [
	"agents/gentle-ai-explore.md", "agents/gentle-ai-verify.md", "agents/gentle-ai-worker.md",
	"gentle-ai/support/strict-tdd.md", "gentle-ai/support/strict-tdd-verify.md",
];
const REVIEW_KEYS = [
	"agents/jd-fix-agent.md", "agents/jd-judge-a.md", "agents/jd-judge-b.md",
	"agents/review-readability.md", "agents/review-reliability.md", "agents/review-resilience.md",
	"agents/review-risk.md", "chains/4r-review.chain.md",
];
const RETIRED_REVIEW = ["agents/review-refuter.md", "agents/review-validator.md"];
const OWNER_CASES: { name: string; owners?: PackageAssetOwner[] }[] = [
	{ name: "delegation", owners: ["delegation"] },
	{ name: "review", owners: ["review"] },
	{ name: "all" },
	{ name: "none", owners: [] },
];

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function put(root: string, key: string, content: string): void {
	const path = join(root, key);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function files(root: string, prefix = ""): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
		const key = `${prefix}${entry.name}`;
		return entry.isDirectory() ? files(join(root, entry.name), `${key}/`) : [key];
	}).sort();
}

function manifest(home: string): Record<string, string> {
	return JSON.parse(readFileSync(join(home, "gentle-ai/managed-assets.json"), "utf8")).assets;
}

function withFixture(run: (home: string, project: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "gentle-retired-preservation-"));
	const home = join(root, "home");
	const project = join(root, "project");
	const previous = process.env.GENTLE_PI_AGENT_HOME;
	mkdirSync(home);
	mkdirSync(project);
	try {
		process.env.GENTLE_PI_AGENT_HOME = home;
		run(home, project);
	} finally {
		if (previous === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previous;
	}
}

function selectedKeys(owners?: readonly PackageAssetOwner[]): string[] {
	return [
		...(owners === undefined || owners.includes("delegation") ? DELEGATION_KEYS : []),
		...(owners === undefined || owners.includes("review") ? REVIEW_KEYS : []),
	];
}

for (const force of [false, true]) {
	for (const { name, owners } of OWNER_CASES) {
		test(`preserves SDD files and forgets only SDD ownership: force=${force} owners=${name}`, () => {
			withFixture((home, project) => {
				const assets: Record<string, string> = {};
				const preserved = new Map<string, Buffer>();
				const legacy = readFileSync(join(ROOT, "tests/fixtures/legacy/sdd-research-v2.5.0.md"), "utf8");
				const history = JSON.parse(readFileSync(join(ROOT, "assets/migrations/managed-assets-v2.5.0.json"), "utf8"));
				assert.equal(hash(legacy), history.assets["agents/sdd-research.md"]);
				for (const [index, key] of SDD_KEYS.entries()) {
					const original = key === "agents/sdd-research.md" ? legacy : `Previously managed ${key}\n`;
					const content = key === "agents/sdd-research.md" || index % 2 === 0 ? original : `${original}User edits\n`;
					put(home, key, content);
					assets[key] = hash(original);
					preserved.set(key, Buffer.from(content));
				}
				// This copy has only append-only legacy evidence, not current ownership.
				delete assets["agents/sdd-research.md"];
				assets["agents/sdd-missing.md"] = hash("absent");
				for (const key of ["agents/custom.md", "agents/custom-sdd-notes.md", "gentle-ai/support/custom.md",
					"prompts/sdd-personal.md", "openspec/config.yaml", "subagents/sdd-apply.md"]) {
					const content = `User-owned ${key}\n`;
					put(home, key, content);
					preserved.set(key, Buffer.from(content));
				}
				assets["agents/custom.md"] = hash("User-owned agents/custom.md\n");
				assets["gentle-ai/support/custom.md"] = hash("User-owned gentle-ai/support/custom.md\n");
				assets["agents/custom-sdd-notes.md"] = hash("User-owned agents/custom-sdd-notes.md\n");
				assets["unknown/key"] = hash("unknown ownership stays");
				for (const key of RETIRED_REVIEW) {
					put(home, key, `Previously managed ${key}\n`);
					assets[key] = hash(`Previously managed ${key}\n`);
				}
				put(home, "gentle-ai/managed-assets.json", JSON.stringify({ schemaVersion: 1, assets }));
				for (const key of [".pi/agents/sdd-apply.md", ".pi/chains/sdd-full.chain.md",
					".pi/prompts/sdd-plan.md", "openspec/config.yaml", "openspec/specs/user.md"]) {
					put(project, key, `Project-owned ${key}\n`);
				}
				const projectBefore = files(project).map(key => [key, readFileSync(join(project, key))] as const);
				const beforeFiles = files(home);
				installPackageAssets(project, force, owners);
				for (const [key, bytes] of preserved) {
					assert.equal(existsSync(join(home, key)), true, `${key} must not be deleted`);
					assert.deepEqual(readFileSync(join(home, key)), bytes, key);
				}
				const expected = { ...assets };
				for (const key of [...SDD_KEYS, "agents/sdd-missing.md"]) delete expected[key];
				const reviewSelected = owners === undefined || owners.includes("review");
				for (const key of RETIRED_REVIEW) {
					assert.equal(existsSync(join(home, key)), !reviewSelected, key);
					if (reviewSelected) delete expected[key];
				}
				for (const key of selectedKeys(owners)) {
					const source = readFileSync(join(ROOT, "assets", key.replace(/^gentle-ai\//, "")), "utf8");
					assert.deepEqual(readFileSync(join(home, key)), Buffer.from(source), key);
					expected[key] = hash(source);
				}
				assert.deepEqual(manifest(home), expected);
				assert.deepEqual(files(home), [...new Set([...beforeFiles.filter(key =>
					!reviewSelected || !RETIRED_REVIEW.includes(key)), ...selectedKeys(owners)])].sort());
				assert.deepEqual(files(project).map(key => [key, readFileSync(join(project, key))]), projectBefore);
			});
		});
	}
}

for (const force of [false, true]) {
	test(`fresh installation has no SDD or OpenSpec scaffolding: force=${force}`, () => {
		withFixture((home, project) => {
			installPackageAssets(project, force);
			assert.deepEqual(files(home), [...DELEGATION_KEYS, ...REVIEW_KEYS, "gentle-ai/managed-assets.json"].sort());
			assert.deepEqual(Object.keys(manifest(home)).sort(), [...DELEGATION_KEYS, ...REVIEW_KEYS].sort());
			assert.deepEqual(files(project), []);
		});
	});
}

test("review retirement still requires ownership and preserves edited or unowned actors", () => {
	for (const key of RETIRED_REVIEW) {
		for (const owned of [false, true]) {
			withFixture((home, project) => {
				const content = "User review policy\n";
				put(home, key, content);
				put(home, "gentle-ai/managed-assets.json", JSON.stringify({ schemaVersion: 1,
					assets: owned ? { [key]: hash("Previously managed review\n") } : {} }));
				installPackageAssets(project, true, ["review"]);
				assert.deepEqual(readFileSync(join(home, key)), Buffer.from(content));
				assert.equal(manifest(home)[key], undefined);
			});
		}
	}
});
