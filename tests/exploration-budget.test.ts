import assert from "node:assert/strict";
import test from "node:test";
import { createExplorationBudget } from "../lib/exploration-budget.ts";

const event = (id: string, toolName = "read", text = "x", isError = false, input: Record<string, unknown> = {}, details?: unknown) => ({
	toolCallId: id, toolName, isError, input, details, content: [{ type: "text" as const, text }],
});

test("cumulative successful lookups cross at four and notify only once", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	for (let i = 1; i <= 3; i++) {
		budget.call("s", String(i));
		assert.equal(budget.result("s", event(String(i))), undefined);
	}
	budget.call("s", "4");
	const notice = budget.result("s", event("4"));
	assert.match(notice ?? "", /Exploration budget:.*4.*4.*bytes/);
	assert.match(notice ?? "", /one configured explorer/i);
	assert.match(notice ?? "", /read.only.*initially small/i);
	assert.match(notice ?? "", /preparation.*already.understood.*authorized inline write/i);
	assert.match(notice ?? "", /no.*mutation.*guard.*bypass/i);
	budget.call("s", "5");
	assert.equal(budget.result("s", event("5")), undefined);
});

test("UTF-8 text bytes cross strictly above 40000 and duplicate IDs do not count", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	budget.call("s", "1");
	assert.equal(budget.result("s", event("1", "grep", "é".repeat(20000))), undefined);
	assert.equal(budget.result("s", event("1", "grep", "x")), undefined);
	budget.call("s", "2");
	assert.match(budget.result("s", event("2", "find", "x")) ?? "", /40,?001.*bytes/);
});

test("ignore child, aborted, non-discovery, error, stale and duplicate results across requests", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	budget.call("s", "old");
	budget.start("s");
	assert.equal(budget.result("s", event("old")), undefined);
	for (const [id, name, error, primary, aborted] of [
		["child", "read", false, false, false], ["aborted", "read", false, true, true],
		["failed", "read", true, true, false], ["review", "gentle_review", false, true, false],
		["write", "write", false, true, false], ["bash", "bash", false, true, false],
	] as const) {
		budget.call("s", id);
		assert.equal(budget.result("s", event(id, name, "x".repeat(50000), error), primary, aborted), undefined);
	}
	for (const [i, name] of ["read", "grep", "find", "ls"].entries()) {
		budget.call("s", `new${i}`);
		const notice = budget.result("s", event(`new${i}`, name));
		if (i < 3) assert.equal(notice, undefined);
		else assert.match(notice ?? "", /Exploration budget:/);
	}
	budget.settle("s");
	budget.call("s", "late");
	assert.equal(budget.result("s", event("late")), undefined);
	budget.start("s");
	budget.call("s", "fresh");
	assert.equal(budget.result("s", event("fresh")), undefined);
});

test("known shell inspections reuse phase inference without counting checks, writes or unknown scripts", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	for (const command of ["node --test example.test.ts", "pnpm build", "cat src/a > out", "unknown-script arg"]) {
		budget.call("s", command, "bash");
		assert.equal(budget.result("s", event(command, "bash", "x".repeat(50000), false, { command })), undefined);
	}
	for (const [i, [name, command]] of [["bash", "pwd"], ["bash", "cd src && rg needle ."], ["bash", "git status"], ["powershell", "git diff"]].entries()) {
		budget.call("s", String(i), name);
		const notice = budget.result("s", event(String(i), name, "x", false, { command }));
		if (i < 3) assert.equal(notice, undefined);
		else assert.match(notice ?? "", /Exploration budget:.*4 tracked lookups.*4 UTF-8/);
	}
});

test("read-only memory recall counts and memory mutation or diagnostics never count", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	for (const name of ["mem_current_project", "mem_stats", "mem_save", "mem_update", "mem_review"]) {
		budget.call("s", name);
		assert.equal(budget.result("s", event(name, name, "x".repeat(50000))), undefined);
	}
	for (const [i, name] of ["mem_search", "mem_get_observation", "mem_context", "read"].entries()) {
		budget.call("s", name);
		const notice = budget.result("s", event(name, name));
		if (i < 3) assert.equal(notice, undefined);
		else assert.match(notice ?? "", /Exploration budget:.*4 tracked lookups/);
	}
});

test("nested reads inside review, mutation or verification are not discovery", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	for (const [i, name] of ["gentle_review", "write", "verification"].entries()) {
		const parent = `p${i}`;
		budget.call("s", parent, name);
		budget.call("s", `${parent}/1`, "read", parent);
		assert.equal(budget.result("s", { ...event(`${parent}/1`, "read", "x".repeat(50000)), parentToolCallId: parent }), undefined);
	}
});

test("codegraph query and explore count but init and failed fallbacks do not", () => {
	const budget = createExplorationBudget();
	budget.start("s");
	for (const [id, input, details] of [
		["init", { operation: "init" }, undefined],
		["failed", { operation: "query" }, { status: "failed" }],
		["unavailable", { operation: "explore" }, { status: "unavailable" }],
	] as const) {
		budget.call("s", id);
		assert.equal(budget.result("s", event(id, "codegraph", "x".repeat(50000), false, input, details)), undefined);
	}
	const calls = [
		event("1", "codegraph", "x", false, { operation: "query" }),
		event("2", "codegraph", "x", false, { operation: "explore" }),
		event("3", "codegraph_query"), event("4", "codegraph_explore"),
	];
	for (const [i, item] of calls.entries()) {
		budget.call("s", item.toolCallId);
		const result = budget.result("s", item);
		if (i === 3) assert.match(result ?? "", /Exploration budget:/);
		else assert.equal(result, undefined);
	}
});
