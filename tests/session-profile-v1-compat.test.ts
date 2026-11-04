import assert from "node:assert/strict";
import test from "node:test";
import type { AgentModelConfig } from "../lib/model-routing-authority.ts";
import { replay, type Transcript } from "./fixtures/session-profile-v1/replay.ts";

// v1 compatibility (gentle-shell#2742, section 10): a session resumed by the
// vendored v1 chain routes like the current modules. This file pins today's
// record shapes; the A2 shapes join the same table as they land.

const FRONTIER: AgentModelConfig = { worker: { model: "anthropic/claude-opus", thinking: "high" } };
const LOCAL: AgentModelConfig = { worker: { model: "ollama/qwen", thinking: "low" } };
const TEAM: AgentModelConfig = { worker: { model: "openai/gpt-5" }, orchestrator: { model: "openai/gpt-5" } };
const profiles = { frontier: FRONTIER, local: LOCAL, team: TEAM };

const userBind = (name: string, modelProfiles: AgentModelConfig) => ({ kind: "bind", origin: "user", name, modelProfiles });

const transcripts: Record<string, Transcript> = {
	"no record, no defaults": { records: [], defaults: { profiles } },
	"no record, active profile": { records: [], defaults: { profiles, active: "frontier" } },
	"no record, local pin over active": { records: [], defaults: { profiles, active: "frontier", localPin: "local" } },
	"no record, repo declaration, foreign pin": {
		records: [],
		defaults: { profiles, repoDeclaration: "team", foreignPin: "local" },
	},
	"explicit bind": { records: [userBind("local", LOCAL)], defaults: { profiles, active: "frontier" } },
	"explicit bind, definition edited since": {
		records: [userBind("local", { worker: { model: "ollama/llama" } })],
		defaults: { profiles, active: "frontier" },
	},
	"legacy clear after a bind": {
		records: [userBind("local", LOCAL), { kind: "clear" }],
		defaults: { profiles, active: "frontier" },
	},
	"legacy clear, no defaults, foreign pin": {
		records: [{ kind: "clear" }],
		defaults: { profiles, foreignPin: "team" },
	},
	"invalid newest record": {
		records: [userBind("local", LOCAL), { kind: "bind", origin: "user", name: "" }],
		defaults: { profiles, active: "frontier" },
	},
	"unsupported newest record": {
		records: [userBind("local", LOCAL), { kind: "rename", name: "x" }],
		defaults: { profiles, active: "frontier" },
	},
};

for (const [name, transcript] of Object.entries(transcripts)) {
	test(`v1 and current resume route the same: ${name}`, () => {
		assert.deepEqual(replay("current", transcript), replay("v1", transcript));
	});
}

test("v1 replay observes the recorded binding, its label and its routing", () => {
	const observed = replay("v1", transcripts["explicit bind"]!);
	assert.deepEqual(observed, {
		authority: true,
		kind: "explicit",
		label: "local (session)",
		routing: LOCAL,
		foreignRouting: LOCAL,
		notice: undefined,
	});
});

test("v1 replay of a legacy clear freezes the resume-time default", () => {
	const observed = replay("v1", transcripts["legacy clear after a bind"]!);
	assert.equal(observed.kind, "inherited");
	assert.equal(observed.label, "frontier");
	assert.deepEqual(observed.routing, FRONTIER);
});
