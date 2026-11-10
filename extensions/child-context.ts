import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { filterChildSessionContextFiles, type ContextFileOptions } from "../lib/child-context-files.ts";
import { CHILD_SKILLS_CATALOG_ENV, REQUESTED_TOOLS_ENV } from "../lib/agents-runner.ts";
import { registerCodeGraphTool } from "./codegraph-tools.ts";

// gentle-shell#1587: delegated children drop the orchestrator-only gentle-ai
// managed blocks from their context files and keep a single engram-protocol
// copy, the one nearest to the working directory. Gentle Agents passes this file to
// every child with --extension because children do not load the gentle-pi
// package in the isolated Gentle Shell home. At startup it also supplies the
// existing CodeGraph implementation only when explicitly requested and absent
// (the full package already registers it). Outside a child session it is inert.
export function createChildContextExtension(env: NodeJS.ProcessEnv = process.env): (pi: ExtensionAPI) => void {
	return (pi) => {
		const requested = (env[REQUESTED_TOOLS_ENV] ?? "").split(",").map(name => name.trim());
		if (env.GENTLE_PI_AGENTS_CHILD === "1" && requested.includes("codegraph")) {
			pi.on("session_start", () => {
				if (!pi.getAllTools().some(tool => tool.name === "codegraph")) registerCodeGraphTool(pi);
			});
		}
		pi.on("before_agent_start", (event, ctx) => {
			if (env.GENTLE_PI_AGENTS_CHILD !== "1") return undefined;
			// The filtered copies replace contextFiles on the same options object
			// (pi-claude-bridge rebuilds its prompt from it). This never throws,
			// keeps the original files on any error or malformed markers, and is
			// idempotent: already-filtered content has nothing left to remove.
			// The engram-protocol block is deduplicated: only the copy in the file
			// nearest to the working directory stays.
			const options = (event as { systemPromptOptions?: ContextFileOptions | null } | undefined)?.systemPromptOptions;
			const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
			filterChildSessionContextFiles(options, typeof cwd === "string" ? { cwd } : {});
			dropSkillsCatalog(event, env);
			return undefined;
		});
	};
}

// The runner marks the children of the package-owned generic agents, whose
// parent passes exact skill paths. Emptying the loaded skills in place removes
// Pi's `<available_skills>` section under every launch form, including skills
// of a package passed with --extension, which --no-skills keeps.
function dropSkillsCatalog(event: unknown, env: NodeJS.ProcessEnv): void {
	if (env[CHILD_SKILLS_CATALOG_ENV] !== "1") return;
	const skills = (event as { systemPromptOptions?: { skills?: unknown } | null } | undefined)?.systemPromptOptions?.skills;
	if (Array.isArray(skills)) skills.length = 0;
}

export default function childContextExtension(pi: ExtensionAPI): void {
	createChildContextExtension()(pi);
}
