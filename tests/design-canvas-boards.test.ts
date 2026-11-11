import assert from "node:assert/strict";
import test from "node:test";
import { boardsOf, flush, loadCanvas, read, texts, withClass } from "./support/design-canvas-dom.ts";

// Artboards and their Implement this control (canvas-boards.js).

test("Implement this shows a toast and the badge at once: Queued when busy, Implementing… when idle", async () => {
	const canvas = await loadCanvas(300, { "/t/api/designs/alpha/implement": { ok: true, slug: "alpha", file: "01-a.html", queued: true } });
	const toast = canvas.document.getElementById("gd-toast");
	assert.match(read("index.html"), /<div id="gd-toast" class="gd-toast" role="status" aria-live="polite" hidden><\/div>/, "the toast starts hidden");
	const send = async () => {
		const [control] = withClass(boardsOf(canvas)[0], "gd-implement");
		withClass(control, "gd-implement-start")[0].dispatch("click");
		const yes = withClass(control, "gd-primary")[0];
		yes.dispatch("click");
		for (let i = 0; i < 10; i++) await flush();
	};
	await send();
	assert.deepEqual(canvas.posts.at(-1), { url: "/t/api/designs/alpha/implement", body: { file: "01-a.html" } });
	assert.equal(toast.hidden, false);
	assert.equal(toast.textContent, "Queued: the session will implement First after its current task.");
	assert.deepEqual(texts(boardsOf(canvas)[0], "gd-handoff-badge"), ["Queued"]);
	assert.deepEqual(texts(boardsOf(canvas)[0], "gd-choice"), ["Chosen"]);
	assert.deepEqual(texts(boardsOf(canvas)[1], "gd-choice"), ["Alternative"]);

	canvas.replies["/t/api/designs/alpha/implement"] = { ok: true, slug: "alpha", file: "01-a.html", queued: false };
	await send();
	assert.equal(toast.textContent, "Sent: the session is implementing First now.");
	assert.deepEqual(texts(boardsOf(canvas)[0], "gd-handoff-badge"), ["Implementing…"]);
});
