// The captured status fixtures predate status/v9 and their bytes are frozen.
// status/v9 is a strict superset of their key set (gentle-ai v4.6.0, the
// minimum supported native binary), so tests re-label a parsed capture as v9
// instead of editing the fixture files.
export function statusV9<T extends Record<string, unknown>>(body: T): T {
	(body as Record<string, unknown>).schema = "gentle-ai.review-integration.status/v9";
	return body;
}
