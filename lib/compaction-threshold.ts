import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type CompactionThreshold = number | "off" | null;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Mirrors Pi's settings resolution, but reports invalid values as unknown. */
function resolveCompactionThreshold(settings: unknown, model: ExtensionContext["model"], window: number | undefined): CompactionThreshold {
	if (!isRecord(settings)) return null;
	const compaction = settings.compaction ?? {};
	if (!isRecord(compaction)) return null;
	const enabled = compaction.enabled ?? true;
	if (enabled === false) return "off";
	if (enabled !== true || !isTokenCount(window) || window === 0) return null;

	const overrides = compaction.modelOverrides;
	if (overrides != null && !isRecord(overrides)) return null;
	const override = model && overrides?.[`${model.provider}/${model.id}`];
	if (override !== undefined && !isRecord(override)) return null;
	// Pi validates both fields, including the ordinary value even when an
	// override wins. keepRecentTokens controls what survives, not the trigger.
	const validSetting = (value: unknown): value is number | undefined => value === undefined || isTokenCount(value);
	const tokenSetting = (field: "reserveTokens" | "keepRecentTokens", fallback: number): number | null => {
		const ordinary = compaction[field];
		const selected = override?.[field];
		return validSetting(ordinary) && validSetting(selected) ? selected ?? ordinary ?? fallback : null;
	};
	const reserve = tokenSetting("reserveTokens", 16_384);
	if (reserve === null || tokenSetting("keepRecentTokens", 20_000) === null) return null;
	return window - reserve;
}

/** A missing or throwing settings API must not break render or notifications. */
export function readCompactionThreshold(pi: Pick<ExtensionAPI, "getSettings">, model: ExtensionContext["model"], window: number | undefined): CompactionThreshold {
	try {
		return resolveCompactionThreshold(pi.getSettings?.(), model, window);
	} catch {
		return null;
	}
}
