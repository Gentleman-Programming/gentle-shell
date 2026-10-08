import assert from "node:assert/strict";
import test from "node:test";
import {
	ALLOWED_READONLY_EXTENSIONS,
	type SubagentSpecialization,
	TASK_STATUS,
	TaskStore,
} from "../lib/agents-protocol.ts";
import {
	childArguments,
	childSystemPrompt,
	composeSpecializationPrompt,
	validateSpecializationSandbox,
	AgentRunner,
	type TaskRequest,
	type RunnerDeps,
} from "../lib/agents-runner.ts";
import {
	agentOperationSubtitle,
	renderAgentBadge,
	renderGentleAgentCall,
	AGENT_LIFECYCLE_STATUS,
} from "../lib/agents-renderer.ts";
import { parseSpecialization } from "../extensions/gentle-agents.ts";
import { AGENT_MODE, type AgentDefinition } from "../lib/agents-config.ts";
import { fakeChild } from "./agents-fake-child.ts";

const readOnlyExplorer: AgentDefinition = {
	name: "gentle-ai-explore",
	description: "Read-only exploration and mapping",
	filePath: "/a/gentle-ai-explore.md",
	scope: "global",
	instructions: "You are the read-only explorer for generic non-SDD work.",
	model: undefined,
	thinking: undefined,
	mode: undefined,
	tools: ["read", "grep", "find", "codegraph"],
};

const mutatingWorker: AgentDefinition = {
	name: "gentle-ai-worker",
	description: "Implementation writer",
	filePath: "/a/gentle-ai-worker.md",
	scope: "global",
	instructions: "You are the package-owned implementation writer.",
	model: undefined,
	thinking: undefined,
	mode: undefined,
	tools: ["read", "grep", "find", "edit", "write", "bash", "mem_save"],
};

function baseRequest(overrides: Partial<TaskRequest> = {}): TaskRequest {
	return {
		agent: readOnlyExplorer,
		prompt: "Explore the codebase",
		label: undefined,
		context: undefined,
		mode: AGENT_MODE.TASK,
		cwd: "/repo",
		parentSessionId: "s1",
		model: { provider: "openai-codex", id: "gpt-5.6-terra" },
		thinking: "high",
		sessionDir: "/sessions",
		resumeSessionPath: undefined,
		env: {},
		...overrides,
	};
}

test("ALLOWED_READONLY_EXTENSIONS contains all whitelisted read-only tools", () => {
	const expected = [
		"read_symbol",
		"read_enclosing",
		"lens_diagnostics",
		"web_search",
		"fetch_content",
		"source_check",
		"ast_grep_search",
		"ast_grep_outline",
	];
	for (const tool of expected) {
		assert.ok(
			ALLOWED_READONLY_EXTENSIONS.includes(tool),
			`Missing expected read-only tool: ${tool}`,
		);
	}
});

test("parseSpecialization parses valid specialization and validates inputs", () => {
	assert.equal(parseSpecialization(undefined), undefined);

	const validFull: SubagentSpecialization = {
		label: "ODD Architect",
		instructionsOverlay: "Focus on Part 1 and Part 2 contracts",
		extraTools: ["read_symbol", "lens_diagnostics"],
		outputContract: "Return diagnosis and specifications",
	};
	const parsed = parseSpecialization(validFull);
	assert.deepEqual(parsed, validFull);

	const validMinimal = {
		instructionsOverlay: "Focus on performance bottleneck analysis",
	};
	assert.deepEqual(parseSpecialization(validMinimal), {
		instructionsOverlay: "Focus on performance bottleneck analysis",
	});

	// Invalid cases throw
	assert.throws(() => parseSpecialization("not-an-object"), /must be an object/);
	assert.throws(() => parseSpecialization({}), /requires non-empty instructionsOverlay/);
	assert.throws(
		() => parseSpecialization({ instructionsOverlay: "   " }),
		/requires non-empty instructionsOverlay/,
	);
	assert.throws(
		() => parseSpecialization({ instructionsOverlay: "ok", label: 123 }),
		/label must be a string/,
	);
	assert.throws(
		() => parseSpecialization({ instructionsOverlay: "ok", outputContract: 123 }),
		/outputContract must be a string/,
	);
	assert.throws(
		() => parseSpecialization({ instructionsOverlay: "ok", extraTools: "read_symbol" }),
		/extraTools must be an array of strings/,
	);
	assert.throws(
		() => parseSpecialization({ instructionsOverlay: "ok", extraTools: [123] }),
		/extraTools must be an array of strings/,
	);
});

test("validateSpecializationSandbox enforces read-only base invariant", () => {
	// Read-only agent with allowed tools succeeds
	assert.doesNotThrow(() => {
		validateSpecializationSandbox(readOnlyExplorer, {
			instructionsOverlay: "Trace call graph",
			extraTools: ["read_symbol", "lens_diagnostics", "ast_grep_search"],
		});
	});

	// Read-only agent without extraTools succeeds
	assert.doesNotThrow(() => {
		validateSpecializationSandbox(readOnlyExplorer, {
			instructionsOverlay: "Trace call graph",
		});
	});

	// Read-only agent attempting write tool throws
	assert.throws(
		() => {
			validateSpecializationSandbox(readOnlyExplorer, {
				instructionsOverlay: "Mutate code",
				extraTools: ["write"],
			});
		},
		/Specialization tool "write" is not allowed for read-only agent "gentle-ai-explore"/,
	);

	// Read-only agent attempting edit tool throws
	assert.throws(
		() => {
			validateSpecializationSandbox(readOnlyExplorer, {
				instructionsOverlay: "Mutate code",
				extraTools: ["edit"],
			});
		},
		/Specialization tool "edit" is not allowed for read-only agent "gentle-ai-explore"/,
	);

	// Read-only agent attempting arbitrary unwhitelisted tool throws
	assert.throws(
		() => {
			validateSpecializationSandbox(readOnlyExplorer, {
				instructionsOverlay: "Run shell",
				extraTools: ["bash"],
			});
		},
		/Specialization tool "bash" is not allowed for read-only agent "gentle-ai-explore"/,
	);

	// Mutating worker is not restricted by read-only sandbox invariant
	assert.doesNotThrow(() => {
		validateSpecializationSandbox(mutatingWorker, {
			instructionsOverlay: "Perform refactor",
			extraTools: ["custom_tool"],
		});
	});
});

test("composeSpecializationPrompt generates correctly formatted overlay block", () => {
	const specialization: SubagentSpecialization = {
		label: "ODD Architect",
		instructionsOverlay: "Map architectural boundaries and settle contracts.",
		outputContract: "1. Diagnosis, 2. Technical Specification & Contracts",
	};

	const overlay = composeSpecializationPrompt(specialization);
	assert.ok(overlay.includes("## DYNAMIC SPECIALIZATION OVERLAY (Active for this execution)"));
	assert.ok(overlay.includes("- Specialized Role: ODD Architect"));
	assert.ok(overlay.includes("- Specific Directives: Map architectural boundaries and settle contracts."));
	assert.ok(overlay.includes("- Output Contract: 1. Diagnosis, 2. Technical Specification & Contracts"));
	assert.ok(overlay.includes("Respect this specialization as your primary lens while strictly adhering to your base constraints."));

	// Minimal specialization without label or outputContract
	const minimal: SubagentSpecialization = {
		instructionsOverlay: "Trace SQL query latency",
	};
	const minimalOverlay = composeSpecializationPrompt(minimal);
	assert.ok(minimalOverlay.includes("## DYNAMIC SPECIALIZATION OVERLAY (Active for this execution)"));
	assert.ok(!minimalOverlay.includes("- Specialized Role:"));
	assert.ok(minimalOverlay.includes("- Specific Directives: Trace SQL query latency"));
	assert.ok(!minimalOverlay.includes("- Output Contract:"));
});

test("childSystemPrompt and childArguments merge base prompt with specialization", () => {
	const specialization: SubagentSpecialization = {
		label: "Security Auditor",
		instructionsOverlay: "Audit authentication flow for timing attacks.",
		extraTools: ["read_symbol"],
		outputContract: "Vulnerability analysis report",
	};

	const req = baseRequest({ specialization });
	const prompt = childSystemPrompt(req);

	assert.ok(prompt.startsWith("You are the read-only explorer for generic non-SDD work."));
	assert.ok(prompt.includes("## DYNAMIC SPECIALIZATION OVERLAY (Active for this execution)"));
	assert.ok(prompt.includes("- Specialized Role: Security Auditor"));
	assert.ok(prompt.includes("- Specific Directives: Audit authentication flow for timing attacks."));
	assert.ok(prompt.includes("- Output Contract: Vulnerability analysis report"));

	const args = childArguments(req);
	const promptIndex = args.indexOf("--append-system-prompt");
	assert.ok(promptIndex >= 0);
	assert.equal(args[promptIndex + 1], prompt);

	const toolsIndex = args.indexOf("--tools");
	assert.ok(toolsIndex >= 0);
	const toolsList = args[toolsIndex + 1].split(",");
	assert.ok(toolsList.includes("read"));
	assert.ok(toolsList.includes("read_symbol"));
	assert.ok(toolsList.includes("subagent_parent_message"));
});

test("childArguments fails fast if specialization violates read-only sandbox", () => {
	const req = baseRequest({
		specialization: {
			instructionsOverlay: "Try to edit files",
			extraTools: ["edit"],
		},
	});

	assert.throws(() => {
		childArguments(req);
	}, /Specialization tool "edit" is not allowed for read-only agent/);
});

test("AgentRunner attaches specialization to TaskRecord and enforces sandbox", () => {
	const store = new TaskStore();
	const deps: RunnerDeps = {
		spawn: () => fakeChild().child,
		now: () => 1000,
		schedule: () => () => {},
		pi: { command: "pi", args: [] },
	};
	const runner = new AgentRunner(store, { maxConcurrency: 1, stallTimeoutMs: 10_000 }, deps, {
		askUser: async () => ({ value: "yes" }),
	});

	const specialization: SubagentSpecialization = {
		label: "A11y Inspector",
		instructionsOverlay: "Inspect ARIA roles",
		extraTools: ["read_symbol"],
	};
	const req = baseRequest({ specialization });
	const task = runner.run(req);

	assert.equal(task.agent, "gentle-ai-explore");
	assert.deepEqual(task.specialization, specialization);

	// Attempting runner.run with sandbox violation throws immediately
	const badReq = baseRequest({
		specialization: {
			instructionsOverlay: "Malicious injection",
			extraTools: ["write"],
		},
	});
	assert.throws(() => {
		runner.run(badReq);
	}, /Specialization tool "write" is not allowed for read-only agent/);
});

test("renderAgentBadge renders <agent-name> ▸ [<specialization-label>]", () => {
	assert.equal(
		renderAgentBadge("gentle-ai-explore", { label: "ODD Architect" }),
		"gentle-ai-explore ▸ [ODD Architect]",
	);
	assert.equal(
		renderAgentBadge("gentle-ai-explore", { label: "" }),
		"gentle-ai-explore",
	);
	assert.equal(
		renderAgentBadge("gentle-ai-explore", undefined),
		"gentle-ai-explore",
	);
});

test("agentOperationSubtitle and renderGentleAgentCall display specialization badge", () => {
	const subtitle = agentOperationSubtitle(
		"run",
		{
			agent: "gentle-ai-explore",
			label: "map auth contracts",
			specialization: { label: "ODD Architect" },
		},
		AGENT_LIFECYCLE_STATUS.RUNNING,
	);
	assert.equal(
		subtitle,
		"running · gentle-ai-explore ▸ [ODD Architect] · map auth contracts",
	);

	const card = renderGentleAgentCall(
		"run",
		{
			agent: "gentle-ai-explore",
			specialization: { label: "Security Auditor" },
		},
		{ fg: (_c, t) => t },
		{ executionStarted: true, isPartial: true },
	);
	const rendered = card.render(80).join("\n");
	assert.ok(
		rendered.includes("gentle-ai-explore ▸ [Security Auditor]"),
		`Card rendering should contain badge: ${rendered}`,
	);
});
