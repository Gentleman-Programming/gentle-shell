// The canvas server API under the per-server base path: artboard file URLs and
// JSON GET and POST, plus the number check shared by everything that reads
// server or artboard data, and what the server can deliver to the session.

/**
 * base: the per-server path every route lives under, from #gd-config; delivery: its `delivery`,
 * what the server can hand to the session (only `part: true` turns Implement only this on).
 */
export function init(ctx, base, delivery) {
	const { win } = ctx;

	function fileUrl(slug, file) {
		return `${base}files/${encodeURIComponent(slug)}/${file.split("/").map(encodeURIComponent).join("/")}`;
	}

	async function getJson(path) {
		const response = await win.fetch(base + path, { headers: { Accept: "application/json" }, cache: "no-store" });
		let body = null;
		try { body = await response.json(); } catch { body = null; }
		if (!response.ok) {
			const reason = body && (body.reason || body.error);
			// The status and the reply body ride along, so a caller can tell one error reply from another.
			throw Object.assign(new Error(reason ? String(reason) : `HTTP ${response.status}`), { status: response.status, body });
		}
		return body;
	}

	async function postJson(path, body) {
		const response = await win.fetch(base + path, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			cache: "no-store",
			body: JSON.stringify(body),
		});
		let reply = null;
		try { reply = await response.json(); } catch { reply = null; }
		return { status: response.status, ok: response.ok, body: reply || {} };
	}

	function isFiniteNumber(value) {
		return typeof value === "number" && Number.isFinite(value);
	}

	return { base, fileUrl, getJson, postJson, isFiniteNumber, delivery: Object.freeze({ part: Boolean(delivery && typeof delivery === "object" && delivery.part === true) }) };
}
