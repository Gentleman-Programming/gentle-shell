#!/usr/bin/env node
// The version is read from the installer rather than written here. Two
// hardcoded copies of it survived a pin bump once and reported installing
// v2.1.11 while writing v2.2.0 to disk, which is the one moment an operator
// most needs the number to be true.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALLER_VERSION, installGentleAi } from "./gentle-ai-installer.mjs";
import { installTuiModeSetting, isPiManagedInstall } from "./install-tui-mode-setting.mjs";

if (process.env.GENTLE_PI_SKIP_GENTLE_AI_INSTALL === "1") {
	console.warn("GENTLE_PI_SKIP_GENTLE_AI_INSTALL=1: skipped package-local Gentle AI installation; native review operations will fail with package-local-binary-missing until gentle-pi is reinstalled.");
} else {
	try {
		const result = await installGentleAi();
		console.log(`Gentle AI v${INSTALLER_VERSION} ${result.installed ? "installed" : "integrity-verified"} at ${result.binaryPath}`);
	} catch (error) {
		console.error(`gentle-pi could not install its package-local Gentle AI v${INSTALLER_VERSION} binary: ${error instanceof Error ? error.message : String(error)}`);
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
