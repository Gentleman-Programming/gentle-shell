import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../assets/design-canvas/canvas-store.js";

// The canvas state (canvas-store.js): live reads, and changes only through the
// store's mutators, one concern each (S3).

test("the store starts with the canvas defaults and no system field", () => {
	const { state } = createStore({ slug: "alpha" });
	assert.deepEqual({ ...state }, {
		slug: "alpha",
		manifest: null,
		boards: [],
		systemBoard: null,
		zoom: 1,
		fitted: false,
		x: 48,
		y: 48,
		commenting: false,
		pick: null,
		shot: null,
		shotToken: 0,
		closeTimer: 0,
		comments: [],
		filter: "open",
		mode: "send",
		activeId: null,
		designCount: 0,
		focus: null,
		savedView: null,
		savedPanel: null,
		hoverBoard: null,
		handoffs: { slug: null, chosen: null, handoffs: {} },
		compare: null,
		toastTimer: 0,
	});
	assert.equal(createStore({ slug: 3 }).state.slug, null, "a slug that is not a string shows the system-only view");
	assert.equal(createStore().state.slug, null);
});

test("reads see the live values without copying them", () => {
	const store = createStore();
	const { state } = store;
	assert.equal(store.state, state, "the read side is one object, never a per-read snapshot");
	const boards = [{ artboard: { file: "01-a.html" } }];
	store.setDesign({ boards });
	assert.equal(state.boards, boards, "the same array, not a copy");
	store.setView({ zoom: 2, x: 10, y: 20, fitted: true });
	assert.deepEqual([state.zoom, state.x, state.y, state.fitted], [2, 10, 20, true]);
	assert.equal(Object.isFrozen(state.boards), false, "values are not frozen either");
});

test("state cannot be assigned outside the store's mutators", () => {
	const store = createStore({ slug: "alpha" });
	assert.ok(Object.isFrozen(store.state));
	assert.throws(() => { (store.state as any).zoom = 3; }, TypeError);
	assert.throws(() => { (store.state as any).extra = 1; }, TypeError);
	assert.ok(Object.isFrozen(store));
	assert.throws(() => { (store as any).setView = () => {}; }, TypeError);
	assert.equal(store.state.zoom, 1);
});

test("each patch mutator changes only the fields of its own concern", () => {
	const store = createStore({ slug: "alpha" });
	const concerns: Array<[string, Record<string, unknown>]> = [
		["setDesign", { slug: "beta", manifest: { slug: "beta" }, boards: [], systemBoard: null, designCount: 2 }],
		["setView", { zoom: 2, x: 1, y: 2, fitted: true }],
		["setFocus", { focus: null, savedView: { zoom: 1, x: 0, y: 0 }, savedPanel: true }],
		["setComments", { comments: [], activeId: "abc123", filter: "resolved" }],
		["setPopover", { pick: null, shot: null, shotToken: 4, closeTimer: 0 }],
	];
	for (const [name, values] of concerns) {
		(store as any)[name](values);
		for (const [key, value] of Object.entries(values)) assert.deepEqual((store.state as any)[key], value, `${name} sets ${key}`);
	}
	const before = { ...store.state };
	assert.throws(() => store.setView({ slug: "gamma" }), { name: "TypeError", message: "setView cannot change slug" });
	assert.throws(() => store.setDesign({ zoom: 3 }), { name: "TypeError", message: "setDesign cannot change zoom" });
	assert.throws(() => store.setComments({ system: {} }), { name: "TypeError", message: "setComments cannot change system" });
	assert.deepEqual({ ...store.state }, before, "a refused patch changes nothing");
	// A patch mixing allowed and foreign fields is refused before any field changes.
	assert.throws(() => store.setView({ zoom: 5, slug: "x" }), { name: "TypeError", message: "setView cannot change slug" });
	assert.throws(() => store.setComments({ filter: "open", activeId: null, zoom: 9 }), { name: "TypeError", message: "setComments cannot change zoom" });
	assert.deepEqual({ ...store.state }, before, "a refused mixed patch changes nothing");
	// A partial patch leaves the other fields of the concern alone.
	store.setView({ x: 7 });
	assert.deepEqual([store.state.zoom, store.state.x, store.state.y, store.state.fitted], [2, 7, 2, true]);
});

test("comments and handoffs can only change through their mutators", () => {
	const store = createStore();
	const comment = { id: "c1", file: "01-a.html", status: "open" };
	const comments = [comment];
	store.setComments({ comments });
	assert.equal(store.state.comments, comments, "the same array, frozen when it is set, not copied per read");
	assert.throws(() => { (store.state.comments as any[]).push({ id: "c2" }); }, TypeError);
	assert.throws(() => { (store.state.comments[0] as any).status = "resolved"; }, TypeError);
	assert.deepEqual(store.state.comments, [{ id: "c1", file: "01-a.html", status: "open" }]);

	const entry = { status: "sent", queued: false };
	store.setHandoffs({ slug: "alpha", chosen: "01-a.html", handoffs: { "01-a.html": entry } });
	assert.throws(() => { (store.state.handoffs as any).chosen = "x"; }, TypeError);
	assert.throws(() => { (store.state.handoffs.handoffs as any)["02-b.html"] = {}; }, TypeError);
	assert.throws(() => { (store.state.handoffs.handoffs as any)["01-a.html"].status = "implemented"; }, TypeError);
	assert.deepEqual(store.state.handoffs, { slug: "alpha", chosen: "01-a.html", handoffs: { "01-a.html": { status: "sent", queued: false } } });
	assert.throws(() => { (createStore().state.handoffs as any).chosen = "x"; }, TypeError, "the initial handoffs are protected too");
	assert.throws(() => { (createStore().state.comments as any[]).push({}); }, TypeError, "the initial comments are protected too");
});

test("the single-field mutators set their one field", () => {
	const store = createStore();
	const board = { id: "board" };
	const compare = { board };
	const handoffs = { slug: "alpha", chosen: "01-a.html", handoffs: {} };
	store.setHover(board);
	store.setCommenting(true);
	store.setMode("collect");
	store.setHandoffs(handoffs);
	store.setCompare(compare);
	store.setToastTimer(9);
	assert.equal(store.state.hoverBoard, board);
	assert.equal(store.state.commenting, true);
	assert.equal(store.state.mode, "collect");
	assert.equal(store.state.handoffs, handoffs);
	assert.equal(store.state.compare, compare);
	assert.equal(store.state.toastTimer, 9);
});
