import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

// Virtual files only: never read or write the user's real persona configuration.
function withPersonaFiles<T>(
	files: Map<string, string>,
	run: (writes: string[], directories: string[]) => T,
): T {
	const writes: string[] = [];
	const directories: string[] = [];
	const originals = { existsSync: fs.existsSync, readFileSync: fs.readFileSync,
		mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync };
	fs.existsSync = ((path) => files.has(String(path))) as typeof fs.existsSync;
	fs.readFileSync = ((path) => {
		assert.ok(files.has(String(path)), `unexpected read: ${path}`);
		return files.get(String(path));
	}) as typeof fs.readFileSync;
	fs.mkdirSync = ((path) => { directories.push(String(path)); }) as typeof fs.mkdirSync;
	fs.writeFileSync = ((path, data) => {
		writes.push(String(path));
		files.set(String(path), String(data));
	}) as typeof fs.writeFileSync;
	syncBuiltinESMExports();
	const restore = () => { Object.assign(fs, originals); syncBuiltinESMExports(); };
	try {
		const result = run(writes, directories);
		if (result instanceof Promise) return result.finally(restore) as T;
		restore();
		return result;
	} catch (error) { restore(); throw error; }
}

// Measured rendered mapper persona text, excluding boundary newlines. This budget is the
// mapper's own, and PMV10-B grew it on purpose from the 1,237 B of the PMV10-A minimum:
// none of the eight shared budgets in persona-single-channel.test.ts moves with it.
const MAPPER_PERSONA_BYTES = 1919;
const cwd = "/virtual/persona-project";
const projectPath = __testing.projectPersonaConfigPath(cwd);
const globalPath = __testing.personaConfigPath(cwd);

test("persona reader recognizes mapper and preserves unknown-value fallback and precedence", () => {
	const files = new Map([[projectPath, '{"mode":"mapper"}'], [globalPath, '{"mode":"neutral"}']]);
	withPersonaFiles(files, () => {
		assert.equal(__testing.readPersonaFile(projectPath), "mapper");
		assert.equal(__testing.readPersonaMode(cwd), "mapper");
		files.set(projectPath, '{"mode":"unknown"}');
		assert.equal(__testing.readPersonaFile(projectPath), "gentleman");
		assert.equal(__testing.readPersonaMode(cwd), "gentleman");
		// Trap 1 is the reason these four cases exist: a value that is not one of the known
		// modes, a non-string mode, a record without the key, and a non-record all resolve
		// exactly as they did before mapper existed.
		files.set(projectPath, '{"mode":42}');
		assert.equal(__testing.readPersonaFile(projectPath), "gentleman");
		files.set(projectPath, '{}');
		assert.equal(__testing.readPersonaFile(projectPath), "gentleman");
		files.set(projectPath, "not json");
		assert.equal(__testing.readPersonaFile(projectPath), undefined);
		files.set(projectPath, "[]");
		assert.equal(__testing.readPersonaFile(projectPath), undefined);
		files.delete(projectPath);
		assert.equal(__testing.readPersonaMode(cwd), "neutral");
		files.delete(globalPath);
		assert.equal(__testing.readPersonaMode(cwd), "gentleman");
	});
});

test("persona writes create or update only the project override and round trip mapper", () => {
	for (const existing of [false, true]) {
		const globalBytes = '{"mode":"neutral"}\n';
		const files = new Map([[globalPath, globalBytes]]);
		if (existing) files.set(projectPath, '{"mode":"gentleman"}');
		withPersonaFiles(files, (writes, directories) => {
			assert.deepEqual(__testing.writePersonaMode(cwd, "mapper"), [projectPath]);
			assert.deepEqual(writes, [projectPath]);
			assert.deepEqual(directories, [dirname(projectPath)]);
			assert.equal(files.get(globalPath), globalBytes);
			assert.equal(__testing.readPersonaMode(cwd), "mapper");
		});
	}
});

test("persona command offers mapper, reports project scope and next-message activation, rejects other selections", async () => {
	for (const selection of ["mapper", "gentleman", "neutral", "unknown", undefined]) {
		await withPersonaFiles(new Map([[globalPath, '{"mode":"neutral"}']]), async (writes) => {
			const notices: string[] = [];
			const ctx = { cwd, ui: {
				select: async (_title: string, options: string[]) => {
					assert.deepEqual(options, ["gentleman", "neutral", "mapper"]);
					return selection;
				},
				notify: (message: string) => notices.push(message),
			} } as unknown as Parameters<typeof __testing.handlePersonaCommand>[0];
			await __testing.handlePersonaCommand(ctx);
			if (selection === "unknown" || selection === undefined) {
				assert.deepEqual(writes, []);
				assert.deepEqual(notices, []);
			} else {
				assert.deepEqual(writes, [projectPath]);
				assert.equal(notices.length, 1);
				assert.ok(notices[0].includes(projectPath));
				assert.match(notices[0], /next message.*no reload needed/i);
				assert.doesNotMatch(notices[0], /Global config:|Run \/reload/);
			}
		});
	}
});

test("mapper prompt adds its role without replacing identity, ODD or the orchestrator", () => {
	const prompt = __testing.buildGentlePrompt("mapper");
	assert.match(prompt, /Current persona mode: mapper/);
	const personaText = prompt.slice(prompt.indexOf("\nPersona:") + 1, prompt.indexOf("\n\nLanguage:"));
	assert.equal(Buffer.byteLength(personaText), MAPPER_PERSONA_BYTES);
	assert.match(prompt, /Language: natural Rioplatense Spanish with voseo when the user writes Spanish\./);
	for (const clause of [
		"Mapper role:",
		"Your job is this project's map:",
		"neither the user nor the orchestrator has to load the whole project into context",
		"following the FP format",
		"A row carries its functional-point code and what the point is, and nothing else.",
		"The state of a row is the checkbox",
		"the order of their codes",
		"the first pending row in code order",
		"Do not add fields, priority markers, dependency notes, or a second copy of the map.",
		"say what is missing instead of inventing it.",
		"Read the project before you write:",
		"Name the documents you read.",
		"You do not implement source code.",
		"`/gentle:persona`",
		"You add a role; you remove nothing.",
	]) assert.ok(personaText.includes(clause), `missing mapper clause: ${clause}`);
	// The clauses above are asserted against the mapper slice and not against the whole
	// prompt, so none of them can be satisfied by the orchestrator asset or by the ODD
	// workflow instead of by the mapper's own text.
	const gentleman = __testing.buildGentlePrompt("gentleman");
	const identity = gentleman.slice(gentleman.indexOf("You are el Gentleman:"), gentleman.indexOf("\nPersona:"));
	assert.ok(prompt.includes(identity));
	const workflowAndOrchestrator = gentleman.slice(gentleman.indexOf("Default workflow:"));
	assert.ok(prompt.endsWith(workflowAndOrchestrator));
	assert.ok(prompt.includes(__testing.getOrchestratorPrompt(cwd)));
	assert.doesNotMatch(prompt, /Do NOT use voseo/);
	assert.equal((prompt.match(/Always respond in the same language the user writes in\./g) ?? []).length, 1);
});
