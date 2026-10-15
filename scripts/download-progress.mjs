// One-line terminal progress for the package-local Gentle AI download. Pure
// formatting plus a throttled reporter over an injected writer; the caller
// decides whether a terminal is attached (install-gentle-ai.mjs).

const KB = 1024;
const MB = 1024 * 1024;

function size(bytes) {
	return bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.round(bytes / KB)} KB`;
}

function truncate(text, width) {
	const chars = [...text];
	return chars.length <= width ? text : chars.slice(0, Math.max(0, width)).join("");
}

export function formatDownloadProgress({ label, received, total, elapsedMs, width }) {
	const rate = elapsedMs > 0 ? (received * 1000) / elapsedMs : 0;
	const known = typeof total === "number" && total > 0;
	const amount = known
		? total >= MB
			? `${(received / MB).toFixed(1)}/${(total / MB).toFixed(1)} MB`
			: `${Math.round(received / KB)}/${Math.round(total / KB)} KB`
		: size(received);
	const parts = [amount];
	if (known) parts.push(`${String(Math.min(100, Math.floor((received / total) * 100))).padStart(3)}%`);
	// The rate is the first thing to go when even the bare numbers do not fit.
	if (rate > 0 && [...parts.join(" ")].length + [...size(rate)].length + 3 <= width) parts.push(`${size(rate)}/s`);
	const metrics = parts.join(" ");
	// The moving numbers win over the label on a narrow terminal: the label is
	// shortened, then dropped, before the amount and percent are ever cut.
	const room = width - [...metrics].length - 1;
	if (room < [...label].length) return room >= 1 ? `${truncate(label, room)} ${metrics}` : truncate(metrics, width);
	const text = `${label} ${metrics}`;
	if (!known) return text;
	const barWidth = Math.min(30, width - [...text].length - 3);
	if (barWidth < 5) return truncate(text, width);
	const filled = Math.min(barWidth, Math.round((received / total) * barWidth));
	return `${text} [${"#".repeat(filled)}${"-".repeat(barWidth - filled)}]`;
}

// Redraws at most every `intervalMs`, except the completed state, which is
// always drawn. `done` clears the line once, and only if something was drawn.
export function createDownloadProgress({ label, write: rawWrite, now = Date.now, width = () => 80, intervalMs = 100 }) {
	// Display only: a failing terminal write (closed pipe, detached tty) must
	// never change the install result, including during cleanup in `done`.
	const write = (text) => { try { rawWrite(text); } catch { /* display only */ } };
	const started = now();
	let lastDraw;
	let drawn = false;
	let finished = false;
	return {
		update({ received, total }) {
			if (finished) return;
			const at = now();
			const complete = typeof total === "number" && total > 0 && received >= total;
			if (lastDraw !== undefined && at - lastDraw < intervalMs && !complete) return;
			lastDraw = at;
			drawn = true;
			write(`\r${formatDownloadProgress({ label, received, total, elapsedMs: at - started, width: Math.max(10, width() - 1) })}\x1b[K`);
		},
		done() {
			if (finished) return;
			finished = true;
			if (drawn) write("\r\x1b[K");
		},
	};
}
