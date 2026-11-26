import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { NativeReviewCliV216, type ExecFileAdapter } from "../lib/native-review-cli.ts";
import { statusV9 } from "./support/status-v9.ts";

const contract = "gentle-ai.review-integration/v2";
const selectionSchema = "gentle-ai.review-intended-untracked-selection/v1";
const selectedPath = "src/add.js";
const inventoryChanged = "untracked inventory changed; rerun `gentle-ai review status --cwd <repo> --contract gentle-ai.review-integration/v2 --agent <runtime> --next-transition` before selecting paths";

function fixture(name: string) {
	return JSON.parse(readFileSync(new URL(`./fixtures/devbinary/${name}.captured.json`, import.meta.url), "utf8"));
}

interface ToolDetails {
	selectionBinding?: string;
	collectBindings?: { collectBinding: string }[];
	result?: { lineage_id?: string; eligible_untracked_inventory?: string };
	native_failure?: { cause: string };
	status?: string;
	outcome?: string;
	reason?: string;
	mutation_performed?: boolean;
	mutation_outcome?: string;
}
interface Tool {
	name: string;
	execute(id: string, parameters: Record<string, unknown>, signal: undefined, onUpdate: undefined, context: unknown): Promise<{ details: ToolDetails }>;
}

for (const committedOnly of [true, false]) {
	test(committedOnly ? "committed review survives a new unrelated untracked path" : "workspace review remains queryable after a selected path is committed", async (t) => {
		const scratch = realpathSync(mkdtempSync(join(tmpdir(), "review-untracked-replay-")));
		t.after(() => rmSync(scratch, { recursive: true, force: true }));
		const cwd = join(scratch, "repo");
		mkdirSync(join(cwd, "src"), { recursive: true });
		const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, encoding: "utf8" });
		git("init", "-q");
		git("commit", "--allow-empty", "-qm", "base");
		const baseRef = git("rev-parse", "HEAD").trim();
		const baseAlias = "refs/tags/review-base";
		let otherBase: string | undefined;
		writeFileSync(join(cwd, selectedPath), "export const add = (a, b) => a + b;\n");
		if (committedOnly) {
			git("tag", "review-base", baseRef);
			git("commit", "--allow-empty", "-qm", "different base with the same tree");
			otherBase = git("rev-parse", "HEAD").trim();
			git("add", selectedPath);
			git("commit", "-qm", "candidate");
			writeFileSync(join(cwd, "existing-unrelated.txt"), "not part of the candidate\n");
		}
		const untrackedPaths = () => git("ls-files", "--others", "--exclude-standard", "-z");
		const inventory = () => `sha256:${createHash("sha256").update(untrackedPaths()).digest("hex")}`;
		const originalInventory = inventory();
		const intendedUntracked = committedOnly ? [] : [selectedPath];
		const selector = committedOnly ? { baseRef, committedOnly: true } : {};
		const baseArgs = committedOnly ? ["--base-ref", baseRef, "--committed-only"] : [];

		const collect = statusV9(fixture("status-v5-capture-result-submission"));
		collect.action = "collect";
		collect.projection.kind = committedOnly ? "base-diff" : "current-changes";
		collect.projection.intended_untracked = intendedUntracked;
		const input = collect.next_transition.collect.inputs[0];
		if (committedOnly) {
			const tree = git("rev-parse", `${baseRef}^{tree}`).trim();
			collect.projection.base_tree = input.base_tree = input.artifact_subject.base_tree = tree;
		}
		const lineageId: string = collect.authority.lineage_id;
		const target: string = collect.target_identity;
		const initial = statusV9(fixture("status-v5"));
		const projection = { ...collect.projection };
		const selectionTokens = [`--contract=${contract}`, "--next-transition=true", "--agent=pi",
			...(committedOnly ? [`--base-ref=${projection.base_tree}`, "--committed-only=true"] : ["--projection=workspace"]),
			"--intended-untracked-selection={{value}}"];
		const offered = {
			...initial, target_identity: target, projection, forecast: undefined,
			next_transition: {
				kind: "collect", reason_code: "intended_untracked_selection_required", collect: { inputs: [{
					name: "intended_untracked_selection", schema: selectionSchema, capture_operation: "external.select_intended_untracked",
					arguments: [["target_identity", target], ["projection", "workspace"], ["base_tree", projection.base_tree],
						["candidate_tree", projection.current_candidate_tree], ["eligible_paths_json", JSON.stringify(untrackedPaths().split("\0").filter(Boolean))],
						["expected_untracked_inventory", originalInventory]].map(([name, value]) => ({ name, value })),
					submission: { operation_token: "status", argument_tokens: selectionTokens,
						value: { slot: "intended_untracked_selection", domain: "schema_bound_json", schema: selectionSchema, substitution_location: selectionTokens.length - 1 } },
				}] },
			},
		};
		const ready = {
			...offered,
			next_transition: { kind: "execute", reason_code: "review_start_required", execute: {
				operation: "review.start", preconditions: [], binding: { target_identity: target },
				arguments: [{ name: "contract", value: contract, token: `--contract=${contract}` }],
			} },
		};
		const started = {
			schema: "gentle-ai.review-integration.start/v3", contract, operation: "review.start", action: "created",
			state: "reviewing", lineage_id: lineageId, lenses_required: true, risk_level: "medium", selected_lenses: ["review-reliability"],
			projection: "workspace", base_tree: projection.base_tree, candidate_tree: projection.current_candidate_tree,
			changed_files: 1, changed_lines: 3, correction_budget: 2,
			risk_reasons: fixture("start-v3-consent-granted").risk_reasons,
			artifact_subjects: [input.artifact_subject], changed_path_manifest: input.changed_path_manifest,
			repository_context: collect.repository_context,
		};
		const mode = { schema: "gentle-ai.review-mode/v1", operation: "status", scope: "both", status: { schema: "gentle-ai.rdd-mode-status/v1", global: "on", clone_local: "", effective: "on", source: "global", revision: originalInventory } };
		const failure = { schema: "gentle-ai.review-integration.failure/v2", contract, operation: "review.status", phase: "preflight", code: "invalid_request",
			message: "The negotiated review request is invalid.", mutation_outcome: "not_started", authority_applicability: "not_evaluated",
			retry_safe: true, replayability: "not_replayable", required_inputs: [], next_action: "correct_request", cause: inventoryChanged };
		const argv: (readonly string[])[] = [];
		let starts = 0;
		const adapter: ExecFileAdapter = async ({ arguments: args }) => {
			argv.push(args);
			const reply = (body: unknown, exitCode = 0) => ({ stdout: JSON.stringify(body), stderr: exitCode === 0 ? "" : `Error: ${failure.message} [invalid_request]\n`,
				exitCode, signal: null, timedOut: false, outputLimitExceeded: false });
			if (args[0] === "review" && args[1] === "mode") return reply(mode);
			if (args[0] === "review" && args[1] === "start") { starts++; return reply(started); }
			assert.deepEqual(args.slice(0, 2), ["review", "status"]);
			const submitted = args.find((arg) => arg.startsWith("--intended-untracked-selection="));
			const value = submitted === undefined ? undefined : JSON.parse(submitted.split("=").slice(1).join("="));
			const expected = value?.expected_untracked_inventory ?? args.find((arg) => arg.startsWith("--expected-untracked-inventory="))?.split("=")[1];
			if (expected !== undefined && expected !== inventory()) return reply(failure, 1);
			return reply(starts ? { ...collect, eligible_untracked_inventory: inventory() } : submitted === undefined ? offered : ready);
		};
		const binary = join(scratch, "gentle-ai-fixture");
		writeFileSync(binary, "fake native provider (argv captured by the ExecFileAdapter)");
		const tools = new Map<string, Tool>();
		createGentleAiExtension({ nativeReviewCli: new NativeReviewCliV216(adapter, binary), candidateViews: null, processEnv: { GENTLE_AI_TELEMETRY: "0" } })(
			{ on() {}, registerCommand() {}, registerTool(tool: Tool) { tools.set(tool.name, tool); } } as never);
		const context = { cwd, hasUI: false, sessionManager: { getSessionId: () => scratch } };
		const call = async (tool: string, parameters: Record<string, unknown>) => (await tools.get(tool)!.execute(tool, parameters, undefined, undefined, context)).details;
		const review = (parameters: Record<string, unknown>) => call("gentle_review", parameters);

		const offer = await review({ operation: "inspect", ...(committedOnly ? { input: JSON.stringify(selector) } : {}) });
		assert.equal(typeof offer.selectionBinding, "string", JSON.stringify(offer));
		const accepted = await review({ operation: "select-intended-untracked", selectionBinding: offer.selectionBinding, intendedUntracked });
		assert.equal(accepted.result?.lineage_id, lineageId, JSON.stringify(accepted));
		assert.ok(argv.some((args) => args.includes(`--intended-untracked-selection=${JSON.stringify({ schema: selectionSchema,
			untracked_scope: committedOnly ? "exclude" : "select", expected_untracked_inventory: originalInventory, intended_untracked: intendedUntracked })}`)), "the fresh provider digest is used for the explicit selection");
		const bound = { operation: "status", lineageId, ...(committedOnly ? { input: JSON.stringify(selector) } : {}) };
		const before = await review(bound);
		const binding = before.collectBindings?.[0];
		assert.ok(binding, JSON.stringify(before));
		assert.equal(before.result?.eligible_untracked_inventory, originalInventory);

		if (committedOnly) {
			const withBase = (ref: string) => review({ ...bound, input: JSON.stringify({ baseRef: ref, committedOnly: true }) });
			const from = argv.length;
			const aliased = await withBase(baseAlias);
			assert.deepEqual(aliased.collectBindings, before.collectBindings, JSON.stringify(aliased));
			const conflict = await withBase(otherBase!);
			assert.deepEqual([conflict.status, conflict.outcome, conflict.reason, conflict.mutation_performed, conflict.mutation_outcome],
				["blocked", "capture-route-registration-rejected", "selector-mismatch", false, "none"]);
			const stale = await call("gentle_review_capture", { lineageId, collectBinding: JSON.stringify({ ...JSON.parse(binding.collectBinding), name: "stale" }) });
			assert.deepEqual([stale.status, stale.outcome, stale.reason, stale.mutation_performed, stale.mutation_outcome],
				["blocked", "capture-binding-rejected", "collectBinding is missing or stale for current STATUS", false, "none"]);
			assert.deepEqual(argv.slice(from).filter((args) => args[1] !== "mode").map((args) => [args[1], args.includes("--base-ref") ? args[args.indexOf("--base-ref") + 1] : undefined]),
				[["status", baseAlias], ["status", otherBase], ["status", undefined]], "no reviewer submission; alias and different base reached native STATUS");
		}

		if (committedOnly) writeFileSync(join(cwd, "new-unrelated.txt"), "not part of the candidate\n");
		else { git("add", selectedPath); git("commit", "-qm", "previously untracked candidate"); }
		assert.notEqual(inventory(), originalInventory);
		const from = argv.length;
		const captured = await call("gentle_review_capture", { lineageId, collectBinding: binding.collectBinding });
		const after = await review(bound);
		const currentCalls = argv.slice(from).filter((args) => args[0] === "review" && args[1] === "status");
		const expected = ["review", "status", "--contract", contract, "--cwd", cwd, "--projection", "workspace", ...baseArgs, "--lineage", lineageId, "--agent", "pi", "--next-transition"];
		assert.deepEqual(currentCalls, [expected, expected], JSON.stringify({ captureFailure: captured.native_failure, statusFailure: after.native_failure }));
		assert.equal(captured.outcome, "reviewer-model-run-forecast", JSON.stringify(captured));
		assert.equal(captured.mutation_performed, false);
		assert.deepEqual(after.collectBindings, before.collectBindings);
		assert.equal(after.result?.eligible_untracked_inventory, inventory());
		assert.equal(starts, 1);
		assert.deepEqual(argv.slice(from).map((args) => args[1]).filter((op) => op !== "mode"), ["status", "status"], "no new START or reviewer submission");
	});
}
