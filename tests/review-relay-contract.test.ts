import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";
import { declareReviewRelayHandshake, GENTLE_PI_REVIEW_RELAY_CONTRACT, GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV } from "../lib/review-relay-contract.ts";

// gentle-pi#550: the session shell must inherit the relay handshake, so a
// `gentle-ai review ... --agent pi` typed in a shell tool is eligible without
// the operator reading package source for the value.

test("declareReviewRelayHandshake exports the exact contract and reports whether it changed anything", () => {
	const env: NodeJS.ProcessEnv = {};
	assert.equal(declareReviewRelayHandshake(env), true);
	assert.equal(env[GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV], GENTLE_PI_REVIEW_RELAY_CONTRACT);
	assert.equal(declareReviewRelayHandshake(env), false, "already declared");
	const stale: NodeJS.ProcessEnv = { [GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV]: "gentle-pi.review-relay/v0" };
	assert.equal(declareReviewRelayHandshake(stale), true, "a wrong value is replaced: this extension is the host");
	assert.equal(stale[GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV], GENTLE_PI_REVIEW_RELAY_CONTRACT);
});

test("loading the extension declares the handshake in the session environment", () => {
	const processEnv: NodeJS.ProcessEnv = { PATH: "/bin" };
	createGentleAiExtension({ nativeReviewCli: null, processEnv })({ on() {}, registerTool() {}, registerCommand() {} } as unknown as ExtensionAPI);
	assert.equal(processEnv[GENTLE_PI_REVIEW_RELAY_CONTRACT_ENV], GENTLE_PI_REVIEW_RELAY_CONTRACT);
	assert.equal(processEnv.PATH, "/bin");
});
