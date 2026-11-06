import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import baseTest from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import {
	GENTLE_AI_DEV_BINARY_ENV,
	resolveGentleAiBinary,
	type GentleAiDevBinaryEnvironment,
} from "../lib/gentle-ai-binary.ts";
import { createNodeExecFileAdapter, NativeReviewCliV216 } from "../lib/native-review-cli.ts";
import { resolveSessionWorktree } from "../lib/session-worktree-registry.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import { decodeReviewLastEventClosureV1 } from "../lib/review-integration-v2.ts";
import { decodeReviewLastEventClosureV1 as decodeRuntimeReviewLastEventClosureV1 } from "../runtime/review-integration-v2.mjs";
import { requireNativeBinary } from "./support/native-binary-gate.ts";

const execFileAsync = promisify(execFile);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pinnedBinaryHome = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-pinned-runtime-home-")));
const pinnedBinaryEnvironment: GentleAiDevBinaryEnvironment = {
	env: { ...process.env },
	home: pinnedBinaryHome,
};
delete pinnedBinaryEnvironment.env[GENTLE_AI_DEV_BINARY_ENV];
delete pinnedBinaryEnvironment.env.GENTLE_PI_CONFIG_HOME;
baseTest.after(() => rmSync(pinnedBinaryHome, { recursive: true, force: true }));
// The parity suite exercises the published official binary; it skips while a
// re-pinned release's archives and digest table are still pending, because the
// pinned package-local binary cannot be installed or integrity-verified yet.
// Dev-binary override state is intentionally excluded: these assertions verify
// the package pin, while explicit dev-binary behavior belongs to its own suite.
const resolvedBinary = (() => {
	try {
		return resolveGentleAiBinary(packageRoot, process.platform, undefined, pinnedBinaryEnvironment);
	} catch {
		return undefined;
	}
})();
const nativeBinaryGate = requireNativeBinary({ resolvedBinary, digestsPinned: true, env: process.env });
if (nativeBinaryGate.run === false) console.log(`native-review-parity-runtime: ${nativeBinaryGate.reason}`);
const test = nativeBinaryGate.run ? baseTest : baseTest.skip;
const binary = resolvedBinary ?? "";

interface CommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

interface RegisteredController {
	execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<{ details?: unknown }>;
}

// Every test in this file drives the real pinned binary through a full review
// lifecycle, and gentle-ai v2.4.0 made receipt-driven development opt-in: an
// install whose global mode was never set now resolves to off, and START is
// rejected before it reaches any of the behavior these tests exist to check.
//
// Until that release these tests had a silent dependency on whatever the
// operator happened to have configured. That is not a new hazard introduced by
// the pin — it was always there — but the flip is what made it visible: the
// suite was green on a machine with review enabled and red on a fresh CI
// runner, from identical bytes. A test whose result depends on unversioned
// machine state is not evidence either way.
//
// So each test owns a sandbox HOME and opts in the same way a user does,
// exactly as gentle-ai did for its own lifecycle fixtures in the commit that
// flipped the default. The extension-registered controller path inherits this
// process environment, so HOME and XDG state are restored afterwards. The
// global enable runs from a disposable repository: this package worktree may
// intentionally have clone-local mode off, which must never participate in the
// fixture's lifecycle.
async function reviewEnabledHome(t: baseTest.TestContext): Promise<string> {
	const home = await realpath(await mkdtemp(join(tmpdir(), "gentle-pi-review-home-")));
	const lifecycleCwd = await realpath(await mkdtemp(join(tmpdir(), "gentle-pi-review-lifecycle-")));
	const xdgConfigHome = join(home, ".config");
	const xdgDataHome = join(home, ".local", "share");
	const xdgCacheHome = join(home, ".cache");
	const previousHome = process.env.HOME;
	const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
	const previousXdgDataHome = process.env.XDG_DATA_HOME;
	const previousXdgCacheHome = process.env.XDG_CACHE_HOME;
	process.env.HOME = home;
	process.env.XDG_CONFIG_HOME = xdgConfigHome;
	process.env.XDG_DATA_HOME = xdgDataHome;
	process.env.XDG_CACHE_HOME = xdgCacheHome;
	const environment = {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: xdgConfigHome,
		XDG_DATA_HOME: xdgDataHome,
		XDG_CACHE_HOME: xdgCacheHome,
	};
	t.after(async () => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
		if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = previousXdgDataHome;
		if (previousXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = previousXdgCacheHome;
		await rm(home, { recursive: true, force: true });
		await rm(lifecycleCwd, { recursive: true, force: true });
	});
	await run("git", ["init", "--quiet"], lifecycleCwd, false, environment);
	const enabled = await run(binary, ["review", "mode", "enable", "--scope", "global", "--cwd", lifecycleCwd, "--json"], lifecycleCwd, false, environment);
	// Assert the opt-in landed rather than assuming it. A silently ineffective
	// enable would put these tests straight back to depending on ambient state,
	// which is the exact failure this helper exists to remove.
	assert.match(enabled.stdout, /"effective": "on"/, "the sandbox HOME must have receipt-driven development explicitly enabled");
	return home;
}

async function run(command: string, arguments_: readonly string[], cwd: string, allowFailure = false, environment?: NodeJS.ProcessEnv): Promise<CommandResult> {
	try {
		const result = await execFileAsync(command, [...arguments_], { cwd, encoding: "utf8", shell: false, env: environment });
		return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		const result = error as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };
		if (allowFailure && typeof result.code === "number") return { exitCode: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
		throw error;
	}
}

test("SDK explicit review delegates enabled-only non-Git preparation to the pinned native binary without START", async (t) => {
	const previous: Record<string, string | undefined> = {};
	for (const key of Object.keys(process.env).filter((key) => key.startsWith("GIT_"))) {
		previous[key] = process.env[key];
		delete process.env[key];
	}
	const home = await reviewEnabledHome(t);
	for (const [key, value] of Object.entries({
		GENTLE_PI_AGENT_HOME: join(home, "agent"), PI_CODING_AGENT_DIR: join(home, "agent"),
		GENTLE_PI_CONFIG_HOME: join(home, "pi-config"), PI_OFFLINE: "1",
		GENTLE_PI_REVIEW_RELAY_CONTRACT: "invalid-ambient-relay",
	})) {
		previous[key] = process.env[key];
		process.env[key] = value;
	}
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
	const version = await run(binary, ["version"], home);
	t.diagnostic(`native binary=${binary}; version=${version.stdout.trim()}`);
	const calls: string[][] = [];
	const agentDir = process.env.GENTLE_PI_AGENT_HOME!;
	await mkdir(agentDir, { recursive: true });
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "empty-auth.json"), modelsPath: null,
		modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false,
	});
	const startup = async (cwd: string, enabled = true) => {
		const before = calls.length;
		const wasVersioned = resolveSessionWorktree(cwd, cwd) !== undefined;
		// Production adapter overwrites the poisoned ambient relay declaration.
		// Fresh native clients also prevent a cached refusal from masking later
		// parent/broken-metadata scenarios without actually invoking STATUS.
		const adapter = createNodeExecFileAdapter();
		const native = new NativeReviewCliV216(async (request) => {
			calls.push([...request.arguments]);
			return adapter(request);
		}, binary);
		const resourceLoader = new DefaultResourceLoader({
			cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [createGentleAiExtension({ nativeReviewCli: native, candidateViews: null, processEnv: {} })],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd, agentDir, resourceLoader, modelRuntime, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
		});
		try {
			await session.bindExtensions({ mode: "print" });
			assert.equal(calls.slice(before).some(args => args[0] === "review" && args[1] === "status"), false, "passive non-Git startup cannot prepare");
			session.setActiveToolsByName(["gentle_review"]);
			const inspect = session.agent.state.tools.find(tool => tool.name === "gentle_review");
			assert.ok(inspect, "real SDK registers the facade");
			await inspect.execute("explicit-review", { operation: "inspect", workspaceRoot: cwd });
			assert.equal(session.messages.length, 0, "explicit review entry must not begin a model turn");
		} finally { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		const scenarioCalls = calls.slice(before);
		if (!wasVersioned) assert.ok(scenarioCalls.some((args) => args[0] === "review" && args[1] === "mode"), "every non-Git explicit review invokes native mode");
		const statuses = scenarioCalls.filter((args) => args[0] === "review" && args[1] === "status");
		assert.equal(statuses.length > 0, enabled, "every on scenario invokes native STATUS; off cannot");
		t.diagnostic(`startup cwd=${cwd}; STATUS calls=${statuses.length}`);
	};
	const plain = join(home, "enabled-project");
	await mkdir(plain);
	await writeFile(join(plain, "candidate.txt"), "candidate bytes\n");
	await startup(plain);
	assert.equal(existsSync(join(plain, ".git")), true, "explicit enabled review must reach native bootstrap");
	assert.equal(await readFile(join(plain, "candidate.txt"), "utf8"), "candidate bytes\n");
	assert.notEqual((await run("git", ["rev-parse", "--verify", "HEAD"], plain, true)).exitCode, 0, "HEAD remains unborn");
	assert.equal((await run("git", ["remote"], plain)).stdout, "");
	assert.equal(existsSync(join(plain, ".git", "gentle-ai", "reviews")), false, "entry does not create review lineage storage");
	const nested = join(plain, "nested");
	await mkdir(nested);
	await startup(nested);
	assert.equal(existsSync(join(nested, ".git")), false, "containing repository is reused");
	const broken = join(home, "broken-project");
	await mkdir(broken);
	await writeFile(join(broken, ".git"), "gitdir: missing-metadata\n");
	await startup(broken);
	assert.equal(await readFile(join(broken, ".git"), "utf8"), "gitdir: missing-metadata\n");
	const brokenChild = join(broken, "child");
	await mkdir(brokenChild);
	await startup(brokenChild);
	assert.equal(existsSync(join(brokenChild, ".git")), false);
	await run(binary, ["review", "mode", "disable", "--scope", "global", "--cwd", plain, "--json"], plain);
	const off = join(home, "off-project");
	await mkdir(off);
	await startup(off, false);
	assert.equal(existsSync(join(off, ".git")), false, "off explicit review leaves the target unversioned");
	assert.equal(calls.some((args) => args[0] === "review" && args[1] === "start"), false);
	t.diagnostic(`native SDK startup calls=${JSON.stringify(calls)}`);
});

test("generated runtime decoder consumes the captured terminal closure directly", async () => {
	const fixture = JSON.parse(await readFile(join(packageRoot, "tests", "fixtures", "devbinary", "last-event-capture-result-approved.captured.json"), "utf8"));
	const source = decodeReviewLastEventClosureV1(fixture);
	const runtime = decodeRuntimeReviewLastEventClosureV1(fixture);
	assert.deepEqual(runtime, source);
	assert.equal(runtime.operation, "review/capture-result");
	assert.equal(runtime.state, "approved");
});

test("registered gentle_review surfaces the package-pinned Pi transport refusal before native START for a safe internal symlink candidate", async (t) => {
	await reviewEnabledHome(t);
	const handshakeLessEnvironment = { ...process.env };
	delete handshakeLessEnvironment.GENTLE_PI_REVIEW_RELAY_CONTRACT;
	const workspace = await realpath(await mkdtemp(join(tmpdir(), "gentle-pi-v215-symlink-candidate-")));
	const repository = join(workspace, "repository");
	t.after(async () => {
		// Candidate views are intentionally read-only. Restore test-workspace write
		// permissions before cleanup when transport refusal stops before START.
		await run("chmod", ["-R", "u+w", workspace], workspace, true);
		await rm(workspace, { recursive: true, force: true });
	});

	await mkdir(join(repository, ".agents", "skills", "example"), { recursive: true });
	await mkdir(join(repository, ".agent", "skills"), { recursive: true });
	await writeFile(join(repository, "tracked.txt"), "base\n");
	await writeFile(join(repository, ".agents", "skills", "example", "SKILL.md"), "---\nname: example\n---\n");
	const link = join(repository, ".agent", "skills", "example");
	const linkTarget = "../../.agents/skills/example";
	await symlink(linkTarget, link);
	const lexicalTarget = resolve(dirname(link), linkTarget);
	const lexicalRelative = relative(repository, lexicalTarget);
	assert.ok(lexicalRelative !== "" && !lexicalRelative.startsWith("..") && !isAbsolute(lexicalRelative), "the internal symlink target must resolve lexically inside the repository");

	await run("git", ["init", "--initial-branch=main"], repository);
	await run("git", ["config", "user.email", "test@example.invalid"], repository);
	await run("git", ["config", "user.name", "Gentle Pi test"], repository);
	await run("git", ["add", "--", "tracked.txt", ".agents", ".agent"], repository);
	await run("git", ["commit", "-m", "base with internal skill symlink"], repository);
	await writeFile(join(repository, "tracked.txt"), "candidate\n");

	const candidateViews = new CandidateViewRegistry();
	let nativeStartReached = false;
	// Materialization and lexical symlink escape rejection have dedicated
	// candidate-view coverage. This safe shape proves negotiated Pi transport
	// refusal happens before native START, regardless of candidate materialization.
	const native = new NativeReviewCliV216(async (request) => {
		if (request.arguments[0] === "review" && request.arguments[1] === "start") nativeStartReached = true;
		const command = await run(binary, request.arguments, request.cwd, true, handshakeLessEnvironment);
		return { ...command, signal: null, timedOut: false, outputLimitExceeded: false };
	});
	const tools = new Map<string, RegisteredController>();
	// The extension declares the relay handshake in the session environment on
	// load (gentle-pi#550). Keep registration isolated in a throwaway environment
	// and spawn the pinned binary with an explicit handshake-less environment so
	// ambient valid relay configuration cannot change this fixture's behavior.
	createGentleAiExtension({ nativeReviewCli: native, candidateViews, processEnv: {} } as Parameters<typeof createGentleAiExtension>[0])({
		on() {},
		registerTool(definition: RegisteredController & { name: string }) { tools.set(definition.name, definition); },
		registerCommand() {},
	} as unknown as ExtensionAPI);
	const controller = tools.get("gentle_review");
	assert.ok(controller);

	let returned: { details?: unknown } | undefined;
	let thrown: unknown;
	try {
		returned = await controller.execute("issue-146-start", { operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, undefined, undefined, { cwd: repository, hasUI: false, ui: { notify: () => {} } } as unknown as ExtensionContext);
	} catch (caught) {
		thrown = caught;
	}
	const error = thrown instanceof Error ? { name: thrown.name, message: thrown.message } : thrown === undefined ? undefined : String(thrown);
	t.diagnostic(JSON.stringify({ returned: returned?.details, error, nativeStartReached }));
	assert.equal(thrown, undefined, "the Pi transport refusal must be returned, not thrown");
	const result = returned?.details as Record<string, unknown> | undefined;
	const relayTransport = result?.relay_transport as Record<string, unknown> | undefined;
	assert.equal(result?.status, "blocked");
	assert.equal(result?.outcome, "pi-host-relay-transport-unavailable");
	assert.equal(relayTransport?.code, "immutable_review_transport_unsupported");
	assert.equal(result?.mutation_performed, false);
	assert.equal(result?.mutation_outcome, "none");
	if (result !== undefined && "lineage_created" in result) assert.equal(result.lineage_created, false);
	assert.equal(nativeStartReached, false, "negotiated Pi transport refusal must preclude native START and any agent-less fallback");
});
