#!/usr/bin/env node
// The version is read from the installer rather than written here. Two
// hardcoded copies of it survived a pin bump once and reported installing
// v2.1.11 while writing v2.2.0 to disk, which is the one moment an operator
// most needs the number to be true.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALLER_VERSION, installGentleAi } from "./gentle-ai-installer.mjs";
import { installTuiModeSetting, isPiManagedInstall } from "./install-tui-mode-setting.mjs";

const FAILURE_CAUSE_DEPTH = 6;
const FAILURE_OUTPUT_TAIL = 4000;

function failureOutputs(error) {
	return ["stderr", "stdout"].map((stream) => [stream, typeof error?.[stream] === "string" ? error[stream].trimEnd() : ""]).filter(([, text]) => text.trim().length > 0);
}

function failureHeadline(error, outputs) {
	const message = error instanceof Error ? error.message : String(error);
	// A child-process error repeats its stderr after the first message line; it is printed below, bounded.
	const text = outputs.length > 0 ? message.split(/\r?\n/)[0] : message;
	const status = [
		...(typeof error?.code === "string" || typeof error?.code === "number" ? [`code ${error.code}`] : []),
		...(typeof error?.signal === "string" ? [`signal ${error.signal}`] : []),
	];
	return `${text}${status.length > 0 ? ` (${status.join(", ")})` : ""}`;
}

/**
 * A failed installation for the postinstall's stderr: the error's message, then its
 * `cause` chain (at most 6 deep) with each code and the last 4000 characters of any
 * stdout/stderr a failed command left on it. When a cause carried output, the last
 * line repeats the deepest one's last output line in `Error:` form, the line the
 * installer wizard's one-line failure detail selects after pnpm's own summary.
 */
function describeGentleAiInstallFailure(error) {
	const lines = [];
	let rootCause = null;
	let cause = error;
	for (let depth = 0; cause !== undefined && cause !== null && depth <= FAILURE_CAUSE_DEPTH; depth += 1) {
		const outputs = failureOutputs(cause);
		const name = cause instanceof Error && typeof cause.name === "string" && cause.name !== "" ? cause.name : "Error";
		lines.push(depth === 0 ? failureHeadline(cause, outputs) : `  caused by ${name}: ${failureHeadline(cause, outputs)}`);
		for (const [stream, text] of outputs) {
			const tail = text.length > FAILURE_OUTPUT_TAIL ? text.slice(-FAILURE_OUTPUT_TAIL) : text;
			lines.push(`    ${stream}${tail === text ? "" : ` (last ${FAILURE_OUTPUT_TAIL} characters)`}:`, ...tail.split(/\r?\n/).map((line) => `    | ${line}`));
		}
		// stderr first: a deeper cause's output replaces a shallower one's.
		if (outputs.length > 0) rootCause = outputs[0][1].split(/\r?\n/).findLast((line) => line.trim().length > 0).trim();
		cause = cause instanceof Error ? cause.cause : undefined;
	}
	if (cause !== undefined && cause !== null) lines.push("  ... further causes omitted");
	if (rootCause !== null) lines.push(`  root cause Error: ${rootCause}`);
	return lines.join("\n");
}

if (process.env.GENTLE_PI_SKIP_GENTLE_AI_INSTALL === "1") {
	console.warn("GENTLE_PI_SKIP_GENTLE_AI_INSTALL=1: skipped package-local Gentle AI installation; native review operations will fail with package-local-binary-missing until gentle-pi is reinstalled.");
} else {
	try {
		const result = await installGentleAi();
		console.log(`Gentle AI v${INSTALLER_VERSION} ${result.installed ? "installed" : "integrity-verified"} at ${result.binaryPath}`);
	} catch (error) {
		// The whole cause chain: the failing command's own output is the diagnosis.
		console.error(`gentle-pi could not install its package-local Gentle AI v${INSTALLER_VERSION} binary: ${describeGentleAiInstallFailure(error)}`);
		process.exitCode = 1;
	}
}

// A native failure never changes settings; the explicit native-only skip does.
if (!process.exitCode) {
	const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
	if (!isPiManagedInstall(packageDir)) {
		console.log(`gentle-pi skipped enabling fullscreen in global Pi settings: ${packageDir} is not a pi-managed install (npm install -g, a git checkout, and npx all land here).`);
	} else {
		try {
			const result = await installTuiModeSetting();
			if (result.changed) console.log("gentle-pi enabled fullscreen in global Pi settings; /settings can switch back to regular.");
		} catch (error) {
			console.error(`gentle-pi could not enable fullscreen: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
	}
}
