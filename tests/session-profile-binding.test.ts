import assert from "node:assert/strict";
import test from "node:test";
import type { AgentModelConfig } from "../lib/model-routing-authority.ts";
import {
	bindSessionProfile,
	clearSessionProfileBinding,
	readSessionProfileBinding,
	resetSessionProfileBindingsForTesting,
	sessionOrPinModelProfiles,
} from "../lib/session-profile-binding.ts";

const ROUTING: AgentModelConfig = {
	worker: { model: "zai/glm-4.7", thinking: "medium" },
	reviewer: { model: "openai/o4-mini" },
};

test("bind and read roundtrip the snapshot by session id", () => {
	resetSessionProfileBindingsForTesting();
	bindSessionProfile("session-a", "work", ROUTING);
	const binding = readSessionProfileBinding("session-a");
	assert.equal(binding?.name, "work");
	assert.equal(binding?.modelProfiles.worker?.model, "zai/glm-4.7");
	assert.equal(binding?.modelProfiles.worker?.thinking, "medium");
});

test("bindings are isolated per session id", () => {
	resetSessionProfileBindingsForTesting();
	bindSessionProfile("session-a", "work", ROUTING);
	bindSessionProfile("session-b", "personal", { solo: { model: "openai/o4-mini" } });
	assert.equal(readSessionProfileBinding("session-a")?.name, "work");
	assert.equal(readSessionProfileBinding("session-b")?.name, "personal");
	assert.equal(readSessionProfileBinding("session-c"), undefined);
});

test("rebinding one session replaces its binding without touching others", () => {
	resetSessionProfileBindingsForTesting();
	bindSessionProfile("session-a", "work", ROUTING);
	bindSessionProfile("session-b", "personal", ROUTING);
	bindSessionProfile("session-a", "review", { auditor: { model: "zai/glm-4.7" } });
	assert.equal(readSessionProfileBinding("session-a")?.name, "review");
	assert.equal(readSessionProfileBinding("session-b")?.name, "personal");
});

test("stored snapshots are immune to later mutation of the source object", () => {
	resetSessionProfileBindingsForTesting();
	const source: AgentModelConfig = { worker: { model: "zai/glm-4.7" } };
	bindSessionProfile("session-a", "work", source);
	source.worker!.model = "openai/o4-mini";
	assert.equal(readSessionProfileBinding("session-a")?.modelProfiles.worker?.model, "zai/glm-4.7");
});

test("read snapshots are copies: callers cannot corrupt the store", () => {
	resetSessionProfileBindingsForTesting();
	bindSessionProfile("session-a", "work", ROUTING);
	const first = readSessionProfileBinding("session-a");
	first!.modelProfiles.worker!.model = "mutated/evil";
	const second = readSessionProfileBinding("session-a");
	assert.equal(second?.modelProfiles.worker?.model, "zai/glm-4.7");
});

test("readSessionProfileBinding(undefined) never resolves a binding", () => {
	resetSessionProfileBindingsForTesting();
	bindSessionProfile("session-a", "work", ROUTING);
	assert.equal(readSessionProfileBinding(undefined), undefined);
});

test("clearSessionProfileBinding removes only the named session", () => {
	resetSessionProfileBindingsForTesting();
	bindSessionProfile("session-a", "work", ROUTING);
	bindSessionProfile("session-b", "personal", ROUTING);
	clearSessionProfileBinding("session-a");
	assert.equal(readSessionProfileBinding("session-a"), undefined);
	assert.equal(readSessionProfileBinding("session-b")?.name, "personal");
});

test("sessionOrPinModelProfiles keeps the wholesale-replacement contract: session wins, pin alone, else undefined", () => {
	resetSessionProfileBindingsForTesting();
	const session: AgentModelConfig = { worker: { model: "zai/glm-4.7" } };
	const pin: AgentModelConfig = { worker: { model: "openai/o4-mini" } };
	assert.equal(sessionOrPinModelProfiles(session, pin), session);
	assert.equal(sessionOrPinModelProfiles(undefined, pin), pin);
	assert.equal(sessionOrPinModelProfiles(session, undefined), session);
	assert.equal(sessionOrPinModelProfiles(undefined, undefined), undefined);
});

test("session bindings from one process never leak into a fresh map state", () => {
	resetSessionProfileBindingsForTesting();
	bindSessionProfile("session-a", "work", ROUTING);
	resetSessionProfileBindingsForTesting();
	assert.equal(readSessionProfileBinding("session-a"), undefined);
});

