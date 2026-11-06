import assert from "node:assert/strict";
import test from "node:test";
import { withOverlayRepaint } from "../lib/overlay-repaint.ts";
import type { TUI } from "@earendil-works/pi-tui";

// Overlay close repaint: wrapping an overlay's done callback must tear the
// overlay down first (done), then force a FULL terminal repaint
// (invalidate + requestRender) so a fullscreen overlay's stale cell state
// cannot survive the close. Paint failures are swallowed; done failures are not.

function fakeTui() {
	const calls: string[] = [];
	const tui = {
		invalidate: () => {
			calls.push("invalidate");
		},
		requestRender: () => {
			calls.push("requestRender");
		},
	} as unknown as TUI;
	return { tui, calls };
}

test("withOverlayRepaint: forces a full render (requestRender(true)) after done", () => {
	const calls: string[] = [];
	const tui = {
		requestRender: (force?: boolean) => {
			calls.push(`requestRender:${force === true}`);
		},
	} as unknown as TUI;
	const close = withOverlayRepaint<string | null>(tui, (result) => {
		calls.push(`done:${String(result)}`);
	});
	close(null);
	assert.deepEqual(calls, ["done:null", "requestRender:true"]);
});

test("withOverlayRepaint: forwards null results (plain close)", () => {
	const calls: string[] = [];
	const tui = {
		requestRender: (force?: boolean) => {
			calls.push(`requestRender:${force === true}`);
		},
	} as unknown as TUI;
	const seen: Array<string | null> = [];
	const close = withOverlayRepaint<string | null>(tui, (result) => {
		seen.push(result);
	});
	close(null);
	assert.deepEqual(seen, [null]);
	assert.deepEqual(calls, ["requestRender:true"]);
});

test("withOverlayRepaint: paint failure is swallowed, done result still delivered", () => {
	const seen: Array<string | null> = [];
	const tui = {
		requestRender: () => {
			throw new Error("EIO");
		},
	} as unknown as TUI;
	const close = withOverlayRepaint<string | null>(tui, (result) => {
		seen.push(result);
	});
	assert.doesNotThrow(() => close(null));
	assert.deepEqual(seen, [null]);
});

test("withOverlayRepaint: done failure propagates (overlay contract, not paint)", () => {
	const { tui } = fakeTui();
	const close = withOverlayRepaint<string | null>(tui, () => {
		throw new Error("overlay teardown failed");
	});
	assert.throws(() => close(null), /overlay teardown failed/);
});
