import { profilesFilePath, readProfilesFileResult } from "./agent-profiles.ts";
import { TERMINAL_ERROR_CATEGORY, type TerminalErrorCategory } from "./agents-protocol.ts";
import { parseModelRef } from "./agents-config.ts";
import { chainFor, fallbacksFilePath, readFallbacksFile, type FallbackChain } from "./model-fallback-store.ts";
import { computeModelPriceRatio, type ModelPriceLookup } from "./model-price-ratio.ts";

// What a fallback says and records, shared by the orchestrator and the agents.

/** Session entry appended on every switch. */
export const MODEL_FALLBACK_ENTRY = "gentle-pi.model-fallback/v1";

export interface FallbackChange {
	agent: string;
	from: string;
	to: string;
	category: TerminalErrorCategory;
	/** The run started on the fallback because the primary was still cooling down. */
	launch?: boolean;
}

const REASON: Partial<Record<TerminalErrorCategory, string>> = {
	[TERMINAL_ERROR_CATEGORY.QUOTA]: "its usage limit",
	[TERMINAL_ERROR_CATEGORY.AUTH]: "an authentication error",
	[TERMINAL_ERROR_CATEGORY.RATE_LIMIT]: "a rate limit",
	[TERMINAL_ERROR_CATEGORY.PROVIDER_UNAVAILABLE]: "a provider outage",
	[TERMINAL_ERROR_CATEGORY.TIMEOUT]: "a timeout",
	[TERMINAL_ERROR_CATEGORY.NETWORK]: "a network error",
};

/** The message that resumes a run after its model changed. */
export function fallbackContinuePrompt(from: string | undefined, to: string, category: TerminalErrorCategory): string {
	return `The previous model${from ? ` (${from})` : ""} stopped with a provider error (${category}). You are now running on ${to}. Continue the task from where it stopped; do not repeat steps that already completed.`;
}

/** One line for the human; a pricier fallback says by how much, an unpriced one says so. */
export function fallbackNotice(change: FallbackChange, prices?: ModelPriceLookup): string {
	let price = "";
	const from = parseModelRef(change.from);
	const to = parseModelRef(change.to);
	if (prices && from && to) {
		const ratio = computeModelPriceRatio(to, from, prices);
		if (ratio.kind === "unknown") price = " (price unknown)";
		else if (ratio.blended >= 1.05) price = ` (${(Math.round(ratio.blended * 10) / 10).toFixed(1)}x the price)`;
	}
	const reason = REASON[change.category] ?? change.category;
	return change.launch
		? `${change.agent}: ${change.from} is still cooling down after ${reason}; starting on ${change.to}${price}.`
		: `${change.agent}: ${change.from} hit ${reason}; continuing on ${change.to}${price}.`;
}

/** The chain for `agent` under the launch's profile, or the active profile when the launch names none. */
export function profileFallbackChain(configHome: string, profile: string | undefined, agent: string): FallbackChain {
	const read = readFallbacksFile(fallbacksFilePath(configHome));
	if (read.status !== "valid") return [];
	let name = profile;
	if (name === undefined) {
		const profiles = readProfilesFileResult(profilesFilePath(configHome));
		name = profiles.status === "valid" ? profiles.file.active : undefined;
	}
	return chainFor(read.file, name, agent);
}
