import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TestContext } from "node:test";
import test from "node:test";
import type { ReceiptBodyV1 } from "../lib/review-transaction.ts";

type Options = Record<string, unknown>;
type Capture = {
	kind: "execFileSync" | "execFile" | "spawnSync";
	command: string;
	args: readonly string[];
	options: Options;
};
type Trace = { label: string; captures: Capture[] };
type ExpectedCall = Pick<Capture, "kind" | "command" | "args">;

async function trace<T>(captures: Capture[], traces: Trace[], label: string, action: () => T | Promise<T>, expected: readonly ExpectedCall[]): Promise<T> {
	const start = captures.length;
	const result = await action();
	const route = captures.slice(start);
	assert.deepEqual(route.map(({ kind, command, args }) => ({ kind, command, args })), expected, `${label} must use its documented public route`);
	traces.push({ label, captures: route });
	return result;
}

function childProcess(): typeof import("node:child_process") {
	return createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
}

function fakeGitResult(command: string, args: readonly string[], cwd: string): string {
	if (command !== "git") return "";
	if (args.includes("--show-toplevel")) return cwd;
	if (args.includes("--git-common-dir")) return `${cwd}/.git`;
	if (args.includes("--show-object-format")) return "sha1";
	if (args.includes("--is-shallow-repository")) return "false";
	if (args.includes("--git-path")) return join(cwd, ".git", "gentle-ai", "reviews");
	if (args.includes("--max-parents=0")) return "a".repeat(40);
	if (args[0] === "cat-file" && args[1] === "-t") return "tree";
	if (args.includes("--verify")) {
		const object = args.find((value) => value.endsWith("^{object}"));
		return object === `${"b".repeat(40)}^{object}` ? "b".repeat(40) : "b".repeat(40);
	}
	if (args.includes("ls-files")) return "tests/windows-hidden-processes.test.ts\0";
	throw new Error(`windows-hidden fixture: unexpected execFileSync git argv ${args.join(" ")}`);
}

function approvedReceipt(
	transaction: typeof import("../lib/review-transaction.ts"),
	fixtures: typeof import("./review-test-fixtures.ts"),
	tree: string,
) {
	const current = transaction.createReviewState({
		lineageId: "windows-hidden-gate",
		mode: "ordinary",
		snapshot: fixtures.testSnapshot({
			baseTree: "1".repeat(40),
			completeTree: "2".repeat(40),
			initialTree: "3".repeat(40),
			route: "standard",
			lenses: ["review-risk"],
		}),
		evidenceHash: "b".repeat(64),
		budget: { review_batches: 1, review_actors: 1, refuter_batches: 1, fix_batches: 1, validator_runs: 1, final_verifications: 1, judgment_rounds: 0, judge_runs: 0 },
	});
	const body: ReceiptBodyV1 = {
		schema: "gentle-ai.review-receipt-body/v1",
		lineage_id: current.lineage_id,
		mode: current.mode,
		base_tree: current.base_tree,
		complete_snapshot_tree: current.complete_snapshot_tree,
		review_projection: current.review_projection,
		initial_review_tree: current.initial_review_tree,
		final_candidate_tree: tree,
		route: current.route,
		lenses: current.lenses,
		policy_hash: current.policy_hash,
		frozen_ledger_hash: "c".repeat(64),
		evidence_hash: current.evidence_hash,
		budget: current.budget,
		counters: current.counters,
		terminal_state: "approved",
	};
	return transaction.createReceiptEnvelope(body);
}

function fakeSpawnResult(command: string, args: readonly string[], cwd: string): { status: number; stdout: string } {
	if (command !== "git") return { status: 0, stdout: "" };
	if (args.join(" ") === "rev-parse --show-toplevel") return { status: 0, stdout: `${cwd}\n` };
	if (args.length === 3 && args[0] === "-C" && args[2] === "remote") return { status: 0, stdout: "origin\n" };
	if (args.includes("get-url")) return { status: 0, stdout: "https://example.invalid/repo.git\n" };
	if (args.includes("check-ref-format")) return { status: 0, stdout: "" };
	if (args.includes("ls-remote")) return { status: 0, stdout: `${"c".repeat(40)}\trefs/heads/main\n` };
	if (args[2] === "config") return { status: 0, stdout: "" };
	throw new Error(`windows-hidden fixture: unexpected spawnSync git argv ${args.join(" ")}`);
}

async function captureOwnedRoutes(t: TestContext): Promise<{ captures: Capture[]; traces: Trace[] }> {
	const cp = childProcess();
	const original = { execFileSync: cp.execFileSync, execFile: cp.execFile, spawnSync: cp.spawnSync };
	const captures: Capture[] = [];
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-windows-hidden-workspace-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	mkdirSync(join(cwd, ".git"), { recursive: true });
	const fakeSync = ((command: string, args: readonly string[], options: Options = {}) => {
		captures.push({ kind: "execFileSync", command, args, options });
		return fakeGitResult(command, args, String(options.cwd ?? cwd));
	}) as unknown as typeof cp.execFileSync;
	const fakeAsync = function(command: string, args: readonly string[], options: Options, callback: (error: null, stdout: string, stderr: string) => void) {
		captures.push({ kind: "execFile", command, args, options });
		if (process.platform === "win32" && command === "codegraph") {
			callback(Object.assign(new Error("fixture shim missing"), { code: "ENOENT" }) as never, "", "");
		} else {
			callback(null, "indexed", "");
		}
		return undefined;
	} as unknown as typeof cp.execFile;
	(fakeAsync as unknown as { [promisify.custom]?: unknown })[promisify.custom] = async (command: string, args: readonly string[], options: Options) => {
		captures.push({ kind: "execFile", command, args, options });
		if (process.platform === "win32" && command === "codegraph") throw Object.assign(new Error("fixture shim missing"), { code: "ENOENT" });
		return { stdout: "indexed", stderr: "" };
	};
	const fakeSpawn = ((command: string, args: readonly string[], options: Options = {}) => {
		const result = fakeSpawnResult(command, args, String(options.cwd ?? cwd));
		captures.push({ kind: "spawnSync", command, args, options });
		if (command === "gh") return { status: 0, stdout: '{"total_count":0,"returned":0,"checks":[]}' };
		return { ...result, stderr: "" };
	}) as unknown as typeof cp.spawnSync;
	try {
		cp.execFileSync = fakeSync;
		cp.execFile = fakeAsync;
		cp.spawnSync = fakeSpawn;
		syncBuiltinESMExports();
		let fallbackRoot: string | undefined;
		let fallbackCalls: ExpectedCall[] = [];
	if (process.platform === "win32") {
		fallbackRoot = mkdtempSync(join(tmpdir(), "gentle-pi-codegraph-contract-"));
		t.after(() => rmSync(fallbackRoot!, { recursive: true, force: true }));
		const packageRoot = join(fallbackRoot, "node_modules", "@colbymchenry", "codegraph");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(join(fallbackRoot, "codegraph.cmd"), "@ECHO off\n");
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ bin: { codegraph: "entry.js" } }));
		writeFileSync(join(packageRoot, "entry.js"), "// fixture entry\n");
		const previousPath = process.env.Path;
		const previousUpperPath = process.env.PATH;
		t.after(() => { if (previousPath === undefined) delete process.env.Path; else process.env.Path = previousPath; });
		t.after(() => { if (previousUpperPath === undefined) delete process.env.PATH; else process.env.PATH = previousUpperPath; });
		process.env.Path = fallbackRoot;
		process.env.PATH = fallbackRoot;
		fallbackCalls = [{ kind: "execFile", command: process.execPath, args: [join(fallbackRoot, "node_modules", "@colbymchenry", "codegraph", "entry.js"), "init", cwd] }];
	}
	// The fixed query prevents accidental cache misses from becoming a fake proof.
		const query = "?windows-hidden-contract";
		const codegraph = await import(`../extensions/codegraph-tools.ts${query}`);
		const repository = await import(`../lib/review-repository.ts${query}`);
		const snapshot = await import(`../lib/review-snapshot.ts${query}`);
		const transaction = await import(`../lib/review-transaction.ts${query}`);
		const fixtures = await import(`./review-test-fixtures.ts${query}`);
		const publication = await import(`../lib/review-publication-gate.ts${query}`);
		const gentleAi = await import(`../extensions/gentle-ai.ts${query}`);

		const traces: Trace[] = [];
		const graph = codegraph.createCodeGraphTool();
		assert.equal(typeof graph.execute, "function", "CodeGraph public handler must be registered");
		const graphResult = await trace(captures, traces, "CodeGraph init", () => graph.execute("capture", { operation: "init" }, undefined, undefined, { cwd } as never), [
			{ kind: "execFileSync", command: "git", args: ["rev-parse", "--show-toplevel"] },
			{ kind: "execFile", command: "codegraph", args: ["init", cwd] },
			...fallbackCalls,
		]);
		const graphText = String((graphResult as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? "");
		assert.match(graphText, /indexed/, "CodeGraph must return the fixture command result");

		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		gentleAi.createGentleAiExtension({ nativeReviewCli: { targetStatus: async () => ({}) } as never })({
			registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) { tools.set(definition.name, definition); },
			registerCommand() {}, on() {},
		} as never);
		const review = tools.get("gentle_review");
		assert.ok(review, "gentle_review public handler must be registered");
		await trace(captures, traces, "gentle_review inspect", () => review.execute("capture", { operation: "inspect", workspaceRoot: cwd }, undefined, undefined, { cwd, hasUI: false } as never), [
			{ kind: "execFileSync", command: "git", args: ["rev-parse", "--show-toplevel"] },
			{ kind: "execFileSync", command: "git", args: ["rev-parse", "--git-common-dir"] },
		]);

		const authority = await trace(captures, traces, "repository authority", () => repository.reviewStoreRootForRepositoryV1(cwd), [
			{ kind: "execFileSync", command: "git", args: ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"] },
			{ kind: "execFileSync", command: "git", args: ["-C", cwd, "rev-parse", "--show-object-format"] },
			{ kind: "execFileSync", command: "git", args: ["-C", cwd, "rev-parse", "--is-shallow-repository"] },
			{ kind: "execFileSync", command: "git", args: ["-C", cwd, "rev-list", "--max-parents=0", "--all"] },
		]);
		assert.equal(authority, join(cwd, ".git", "gentle-ai", "reviews"));
		const untracked = await trace(captures, traces, "snapshot untracked discovery", () => snapshot.discoverReviewUntrackedPaths(cwd), [
			{ kind: "execFileSync", command: "git", args: ["rev-parse", "--show-toplevel"] },
			{ kind: "execFileSync", command: "git", args: ["ls-files", "--others", "--exclude-standard", "-z"] },
		]);
		assert.deepEqual(untracked, ["tests/windows-hidden-processes.test.ts"]);
		const storeRoot = await trace(captures, traces, "transaction store root", () => transaction.reviewStoreRootForRepository(cwd), [
			{ kind: "execFileSync", command: "git", args: ["rev-parse", "--show-toplevel"] },
			{ kind: "execFileSync", command: "git", args: ["rev-parse", "--git-path", "gentle-ai/reviews"] },
		]);
		assert.equal(storeRoot, join(cwd, ".git", "gentle-ai", "reviews"));
		const gateTree = "b".repeat(40);
		const gate = await trace(captures, traces, "transaction intended-commit gate", () => transaction.evaluateGateTarget(
			approvedReceipt(transaction, fixtures, gateTree),
			{ kind: publication.GATE_TARGET_KIND.INTENDED_COMMIT, intended_commit_tree: gateTree }, cwd, gateTree,
		), [
			{ kind: "execFileSync", command: "git", args: ["rev-parse", "--show-toplevel"] },
			{ kind: "execFileSync", command: "git", args: ["rev-parse", "--verify", `${gateTree}^{object}`] },
			{ kind: "execFileSync", command: "git", args: ["cat-file", "-t", gateTree] },
			{ kind: "execFileSync", command: "git", args: ["rev-parse", "--verify", `${gateTree}^{object}`] },
			{ kind: "execFileSync", command: "git", args: ["cat-file", "-t", gateTree] },
		]);
		assert.equal(gate.status, publication.GATE_RESULT.ALLOW);
		const destination = await trace(captures, traces, "publication configured destination", () => publication.resolveConfiguredPushDestinationV1(cwd, "origin"), [
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "remote"] },
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "remote", "get-url", "--push", "--all", "origin"] },
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "config", "--get-all", "remote.origin.pushurl"] },
		]);
		assert.equal(destination.url, "https://example.invalid/repo.git");
		await trace(captures, traces, "publication remote ref", () => publication.resolvePushRemoteRefV1(cwd, "origin", "refs/heads/main", "remote ref"), [
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "remote"] },
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "remote", "get-url", "--push", "--all", "origin"] },
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "config", "--get-all", "remote.origin.pushurl"] },
			{ kind: "spawnSync", command: "git", args: ["ls-remote", "--refs", "https://example.invalid/repo.git", "refs/heads/main"] },
		]);
		await trace(captures, traces, "publication destination ref", () => publication.resolvePushDestinationRefV1(cwd, "origin", "main", "refs/heads/main", "destination"), [
			{ kind: "spawnSync", command: "git", args: ["check-ref-format", "refs/main"] },
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "remote"] },
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "remote", "get-url", "--push", "--all", "origin"] },
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "config", "--get-all", "remote.origin.pushurl"] },
			{ kind: "spawnSync", command: "git", args: ["ls-remote", "--refs", "https://example.invalid/repo.git"] },
		]);
		await trace(captures, traces, "publication advertised object", () => publication.pushRemoteAdvertisesObjectV1(cwd, "origin", destination.destination_id, "c".repeat(40)), [
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "remote"] },
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "remote", "get-url", "--push", "--all", "origin"] },
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "config", "--get-all", "remote.origin.pushurl"] },
			{ kind: "spawnSync", command: "git", args: ["ls-remote", "--refs", "https://example.invalid/repo.git"] },
		]);
		const remoteHead = await trace(captures, traces, "publication remote head", () => publication.recheckReleaseFastPathRemoteHeadV1({ repositoryCwd: cwd, remote: "origin", expectedRemoteHead: "c".repeat(40) }), [
			{ kind: "spawnSync", command: "git", args: ["rev-parse", "--show-toplevel"] },
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "remote"] },
			{ kind: "spawnSync", command: "git", args: ["-C", cwd, "remote", "get-url", "origin"] },
			{ kind: "spawnSync", command: "git", args: ["ls-remote", "--refs", "https://example.invalid/repo.git", "refs/heads/main"] },
		]);
		assert.deepEqual(remoteHead, { advanced: false, remote_head: "c".repeat(40) });
		const ci = await trace(captures, traces, "publication GH CI", () => publication.recheckReleaseFastPathCiStatusV1({ repositoryCwd: cwd, sha: "f".repeat(40), expectedStatus: "success" }), [
			{ kind: "spawnSync", command: "gh", args: ["api", "repos/{owner}/{repo}/commits/ffffffffffffffffffffffffffffffffffffffff/check-runs?per_page=100", "--jq", "{total_count, returned: (.check_runs | length), checks: [.check_runs[] | [.status, .conclusion]]}"] },
			{ kind: "spawnSync", command: "gh", args: ["api", "repos/{owner}/{repo}/commits/ffffffffffffffffffffffffffffffffffffffff/status", "--jq", ".state"] },
		]);
		assert.deepEqual(ci, { proven: false, status: null });
		return { captures, traces };
	} finally {
		cp.execFileSync = original.execFileSync;
		cp.execFile = original.execFile;
		cp.spawnSync = original.spawnSync;
		syncBuiltinESMExports();
		t.after(() => {
			cp.execFileSync = original.execFileSync;
			cp.execFile = original.execFile;
			cp.spawnSync = original.spawnSync;
			syncBuiltinESMExports();
		});
	}
}

test("owned public adapters pass windowsHide at every mapped Node child-process boundary", async (t) => {
	const { traces } = await captureOwnedRoutes(t);
	assert.deepEqual(traces.map(({ label }) => label), [
		"CodeGraph init",
		"gentle_review inspect",
		"repository authority",
		"snapshot untracked discovery",
		"transaction store root",
		"transaction intended-commit gate",
		"publication configured destination",
		"publication remote ref",
		"publication destination ref",
		"publication advertised object",
		"publication remote head",
		"publication GH CI",
	], "all twelve mapped public actions must complete before flag assertions");
	for (const trace of traces) {
		for (const capture of trace.captures) {
			assert.equal(capture.options.windowsHide, true, `${trace.label}: ${capture.kind} ${capture.command} must hide Windows consoles`);
		}
	}
});

test("external editor remains the explicit interactive exemption", async () => {
	const shell = await import("../extensions/gentle-shell.ts");
	let received: Options | undefined;
	const host = { stop() {}, start() {}, requestRender() {} };
	assert.equal(shell.openInExternalEditor(host, "editor.txt", { EDITOR: "fixture-editor" }, ((_command: string, _args: readonly string[], options: Options) => {
		received = options;
		return { status: 0 };
	}) as never, process.cwd()), true);
	assert.equal(received?.shell, process.platform === "win32");
	assert.equal(received?.stdio, "inherit");
	assert.equal(received?.windowsHide, undefined, "the interactive editor intentionally remains unhidden");
});
