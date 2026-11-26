import { execFile } from "node:child_process";
import { Worker, type WorkerOptions } from "node:worker_threads";
import type { GitResult } from "./shell-changes.ts";

const GIT_WORKER_IDLE_MS = 30_000;

// On POSIX the Git pipes and deadline must progress even while rendering
// blocks the UI thread. The program is fixed; arguments travel as data.
const GIT_READ_WORKER_SOURCE = `
	import { execFile } from "node:child_process";
	import { parentPort } from "node:worker_threads";
	parentPort.on("message", ({ id, args, options }) => {
		try {
			execFile("git", args, options, (error, stdout) => {
				parentPort.postMessage({ id, stdout, error: error && { code: error.code, killed: error.killed } });
			});
		} catch {
			parentPort.postMessage({ id, stdout: "", error: null, unavailable: true });
		}
	});
`;

export type GitExecError = { code?: unknown; killed?: boolean };
export type ShellGitReadResult = GitResult & { unavailable?: true };

export function gitExecResult(error: GitExecError | null, stdout: string, timedOut: boolean): ShellGitReadResult {
	if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { stdout, code: 1, truncated: true };
	// execFile reports a Git exit as a number (or null for a signal), but a
	// spawn failure such as ENOENT or EACCES as a system error code.
	if (!timedOut && typeof error?.code === "string") return { stdout, code: 1, unavailable: true };
	const code = timedOut ? 1 : error ? typeof error.code === "number" ? error.code : 1 : 0;
	return { stdout, code, ...(timedOut ? { timedOut: true } : {}) };
}

export const failedGitRead = (): ShellGitReadResult => ({ stdout: "", code: 1, unavailable: true });

type GitReadOptions = { env: NodeJS.ProcessEnv; encoding: "utf8"; shell: false; windowsHide: true; maxBuffer: number; timeout: number };
export type ShellGitWorkerRead = (args: string[], options: GitReadOptions) => Promise<ShellGitReadResult>;

function readDirect(args: string[], options: GitReadOptions, resolve: (result: ShellGitReadResult) => void) {
	try {
		execFile("git", args, options, (error, stdout) => resolve(gitExecResult(error, stdout, Boolean(error?.killed))));
	} catch {
		resolve(failedGitRead());
	}
}

type WorkerState = {
	worker: Worker;
	// An absent result means the worker was lost; the request can run directly unless closed.
	pending: Map<number, (result?: ShellGitReadResult) => void>;
	idle?: NodeJS.Timeout;
	drained?: () => void;
};

export function createShellGitWorker(shutdownMs: number, launchWorker = (url: URL, options: WorkerOptions) => new Worker(url, options)) {
	let current: WorkerState | undefined;
	let closed = false;
	let workerUnavailable = false;
	let stopped: Promise<void> | undefined;
	let nextId = 0;
	const retiring = new Set<Promise<number>>();

	const settleLostReads = (state: WorkerState) => {
		for (const finish of state.pending.values()) finish();
		state.pending.clear();
		state.drained?.();
	};
	const retire = (state: WorkerState, unavailable = false) => {
		if (current !== state) return;
		current = undefined;
		if (unavailable) workerUnavailable = true;
		clearTimeout(state.idle);
		settleLostReads(state);
		const exit = state.worker.terminate();
		retiring.add(exit);
		void exit.then(() => retiring.delete(exit));
	};
	const onSettled = (state: WorkerState) => {
		if (state.pending.size || current !== state) return;
		if (closed) {
			state.drained?.();
			return;
		}
		state.worker.unref();
		state.idle = setTimeout(() => retire(state), GIT_WORKER_IDLE_MS).unref();
	};
	const getWorker = () => {
		if (current) return current;
		const worker = launchWorker(new URL(`data:text/javascript,${encodeURIComponent(GIT_READ_WORKER_SOURCE)}`), { env: {}, execArgv: [] });
		const state: WorkerState = { worker, pending: new Map() };
		worker.on("error", () => retire(state, true));
		worker.on("exit", () => {
			if (current === state) {
				current = undefined;
				if (state.pending.size) workerUnavailable = true;
			}
			clearTimeout(state.idle);
			settleLostReads(state);
		});
		worker.on("message", ({ id, error, stdout, unavailable }: { id: number; error: GitExecError | null; stdout: string; unavailable?: true }) => {
			const finish = state.pending.get(id);
			if (!finish) return;
			state.pending.delete(id);
			finish(unavailable ? failedGitRead() : gitExecResult(error, stdout, Boolean(error?.killed)));
			onSettled(state);
		});
		return current = state;
	};
	const read: ShellGitWorkerRead = (args, options) => new Promise((resolve) => {
		const finish = (result?: ShellGitReadResult) => {
			if (result) resolve(result);
			else if (closed) resolve(failedGitRead());
			else readDirect(args, options, resolve);
		};
		if (closed || workerUnavailable) { finish(); return; }
		let state: WorkerState | undefined;
		const id = ++nextId;
		try {
			state = getWorker();
			clearTimeout(state.idle);
			state.pending.set(id, finish);
			state.worker.ref();
			state.worker.postMessage({ id, args, options });
		} catch {
			workerUnavailable = true;
			if (state) retire(state);
			else finish();
		}
	});
	return {
		read,
		dispose() {
			if (stopped) return stopped;
			closed = true;
			return stopped = (async () => {
				const state = current;
				if (state) {
					clearTimeout(state.idle);
					if (state.pending.size) {
						// Normally the Git callback drains the worker. A stuck child or
						// pipe must not hang session replacement past the Git deadline.
						await new Promise<void>((resolve) => {
							const timeout = setTimeout(() => state.drained?.(), shutdownMs);
							state.drained = () => {
								clearTimeout(timeout);
								state.drained = undefined;
								resolve();
							};
						});
					}
					retire(state);
				}
				await Promise.all(retiring);
			})();
		},
	};
}
