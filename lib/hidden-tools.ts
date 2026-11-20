import type { ToolLoadout, ToolLoadoutChanges } from "@earendil-works/pi-coding-agent";

// Rarely used or state-bound tools leave the per-turn declarations only while
// a route the model is told about still reaches them. The route is codemode:
// a hidden declaration stays registered and active (Pi's prepareLoadout
// `hiddenDeclarations`, the projection the RDD-off review loadout uses), so a
// script calls it as `tools.<name>(args)`. Without codemode in the loadout the
// tool stays a direct declaration. The decision depends only on the loadout and
// session state, so two requests of one session carry the same tool list until
// that state changes.

export const CODEMODE_TOOL_NAME = "codemode";

/** Whether codemode is among the given tool names, the route that reaches hidden declarations. */
export function codemodeReaches(names: readonly unknown[] | undefined): boolean {
	return Array.isArray(names) && names.includes(CODEMODE_TOOL_NAME);
}

/**
 * A prepareLoadout hook that hides `name`'s declaration while codemode is
 * declared beside it and `when()` holds. The tool stays active and callable.
 */
export function hideBehindCodemode(name: string, when: () => boolean = () => true): (loadout: ToolLoadout) => ToolLoadoutChanges | undefined {
	return (loadout) => {
		const declared = loadout.declared.map((tool) => tool.name);
		return codemodeReaches(declared) && declared.includes(name) && when() ? { hiddenDeclarations: [name] } : undefined;
	};
}

/** Appended to the system prompt while the coordination tools are hidden. */
export const COORDINATION_TOOLS_ROUTE = "Cross-session tools orchestrator_list, orchestrator_consult and orchestrator_send_message are not declared: call them from codemode as `tools.<name>(args)`; `describeTool(name)` shows their arguments.";
/** Appended while the design tools are hidden: no design/ directory when this run started. */
export const DESIGN_TOOLS_ROUTE = "gentle_design and gentle_design_comments are not declared in this run: call them from codemode, such as `tools.gentle_design({ action: \"list\" })`.";
/** Appended while the guide tool is hidden. */
export const GUIDE_TOOL_ROUTE = "gentle_guide is not declared: call it from codemode as `tools.gentle_guide({ action: \"start\" })`.";
