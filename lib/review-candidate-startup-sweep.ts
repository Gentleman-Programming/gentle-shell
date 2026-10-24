import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CandidateSweepResult } from "./review-candidate-view-owner.ts";

const inFlight = new Map<string, Promise<CandidateSweepResult>>();
type SweepRunner = (cwd: string) => Promise<CandidateSweepResult>;

// Hang backstop only: the soft work budget stops new marker work, so this must stay well above it.
const HELPER_TIMEOUT_MS = 120_000;
const DEFAULT_SCRIPT = fileURLToPath(new URL("../scripts/sweep-candidate-views.mjs", import.meta.url));

export function launchSweep(cwd: string, { timeoutMs = HELPER_TIMEOUT_MS, script = DEFAULT_SCRIPT } = {}): Promise<CandidateSweepResult> {
	return new Promise((resolveResult, reject) => {
		// Do not inherit Pi loaders/debugger flags. The package supports Node >=22.19.
		// Discovery, ACL probes, chmod and Git removal all execute outside Pi's event loop.
		execFile(process.execPath, [
			"--experimental-strip-types",
			script,
			cwd,
		], { windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024, timeout: timeoutMs }, (error, stdout) => {
			if (error) { reject(new Error((error as { killed?: boolean }).killed ? "Candidate cleanup helper timed out" : "Candidate cleanup helper failed")); return; }
			try {
				const result = JSON.parse(stdout) as CandidateSweepResult;
				if (!result || ["examined", "remaining", "failed"].some((key) => {
					const value = result[key as "examined" | "remaining" | "failed"];
					return !Number.isSafeInteger(value) || value < 0;
				}) || typeof result.budgetExceeded !== "boolean" || typeof result.unavailable !== "boolean") throw new Error("Invalid result");
				resolveResult(result);
			} catch { reject(new Error("Candidate cleanup helper returned an invalid result")); }
		});
	});
}

/** A soft-bounded, asynchronous child; shared across reloads while still running. */
export function runCandidateStartupSweep(cwd: string, runner: SweepRunner = launchSweep): Promise<CandidateSweepResult> {
	const key = process.platform === "win32" ? resolve(cwd).toLowerCase() : resolve(cwd);
	const existing = inFlight.get(key);
	if (existing) return existing;
	const pending = Promise.resolve().then(() => runner(cwd)).finally(() => {
		if (inFlight.get(key) === pending) inFlight.delete(key);
	});
	inFlight.set(key, pending);
	return pending;
}
