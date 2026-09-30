// Cross-entrypoint sharing of the session profile binding store (gentle-shell#1558).
//
// Pi loads every extension entrypoint with its own Jiti instance and
// `moduleCache: false`, so each entrypoint re-evaluates `lib/` modules and a
// module-local store would give the panel (gentle-ai.ts) one Map while the
// launch, usage, and status readers (gentle-agents.ts, gentle-shell.ts) hold
// their own empty copies. These tests reproduce that isolation the same way
// the loader creates it: a second import of the module under a distinct URL is
// a separate module record in the same process, standing in for a second
// extension entrypoint.
import assert from "node:assert/strict";
import test from "node:test";
import {
	bindSessionProfile,
	clearSessionProfileBinding,
	readSessionProfileBinding,
	resetSessionProfileBindingsForTesting,
	type SessionProfileBinding,
} from "../lib/session-profile-binding.ts";

// A second, isolated evaluation of the same module source: a distinct module
// record, so module-local state would diverge, while a process-shared
// registry must not. The specifier is built as a URL because the TypeScript
// checker cannot resolve a literal query-string import; at runtime Node still
// keys the module cache on the full URL, giving this evaluation its own copy.
const secondEntrypointSpecifier = new URL("../lib/session-profile-binding.ts?gentle-agents-entrypoint", import.meta.url).href;
const otherEntrypoint = await import(secondEntrypointSpecifier);

test("a binding written by one entrypoint is visible to every other entrypoint", () => {
	resetSessionProfileBindingsForTesting();
	otherEntrypoint.resetSessionProfileBindingsForTesting();
	bindSessionProfile("session-1", "work", { worker: { model: "zai/glm-4.7" } });
	const read: SessionProfileBinding | undefined = otherEntrypoint.readSessionProfileBinding("session-1");
	assert.equal(read?.name, "work", "the launch-path entrypoint must see what the panel wrote");
	assert.equal(read?.modelProfiles.worker?.model, "zai/glm-4.7", "the routing snapshot crosses entrypoints intact");
	resetSessionProfileBindingsForTesting();
});

test("a binding written by a non-panel entrypoint is visible to the panel entrypoint", () => {
	resetSessionProfileBindingsForTesting();
	otherEntrypoint.bindSessionProfile("session-2", "beta", { explore: { model: "openai-codex/gpt-5.6-terra" } });
	assert.equal(readSessionProfileBinding("session-2")?.name, "beta");
	resetSessionProfileBindingsForTesting();
});

test("clearing from one entrypoint unbinds every entrypoint", () => {
	resetSessionProfileBindingsForTesting();
	bindSessionProfile("session-3", "work", { worker: { model: "zai/glm-4.7" } });
	otherEntrypoint.clearSessionProfileBinding("session-3");
	assert.equal(readSessionProfileBinding("session-3"), undefined, "a cleared binding falls back in every entrypoint");
	assert.equal(otherEntrypoint.readSessionProfileBinding("session-3"), undefined);
	resetSessionProfileBindingsForTesting();
});

test("each entrypoint still hands out private copies of the shared store", () => {
	resetSessionProfileBindingsForTesting();
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
