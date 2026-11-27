import assert from "node:assert/strict";
import test from "node:test";
import { flush, loadCanvas } from "./support/design-canvas-dom.ts";

// Design groups (design.json "group"). A pill floats over the canvas, top-left: it names the open design's group
// ("No group" when it has none), and its popover files the design under one of the groups in use, under "No group",
// or under a new name. The design selector lists every design, grouped by name.

const manifest = (slug: string, title: string) => ({ slug, title, brief: "", artboards: [{ file: "01-a.html", title: "A", tradeoff: "", width: 400, height: 300 }] });
const GROUPED = [
	{ slug: "customer-settings", title: "Settings", group: "Customer", mtime: 5, valid: true },
	{ slug: "admin-settings", title: "Settings", group: "Admin", mtime: 9, valid: true },
	{ slug: "admin-accounts", title: "Accounts", group: "Admin", mtime: 1, valid: true },
	{ slug: "alpha", title: "Alpha", mtime: 3, valid: true },
];
const replies = (designs: unknown[], extra: Record<string, unknown> = {}) => ({
	"/t/api/designs": { designs },
	...Object.fromEntries(["customer-settings", "admin-settings", "admin-accounts", "alpha"].flatMap((slug) => [
		[`/t/api/designs/${slug}`, manifest(slug, slug)],
		[`/t/api/designs/${slug}/comments`, { comments: [] }],
		[`/t/api/designs/${slug}/handoffs`, { version: 1, chosen: null, handoffs: {} }],
		[`/t/api/designs/${slug}/parts`, { version: 1, parts: [] }],
	])),
	...extra,
});
type Canvas = Awaited<ReturnType<typeof loadCanvas>>;
type Node = { textContent: string; value?: string; disabled?: boolean; hidden?: boolean; dispatch(type: string, init?: Record<string, unknown>): unknown; getAttribute(name: string): string | null; children: Node[] };
const options = (select: { children: Array<{ value?: string; textContent: string }> }) => select.children.map((option) => [option.value, option.textContent]);
const $ = (canvas: Canvas, id: string) => canvas.document.getElementById(id) as unknown as Node;
const menuOpen = (canvas: Canvas) => !$(canvas, "gd-group-menu").hidden;
const items = (canvas: Canvas) => $(canvas, "gd-group-items").children;
const itemNamed = (canvas: Canvas, label: string) => items(canvas).find((item) => item.textContent === label)!;
const groupPost = (slug: string, group: string | null) => ({ url: `/t/api/designs/${slug}/group`, body: { group } });

test("with no group in any design the pill reads No group, and every design is listed", async () => {
	const canvas = await loadCanvas(300, replies([{ slug: "alpha", title: "Alpha", valid: true }, { slug: "beta", title: "Beta", valid: true }]), { slug: "alpha" });
	await flush();
	assert.equal($(canvas, "gd-group-float").hidden, false, "the pill stays so the first group can be made");
	assert.equal($(canvas, "gd-group").textContent, "No group");
	assert.deepEqual(options($(canvas, "gd-design")), [["alpha", "Alpha"], ["beta", "Beta"]]);
});

test("the pill shows the open design's group, and All lists every design grouped, with the group in front of each title", async () => {
	const canvas = await loadCanvas(300, replies(GROUPED), { slug: "admin-settings" });
	await flush();
	assert.equal($(canvas, "gd-group").textContent, "Admin");
	assert.deepEqual(options($(canvas, "gd-design")), [["admin-accounts", "Admin / Accounts"], ["admin-settings", "Admin / Settings"], ["customer-settings", "Customer / Settings"], ["alpha", "Alpha"]]);
	assert.equal($(canvas, "gd-design").value, "admin-settings");
});

test("a show event for a design in another group moves the pill to that group", async () => {
	const canvas = await loadCanvas(300, replies(GROUPED), { slug: "admin-settings" });
	await flush();
	await canvas.serverEvent("show", { slug: "customer-settings" });
	assert.equal($(canvas, "gd-group").textContent, "Customer");
	assert.equal($(canvas, "gd-design").value, "customer-settings");
});

test("designs without a group sit under No group, and an invalid design is listed there too", async () => {
	const canvas = await loadCanvas(300, replies([...GROUPED, { slug: "broken", title: "broken", valid: false }]), { slug: "alpha" });
	await flush();
	assert.equal($(canvas, "gd-group").textContent, "No group");
	assert.deepEqual(options($(canvas, "gd-design")).at(-1), ["broken", "broken (invalid design.json)"]);
});

test("the pill opens a popover of No group and the groups in use, with the open design's group checked", async () => {
	const canvas = await loadCanvas(300, replies(GROUPED), { slug: "admin-settings" });
	await flush();
	assert.equal(menuOpen(canvas), false);
	$(canvas, "gd-group").dispatch("click");
	assert.equal(menuOpen(canvas), true);
	assert.equal($(canvas, "gd-group").getAttribute("aria-expanded"), "true");
	assert.deepEqual(items(canvas).map((item) => [item.textContent, item.getAttribute("aria-checked")]), [["No group", "false"], ["Admin", "true"], ["Customer", "false"]]);
});

test("picking a group saves it for the open design and closes the popover", async () => {
	const canvas = await loadCanvas(300, replies(GROUPED, { "/t/api/designs/admin-settings/group": { ok: true, group: { slug: "admin-settings", group: "Customer", changed: true } } }), { slug: "admin-settings" });
	await flush();
	$(canvas, "gd-group").dispatch("click");
	itemNamed(canvas, "Customer").dispatch("click");
	await flush();
	assert.deepEqual(canvas.posts.at(-1), groupPost("admin-settings", "Customer"));
	assert.equal(menuOpen(canvas), false);
});

test("No group takes the design out of its group", async () => {
	const canvas = await loadCanvas(300, replies(GROUPED, { "/t/api/designs/admin-settings/group": { ok: true, group: { slug: "admin-settings", changed: true } } }), { slug: "admin-settings" });
	await flush();
	$(canvas, "gd-group").dispatch("click");
	itemNamed(canvas, "No group").dispatch("click");
	await flush();
	assert.deepEqual(canvas.posts.at(-1), groupPost("admin-settings", null));
});

test("New group reveals a name field; Create files the design under the trimmed name", async () => {
	const canvas = await loadCanvas(300, replies(GROUPED, { "/t/api/designs/alpha/group": { ok: true, group: { slug: "alpha", group: "Ops", changed: true } } }), { slug: "alpha" });
	await flush();
	$(canvas, "gd-group").dispatch("click");
	assert.equal($(canvas, "gd-group-new-row").hidden, true);
	$(canvas, "gd-group-new-toggle").dispatch("click");
	assert.equal($(canvas, "gd-group-new-row").hidden, false);
	$(canvas, "gd-group-input").value = "  Ops  ";
	$(canvas, "gd-group-input").dispatch("input");
	$(canvas, "gd-group-create").dispatch("click");
	await flush();
	assert.deepEqual(canvas.posts.at(-1), groupPost("alpha", "Ops"));
});

test("Enter in the name field creates the group too", async () => {
	const canvas = await loadCanvas(300, replies(GROUPED, { "/t/api/designs/alpha/group": { ok: true, group: { slug: "alpha", group: "Ops", changed: true } } }), { slug: "alpha" });
	await flush();
	$(canvas, "gd-group").dispatch("click");
	$(canvas, "gd-group-new-toggle").dispatch("click");
	$(canvas, "gd-group-input").value = "Ops";
	$(canvas, "gd-group-input").dispatch("keydown", { key: "Enter" });
	await flush();
	assert.deepEqual(canvas.posts.at(-1), groupPost("alpha", "Ops"));
});

test("a name that differs from a group in use only in case is offered back, and clicking the offer uses the existing spelling", async () => {
	const canvas = await loadCanvas(300, replies(GROUPED), { slug: "alpha" });
	await flush();
	$(canvas, "gd-group").dispatch("click");
	$(canvas, "gd-group-new-toggle").dispatch("click");
	$(canvas, "gd-group-input").value = "admin";
	$(canvas, "gd-group-input").dispatch("input");
	assert.equal($(canvas, "gd-group-hint").hidden, false);
	assert.equal($(canvas, "gd-group-hint").textContent, 'Did you mean "Admin"?');
	$(canvas, "gd-group-hint").dispatch("click");
	assert.equal($(canvas, "gd-group-input").value, "Admin");
});

test("a refused name keeps the popover open and shows the reason", async () => {
	const canvas = await loadCanvas(300, replies(GROUPED, { "/t/api/designs/alpha/group": { __http: 422, error: "invalid-group", reason: "group must be at most 40 characters" } }), { slug: "alpha" });
	await flush();
	$(canvas, "gd-group").dispatch("click");
	$(canvas, "gd-group-new-toggle").dispatch("click");
	$(canvas, "gd-group-input").value = "x".repeat(41);
	$(canvas, "gd-group-input").dispatch("input");
	$(canvas, "gd-group-create").dispatch("click");
	await flush();
	assert.equal(menuOpen(canvas), true);
	assert.equal($(canvas, "gd-group-error").hidden, false);
	assert.match($(canvas, "gd-group-error").textContent, /at most 40 characters/);
});

test("Escape closes the popover without posting", async () => {
	const canvas = await loadCanvas(300, replies(GROUPED), { slug: "admin-settings" });
	await flush();
	$(canvas, "gd-group").dispatch("click");
	$(canvas, "gd-group-menu").dispatch("keydown", { key: "Escape" });
	assert.equal(menuOpen(canvas), false);
	assert.equal(canvas.posts.length, 0);
});

test("the pill and the design selector stay enabled in navigation, and both are disabled once an artboard is focused", async () => {
	const canvas = await loadCanvas(300, replies(GROUPED), { slug: "admin-settings" });
	await flush();
	assert.equal($(canvas, "gd-design").disabled, false);
	assert.equal($(canvas, "gd-group").disabled, false);
	// Enter on an artboard's shield is how a person enters focus mode.
	canvas.boards[0].shield.dispatch("keydown", { key: "Enter" });
	await flush();
	assert.equal($(canvas, "gd-design").disabled, true);
	assert.equal($(canvas, "gd-group").disabled, true);
});
