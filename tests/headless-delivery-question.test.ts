import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { INTERACTIVE_HOST_ENV } from "../lib/rpc-host.ts";

// Bench gate-p53-r1-BS40 x6 run 3 (headless RPC): the ask-on-risk delivery
// question ran before any code was written; ask_user_question answered
// "unavailable outside the interactive TUI", the orchestrator printed the menu
// and stopped, and the round ended with "No code changed yet". When no human
// can answer, the delivery question resolves to the recommended chain instead.

const HEADLESS_DELIVERY = "No human can answer questions in this session";

function promptFor(mode: string | undefined): string {
	return __testing.buildGentlePrompt("neutral", process.cwd(), undefined, undefined, mode);
}

function withInteractiveHost<T>(value: string | undefined, run: () => T): T {
	const previous = process.env[INTERACTIVE_HOST_ENV];
	if (value === undefined) delete process.env[INTERACTIVE_HOST_ENV];
	else process.env[INTERACTIVE_HOST_ENV] = value;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env[INTERACTIVE_HOST_ENV];
		else process.env[INTERACTIVE_HOST_ENV] = previous;
	}
}

test("headless host modes resolve the ask-on-risk delivery question to the feature-branch chain without asking", () => {
	withInteractiveHost(undefined, () => {
		for (const mode of ["rpc", "print", "json"]) {
			const prompt = promptFor(mode);
			assert.ok(prompt.includes(HEADLESS_DELIVERY), `${mode} must say no human can answer`);
			assert.match(prompt, /ask-on-risk/, `${mode} must name the ask-on-risk delivery question`);
			assert.match(prompt, /`feature-branch-chain`/, `${mode} must name the chain it resolves to`);
			assert.match(prompt, /feature document/, `${mode} must record the choice in the feature document`);
			assert.match(prompt, /consent/, `${mode} must keep consent prompts out of the default`);
		}
	});
});

test("interactive hosts keep asking the delivery question", () => {
	withInteractiveHost(undefined, () => {
		for (const mode of ["tui", undefined]) assert.ok(!promptFor(mode).includes(HEADLESS_DELIVERY), `${String(mode)} keeps the question`);
	});
	withInteractiveHost("1", () => {
		assert.ok(!promptFor("rpc").includes(HEADLESS_DELIVERY), "an interactive RPC host keeps the question");
	});
});

test("the reference documents the headless delivery default", async () => {
	const { readFileSync } = await import("node:fs");
	const reference = readFileSync(new URL("../docs/readme-reference.md", import.meta.url), "utf8");
	for (const term of ["no human can answer questions", "`GENTLE_SHELL_INTERACTIVE_HOST=1`", "`ask-on-risk` does not ask", "`feature-branch-chain`"]) {
		assert.ok(reference.includes(term), `docs/readme-reference.md is missing ${term}`);
	}
});
