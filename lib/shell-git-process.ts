import { execFile, type ChildProcess } from "node:child_process";
import { win32 } from "node:path";

// Resolve from the host environment, never the caller's Git environment or PATH.
const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
const taskkill = win32.join(systemRoot, "System32", "taskkill.exe");
const CLEANUP_TIMEOUT_MS = 1000;

export function runShellGit(cwd: string, args: string[], env: NodeJS.ProcessEnv, run: typeof execFile = execFile, platform = process.platform, timeout = 5000): Promise<{ stdout: string; code: number }> {
	return new Promise((resolve) => {
		let child: ChildProcess | undefined;
		let closed = false;
		let exited = false;
		let settled = false;
		let timedOut = false;
		let output = "";
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
		let cleanup: ChildProcess | undefined;
		const settle = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			clearTimeout(cleanupDeadline);
			resolve({ stdout: output, code });
		};
		// Exit can precede close/callback when descendants retain inherited pipes.
		const rootEnded = () => closed || exited || child?.exitCode != null || child?.signalCode != null;
		const fallback = () => {
			if (settled) return;
			// Never address a recycled PID after the owned process has exited.
			if (!rootEnded()) {
				try { child?.kill(); } catch { /* Failure still settles the command. */ }
			}
			settle(1);
		};
		try {
			child = run("git", ["-C", cwd, ...args], {
				env, encoding: "utf8", shell: false, windowsHide: true,
				timeout: platform === "win32" ? 0 : timeout, maxBuffer: Infinity,
			}, (error, stdout) => {
				if (settled) return;
				output = stdout;
				closed = true;
				// During tree termination wait for cleanup to finish, not just Git.
				if (timedOut) return;
				settle(error ? typeof error.code === "number" && error.code !== 0 ? error.code : 1 : 0);
			});
		} catch {
			settle(1);
		}
		if (settled || platform !== "win32") return;
		child?.once("exit", () => { exited = true; });
		child?.once("close", () => { closed = true; });
		child?.once("error", () => { if (!timedOut) settle(1); });
		deadline = setTimeout(() => {
			if (settled) return;
			timedOut = true;
			if (rootEnded() || !Number.isSafeInteger(child?.pid) || (child?.pid ?? 0) <= 0) {
				fallback();
				return;
			}
			// Keep Git alive until taskkill has captured its descendant tree.
			cleanupDeadline = setTimeout(() => {
				try { cleanup?.kill(); } catch { /* Bounded even if taskkill cannot terminate. */ }
				fallback();
			}, CLEANUP_TIMEOUT_MS);
			try {
				cleanup = run(taskkill, ["/PID", String(child!.pid), "/T", "/F"], {
					encoding: "utf8", shell: false, windowsHide: true,
					timeout: CLEANUP_TIMEOUT_MS,
				}, fallback);
				cleanup?.once("error", fallback);
			} catch {
				fallback();
			}
		}, timeout);
	});
}
