import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDrakoncAiExtension } from "../extensions/drakonc-ai.ts";
import { declareReviewRelayHandshake, DRAKONC_PI_REVIEW_RELAY_CONTRACT, DRAKONC_PI_REVIEW_RELAY_CONTRACT_ENV } from "../lib/review-relay-contract.ts";

// drakonc-pi#550: the session shell must inherit the relay handshake, so a
// `drakonc-ai review ... --agent pi` typed in a shell tool is eligible without
// the operator reading package source for the value.

test("declareReviewRelayHandshake exports the exact contract and reports whether it changed anything", () => {
	const env: NodeJS.ProcessEnv = {};
	assert.equal(declareReviewRelayHandshake(env), true);
	assert.equal(env[DRAKONC_PI_REVIEW_RELAY_CONTRACT_ENV], DRAKONC_PI_REVIEW_RELAY_CONTRACT);
	assert.equal(declareReviewRelayHandshake(env), false, "already declared");
	const stale: NodeJS.ProcessEnv = { [DRAKONC_PI_REVIEW_RELAY_CONTRACT_ENV]: "drakonc-pi.review-relay/v0" };
	assert.equal(declareReviewRelayHandshake(stale), true, "a wrong value is replaced: this extension is the host");
	assert.equal(stale[DRAKONC_PI_REVIEW_RELAY_CONTRACT_ENV], DRAKONC_PI_REVIEW_RELAY_CONTRACT);
});

test("loading the extension declares the handshake in the session environment", () => {
	const processEnv: NodeJS.ProcessEnv = { PATH: "/bin" };
	createDrakoncAiExtension({ nativeReviewCli: null, processEnv })({ on() {}, registerTool() {}, registerCommand() {} } as unknown as ExtensionAPI);
	assert.equal(processEnv[DRAKONC_PI_REVIEW_RELAY_CONTRACT_ENV], DRAKONC_PI_REVIEW_RELAY_CONTRACT);
	assert.equal(processEnv.PATH, "/bin");
});
