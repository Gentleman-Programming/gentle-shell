import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const paths = [
	"assets/sdd-orchestrator-workflow.md",
	"assets/support/sdd-status-contract.md",
];
const documents = paths.map((path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

function routingContract(document: string): string {
	const section = document.match(/## Bounded Planning Routing\n([\s\S]*?)(?=\n## |$)/);
	assert.ok(section, "explicit bounded planning routing contract is required");
	return section[1].trim();
}

for (const [index, path] of paths.entries()) {
	test(`${path}: native planning tokens are the only automatic routes`, () => {
		const contract = routingContract(documents[index]);
		for (const [token, phase] of [["propose", "sdd-proposal"], ["spec", "sdd-spec"], ["design", "sdd-design"], ["tasks", "sdd-tasks"]]) {
			assert.ok(contract.includes(`| \`${token}\` | \`${phase}\` |`));
		}
		assert.match(contract, /only automatic planning routes/i);
		assert.doesNotMatch(contract, /^\| `sdd-(?:propose|spec|design|tasks)`/m);
	});

	test(`${path}: planning preserves native blocker and edit-root guards`, () => {
		const contract = routingContract(documents[index]);
		for (const guard of [
			"stop for ambiguous change selection, unresolved session preflight, or unsafe action context",
			"prove planned writes are within the authoritative workspace or allowed edit roots",
			"workspace-planning without allowed edit roots remains read-only",
			"Planning does not bypass the init guard, optional research guidance, or phase approval requirements",
			"never infer a route from prose",
			"Keep genuine blockers in `blockedReasons` and non-blocking diagnostics in `notes`, never in `nextRecommended`",
			"report them without discarding them to enable a route",
		]) {
			assert.ok(contract.includes(guard), `missing guard: ${guard}`);
		}
	});
}

test("workflow and support contract agree on bounded planning routing", () => {
	assert.equal(routingContract(documents[0]), routingContract(documents[1]));
});
