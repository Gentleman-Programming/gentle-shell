import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { filterChildSessionContextFiles, type ContextFileOptions } from "../lib/child-context-files.ts";
import { REQUESTED_TOOLS_ENV } from "../lib/agents-runner.ts";
import { registerCodeGraphTool } from "./codegraph-tools.ts";

// gentle-shell#1587: delegated children drop the orchestrator-only gentle-ai
// managed blocks from their context files. Gentle Agents passes this file to
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
		pi.on("before_agent_start", (event) => {
			if (env.GENTLE_PI_AGENTS_CHILD !== "1") return undefined;
			// The filtered copies replace contextFiles on the same options object
			// (pi-claude-bridge rebuilds its prompt from it). This never throws,
			// keeps the original files on any error or malformed markers, and is
			// idempotent: already-filtered content has nothing left to remove.
			const options = (event as { systemPromptOptions?: ContextFileOptions | null } | undefined)?.systemPromptOptions;
			filterChildSessionContextFiles(options);
			return undefined;
		});
	};
}

export default function childContextExtension(pi: ExtensionAPI): void {
	createChildContextExtension()(pi);
}
