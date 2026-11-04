import assert from "node:assert/strict";
import test from "node:test";
import { createShellBarComponent } from "../extensions/gentle-shell.ts";

// Pi invalidates an extension ctx on reload or session replacement, and its
// runner throws on any access to the invalidated ctx. Gentle Shell installs
// render-path closures at setup that outlive it: the footer, the header and
// status bar chrome, the below-editor widget and the prompt all read that ctx
// on every frame. Before this guard the first frame after the ctx went stale
// escaped from Pi's render timer as an uncaughtException and exited the
// process (gentle-shell#745).
//
// These tests pin the containment, not the structural rework: a stale frame
// degrades to an empty frame, and the process keeps running.

const STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

/** A ctx shaped like Pi's after invalidation: every property access throws. */
function staleCtx(): unknown {
	return new Proxy(
		{},
		{
			get() {
				throw new Error(STALE_MESSAGE);
			},
			has() {
				throw new Error(STALE_MESSAGE);
			},
		},
	);
}

function footerData(): unknown {
	return { onBranchChange: () => () => {} };
}

test("a stale ctx degrades the footer frame to [] instead of throwing", () => {
	const component = createShellBarComponent(
		{} as never,
		staleCtx() as never,
		{ requestRender() {}, invalidateSidebar() {} },
		{} as never,
		footerData() as never,
	);
	try {
		// The assertion that matters is that this does not throw: an exception
		// here is the process-killing one, because Pi's render timer does not
		// catch for the extension.
		assert.deepEqual(component.render(80), []);
	} finally {
		component.dispose();
	}
});

test("a stale ctx keeps degrading across repeated frames", () => {
	const component = createShellBarComponent(
		{} as never,
		staleCtx() as never,
		{ requestRender() {}, invalidateSidebar() {} },
		{} as never,
		footerData() as never,
	);
	try {
		for (let frame = 0; frame < 5; frame += 1) {
			assert.deepEqual(component.render(80), []);
		}
	} finally {
		component.dispose();
	}
});

test("disposing a stale-ctx footer still releases its branch subscription", () => {
	let unsubscribed = 0;
	const component = createShellBarComponent(
		{} as never,
		staleCtx() as never,
		{ requestRender() {}, invalidateSidebar() {} },
		{} as never,
		{ onBranchChange: () => () => { unsubscribed += 1; } } as never,
	);
	component.dispose();
	assert.equal(unsubscribed, 1);
});
