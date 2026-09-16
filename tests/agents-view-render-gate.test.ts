import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { TASK_STATUS, TaskStore, type TaskRecord } from "../lib/agents-protocol.ts";
import { AgentsView } from "../lib/agents-view.ts";
import { PresenceCursor, PresencePublisher, type ActivityInput } from "../lib/orchestrator-presence.ts";

// The 1 Hz presence poll must request a render only when a poll changed
// something the view shows. A live-but-quiet peer re-arms the timer without
// reassigning state or paying the full-transcript layout pass every second.

const plainTheme = { fg: (_color: string, text: string) => text };

function localTask(id: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
	return { id, agent: "explore", mode: "task", prompt: "p", label: "p", cwd: "/r", parentSessionId: "s", status: TASK_STATUS.RUNNING, createdAt: 1000, startedAt: 1000, endedAt: null, model: "gpt-5.6-terra", thinking: undefined, sessionPath: "/sessions/x.jsonl", error: null, result: null, lastStep: "grep", lastActivityAt: 1000, turns: 0, toolCalls: 0, tokens: 34_000, cost: 0.27, ...overrides };
}

function peer(id: string, overrides: Partial<ActivityInput["task"]> = {}, thread: ActivityInput["thread"] = { version: 1, dropped: 0, items: [{ kind: "text", text: "hello" }] }): ActivityInput {
	return {
		task: { id, agent: "worker", label: "peer", status: "running", model: "m", createdAt: 1000, startedAt: 1000, endedAt: null, lastActivityAt: 1000, ...overrides },
		thread,
	};
}

function gateHarness(t: TestContext, profile: string) {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const polls = t.mock.method(PresenceCursor.prototype, "next");
	const store = new TaskStore();
	let renders = 0;
	const view = new AgentsView({
		theme: plainTheme,
		rows: 8,
		store,
		sessionId: "s",
		now: () => 61_000,
		onCancel() {},
		onOpen() {},
		onClose() {},
		requestRender: () => {
			renders += 1;
		},
		presence: { profile },
	});
	return { store, view, renders: () => renders, polls: () => polls.mock.callCount() };
}

// Settle the pending poll's zero-delay hops without reaching its 1 s re-arm.
function settle(t: TestContext): void {
	for (let index = 0; index < 64; index += 1) t.mock.timers.tick(1);
}

function nextPoll(t: TestContext): void {
	t.mock.timers.tick(1000);
	settle(t);
}

function tempProfile(t: TestContext): string {
	const profile = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "presence-gate-"));
	t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
	return profile;
}

test("a live-but-quiet peer renders once and then polls silently", (t) => {
	const profile = tempProfile(t);
	const publisher = PresencePublisher.start({ profile, sessionId: "peer-a", label: "Peer A", activity: [peer("p1")] });
	t.after(() => publisher.dispose());
	const { view, renders, polls } = gateHarness(t, profile);
	settle(t);
	assert.equal(polls(), 1);
	assert.equal(renders(), 1, "the first poll renders once");
	nextPoll(t);
	assert.equal(polls(), 2, "the poll still runs every second");
	assert.equal(renders(), 1, "an identical poll does not render again");
	nextPoll(t);
	assert.equal(polls(), 3, "the timer keeps re-arming while quiet");
	assert.equal(renders(), 1);
	view.dispose();
});

test("a peer task status change renders again", (t) => {
	const profile = tempProfile(t);
	const publisher = PresencePublisher.start({ profile, sessionId: "peer-a", label: "Peer A", activity: [peer("p1")] });
	t.after(() => publisher.dispose());
	const { view, renders } = gateHarness(t, profile);
	settle(t);
	assert.equal(renders(), 1);
	publisher.update([peer("p1", { status: "waiting" })]);
	t.mock.timers.tick(500);
	nextPoll(t);
	assert.equal(renders(), 2, "a peer status change is visible on the next poll");
	nextPoll(t);
	assert.equal(renders(), 2, "the settled state stops rendering again");
	view.dispose();
});

test("a same-length rewrite of peer thread content renders again", (t) => {
	const profile = tempProfile(t);
	// keepTail (TEXT_CAP / maxOutputChars) lets a streaming peer rewrite item
	// content in place; a rewrite that preserves length must still trip the gate.
	const publisher = PresencePublisher.start({ profile, sessionId: "peer-a", label: "Peer A", activity: [peer("p1", {}, { version: 1, dropped: 0, items: [{ kind: "text", text: "streamed tail is now AAAA" }] })] });
	t.after(() => publisher.dispose());
	const { view, renders } = gateHarness(t, profile);
	settle(t);
	assert.equal(renders(), 1);
	publisher.update([peer("p1", {}, { version: 1, dropped: 0, items: [{ kind: "text", text: "streamed tail is now BBBB" }] })]);
	t.mock.timers.tick(500);
	nextPoll(t);
	assert.equal(renders(), 2, "a same-length different-content rewrite renders on the next poll");
	nextPoll(t);
	assert.equal(renders(), 2, "the settled state stops rendering again");
	view.dispose();
});

test("peer membership and availability changes render again", (t) => {
	const profile = tempProfile(t);
	const publisher = PresencePublisher.start({ profile, sessionId: "peer-a", label: "Peer A", activity: [peer("p1")] });
	const { view, renders } = gateHarness(t, profile);
	settle(t);
	assert.equal(renders(), 1);
	publisher.update([peer("p1"), peer("p2", { agent: "builder" })]);
	t.mock.timers.tick(500);
	nextPoll(t);
	assert.equal(renders(), 2, "an appearing peer task renders again");
	fs.unlinkSync(join(profile, "gentle-agents", "presence", `${publisher.target.sessionHash}.${publisher.target.incarnation}.activity.json`));
	nextPoll(t);
	assert.equal(renders(), 3, "an unavailable activity changes the rendered group label");
	publisher.dispose();
	nextPoll(t);
	assert.equal(renders(), 4, "a disappearing peer group renders again");
	nextPoll(t);
	assert.equal(renders(), 4, "the settled empty directory stops rendering again");
	view.dispose();
});

test("local task changes render again while presence stays identical", (t) => {
	const profile = tempProfile(t);
	const publisher = PresencePublisher.start({ profile, sessionId: "peer-a", label: "Peer A", activity: [peer("p1")] });
	t.after(() => publisher.dispose());
	const { store, view, renders, polls } = gateHarness(t, profile);
	settle(t);
	assert.equal(renders(), 1);
	store.add(localTask("mine"));
	assert.equal(renders(), 2, "the store change itself renders immediately");
	nextPoll(t);
	assert.equal(polls(), 2);
	assert.equal(renders(), 3, "the next poll renders again because the local snapshot changed");
	store.update("mine", { lastStep: "edited" });
	assert.equal(renders(), 4, "the subscribed selection renders on its own update");
	nextPoll(t);
	assert.equal(polls(), 3);
	assert.equal(renders(), 5, "a local lastStep change is covered by the poll signature");
	nextPoll(t);
	assert.equal(renders(), 5, "an unchanged store stops rendering again");
	view.dispose();
});

test("presence read failures still render and recover on the next successful poll", (t) => {
	const parent = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "presence-gate-"));
	t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
	const profile = join(parent, "absent");
	const { view, renders, polls } = gateHarness(t, profile);
	assert.equal(renders(), 1, "a failed first poll renders the empty error state");
	nextPoll(t);
	assert.equal(renders(), 2, "the error path still renders on every failed poll");
	fs.mkdirSync(profile);
	const publisher = PresencePublisher.start({ profile, sessionId: "peer-a", label: "Peer A", activity: [peer("p1")] });
	t.after(() => publisher.dispose());
	nextPoll(t);
	assert.equal(polls(), 1, "the recovered poll finally reads the directory");
	assert.equal(renders(), 3, "recovery renders the found peers");
	nextPoll(t);
	assert.equal(renders(), 3, "the recovered quiet state stops rendering again");
	view.dispose();
});
