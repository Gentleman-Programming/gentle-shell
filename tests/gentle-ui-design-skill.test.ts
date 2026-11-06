import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { requiredPaths } from "../scripts/verify-package-files.mjs";

const root = resolve(import.meta.dirname, "..");
const skillDir = join(root, "skills/gentle-ui-design");
const references = [
	"references/task-and-content.md",
	"references/browse-and-compare.md",
	"references/composition-and-feedback.md",
	"references/adaptive-interfaces.md",
];
const read = (path: string) => readFileSync(join(skillDir, path), "utf8");

test("product design skill is discoverable and distinct from existing workflows", () => {
	const skill = read("SKILL.md");
	assert.match(skill, /^---\nname: gentle-ui-design\ndescription: "Trigger: [^\n]+"\nlicense: Apache-2\.0\nmetadata:\n  author: gentleman-programming\n  version: "1\.0"\n---/);
	for (const section of ["Activation Contract", "Hard Rules", "Decision Gates", "Execution Steps", "Output Contract", "References"]) {
		assert.match(skill, new RegExp(`^## ${section}$`, "m"));
	}
	assert.match(skill, /gentle-design/);
	assert.match(skill, /gentle-ai-tui-design/);
	assert.match(skill, /read.only/i);
	const names = readdirSync(join(root, "skills"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, "skills", entry.name, "SKILL.md")))
		.map((entry) => readFileSync(join(root, "skills", entry.name, "SKILL.md"), "utf8").match(/^name: (.+)$/m)?.[1]);
	assert.equal(names.filter((name) => name === "gentle-ui-design").length, 1);
});

test("the skill loads its bundled guidance through local links", () => {
	const links = [...read("SKILL.md").matchAll(/`(references\/[^`]+\.md)`/g)].map((match) => match[1]);
	assert.deepEqual(new Set(links), new Set(references));
	for (const path of ["SKILL.md", ...references]) {
		assert.ok(requiredPaths.includes(`skills/gentle-ui-design/${path}`), `${path} must be required`);
		assert.ok(statSync(join(skillDir, path)).isFile());
		assert.equal(statSync(join(skillDir, path)).mode & 0o111, 0, `${path} must not be executable`);
	}
});

test("the package contains only the skill and its four guidance documents", () => {
	const files = readdirSync(skillDir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(skillDir.length + 1));
	assert.deepEqual(files.sort(), ["SKILL.md", ...references].sort());
});

test("guidance covers product tasks, browsing, presentation and adaptation", () => {
	const all = ["SKILL.md", ...references].map(read).join("\n");
	for (const topic of [/task/i, /search/i, /filter/i, /result/i, /keyboard/i, /focus/i, /contrast/i, /loading/i, /error/i, /motion/i]) assert.match(all, topic);
});

test("shell documentation exposes the skill without changing existing design workflows", () => {
	const docs = readFileSync(join(root, "docs/gentle-shell.md"), "utf8");
	assert.match(docs, /\/skill:gentle-ui-design/);
	assert.match(docs, /gentle-design/);
	assert.match(docs, /gentle-ai-tui-design/);
});
