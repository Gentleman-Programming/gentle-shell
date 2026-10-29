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

// Cross-entrypoint sharing of the store (gentle-shell#1558).
//
// Pi loads every extension entrypoint with its own Jiti instance and
// `moduleCache: false`, so each entrypoint re-evaluates `lib/` modules and a
// module-local store would give the panel (gentle-ai.ts) one Map while the
// launch, usage, and status readers (gentle-agents.ts, gentle-shell.ts) hold
// their own empty copies. These tests reproduce that isolation the same way
// the loader creates it: a second import of the module under a distinct URL is
// a separate module record in the same process, standing in for a second
// extension entrypoint.
//
// The specifier is built as a URL string because the TypeScript checker
// cannot resolve a literal query-string import; at runtime Node still keys
// the module cache on the full URL, giving this evaluation its own copy.
const secondEntrypointSpecifier = new URL("../lib/session-profile-binding.ts?gentle-agents-entrypoint", import.meta.url).href;
const otherEntrypoint = await import(secondEntrypointSpecifier);

test("a binding written by one entrypoint is visible to every other entrypoint", (t) => {
	resetSessionProfileBindingsForTesting();
	otherEntrypoint.resetSessionProfileBindingsForTesting();
	t.after(() => {
		resetSessionProfileBindingsForTesting();
		otherEntrypoint.resetSessionProfileBindingsForTesting();
	});
	bindSessionProfile("session-1", "work", { worker: { model: "zai/glm-4.7" } });
	const read = otherEntrypoint.readSessionProfileBinding("session-1");
	assert.equal(read?.name, "work", "the launch-path entrypoint must see what the panel wrote");
	assert.equal(read?.modelProfiles.worker?.model, "zai/glm-4.7", "the routing snapshot crosses entrypoints intact");
	resetSessionProfileBindingsForTesting();
});

test("a binding written by a non-panel entrypoint is visible to the panel entrypoint", (t) => {
	resetSessionProfileBindingsForTesting();
	t.after(() => {
		resetSessionProfileBindingsForTesting();
		otherEntrypoint.resetSessionProfileBindingsForTesting();
	});
	otherEntrypoint.bindSessionProfile("session-2", "beta", { explore: { model: "openai-codex/gpt-5.6-terra" } });
	assert.equal(readSessionProfileBinding("session-2")?.name, "beta");
	resetSessionProfileBindingsForTesting();
});

test("clearing from one entrypoint unbinds every entrypoint", (t) => {
	resetSessionProfileBindingsForTesting();
	t.after(() => {
		resetSessionProfileBindingsForTesting();
		otherEntrypoint.resetSessionProfileBindingsForTesting();
	});
	bindSessionProfile("session-3", "work", { worker: { model: "zai/glm-4.7" } });
	otherEntrypoint.clearSessionProfileBinding("session-3");
	assert.equal(readSessionProfileBinding("session-3"), undefined, "a cleared binding falls back in every entrypoint");
	assert.equal(otherEntrypoint.readSessionProfileBinding("session-3"), undefined);
	resetSessionProfileBindingsForTesting();
});

test("each entrypoint still hands out private copies of the shared store", (t) => {
	resetSessionProfileBindingsForTesting();
	t.after(() => {
		resetSessionProfileBindingsForTesting();
		otherEntrypoint.resetSessionProfileBindingsForTesting();
	});
	bindSessionProfile("session-4", "work", { worker: { model: "zai/glm-4.7" } });
	const first = otherEntrypoint.readSessionProfileBinding("session-4");
	first!.modelProfiles.worker!.model = "mutated/elsewhere";
	assert.equal(
		otherEntrypoint.readSessionProfileBinding("session-4")?.modelProfiles.worker?.model,
		"zai/glm-4.7",
		"mutating one reader's copy never reaches another reader",
	);
	resetSessionProfileBindingsForTesting();
});
