import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { imageFallback, visibleWidth } from "@earendil-works/pi-tui";
import { cardBody, cardHint, cardTitle, cardTone } from "./gentle-card-text.ts";
import { CARD_STYLE, cardStyle, setCardStyle } from "../lib/shell-card.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { CARD_CONTENT, cardContent, setCardContent } from "../lib/card-content-policy.ts";
import piPretty from "../extensions/pi-pretty.ts";
import productionQuietTools, {
	createQuietToolRenderer,
	countNonEmptyLines,
	extractTextContent,
	formatToolResultOutput,
	gentleAiRoutineCommand,
	tailLines,
} from "../extensions/quiet-tools.ts";

const passthroughTheme = {
	bold(value: string) {
		return value;
	},
	fg(_color: string, value: string) {
		return value;
	},
};

initTheme("dark");

const statusTheme = {
	bold(value: string) {
		return value;
	},
	fg(color: string, value: string) {
		return `<${color}>${value}</${color}>`;
	},
};

function routineRenderContext(overrides: Record<string, unknown> = {}) {
	return {
		args: {},
		toolCallId: "tool-call",
		invalidate() {},
		lastComponent: undefined,
		cwd: "/repo",
		executionStarted: false,
		argsComplete: true,
		isPartial: true,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

// Content assertions read the quiet tool card content: the top rule becomes its
// call text (glyph, fill, and hint dropped), sides are stripped, and the closing
// rule is dropped. Gentle AI cards keep their raw frame for the card-text
// helpers, and the quiet card tests assert the raw frame via frameLines.
// Legacy bash argument assertions drop its new identity prefix here; distinct
// tool identity is asserted separately against the actual unmodified frame.
// A pending call's `running…` row is frame chrome too, asserted separately.
const TAG = "(?:</?[a-zA-Z]+>)*";
const CARD_TOP = new RegExp(`^${TAG}╭─ ${TAG}[✿≡$⌕⌖☷✎+]${TAG} (.*?) ${TAG}─+${TAG}(?: .*? )?${TAG}╮${TAG}$`);
const CARD_SIDE = new RegExp(`^${TAG}│${TAG} (.*) ${TAG}│${TAG}$`);
const CARD_BOTTOM = new RegExp(`^${TAG}╰${TAG}─*${TAG}╯${TAG}$`);

function frameLines(component: { render(width: number): string[] }, width = 120): string[] {
	return component.render(width).map((line) => line.trimEnd());
}

const QUIET_CARD_COMPONENTS = new Set(["ToolCardTop", "ToolCardBody"]);

function renderLines(component: { render(width: number): string[] }, width = 120): string[] {
	if (!QUIET_CARD_COMPONENTS.has(component.constructor.name)) return component.render(width).map((line) => line.trimEnd());
	const call = component.constructor.name === "ToolCardTop";
	return component.render(width).flatMap((line) => {
		if (CARD_BOTTOM.test(line)) return [];
		const top = CARD_TOP.exec(line);
		if (top) return [top[1]!.replace(/^(?:<[^>]+>)*bash(?:<[^>]+>)* /, "").trimEnd()];
		const side = CARD_SIDE.exec(line);
		const text = (side ? side[1]! : line).trimEnd();
		return call && side && text.replace(/<\/?[a-zA-Z]+>/g, "") === "running…" ? [] : [text];
	});
}

function renderToString(component: { render(width: number): string[] }, width = 120): string {
	return renderLines(component, width).join("\n");
}

function textResult(text: string, details?: unknown) {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function createPi(options: { throwOnToolConflict?: boolean } = {}) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const hooks = new Map<string, any[]>();
	return {
		tools,
		hooks,
		pi: {
			registerTool(tool: any) {
				if (options.throwOnToolConflict && tools.has(tool.name)) {
					throw new Error(`Tool ${tool.name} already registered`);
				}
				tools.set(tool.name, tool);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			on(name: string, handler: any) {
				hooks.set(name, [...(hooks.get(name) ?? []), handler]);
			},
		},
	};
}

function createSdkTool(name: string) {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: { type: "object", properties: {} },
		execute: async () => textResult(`${name} result`),
	};
}

const fakePiPrettyDeps = {
	sdk: {
		createReadTool: () => createSdkTool("read"),
		createBashTool: () => createSdkTool("bash"),
		createLsTool: () => createSdkTool("ls"),
		createFindTool: () => createSdkTool("find"),
		createGrepTool: () => createSdkTool("grep"),
	},
};

function withEnv<T>(updates: Record<string, string | undefined>, run: () => T): T {
	const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
	try {
		for (const [key, value] of Object.entries(updates)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function withEnvAsync<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, process.env[key]]));
	try {
		for (const [key, value] of Object.entries(updates)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		return await run();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

// Standalone rendering-only fixture for historical Bash formatting contracts.
// No executor, shellPath, or claim of production native-Bash UI parity.
function quietTools(pi: any, resolveOverride?: any) {
	productionQuietTools(pi, resolveOverride);
	if (process.env.GENTLE_PI_QUIET_TOOLS !== "0") {
		pi.registerTool({ name: "bash", ...createQuietToolRenderer("bash", resolveOverride) });
	}
}

function registeredQuietTools() {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	return tools;
}

function registeredQuietToolsWithResolver(resolveOverride: () => unknown) {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any, resolveOverride as any));
	return tools;
}

function renderToolResult(tool: any, result: any, options: any, context: Record<string, unknown> = {}): string {
	return renderToString(tool.renderResult(result, options, passthroughTheme, context));
}

function assertGenericBash(tool: any, command: string): void {
	const call = renderToString(tool.renderCall({ command }, passthroughTheme, { args: { command } }));
	const output = renderToolResult(tool, textResult("original command output"), { expanded: true, isPartial: false }, { args: { command } });
	assert.equal(call.trimEnd(), `$ ${command}`, command);
	assert.doesNotMatch(call, /🌹/);
	assert.match(output, /original command output/);
}

test("quiet tools register six overrides and codemode, never Bash", () => {
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => {
		const { pi, tools } = createPi();

		productionQuietTools(pi as any);

		assert.equal(tools.has("bash"), false);
		for (const toolName of ["read", "grep", "find", "ls", "edit", "write", "codemode"]) {
			const tool = tools.get(toolName);
			assert.ok(tool, `missing quiet renderer for ${toolName}`);
			assert.equal(tool.renderShell, "self", `${toolName} must opt out of Pi's painted Box`);
			assert.equal(typeof tool.execute, "function", `${toolName} must delegate execution`);
			assert.ok(tool.parameters, `${toolName} must preserve built-in parameters`);
		}
	});
});

test("quiet tools never replace an existing native Bash tool", () => {
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => {
		const { pi, tools } = createPi({ throwOnToolConflict: true });
		const native = createSdkTool("bash");
		pi.registerTool(native);
		productionQuietTools(pi as any);
		assert.strictEqual(tools.get("bash"), native);
	});
});

// Actual configured Bash execution is covered in quiet-bash-runtime.test.ts.

test("standalone Bash rendering fixture does not interpret shellPath", () => {
	const tool = registeredQuietTools().get("bash");
	const render = (context: Record<string, unknown> = {}) => renderToString(tool.renderCall({ command: "printf output" }, passthroughTheme, routineRenderContext(context)));
	const configured = render({ shellPath: "/configured/bash" });
	assert.equal(configured, render());
	assert.doesNotMatch(configured, /shellPath|configured\/bash/);
});

test("quiet tool rendering can be disabled by env", () => {
	withEnv({ GENTLE_PI_QUIET_TOOLS: "0" }, () => {
		const { pi, tools } = createPi();

		productionQuietTools(pi as any);

		assert.equal(tools.size, 0);
	});
});

test("pi-pretty suppresses overlapping tools before quiet tools register", async () => {
	await withEnvAsync(
		{ GENTLE_PI_AGENTS_CHILD: undefined, GENTLE_PI_QUIET_TOOLS: undefined, PRETTY_DISABLE_TOOLS: "multi_grep" },
		async () => {
			const { pi, tools } = createPi({ throwOnToolConflict: true });

			await piPretty(pi as any, fakePiPrettyDeps as any);
			productionQuietTools(pi as any);

			assert.equal(tools.has("bash"), false);
			for (const toolName of ["read", "grep", "find", "ls", "edit", "write"]) {
				assert.ok(tools.has(toolName), `missing quiet tool ${toolName}`);
			}
			assert.equal(process.env.PRETTY_DISABLE_TOOLS, "multi_grep,read,bash,ls,find,grep");
		},
	);
});

test("pi-pretty preserves byte-exact model-visible read results when quiet tools suppress its renderer", async () => {
	await withEnvAsync(
		{ GENTLE_PI_AGENTS_CHILD: undefined, GENTLE_PI_QUIET_TOOLS: undefined, PRETTY_DISABLE_TOOLS: undefined },
		async () => {
			const { pi, hooks } = createPi();
			await piPretty(pi as any, fakePiPrettyDeps as any);

			const original = "[alpha]\ntarget=old\n\n[beta]\ntarget=old\n";
			let event: any = {
				toolName: "read",
				content: [{ type: "text", text: original }],
			};
			for (const handler of hooks.get("tool_result") ?? []) {
				const replacement = await handler(event, {});
				if (replacement) event = { ...event, ...replacement };
			}

			assert.equal(event.content[0]?.text, original);
		},
	);
});

test("pi-pretty suppression is skipped when quiet tools are disabled", async () => {
	await withEnvAsync(
		{
			GENTLE_PI_AGENTS_CHILD: undefined,
			GENTLE_PI_QUIET_TOOLS: "0",
			PRETTY_DISABLE_TOOLS: undefined,
			PRETTY_ENABLE_TOOLS: "ls",
		},
		async () => {
			const { pi, tools } = createPi();

			await piPretty(pi as any, fakePiPrettyDeps as any);
			quietTools(pi as any);

			for (const toolName of ["read", "bash", "grep", "find", "ls"]) {
				assert.ok(tools.has(toolName), `pi-pretty should keep ${toolName} when quiet tools are disabled`);
			}
			assert.equal(process.env.PRETTY_DISABLE_TOOLS, undefined);
		},
	);
});

test("quiet tool rendering uses bounded previews while preserving search summaries", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));

	const read = renderToString(
		tools.get("read").renderResult(textResult("first line\nsecond line"), { expanded: false, isPartial: false }, passthroughTheme, {}),
	);
	const bash = renderToString(
		tools.get("bash").renderResult(textResult("stdout line\nstderr line"), { expanded: false, isPartial: false }, passthroughTheme, { args: { command: "printf output" } }),
	);
	assert.match(read, /first line\nsecond line/);
	assert.match(bash, /stdout line\nstderr line/);
	// The expand key rides the call card's top rule, never the result body.
	const configuredHint = keyHint("app.tools.expand", "to expand");
	assert.ok(!read.includes(configuredHint));
	assert.ok(!bash.includes(configuredHint));

	for (const [tool, text, label] of [
		["grep", "src/a.ts:1:match\nsrc/b.ts:2:match", "2 matches"],
		["find", "src/a.ts\nsrc/b.ts", "2 files"],
		["ls", "file-a.ts\nfile-b.ts", "2 entries"],
	] as const) {
		const collapsed = renderToString(
			tools.get(tool).renderResult(textResult(text), { expanded: false, isPartial: false }, passthroughTheme, {}),
		);
		const expanded = renderToString(
			tools.get(tool).renderResult(textResult(text), { expanded: true, isPartial: false }, passthroughTheme, {}),
		);
		assert.match(collapsed, new RegExp(label));
		assert.match(collapsed, /src\/a\.ts|file-a\.ts/);
		assert.match(expanded, new RegExp(text.split("\n")[1]!));
	}
});

test("quiet tool rendering keeps compact collapsed summaries for search and listing tools", () => {
	assert.equal(countNonEmptyLines("a\n\n b \n"), 2);
	assert.equal(extractTextContent(textResult("alpha\nbeta") as any), "alpha\nbeta");
	assert.equal(formatToolResultOutput("grep", textResult("a\nb\n") as any, { expanded: false }), " → 2 matches");
	assert.equal(formatToolResultOutput("find", textResult("a\nb\n") as any, { expanded: false }), " → 2 files");
	assert.equal(formatToolResultOutput("ls", textResult("a\nb\n") as any, { expanded: false }), " → 2 entries");
	assert.equal(formatToolResultOutput("grep", textResult("No matches found") as any, { expanded: false }), "");
	assert.equal(formatToolResultOutput("find", textResult("No files found matching pattern") as any, { expanded: false }), "");
	assert.equal(formatToolResultOutput("ls", textResult("Directory is empty") as any, { expanded: false }), "");
	assert.equal(formatToolResultOutput("read", textResult("a\nb\n") as any, { expanded: false }), "\na\nb");
	assert.equal(formatToolResultOutput("bash", textResult("a\nb\n") as any, { expanded: false }), "\na\nb");
	assert.equal(formatToolResultOutput("bash", textResult("a\nb\n") as any, { expanded: false, args: { command: "git diff" } }), "\na\nb\n");
	assert.equal(formatToolResultOutput("bash", textResult("a\nb\n") as any, { expanded: false, args: { command: "git -C repo status" } }), "\na\nb\n");
	assert.equal(formatToolResultOutput("bash", textResult("a\nb\n") as any, { expanded: false, args: { command: "echo git diff" } }), "\na\nb");
	assert.equal(formatToolResultOutput("edit", textResult("updated") as any, { expanded: false }), "\n✓ applied");
	assert.equal(formatToolResultOutput("write", textResult("wrote") as any, { expanded: false }), "\n✓ written");
	assert.equal(formatToolResultOutput("grep", textResult("a\nb\n") as any, { expanded: true }), "\na\nb\n");
	assert.equal(formatToolResultOutput("read", textResult("ENOENT: missing file") as any, { expanded: false, isError: true }), "\nENOENT: missing file");
});

test("quiet search and placeholder summaries preserve exact-result behavior", async (t) => {
	const grepRows = [["one", 12, "first"], ["two", 20, "second"], ["three", 28, "third"], ["four", 36, "fourth"], ["five", 44, "fifth"]] as const;
	const contextText = grepRows.flatMap(([file, line, ordinal]) => [
		`src/${file}.ts:${line}: ${ordinal} match`,
		`src/${file}.ts-${line - 1}- context before`,
		`src/${file}.ts-${line + 1}- context after`,
	]).join("\n");
	assert.deepEqual([grepRows.length, contextText.split("\n").length, contextText.split("\n").filter((line) => /:\d+:/.test(line)).length, contextText.split("\n").filter((line) => /-\d+-/.test(line)).length], [5, 15, 5, 10]);

	const lsCollisionText = "(empty directory)\nreal-entry.txt";
	const bashCollisionText = "(no output)\nreal output";
	const tools = registeredQuietTools();
	const hint = keyHint("app.tools.expand", "to expand");
	const cases = [
		["grep", "context rows count only match rows", "grep", contextText, { context: 1 }, " → 5 matches", undefined, /5 matches[\s\S]*first match/, /15 matches/, 1],
		["grep", "no-context output counts every non-empty row", "grep", "src/a.ts:1:match\nsrc/b.ts:2:match", {}, " → 2 matches", undefined, /2 matches/, undefined, 1],
		["exact", "current empty-directory marker", "ls", "(empty directory)", {}, "", undefined, /^$/, /entries|to expand/, 0],
		["exact", "legacy empty-directory marker", "ls", "Directory is empty", {}, "", undefined, /^$/, /entries|to expand/, 0],
		["exact", "no-output marker", "bash", "(no output)", { command: "true" }, "\n(no output)", undefined, /^\(no output\)$/, /to expand/, 0],
		["collision", "empty-directory marker with a real entry", "ls", lsCollisionText, {}, " → 2 entries", `\n${lsCollisionText}`, /2 entries[\s\S]*real-entry\.txt/, undefined, 1],
		["collision", "no-output marker with real output", "bash", bashCollisionText, { command: "printf output" }, `\n${bashCollisionText}`, `\n${bashCollisionText}`, /\(no output\)\nreal output/, undefined, 1],
	] as const;
	assert.equal(cases.length, 7);

	const assertSummaryCase = (current: (typeof cases)[number]) => {
		const [, name, toolName, text, args, collapsed, expanded, rendered, forbidden] = current;
		const result = textResult(text) as any;
		const tool = tools.get(toolName);
		assert.ok(tool, `${name}: missing ${toolName} renderer`);
		assert.equal(formatToolResultOutput(toolName, result, { expanded: false, args }), collapsed, name);
		if (expanded !== undefined) assert.equal(formatToolResultOutput(toolName, result, { expanded: true, args }), expanded, `${name} expanded output`);
		const output = renderToolResult(tool, result, { expanded: false, isPartial: false }, { args });
		assert.match(output, rendered, name);
		if (forbidden) assert.doesNotMatch(output, forbidden, name);
		assert.equal(output.split(hint).length - 1, 0, `${name}: the expand key rides the call card, not the result`);
	};

	for (const [section, count] of [["grep", 2], ["exact", 3], ["collision", 2]] as const) await t.test(section, () => {
		const selected = cases.filter(([currentSection]) => currentSection === section);
		assert.equal(selected.length, count, `${section}: case count`);
		for (const current of selected) assertSummaryCase(current);
	});
});

test("quiet Bash errors preserve meaningful rows for both public output orderings", () => {
	const tool = registeredQuietTools().get("bash");
	const hint = keyHint("app.tools.expand", "to expand");
	const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
	const cases = [
		["Pi session event", [
			["    B3 stdout before failure", []],
			["    B3 stderr detail that should require expansion", ["    ", "    "]],
			["    Command exited with code 7", []],
		]],
		["registered execution probe", [
			["probe stdout before failure", ["", ""]],
			["probe stderr detail \x1b[31mwith terminal color\x1b[0m", ["", ""]],
			["probe exit status: 7", []],
		]],
	] satisfies ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, readonly string[]]>]>;
	assert.equal(cases.length, 2);
	const args = { command: "false" };
	const renderResult = (result: any, expanded: boolean) => tool.renderResult(result, { expanded, isPartial: false, isError: true }, passthroughTheme, { args, isError: true });

	for (const [name, rows] of cases) {
		assert.equal(rows.length, 3, `${name}: three meaningful source rows`);
		const text = rows.flatMap(([row, gaps]) => [row, ...gaps]).join("\n");
		const previewRows = rows.map(([row]) => stripAnsi(row));
		assert.ok(previewRows.every((row) => row.trim().length > 0), `${name}: preview rows are meaningful`);
		const expandedText = stripAnsi(text);
		const renderedExpandedText = expandedText.split("\n").map((line) => line.trimEnd()).join("\n");
		const result = textResult(text) as any;
		assert.equal(formatToolResultOutput("bash", result, { expanded: false, isError: true, args }), `\n${previewRows.join("\n")}`, name);
		assert.equal(formatToolResultOutput("bash", result, { expanded: true, isError: true, args }), `\n${expandedText}`, `${name} expanded output`);

		const collapsedLines = renderLines(renderResult(result, false), 120);
		assert.ok(collapsedLines.length <= 4, `${name}: expected at most 4 visual rows, got ${collapsedLines.length}`);
		assert.deepEqual(collapsedLines.slice(0, 3), previewRows, `${name}: preview rows`);
		assert.equal(collapsedLines.filter((line) => line.trim().length === 0).length, 0, `${name}: no blank preview rows`);
		assert.equal(collapsedLines.filter((line) => line.includes(hint)).length, 0, `${name}: the expand key rides the call card`);
		const expanded = renderToString(renderResult(result, true), 1000);
		assert.equal(expanded, renderedExpandedText, `${name}: complete expanded sanitized text`);
		assert.doesNotMatch(expanded, /\x1b\[/, `${name}: expanded output is ANSI-free`);
	}
});

test("quiet Bash normalizes compact JSON for bounded previews while keeping expanded text complete", () => {
	const compactJson = JSON.stringify({
		schema: "review",
		contract: "compact",
		nested: { longTail: "this must stay out of the collapsed preview", deeper: { value: true } },
	});
	const result = textResult(compactJson) as any;
	const commandArgs = { command: "printf json" };
	const previewRows = [
		'  "schema": "review",',
		'  "contract": "compact",',
		'  "nested": {',
	];
	const expectedPreview = `\n${previewRows.join("\n")}`;
	const tool = registeredQuietTools().get("bash");

	assert.equal(formatToolResultOutput("bash", result, { expanded: false, args: commandArgs }), expectedPreview);
	assert.equal(formatToolResultOutput("bash", result, { expanded: true, args: commandArgs }), `\n${compactJson}`);

	const collapsedLines = renderLines(tool.renderResult(result, { expanded: false, isPartial: false }, passthroughTheme, { args: commandArgs }), 120);
	const collapsed = collapsedLines.join("\n");
	assert.equal(previewRows.length, 3);
	assert.ok(collapsedLines.length <= 4, `expected at most 4 visual rows, got ${collapsedLines.length}`);
	assert.deepEqual(collapsedLines.slice(0, 3), previewRows);
	assert.equal(collapsedLines.filter((line) => line.includes(keyHint("app.tools.expand", "to expand"))).length, 0);
	assert.doesNotMatch(collapsed, /longTail|this must stay out of the collapsed preview|deeper/);

	const expanded = renderToString(tool.renderResult(result, { expanded: true, isPartial: false }, passthroughTheme, { args: commandArgs }), 1000);
	assert.equal(expanded, compactJson);
});

test("retired SDD commands use generic bash rendering while review remains private", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	const bash = tools.get("bash");
	for (const command of [
		"gentle-ai sdd-status rose --json",
		"env FOO=bar gentle-ai sdd-continue rose",
		"gentle-ai sdd-attempt grant --authorization-root /root",
		"./.gentle-ai/v2.2.0/gentle-ai sdd-status rose --json",
		"C:\\package\\.gentle-ai\\v2.2.0\\gentle-ai.exe sdd-continue rose",
	]) {
		assert.equal(gentleAiRoutineCommand({ command }), undefined, command);
		const call = renderToString(bash.renderCall({ command }, passthroughTheme, { args: { command } }));
		assert.equal(call, `$ ${command}`);
		const result = renderToString(bash.renderResult(textResult("ordinary output"), { expanded: false, isPartial: false }, passthroughTheme, { args: { command } }));
		assert.match(result, /ordinary output/);
	}
	const review = "gentle-ai review status --next-transition";
	assert.equal(gentleAiRoutineCommand({ command: review }), "review");
	assert.equal(cardTitle(renderToString(bash.renderCall({ command: review }, passthroughTheme, { args: { command: review } }))), "🌹 rdd running · status");
});

test("quiet tool rendering identifies only routine Gentle AI review commands", () => {
	assert.equal(gentleAiRoutineCommand({ command: "/package/.gentle-ai/v2.2.0/gentle-ai review status --next-transition" }), "review");
	assert.equal(gentleAiRoutineCommand({ command: ".\\.gentle-ai\\v2.2.0\\gentle-ai.exe review status --next-transition" }), "review");
	assert.equal(gentleAiRoutineCommand({ command: "gentle-ai sdd-attempt acquire --change fix-rose" }), undefined);
	assert.equal(gentleAiRoutineCommand({ command: "gentle-ai sdd-attempt settle --change fix-rose" }), undefined);
	assert.equal(gentleAiRoutineCommand({ command: "gentle-ai review status --next-transition" }), "review");
	assert.equal(gentleAiRoutineCommand({ command: "gentle-ai version" }), undefined);
	assert.equal(gentleAiRoutineCommand({ command: "gentle-ai sdd-attempt inspect" }), undefined);
	assert.equal(gentleAiRoutineCommand({ command: "/package/.gentle-ai/v2.2.0/gentle-ai-copy review status" }), undefined);
	assert.equal(gentleAiRoutineCommand({ command: "echo gentle-ai review status" }), undefined);
});

test("quiet tool rendering refuses to compact composed Gentle AI shell commands", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	const commands = [
		"gentle-ai review status --next-transition && rm -rf target",
		"gentle-ai review status; rm -rf target",
		"gentle-ai review status || rm -rf target",
		"gentle-ai review status | tee status.json",
		"gentle-ai review status & rm -rf target",
		"gentle-ai review status\nrm -rf target",
		"gentle-ai review status --next-transition $(rm -rf target)",
		"gentle-ai review status --next-transition `rm -rf target`",
		"gentle-ai review status --next-transition <(cat target)",
		"gentle-ai review status --next-transition >(tee target)",
		"gentle-ai review status --next-transition > status.json",
		"gentle-ai review status --next-transition < status.json",
		"gentle-ai review status $HOME",
		"gentle-ai review status ${HOME}",
		"gentle-ai review status\n",
	];

	for (const command of commands) {
		assert.equal(gentleAiRoutineCommand({ command }), undefined, command);
		const call = renderToString(tools.get("bash").renderCall({ command }, passthroughTheme, {}));
		const output = renderToString(tools.get("bash").renderResult(textResult("command output"), { expanded: true, isPartial: false }, passthroughTheme, { args: { command } }));
		assert.equal(call.replace(/[ \t]+$/gm, "").trimEnd(), `$ ${command.trimEnd()}`);
		assert.match(output, /command output/);
	}
});

test("quiet tool rendering previews direct Gentle AI results and preserves expanded errors", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	const command = "gentle-ai review status --next-transition";
	const rose = "\u{1F339}";
	const tool = tools.get("bash");
	const failureText = "review status failed: authority unavailable\x1b[31m\nlineage=secret";
	const expandHint = keyHint("app.tools.expand", "to expand");

	const call = renderToString(tool.renderCall({ command }, passthroughTheme, {}));
	const collapsed = renderToString(tool.renderResult(textResult('{"next_transition":"stop"}'), { expanded: false, isPartial: false }, passthroughTheme, { args: { command } }));
	const expanded = renderToString(tool.renderResult(textResult('{"next_transition":"stop"}'), { expanded: true, isPartial: false }, passthroughTheme, { args: { command } }));
	const failure = renderToString(tool.renderResult(textResult(failureText), { expanded: false, isPartial: false, isError: true }, passthroughTheme, { args: { command } }));
	const expandedFailure = renderToString(tool.renderResult(textResult(failureText), { expanded: true, isPartial: false, isError: true }, passthroughTheme, { args: { command } }));
	const empty = renderToString(tool.renderResult(textResult(""), { expanded: false, isPartial: false }, passthroughTheme, { args: { command } }));
	const nonText = renderToString(tool.renderResult({ content: [{ type: "image", data: "opaque", mimeType: "image/png" }] }, { expanded: false, isPartial: false }, passthroughTheme, { args: { command } }));

	assert.equal([...rose].length, 1, "the rose is a plain emoji, no presentation selector");
	assert.equal(visibleWidth(rose), 2);
	assert.equal(cardTitle(call), `🌹 rdd running · status`);
	assert.equal(cardBody(collapsed), "stop", "a JSON envelope collapses to its readable summary");
	assert.doesNotMatch(collapsed, /\{"|next_transition/);
	assert.equal(cardBody(expanded), '{\n  "next_transition": "stop"\n}', "expanded JSON is pretty-printed");
	assert.doesNotMatch(expanded, /to expand/);
	assert.match(cardBody(failure), /review status failed.*authority unavailable/);
	assert.match(failure, /lineage=secret/);
	assert.match(expandedFailure, /review status failed: authority unavailable/);
	assert.match(expandedFailure, /lineage=secret/);
	assert.doesNotMatch(expandedFailure, /to expand/);
	assert.doesNotMatch(cardBody(expandedFailure), /\x1b\[/);
	assert.equal(cardBody(empty), "");
	assert.equal(cardBody(nonText), "");
});

test("quiet tool rendering transitions one Gentle AI header through lifecycle states", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	const tool = tools.get("bash");
	const command = "gentle-ai review status --cwd /repo/private-change";

	const initial = tool.renderCall({ command }, statusTheme, routineRenderContext());
	const initialText = renderToString(initial).trimEnd();
	const running = tool.renderCall(
		{ command },
		statusTheme,
		routineRenderContext({ executionStarted: true, lastComponent: initial }),
	);
	const runningText = renderToString(running).trimEnd();
	const completed = tool.renderCall(
		{ command },
		statusTheme,
		routineRenderContext({
			executionStarted: true,
			isPartial: false,
			lastComponent: running,
		}),
	);
	const completedText = renderToString(completed).trimEnd();
	const failed = tool.renderCall(
		{ command },
		statusTheme,
		routineRenderContext({
			executionStarted: true,
			isPartial: false,
			isError: true,
			lastComponent: completed,
		}),
	);
	const failedText = renderToString(failed).trimEnd();

	assert.strictEqual(initial, running);
	assert.strictEqual(running, completed);
	assert.strictEqual(completed, failed);
	assert.equal(cardTitle(initialText), "🌹 rdd running · status"); assert.equal(cardTone(initialText), "warning");
	assert.equal(cardTitle(runningText), "🌹 rdd running · status"); assert.equal(cardTone(runningText), "warning");
	assert.equal(cardTitle(completedText), "🌹 rdd status"); assert.equal(cardTone(completedText), "success");
	assert.equal(cardTitle(failedText), "🌹 rdd failed · status"); assert.equal(cardTone(failedText), "error");
	assert.doesNotMatch(failedText, /private-change/);
});

test("quiet Bash keeps direct Gentle AI calls seamless while streaming", () => {
	const tool = registeredQuietTools().get("bash");
	const rose = /🌹/;
	const render = (command: string, state: Record<string, unknown>, overrides: Record<string, unknown> = {}) => {
		const component = tool.renderCall({ command }, passthroughTheme, routineRenderContext({ args: { command }, state, argsComplete: false, ...overrides }));
		return [component, renderToString(component)] as const;
	};
	const command = "gentle-ai review status --token 'lineage-secret";
	const state = {};
	const [preparing, collapsed] = render(command, state);
	assert.equal(cardTitle(collapsed), "🌹 rdd preparing · status");
	assert.doesNotMatch(collapsed, /token|lineage-secret/);
	const expanded = render(command, state, { expanded: true, lastComponent: preparing })[1];
	assert.equal(cardTitle(expanded), "🌹 rdd preparing · status"); assert.equal(cardBody(expanded), "$ gentle-ai review status --token 'lineage-secret");

	const direct = "gentle-ai review status";
	const [running, runningText] = render(direct, state, { argsComplete: true, executionStarted: true, lastComponent: preparing });
	assert.strictEqual(running, preparing); assert.equal(cardTitle(runningText), "🌹 rdd running · status");
	const genericState = {};
	const [generic, genericText] = render("gentle-ai review status | cat", genericState);
	assert.doesNotMatch(genericText, rose); assert.match(genericText, /\| cat/);
	assert.doesNotMatch(render(direct, genericState, { argsComplete: true, lastComponent: generic })[1], rose);
	assert.match(render(direct, {}, { argsComplete: true })[1], rose);

	for (const malformed of ["gentle-ai\x1b[31m review status", 'gentle-ai review status "unfinished']) {
		const text = render(malformed, {}, { argsComplete: true })[1];
		assert.doesNotMatch(text, rose); assert.match(text, /\$ gentle-ai.*review status/);
	}
	for (const bracket of ["[", "]"]) assert.match(render(`${direct} ${bracket}`, {})[1], rose);

	const genericResult = renderToolResult(tool, textResult("generic result"), { expanded: false, isPartial: false }, { args: { command: direct }, state: genericState, argsComplete: true });
	assert.equal(genericResult.split("\n")[0], "generic result");
	const directState = {}; render(direct, directState, { argsComplete: true });
	const directResult = renderToolResult(tool, textResult("direct result"), { expanded: false, isPartial: false }, { args: { command: direct }, state: directState, argsComplete: true });
	assert.match(cardBody(directResult), /direct result/);
});

test("quiet tool rendering displays only finite safe Gentle AI operation paths", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	const tool = tools.get("bash");
	const cases = [
		["gentle-ai review capabilities --cwd /repo/private", "review capabilities"],
		["gentle-ai review start --target sha256:secret --path src/private.ts", "review start"],
		["gentle-ai review finalize --lineage lineage-secret --payload '{\"secret\":true}'", "review finalize"],
		["gentle-ai review status --lineage lineage-secret", "review status"],
		["gentle-ai review repair --reason private-reason", "review repair"],
		["gentle-ai review invalidate --lineage lineage-secret", "review invalidate"],
		["gentle-ai review abandon --lineage lineage-secret", "review abandon"],
		["gentle-ai review recover --lineage lineage-secret", "review recover"],
		["gentle-ai review reclaim --lineage lineage-secret", "review reclaim"],
		["gentle-ai review validate --cwd /repo/private", "review validate"],
		["gentle-ai review capture-result --input result.json", "review capture result"],
		["gentle-ai review capture-refuter --input result.json", "review capture refuter"],
		["gentle-ai review capture-validation --input result.json", "review capture validation"],
		["gentle-ai review capture-evidence --input evidence.json", "review capture evidence"],
		["gentle-ai review preserve-result --input result.json", "review preserve result"],
		["gentle-ai review lens-context --lens reviewer", "review lens context"],
		["gentle-ai review retry-final-verification --incident incident.json", "review retry final verification"],
		["gentle-ai review store-reset --authorization secret", "review store reset"],
		["gentle-ai review inspect-authority --path /repo/private", "review inspect authority"],
		["gentle-ai review inspect-candidate --path /repo/private", "review inspect candidate"],
		["gentle-ai review dispose-result --reference result-secret", "review dispose result"],
		["gentle-ai review reopen-results --reference result-secret", "review reopen results"],
		["gentle-ai review opencode-transport --payload secret", "review opencode transport"],
		["gentle-ai review bind-sdd --change change-123 --lineage lineage-secret", "review bind sdd"],
		["gentle-ai review mode enable --actor maintainer", "review mode enable"],
		["gentle-ai review mode disable --actor maintainer", "review mode disable"],
		["gentle-ai review mode status --json", "review mode status"],
		["gentle-ai review validate --gate post-apply --cwd /repo/private", "review validate post apply"],
		["gentle-ai review validate --gate pre-commit --cwd /repo/private", "review validate pre commit"],
		["gentle-ai review validate --gate pre-push --cwd /repo/private", "review validate pre push"],
		["gentle-ai review validate --gate pre-pr --cwd /repo/private", "review validate pre pr"],
		["gentle-ai review validate --gate release --cwd /repo/private", "review validate release"],
		["gentle-ai review schema capture-result-dry-run --path /tmp/private.json", "review schema capture result dry run"],
		["gentle-ai review schema final-verification-incident --path /tmp/private.json", "review schema final verification incident"],
		["gentle-ai review schema refuter --path /tmp/private.json", "review schema refuter"],
		["gentle-ai review schema reviewer --path /tmp/private.json", "review schema reviewer"],
		["gentle-ai review schema validator --path /tmp/private.json", "review schema validator"],
		["gentle-ai review schema verification-evidence --path /tmp/private.json", "review schema verification evidence"],
		["gentle-ai review schema verification-evidence-record --path /tmp/private.json", "review schema verification evidence record"],
		["gentle-ai review unknown-operation --change change-123 --reason private-reason", "review"],
		["gentle-ai review mode restart --actor maintainer", "review"],
		["gentle-ai review validate --gate unknown-gate --cwd /repo/private", "review"],
		["gentle-ai review schema unknown-schema --path /tmp/private.json", "review schema"],
	];

	for (const [command, path] of cases) {
		const rendered = renderToString(
			tool.renderCall(
				{ command },
				passthroughTheme,
				routineRenderContext({ args: { command } }),
			),
		);
		assert.equal(cardTitle(rendered), path === "review" ? "🌹 rdd running" : `🌹 rdd running · ${path.slice("review ".length)}`, command);
		assert.doesNotMatch(rendered, /change-123|private|secret|lineage|sha256|result\.json|incident\.json/);
	}
});

test("quiet tool rendering covers version and future standalone Gentle AI commands", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	const tool = tools.get("bash");
	const cases = [
		["gentle-ai version", "gentle-ai running · version"],
		["gentle-ai future-command --authorization-root /repo/private", "gentle-ai running · command"],
		["gentle-ai review future-operation --path /repo/private", "rdd running"],
		["/package/.gentle-ai/v2.2.0/gentle-ai version", "gentle-ai running · version"],
		["C:\\package\\.gentle-ai\\v2.2.0\\gentle-ai.exe future-command --root C:\\private", "gentle-ai running · command"],
	] as const;

	for (const [command, path] of cases) {
		const rendered = renderToString(
			tool.renderCall({ command }, passthroughTheme, routineRenderContext({ args: { command } })),
		);
		assert.equal(cardTitle(rendered), `🌹 ${path}`, command);
		assert.doesNotMatch(rendered, /authorization-root|private|C:\\\\private/);
	}
});

test("quiet tool rendering recognizes exact quoted, escaped, Windows, and command-prefixed Gentle AI executables", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	const tool = tools.get("bash");
	const routineCommands = [
		"gentle-ai.exe version",
		"'gentle-ai' version",
		'"gentle-ai" version',
		"'gentle-ai.exe' version",
		'"gentle-ai.exe" version',
		"gentle\\-ai version",
		"gentle\\-ai\\.exe version",
		"command -- gentle-ai version",
		"command -- 'gentle-ai.exe' version",
		"env gentle-ai version",
		"FOO='a b' gentle-ai version",
		'FOO="a b" gentle-ai version',
		"env FOO='a b' gentle-ai version",
		'env FOO="a b" gentle-ai version',
	] as const;

	for (const command of routineCommands) {
		const call = renderToString(tool.renderCall({ command }, passthroughTheme, { args: { command } }));
		assert.equal(cardTitle(call), "🌹 gentle-ai running · version", command);
	}

	for (const command of ["'gentle-ai-copy' version", '"gentle-ai-copy.exe" version', "'gentle-ai' version && echo done"] as const) {
		const call = renderToString(tool.renderCall({ command }, passthroughTheme, { args: { command } }));
		assert.equal(call.trimEnd(), `$ ${command}`);
		assert.doesNotMatch(call, /🌹/);
	}
});

test("quiet tool rendering recognizes only the exact resolved dev binary", () => {
	let devPath = "/home/devel/projects/gentle-ai/dist/gentle-ai-main";
	let resolutions = 0;
	const tools = registeredQuietToolsWithResolver(() => {
		resolutions += 1;
		return { source: "registration", origin: "test", path: devPath, sha256: "test" };
	});
	const tool = tools.get("bash");
	const cases = [
		[`${devPath} review validate --gate pre-commit --cwd /repo/private`, "rdd running · validate pre commit"],
		[`'${devPath}' review status --lineage secret`, "rdd running · status"],
		[`"${devPath}" version`, "gentle-ai running · version"],
		[`env FOO='a b' ${devPath} review capabilities`, "rdd running · capabilities"],
	] as const;
	for (const [command, operationPath] of cases) {
		const call = renderToString(tool.renderCall({ command }, statusTheme, routineRenderContext({ args: { command } })));
		assert.equal(cardTitle(call), `🌹 ${operationPath}`, command); assert.equal(cardTone(call), "warning", command);
		assert.doesNotMatch(call, /gentle-ai-main|private|secret|hidden/);
	}
	const command = `${devPath} review status --prompt hidden-prompt --lineage lineage-secret --body private-body`;
	const lifecycleContext = routineRenderContext({ args: { command }, state: {} });
	assert.match(renderToString(tool.renderCall({ command }, passthroughTheme, lifecycleContext)), /rdd running · status/);
	devPath = "/new/dev/gentle-ai-main";
	const refreshedCommand = `${devPath} review status --token token-secret`;
	assert.match(renderToString(tool.renderCall({ command: refreshedCommand }, passthroughTheme, routineRenderContext({ args: { command: refreshedCommand } }))), /rdd running · status/);
	assertGenericBash(tool, cases[2][0]);
	const text = "error: private failure\nlineage=secret body=hidden\x1b[31m";
	const collapsed = renderToolResult(tool, textResult(text), { expanded: false, isPartial: false, isError: true }, lifecycleContext);
	const expanded = renderToolResult(tool, textResult(text), { expanded: true, isPartial: false, isError: true }, lifecycleContext);
	const refreshed = renderToolResult(tool, textResult("result-secret"), { expanded: false, isPartial: false }, { args: { command: refreshedCommand } });
	const hint = keyHint("app.tools.expand", "to expand");
	assert.match(cardBody(collapsed), /private failure/);
	assert.equal(cardBody(collapsed).split(hint).length - 1, 0);
	assert.match(expanded, /private failure|lineage=secret body=hidden/);
	assert.doesNotMatch(cardBody(expanded), /to expand|\x1b\[/);
	assert.match(refreshed, /result-secret/);
	assert.ok(resolutions > 1);
});
test("quiet tool rendering keeps unregistered dev lookalikes and composed calls generic", () => {
	const devPath = "/home/devel/projects/gentle-ai/dist/gentle-ai-main";
	const active = registeredQuietToolsWithResolver(() => ({ source: "registration", origin: "test", path: devPath, sha256: "test" }));
	for (const command of [
		"gentle-ai-main review status",
		"/tmp/alias/gentle-ai review status",
		`${devPath}-sibling review status`, `${devPath}.bak review status`, `${devPath}x review status`,
		`${devPath} review status | tee output`, `${devPath} review status && echo done`,
		`'${devPath}' review status $(printf nested)`,
	]) assertGenericBash(active.get("bash"), command);

	const unresolved = `${devPath} review status`;
	assertGenericBash(registeredQuietToolsWithResolver(() => undefined).get("bash"), unresolved);
	let throwing: Map<string, any> | undefined;
	assert.doesNotThrow(() => { throwing = registeredQuietToolsWithResolver(() => { throw new Error("invalid override"); }); });
	assertGenericBash(throwing!.get("bash"), unresolved);
	assertGenericBash(registeredQuietToolsWithResolver(() => ({ path: "relative/gentle-ai-main" })).get("bash"), unresolved);
});
test("quiet tool rendering previews routine partial content while the header owns state", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	const tool = tools.get("bash");
	const command = "gentle-ai review status --cwd /repo/private";

	const expandHint = keyHint("app.tools.expand", "to expand");
	const partial = renderToString(
		tool.renderResult(
			textResult("{\"status\":\"running\"}"),
			{ expanded: false, isPartial: true },
			passthroughTheme,
			{ ...routineRenderContext({ args: { command } }), isError: false },
		),
	);
	const partialExpanded = renderToString(
		tool.renderResult(
			textResult("{\"status\":\"running\"}"),
			{ expanded: true, isPartial: true },
			passthroughTheme,
			{ ...routineRenderContext({ args: { command } }), isError: false },
		),
	);
	const partialFailure = renderToString(
		tool.renderResult(
			textResult("review status failed: authority unavailable"),
			{ expanded: false, isPartial: true },
			passthroughTheme,
			{ ...routineRenderContext({ args: { command } }), isError: true },
		),
	);
	const completed = renderToString(
		tool.renderResult(
			textResult("{\"status\":\"running\"}"),
			{ expanded: false, isPartial: false },
			passthroughTheme,
			{ ...routineRenderContext({ args: { command } }), isError: false },
		),
	);

	assert.equal(cardBody(partial), "running");
	assert.equal(cardBody(partial).split(expandHint).length - 1, 0);
	assert.match(partialExpanded, /"status": "running"/);
	assert.doesNotMatch(partialExpanded, /to expand/);
	assert.match(cardBody(partialFailure), /authority unavailable/);
	assert.equal(cardBody(completed), "running");

	const partialExpandedFailure = renderToString(
		tool.renderResult(
			textResult("review status failed: authority unavailable\x1b[31m"),
			{ expanded: true, isPartial: true },
			passthroughTheme,
			{ ...routineRenderContext({ args: { command } }), isError: true },
		),
	);
	assert.match(partialExpandedFailure, /review status failed: authority unavailable/);
	assert.doesNotMatch(cardBody(partialExpandedFailure), /\x1b\[/);
});

test("quiet tool rendering hides invocation arguments but previews result content without redaction", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	const tool = tools.get("bash");
	const command = "gentle-ai review finalize --prompt hidden-prompt --lineage lineage-secret --body private-body --authorization-root /private/root";
	const call = renderToString(tool.renderCall({ command }, passthroughTheme, { args: { command } }));
	const collapsed = renderToString(
		tool.renderResult(
			textResult("audit: lineage-secret body=private-body prompt=hidden-prompt root=/private/root"),
			{ expanded: false, isPartial: false, isError: true },
			passthroughTheme,
			{ args: { command }, isError: true },
		),
	);

	assert.equal(cardTitle(call), "🌹 rdd running · finalize");
	assert.match(cardBody(collapsed), /audit:/);
	for (const forbidden of ["hidden-prompt", "lineage-secret", "private-body", "/private/root", "audit:"]) {
		assert.doesNotMatch(call, new RegExp(forbidden));
		assert.match(collapsed, new RegExp(forbidden), "result preview is not secret redaction");
	}
});

test("quiet tool rendering keeps shell compositions, expansions, and lookalikes generic", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	const tool = tools.get("bash");
	const commands = [
		"gentle-ai version && echo done",
		"gentle-ai version; echo done",
		"gentle-ai version | tee output",
		"gentle-ai version $HOME",
		"gentle-ai version $(printf nested)",
		"gentle-ai sdd-attempt grant --change secret-change # ignored comment",
		"gentle-ai sdd-attempt grant --authorization-root /private/root && echo done",
		"gentle-ai sdd-attempt grant --authorization-root=/private/root | tee output",
		"/package/.gentle-ai/v2.2.0/gentle-ai-copy version",
		"echo gentle-ai version",
	];

	for (const command of commands) {
		const call = renderToString(tool.renderCall({ command }, passthroughTheme, { args: { command } }));
		const output = renderToString(
			tool.renderResult(textResult("original command output"), { expanded: true, isPartial: false }, passthroughTheme, { args: { command } }),
		);
		assert.equal(call.trimEnd(), `$ ${command}`);
		assert.doesNotMatch(call, /🌹/);
		assert.match(output, /original command output/);
	}
});

test("quiet Bash previews semantic lines for generic JSON output", () => {
	const tools = registeredQuietTools();
	const tool = tools.get("bash");
	const command = "gentle-ai review capabilities --contract gentle-ai.review-integration/v2 | python3 -m json.tool";
	const json = (value: unknown) => JSON.stringify(value, null, 2);
	const object = json({ schema: "gentle-ai.review-integration/v2", contract: "review", protocol: { version: 2 }, payload: { items: [{ value: true }] } });
	const error = json({ error: "failed", payload: { items: [{ code: 1 }] } });
	const cases = [
		[object, '  "schema": "gentle-ai.review-integration/v2",\n  "contract": "review",\n  "protocol": {'],
		[json(["alpha", "beta", { entry: true }]), '  "alpha",\n  "beta",\n    "entry": true'],
		['{\n  "schema": "broken",\n  "contract": "partial",\n  "payload": [\n    "value"\n  ]', '  "payload": [\n    "value"\n  ]'],
	] as const;
	for (const [text, expected] of cases) {
		assert.equal(formatToolResultOutput("bash", textResult(text) as any, { expanded: false, args: { command } }), `\n${expected}`);
	}
	assert.equal(formatToolResultOutput("bash", textResult(error) as any, { expanded: false, isError: true, args: { command } }), `\n${tailLines(error, 3)}`);
	const call = renderToString(tool.renderCall({ command }, passthroughTheme, { args: { command } }));
	const collapsed = renderToolResult(tool, textResult(object), { expanded: false, isPartial: false }, { args: { command } });
	const expanded = renderToolResult(tool, textResult(object), { expanded: true, isPartial: false }, { args: { command } });
	assert.equal(call.trimEnd(), `$ ${command}`);
	assert.doesNotMatch(call, /🌹/);
	assert.doesNotMatch(collapsed, /^\n\s*[}\]]/);
	const expandHint = keyHint("app.tools.expand", "to expand");
	assert.equal(collapsed.split(expandHint).length - 1, 0);
	assert.equal(expanded, object);
	assert.doesNotMatch(expanded, /to expand/);
});

test("quiet tool rendering keeps collapsed git bash result tails", () => {
	const text = Array.from({ length: 12 }, (_, index) => `git line ${index + 1}`).join("\n");

	assert.equal(formatToolResultOutput("bash", textResult(text) as any, { expanded: false, args: { command: "git diff" } }), `\n${tailLines(text, 10)}`);
	assert.equal(formatToolResultOutput("bash", textResult(text) as any, { expanded: false, args: { command: "git status --short" } }), `\n${tailLines(text, 10)}`);
});

test("quiet tool rendering keeps concise collapsed edit and write summaries", () => {
	const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

	assert.equal(tailLines(text, 10), Array.from({ length: 10 }, (_, index) => `line ${index + 3}`).join("\n"));
	assert.equal(formatToolResultOutput("edit", textResult(text, { diff: "@@\n-old\n+new" }) as any, { expanded: false }), "\n✓ +1 / -1");
	assert.equal(formatToolResultOutput("write", textResult("Successfully wrote 12 bytes\n" + text) as any, { expanded: false }), "\n✓ wrote 12 bytes");
});

test("quiet write expansion shows the complete written content without changing the compact summary", () => {
	const tool = registeredQuietTools().get("write");
	const content = Array.from({ length: 12 }, (_, index) => `written line ${index + 1}`).join("\n");
	const result = textResult("Successfully wrote 182 bytes to file.ts");
	const context = { args: { path: "file.ts", content } };

	assert.equal(renderToolResult(tool, result, { expanded: true, isPartial: false }, context), content);
	assert.equal(renderToolResult(tool, result, { expanded: false, isPartial: false }, context), "✓ wrote 182 bytes");
});

test("quiet write expansion renders content after a real built-in write", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "gentle-write-expanded-"));
	try {
		const tool = registeredQuietTools().get("write");
		const args = { path: "example.ts", content: "export const answer = 42;\n" };
		const result = await tool.execute("write-expanded", args, undefined, undefined, { cwd });

		assert.equal(await readFile(join(cwd, args.path), "utf8"), args.content);
		assert.match(extractTextContent(result), /Successfully wrote/);
		assert.doesNotMatch(extractTextContent(result), /export const answer/);
		assert.equal(renderToolResult(tool, result, { expanded: true, isPartial: false }, { args }), args.content);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("quiet write expansion sanitizes content and respects narrow card widths", () => {
	const tool = registeredQuietTools().get("write");
	const content = "first\n\nsafe\x1b]52;c;Y2xpcGJvYXJk\x07\x1b[2Jdone\n界e\u0301😀";
	const result = textResult("Successfully wrote to file.ts");
	const context = { args: { path: "file.ts", content } };
	const options = { expanded: true, isPartial: false };

	assert.equal(renderToolResult(tool, result, options, context), "first\n\nsafedone\n界e\u0301😀");
	const lines = frameLines(tool.renderResult(result, options, passthroughTheme, context), 16);
	assert.ok(lines.every((line) => visibleWidth(line) <= 16));
	assert.doesNotMatch(lines.join("\n"), /\x1b/);
});

test("quiet write expansion preserves failures, partial results and fallback confirmations", () => {
	const tool = registeredQuietTools().get("write");
	const context = { args: { path: "file.ts", content: "not written" } };
	const options = { expanded: true, isPartial: false };
	for (const errorContext of [context, { ...context, isError: true }]) {
		const rendered = renderToolResult(tool, textResult("EACCES: permission denied"), { ...options, isError: true }, errorContext);
		assert.equal(rendered, "EACCES: permission denied");
	}
	const partial = renderToolResult(tool, textResult("writing…"), { expanded: true, isPartial: true }, context);
	assert.match(partial, /writing…/);
	assert.doesNotMatch(partial, /not written/);
	const confirmation = "Successfully wrote 0 bytes to file.ts";
	for (const fallbackContext of [{}, { args: {} }, { args: { content: 42 } }, { args: { content: "" } }]) {
		assert.equal(renderToolResult(tool, textResult(confirmation), options, fallbackContext), confirmation);
	}
});

test("quiet tool rendering sanitizes collapsed output and call rows", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));

	const collapsed = renderToString(
		tools.get("bash").renderResult(textResult("safe\x1b[31mred\x1b[0m"), { expanded: false, isPartial: false }, passthroughTheme, { args: { command: "printf output" } }),
	);
	const call = renderToString(tools.get("bash").renderCall({ command: "echo \x1b[31mred\x1b[0m" }, passthroughTheme, {}));

	const carriageReturn = renderToolResult(tools.get("bash"), textResult("prefix\rSECRET\r\nnext"), { expanded: false, isPartial: false }, { args: { command: "printf output" } });
	assert.match(collapsed, /safered/);
	assert.doesNotMatch(cardBody(collapsed), /\x1b\[31m|\x1b\[0m/);
	assert.equal(call.trimEnd(), "$ echo red");
	assert.match(carriageReturn, /prefixSECRET\nnext/);
	assert.doesNotMatch(carriageReturn, /\r/);
});

test("quiet tool rendering sanitizes only rendered fields", () => {
	let argsReads = 0, detailReads = 0;
	const counted = (record: Record<string, unknown>, increment: () => void) => Object.defineProperties(record, Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`unused${index}`, { enumerable: true, get() { increment(); return "ignored"; } }])));
	const args = counted({ command: "printf output" }, () => argsReads++);
	const details = counted({}, () => detailReads++);
	renderToolResult(registeredQuietTools().get("bash"), textResult("first\nsecond", details), { expanded: false, isPartial: false }, { args });
	assert.equal(argsReads, 0);
	assert.equal(detailReads, 0);
});

test("quiet tool rendering call rows show tool calls without result output", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));

	const readCall = renderToString(tools.get("read").renderCall({ path: "/tmp/example.ts", offset: 2, limit: 3 }, passthroughTheme, {}));
	const bashCall = renderToString(tools.get("bash").renderCall({ command: "printf noisy", timeout: 5 }, passthroughTheme, {}));
	const grepCall = renderToString(tools.get("grep").renderCall({ pattern: "needle", path: "src", glob: "*.ts" }, passthroughTheme, {}));

	assert.match(readCall, /read .*example\.ts:2-4/);
	assert.match(bashCall, /\$ printf noisy \(timeout 5s\)/);
	assert.match(grepCall, /grep \/needle\/ in src \(\*\.ts\)/);
    });

test("quiet tool rendering limits collapsed visual rows at the actual width", () => {
	const tools = registeredQuietTools();
	const bash = tools.get("bash");
	const hint = keyHint("app.tools.expand", "to expand");
	// Twelve content columns inside the four-column card sides.
	const narrowWidth = 16;
	const cases = [
		// Preview rows plus the closing rule; a partial result adds its label row.
		[textResult("x".repeat(80)), { expanded: false, isPartial: true }, { args: { command: "printf output" } }, 5],
		[textResult("界".repeat(40)), { expanded: false, isPartial: false }, { args: { command: "printf output" } }, 4],
		[textResult("e\u0301".repeat(40)), { expanded: false, isPartial: false, isError: true }, { args: { command: "false" }, isError: true }, 4],
	] as const;
	for (const [result, options, context, maxRows] of cases) {
		const lines = frameLines(bash.renderResult(result, options, passthroughTheme, context), narrowWidth);
		assert.ok(lines.length <= maxRows, `expected at most ${maxRows} rows, got ${lines.length}`);
		assert.ok(lines.every((line) => visibleWidth(line) <= narrowWidth));
	}
	const completed = frameLines(bash.renderResult(textResult("😀".repeat(40)), { expanded: false, isPartial: false }, passthroughTheme, { args: { command: "printf output" } }), narrowWidth);
	assert.equal(completed.filter((line) => line.includes(hint)).length, 0);
	assert.ok(completed.every((line) => visibleWidth(line) <= narrowWidth));
});

test("quiet tool rendering classifies quoted and escaped literal shell metacharacters as direct Gentle AI calls", () => {
	const tool = registeredQuietTools().get("bash");
	for (const command of [
		"gentle-ai review status '--note=$|#;'",
		'"gentle-ai" review status "literal \\$|#;"',
		"gentle\\-ai review status escaped\\ space",
	]) {
		const call = renderToString(tool.renderCall({ command }, passthroughTheme, { args: { command } }));
		const collapsed = renderToolResult(tool, textResult("private output"), { expanded: false, isPartial: false }, { args: { command } });
		assert.match(call, /🌹 rdd running · status/, command);
		assert.match(collapsed, /private output/, command);
	}
});

test("quiet tool rendering keeps unescaped expansions inside double quotes generic", () => {
	const tool = registeredQuietTools().get("bash");
	const commands = [
		'gentle-ai review status "$VALUE"',
		'gentle-ai review status "$(printf nested)"',
		'gentle-ai review status "`printf nested`"',
	] as const;

	for (const command of commands) {
		const call = renderToString(tool.renderCall({ command }, passthroughTheme, { args: { command } }));
		const collapsed = renderToolResult(
			tool,
			textResult("original command output"),
			{ expanded: false, isPartial: false },
			{ args: { command } },
		);
		assert.equal(gentleAiRoutineCommand({ command }), undefined, command);
		assert.equal(call.trimEnd(), `$ ${command}`, command);
		assert.match(collapsed, /original command output/, command);
	}
});

test("quiet tool rendering recognizes a quoted exact dev override path containing spaces", () => {
	const devPath = "/opt/Gentle AI/gentle-ai";
	const tool = registeredQuietToolsWithResolver(() => ({ path: devPath })).get("bash");
	const command = `"${devPath}" review status "literal \\$|#;"`;
	const call = renderToString(tool.renderCall({ command }, passthroughTheme, { args: { command } }));
	const collapsed = renderToolResult(tool, textResult("private result"), { expanded: false, isPartial: false }, { args: { command } });
	assert.equal(cardTitle(call), "🌹 rdd running · status");
	assert.doesNotMatch(call, /\/opt\/Gentle AI\/gentle-ai|literal/);
	assert.match(collapsed, /private result/);
});

test("quiet tool rendering bounds and sanitizes partial text without a completion hint", () => {
	const tool = registeredQuietTools().get("bash");
	const result = textResult("first\nsecond\nthird\nfourth");
	const collapsed = renderToolResult(tool, result, { expanded: false, isPartial: true }, { args: { command: "printf output" } });
	const expanded = renderToolResult(tool, result, { expanded: true, isPartial: true }, { args: { command: "printf output" } });

	assert.match(collapsed, /… bash · 4 lines/);
	assert.doesNotMatch(collapsed, /first/);
	assert.match(collapsed, /second\nthird\nfourth/);
	assert.doesNotMatch(collapsed, /to expand|Ctrl\+O/);
	assert.match(expanded, /first\nsecond\nthird\nfourth/);
	assert.doesNotMatch(expanded, /to expand|Ctrl\+O/);
	assert.match(renderToolResult(tool, textResult("first\n\nsecond\n\n"), { expanded: false, isPartial: true }, { args: { command: "printf output" } }), /… bash · 2 lines/);

	const sanitized = renderToolResult(tool, textResult("safe\x1b]52;c;Y2xpcGJvYXJk\x07\x1b[2Jdone"), { expanded: true, isPartial: true }, { args: { command: "echo safe" } });
	assert.match(sanitized, /safedone/);
	assert.doesNotMatch(sanitized, /\x1b/);

	for (const [value, options] of [
		[textResult(""), { expanded: false, isPartial: true }],
		[{ content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] }, { expanded: true, isPartial: true }],
	] as const) {
		assert.equal(renderToolResult(tool, value, options, { args: { command: "true" } }).trimEnd(), "… bash");
	}
});

test("quiet tool rendering bounds completed previews, errors, and edit/write summaries", () => {
	const tools = registeredQuietTools();
	for (const [toolName, text, hidden, visible, context] of [
		["read", "read one\nread two\nread three\nread four", "read four", "read one\nread two\nread three", {}],
		["bash", "bash one\nbash two\nbash three\nbash four", "bash one", "bash two\nbash three\nbash four", { args: { command: "printf output" } }],
	] as const) {
		const rendered = renderToolResult(tools.get(toolName), textResult(text), { expanded: false, isPartial: false }, context);
		assert.doesNotMatch(rendered, new RegExp(hidden));
		assert.match(rendered, new RegExp(visible));
		assert.doesNotMatch(rendered, /to expand/);
	}

	for (const toolName of ["read", "bash", "grep", "find", "ls", "edit", "write"] as const) {
		const rendered = renderToolResult(tools.get(toolName), textResult("error one\nerror two\nerror three\nerror four"), { expanded: false, isPartial: false, isError: true }, { args: toolName === "bash" ? { command: "false" } : {} });
		assert.doesNotMatch(rendered, /error one/);
		assert.match(rendered, /error two\nerror three\nerror four/);
		assert.doesNotMatch(rendered, /to expand/);
	}

	const edit = renderToolResult(tools.get("edit"), textResult("Applied", { diff: "@@\n-old\n+new" }), { expanded: false, isPartial: false }, { args: { path: "file.ts", edits: [] } });
	const write = renderToolResult(tools.get("write"), textResult("Successfully wrote 4 bytes\nbody"), { expanded: false, isPartial: false }, { args: { path: "file.ts", content: "body" } });
	assert.match(edit, /\+1 \/ -1/);
	assert.match(edit, /-old[\s\S]*\+new/);
	assert.match(write, /wrote 4 bytes/);
	assert.doesNotMatch(write, /body/);
});

test("quiet tool rendering preserves complete expanded text and delegates sanitized image reads", () => {
	const tools = registeredQuietTools();
	const expanded = renderToolResult(tools.get("bash"), textResult("first\nsecond\nthird\nfourth\nsafe\x1b]52;c;Y2xpcGJvYXJk\x07done"), { expanded: true, isPartial: false }, { args: { command: "printf safe" } });
	assert.match(expanded, /first\nsecond\nthird\nfourth\nsafedone/);
	assert.doesNotMatch(expanded, /\x1b/);

	const edit = renderToolResult(tools.get("edit"), textResult("Applied", { diff: "@@\n-old\x1b]52;c;Y2xpcGJvYXJk\x07\n+new" }), { expanded: true, isPartial: false }, { args: { path: "file\x1b[2J.ts", edits: [{ oldText: "old\x1b[31m", newText: "new" }] } });
	assert.match(edit, /-old\n\+new/);
	assert.doesNotMatch(edit, /\x1b/);

	const image = renderToolResult(
		tools.get("read"),
		{ content: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], details: { path: "image\x1b[2J.png", note: "safe\x1b]2;title\x07" } },
		{ expanded: true, isPartial: false },
		{ args: { path: "image\x1b[2J.png", offset: 1, limit: 2 }, cwd: "/repo\x1b[2J", showImages: false, isError: false },
	);
	assert.ok(image.includes(imageFallback("image/png")));
	assert.doesNotMatch(image, /\x1b/);
});

test("quiet tool rendering preserves directional visual preview rows at narrow widths", () => {
	const tools = registeredQuietTools();
	const bash = tools.get("bash");
	const readTool = tools.get("read");
	// Twelve content columns inside the four-column card sides.
	const narrowWidth = 16;
	const renderCollapsed = (
		text: string,
		options: { expanded: false; isPartial: boolean; isError?: boolean },
		context: Record<string, unknown>,
	) => renderLines(bash.renderResult(textResult(text), options, passthroughTheme, context), narrowWidth);
	const renderRead = (text: string) => renderLines(
		readTool.renderResult(textResult(text), { expanded: false, isPartial: false }, passthroughTheme, {}),
		narrowWidth,
	);
	const oldText = "older wrapped text ".repeat(16);

	const partial = renderCollapsed(`${oldText}\nPARTIAL-NEW`, { expanded: false, isPartial: true }, { args: { command: "printf output" } });
	const growingPartial = renderCollapsed(`${oldText}GROW-SUFFIX`, { expanded: false, isPartial: true }, { args: { command: "printf output" } });
	const completedBash = renderCollapsed(`${oldText}\nBASH-NEW`, { expanded: false, isPartial: false }, { args: { command: "printf output" } });
	const error = renderCollapsed(`${oldText}\nERROR-NEW`, { expanded: false, isPartial: false, isError: true }, { args: { command: "false" }, isError: true });
	const git = renderCollapsed(`${oldText}\nGIT-NEW`, { expanded: false, isPartial: false }, { args: { command: "git diff" } });

	for (const [lines, marker] of [
		[partial, "PARTIAL-NEW"],
		[growingPartial, "GROW-SUFFIX"],
		[completedBash, "BASH-NEW"],
		[error, "ERROR-NEW"],
		[git, "GIT-NEW"],
	] as const) {
		assert.ok(lines.length <= 4, `expected fixed preview budget, got ${lines.length}`);
		assert.match(lines.join("\n"), new RegExp(marker));
	}
	assert.match(partial[0] ?? "", /… bash/);
	assert.doesNotMatch(completedBash.join("\n"), /to expand/);

	const read = renderRead(`READ-FIRST\n${oldText}\nREAD-NEW`);
	const semanticJson = renderCollapsed(
		JSON.stringify({ first: "x".repeat(80), newest: "JSON-NEW" }, null, 2),
		{ expanded: false, isPartial: false },
		{ args: { command: "printf output" } },
	);
	assert.match(read.join("\n"), /READ-FIRST/);
	assert.doesNotMatch(read.join("\n"), /READ-NEW/);
	assert.match(semanticJson.join("\n"), /first/);
	assert.doesNotMatch(semanticJson.join("\n"), /JSON-NEW/);
	assert.match(
		renderToolResult(bash, textResult(`${oldText}\nBASH-NEW`), { expanded: true, isPartial: false }, { args: { command: "printf output" } }),
		/BASH-NEW/,
	);
});

test("quiet tool rendering fails closed on unquoted shell expansions", () => {
	const bash = registeredQuietTools().get("bash");
	for (const command of [
		"gentle-ai review status *",
		"gentle-ai review status ?",
		"gentle-ai review status [a-z]",
		"gentle-ai review status ~",
		"gentle-ai review status {one,two}",
	]) {
		assert.equal(gentleAiRoutineCommand({ command }), undefined, command);
		assertGenericBash(bash, command);
	}

	for (const command of [
		"gentle-ai review status '*'",
		"gentle-ai review status \"?\"",
		"gentle-ai review status '[a-z]'",
		"gentle-ai review status \"~\"",
		"gentle-ai review status '{one,two}'",
		"gentle-ai review status \\*",
		"gentle-ai review status \\?",
		"gentle-ai review status \\[a-z\\]",
		"gentle-ai review status \\~",
		"gentle-ai review status \\{one,two\\}",
	]) {
		const call = renderToString(bash.renderCall({ command }, passthroughTheme, { args: { command } }));
		const collapsed = renderToolResult(bash, textResult("dummy-secret"), { expanded: false, isPartial: false }, { args: { command } });
		assert.equal(gentleAiRoutineCommand({ command }), "review", command);
		assert.match(call, /🌹 rdd running · status/, command);
		assert.match(collapsed, /dummy-secret/, command);
	}
});

test("quiet tool rendering redacts only exact package-local executable paths with spaces", () => {
	const bash = registeredQuietTools().get("bash");
	const validCommands = [
		"'/opt/Gentle Package/.gentle-ai/v2.2.0/gentle-ai' review status --token single-secret",
		'"/opt/Gentle Package/.gentle-ai/v2.2.0/gentle-ai" review status --token double-secret',
		"/opt/Gentle\\ Package/.gentle-ai/v2.2.0/gentle-ai review status --token escaped-secret",
	] as const;
	for (const command of validCommands) {
		const call = renderToString(bash.renderCall({ command }, passthroughTheme, { args: { command } }));
		const collapsed = renderToolResult(bash, textResult("dummy-secret"), { expanded: false, isPartial: false }, { args: { command } });
		assert.equal(gentleAiRoutineCommand({ command }), "review", command);
		assert.match(call, /🌹 rdd running · status/, command);
		assert.doesNotMatch(call, /Gentle Package|secret/, command);
		assert.match(collapsed, /dummy-secret/, command);
	}

	for (const command of [
		"'/opt/Gentle Package/.gentle-ai/v2.2.0/gentle-ai-copy' review status --token copy-secret",
		'"/opt/Gentle Package/.gentle-ai/v2.2.0/gentle-ai.exe.bak" review status --token backup-secret',
		"/opt/Gentle\\ Package/.gentle-ai/v2.2.0/not-gentle-ai review status --token sibling-secret",
	]) {
		const call = renderToString(bash.renderCall({ command }, passthroughTheme, { args: { command } }));
		const collapsed = renderToolResult(bash, textResult("dummy-secret"), { expanded: false, isPartial: false }, { args: { command } });
		assert.equal(gentleAiRoutineCommand({ command }), undefined, command);
		assert.equal(call.trimEnd(), `$ ${command}`, command);
		assert.match(collapsed, /dummy-secret/, command);
	}
});

test("quiet tool rendering respects command and env wrapper order", () => {
	const bash = registeredQuietTools().get("bash");
	for (const command of [
		"FOO=bar command -- env BAR=baz gentle-ai review status",
		"command -- env FOO=bar gentle-ai review status",
		"env FOO=bar gentle-ai review status",
		"command -- gentle-ai review status",
	]) {
		const call = renderToString(bash.renderCall({ command }, passthroughTheme, { args: { command } }));
		const collapsed = renderToolResult(bash, textResult("dummy-secret"), { expanded: false, isPartial: false }, { args: { command } });
		assert.equal(gentleAiRoutineCommand({ command }), "review", command);
		assert.match(call, /🌹 rdd running · status/, command);
		assert.match(collapsed, /dummy-secret/, command);
	}

	const command = "env FOO=bar command -- gentle-ai review status";
	assert.equal(gentleAiRoutineCommand({ command }), undefined);
	assertGenericBash(bash, command);
});

test("quiet tool rendering lets a final result promote a replayed call card to its outcome", async () => {
	// The promotion invalidates after the render returns (a microtask), never inside it.
	const flush = () => new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	const tool = tools.get("bash");
	const command = "gentle-ai review status";
	const state = {};
	let invalidations = 0;
	const replayed = routineRenderContext({ args: { command }, state, argsComplete: false, executionStarted: false, isPartial: false, invalidate: () => { invalidations += 1; } });

	const call = tool.renderCall({ command }, statusTheme, replayed);
	assert.equal(cardTitle(renderToString(call)), "🌹 rdd preparing · status");
	renderToString(tool.renderResult(textResult("done"), { expanded: false, isPartial: false }, statusTheme, replayed));
	assert.equal(invalidations, 0, "never reentrant");
	await flush();
	assert.equal(invalidations, 1);
	const promoted = tool.renderCall({ command }, statusTheme, { ...replayed, lastComponent: call });
	assert.strictEqual(promoted, call);
	assert.equal(cardTitle(renderToString(promoted)), "🌹 rdd status");
	assert.equal(cardTone(renderToString(promoted)), "success");

	renderToString(tool.renderResult(textResult("boom"), { expanded: false, isPartial: false }, statusTheme, { ...replayed, isError: true }));
	await flush();
	assert.equal(invalidations, 2);
	assert.equal(cardTitle(renderToString(tool.renderCall({ command }, statusTheme, { ...replayed, lastComponent: call }))), "🌹 rdd failed · status");
	renderToString(tool.renderResult(textResult("boom"), { expanded: false, isPartial: false }, statusTheme, { ...replayed, isError: true }));
	await flush();
	assert.equal(invalidations, 2, "an unchanged outcome must not request another render");
});

test("quiet tool rendering puts the expand key in the finished call card's top rule, not in the result", () => {
	const { pi, tools } = createPi();
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	const tool = tools.get("bash");
	const command = "gentle-ai review status";
	const running = renderToString(tool.renderCall({ command }, passthroughTheme, routineRenderContext({ args: { command }, executionStarted: true, isPartial: true })));
	assert.equal(cardHint(running), undefined, "a running call has nothing to expand yet");
	const completed = renderToString(tool.renderCall({ command }, passthroughTheme, routineRenderContext({ args: { command }, executionStarted: true, isPartial: false, expanded: false })));
	assert.match(cardHint(completed) ?? "", /to expand$/);
	assert.equal(cardTitle(completed), "🌹 rdd status");
	const expanded = renderToString(tool.renderCall({ command }, passthroughTheme, routineRenderContext({ args: { command }, executionStarted: true, isPartial: false, expanded: true })));
	assert.match(cardHint(expanded) ?? "", /to collapse$/);
	const collapsedResult = renderToolResult(tool, textResult("{\"next_transition\":\"stop\"}"), { expanded: false, isPartial: false }, { args: { command } });
	assert.equal(cardBody(collapsedResult), "stop");
	assert.equal(cardBody(renderToolResult(tool, textResult("a\nb\nc"), { expanded: false, isPartial: false }, { args: { command } })), "a\nb\nc");
	assert.match(collapsedResult.split("\n").pop() ?? "", /╰─+╯$/);
});

test("long finished quiet headings retain the applicable expansion hint and complete command", () => {
	const tool = registeredQuietTools().get("bash");
	const command = "printf alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango";
	const args = { command };
	for (const expanded of [false, true]) {
		const hint = keyHint("app.tools.expand", expanded ? "to collapse" : "to expand").replace(/\x1b\[[\d;]*m/g, "");
		const ctx = routineRenderContext({ args, executionStarted: true, isPartial: false, expanded });
		for (const width of [80, 120]) {
			const rows = frameLines(tool.renderCall(args, passthroughTheme, ctx), width);
			assert.ok(rows[0].endsWith(` ${hint} ╮`), `width ${width}: applicable hint must survive heading wrapping`);
			assert.ok(rows.length > 1);
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
			const first = rows[0].slice("╭─ $ ".length).split(" ─")[0];
			const rest = rows.slice(1).map((row) => row.replace(/^│ /, "").replace(/ +│$/, ""));
			assert.equal([first, ...rest].join(" ").replace(/\s+/g, " ").trim(), `bash $ ${command}`);
		}
	}
});

test("quiet components repaint after theme invalidation and retain transparent error frames", (t) => {
	const found = cardStyle();
	t.after(() => setCardStyle(found));
	setCardStyle(CARD_STYLE.NEON);
	const bash = registeredQuietTools().get("bash");
	let paint = "\x1b[31m";
	const theme = { bold: (text: string) => text, fg: (_role: string, text: string) => `${paint}${text}\x1b[0m`, bg: (_role: string, text: string) => `\x1b[44m${text}\x1b[49m` };
	const args = { command: "printf failure" };
	const context = routineRenderContext({ args, isError: true, isPartial: false });
	const components = [bash.renderCall(args, theme, context), bash.renderResult(textResult("denied\nreason"), { expanded: false, isPartial: false }, theme, context)];
	const first = components.flatMap((component) => component.render(80)).join("\n");
	paint = "\x1b[35m";
	for (const component of components) component.invalidate();
	const changed = components.flatMap((component) => component.render(80)).join("\n");
	assert.match(first, /\x1b\[31m/);
	assert.doesNotMatch(changed, /\x1b\[31m|\x1b\[44m/);
	assert.match(changed, /\x1b\[35m/);
	assert.equal(first.replace(/\x1b\[[\d;]*m/g, ""), changed.replace(/\x1b\[[\d;]*m/g, ""));
});

test("six quiet cards and standalone Bash fixture retain distinct identity and bounded results", () => {
	const tools = registeredQuietTools();
	for (const [name, glyph] of [["read", "≡"], ["bash", "$"], ["grep", "⌕"], ["find", "⌖"], ["ls", "☷"], ["edit", "✎"], ["write", "+"]] as const) {
		const tool = tools.get(name);
		const args = { command: "printf hello", path: "src/example.ts", pattern: "needle" };
		const ctx = routineRenderContext({ args, isPartial: false, executionStarted: true });
		const header = frameLines(tool.renderCall(args, passthroughTheme, ctx), 120).join("\n");
		assert.ok(header.startsWith(`╭─ ${glyph} ${name} `), `${name} retains its distinct icon and actual identity`);
		assert.match(header, /to expand/);
		const value = textResult("useful row\nsecond row", name === "edit" ? { diff: "-before\n+after" } : undefined);
		const body = frameLines(tool.renderResult(value, { expanded: false, isPartial: false }, passthroughTheme, ctx), 120).join("\n");
		if (name !== "write") assert.match(body, name === "edit" ? /before|after/ : /useful row/);
		for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8, 24]) {
			const rows = frameLines(tool.renderResult(textResult("界e\u0301🌹".repeat(80)), { expanded: false, isPartial: false }, passthroughTheme, ctx), width);
			assert.ok(rows.length <= 4);
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
			assert.equal(rows.filter((row) => row.startsWith("╰")).length, width ? 1 : 0);
		}
	}
});

test("quiet tool calls draw a rounded petal card in the lifecycle tone", () => {
	const tools = registeredQuietTools();
	const bash = tools.get("bash");
	const args = { command: "printf output" };
	const width = 30;

	const header = bash.renderCall(args, passthroughTheme, routineRenderContext({ args, isPartial: false })).render(width);
	assert.deepEqual(header, [`╭─ $ bash $ printf output ${"─".repeat(3)}╮`]);
	const running = bash.renderCall(args, statusTheme, routineRenderContext({ args, executionStarted: true, isPartial: true })).render(width);
	assert.match(running[0] ?? "", /^<warning>╭<\/warning><warning>─ <\/warning><warning>\$ (?:<toolTitle>)?bash/);
	assert.match(bash.renderCall(args, statusTheme, routineRenderContext({ args, isPartial: false, isError: true })).render(width)[0] ?? "", /^<error>╭<\/error>/);

	const expanded = bash.renderResult(textResult("alpha\nbeta"), { expanded: true, isPartial: false }, passthroughTheme, { args }).render(width);
	assert.deepEqual(expanded, [
		`│ alpha${" ".repeat(21)} │`,
		`│ beta${" ".repeat(22)} │`,
		`╰${"─".repeat(28)}╯`,
	]);
	const failed = bash.renderResult(textResult("boom"), { expanded: true, isPartial: false, isError: true }, statusTheme, { args, isError: true }).render(width);
	assert.match(failed.at(-1) ?? "", /^<error>╰<\/error><error>─+╯<\/error>$/);
	assert.ok(failed.slice(0, -1).every((line) => line.startsWith("<error>│</error> ")), failed.join("\n"));

	const empty = tools.get("grep").renderResult(textResult("No matches found"), { expanded: false, isPartial: false }, passthroughTheme, {}).render(width);
	assert.deepEqual(empty, [`╰${"─".repeat(28)}╯`], "an empty result still closes the card");

	// The expand key rides the top rule once the call finished, like the Gentle AI card.
	const wide = 80;
	const expandKey = keyHint("app.tools.expand", "to expand").replace(/\x1b\[[0-9;]*m/g, "");
	const finishedTop = bash.renderCall(args, passthroughTheme, routineRenderContext({ args, executionStarted: true, isPartial: false })).render(wide)[0] ?? "";
	assert.ok(finishedTop.endsWith(` ${expandKey} ╮`), finishedTop);
	const expandedTop = bash.renderCall(args, passthroughTheme, routineRenderContext({ args, executionStarted: true, isPartial: false, expanded: true })).render(wide)[0] ?? "";
	assert.match(expandedTop, /to collapse ╮$/);
	const runningTop = bash.renderCall(args, passthroughTheme, routineRenderContext({ args, executionStarted: true, isPartial: true })).render(wide)[0] ?? "";
	assert.ok(!runningTop.includes("to expand"), runningTop);
	const collapsedBody = bash.renderResult(textResult("alpha\nbeta"), { expanded: false, isPartial: false }, passthroughTheme, { args }).render(wide);
	assert.ok(!collapsedBody.some((line) => line.includes("to expand")), "the body no longer carries the expand key");

	for (const narrow of [1, 2, 3, 4, 5, 8]) {
		const lines = [
			...bash.renderCall({ command: "printf " + "x".repeat(80) }, passthroughTheme, routineRenderContext({ args, isPartial: false })).render(narrow),
			...bash.renderResult(textResult("😀".repeat(40)), { expanded: true, isPartial: false }, passthroughTheme, { args }).render(narrow),
		];
		for (const line of lines) assert.ok(visibleWidth(line) <= narrow, `width ${narrow}: ${JSON.stringify(line)}`);
	}
});

// Pi builds the call component, then the result component once a result
// exists, and only then renders them; both share one row state.
function piToolRow(tool: any, args: Record<string, unknown>, value: unknown, context: Record<string, unknown>, width: number, theme: object = passthroughTheme): string[] {
	const call = tool.renderCall(args, theme, context);
	const body = value ? tool.renderResult(value, { expanded: context.expanded === true, isPartial: context.isPartial === true }, theme, context) : undefined;
	return [...call.render(width), ...(body?.render(width) ?? [])];
}

test("a running quiet card closes its own frame with one running row until a result exists", () => {
	const tools = registeredQuietTools();
	const read = tools.get("read");
	const args = { path: "a.md" };
	const pending = () => routineRenderContext({ args, executionStarted: true, isPartial: true, state: {} });
	const running = piToolRow(read, args, undefined, pending(), 40);
	assert.deepEqual(running, [
		`╭─ ≡ read a.md ${"─".repeat(24)}╮`,
		`│ running…${" ".repeat(28)} │`,
		`╰${"─".repeat(38)}╯`,
	]);
	const painted = piToolRow(read, args, undefined, pending(), 40, statusTheme).join("\n");
	assert.match(painted, /<muted>running…<\/muted>/);
	assert.match(painted, /<warning>╰<\/warning>/);
	for (const width of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
		const rows = piToolRow(read, args, undefined, pending(), width);
		assert.ok(rows.every((row) => visibleWidth(row) <= width), `width ${width}`);
		// Narrow headings may continue on rows below the top rule; the frame still closes once.
		assert.equal(rows.filter((row) => row.startsWith("╰")).length, width === 0 ? 0 : 1);
		if (width > 0) assert.ok(rows.at(-1)!.startsWith("╰"), `width ${width}: ${rows.join("\n")}`);
	}

	// A partial result below the call closes the frame instead: one bottom rule, no running row.
	const bash = tools.get("bash");
	const bashArgs = { command: "printf output" };
	const partial = piToolRow(bash, bashArgs, textResult("out"), routineRenderContext({ args: bashArgs, executionStarted: true, isPartial: true, state: {} }), 40);
	assert.equal(partial.filter((row) => row.startsWith("╭")).length, 1);
	assert.equal(partial.filter((row) => row.startsWith("╰")).length, 1);
	assert.match(partial.at(-1)!, /^╰─+╯$/);
	assert.doesNotMatch(partial.join("\n"), /running…/);

	// A finished call keeps its open top rule; the result closes the card.
	const finished = piToolRow(read, args, textResult("one"), routineRenderContext({ args, executionStarted: true, isPartial: false, state: {} }), 40);
	assert.equal(finished.length, 3);
	assert.match(finished[0]!, /^╭─ ≡ read a\.md .*╮$/);
	assert.match(finished[1]!, /^│ one +│$/);
	assert.match(finished[2]!, /^╰─+╯$/);
});



// Float style: the call and result components of one quiet card read as one
// borderless panel. The heading owns the blank row above it; the result owns
// the separator below the heading and the blank closing row.
const floatToolTheme = {
	bold(value: string) {
		return value;
	},
	fg(_color: string, value: string) {
		return `\x1b[38;5;114m${value}\x1b[39m`;
	},
	bg(color: string, value: string) {
		return `\x1b[48;5;${color === "toolErrorBg" ? 52 : color === "toolPendingBg" ? 58 : 22}m${value}\x1b[49m`;
	},
};

function withFloatCards<T>(run: () => T): T {
	setCardStyle(CARD_STYLE.FLOAT);
	try {
		return run();
	} finally {
		setCardStyle(CARD_STYLE.NEON);
	}
}

test("float quiet cards render the call and result as one panel with a single separator", () => {
	const tools = registeredQuietTools();
	const read = tools.get("read");
	const context = routineRenderContext({ args: { path: "package.json" }, isPartial: false, executionStarted: true });
	const width = 60;
	const rows = withFloatCards(() => [
		...read.renderCall({ path: "package.json" }, floatToolTheme, context).render(width),
		...read.renderResult(textResult("{\n  \"name\": \"gentle-pi\""), { expanded: false, isPartial: false }, floatToolTheme, context).render(width),
	]);
	const plain = rows.map(stripAnsi);
	for (const line of rows) {
		assert.equal(visibleWidth(line), width);
		assert.ok(line.startsWith(" \x1b[48;5;22m"), JSON.stringify(line));
		assert.ok(line.endsWith("\x1b[49m "), JSON.stringify(line));
	}
	assert.doesNotMatch(plain.join("\n"), /[╭╮╰╯│─]/);
	assert.match(plain[0]!, /^ ▎ +$/);
	assert.match(plain[1]!, /^ ▎ ≡ read package\.json +.*to expand {4}$/);
	assert.match(plain[2]!, /^ ▎ +$/);
	assert.match(plain[3]!, /^ ▎ \{ +$/);
	assert.match(plain[4]!, /^ ▎ {3}"name": "gentle-pi" +$/);
	assert.match(plain.at(-1)!, /^ ▎ +$/);
	assert.equal(plain.length, 6);
	assert.equal(plain[1]!.indexOf("≡"), plain[3]!.indexOf("{"), "the glyph starts in the body text column");
});

test("float quiet cards close a running call as one panel and add no separator without result rows", () => {
	const tools = registeredQuietTools();
	const read = tools.get("read");
	const running = withFloatCards(() => read.renderCall({ path: "a.md" }, floatToolTheme, routineRenderContext({ args: { path: "a.md" }, state: {} })).render(40)).map(stripAnsi);
	assert.equal(running.length, 5, "blank row, heading, separator, running row, closing row");
	assert.match(running[0]!, /^ ▎ +$/);
	assert.match(running[1]!, /^ ▎ ≡ read a\.md +$/);
	assert.match(running[2]!, /^ ▎ +$/);
	assert.match(running[3]!, /^ ▎ running… +$/);
	assert.match(running[4]!, /^ ▎ +$/);
	assert.doesNotMatch(running.join("\n"), /[╭╮╰╯│─]/);
	const empty = withFloatCards(() => read.renderResult(textResult(""), { expanded: false, isPartial: false }, floatToolTheme, routineRenderContext({ isPartial: false })).render(40)).map(stripAnsi);
	assert.deepEqual(empty, [` ▎${" ".repeat(37)} `], "an empty result only closes the panel");
});

test("quiet cards stay outlined in the neon style with a background-capable theme", () => {
	const tools = registeredQuietTools();
	const read = tools.get("read");
	const context = routineRenderContext({ args: { path: "a.md" }, isPartial: false, executionStarted: true });
	const rows = [
		...read.renderCall({ path: "a.md" }, floatToolTheme, context).render(40),
		...read.renderResult(textResult("one"), { expanded: false, isPartial: false }, floatToolTheme, context).render(40),
	].map(stripAnsi);
	assert.match(rows[0]!, /^╭─ ≡ read a\.md/);
	assert.match(rows.at(-1)!, /^╰─+╯$/);
	assert.doesNotMatch(rows.join("\n"), /▎/);
});

// The Card content slot is process-wide; each test that needs a level sets it
// and restores the previous one.
function useCardContent(t: { after(fn: () => void): void }, level: (typeof CARD_CONTENT)[keyof typeof CARD_CONTENT]): void {
	const previous = cardContent();
	t.after(() => setCardContent(previous));
	setCardContent(level);
}

test("the Card content preference defaults to the result previews", () => {
	assert.equal(cardContent(), CARD_CONTENT.DEFAULT);
	const rendered = renderToolResult(registeredQuietTools().get("read"), textResult("first line\nsecond line"), { expanded: false, isPartial: false }, {});
	assert.match(rendered, /first line/);
});

test("minimal command-only cards keep the bounded error tail of failed calls", (t) => {
	useCardContent(t, CARD_CONTENT.MINIMAL);
	const tools = registeredQuietTools();
	for (const toolName of ["read", "bash", "write", "grep", "find", "ls", "edit"] as const) {
		const rendered = renderToolResult(tools.get(toolName), textResult("error one\nerror two\nerror three\nerror four"), { expanded: false, isPartial: false, isError: true }, toolName === "bash" ? { args: { command: "false" } } : {});
		assert.match(rendered, /error two\nerror three\nerror four/, `${toolName}: a failed call says why while collapsed`);
		assert.doesNotMatch(rendered, /to expand/);
	}
});

test("every quiet tool card shows only the command while collapsed and stays expandable", (t) => {
	useCardContent(t, CARD_CONTENT.MINIMAL);
	const tools = registeredQuietTools();
	const finished = { isPartial: false, executionStarted: true };
	const cases: Array<[string, Record<string, unknown>, string, string]> = [
		["read", { path: "a.ts" }, "first line\nsecond line", "first line"],
		["write", { path: "b.ts", content: "body" }, "Successfully wrote 4 bytes", "body"],
		["bash", { command: "printf hi" }, "hi\nthere", "there"],
		["grep", { pattern: "needle", path: "src" }, "src/a.ts:1:needle", "src/a.ts:1:needle"],
		["find", { pattern: "*.ts", path: "src" }, "src/a.ts\nsrc/b.ts", "src/b.ts"],
		["ls", { path: "src" }, "file-a.ts\nfile-b.ts", "file-b.ts"],
		["edit", { path: "file.ts", edits: [] }, "Applied edits", "Applied edits"],
	];
	for (const [name, args, output, visible] of cases) {
		const tool = tools.get(name);
		const context = routineRenderContext({ args, ...finished });
		const callRows = tool.renderCall(args, passthroughTheme, context).render(120).map(stripAnsi);
		assert.ok(callRows.some((row) => row.includes("to expand")), `${name}: the expand key stays`);
		const collapsed = renderToString(tool.renderResult(textResult(output), { expanded: false, isPartial: false }, passthroughTheme, context));
		assert.equal(collapsed.trim(), "", `${name}: no result rows while collapsed`);
		const expanded = renderToString(tool.renderResult(textResult(output), { expanded: true, isPartial: false }, passthroughTheme, context));
		assert.match(expanded, new RegExp(visible.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${name}: expanding reveals the result`);
	}
});

test("the default Card content preference restores result previews and native bash drawing", () => {
	const tools = registeredQuietTools();
	const read = tools.get("read");
	setCardContent(CARD_CONTENT.DEFAULT);
	try {
		const context = routineRenderContext({ args: { path: "a.ts" }, executionStarted: true, isPartial: false });
		const collapsed = renderToString(read.renderResult(textResult("first line\nsecond line"), { expanded: false, isPartial: false }, passthroughTheme, context));
		assert.match(collapsed, /first line\nsecond line/, "default content keeps the read preview");
		const write = renderToString(tools.get("write").renderResult(textResult("Successfully wrote 4 bytes"), { expanded: false, isPartial: false }, passthroughTheme, routineRenderContext({ args: { path: "b.ts", content: "body" }, executionStarted: true, isPartial: false })));
		assert.match(write, /wrote 4 bytes/, "default content keeps the write summary");

		const { pi } = createPi();
		const resolvers: Array<(toolName: string, next: () => unknown) => unknown> = [];
		(pi as any).registerToolRenderer = (resolver: (toolName: string, next: () => unknown) => unknown) => {
			resolvers.push(resolver);
		};
		withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
		const native = { marker: "native" };
		assert.equal(resolvers.at(-1)!("bash", () => native), native, "default content defers bash drawing to the native renderer");
		assert.equal(resolvers.at(-1)!("read", () => native), native, "every other tool still defers");
	} finally {
		setCardContent(CARD_CONTENT.DEFAULT);
	}
});

test("the production factory takes over native bash drawing through a tool renderer resolver", (t) => {
	useCardContent(t, CARD_CONTENT.MINIMAL);
	const { pi } = createPi();
	const resolvers: Array<(toolName: string, next: () => unknown) => unknown> = [];
	(pi as any).registerToolRenderer = (resolver: (toolName: string, next: () => unknown) => unknown) => {
		resolvers.push(resolver);
	};
	withEnv({ GENTLE_PI_QUIET_TOOLS: undefined }, () => quietTools(pi as any));
	assert.ok(resolvers.length >= 1, "quiet tools registers a tool renderer resolver");
	const resolver = resolvers.at(-1)!;
	const native = { marker: "native" };
	assert.equal(resolver("read", () => native), native, "every other tool keeps the next renderer");
	const bash = resolver("bash", () => native) as any;
	assert.notEqual(bash, native);
	assert.equal(bash.renderShell, "self");
	assert.equal(typeof bash.renderCall, "function");
	assert.equal(typeof bash.renderResult, "function");
	const call = bash.renderCall({ command: "printf hi", timeout: 5 }, passthroughTheme, routineRenderContext({ args: { command: "printf hi", timeout: 5 }, executionStarted: true, isPartial: false }));
	assert.match(renderToString(call), /printf hi \(timeout 5s\)/);
});

