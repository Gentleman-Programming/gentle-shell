import assert from "node:assert/strict";
import { test } from "node:test";
import type { JobRecord } from "../lib/background-jobs.ts";
import { projectDesktopJob } from "../lib/desktop-rpc-jobs.ts";
import { DesktopPermissionBridge } from "../lib/desktop-rpc-permissions.ts";
import { YOLO_DISPLAY } from "../lib/yolo-session-policy.ts";

function job(command: string, label = command, kind: JobRecord["kind"] = "command"): JobRecord {
	return {
		id: "job-1",
		kind,
		label,
		command,
		cwd: "/home/devel/secret-repo",
		ownerSessionId: "session-a",
		outputPath: "/tmp/gentle-jobs/job-1.log",
		startedAt: 1000,
		status: "running",
		tail: [],
	};
}

test("a job without its own label never shows any part of its command", () => {
	// Every form a shell can hide a value in: headers, assignments (plain,
	// quoted, escaped), quoted and Windows paths, substitutions, unbalanced quotes.
	const commands = [
		'curl -H "Authorization: Bearer sk-live-123" https://api.example.com',
		"GITHUB_TOKEN=ghp_secret /home/devel/bin/deploy.sh --key=s3cr3t",
		'"C:\\Program Files\\Tools\\app.exe" --token=s3cr3t',
		'API_KEY="prefix s3cr3t" /usr/bin/curl https://example.com',
		"TOKEN=prefix\\ s3cr3t /usr/bin/curl",
		"$(printf s3cr3t) --flag",
		'API_KEY="unterminated s3cr3t /usr/bin/curl',
		"  npm run build  ",
		"",
	];
	for (const [index, command] of commands.entries()) {
		const projected = projectDesktopJob(job(command));
		assert.equal(projected.label, "Background job", `case ${index}`);
		const wire = JSON.stringify(projected);
		for (const secret of ["sk-live-123", "ghp_secret", "s3cr3t", "/home/devel", "Authorization", "npm"]) {
			assert.equal(wire.includes(secret), false, `case ${index} leaks a command fragment`);
		}
	}
	assert.equal(projectDesktopJob(job("tail -f /var/log/app.log", undefined, "monitor")).label, "Background monitor");
});

test("an explicit job label is kept as the agent wrote it", () => {
	assert.equal(projectDesktopJob(job("gh run watch 42 --exit-status", "CI for PR 42")).label, "CI for PR 42");
});

type Snapshot = { mode: string; defaultMode: string; yolo: string };

function fakeAdapter(snapshots: Array<Snapshot | undefined>) {
	let reads = 0;
	const disposed: string[] = [];
	const adapter = {
		readSnapshot: async () => snapshots[Math.min(reads++, snapshots.length - 1)],
		setMode: async () => true,
		saveDefault: async () => true,
		dispose: () => disposed.push("adapter"),
	};
	return { adapter, disposed };
}

const live = (mode: string): Snapshot => ({ mode, defaultMode: "normal", yolo: "on" });

test("set_permission_mode never echoes the request when the owner cannot confirm the result", async () => {
	// Before the write the owner answers; after it the session was replaced or
	// revoked, so the post-write read is unavailable.
	const { adapter } = fakeAdapter([live("normal"), { mode: "yolo", defaultMode: "normal", yolo: YOLO_DISPLAY.unavailable }]);
	const bridge = new DesktopPermissionBridge({} as never, (async () => adapter) as never);
	bridge.attach({} as never);
	const outcome = await bridge.handle("set_permission_mode", { mode: "yolo", persist: true });
	assert.equal(outcome?.ok, false);
	assert.deepEqual((outcome as { ok: false; error: { code: string } }).error.code, "permission_unavailable");
	assert.equal("event" in (outcome ?? {}), false, "no permission_mode_changed for an unconfirmed result");
});

test("a confirmed set still reports the owner's state and one event", async () => {
	const { adapter } = fakeAdapter([live("normal"), live("auto")]);
	const bridge = new DesktopPermissionBridge({} as never, (async () => adapter) as never);
	bridge.attach({} as never);
	const outcome = (await bridge.handle("set_permission_mode", { mode: "auto" })) as {
		ok: true;
		data: Record<string, unknown>;
		event?: { name: string };
	};
	assert.equal(outcome.ok, true);
	assert.equal(outcome.data.mode, "auto");
	assert.equal(outcome.event?.name, "permission_mode_changed");
});

test("an owner discovered after a reset is disposed and never cached for the next session", async () => {
	const stale = fakeAdapter([live("yolo")]);
	const fresh = fakeAdapter([live("normal")]);
	let release: (value: unknown) => void = () => {};
	let calls = 0;
	const discover = (() => {
		calls += 1;
		if (calls === 1) return new Promise((resolve) => { release = () => resolve(stale.adapter); });
		return Promise.resolve(fresh.adapter);
	}) as never;
	const bridge = new DesktopPermissionBridge({} as never, discover);
	bridge.attach({} as never);
	const pending = bridge.handle("get_permission_mode", {});
	await Promise.resolve();
	bridge.reset();
	bridge.attach({} as never);
	release(undefined);
	const late = await pending;
	assert.equal(late?.ok, false, "the replaced session's request does not answer from its owner");
	assert.deepEqual(stale.disposed, ["adapter"], "the late owner is disposed");

	const next = (await bridge.handle("get_permission_mode", {})) as { ok: true; data: Record<string, unknown> };
	assert.equal(next.ok, true);
	assert.equal(next.data.mode, "normal", "the next session reads its own owner, not the late one");
	assert.equal(calls, 2);
});
