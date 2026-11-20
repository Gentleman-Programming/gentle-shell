import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChildContextExtension } from "../extensions/child-context.ts";
import { CHILD_SKILLS_CATALOG_ENV } from "../lib/agents-runner.ts";

// The runner marks the children of gentle-ai-worker, gentle-ai-explore and
// gentle-ai-verify: their parent injects exact skill paths, so the hook empties
// Pi's skills list and the `<available_skills>` section is never sent.
type BeforeAgentStart = (event: unknown, ctx: unknown) => unknown;

function beforeAgentStart(env: NodeJS.ProcessEnv): BeforeAgentStart {
	let handler: BeforeAgentStart | undefined;
	const pi = { on(name: string, fn: BeforeAgentStart) { if (name === "before_agent_start") handler = fn; } } as unknown as ExtensionAPI;
	createChildContextExtension(env)(pi);
	return handler!;
}

function event() {
	const skills = [{ name: "gentle-ai", filePath: "/pkg/skills/gentle-ai/SKILL.md" }, { name: "user-skill", filePath: "/home/u/.agents/skills/user-skill/SKILL.md" }];
	const contextFiles = [{ path: "/repo/AGENTS.md", content: "# Plain\n" }];
	return { systemPrompt: "base", systemPromptOptions: { appendSystemPrompt: "", contextFiles, skills } };
}

for (const agent of ["gentle-ai-worker", "gentle-ai-explore", "gentle-ai-verify"]) {
	test(`a marked ${agent} child sends no skills catalog`, async () => {
		const handler = beforeAgentStart({ GENTLE_PI_AGENTS_CHILD: "1", [CHILD_SKILLS_CATALOG_ENV]: "1" });
		const e = event();
		const skills = e.systemPromptOptions.skills;
		assert.equal(await handler(e, {}), undefined);
		assert.equal(e.systemPromptOptions.skills, skills, "the same list is emptied in place");
		assert.deepEqual(e.systemPromptOptions.skills, []);
		assert.deepEqual(e.systemPromptOptions.contextFiles.map(file => file.content), ["# Plain\n"], "context files are untouched");
	});
}

test("an unmarked child (any other agent) keeps its skills catalog", async () => {
	const e = event();
	await beforeAgentStart({ GENTLE_PI_AGENTS_CHILD: "1" })(e, {});
	assert.deepEqual(e.systemPromptOptions.skills.map(skill => skill.name), ["gentle-ai", "user-skill"]);
});

test("a primary session keeps its skills catalog even with a stray marker", async () => {
	for (const env of [{ [CHILD_SKILLS_CATALOG_ENV]: "1" }, { GENTLE_PI_AGENTS_CHILD: "0", [CHILD_SKILLS_CATALOG_ENV]: "1" }]) {
		const e = event();
		await beforeAgentStart(env)(e, {});
		assert.deepEqual(e.systemPromptOptions.skills.map(skill => skill.name), ["gentle-ai", "user-skill"]);
	}
});

test("the skills hook never throws on missing or malformed options", async () => {
	const handler = beforeAgentStart({ GENTLE_PI_AGENTS_CHILD: "1", [CHILD_SKILLS_CATALOG_ENV]: "1" });
	for (const e of [undefined, {}, { systemPromptOptions: null }, { systemPromptOptions: { skills: "x" } }]) {
		await assert.doesNotReject(async () => handler(e, {}));
	}
});
