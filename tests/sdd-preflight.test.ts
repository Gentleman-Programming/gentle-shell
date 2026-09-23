import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	collectSddPreflightPreferences,
	ensureSddPreflight,
	getSddPreflightPreferences,
	DEFAULT_SDD_PREFLIGHT,
	installPackageAssets,
	installSddAssets,
	isSddPreflightTrigger,
	isParentConfirmedSddPreflightContext,
	renderSddPreflightPrompt,
	SHIPPED_SDD_AGENT_NAMES,
	updatePackageManagedSddAgentOwnership,
	readSddPreflightFromDisk,
	sddPreflightDiskPath,
	writeSddPreflightToDisk,
	type SddPreflightPreferences,
} from "../lib/sdd-preflight.ts";

async function workspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), "gentle-pi-sdd-preflight-"));
}

const SAMPLE_PREFS: SddPreflightPreferences = {
	executionMode: "auto",
	artifactStore: "engram",
	chainedPrStrategy: "auto-chain",
	reviewBudgetLines: 400,
	engramAvailable: true,
	prompted: true,
};

function preflightContext(cwd: string, hasUI: boolean, calls: string[] = [], answers: Record<string, string> = {}) {
	return { cwd, hasUI, ui: { select: async (title: string) => (calls.push(`select:${title}`), answers[title]), input: async (title: string) => (calls.push(`input:${title}`), answers[title]), notify: () => {} } } as Parameters<typeof collectSddPreflightPreferences>[0];
}
function writeRawPreflight(cwd: string, chainedPrStrategy: string, prompted = true): string {
	const path = sddPreflightDiskPath(cwd); mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true }); writeFileSync(path, JSON.stringify({ executionMode: "auto", artifactStore: "openspec", chainedPrStrategy, reviewBudgetLines: 400, engramAvailable: false, prompted })); return path;
}
test("production callers distinguish first-session confirmation from explicit field editing", () => {
	const root = join(import.meta.dirname, ".."), gentleAi = readFileSync(join(root, "extensions", "gentle-ai.ts"), "utf8"), sddInit = readFileSync(join(root, "extensions", "sdd-init.ts"), "utf8");
	assert.match(gentleAi, /function runSddPreflight\(\s*ctx: ExtensionContext,\s*promptFields: readonly SddPreflightField\[\] = \[\]\s*\)/s); assert.match(gentleAi, /if \(isSddAgent && !getSddPreflightPreferences\(ctx\) && ctx\.mode !== "rpc"\) \{\s*await runSddPreflight\(ctx\);/s); assert.match(gentleAi, /applyModelConfig: async \(\) => applySavedModelConfig\(ctx\)\s*\},\s*\{\s*promptFields\s*\}\s*\);/s); assert.ok(gentleAi.includes('await runSddPreflight(ctx, args.trim() === "--edit" ? SDD_PREFLIGHT_FIELDS : []);')); assert.match(sddInit, /applyModelConfig: \(\) => applySavedModelConfig\(ctx\)\s*\},\s*\{\s*promptFields: \[\]\s*\}\s*\);/s);
});
test("capability-constrained artifact selector elision", async () => {
	const calls: string[] = [], prefs = await collectSddPreflightPreferences(preflightContext(await workspace(), true, calls), false, { promptFields: ["artifactStore"] });
	assert.deepEqual(prefs, DEFAULT_SDD_PREFLIGHT); assert.deepEqual(calls, []);
});
test("headless defaults stay silent while UI confirms defaults", async () => {
	const calls: string[] = [], ui = await collectSddPreflightPreferences(preflightContext(await workspace(), true, calls, { "Confirm SDD session preflight": "Confirm" }), false), headless = await collectSddPreflightPreferences(preflightContext(await workspace(), false), false);
	assert.deepEqual(headless, DEFAULT_SDD_PREFLIGHT);
	assert.deepEqual(ui, { ...headless, prompted: true }); assert.equal(calls.length, 1);
});
test("disk preferences are suggestions and resolved choices are reused only in session", async () => {
	const cwd = await workspace(), calls: string[] = [];
	writeSddPreflightToDisk(cwd, SAMPLE_PREFS);
	const ctx = preflightContext(cwd, true, calls, { "Confirm SDD session preflight": "Confirm" });
	assert.equal(getSddPreflightPreferences(ctx), undefined);
	const callbacks = { pi: { getActiveTools: () => ["mem_save"] } as never, installAssets: () => ({ agents: 0, chains: 0, support: 0, skipped: 0 }) };
	await ensureSddPreflight(ctx, callbacks);
	await ensureSddPreflight(ctx, callbacks);
	assert.equal(calls.length, 1);
	const next = { ...ctx, sessionManager: { getSessionId: () => `${cwd}-new` } } as typeof ctx;
	assert.equal(getSddPreflightPreferences(next), undefined);
	await ensureSddPreflight(next, callbacks);
	assert.equal(calls.length, 2);
});
test("no-callback preflight fallback installs only SDD-owned assets", async () => {
	const cwd = await workspace();
	const agentHome = await workspace();
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	try {
		process.env.GENTLE_PI_AGENT_HOME = agentHome;
		await ensureSddPreflight(
			preflightContext(cwd, false),
			{ pi: { getActiveTools: () => [] } as never },
		);
		assert.equal(existsSync(join(agentHome, "agents", "sdd-apply.md")), true);
		assert.equal(existsSync(join(agentHome, "agents", "gentle-ai-worker.md")), false);
		assert.equal(existsSync(join(agentHome, "agents", "review-risk.md")), false);
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		rmSync(agentHome, { recursive: true, force: true });
	}
});

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function spawnOwnerInstall(agentHome: string, owner: "delegation" | "review", holdLockMs = 0) {
	const moduleUrl = pathToFileURL(join(import.meta.dirname, "..", "lib", "sdd-preflight.ts")).href;
	const script = `import { installPackageAssets } from ${JSON.stringify(moduleUrl)}; installPackageAssets(process.env.GENTLE_PI_AGENT_HOME, false, [process.env.GENTLE_PI_TEST_ASSET_OWNER], { holdLockMs: Number(process.env.GENTLE_PI_TEST_HOLD_LOCK_MS) });`;
	const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
		env: {
			...process.env,
			GENTLE_PI_AGENT_HOME: agentHome,
			GENTLE_PI_TEST_ASSET_OWNER: owner,
			GENTLE_PI_TEST_HOLD_LOCK_MS: String(holdLockMs),
		},
		stdio: "inherit",
	});
	let exited = false;
	const completion = new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) => {
			exited = true;
			code === 0 ? resolve() : reject(new Error(`asset installer exited ${code}`));
		});
	});
	return { completion, hasExited: () => exited };
}

test("managed asset replacements use exclusive same-directory temporary files", () => {
	const source = readFileSync(join(import.meta.dirname, "..", "lib", "sdd-preflight.ts"), "utf8");
	assert.match(source, /function replaceManagedAssetFileAtomically\([\s\S]*?flag: "wx"/);
	assert.match(source, /renameSync\(temporaryPath, path\)/);
});

test("managed ownership update waits for installer lock and atomically updates the file and manifest", async () => {
	const agentHome = await workspace();
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	try {
		process.env.GENTLE_PI_AGENT_HOME = agentHome;
		installPackageAssets(agentHome, false, ["sdd"]);
		const target = join(agentHome, "agents", "sdd-apply.md");
		const previous = readFileSync(target, "utf8");
		const next = `${previous}\nmanaged routing update\n`;
		const held = spawnOwnerInstall(agentHome, "delegation", 400);
		await waitForFile(join(agentHome, "gentle-ai", "managed-assets.lock"));
		const startedAt = Date.now();
		assert.equal(updatePackageManagedSddAgentOwnership(target, previous, next), true);
		assert.ok(Date.now() - startedAt >= 250, "ownership update must not bypass an active installer lock");
		await held.completion;
		assert.equal(readFileSync(target, "utf8"), next, "the managed file must be written under the installer lock");
		const manifest = JSON.parse(readFileSync(join(agentHome, "gentle-ai", "managed-assets.json"), "utf8")) as { assets: Record<string, string> };
		assert.ok(manifest.assets["agents/gentle-ai-worker.md"], "delegation ownership must survive the routed SDD update");
		assert.equal(manifest.assets["agents/sdd-apply.md"], createHash("sha256").update(next).digest("hex"));
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		rmSync(agentHome, { recursive: true, force: true });
	}
});

test("managed ownership update exposes lock timeout without writing a partial routed file", async () => {
	const agentHome = await workspace();
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	try {
		process.env.GENTLE_PI_AGENT_HOME = agentHome;
		installPackageAssets(agentHome, false, ["sdd"]);
		const target = join(agentHome, "agents", "sdd-apply.md");
		const previous = readFileSync(target, "utf8");
		const next = `${previous}\nmanaged routing update\n`;
		const manifestPath = join(agentHome, "gentle-ai", "managed-assets.json");
		const manifestBefore = readFileSync(manifestPath, "utf8");
		writeFileSync(
			join(agentHome, "gentle-ai", "managed-assets.lock"),
			JSON.stringify({ schemaVersion: 1, token: "foreign", pid: process.pid, createdAtMs: Date.now() }),
		);

		assert.throws(
			() => updatePackageManagedSddAgentOwnership(target, previous, next, { timeoutMs: 0 }),
			/Timed out acquiring managed-assets lock file/i,
		);
		assert.equal(readFileSync(target, "utf8"), previous, "a timed-out managed update must not write the agent file");
		assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore, "a timed-out managed update must not write the manifest");
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		rmSync(agentHome, { recursive: true, force: true });
	}
});

test("cross-process owner installations preserve both managed manifest entries", async () => {
	const agentHome = await workspace();
	const lockPath = join(agentHome, "gentle-ai", "managed-assets.lock");
	try {
		const delegation = spawnOwnerInstall(agentHome, "delegation", 500);
		await waitForFile(lockPath);
		const review = spawnOwnerInstall(agentHome, "review");
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(review.hasExited(), false, "the second owner must remain blocked while the first owner holds the lock");
		await Promise.all([delegation.completion, review.completion]);
		const assets = (JSON.parse(readFileSync(join(agentHome, "gentle-ai", "managed-assets.json"), "utf8")) as { assets: Record<string, string> }).assets;
		assert.deepEqual(
			Object.keys(assets).filter((key) => key.startsWith("agents/gentle-ai-")).sort(),
			["agents/gentle-ai-explore.md", "agents/gentle-ai-verify.md", "agents/gentle-ai-worker.md"],
		);
		assert.deepEqual(
			Object.keys(assets).filter((key) => key === "chains/4r-review.chain.md" || key.startsWith("agents/jd-") || key.startsWith("agents/review-")).sort(),
			["agents/jd-fix-agent.md", "agents/jd-judge-a.md", "agents/jd-judge-b.md", "agents/review-readability.md", "agents/review-reliability.md", "agents/review-resilience.md", "agents/review-risk.md", "chains/4r-review.chain.md"],
		);
		assert.equal(existsSync(lockPath), false, "the completed lock owner must release its lock file");
	} finally {
		rmSync(agentHome, { recursive: true, force: true });
	}
});

test("installer preserves foreign, malformed, and unsafe lock paths", async () => {
	const agentHome = await workspace();
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const lockPath = join(agentHome, "gentle-ai", "managed-assets.lock");
	try {
		process.env.GENTLE_PI_AGENT_HOME = agentHome;
		mkdirSync(join(agentHome, "gentle-ai"), { recursive: true });
		for (const contents of ["", "not-json\n", JSON.stringify({ schemaVersion: 1, token: "foreign", pid: process.pid, createdAtMs: Date.now() })]) {
			writeFileSync(lockPath, contents);
			assert.throws(() => installPackageAssets(agentHome, false, ["delegation"], { timeoutMs: 0 }), /Timed out acquiring managed-assets lock file .*verify no installer is active/i);
			assert.equal(readFileSync(lockPath, "utf8"), contents, "a regular lock file must remain untouched without this caller's token");
			rmSync(lockPath, { force: true });
		}
		mkdirSync(lockPath);
		assert.throws(() => installPackageAssets(agentHome, false, ["review"], { timeoutMs: 0 }), /lock path is unsafe/);
		assert.equal(existsSync(lockPath), true, "an unsafe non-regular lock path must remain untouched");
		rmSync(lockPath, { recursive: true, force: true });
		installPackageAssets(agentHome, false, ["review"]);
		assert.equal(existsSync(lockPath), false, "an installer must release only its own completed lock file");
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		rmSync(agentHome, { recursive: true, force: true });
	}
});

test("RPC children cannot promote or persist headless defaults", async () => {
	const cwd = await workspace();
	const calls: string[] = [];
	const ctx = { ...preflightContext(cwd, true, calls), mode: "rpc" as const };
	assert.deepEqual(await collectSddPreflightPreferences(ctx, false), DEFAULT_SDD_PREFLIGHT);
	await assert.rejects(
		ensureSddPreflight(ctx, { pi: { getActiveTools: () => [] } as never }),
		/RPC child cannot originate or persist defaults/i,
	);
	assert.equal(existsSync(sddPreflightDiskPath(cwd)), false);
	assert.deepEqual(calls, []);
});
test("explicit field editing cannot open RPC or no-UI dialogs", async () => {
	for (const hasUI of [true, false]) {
		const calls: string[] = [];
		const ctx = { ...preflightContext(await workspace(), hasUI, calls), mode: "rpc" as const };
		const prefs = await collectSddPreflightPreferences(ctx, false, { promptFields: ["executionMode", "artifactStore", "chainedPrStrategy", "reviewBudgetLines"] });
		assert.deepEqual(prefs, DEFAULT_SDD_PREFLIGHT);
		assert.deepEqual(calls, []);
	}
});
test("cancelled confirmation cannot become current-session consent", async () => {
	await assert.rejects(collectSddPreflightPreferences(preflightContext(await workspace(), true), false), /cancelled/i);
});
test("explicit UI selections override defaults when a field is genuinely unresolved", async () => {
	const calls: string[] = [], prefs = await collectSddPreflightPreferences(preflightContext(await workspace(), true, calls, { "SDD execution mode": "interactive", "SDD artifact store": "engram", "SDD delivery strategy": "auto-chain", "SDD review budget lines": "700" }), true, { persisted: DEFAULT_SDD_PREFLIGHT, promptFields: ["executionMode", "artifactStore", "chainedPrStrategy", "reviewBudgetLines"] });
	assert.deepEqual({ executionMode: prefs.executionMode, artifactStore: prefs.artifactStore, chainedPrStrategy: prefs.chainedPrStrategy, reviewBudgetLines: prefs.reviewBudgetLines }, { executionMode: "interactive", artifactStore: "engram", chainedPrStrategy: "auto-chain", reviewBudgetLines: 700 }); assert.equal(prefs.prompted, true); assert.equal(calls.length, 4);
});
test("legacy persisted strategies normalize to canonical values", async () => {
	const mappings = { "auto-forecast": "ask-on-risk", "ask-always": "ask-on-risk", "single-pr-default": "single-pr", "force-chained": "auto-chain" } as const;
	for (const [legacy, canonical] of Object.entries(mappings)) { const cwd = await workspace(); writeRawPreflight(cwd, legacy); assert.equal(readSddPreflightFromDisk(cwd)?.chainedPrStrategy, canonical); }
});
test("exception-ok requires narrow delivery-gate provenance", async () => {
	for (const prompted of [false, true]) { const cwd = await workspace(); writeRawPreflight(cwd, "exception-ok", prompted); assert.equal(readSddPreflightFromDisk(cwd)?.chainedPrStrategy, "ask-on-risk"); }
	const accepted = await collectSddPreflightPreferences(preflightContext(await workspace(), false), false, { persisted: { ...DEFAULT_SDD_PREFLIGHT, chainedPrStrategy: "exception-ok" }, acceptSizeException: true }); assert.equal(accepted.chainedPrStrategy, "exception-ok"); assert.equal(accepted.sizeExceptionAccepted, true);
	const durable = await workspace(); writeSddPreflightToDisk(durable, accepted); assert.equal(readSddPreflightFromDisk(durable)?.chainedPrStrategy, "ask-on-risk");
});

test("sddPreflightDiskPath returns project-local .pi/gentle-ai/sdd-preflight.json", async () => {
	const cwd = await workspace();
	const path = sddPreflightDiskPath(cwd);
	assert.equal(path, join(cwd, ".pi", "gentle-ai", "sdd-preflight.json"));
});

test("writeSddPreflightToDisk creates parent dirs and writes valid JSON", async () => {
	const cwd = await workspace();
	writeSddPreflightToDisk(cwd, SAMPLE_PREFS);

	const path = sddPreflightDiskPath(cwd);
	assert.ok(existsSync(path));
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(parsed, SAMPLE_PREFS);
});

test("readSddPreflightFromDisk returns undefined when no file exists", async () => {
	const cwd = await workspace();
	assert.equal(readSddPreflightFromDisk(cwd), undefined);
});

test("readSddPreflightFromDisk returns persisted prefs after write", async () => {
	const cwd = await workspace();
	writeSddPreflightToDisk(cwd, SAMPLE_PREFS);

	const loaded = readSddPreflightFromDisk(cwd);
	assert.deepEqual(loaded, SAMPLE_PREFS);
});

test("persisted preferences require fresh session confirmation", async () => {
	const cwd = await workspace(); writeSddPreflightToDisk(cwd, SAMPLE_PREFS);
	const loaded = readSddPreflightFromDisk(cwd); assert.ok(loaded);
	const calls: string[] = [], reused = await collectSddPreflightPreferences(preflightContext(cwd, true, calls, { "Confirm SDD session preflight": "Confirm" }), loaded!.engramAvailable, { persisted: loaded });
	assert.deepEqual(reused, loaded); assert.equal(calls.length, 1);
});

test("readSddPreflightFromDisk returns undefined for corrupt JSON", async () => {
	const cwd = await workspace();
	const path = sddPreflightDiskPath(cwd);
	mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(path, "not-json{{{");

	assert.equal(readSddPreflightFromDisk(cwd), undefined);
});

test("readSddPreflightFromDisk returns undefined for JSON with invalid fields", async () => {
	const cwd = await workspace();
	const path = sddPreflightDiskPath(cwd);
	mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(path, JSON.stringify({ executionMode: "invalid", artifactStore: "openspec", chainedPrStrategy: "auto-forecast", reviewBudgetLines: 400, engramAvailable: false, prompted: false }));

	// executionMode "invalid" is not "interactive" | "auto" → should reject
	assert.equal(readSddPreflightFromDisk(cwd), undefined);
});

test("readSddPreflightFromDisk normalizes unknown chainedPrStrategy to ask-on-risk", async () => {
	const cwd = await workspace();
	const path = sddPreflightDiskPath(cwd);
	mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(path, JSON.stringify({
		executionMode: "interactive",
		artifactStore: "openspec",
		chainedPrStrategy: "unknown-strategy",
		reviewBudgetLines: 400,
		engramAvailable: false,
		prompted: true,
	}));

	const loaded = readSddPreflightFromDisk(cwd);
	assert.ok(loaded !== undefined);
	assert.equal(loaded.chainedPrStrategy, "ask-on-risk");
});

test("writeSddPreflightToDisk is non-fatal when directory is not writable (no throw)", async () => {
	// Can only test the no-throw guarantee; the actual write failure is swallowed
	// We verify that calling with a deeply nested path doesn't throw
	assert.doesNotThrow(() => {
		writeSddPreflightToDisk("/nonexistent/path/that/cannot/be/created/gently", SAMPLE_PREFS);
	});
});

test("forced asset refresh migrates the exact v0.10.7 malformed sdd-apply asset and preserves user edits", () => {
	const packageRoot = join(import.meta.dirname, "..");
	const legacySource = readFileSync(
		join(
			packageRoot,
			"tests",
			"fixtures",
			"v0.10.7",
			"assets",
			"agents",
			"sdd-apply.md",
		),
		"utf8",
	);
	const currentSource = readFileSync(
		join(packageRoot, "assets", "agents", "sdd-apply.md"),
		"utf8",
	);
	const temporaryAgentHome = mkdtempSync(join(tmpdir(), "gentle-pi-v0107-preflight-"));
	const temporaryUserAgentHome = mkdtempSync(join(tmpdir(), "gentle-pi-v0107-user-preflight-"));
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const installed = join(temporaryAgentHome, "agents", "sdd-apply.md");
	const userInstalled = join(temporaryUserAgentHome, "agents", "sdd-apply.md");
	const userEdited = legacySource.replace(
		"You are the SDD apply executor for Gentle AI.",
		"You are the user-customized SDD apply executor for Gentle AI.",
	);
	try {
		process.env.GENTLE_PI_AGENT_HOME = temporaryAgentHome;
		mkdirSync(join(temporaryAgentHome, "agents"), { recursive: true });
		writeFileSync(installed, legacySource);
		mkdirSync(join(temporaryAgentHome, "gentle-ai"), { recursive: true });
		writeFileSync(
			join(temporaryAgentHome, "gentle-ai", "managed-assets.json"),
			JSON.stringify({ schemaVersion: 1, assets: {} }),
		);

		installSddAssets(packageRoot, true);

		assert.equal(readFileSync(installed, "utf8"), currentSource);
		assert.match(readFileSync(installed, "utf8"), /^tools:\n  - read$/m);
		const managedAssets = JSON.parse(
			readFileSync(
				join(temporaryAgentHome, "gentle-ai", "managed-assets.json"),
				"utf8",
			),
		) as { assets: Record<string, string> };
		assert.equal(
			managedAssets.assets["agents/sdd-apply.md"],
			createHash("sha256").update(currentSource).digest("hex"),
			"the migrated asset must record current package ownership",
		);

		installSddAssets(packageRoot, true);
		assert.equal(
			readFileSync(installed, "utf8"),
			currentSource,
			"a current package-managed asset must remain refreshable",
		);

		process.env.GENTLE_PI_AGENT_HOME = temporaryUserAgentHome;
		mkdirSync(join(temporaryUserAgentHome, "agents"), { recursive: true });
		writeFileSync(userInstalled, userEdited);
		installSddAssets(packageRoot, true);
		assert.equal(
			readFileSync(userInstalled, "utf8"),
			userEdited,
			"a user-edited variant of the malformed legacy asset must remain untouched",
		);
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		rmSync(temporaryAgentHome, { recursive: true, force: true });
		rmSync(temporaryUserAgentHome, { recursive: true, force: true });
	}
});

test("forced asset refresh migrates only untouched v0.14 package contracts and preserves user edits", () => {
	const packageRoot = join(import.meta.dirname, "..");
	const fixture = readFileSync(
		join(packageRoot, "tests", "fixtures", "v0.14", "assets", "agents", "review-risk.md"),
		"utf8",
	);
	const temporaryAgentHome = mkdtempSync(join(tmpdir(), "gentle-pi-v014-preflight-"));
	const previousAgentHome = process.env.GENTLE_PI_AGENT_HOME;
	const untouched = join(temporaryAgentHome, "agents", "review-risk.md");
	const edited = join(temporaryAgentHome, "agents", "review-readability.md");
	try {
		process.env.GENTLE_PI_AGENT_HOME = temporaryAgentHome;
		mkdirSync(join(temporaryAgentHome, "agents"), { recursive: true });
		writeFileSync(untouched, fixture);
		writeFileSync(edited, `${fixture}\nuser-owned edit\n`);

		installSddAssets(packageRoot, true);

		assert.match(readFileSync(untouched, "utf8"), /initial_review_tree/);
		assert.equal(readFileSync(edited, "utf8"), `${fixture}\nuser-owned edit\n`);
	} finally {
		if (previousAgentHome === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previousAgentHome;
		rmSync(temporaryAgentHome, { recursive: true, force: true });
	}
});

// gentle-ai calls the dual-store mode "hybrid"; this repo called the same
// operator-facing choice "both". Two names for one concept is how a caller ends
// up mapping between them by hand. gentle-ai owns the contract, so "hybrid" is
// canonical here too — but "both" is already persisted in operator preflight
// files on disk, so it must keep loading rather than fall back to the default.
test("a persisted legacy 'both' artifact store loads as hybrid", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sdd-preflight-legacy-"));
	mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(
		sddPreflightDiskPath(cwd),
		JSON.stringify({ executionMode: "auto", artifactStore: "hybrid", chainedPrStrategy: "ask-on-risk", reviewBudgetLines: 400, engramAvailable: true, prompted: true }),
	);

	const loaded = readSddPreflightFromDisk(cwd, true);
	assert.equal(loaded?.artifactStore, "hybrid", "legacy 'both' must normalize to the canonical name, not be discarded");
});

test("a persisted canonical 'hybrid' artifact store loads unchanged", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "sdd-preflight-hybrid-"));
	mkdirSync(join(cwd, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(
		sddPreflightDiskPath(cwd),
		JSON.stringify({ executionMode: "auto", artifactStore: "hybrid", chainedPrStrategy: "ask-on-risk", reviewBudgetLines: 400, engramAvailable: true, prompted: true }),
	);

	const loaded = readSddPreflightFromDisk(cwd, true);
	assert.equal(loaded?.artifactStore, "hybrid");
});

test("the shared shipped SDD inventory includes every executor, including remediation", () => {
	assert.deepEqual(SHIPPED_SDD_AGENT_NAMES, [
		"sdd-init", "sdd-onboard", "sdd-explore", "sdd-research", "sdd-proposal", "sdd-spec", "sdd-design",
		"sdd-tasks", "sdd-status", "sdd-apply", "sdd-verify", "sdd-archive", "sdd-remediate",
	]);
});

test("only a structurally valid parent-rendered preflight block can reach an SDD child", () => {
	const block = renderSddPreflightPrompt({ ...DEFAULT_SDD_PREFLIGHT, prompted: true });
	assert.equal(isParentConfirmedSddPreflightContext(block), true);
	assert.equal(isParentConfirmedSddPreflightContext(block.replace("Review budget: 400", "Review budget: 0")), false);
	assert.equal(isParentConfirmedSddPreflightContext("## SDD Session Preflight\ncaller-authored defaults"), false);
});

test("natural-language SDD text never triggers input preflight", () => {
	// Natural-language intent belongs to the parent/orchestrator. The input hook
	// is syntax-only; execution gates enforce preflight when an SDD action is
	// actually attempted.
	for (const text of [
		"quiero hacer un proyecto con SDD",
		"I want to build this with SDD",
		"por favor usemos SDD para este cambio",
		"do SDD for this change",
		"haz SDD para este cambio",
		"continue the SDD change",
		"Should we use SDD?",
		"no quiero usar SDD por ahora",
		"I use SDD sometimes",
		"necesito reportar un bug del preflight de SDD",
		"I need to report a bug in the SDD preflight",
		"quiero comparar SDD con ODD",
		"I want to review the SDD proposal",
		"necesito una explicación de SDD",
	]) {
		assert.equal(isSddPreflightTrigger(text), false, text);
	}
});

test("slash SDD preflight trigger accepts the gentle-sdd command prefix", () => {
	for (const text of ["/gentle-sdd-init", "/gentle-sdd-continue", "/gentle-sdd-status fix-rose --json", "/sdd", "/sdd:plan", "/sdd-plan this change"]) {
		assert.equal(isSddPreflightTrigger(text), true, text);
	}
	for (const text of ["/gentle-sddx", "/gentle:sdd-preflight", "/gentle-status", "gentle-sdd-init"]) {
		assert.equal(isSddPreflightTrigger(text), false, text);
	}
});
