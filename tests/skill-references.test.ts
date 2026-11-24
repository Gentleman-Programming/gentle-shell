import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "node:test";

// Issue #2909: Pi resolves a skill's relative paths against the skill's own
// directory, so a `## References` entry written from the package root
// (`docs/...`, `skills/...`) sends the agent to a file that does not exist.
const skillsRoot = join(import.meta.dirname, "..", "skills");
const PATH_TOKEN = /^`([\w./-]+\.\w+)`/;

function referencePaths(skill: string): string[] {
	const section = /^## References\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(skill)?.[1] ?? "";
	return section
		.split("\n")
		.map((line) => line.replace(/^\s*-\s*/, ""))
		// Files that live in the user's project, not in the package, cannot resolve here.
		.filter((entry) => !/\bin the project\b/.test(entry))
		.map((entry) => PATH_TOKEN.exec(entry)?.[1])
		.filter((path): path is string => path !== undefined);
}

const skillFiles = readdirSync(skillsRoot, { withFileTypes: true })
	.filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
	.map((entry) => join(skillsRoot, entry.name, "SKILL.md"));

test("every SKILL.md reference resolves relative to its own skill directory", () => {
	const broken = skillFiles.flatMap((file) =>
		referencePaths(readFileSync(file, "utf8"))
			.filter((path) => !existsSync(join(dirname(file), path)))
			.map((path) => `${basename(dirname(file))}/SKILL.md: ${path}`),
	);
	assert.deepEqual(broken, []);
});

test("the reference check sees package-root paths as broken", () => {
	assert.deepEqual(referencePaths("## References\n\n- `docs/skill-style-guide.md` — guide.\n- `gentle-ui-design` skill — not a path.\n"), ["docs/skill-style-guide.md"]);
	assert.equal(existsSync(join(skillsRoot, "skill-improver", "docs/skill-style-guide.md")), false);
});
