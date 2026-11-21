// The pinned contract fixtures predate capabilities/v2.6 and their bytes are
// frozen, so tests derive the only supported advertisement (capabilities/v2.6,
// gentle-ai v4.6.0) from any older capabilities body instead of editing them.
const RETIRED_SCHEMAS = ["gentle-ai.review-final-verification-incident/v1", "gentle-ai.review-receipt/v2", "gentle-ai.review-verification-evidence/v2"];
const RETIRED_FEATURES = ["exact_receipt_replay", "five_delivery_gates", "sdd_receipt_binding"];

export function capabilitiesV26<T extends Record<string, unknown>>(base: T): T {
	const body = structuredClone(base) as Record<string, unknown>;
	body.schema = "gentle-ai.review-integration.capabilities/v2.6";
	body.protocol = { ...(body.protocol as Record<string, unknown>), minor: 6 };
	const schemas = (body.schemas as string[])
		.filter((schema) => !RETIRED_SCHEMAS.includes(schema))
		.map((schema) => schema
			.replace(/capabilities\/v2(?:\.[0-9]+)?$/, "capabilities/v2.6")
			.replace("consent/v2", "consent/v3")
			.replace("start/v3", "start/v4")
			.replace(/status\/v[35]$/, "status/v6"));
	body.schemas = [...new Set([...schemas, "gentle-ai.review-intended-untracked-selection/v1"])];
	const features = body.features as { mandatory: Array<{ name: string }>; optional: unknown[] };
	features.mandatory = features.mandatory.filter((feature) => !RETIRED_FEATURES.includes(feature.name));
	return body as T;
}
