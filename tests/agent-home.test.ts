import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundledDrakoncPiAgentHome, drakoncPiConfigHome } from "../lib/agent-home.ts";
import { setBundledInstallForTesting } from "../lib/drakonc-shell-bundled.ts";

// The two Pi homes: `~/.pi/agent` holds Pi's own agent definitions and
// `~/.drakonc-shell/drakonc-ai` holds everything the Drakonc AI commands own. Both are resolved
// once and shared, because the launch-time profile pin resolver reads the same
// profiles store the `/drakonc:profiles` panel writes: two spellings of the override
// would silently read two different stores.

function isolatedHome(t: test.TestContext): string {
	const home = mkdtempSync(join(tmpdir(), "drakonc-pi-config-home-"));
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousConfigHome = process.env.DRAKONC_PI_CONFIG_HOME;
	const previousShellConfigHome = process.env.DRAKONC_SHELL_CONFIG_HOME;
	// Clear both config overrides as well as isolating both OS homes.
	delete process.env.DRAKONC_PI_CONFIG_HOME;
	delete process.env.DRAKONC_SHELL_CONFIG_HOME;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	t.after(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		if (previousConfigHome === undefined) delete process.env.DRAKONC_PI_CONFIG_HOME;
		else process.env.DRAKONC_PI_CONFIG_HOME = previousConfigHome;
		if (previousShellConfigHome === undefined) delete process.env.DRAKONC_SHELL_CONFIG_HOME;
		else process.env.DRAKONC_SHELL_CONFIG_HOME = previousShellConfigHome;
		rmSync(home, { recursive: true, force: true });
	});
	return home;
}

test("drakoncPiConfigHome honours DRAKONC_PI_CONFIG_HOME and otherwise falls back to ~/.drakonc-shell/drakonc-ai", (t) => {
	const home = isolatedHome(t);
	assert.equal(drakoncPiConfigHome({ DRAKONC_PI_CONFIG_HOME: "/custom/drakonc-ai" }), "/custom/drakonc-ai");
	assert.equal(drakoncPiConfigHome({ DRAKONC_PI_CONFIG_HOME: "" }), join(homedir(), ".drakonc-shell", "drakonc-ai"));
	assert.equal(drakoncPiConfigHome({}), join(homedir(), ".drakonc-shell", "drakonc-ai"));
	assert.equal(drakoncPiConfigHome(), join(homedir(), ".drakonc-shell", "drakonc-ai"));
	assert.equal(
		join(drakoncPiConfigHome(), "profiles.json"),
		join(home, ".drakonc-shell", "drakonc-ai", "profiles.json"),
		"the store path is derived from the config home, not from the agent home",
	);
});

test("the isolated home restores defined and undefined config overrides", async (t) => {
	const previous = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		DRAKONC_PI_CONFIG_HOME: process.env.DRAKONC_PI_CONFIG_HOME,
		DRAKONC_SHELL_CONFIG_HOME: process.env.DRAKONC_SHELL_CONFIG_HOME,
	};
	const config = join(tmpdir(), "synthetic-inherited-config");
	const marker = join(tmpdir(), "synthetic-inherited-marker");
	try {
		for (const [pi, shell] of [[undefined, undefined], [config, marker], [undefined, marker], [config, undefined]]) {
			if (pi === undefined) delete process.env.DRAKONC_PI_CONFIG_HOME;
			else process.env.DRAKONC_PI_CONFIG_HOME = pi;
			if (shell === undefined) delete process.env.DRAKONC_SHELL_CONFIG_HOME;
			else process.env.DRAKONC_SHELL_CONFIG_HOME = shell;
			await t.test(`inherited pi ${pi === undefined ? "unset" : "set"}, shell ${shell === undefined ? "unset" : "set"}`, (child) => {
				const home = isolatedHome(child);
				assert.equal(process.env.DRAKONC_PI_CONFIG_HOME, undefined);
				assert.equal(process.env.DRAKONC_SHELL_CONFIG_HOME, undefined);
				assert.equal(drakoncPiConfigHome(), join(home, ".drakonc-shell", "drakonc-ai"));
			});
			assert.equal(process.env.DRAKONC_PI_CONFIG_HOME, pi);
			assert.equal(process.env.DRAKONC_SHELL_CONFIG_HOME, shell);
			assert.equal(process.env.HOME, previous.HOME);
			assert.equal(process.env.USERPROFILE, previous.USERPROFILE);
		}
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("the config home ignores the Pi agent-home overrides", (t) => {
	const home = isolatedHome(t);
	// PI_CODING_AGENT_DIR and DRAKONC_PI_AGENT_HOME move Pi's agent directory only.
	// Reusing that resolver here would point the profiles store at the agent home.
	assert.equal(
		drakoncPiConfigHome({ PI_CODING_AGENT_DIR: "/pi/agent", DRAKONC_PI_AGENT_HOME: "/drakonc/agent" }),
		join(home, ".drakonc-shell", "drakonc-ai"),
	);
});

// S9: a bundled Drakonc Shell keeps drakonc-pi's config inside its prefix. It is
// derived from this package's bundled install and the launcher's
// DRAKONC_SHELL_PREFIX, never exported (Drakonc AI 4.0.0 reads
// DRAKONC_PI_CONFIG_HOME as a parent folder). The testing overlay stands in for
// this package running from that install.
function bundledInstall(t: test.TestContext): string {
	const prefix = realpathSync(mkdtempSync(join(tmpdir(), "drakonc-pi-bundled-config-")));
	setBundledInstallForTesting({ root: prefix });
	t.after(() => {
		setBundledInstallForTesting(undefined);
		rmSync(prefix, { recursive: true, force: true });
	});
	return prefix;
}

test("a bundled install derives the config home inside its prefix and the agent home from Pi's", (t) => {
	isolatedHome(t);
	const prefix = bundledInstall(t);
	const env = { DRAKONC_SHELL_PREFIX: prefix, DRAKONC_PI_CONFIG_HOME: "/home/ana/.pi/drakonc-ai", PI_CODING_AGENT_DIR: "/agent" };
	assert.equal(drakoncPiConfigHome(env), join(prefix, "config", "drakonc-ai"));
	assert.equal(bundledDrakoncPiAgentHome(env), "/agent");
	// Another prefix, or none, is not this install: everything stays as before.
	for (const other of [{ DRAKONC_PI_CONFIG_HOME: "/custom" }, { DRAKONC_SHELL_PREFIX: join(prefix, "other"), DRAKONC_PI_CONFIG_HOME: "/custom" }]) {
		assert.equal(drakoncPiConfigHome(other), "/custom");
		assert.equal(bundledDrakoncPiAgentHome({ ...other, PI_CODING_AGENT_DIR: "/agent" }), undefined);
	}
	assert.equal(drakoncPiConfigHome({ DRAKONC_PI_CONFIG_HOME: "" }), join(homedir(), ".drakonc-shell", "drakonc-ai"));
});
