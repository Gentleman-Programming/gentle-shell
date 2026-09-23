import assert from "node:assert/strict";
import test from "node:test";
import { ForeignTargetGrants } from "../lib/foreign-target-grants.ts";

const target = { root: "/foreign", commonDir: "/foreign/.git" };
function context(confirm?: () => Promise<boolean>) {
	let id = "session-one";
	let calls = 0;
	const ctx = { sessionManager: { getSessionId: () => id }, hasUI: !!confirm, ui: confirm ? { confirm: async () => { calls++; return confirm(); } } : undefined };
	return { ctx, setId: (next: string) => { id = next; }, calls: () => calls };
}

test("foreign grant requires interactive consent and reuses only the same live session and clone", async () => {
	const grants = new ForeignTargetGrants();
	const h = context(async () => true);
	await grants.authorize(h.ctx as never, target);
	await grants.authorize(h.ctx as never, target);
	assert.equal(h.calls(), 1);
	await grants.authorize(h.ctx as never, { root: "/another", commonDir: "/another/.git" });
	assert.equal(h.calls(), 2);
	h.setId("session-two");
	assert.throws(() => grants.assertCurrent(h.ctx as never, target), /no longer live/);
	await grants.authorize(h.ctx as never, target);
	assert.equal(h.calls(), 3);
	await new ForeignTargetGrants().authorize(h.ctx as never, target);
	assert.equal(h.calls(), 4);
});

test("continuation after a reload cannot recreate a lost grant by prompting", async () => {
	const h = context(async () => true);
	const original = new ForeignTargetGrants();
	await original.authorize(h.ctx as never, target);
	const reloaded = new ForeignTargetGrants();
	await assert.rejects(reloaded.authorize(h.ctx as never, target, { continuation: true }), /grant.*lost|grant.*live/i);
	assert.equal(h.calls(), 1, "a lost continuation grant must never prompt again");
});

test("same-ID session-manager replacement revokes a grant without resurrecting it on continuation", async () => {
	const h = context(async () => true);
	const grants = new ForeignTargetGrants();
	await grants.authorize(h.ctx as never, target);
	const replacement = { ...h.ctx, sessionManager: { getSessionId: () => "session-one" } };
	assert.throws(() => grants.assertCurrent(replacement as never, target), /no longer live/);
	await assert.rejects(grants.authorize(replacement as never, target, { continuation: true }), /grant.*lost/i);
	assert.equal(h.calls(), 1);
	assert.throws(() => grants.assertCurrent(h.ctx as never, target), /no longer live/);
});

test("foreign grant fails closed on no UI, decline, cancellation, and identity change during consent", async () => {
	await assert.rejects(new ForeignTargetGrants().authorize(context().ctx as never, target), /interactive/);
	await assert.rejects(new ForeignTargetGrants().authorize(context(async () => false).ctx as never, target), /interactive/);
	const cancelled = context(async () => { throw new Error("cancelled"); });
	await assert.rejects(new ForeignTargetGrants().authorize(cancelled.ctx as never, target), /cancelled/);
	const changed = context(async () => { changed.setId("replacement"); return true; });
	const grants = new ForeignTargetGrants();
	await assert.rejects(grants.authorize(changed.ctx as never, target), /identity changed/);
	assert.throws(() => grants.assertCurrent(changed.ctx as never, target), /no longer live/);
});
