import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agentBody, installPackageAssets } from "../lib/agent-assets.ts";
import { discoverAgents } from "../lib/agents-config.ts";

// gentle-shell#3133 acceptance: the tool overlay is a load-time layer, so it
// adds/removes tools WITHOUT editing the package-owned agent file. The file
// stays pristine, `managed-assets.json` keeps owning it, and upgrades replace
// it freely while the overlay is re-applied on top.

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKER_KEY = "agents/gentle-ai-worker.md";
const WORKER_SHIPPED = readFileSync(join(PACKAGE_ROOT, "assets", WORKER_KEY), "utf8");
const STALE_FIXTURE = readFileSync(
	join(PACKAGE_ROOT, "tests", "fixtures", "agent-assets", "gentle-ai-worker.strict-tdd-era.md"),
	"utf8",
);

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function isolatedHome() {
	const agentHome = mkdtempSync(join(tmpdir(), "overlay-agent-home-"));
	const previous = process.env.GENTLE_PI_AGENT_HOME;
	const restore = () => {
		if (previous === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previous;
		rmSync(agentHome, { recursive: true, force: true });
	};
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	return { agentHome, restore };
}

function isolatedRoots(agentHome: string) {
	const configHome = mkdtempSync(join(tmpdir(), "overlay-config-home-"));
	const cwd = mkdtempSync(join(tmpdir(), "overlay-cwd-"));
	return {
		configHome,
		cwd,
		cleanup: () => {
			rmSync(configHome, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

function manifestOwns(agentHome: string): string | undefined {
	const manifest = JSON.parse(
		readFileSync(join(agentHome, "gentle-ai", "managed-assets.json"), "utf8"),
	) as { assets: Record<string, string> };
	return manifest.assets[WORKER_KEY];
}

function workerTools(agentHome: string, configHome: string, cwd: string): string[] {
	const agent = discoverAgents({ cwd, home: cwd, agentHome, configHome }).agents.find(
		(candidate) => candidate.name === "gentle-ai-worker",
	);
	assert.ok(agent, "worker must be discovered");
	return agent.tools;
}

test("overlay adds a tool at load without editing the package-owned file, and removing it restores the shipped tools (S3.1, S3.3)", () => {
	const { agentHome, restore } = isolatedHome();
	const { configHome, cwd, cleanup } = isolatedRoots(agentHome);
	try {
		installPackageAssets(agentHome, false, ["delegation"]);
		writeFileSync(
			join(configHome, "tools.json"),
			JSON.stringify({ "gentle-ai-worker": { add: ["bash_background"] } }),
		);

		// The overlay is applied at load, but the shipped file never declares it.
		assert.ok(workerTools(agentHome, configHome, cwd).includes("bash_background"));
		assert.doesNotMatch(WORKER_SHIPPED, /bash_background/);
		assert.equal(readFileSync(join(agentHome, WORKER_KEY), "utf8"), WORKER_SHIPPED, "the file itself is untouched");
		assert.ok(manifestOwns(agentHome), "manifest still owns the file");

		// A forced refresh must not treat the overlay as a local edit.
		const result = installPackageAssets(agentHome, true, ["delegation"]);
		assert.equal(result.skipped, 0, "no skip: the overlay never edited the file");
		assert.equal(manifestOwns(agentHome), sha256(WORKER_SHIPPED), "ownership kept through a forced refresh");
		assert.ok(workerTools(agentHome, configHome, cwd).includes("bash_background"), "overlay survives the refresh");

		// S3.3: removing the overlay entry drops the tool and the file equals shipped.
		rmSync(join(configHome, "tools.json"));
		assert.ok(!workerTools(agentHome, configHome, cwd).includes("bash_background"));
		assert.equal(readFileSync(join(agentHome, WORKER_KEY), "utf8"), WORKER_SHIPPED);
	} finally {
		cleanup();
		restore();
	}
});

test("an upgrade replaces an outdated body while the external overlay survives (S3.2)", () => {
	const { agentHome, restore } = isolatedHome();
	const { configHome, cwd, cleanup } = isolatedRoots(agentHome);
	try {
		installPackageAssets(agentHome, false, ["delegation"]);
		writeFileSync(
			join(configHome, "tools.json"),
			JSON.stringify({ "gentle-ai-worker": { add: ["bash_background"] } }),
		);

		// Simulate an installed copy that predates the current shipped body.
		const workerPath = join(agentHome, WORKER_KEY);
		writeFileSync(workerPath, STALE_FIXTURE);
		const manifestPath = join(agentHome, "gentle-ai", "managed-assets.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { assets: Record<string, string> };
		delete manifest.assets[WORKER_KEY];
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

		// The upgrade replaces the outdated body with the packaged one.
		installPackageAssets(agentHome, true, ["delegation"]);
		assert.equal(agentBody(readFileSync(workerPath, "utf8")), agentBody(WORKER_SHIPPED), "body updated to shipped");
		assert.doesNotMatch(readFileSync(workerPath, "utf8"), /effective TDD mode/, "stale body is gone");

		// The overlay is external, so the tool is still present after the upgrade.
		assert.ok(workerTools(agentHome, configHome, cwd).includes("bash_background"), "overlay survives an upgrade that changed the body");
	} finally {
		cleanup();
		restore();
	}
});

test("project overlay outranks the global overlay, and both outrank an extension drop-in (S3.4)", () => {
	const { agentHome, restore } = isolatedHome();
	const { configHome, cwd, cleanup } = isolatedRoots(agentHome);
	try {
		installPackageAssets(agentHome, false, ["delegation"]);

		// Extension adds `ext_tool`, global removes it and adds `glob_tool`, project re-adds `ext_tool`.
		const dropInDir = join(configHome, "agent-overlays.d");
		mkdirSync(dropInDir, { recursive: true });
		writeFileSync(join(dropInDir, "aa-extension.json"), JSON.stringify({ "gentle-ai-worker": { add: ["ext_tool"] } }));
		writeFileSync(join(configHome, "tools.json"), JSON.stringify({ "gentle-ai-worker": { add: ["glob_tool"], remove: ["ext_tool"] } }));
		mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "gentle-ai", "tools.json"), JSON.stringify({ "gentle-ai-worker": { add: ["ext_tool"] } }));

		const tools = workerTools(agentHome, configHome, cwd);
		assert.ok(tools.includes("ext_tool"), "project re-add wins over the global remove");
		assert.ok(tools.includes("glob_tool"), "distinct tools from different sources all apply");
	} finally {
		cleanup();
		restore();
	}
});
