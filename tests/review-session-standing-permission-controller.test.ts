import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { ChildStandingReviewPermissionClient, ParentStandingReviewPermissionBroker } from "../lib/review-session-standing-permission-ipc.ts";
import { captureReviewSessionIdentity, grantReviewSessionPermission, hasReviewSessionPermission, revokeReviewSessionPermissionsForSession } from "../lib/review-session-standing-permission.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import { NativeReviewConsentRequiredError, type NativeReviewCli } from "../lib/native-review-cli.ts";
import { decodeReviewConsentV2, decodeReviewConsentV3, type ReviewConsentEnvelope, type ReviewStatusV3 } from "../lib/review-integration-v2.ts";
import {
	HOST_REVIEW_SESSION_PERMISSION_LABEL,
	formatReviewConsentUi,
	presentReviewConsentUi,
} from "../lib/review-consent-ui.ts";

function consentFixture(): Record<string, unknown> {
	const path = join(process.cwd(), "tests", "fixtures", "devbinary", "consent-v3.captured.json");
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function consent() {
	const raw = consentFixture();
	raw.agent = "pi";
	return decodeReviewConsentV3(raw, "pi");
}

function providerV2Consent() {
	const raw = consentFixture();
	delete raw.agent;
	raw.schema = "gentle-ai.review-integration.consent/v2";
	return decodeReviewConsentV2(raw);
}

function nonPiV3Consent() {
	return decodeReviewConsentV3(consentFixture(), "claude-code");
}

function consentCustom(select: (title: string, options: string[]) => Promise<string | undefined>) {
	return async (factory: (...args: never[]) => unknown) => {
		let result: unknown;
		const component = factory(
			{ terminal: { rows: 24 }, requestRender() {} },
			{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
			undefined,
			(value: unknown) => { result = value; },
		) as { getActionOptions(): readonly string[]; render(width: number): string[]; handleInput?(data: string): void };
		component.render(80);
		const options = [...component.getActionOptions()];
		const selected = await select("", options);
		const index = options.indexOf(selected ?? "");
		if (index === -1) component.handleInput?.("\u001b");
		else {
			for (let current = 0; current < index; current += 1) {
				component.handleInput?.("\u001b[B");
				component.render(80);
			}
			component.handleInput?.("\r");
		}
		return result;
	};
}

test("host UI preserves the complete provider envelope and adds a separately owned third action", () => {
	const envelope = consent();
	const before = structuredClone(envelope.raw);
	const model = formatReviewConsentUi(envelope);
	assert.match(model.title, new RegExp(envelope.headline.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	for (const text of [envelope.reason, envelope.value, ...envelope.riskEvidence, envelope.offPath.note, envelope.offPath.command]) {
		assert.ok(model.title.includes(text), `missing provider text: ${text}`);
	}
	assert.equal(model.options.length, 3);
	for (const [index, choice] of envelope.choices.entries()) {
		assert.ok(model.options[index]!.includes(choice.label));
		assert.ok(model.options[index]!.includes(choice.effect));
	}
	assert.equal(model.content.actions[2]?.label, "Review and allow this session");
	assert.equal(model.content.actions[2]?.effect, "Reviews this change and allows later reviews in this session and repository; revoke anytime.");
	assert.ok(model.options[2]!.includes(HOST_REVIEW_SESSION_PERMISSION_LABEL));
	assert.match(model.title, /The first two actions are provider-owned and apply only to this candidate/);
	assert.match(model.title, /The third action is owned by the Pi host/);
	assert.match(model.content.ownership, /runs the current provider grant for this frozen candidate/);
	assert.match(model.content.ownership, /one fresh validated provider grant for each later candidate/);
	assert.match(model.content.ownership, /canonical Git repository identity, including sibling worktrees/);
	assert.match(model.content.ownership, /Reload preserves it; new, resume, fork, quit, process restart, or explicit revocation ends it/);
	assert.match(model.content.ownership, /no verdict, acknowledgement, maintenance, delivery, or cross-repository authority/);
	assert.equal(envelope.choices.length, 2, "the decoded provider envelope must remain a two-choice contract");
	assert.deepEqual(envelope.raw, before, "formatting must not mutate or append to the provider envelope");
});

test("the real Pi Text primitive bounds every consent line at narrow terminal widths", () => {
	const model = formatReviewConsentUi(consent());
	for (const width of [1, 2, 8, 20, 40]) {
		for (const text of [model.title, ...model.options]) {
			const lines = new Text(text, 0, 0).render(width);
			assert.ok(lines.length > 0);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
		}
	}
});

test("selection maps only exact displayed actions and cancellation or UI failure stays unresolved", async () => {
	const envelope = consent();
	const model = formatReviewConsentUi(envelope);
	const selections = [model.options[0], model.options[1], model.options[2], undefined] as const;
	const expected = [
		{ kind: "provider", answer: "granted" },
		{ kind: "provider", answer: "declined" },
		{ kind: "host-session" },
		undefined,
	];
	for (let index = 0; index < selections.length; index += 1) {
		const ctx = { mode: "tui", ui: { custom: consentCustom(async () => selections[index]) } } as unknown as ExtensionContext;
		assert.deepEqual(await presentReviewConsentUi(ctx, envelope), expected[index]);
	}
	const failed = { mode: "tui", ui: { custom: consentCustom(async () => { throw new Error("UI unavailable"); }) } } as unknown as ExtensionContext;
	assert.equal(await presentReviewConsentUi(failed, envelope), undefined);
});

test("non-TUI selection preserves the existing action and cancellation mapping", async () => {
	const envelope = consent();
	const model = formatReviewConsentUi(envelope);
	const selections = [model.options[0], model.options[1], model.options[2], undefined] as const;
	const expected = [
		{ kind: "provider", answer: "granted" },
		{ kind: "provider", answer: "declined" },
		{ kind: "host-session" },
		undefined,
	];
	for (let index = 0; index < selections.length; index += 1) {
		const ctx = { mode: "rpc", ui: { select: async () => selections[index] } } as unknown as ExtensionContext;
		assert.deepEqual(await presentReviewConsentUi(ctx, envelope), expected[index]);
	}
});

interface RegisteredTool {
	execute(id: string, parameters: unknown, signal: undefined, onUpdate: undefined, context: ExtensionContext): Promise<{ details: Record<string, unknown> }>;
}

interface RegisteredCommand {
	handler(args: string, context: ExtensionContext): Promise<void>;
}

interface RegisteredEvent {
	(event: unknown, context: ExtensionContext): Promise<unknown> | unknown;
}

function reviewRepository(t: test.TestContext): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-session-consent-")));
	t.after(() => {
		try { execFileSync("chmod", ["-R", "u+w", cwd], { stdio: "ignore" }); } catch { /* best effort */ }
		rmSync(cwd, { recursive: true, force: true });
	});
	execFileSync("git", ["init", "-b", "main"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "app.ts"), "export const value = 1;\n");
	execFileSync("git", ["add", "app.ts"], { cwd, stdio: "ignore" });
	execFileSync("git", ["-c", "user.name=Consent Test", "-c", "user.email=consent@example.invalid", "commit", "-m", "base"], { cwd, stdio: "ignore" });
	writeFileSync(join(cwd, "app.ts"), "export const value = 2;\n");
	return cwd;
}

function siblingWorktree(t: test.TestContext, parentRoot: string): string {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gentle-pi-session-consent-worktree-")));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	execFileSync("git", ["worktree", "add", "-b", `permission-child-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, cwd, "HEAD"], { cwd: parentRoot, stdio: "ignore" });
	return cwd;
}

function startStatus(cwd: string, intendedUntracked: readonly string[] = []): ReviewStatusV3 {
	const views = new CandidateViewRegistry();
	const candidate = views.create({
		contributorRoot: cwd,
		...(intendedUntracked.length === 0 ? {} : { intendedUntracked }),
	});
	try {
		return {
			contract: "gentle-ai.review-integration/v2",
			applicability: "unrelated",
			action: "start",
			replayability: "not_replayable",
			targetIdentity: `sha256:${"a".repeat(64)}`,
			projection: {
				schema: "gentle-ai.review-candidate-projection/v1",
				kind: "current-changes",
				projection: "workspace",
				baseTree: candidate.baseTree,
				initialReviewTree: candidate.candidateTree,
				currentCandidateTree: candidate.candidateTree,
				pathsDigest: `sha256:${"a".repeat(64)}`,
				paths: [...candidate.paths],
				intendedUntracked: [...intendedUntracked],
				intendedUntrackedProof: `sha256:${"a".repeat(64)}`,
				initialSnapshotIdentity: `sha256:${"a".repeat(64)}`,
				currentSnapshotIdentity: `sha256:${"a".repeat(64)}`,
			},
			candidates: [],
			raw: { schema: "gentle-ai.review-integration.status/v5" },
		} as unknown as ReviewStatusV3;
	} finally {
		views.cleanup(candidate.token);
	}
}

function intendedUntrackedSelectionStatuses(cwd: string, eligible: string): { initial: ReviewStatusV3; selected: ReviewStatusV3 } {
	const initialTarget = startStatus(cwd);
	const selectedTarget = startStatus(cwd, [eligible]);
	const selection = {
		name: "intended_untracked_selection",
		schema: "gentle-ai.review-intended-untracked-selection/v1",
		captureOperation: "external.select_intended_untracked",
		arguments: [
			{ name: "target_identity", value: initialTarget.targetIdentity },
			{ name: "projection", value: "workspace" },
			{ name: "base_tree", value: initialTarget.projection.baseTree },
			{ name: "candidate_tree", value: initialTarget.projection.currentCandidateTree },
			{ name: "eligible_paths_json", value: JSON.stringify([eligible]) },
			{ name: "expected_untracked_inventory", value: "sha256:" + "a".repeat(64) },
		],
		submission: {
			operationToken: "status",
			argumentTokens: ["--contract=gentle-ai.review-integration/v2", "--next-transition=true", "--agent=pi", "--projection=workspace", "--intended-untracked-selection={{value}}"],
			values: [{ slot: "intended_untracked_selection", domain: "schema_bound_json", schema: "gentle-ai.review-intended-untracked-selection/v1", substitutionLocation: 4 }],
		},
	};
	return {
		initial: {
			...initialTarget,
			nextTransition: { kind: "collect", reasonCode: "intended_untracked_selection_required", collect: { inputs: [selection] } },
			raw: { schema: "gentle-ai.review-integration.status/v7" },
		} as unknown as ReviewStatusV3,
		selected: selectedTarget,
	};
}

function piConsent() {
	const decoded = consent();
	return {
		...decoded,
		choices: decoded.choices.map((choice) => ({
			...choice,
			invocation: choice.invocation.replace(" --consent ", " --agent pi --consent "),
		})) as typeof decoded.choices,
	};
}

function controllerHarness(cwd: string, processEnv: NodeJS.ProcessEnv = {}, options: {
	answerConsentError?: Error & { mutationOutcome?: "none" | "unknown" };
	startAction?: "created" | "resumed" | "replayed" | "closed" | "blocked-scope-action";
	childStandingReviewPermissionClient?: ChildStandingReviewPermissionClient;
	consent?: ReviewConsentEnvelope;
	targetStatus?: (request: Record<string, unknown>) => Promise<ReviewStatusV3>;
} = {}) {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	const events = new Map<string, RegisteredEvent>();
	const answers: string[] = [];
	const answerRequests: Array<{ cwd: string; consent: { raw: unknown }; answer: "granted" | "declined" }> = [];
	const permissionConsent = options.consent ?? piConsent();
	const native = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "", cloneLocal: "", effective: "on", source: "default" } }),
		targetStatus: async (request: Record<string, unknown>) => options.targetStatus?.(request) ?? startStatus(cwd),
		start: async () => { throw new NativeReviewConsentRequiredError(permissionConsent); },
		answerConsent: async (request: { cwd: string; consent: { raw: unknown }; answer: "granted" | "declined" }) => {
			answers.push(request.answer);
			answerRequests.push(request);
			if (options.answerConsentError !== undefined && answers.length === 1) throw options.answerConsentError;
			if (request.answer === "declined") return {
				kind: "declined",
				targetIdentity: permissionConsent.targetIdentity,
				projection: permissionConsent.projection,
				riskLevel: permissionConsent.riskLevel,
				changedFiles: permissionConsent.changedFiles,
				changedLines: permissionConsent.changedLines,
				consent: "declined_this_candidate",
				raw: { operation: "review/start", action: "declined", consent: "declined_this_candidate" },
			};
			const action = options.startAction ?? "closed";
			return { kind: "started", start: { lineageId: `lineage-${answers.length}`, state: action === "blocked-scope-action" ? "unreviewed" : "approved", riskLevel: "high", selectedLenses: [], changedFiles: 1, changedLines: 2, correctionBudget: 0, action, lensesRequired: false, riskReasons: [] } };
		},
	} as unknown as NativeReviewCli;
	createGentleAiExtension({ nativeReviewCli: native, candidateViews: new CandidateViewRegistry(), processEnv, childStandingReviewPermissionClient: options.childStandingReviewPermissionClient })({
		on(name: string, handler: RegisteredEvent) { events.set(name, handler); },
		registerCommand(name: string, definition: RegisteredCommand) { commands.set(name, definition); },
		registerTool(definition: RegisteredTool & { name: string }) { tools.set(definition.name, definition); },
		events: { emit() {} },
	} as unknown as ExtensionAPI);
	const controller = tools.get("gentle_review");
	assert.ok(controller);
	return { controller: controller!, answers, answerRequests, consent: permissionConsent, commands, events };
}

function interactiveContext(cwd: string, manager: object, select: (title: string, options: string[]) => Promise<string | undefined>, sessionId = "session-a"): ExtensionContext {
	return {
		cwd,
		mode: "tui",
		hasUI: true,
		sessionManager: Object.assign(manager, { getSessionId: () => sessionId }),
		ui: { custom: consentCustom(select), notify() {}, setStatus() {}, theme: { fg: (_color: string, text: string) => text } },
	} as unknown as ExtensionContext;
}

test("a validated intended-untracked selection may use the host third action only for its selected repository", async (t) => {
	const cwd = reviewRepository(t);
	const sibling = siblingWorktree(t, cwd);
	const unrelated = reviewRepository(t);
	const selectedPath = "selected.md";
	for (const root of [cwd, sibling, unrelated]) writeFileSync(join(root, selectedPath), "selected\n");
	const statuses = new Map<string, ReturnType<typeof intendedUntrackedSelectionStatuses>>();
	const statusFor = (root: string) => statuses.get(root) ?? statuses.set(root, intendedUntrackedSelectionStatuses(root, selectedPath)).get(root)!;
	const runtime = controllerHarness(cwd, {}, {
		targetStatus: async (request) => ("intendedUntrackedSelection" in request ? statusFor(request.cwd as string).selected : statusFor(request.cwd as string).initial),
	});
	const manager = {};
	let prompts = 0;
	const select = async (_title: string, options: string[]) => {
		prompts += 1;
		assert.equal(options.length, 3, "the host UI exposes exactly its two provider choices plus one host action");
		return options[2];
	};
	const selectIntended = async (root: string, context: ExtensionContext) => {
		const listed = (await runtime.controller.execute(`list-${root}`, { operation: "status", workspaceRoot: root }, undefined, undefined, context)).details;
		assert.equal(typeof listed.selectionBinding, "string");
		return await runtime.controller.execute(`select-${root}`, { operation: "select-intended-untracked", selectionBinding: listed.selectionBinding, intendedUntracked: [selectedPath], workspaceRoot: root }, undefined, undefined, context);
	};

	const first = (await selectIntended(cwd, interactiveContext(cwd, manager, select))).details;
	assert.equal(first.operation, "answer-consent");
	assert.deepEqual(runtime.answers, ["granted"]);
	assert.equal(runtime.answerRequests[0]?.answer, "granted", "the exact provider grant is relayed once");
	assert.equal(JSON.stringify(runtime.answerRequests[0]?.consent.raw), JSON.stringify(runtime.consent.raw), "the exact provider envelope is granted unchanged");
	const grantedIdentity = await captureReviewSessionIdentity(interactiveContext(cwd, manager, select), {});
	assert.ok(grantedIdentity);
	assert.equal(hasReviewSessionPermission(grantedIdentity), true, "the host third action establishes the session repository grant");

	const second = (await selectIntended(sibling, interactiveContext(sibling, manager, select))).details;
	assert.equal(second.operation, "answer-consent");
	assert.deepEqual(runtime.answers, ["granted", "granted"]);
	assert.equal(prompts, 1, "a sibling worktree consumes the selected repository grant without another prompt");

	const third = (await selectIntended(unrelated, interactiveContext(unrelated, manager, select))).details;
	assert.equal(third.operation, "answer-consent");
	assert.deepEqual(runtime.answers, ["granted", "granted", "granted"]);
	assert.equal(prompts, 2, "an unrelated repository receives a new explicit host prompt");

	const headless = (await selectIntended(unrelated, { ...interactiveContext(unrelated, {}, async () => { throw new Error("headless must not prompt"); }), mode: "print", hasUI: false } as ExtensionContext)).details;
	assert.equal(headless.outcome, "native-review-consent-required");
	assert.equal(JSON.stringify(headless.consent), JSON.stringify(runtime.consent.raw), "an unavailable host returns the byte-equivalent raw provider envelope");
	assert.deepEqual(runtime.answers, ["granted", "granted", "granted"], "an unavailable host never submits a provider answer");
});

test("standing permission replays an explicit sibling-worktree consent against its binding-owned workspace root", async (t) => {
	const parentRoot = reviewRepository(t);
	const siblingRoot = siblingWorktree(t, parentRoot);
	writeFileSync(join(siblingRoot, "app.ts"), "export const value = 2;\n");
	const manager = {};
	const context = interactiveContext(parentRoot, manager, async () => {
		throw new Error("an active standing permission must not reopen consent UI");
	});
	const identity = await captureReviewSessionIdentity(context, {});
	assert.ok(identity);
	assert.equal(grantReviewSessionPermission(identity), true);

	const runtime = controllerHarness(parentRoot);
	const details = (await runtime.controller.execute(
		"sibling-standing-permission",
		{ operation: "start", input: JSON.stringify({ mode: "ordinary" }), workspaceRoot: siblingRoot },
		undefined,
		undefined,
		context,
	)).details;

	assert.equal(details.operation, "answer-consent");
	assert.deepEqual(runtime.answers, ["granted"]);
	assert.equal(runtime.answerRequests[0]?.cwd, siblingRoot, "automatic continuation must preserve the pending binding's canonical sibling worktree root");
});

test("provider grant and decline remain candidate-only and cancellation stores nothing", async (t) => {
	const cwd = reviewRepository(t);
	const runtime = controllerHarness(cwd);
	const manager = {};
	const selections = [0, 1, undefined] as const;
	let prompts = 0;
	const ctx = interactiveContext(cwd, manager, async (_title, options) => {
		const selection = selections[prompts++];
		return selection === undefined ? undefined : options[selection];
	});
	const start = { operation: "start", input: JSON.stringify({ mode: "ordinary" }) };
	assert.equal(((await runtime.controller.execute("grant", start, undefined, undefined, ctx)).details.result as { lineage_id?: string }).lineage_id, "lineage-1");
	writeFileSync(join(cwd, "app.ts"), "export const value = 3;\n");
	assert.equal((await runtime.controller.execute("decline", start, undefined, undefined, ctx)).details.outcome, "consent-declined-this-candidate");
	writeFileSync(join(cwd, "app.ts"), "export const value = 4;\n");
	const cancelled = (await runtime.controller.execute("cancel", start, undefined, undefined, ctx)).details;
	assert.equal(cancelled.outcome, "native-review-consent-required");
	assert.deepEqual(runtime.answers, ["granted", "declined"]);
	assert.equal(prompts, 3, "neither provider choice creates standing host permission");
});

test("explicit revocation ends the host grant without changing provider mode or authority", async (t) => {
	const cwd = reviewRepository(t);
	const runtime = controllerHarness(cwd);
	const manager = {};
	let prompts = 0;
	const ctx = interactiveContext(cwd, manager, async (_title, options) => options[prompts++ === 0 ? 2 : 1]);
	const start = { operation: "start", input: JSON.stringify({ mode: "ordinary" }) };
	await runtime.controller.execute("grant-session", start, undefined, undefined, ctx);
	const command = runtime.commands.get("gentle:review-session-permission");
	assert.ok(command);
	await command!.handler("revoke", ctx);
	writeFileSync(join(cwd, "app.ts"), "export const value = 3;\n");
	await runtime.controller.execute("after-revoke", start, undefined, undefined, ctx);
	assert.equal(prompts, 2);
	assert.deepEqual(runtime.answers, ["granted", "declined"]);
});

test("reload shutdown preserves the grant, while nonreload shutdown revokes it", async (t) => {
	const cwd = reviewRepository(t);
	const runtime = controllerHarness(cwd);
	const manager = {};
	let prompts = 0;
	const ctx = interactiveContext(cwd, manager, async (_title, options) => options[prompts++ === 0 ? 2 : 1]);
	const start = { operation: "start", input: JSON.stringify({ mode: "ordinary" }) };
	await runtime.controller.execute("grant-session", start, undefined, undefined, ctx);
	const shutdown = runtime.events.get("session_shutdown");
	assert.ok(shutdown);
	await shutdown!({ reason: "reload" }, ctx);
	writeFileSync(join(cwd, "app.ts"), "export const value = 3;\n");
	await runtime.controller.execute("after-reload", start, undefined, undefined, ctx);
	assert.equal(prompts, 1, "reload keeps the standing permission");
	await shutdown!({ reason: "new" }, ctx);
	writeFileSync(join(cwd, "app.ts"), "export const value = 4;\n");
	await runtime.controller.execute("after-new", start, undefined, undefined, ctx);
	assert.equal(prompts, 2, "new-session shutdown revokes the standing permission");
});

test("successful decoded native START action variants remain eligible for a host grant", async (t) => {
	const cwd = reviewRepository(t);
	let candidate = 3;
	for (const action of ["created", "resumed", "replayed", "closed"] as const) {
		const runtime = controllerHarness(cwd, {}, { startAction: action });
		let prompts = 0;
		const ctx = interactiveContext(cwd, {}, async (_title, options) => {
			prompts += 1;
			return options[2];
		}, `session-${action}`);
		const start = { operation: "start", input: JSON.stringify({ mode: "ordinary" }) };
		await runtime.controller.execute(`${action}-grant`, start, undefined, undefined, ctx);
		writeFileSync(join(cwd, "app.ts"), `export const value = ${candidate++};\n`);
		await runtime.controller.execute(`${action}-next`, start, undefined, undefined, ctx);
		assert.equal(prompts, 1, `${action} must retain the successful decoded START grant variant`);
	}
});

test("blocked-scope-action never persists host permission", async (t) => {
	const cwd = reviewRepository(t);
	const runtime = controllerHarness(cwd, {}, { startAction: "blocked-scope-action" });
	let prompts = 0;
	const ctx = interactiveContext(cwd, {}, async (_title, options) => options[prompts++ === 0 ? 2 : 1]);
	const start = { operation: "start", input: JSON.stringify({ mode: "ordinary" }) };
	const blocked = (await runtime.controller.execute("blocked-host-choice", start, undefined, undefined, ctx)).details;
	assert.equal((blocked.result as { action?: string }).action, "blocked-scope-action");
	assert.equal((blocked.result as { state?: string }).state, "unreviewed");
	writeFileSync(join(cwd, "app.ts"), "export const value = 3;\n");
	await runtime.controller.execute("after-blocked-scope", start, undefined, undefined, ctx);
	assert.equal(prompts, 2, "pending explicit scope action must leave the next candidate behind a fresh prompt");
	assert.deepEqual(runtime.answers, ["granted", "declined"]);
});

test("a late consent answer is accepted once and arms host permission without another prompt", async (t) => {
	const cwd = reviewRepository(t);
	let now = 0;
	t.mock.method(Date, "now", () => now);
	const runtime = controllerHarness(cwd);
	const manager = {};
	let prompts = 0;
	const ctx = interactiveContext(cwd, manager, async (_title, options) => {
		prompts += 1;
		if (prompts === 1) {
			now = 10 * 60 * 1000 + 1;
			return options[2];
		}
		return options[1];
	});
	const start = { operation: "start", input: JSON.stringify({ mode: "ordinary" }) };
	const accepted = (await runtime.controller.execute("late-host-choice", start, undefined, undefined, ctx)).details;
	assert.notEqual(accepted.outcome, "consent-binding-stale");
	assert.deepEqual(runtime.answers, ["granted"]);
	writeFileSync(join(cwd, "app.ts"), "export const value = 3;\n");
	await runtime.controller.execute("after-late-answer", start, undefined, undefined, ctx);
	assert.equal(prompts, 1, "a late session grant must not cause a second prompt");
	assert.deepEqual(runtime.answers, ["granted", "granted"]);
});

test("a failed consent invocation never arms host permission", async (t) => {
	const cwd = reviewRepository(t);
	const failure = Object.assign(new Error("provider start failed before mutation"), { mutationOutcome: "none" as const });
	const runtime = controllerHarness(cwd, {}, { answerConsentError: failure });
	let prompts = 0;
	const ctx = interactiveContext(cwd, {}, async (_title, options) => options[prompts++ === 0 ? 2 : 1]);
	const start = { operation: "start", input: JSON.stringify({ mode: "ordinary" }) };
	const failed = (await runtime.controller.execute("failed-host-choice", start, undefined, undefined, ctx)).details;
	assert.equal(failed.outcome, "native-operation-failed");
	writeFileSync(join(cwd, "app.ts"), "export const value = 3;\n");
	await runtime.controller.execute("after-error", start, undefined, undefined, ctx);
	assert.equal(prompts, 2, "a native error must leave the next candidate behind a fresh prompt");
	assert.deepEqual(runtime.answers, ["granted", "declined"]);
});

test("headless, child, and changed post-UI identity never use host permission", async (t) => {
	const cwd = reviewRepository(t);
	const start = { operation: "start", input: JSON.stringify({ mode: "ordinary" }) };
	for (const [label, processEnv, makeContext, parameters] of [
		["headless", {}, () => ({ ...interactiveContext(cwd, {}, async () => { throw new Error("must not prompt"); }), mode: "print", hasUI: false }) as ExtensionContext, start],
		["child", { GENTLE_PI_AGENTS_CHILD: "1" }, () => interactiveContext(cwd, {}, async () => { throw new Error("must not prompt"); }), start],
	] as const) {
		const runtime = controllerHarness(cwd, processEnv);
		const result = (await runtime.controller.execute(label, parameters, undefined, undefined, makeContext())).details;
		assert.equal(result.outcome, "native-review-consent-required", label);
		assert.deepEqual(runtime.answers, [], label);
	}

	const runtime = controllerHarness(cwd);
	const manager = { sessionId: "before", getSessionId() { return this.sessionId; } };
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		sessionManager: manager,
		ui: {
			custom: consentCustom(async (_title: string, options: string[]) => { manager.sessionId = "after"; return options[2]; }),
			notify() {},
			setStatus() {},
			theme: { fg: (_color: string, text: string) => text },
		},
	} as unknown as ExtensionContext;
	const switched = (await runtime.controller.execute("switched", start, undefined, undefined, ctx)).details;
	assert.equal(switched.outcome, "native-review-consent-required");
	assert.deepEqual(runtime.answers, []);
});

test("standing permission never replays provider v2 or non-Pi v3 consents", async (t) => {
	const cwd = reviewRepository(t);
	const manager = {};
	const start = { operation: "start", input: JSON.stringify({ mode: "ordinary" }) };
	const authorized = controllerHarness(cwd);
	const grantingContext = interactiveContext(cwd, manager, async (_title, options) => options[2]);
	await authorized.controller.execute("grant-standing-permission", start, undefined, undefined, grantingContext);
	assert.deepEqual(authorized.answers, ["granted"]);

	for (const [label, providerConsent] of [
		["provider v2", providerV2Consent()],
		["non-Pi v3", nonPiV3Consent()],
	] as const) {
		const runtime = controllerHarness(cwd, {}, { consent: providerConsent });
		const result = (await runtime.controller.execute(label, start, undefined, undefined, interactiveContext(cwd, manager, async () => { throw new Error(`${label} must not prompt`); }))).details;
		assert.equal(result.outcome, "native-review-consent-required", label);
		assert.deepEqual(result.consent, providerConsent.raw, `${label} returns the exact unresolved provider envelope`);
		assert.deepEqual(runtime.answers, [], `${label} never submits a provider answer`);
	}
});

test("a child never asks its broker to replay provider v2 or non-Pi v3 consents", async (t) => {
	const cwd = reviewRepository(t);
	const start = { operation: "start", input: JSON.stringify({ mode: "ordinary" }), workspaceRoot: cwd };
	for (const [label, providerConsent] of [
		["provider v2", providerV2Consent()],
		["non-Pi v3", nonPiV3Consent()],
	] as const) {
		let brokerRequests = 0;
		const runtime = controllerHarness(cwd, { GENTLE_PI_AGENTS_CHILD: "1" }, {
			consent: providerConsent,
			childStandingReviewPermissionClient: {
				requestAuthorization: async () => {
					brokerRequests += 1;
					return true;
				},
				close() {},
			} as unknown as ChildStandingReviewPermissionClient,
		});
		const result = (await runtime.controller.execute(label, start, undefined, undefined, interactiveContext(cwd, {}, async () => { throw new Error(`${label} child must not prompt`); }))).details;
		assert.equal(result.outcome, "native-review-consent-required", label);
		assert.deepEqual(result.consent, providerConsent.raw, `${label} returns the exact unresolved provider envelope`);
		assert.equal(brokerRequests, 0, `${label} never requests broker authorization`);
		assert.deepEqual(runtime.answers, [], `${label} never submits a provider answer`);
	}
});

test("child permission transport survives reload shutdown but closes on terminal session shutdown", (t) => {
	const cwd = reviewRepository(t);
	let closes = 0;
	const runtime = controllerHarness(cwd, { GENTLE_PI_AGENTS_CHILD: "1" }, {
		childStandingReviewPermissionClient: { close: () => { closes += 1; } } as unknown as ChildStandingReviewPermissionClient,
	});
	const shutdown = runtime.events.get("session_shutdown");
	assert.ok(shutdown);
	const context = interactiveContext(cwd, {}, async () => undefined, "child-session");
	shutdown({ reason: "reload" }, context);
	assert.equal(closes, 0, "reload leaves the process-owned transport open for the replacement extension");
	shutdown({ reason: "new" }, context);
	assert.equal(closes, 1, "a terminal lifecycle closes the transport");
});

test("a package-owned child replays its exact pending ordinary grant from a sibling Git worktree only while its parent session remains authorized", async (t) => {
	const parentRoot = reviewRepository(t);
	const childRoot = siblingWorktree(t, parentRoot);
	const unrelatedRoot = reviewRepository(t);
	writeFileSync(join(childRoot, "app.ts"), "export const value = 2;\n");
	const parentManager = {};
	const parentIdentity = await captureReviewSessionIdentity({
		cwd: parentRoot,
		mode: "tui",
		hasUI: true,
		sessionManager: Object.assign(parentManager, { getSessionId: () => "parent-session" }),
	}, {});
	assert.ok(parentIdentity);
	assert.equal(grantReviewSessionPermission(parentIdentity), true);

	const childToParent = new PassThrough();
	const parentToChild = new PassThrough();
	const broker = new ParentStandingReviewPermissionBroker(
		{ readable: childToParent, writable: parentToChild },
		(repositoryIdentity) => repositoryIdentity === parentIdentity.repositoryIdentity && parentManager.getSessionId() === "parent-session" && hasReviewSessionPermission(parentIdentity),
	);
	const childPermission = new ChildStandingReviewPermissionClient(
		{ readable: parentToChild, writable: childToParent },
		{ timeoutMs: 25 },
	);
	const runtime = controllerHarness(childRoot, { GENTLE_PI_AGENTS_CHILD: "1" }, { childStandingReviewPermissionClient: childPermission });
	const childContext = interactiveContext(childRoot, {}, async () => { throw new Error("a child must not open its own consent UI"); }, "child-session");
	const explicitStart = { operation: "start", input: JSON.stringify({ mode: "ordinary" }), workspaceRoot: childRoot };

	const granted = (await runtime.controller.execute("child-grant", explicitStart, undefined, undefined, childContext)).details;
	assert.equal(granted.operation, "answer-consent");
	assert.deepEqual(runtime.answers, ["granted"], "the child locally replays the exact provider grant once");

	const unrelatedContext = interactiveContext(unrelatedRoot, {}, async () => { throw new Error("an unrelated child target must not open its own consent UI"); }, "child-session");
	const unrelatedStart = { operation: "start", input: JSON.stringify({ mode: "ordinary" }), workspaceRoot: unrelatedRoot };
	const unrelated = (await runtime.controller.execute("child-unrelated", unrelatedStart, undefined, undefined, unrelatedContext)).details;
	assert.equal(unrelated.outcome, "native-review-consent-required", "a dynamically targeted unrelated repository is denied by the task-bound broker");
	assert.deepEqual(runtime.answers, ["granted"]);

	revokeReviewSessionPermissionsForSession(parentIdentity.sessionManager, parentIdentity.sessionId);
	writeFileSync(join(childRoot, "app.ts"), "export const value = 3;\n");
	const denied = (await runtime.controller.execute("child-revoked", explicitStart, undefined, undefined, childContext)).details;
	assert.equal(denied.outcome, "native-review-consent-required", "a revoked parent session cannot authorize the next child candidate");
	assert.deepEqual(runtime.answers, ["granted"]);
	childPermission.close();
	broker.close();
	childToParent.destroy();
	parentToChild.destroy();
});
