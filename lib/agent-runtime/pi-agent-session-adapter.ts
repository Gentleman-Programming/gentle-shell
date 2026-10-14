import {
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionOptions,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { posix, win32 } from "node:path";

const SPECIFICATION_KEYS = [
	"ownerCwd",
	"systemPrompt",
	"model",
	"modelRegistry",
	"thinkingLevel",
	"tools",
] as const;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

type Specification = {
	ownerCwd: string;
	systemPrompt: string;
	model: NonNullable<CreateAgentSessionOptions["model"]>;
	modelRegistry: NonNullable<CreateAgentSessionOptions["modelRegistry"]>;
	thinkingLevel: NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;
	tools: string[];
};
type CreateSession = (options: CreateAgentSessionOptions) => Promise<unknown>;
type FailureCode = "invalid-spec" | "session-creation-failed" | "session-contract-failed" | "cleanup-failed";
export type PiAgentSessionPreparationResult =
	| Readonly<{ kind: "ready"; session: AgentSession }>
	| Readonly<{ kind: "failed"; code: FailureCode }>;

function failed(code: FailureCode): PiAgentSessionPreparationResult {
	return Object.freeze({ kind: "failed", code });
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function isPlainObject(value: unknown): value is object {
	if (!isObject(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isNonArrayObject(value: unknown): value is object {
	return isObject(value) && !Array.isArray(value);
}

function isAbsolutePath(value: string): boolean {
	return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function hasExactKeys(value: object): boolean {
	const keys = Reflect.ownKeys(value);
	if (keys.length !== SPECIFICATION_KEYS.length) return false;
	return keys.every((key) => typeof key === "string" && SPECIFICATION_KEYS.includes(key as typeof SPECIFICATION_KEYS[number]));
}

function readDataValues(value: object, keys: readonly string[]): unknown[] | undefined {
	const descriptors = keys.map((key) => Object.getOwnPropertyDescriptor(value, key));
	if (descriptors.some((descriptor) => descriptor === undefined || !("value" in descriptor))) return undefined;
	return descriptors.map((descriptor) => descriptor.value);
}

function readTools(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== value.length + 1) return undefined;
	if (keys.some((key, index) => key !== "length" && key !== String(index))) return undefined;
	const tools = readDataValues(value, Array.from({ length: value.length }, (_, index) => String(index)));
	if (tools === undefined || tools.some((tool) => typeof tool !== "string" || !TOOL_NAMES.has(tool))) return undefined;
	if (new Set(tools).size !== tools.length) return undefined;
	return tools as string[];
}

function readSpecification(value: unknown): Specification | undefined {
	try {
		if (!isPlainObject(value) || !hasExactKeys(value)) return undefined;
		const values = readDataValues(value, SPECIFICATION_KEYS);
		if (values === undefined) return undefined;
		const [ownerCwd, systemPrompt, model, modelRegistry, thinkingLevel, suppliedTools] = values;
		if (typeof ownerCwd !== "string" || !isAbsolutePath(ownerCwd) || ownerCwd.includes("\0")) return undefined;
		if (typeof systemPrompt !== "string" || systemPrompt.trim() === "") return undefined;
		if (!isNonArrayObject(model) || !isNonArrayObject(modelRegistry)) return undefined;
		if (typeof thinkingLevel !== "string" || !THINKING_LEVELS.has(thinkingLevel)) return undefined;
		const tools = readTools(suppliedTools);
		if (tools === undefined) return undefined;
		return {
			ownerCwd,
			systemPrompt,
			model: model as Specification["model"],
			modelRegistry: modelRegistry as Specification["modelRegistry"],
			thinkingLevel: thinkingLevel as Specification["thinkingLevel"],
			tools,
		};
	} catch {
		return undefined;
	}
}

function createResourceLoader(systemPrompt: string): ResourceLoader {
	const runtime = createExtensionRuntime();
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function createOptions(specification: Specification): CreateAgentSessionOptions {
	const tools = Object.freeze([...specification.tools]);
	return Object.freeze({
		cwd: specification.ownerCwd,
		model: specification.model,
		modelRegistry: specification.modelRegistry,
		thinkingLevel: specification.thinkingLevel,
		tools,
		...(tools.length === 0 ? { noTools: "all" as const } : {}),
		customTools: Object.freeze([]),
		resourceLoader: createResourceLoader(specification.systemPrompt),
		sessionManager: SessionManager.inMemory(specification.ownerCwd),
		settingsManager: SettingsManager.inMemory(),
	});
}

function acquireSession(result: unknown): object | undefined {
	try {
		if (!isObject(result)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(result, "session");
		if (descriptor === undefined || !("value" in descriptor) || !isObject(descriptor.value)) return undefined;
		return descriptor.value;
	} catch {
		return undefined;
	}
}

function acquireDispose(session: object): (() => unknown) | undefined {
	try {
		const dispose = (session as { dispose?: unknown }).dispose;
		return typeof dispose === "function" ? dispose : undefined;
	} catch {
		return undefined;
	}
}

function sessionMatchesContract(session: object, tools: readonly string[]): boolean {
	try {
		const prompt = (session as { prompt?: unknown }).prompt;
		const getActiveToolNames = (session as { getActiveToolNames?: unknown }).getActiveToolNames;
		const agent = (session as { agent?: unknown }).agent;
		const sessionFile = (session as { sessionFile?: unknown }).sessionFile;
		if (typeof prompt !== "function" || typeof getActiveToolNames !== "function") return false;
		if (!isObject(agent) || typeof (agent as { subscribe?: unknown }).subscribe !== "function") return false;
		if (sessionFile !== undefined) return false;
		const activeTools = getActiveToolNames.call(session);
		if (!Array.isArray(activeTools) || activeTools.length !== tools.length) return false;
		if (new Set(activeTools).size !== activeTools.length) return false;
		return activeTools.every((tool) => typeof tool === "string" && tools.includes(tool));
	} catch {
		return false;
	}
}

function cleanUp(session: object, dispose: () => unknown): boolean {
	try {
		dispose.call(session);
		return true;
	} catch {
		return false;
	}
}

export async function preparePiAgentSession(
	input: unknown,
	injectedCreateSession?: CreateSession,
): Promise<PiAgentSessionPreparationResult> {
	const specification = readSpecification(input);
	if (specification === undefined) return failed("invalid-spec");

	let options: CreateAgentSessionOptions;
	let result: unknown;
	try {
		options = createOptions(specification);
		result = await (injectedCreateSession ?? createAgentSession)(options);
	} catch {
		return failed("session-creation-failed");
	}

	const session = acquireSession(result);
	if (session === undefined) return failed("session-creation-failed");

	const dispose = acquireDispose(session);
	if (dispose === undefined) return failed("cleanup-failed");
	if (!sessionMatchesContract(session, options.tools ?? [])) {
		return cleanUp(session, dispose) ? failed("session-contract-failed") : failed("cleanup-failed");
	}

	return Object.freeze({ kind: "ready", session: session as AgentSession });
}
