import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodeTest from "node:test";
import { ActiveSessionListener, SessionPresenceRegistry, type ReceivedAdopt } from "../lib/agents-session-transport.ts";
import { abandonAdoption, AdoptionTarget, adoptedMemberName, adoptHandoffPath, adoptRefusal, createAdoptTransport, isProcessAlive, readAdoptHandoff, watchAdoption, writeAdoptHandoff, type AdoptHandoff } from "../lib/fleet-adopt.ts";
import { FLEET_ROLE_ENV } from "../lib/fleet-role.ts";

const posixTest = process.platform === "win32" ? nodeTest.skip : nodeTest;
const test = nodeTest;
// Scratch stays outside the worktree; it is reported, not removed.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gentle-fleet-adopt-test-")));
let homes = 0;
const agentHome = () => {
	const home = join(scratch, `agent-${++homes}`);
	mkdirSync(home, { recursive: true });
	return home;
};
const TOKEN = "Tok_en-12345678";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("the hand-off path is derived by the target from a strict token under its own agent home", () => {
	const home = agentHome();
	assert.equal(adoptHandoffPath(home, TOKEN), join(home, "gentle-fleet", "adopt", `${TOKEN}.json`));
	for (const token of ["../../etc/passwd", "/abs/path", "short", "a/b/c/d/e/f", "", "x".repeat(129)]) assert.equal(adoptHandoffPath(home, token), undefined, token);
});

test("an invalid token is refused with nothing written", () => {
	const home = agentHome();
	for (const token of ["../../escape-me", "/tmp/absolute-x", "short"]) assert.equal(writeAdoptHandoff(home, token, { state: "refused", reason: "x" }), false, token);
	assert.equal(existsSync(join(home, "gentle-fleet")), false, "no directory is created for an invalid token");
	assert.equal(existsSync(join(scratch, "escape-me.json")), false);
});

posixTest("the target writes the hand-off owner-only in a 0700 directory and reads it back", () => {
	const home = agentHome();
	const handoff: AdoptHandoff = { state: "ready", pid: 42, label: "blog", sessionFile: "/s/2026_x.jsonl", sessionDir: "/s", cwd: "/w/blog" };
	assert.equal(writeAdoptHandoff(home, TOKEN, handoff), true);
	assert.equal(lstatSync(join(home, "gentle-fleet", "adopt")).mode & 0o777, 0o700);
	assert.equal(lstatSync(adoptHandoffPath(home, TOKEN)!).mode & 0o777, 0o600);
	assert.deepEqual(readAdoptHandoff(home, TOKEN), handoff);
	assert.equal(readAdoptHandoff(home, "Other-token-123"), undefined);
});

posixTest("an existing symlink at the hand-off path or a symlinked hand-off directory is refused", () => {
	const home = agentHome();
	mkdirSync(join(home, "gentle-fleet", "adopt"), { recursive: true, mode: 0o700 });
	const outside = join(scratch, `outside-${homes}.json`);
	writeFileSync(outside, "keep");
	symlinkSync(outside, adoptHandoffPath(home, TOKEN)!);
	assert.equal(writeAdoptHandoff(home, TOKEN, { state: "refused", reason: "x" }), false);
	assert.equal(readFileSync(outside, "utf8"), "keep", "the symlink target is untouched");
	assert.equal(readAdoptHandoff(home, TOKEN), undefined, "a symlinked hand-off is never read");
	const linked = agentHome();
	const elsewhere = join(scratch, `elsewhere-${homes}`);
	mkdirSync(elsewhere);
	mkdirSync(join(linked, "gentle-fleet"));
	symlinkSync(elsewhere, join(linked, "gentle-fleet", "adopt"));
	assert.equal(writeAdoptHandoff(linked, TOKEN, { state: "refused", reason: "x" }), false);
	assert.equal(existsSync(join(elsewhere, `${TOKEN}.json`)), false);
});

test("a malformed hand-off is not read", () => {
	const home = agentHome();
	mkdirSync(join(home, "gentle-fleet", "adopt"), { recursive: true });
	for (const value of [{ state: "ready", pid: 1 }, { state: "accepted", pid: -1, label: "x" }, { state: "other" }, "x"]) {
		writeFileSync(adoptHandoffPath(home, TOKEN)!, JSON.stringify(value));
		assert.equal(readAdoptHandoff(home, TOKEN), undefined, JSON.stringify(value));
	}
});

test("only an interactive TUI primary session with a saved session file can be adopted", () => {
	const file = join(scratch, "session.jsonl");
	writeFileSync(file, "{}\n");
	const ok = { mode: "tui", hasUI: true, env: {}, sessionFile: file };
	assert.equal(adoptRefusal(ok), undefined);
	for (const mode of ["rpc", "print", "json"]) assert.match(adoptRefusal({ ...ok, mode }) ?? "", new RegExp(`not an interactive terminal session \\(${mode} mode\\)`));
	assert.match(adoptRefusal({ ...ok, env: { [FLEET_ROLE_ENV]: "member" } }) ?? "", /fleet member/);
	assert.match(adoptRefusal({ ...ok, env: { [FLEET_ROLE_ENV]: "controller" } }) ?? "", /fleet controller/);
	assert.match(adoptRefusal({ ...ok, env: { GENTLE_PI_AGENTS_CHILD: "1" } }) ?? "", /subagent/);
	assert.match(adoptRefusal({ ...ok, sessionFile: undefined }) ?? "", /ephemeral/);
	assert.match(adoptRefusal({ ...ok, sessionFile: join(scratch, "missing.jsonl") }) ?? "", /no saved conversation/);
});

/** A target session context: busy until the test says it is idle. */
function targetContext(options: { mode?: string; sessionFile?: string } = {}) {
	const sessionFile = options.sessionFile ?? join(scratch, `target-${++homes}.jsonl`);
	if (!options.sessionFile) writeFileSync(sessionFile, "{}\n");
	let idle = false;
	let queued = false;
	const notices: string[] = [];
	const calls = { shutdown: 0, abort: 0 };
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		isIdle: () => idle,
		hasPendingMessages: () => queued,
		abort: () => { calls.abort += 1; },
		shutdown: () => { calls.shutdown += 1; },
		ui: { notify: (message: string) => notices.push(message) },
		sessionManager: { getSessionFile: () => sessionFile, getSessionDir: () => join(scratch, "sessions"), getCwd: () => join(scratch, "work", "blog"), getSessionName: () => "Blog \u001b[31mposts" },
	};
	return { ctx, notices, calls, sessionFile, setIdle: (value: boolean) => { idle = value; }, setQueued: (value: boolean) => { queued = value; } };
}

function manualTimers() {
	const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
	return {
		schedule: (fn: () => void, ms: number) => {
			const timer = { fn, ms, cancelled: false };
			timers.push(timer);
			return () => { timer.cancelled = true; };
		},
		run: () => { for (const timer of timers.splice(0)) if (!timer.cancelled) timer.fn(); },
		live: () => timers.filter(timer => !timer.cancelled).length,
	};
}

test("an accepted adoption answers at once, waits for the current turn without aborting it, then hands off and shuts down", () => {
	const home = agentHome();
	const timers = manualTimers();
	const target = new AdoptionTarget({ agentHome: home, env: {}, pid: 4242, schedule: timers.schedule });
	const session = targetContext();
	assert.equal(target.accept({ fleetSlug: "ship-it", token: TOKEN }, session.ctx as never), true);
	assert.deepEqual(readAdoptHandoff(home, TOKEN), { state: "accepted", pid: 4242, label: "Blog posts" });
	assert.deepEqual(session.notices, ["Adopted by fleet ship-it: this window will close after the current turn"]);
	timers.run();
	timers.run();
	assert.deepEqual(session.calls, { shutdown: 0, abort: 0 }, "a busy session keeps its turn");
	assert.equal(readAdoptHandoff(home, TOKEN)?.state, "accepted");
	session.setIdle(true);
	timers.run();
	assert.deepEqual(readAdoptHandoff(home, TOKEN), { state: "ready", pid: 4242, label: "Blog posts", sessionFile: session.sessionFile, sessionDir: join(scratch, "sessions"), cwd: join(scratch, "work", "blog") });
	assert.deepEqual(session.calls, { shutdown: 1, abort: 0 });
	target.cancel("the session closed before the hand-off");
	assert.equal(readAdoptHandoff(home, TOKEN)?.state, "ready", "its own shutdown never overwrites the hand-off");
	assert.equal(timers.live(), 0);
});

test("a refused adoption answers rejected and records the reason in the hand-off", () => {
	const home = agentHome();
	const timers = manualTimers();
	const target = new AdoptionTarget({ agentHome: home, env: {}, pid: 4242, schedule: timers.schedule });
	const rpc = targetContext({ mode: "rpc" });
	assert.equal(target.accept({ fleetSlug: "ship-it", token: TOKEN }, rpc.ctx as never), false);
	assert.deepEqual(readAdoptHandoff(home, TOKEN), { state: "refused", reason: "this is not an interactive terminal session (rpc mode)" });
	assert.deepEqual(rpc.notices, []);
	assert.equal(target.accept({ fleetSlug: "ship-it", token: "No-context-123" }, undefined), false);
	assert.equal(timers.live(), 0);
	const member = new AdoptionTarget({ agentHome: home, env: { [FLEET_ROLE_ENV]: "member" }, pid: 1, schedule: timers.schedule });
	assert.equal(member.accept({ fleetSlug: "ship-it", token: "Member-token-1" }, targetContext().ctx as never), false);
	assert.match(JSON.stringify(readAdoptHandoff(home, "Member-token-1")), /fleet member/);
	assert.equal(target.accept({ fleetSlug: "ship-it", token: "../escape" }, targetContext().ctx as never), false);
});

test("a second request while one adoption is pending is refused, and a cancelled one records why", () => {
	const home = agentHome();
	const timers = manualTimers();
	const target = new AdoptionTarget({ agentHome: home, env: {}, pid: 7, schedule: timers.schedule });
	const session = targetContext();
	assert.equal(target.accept({ fleetSlug: "one", token: TOKEN }, session.ctx as never), true);
	assert.equal(target.accept({ fleetSlug: "two", token: "Second-token-1" }, session.ctx as never), false);
	assert.deepEqual(readAdoptHandoff(home, "Second-token-1"), { state: "refused", reason: "another fleet is adopting this session" });
	target.cancel("the session changed before the hand-off");
	assert.deepEqual(readAdoptHandoff(home, TOKEN), { state: "refused", reason: "the session changed before the hand-off" });
	session.setIdle(true);
	timers.run();
	assert.equal(session.calls.shutdown, 0);
	assert.equal(timers.live(), 0);
});

// S10 R4: when the fleet gives up it marks the hand-off abandoned; the target
// reads it right before it would close and stays open instead.
test("an abandoned hand-off keeps the target open with a notice, at idle and after it wrote ready", () => {
	const home = agentHome();
	const timers = manualTimers();
	const target = new AdoptionTarget({ agentHome: home, env: {}, pid: 4242, schedule: timers.schedule });
	const session = targetContext();
	assert.equal(target.accept({ fleetSlug: "ship-it", token: TOKEN }, session.ctx as never), true);
	assert.equal(abandonAdoption(home, TOKEN, "the fleet controller closed"), true);
	session.setIdle(true);
	timers.run();
	assert.deepEqual(session.calls, { shutdown: 0, abort: 0 });
	assert.deepEqual(readAdoptHandoff(home, TOKEN), { state: "abandoned", reason: "the fleet controller closed" }, "the fleet's answer is kept");
	assert.deepEqual(session.notices.at(-1), "Gentle Fleet stopped waiting for this window (the fleet controller closed): it stays open.");
	assert.equal(timers.live(), 0);
	assert.equal(target.accept({ fleetSlug: "other", token: "Next-token-123" }, session.ctx as never), true, "the window can be adopted again");
	// The fleet gives up while the target builds its ready hand-off.
	const late = agentHome();
	const lateTimers = manualTimers();
	const lateSession = targetContext();
	const racing = new AdoptionTarget({ agentHome: late, env: {}, pid: 4242, schedule: lateTimers.schedule });
	assert.equal(racing.accept({ fleetSlug: "ship-it", token: TOKEN }, lateSession.ctx as never), true);
	lateSession.setIdle(true);
	const notify = lateSession.ctx.ui.notify;
	lateSession.ctx.sessionManager.getCwd = () => { abandonAdoption(late, TOKEN, "the fleet stopped waiting"); return join(scratch, "work", "blog"); };
	lateTimers.run();
	assert.equal(lateSession.calls.shutdown, 0, "a hand-off the fleet abandoned before the shutdown keeps the window");
	assert.equal(lateSession.ctx.ui.notify, notify);
	assert.equal(readAdoptHandoff(late, TOKEN)?.state, "abandoned", "the ready write never overwrites the fleet's answer");
	assert.match(String(lateSession.notices.at(-1)), /stopped waiting for this window \(the fleet stopped waiting\): it stays open/);
});

test("a target with queued messages waits for them before it hands off", () => {
	const home = agentHome();
	const timers = manualTimers();
	const target = new AdoptionTarget({ agentHome: home, env: {}, pid: 4242, schedule: timers.schedule });
	const session = targetContext();
	assert.equal(target.accept({ fleetSlug: "ship-it", token: TOKEN }, session.ctx as never), true);
	session.setIdle(true);
	session.setQueued(true);
	timers.run();
	timers.run();
	assert.equal(session.calls.shutdown, 0);
	assert.equal(readAdoptHandoff(home, TOKEN)?.state, "accepted");
	session.setQueued(false);
	timers.run();
	assert.equal(readAdoptHandoff(home, TOKEN)?.state, "ready");
	assert.equal(session.calls.shutdown, 1);
});

test("a request whose hand-off the fleet already abandoned is refused with nothing overwritten", () => {
	const home = agentHome();
	const timers = manualTimers();
	assert.equal(abandonAdoption(home, TOKEN, "it did not accept the adopt request"), true);
	const session = targetContext();
	const target = new AdoptionTarget({ agentHome: home, env: {}, pid: 4242, schedule: timers.schedule });
	assert.equal(target.accept({ fleetSlug: "ship-it", token: TOKEN }, session.ctx as never), false);
	assert.deepEqual(readAdoptHandoff(home, TOKEN), { state: "abandoned", reason: "it did not accept the adopt request" });
	assert.deepEqual([session.notices, timers.live()], [[], 0]);
	assert.equal(abandonAdoption(home, "../escape-it", "x"), false, "the same safe write rules: derived path only");
});

test("adopted member names come from the label and stay unique", () => {
	assert.equal(adoptedMemberName("Blog posts", []), "blog-posts");
	assert.equal(adoptedMemberName("Blog posts", ["blog-posts", "blog-posts-2"]), "blog-posts-3");
	assert.equal(adoptedMemberName("¿¿", []), "adopted");
	assert.equal(adoptedMemberName("x".repeat(80), []).length <= 32, true);
});

/** A real child process: the adopted window's pid. */
async function liveProcess() {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	await once(child, "spawn");
	const exited = once(child, "exit");
	return { pid: child.pid!, stop: async () => { child.kill("SIGKILL"); await exited; } };
}

const realTimers = () => {
	const live = new Set<ReturnType<typeof setTimeout>>();
	return {
		live,
		schedule: (fn: () => void, ms: number) => {
			const timer = setTimeout(() => { live.delete(timer); fn(); }, ms);
			live.add(timer);
			return () => { clearTimeout(timer); live.delete(timer); };
		},
	};
};
const until = async (label: string, condition: () => boolean, ms = 5000) => {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise(resolve => setTimeout(resolve, 10));
	}
};

test("the fleet respawns only after the hand-off exists and the adopted process has exited", async () => {
	const home = agentHome();
	const target = await liveProcess();
	const timers = realTimers();
	const events: string[] = [];
	writeAdoptHandoff(home, TOKEN, { state: "accepted", pid: target.pid, label: "blog" });
	const cancel = watchAdoption({ agentHome: home, token: TOKEN, pid: target.pid, schedule: timers.schedule, pollMs: 10, onReady: handoff => events.push(`ready ${handoff.label}`), onFailed: reason => events.push(`failed ${reason}`) });
	await new Promise(resolve => setTimeout(resolve, 60));
	assert.deepEqual(events, [], "no hand-off yet");
	writeAdoptHandoff(home, TOKEN, { state: "ready", pid: target.pid, label: "blog", sessionFile: "/s/x.jsonl", sessionDir: "/s", cwd: "/w" });
	await new Promise(resolve => setTimeout(resolve, 60));
	assert.deepEqual(events, [], "the hand-off exists but the process still runs");
	await target.stop();
	await until("ready", () => events.length > 0);
	assert.deepEqual(events, ["ready blog"]);
	assert.equal(timers.live.size, 0, "no timer outlives the watch");
	cancel();
});

test("a process that exits without a hand-off, a refusal or a timeout fails the adoption once", async () => {
	const home = agentHome();
	const timers = realTimers();
	const target = await liveProcess();
	const failures: string[] = [];
	watchAdoption({ agentHome: home, token: TOKEN, pid: target.pid, schedule: timers.schedule, pollMs: 10, onReady: () => failures.push("ready"), onFailed: reason => failures.push(reason) });
	await target.stop();
	await until("exit failure", () => failures.length > 0);
	assert.deepEqual(failures, ["the session closed without a hand-off"]);
	const refusedHome = agentHome();
	const alive = await liveProcess();
	writeAdoptHandoff(refusedHome, TOKEN, { state: "refused", reason: "the session changed before the hand-off" });
	const refused: string[] = [];
	watchAdoption({ agentHome: refusedHome, token: TOKEN, pid: alive.pid, schedule: timers.schedule, pollMs: 10, onReady: () => refused.push("ready"), onFailed: reason => refused.push(reason) });
	await until("refusal", () => refused.length > 0);
	assert.deepEqual(refused, ["the session changed before the hand-off"]);
	let now = 0;
	const slow: string[] = [];
	watchAdoption({ agentHome: agentHome(), token: TOKEN, pid: alive.pid, schedule: timers.schedule, pollMs: 10, turnTimeoutMs: 1000, now: () => (now += 400), onReady: () => slow.push("ready"), onFailed: reason => slow.push(reason) });
	await until("timeout", () => slow.length > 0);
	assert.deepEqual(slow, ["the session did not finish its turn within 1 s"]);
	await alive.stop();
	await tick();
	assert.equal(timers.live.size, 0);
});

test("a watch that gives up marks the hand-off abandoned; one that ended on the target's answer does not", async (t) => {
	const timers = realTimers();
	const alive = await liveProcess();
	t.after(alive.stop);
	let now = 0;
	const slow: string[] = [];
	const turnHome = agentHome();
	writeAdoptHandoff(turnHome, TOKEN, { state: "accepted", pid: alive.pid, label: "blog" });
	watchAdoption({ agentHome: turnHome, token: TOKEN, pid: alive.pid, schedule: timers.schedule, pollMs: 10, turnTimeoutMs: 1000, now: () => (now += 400), onReady: () => slow.push("ready"), onFailed: reason => slow.push(reason) });
	await until("turn timeout", () => slow.length > 0);
	assert.deepEqual(readAdoptHandoff(turnHome, TOKEN), { state: "abandoned", reason: "the session did not finish its turn within 1 s" });
	const exitHome = agentHome();
	const ready = { state: "ready" as const, pid: alive.pid, label: "blog", sessionFile: "/s/x.jsonl", sessionDir: "/s", cwd: "/w" };
	writeAdoptHandoff(exitHome, TOKEN, ready);
	let later = 0;
	const stuck: string[] = [];
	watchAdoption({ agentHome: exitHome, token: TOKEN, pid: alive.pid, schedule: timers.schedule, pollMs: 10, exitTimeoutMs: 1000, now: () => (later += 400), onReady: () => stuck.push("ready"), onFailed: reason => stuck.push(reason) });
	await until("exit timeout", () => stuck.length > 0);
	assert.deepEqual(readAdoptHandoff(exitHome, TOKEN), { state: "abandoned", reason: "the session wrote its hand-off but did not exit within 1 s" });
	const cancelHome = agentHome();
	writeAdoptHandoff(cancelHome, TOKEN, { state: "accepted", pid: alive.pid, label: "blog" });
	const cancel = watchAdoption({ agentHome: cancelHome, token: TOKEN, pid: alive.pid, schedule: timers.schedule, pollMs: 10, onReady: () => {}, onFailed: () => {} });
	cancel("the fleet controller closed");
	assert.deepEqual(readAdoptHandoff(cancelHome, TOKEN), { state: "abandoned", reason: "the fleet controller closed" });
	const refusedHome = agentHome();
	writeAdoptHandoff(refusedHome, TOKEN, { state: "refused", reason: "the session changed before the hand-off" });
	const refused: string[] = [];
	const cancelRefused = watchAdoption({ agentHome: refusedHome, token: TOKEN, pid: alive.pid, schedule: timers.schedule, pollMs: 10, onReady: () => {}, onFailed: reason => refused.push(reason) });
	await until("refusal", () => refused.length > 0);
	cancelRefused("too late");
	assert.deepEqual(readAdoptHandoff(refusedHome, TOKEN), { state: "refused", reason: "the session changed before the hand-off" }, "the target's own answer is kept");
	await alive.stop();
	await tick();
	assert.equal(timers.live.size, 0);
});

test("cancelling a watch clears its timer and reports nothing", async () => {
	const timers = realTimers();
	const events: string[] = [];
	const cancel = watchAdoption({ agentHome: agentHome(), token: TOKEN, pid: process.pid, schedule: timers.schedule, pollMs: 10, onReady: () => events.push("ready"), onFailed: reason => events.push(reason) });
	await new Promise(resolve => setTimeout(resolve, 30));
	cancel();
	assert.equal(timers.live.size, 0);
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.deepEqual(events, []);
	assert.equal(isProcessAlive(process.pid), true);
});

posixTest("the default transport sends an adopt request to a live peer and reports its answer", async (t) => {
	const home = agentHome();
	chmodSync(home, 0o755);
	mkdirSync(join(home, "gentle-agents"), { mode: 0o755 });
	const registry = await SessionPresenceRegistry.create(home);
	const received: ReceivedAdopt[] = [];
	const accepting = new ActiveSessionListener(registry, "peer-accepts", async () => { throw new Error("never a notification"); }, { onAdopt: async request => { received.push(request); return true; } });
	const refusing = new ActiveSessionListener(registry, "peer-refuses", async () => {}, { onAdopt: async () => false });
	t.after(() => Promise.all([accepting.close(), refusing.close()]));
	await Promise.all([accepting.start(), refusing.start()]);
	const transport = createAdoptTransport(home);
	assert.deepEqual((await transport.candidates("fleet-1")).map(candidate => candidate.sessionId), ["peer-accepts", "peer-refuses"]);
	assert.deepEqual((await transport.candidates("peer-accepts")).map(candidate => candidate.sessionId), ["peer-refuses"], "the fleet's own session is never a candidate");
	assert.equal(await transport.send("fleet-1", "peer-accepts", { fleetSlug: "ship-it", token: TOKEN }), true);
	assert.deepEqual(received.map(request => [request.senderSessionId, request.fleetSlug, request.token]), [["fleet-1", "ship-it", TOKEN]]);
	assert.equal(await transport.send("fleet-1", "peer-refuses", { fleetSlug: "ship-it", token: TOKEN }), false);
});
