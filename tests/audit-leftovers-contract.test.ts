import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// cost-speed-painpoints S15 P7, task P15: two deferred audit leftovers.
// Unit A narrows the rdd-defect-workflow trigger to fixing RDD itself.
// Unit B removes the unread skills/_shared/review-ledger-contract.md.

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

// Byte length of the description value before P15 (the frontmatter string, quotes excluded).
const PREVIOUS_RDD_DESCRIPTION_BYTES = 160;

function rddDescription(): string {
	const line = read("skills/rdd-defect-workflow/SKILL.md").split("\n").find((entry) => entry.startsWith("description:")) ?? "";
	assert.match(line, /^description: "[^"\n]+"$/, "the description stays one quoted physical line");
	return JSON.parse(line.slice("description: ".length)) as string;
}

test("Unit A: the rdd-defect-workflow trigger fires on fixing RDD defects, not on using RDD", () => {
	const description = rddDescription();
	assert.ok(description.startsWith("Trigger: "), "the Trigger: prefix stays");
	assert.doesNotMatch(description, /^Trigger: RDD, receipt-driven development/, "a bare mention of RDD must not trigger the skill");
	assert.match(description, /fixing RDD defects/);
	for (const scope of ["review authority", "receipts/lineage", "correction/recovery", "delivery gate"]) {
		assert.ok(description.includes(scope), `the defect scope keeps "${scope}"`);
	}
	assert.match(description, /Not for using or toggling RDD\./);
	const bytes = Buffer.byteLength(description, "utf8");
	assert.ok(bytes <= PREVIOUS_RDD_DESCRIPTION_BYTES, `description is ${bytes} B, over the previous ${PREVIOUS_RDD_DESCRIPTION_BYTES} B`);
});

const DELETED = "skills/_shared/review-ledger-contract.md";

function filesUnder(directory: string): string[] {
	const absolute = join(root, directory);
	if (!existsSync(absolute)) return [];
	if (statSync(absolute).isFile()) return [directory];
	return readdirSync(absolute).flatMap((entry) => (entry === "node_modules" ? [] : filesUnder(`${directory}/${entry}`)));
}

test("Unit B: the unread review ledger contract is gone and nothing names it", () => {
	assert.ok(!existsSync(join(root, DELETED)), `${DELETED} must be deleted`);
	assert.ok(!existsSync(join(root, "skills/_shared")), "the emptied skills/_shared directory must be deleted");
	const naming = ["lib", "extensions", "assets", "skills", "agents", "prompts", "docs", "scripts"]
		.flatMap(filesUnder)
		.filter((path) => read(path).includes("review-ledger-contract.md"));
	assert.deepEqual(naming, [], `files still name ${DELETED}`);
});
