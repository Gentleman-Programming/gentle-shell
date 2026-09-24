import assert from "node:assert/strict";
import test from "node:test";
import {
	ALL_KNOWN_AGENTS,
	BUILTIN_PROFILES,
	SDD_AGENT_CATEGORIES,
} from "../lib/sdd-profiles-catalog.ts";

const VERIFIED_ROSTER = [
	"gentle-ai-explore",
	"gentle-ai-verify",
	"gentle-ai-worker",
	"jd-fix-agent",
	"jd-judge-a",
	"jd-judge-b",
	"review-readability",
	"review-reliability",
	"review-resilience",
	"review-risk",
	"sdd-apply",
	"sdd-archive",
	"sdd-design",
	"sdd-explore",
	"sdd-init",
	"sdd-onboard",
	"sdd-proposal",
	"sdd-research",
	"sdd-spec",
	"sdd-status",
	"sdd-sync",
	"sdd-tasks",
	"sdd-verify",
	"security-auditor",
	"task-tracker-manager",
	"ui-specialist",
];

test("categories list every verified agent exactly once", () => {
	const listed = SDD_AGENT_CATEGORIES.flatMap((c) => c.agents);
	assert.deepEqual([...listed].sort(), [...VERIFIED_ROSTER].sort());
	assert.equal(new Set(listed).size, listed.length);
	for (const category of SDD_AGENT_CATEGORIES) {
		assert.ok(category.id.length > 0);
		assert.ok(category.agents.length > 0);
	}
});

test("ALL_KNOWN_AGENTS equals flattened categories", () => {
	assert.deepEqual(ALL_KNOWN_AGENTS, SDD_AGENT_CATEGORIES.flatMap((c) => c.agents));
});

test("stale and retired agents are absent", () => {
	for (const retired of ["sdd-propose", "review-validator", "review-refuter"]) {
		assert.ok(!ALL_KNOWN_AGENTS.includes(retired), `${retired} must not be listed`);
	}
});

test("builtin presets have name, default_model, and non-empty model_profiles", () => {
	for (const key of ["gentle-default", "gentle-economy", "gentle-reasoning"]) {
		const profile = BUILTIN_PROFILES[key];
		assert.ok(profile, `${key} must exist`);
		assert.equal(profile.name, key);
		assert.ok(profile.default_model && profile.default_model.includes("/"), `${key} needs a provider/id default_model`);
		assert.ok(Object.keys(profile.model_profiles).length > 0, `${key} needs entries`);
		for (const [agent, entry] of Object.entries(profile.model_profiles)) {
			assert.ok(entry.model.includes("/"), `${key}.${agent} needs a provider/id model`);
		}
	}
});

test("every agent referenced in builtins exists in ALL_KNOWN_AGENTS", () => {
	const known = new Set(ALL_KNOWN_AGENTS);
	for (const [key, profile] of Object.entries(BUILTIN_PROFILES)) {
		for (const agent of Object.keys(profile.model_profiles)) {
			assert.ok(known.has(agent), `${key} references unknown agent ${agent}`);
		}
	}
});
