import type { NativeSddStatusV2 } from "./native-review-cli.ts";

// Keep persisted legacy "both" normalization in sdd-preflight; native owns status.
export type SddArtifactStore = "openspec" | "engram" | "hybrid" | "none";
export type SddPhase = "apply" | "verify" | "archive";

export function renderNativeSddPhasePrompt(status: NativeSddStatusV2, phase?: SddPhase | "remediate"): string {
	const instructions = phase ? status.phaseInstructions?.[phase] : undefined;
	return [
		"## Native SDD Status Engine",
		"Native status is the authoritative, read-only projection. Never re-derive readiness from artifacts or replace its recommended action.",
		"Run only an admitted phase; report blocked dependencies and preserve every native blocker. Explicit optional verification does not change the recommended action.",
		...(phase && instructions ? ["", `### ${phase} instructions`, ...instructions.map((line) => `- ${line}`)] : []),
		"",
		"```json",
		JSON.stringify(status, null, 2),
		"```",
	].join("\n");
}

export function parseSddStatusCommandArgs(args: string): { changeName?: string; json: boolean } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const json = parts.includes("--json");
	const changeName = parts.find((part) => part !== "--json");
	return { changeName, json };
}
