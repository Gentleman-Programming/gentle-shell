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

/** A reply the test gives later: a request for it stays in flight until `resolve`. */
function deferred() {
	let resolve!: (reply: unknown) => void;
	const promise = new Promise<unknown>((done) => { resolve = done; });
	return { promise, resolve };
}
const settle = async () => { for (let i = 0; i < 10; i++) await flush(); };

test("an older design.json load that answers last never replaces the boards of a newer load of the same design", async () => {
	const MANIFEST = "/t/api/designs/alpha";
	const LAYOUT = "/t/api/designs/alpha/layout";
	const canvas = await loadCanvas(300, { [LAYOUT]: { layout: null } });
	const older = canvas.replies[MANIFEST] as { artboards: unknown[] };
	const newer = { ...older, artboards: [...older.artboards, { file: "03-c.html", title: "Third", tradeoff: "", width: 400, height: 300 }] };
	const olderManifest = deferred();
	canvas.replies[MANIFEST] = olderManifest.promise;
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	const newerManifest = deferred();
	canvas.replies[MANIFEST] = newerManifest.promise;
	await canvas.serverEvent("change", { slug: "alpha", file: "design.json" });
	// The older load reads its manifest first and waits for its layout; the newer one then reads both.
	const olderLayout = deferred();
	canvas.replies[LAYOUT] = olderLayout.promise;
	olderManifest.resolve(older);
	await settle();
	canvas.replies[LAYOUT] = { layout: null };
	newerManifest.resolve(newer);
	await settle();
	assert.deepEqual(texts(canvas.world, "gd-artboard-title"), ["First", "Second", "Third"], "the newer manifest shows");
	olderLayout.resolve({ layout: null });
	await settle();
	assert.deepEqual(texts(canvas.world, "gd-artboard-title"), ["First", "Second", "Third"], "the older load that answered last is dropped");
});
