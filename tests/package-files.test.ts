import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { missingRequiredPaths, requiredPaths } from "../scripts/verify-package-files.mjs";

// The voice worker is spawned by path and never imported, so only the package
// check keeps it in the published tarball next to the modules that launch it.

const root = fileURLToPath(new URL("..", import.meta.url));

test("the package check requires the voice command, its modules and the worker script", () => {
	const voice = ["extensions/gentle-voice.ts", "lib/voice-command.ts", "lib/voice-session.ts", "lib/voice-ui.ts", "scripts/voice-worker.cjs", "docs/voice.md"];
	for (const path of voice) assert.ok(requiredPaths.includes(path), `${path} is required`);
	assert.deepEqual(missingRequiredPaths(root, voice), []);
});
