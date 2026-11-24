import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DESKTOP_CHANGES_SERVICE_CHANNEL, type DesktopChangesService } from "../lib/desktop-rpc-changes.ts";

function install(shell: typeof import("../extensions/gentle-shell.ts").default, root: string, config: string, id: string) {
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const listeners = new Map<string, (event: unknown) => void>();
	const entries: unknown[] = [];
	const pi = {
		on: (key: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(key, [...(handlers.get(key) ?? []), handler]),
		events: { on: (key: string, listener: (event: unknown) => void) => { listeners.set(key, listener); return () => undefined; }, emit() {} },
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		registerCommand() {}, registerTool() {}, registerShortcut() {}, registerMessageRenderer() {},
	} as unknown as ExtensionAPI;
	shell(pi, { GENTLE_PI_CONFIG_HOME: config }, {
		devBinary: () => undefined,
		resolveWorktree: () => ({ root, commonDir: join(root, ".git") }),
	});
	const ctx = {
		mode: "rpc", hasUI: true, cwd: root,
		sessionManager: { getSessionId: () => id, getEntries: () => entries },
		ui: { setFooter() {}, getEditorComponent: () => ({}), setWorkingVisible() {}, setWidget() {}, notify() {} },
	} as unknown as ExtensionContext;
	return {
		async fire(event: string) { for (const handle of handlers.get(event) ?? []) await handle({}, ctx); },
		read() {
			let adapter: DesktopChangesService | undefined;
			listeners.get(DESKTOP_CHANGES_SERVICE_CHANNEL)!({ context: ctx, respond: (service: DesktopChangesService) => { adapter = service; } });
			assert.ok(adapter, "the active session exposes the public Changes service");
			return adapter.read();
		},
	};
}

test("Git workers drain on shutdown, do not accumulate on reload, and restart lazily", { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "gentle-worker-reload-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const config = join(root, ".test-config");
	mkdirSync(config);
	const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]);
	git("init", "-q", "--initial-branch=main");
	git("commit", "-q", "--allow-empty", "-m", "base");
	writeFileSync(join(root, "new.txt"), "hello\n");

	const workers = new Set<Worker>();
	let onPost: (() => void) | undefined;
	const post = Worker.prototype.postMessage;
	t.mock.method(Worker.prototype, "postMessage", function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
		workers.add(this);
		post.apply(this, args);
		onPost?.();
	});
	// Count actual Node worker handles used by the production Git runner. Node
	// resets threadId to -1 on exit, including for a worker that was unref'd.
	const live = () => [...workers].filter((worker) => worker.threadId !== -1).length;
	t.after(async () => { await Promise.all([...workers].filter((worker) => worker.threadId !== -1).map((worker) => worker.terminate())); });
	const shutdownCounts: number[] = [];
	for (let cycle = 0; cycle < 3; cycle++) {
		const { default: shell } = await import(`../extensions/gentle-shell.ts?git-worker-reload=${cycle}`) as typeof import("../extensions/gentle-shell.ts");
		const app = install(shell, root, config, `session-${cycle}`);
		const previous = workers.size;
		await app.fire("session_start");
		assert.equal(workers.size, previous, "startup is lazy");
		assert.equal((await app.read())?.files.find((file) => file.path === "new.txt")?.added, 1);
		assert.equal(workers.size, previous + 1, "the real runner started one worker");
		await app.fire("session_shutdown");
		shutdownCounts.push(live());

		if (cycle === 2) {
			// Restart on the same factory, and take shutdown between posting a worktree
			// request and delivering its reply. The old scan must not start a new worker.
			await app.fire("session_start");
			assert.equal((await app.read())?.files.find((file) => file.path === "new.txt")?.added, 1);
			const pending = Promise.withResolvers<void>();
			onPost = pending.resolve;
			const reading = app.read();
			await pending.promise;
			onPost = undefined;
			await app.fire("session_shutdown");
			assert.equal(await reading, undefined, "the in-flight read settled for the closed session");
			shutdownCounts.push(live());
		}
	}
	assert.deepEqual(shutdownCounts, [0, 0, 0, 0], "no worker survived its session or accumulated across reloads");
});
