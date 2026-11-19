import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";
import { NativeReviewCliV216, type ExecFileAdapter } from "../lib/native-review-cli.ts";

// odd/tasks/review-one-call.md T11 (S5), L19: only the run asks the provider
// for the non-blocking findings; a direct gentle_review never does, and the
// run's result carries one bounded copy of them.

type Body = Record<string, unknown>;
interface CapturedAuthority { lineage_id: string }
interface FixtureFindings extends Body { statement: string; findings: Body[] }
interface CapturedStatus extends Body { authority: CapturedAuthority; non_blocking_findings?: FixtureFindings }
interface FixtureEnvelope { result: Body }
interface FixtureDetails extends Body {
	result: FixtureEnvelope;
	non_blocking_findings: FixtureFindings;
	non_blocking_finding_claims: Body;
}
interface FixtureTextContent { text: string }
interface FixtureResult { details: FixtureDetails; content: FixtureTextContent[] }
interface FixtureTool {
	name: string;
	execute(callId: string, parameters: Body, signal: undefined, onUpdate: undefined, context: unknown): Promise<FixtureResult>;
}
const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "rdd-nbf-scope-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
execFileSync("git", ["init", "-q"], { cwd: scratch });
writeFileSync(join(scratch, "app.ts"), "export const value = 1;\n");
const executable = join(scratch, "gentle-ai-fixture");
writeFileSync(executable, "fixture provider; never executed");

const captured = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "status-v9-escalated-non-blocking.captured.json"), "utf8")) as CapturedStatus;
const lineage: string = captured.authority.lineage_id;
const mode = JSON.stringify({ schema: "gentle-ai.review-mode/v1", operation: "status", scope: "both", status: { schema: "gentle-ai.rdd-mode-status/v1", global: "on", clone_local: "", effective: "on", source: "global", revision: `sha256:${"f".repeat(64)}` } });

/** The captured escalated STATUS with `count` non-blocking findings of about 1.2 KB each. */
function statusBody(count: number): CapturedStatus {
	const body = structuredClone(captured);
	body.non_blocking_findings!.findings = Array.from({ length: count }, (_, index) => ({
		id: `R3-W${String(index).padStart(3, "0")}`, lens: "reliability", location: `app.ts:${index + 1}`, severity: "WARNING", disposition: "informational",
		claim: `Fixture claim ${index}; not real review output. ${"c".repeat(1150)}`,
	}));
	return body;
}

/** A provider that knows --non-blocking-findings: the key appears only when the flag is passed. */
function provider(count: number, mutate: (set: Body) => void = () => {}) {
	const statusCalls: (readonly string[])[] = [];
	const adapter: ExecFileAdapter = async (request) => {
		const args = request.arguments;
		let stdout: string;
		if (args[0] === "review" && args[1] === "mode") stdout = mode;
		else if (args[0] === "review" && args[1] === "status") {
			statusCalls.push(args);
			const body = statusBody(count);
			if (!args.includes("--non-blocking-findings")) delete body.non_blocking_findings;
			else mutate(body.non_blocking_findings!);
			stdout = JSON.stringify(body);
		} else throw new Error(`unexpected native invocation: ${args.join(" ")}`);
		return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, outputLimitExceeded: false };
	};
	const tools = new Map<string, FixtureTool>();
	createGentleAiExtension({ nativeReviewCli: new NativeReviewCliV216(adapter, executable, 30_000, 64 * 1024 * 1024), candidateViews: null, processEnv: { GENTLE_AI_TELEMETRY: "0" } })(
		{ on() {}, registerCommand() {}, registerTool: (tool: FixtureTool) => tools.set(tool.name, tool) } as never);
	const context = { cwd: scratch, hasUI: false, sessionManager: { getSessionId: () => "fixture-scope", getBranch: () => [], getSessionFile: () => undefined } };
	const invoke = async (name: string, parameters: Body) => {
		const result = await tools.get(name)!.execute("fixture-call", parameters, undefined, undefined, context);
		return { details: result.details, bytes: Buffer.byteLength((result.content as { text: string }[]).map((part) => part.text).join("")), content: result.content };
	};
	return { statusCalls, invoke, close: () => { __testing.setReviewHostRelayRunnerForTesting(); __testing.setReviewHostRelayGroupRunnersForTesting(); } };
}

test("a direct gentle_review status or inspect never asks for the non-blocking findings and relays none", async (t) => {
	for (const parameters of [{ operation: "status", lineageId: lineage }, { operation: "status" }, { operation: "inspect" }]) {
		const host = provider(300);
		try {
			const { details, content, bytes } = await host.invoke("gentle_review", parameters);
			t.diagnostic(`${JSON.stringify(parameters)} content ${bytes} B`);
			assert.ok(host.statusCalls.length >= 1, JSON.stringify(parameters));
			for (const args of host.statusCalls) assert.equal(args.includes("--non-blocking-findings"), false, `${JSON.stringify(parameters)}: ${args.join(" ")}`);
			assert.doesNotMatch(JSON.stringify(content), /non_blocking_findings/, JSON.stringify(parameters));
			assert.doesNotMatch(JSON.stringify(details), /non_blocking_findings/, JSON.stringify(parameters));
		} finally { host.close(); }
	}
});

test("a model-supplied attempt to opt in through tool input is refused, never sent", async () => {
	for (const parameters of [{ operation: "status", lineageId: lineage, nonBlockingFindings: true }, { operation: "status", lineageId: lineage, input: JSON.stringify({ nonBlockingFindings: true }) }]) {
		const host = provider(1);
		try {
			const { details } = await host.invoke("gentle_review", parameters).catch((error: Error) => ({ details: { thrown: error.message } as Body }));
			for (const args of host.statusCalls) assert.equal(args.includes("--non-blocking-findings"), false, JSON.stringify(parameters));
			assert.doesNotMatch(JSON.stringify(details), /"non_blocking_findings"/, JSON.stringify(parameters));
		} finally { host.close(); }
	}
});

const RUN_CEILING = 32 * 1024;

test("the run asks for them and returns one bounded copy: the nested record omits the raw set, the list and claims are capped", async (t) => {
	const host = provider(300);
	try {
		const { details, bytes } = await host.invoke("gentle_review_run", { lineageId: lineage });
		t.diagnostic(`run content ${bytes} B with 300 findings`);
		assert.equal(details.outcome, "stopped", JSON.stringify(details).slice(0, 400));
		assert.ok(host.statusCalls.length >= 1);
		for (const args of host.statusCalls) assert.equal(args.includes("--non-blocking-findings"), true, args.join(" "));
		assert.ok(bytes <= RUN_CEILING, `run content ${bytes} B exceeds ${RUN_CEILING} B`);
		assert.equal(Object.hasOwn(details.result.result, "non_blocking_findings"), false, "the nested provider record omits the raw set");
		const { non_blocking_findings: _raw, ...rest } = statusBody(0);
		for (const key of Object.keys(rest)) assert.deepEqual(details.result.result[key], rest[key], `nested ${key} unchanged`);
		const listed = details.non_blocking_findings.findings as Body[];
		assert.equal(details.non_blocking_findings.statement, captured.non_blocking_findings.statement);
		assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= 16 * 1024, "the listed findings stay within 16 KiB");
		const expected = statusBody(300).non_blocking_findings.findings.map(({ claim: _claim, ...finding }: Body) => finding);
		assert.deepEqual(listed, expected.slice(0, listed.length), "provider order and fields, unchanged");
		assert.equal(details.non_blocking_findings_omitted_count, 300 - listed.length);
		assert.ok(listed.length > 0 && listed.length < 300);
		const claims = details.non_blocking_finding_claims as Body;
		assert.ok(Buffer.byteLength(Object.values(claims).join("")) <= 8192);
		assert.deepEqual(Object.keys(claims), listed.slice(0, Object.keys(claims).length).map((finding) => finding.id), "claims only for listed ids, in order");
		assert.deepEqual(details.non_blocking_finding_claims_omitted, listed.slice(Object.keys(claims).length).map((finding) => finding.id), "the claim limit names the listed ids it left out");
	} finally { host.close(); }
});

test("a small set is returned whole with no omitted count", async () => {
	const host = provider(3);
	try {
		const { details } = await host.invoke("gentle_review_run", { lineageId: lineage });
		assert.equal(details.outcome, "stopped");
		assert.equal(details.non_blocking_findings.findings.length, 3);
		assert.equal(Object.hasOwn(details, "non_blocking_findings_omitted_count"), false);
		assert.equal(Object.keys(details.non_blocking_finding_claims).length, 3);
		assert.equal(Object.hasOwn(details.result.result, "non_blocking_findings"), false);
	} finally { host.close(); }
});

test("a malformed set fails the strict STATUS decode and the run ends blocked; only whitespace-only strings pass the decoder and are dropped by the run", async () => {
	const malformed: [string, (set: Body) => void][] = [
		["disposition outside the set", (set) => { set.findings[0].disposition = "bogus"; }],
		["claim missing", (set) => { delete set.findings[0].claim; }],
		["extra key", (set) => { set.findings[0].proof_refs = []; }],
		["empty statement", (set) => { set.statement = ""; }],
		["findings null", (set) => { set.findings = null; }],
		["severity not a string", (set) => { set.findings[0].severity = 5; }],
	];
	for (const [label, mutate] of malformed) {
		const host = provider(2, mutate);
		try {
			const { details } = await host.invoke("gentle_review_run", { lineageId: lineage });
			assert.equal(details.outcome, "blocked", label);
			for (const key of ["non_blocking_findings", "non_blocking_finding_claims"]) assert.equal(Object.hasOwn(details, key), false, `${label}: ${key}`);
		} finally { host.close(); }
	}
	for (const [label, mutate] of [["whitespace-only id", (set: Body) => { set.findings[0].id = "   "; }], ["whitespace-only statement", (set: Body) => { set.statement = " "; }]] as const) {
		const host = provider(2, mutate);
		try {
			const { details } = await host.invoke("gentle_review_run", { lineageId: lineage });
			assert.equal(details.outcome, "stopped", label);
			for (const key of ["non_blocking_findings", "non_blocking_finding_claims", "non_blocking_findings_omitted_count"]) assert.equal(Object.hasOwn(details, key), false, `${label}: ${key}`);
			assert.equal(Object.hasOwn(details.result.result, "non_blocking_findings"), false, `${label}: the raw set is still left out`);
		} finally { host.close(); }
	}
});
