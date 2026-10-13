import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureEnabled } from "../extensions/history/index.ts";

// An env that owns `behavior` keeps history-capture.json in its own config
// home: the capture gate must read that file, not the shared one.
test("history capture follows the env's own behavior scope", (t) => {
	const root = mkdtempSync(join(tmpdir(), "history-env-scope-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const shared = join(root, "shared");
	const own = join(root, "env", "gentle-ai");
	for (const [dir, policy] of [[shared, "off"], [own, "on"]] as const) {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "history-capture.json"), JSON.stringify({ schema: "gentle-pi.history-capture/v1", policy }));
	}
	const base = { GENTLE_PI_CONFIG_HOME: shared };
	assert.equal(captureEnabled(base), false, "no scope: the shared preference");
	assert.equal(captureEnabled({ ...base, GENTLE_SHELL_ENV_CONFIG_HOME: own, GENTLE_SHELL_ENV_OWN_CONFIG: "behavior" }), true);
	assert.equal(captureEnabled({ ...base, GENTLE_SHELL_ENV_CONFIG_HOME: own, GENTLE_SHELL_ENV_OWN_CONFIG: "appearance" }), false, "behavior shared");
});
