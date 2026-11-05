import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";
import { profileRoleEntries } from "../lib/agent-profiles.ts";
import type { AgentModelConfig } from "../lib/model-routing-authority.ts";
import {
	createSessionProfileBind,
	createSessionProfileClear,
	createSessionProfileStartupBind,
} from "../lib/session-profile-persistence.ts";
import { replay, replayReviewerRouting, type Transcript } from "./fixtures/session-profile-v1/replay.ts";
import { reviewHostRelaySelection as v1ReviewHostRelaySelection } from "./fixtures/session-profile-v1/gentle-ai-reviewer.ts";

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

// A2 shapes, written by the current codec (section 5): the v1 observation is
// asserted directly, since how the current version reads them is T3's job.
const startupDefaults = {
	local: { profiles, localPin: "local" },
	repo: { profiles, repoDeclaration: "frontier" },
	global: { profiles, active: "team" },
} as const;

for (const [origin, defaults] of Object.entries(startupDefaults) as Array<[keyof typeof startupDefaults, (typeof startupDefaults)["local"]]>) {
	test(`v1 reads a ${origin} startup bind as bound, with the startup launch routing and no drift notice`, () => {
		const name = { local: "local", repo: "frontier", global: "team" }[origin];
		const definition = profiles[name];
		const started = replay("v1", { records: [], defaults });
		const observed = replay("v1", { records: [createSessionProfileStartupBind(origin, name, definition)], defaults });
		assert.deepEqual(observed, {
			authority: true,
			kind: "explicit",
			label: `${name} (session)`,
			routing: definition,
			foreignRouting: definition,
			notice: undefined,
		});
		// Launch routing ignores the orchestrator key the record carries; the
		// inherited path may hold an absent route field as `undefined`.
		const { orchestrator: _, ...roles } = observed.routing!;
		assert.deepEqual(roles, JSON.parse(JSON.stringify(started.routing)));
	});
}

test("v1 reads a startup-none clear as a legacy clear", () => {
	const defaults = { profiles, foreignPin: "team" };
	const observed = replay("v1", { records: [userBind("local", LOCAL), createSessionProfileClear("none")], defaults });
	assert.equal(observed.kind, "inherited");
	assert.deepEqual(observed, replay("v1", { records: [userBind("local", LOCAL), { kind: "clear" }], defaults }));
});

test("v1 reads an explicit bind with a startup state as bound and ignores the startup state", () => {
	const defaults = { profiles, active: "frontier" };
	for (const startup of [{ origin: "global" as const, name: "team", modelProfiles: TEAM }, "none" as const]) {
		const observed = replay("v1", { records: [createSessionProfileBind("local", LOCAL, startup)], defaults });
		assert.equal(observed.kind, "explicit");
		assert.deepEqual(observed, replay("v1", transcripts["explicit bind"]!));
	}
});

// How the current version reads the A2 shapes (section 4) against v1 (section
// 5). Launch routing ignores the orchestrator key, so routing compares role
// entries; kind, label and notices are asserted per version.
const roles = (config: AgentModelConfig | undefined) =>
	config === undefined ? undefined : JSON.parse(JSON.stringify(Object.fromEntries(profileRoleEntries(config))));
const launchRouting = (version: "v1" | "current", transcript: Transcript) => {
	const observed = replay(version, transcript);
	return { authority: observed.authority, routing: roles(observed.routing), foreignRouting: roles(observed.foreignRouting) };
};

for (const [origin, defaults] of Object.entries(startupDefaults) as Array<[keyof typeof startupDefaults, (typeof startupDefaults)["local"]]>) {
	const name = { local: "local", repo: "frontier", global: "team" }[origin];
	const label = origin === "global" ? name : `${name} (${origin})`;
	const record = createSessionProfileStartupBind(origin, name, profiles[name]);
	test(`current reads a ${origin} startup bind as the inherited ${label}, with v1 launch routing`, () => {
		const transcript = { records: [record], defaults: { ...defaults, foreignPin: "local" } };
		const observed = replay("current", transcript);
		assert.deepEqual([observed.kind, observed.label, observed.notice], ["inherited", label, undefined]);
		assert.deepEqual(launchRouting("current", transcript), launchRouting("v1", transcript));
	});
	test(`resume of a ${origin} startup bind keeps it after the defaults changed, in both versions`, () => {
		const transcript = { records: [record], defaults: { profiles, active: "local", localPin: name === "local" ? "frontier" : undefined } };
		assert.deepEqual(launchRouting("current", transcript), launchRouting("v1", transcript));
		assert.deepEqual(launchRouting("current", transcript).routing, roles(profiles[name]));
		const notice = replay("current", transcript).notice;
		assert.ok(notice?.includes(`this session keeps "${name}" (${origin})`), "the inherited drift notice");
		assert.equal(replay("v1", transcript).notice, undefined, "v1 finds no definition drift");
	});
	test(`follow mode routes a ${origin} startup bind as v1 does`, () => {
		const transcript = { records: [record], defaults: { profiles, active: "local", foreignPin: "frontier" }, env: { GENTLE_PI_PROFILE_FOLLOW: "1" } };
		assert.deepEqual(launchRouting("current", transcript), launchRouting("v1", transcript));
		assert.deepEqual(launchRouting("current", transcript).foreignRouting, roles(profiles[name]));
	});
}

test("current reads a startup-none clear as no session profile, routing as v1 while the defaults did not change", () => {
	const transcript = { records: [userBind("local", LOCAL), createSessionProfileClear("none")], defaults: { profiles, foreignPin: "team" } };
	const observed = replay("current", transcript);
	assert.deepEqual([observed.kind, observed.label, observed.routing, observed.notice], ["inherited", undefined, undefined, undefined]);
	assert.deepEqual(roles(observed.foreignRouting), roles(TEAM), "a foreign repository uses its own pin");
	assert.deepEqual(observed, replay("v1", transcript));
});

test("gap (section 10): a startup-none clear resumed after an active profile appeared diverges from v1", () => {
	const transcript = { records: [createSessionProfileClear("none")], defaults: { profiles, active: "frontier" } };
	const current = replay("current", transcript);
	assert.deepEqual([current.kind, current.label, current.routing], ["inherited", undefined, undefined], "current keeps no session profile");
	const v1 = replay("v1", transcript);
	assert.deepEqual([v1.kind, v1.label, v1.routing], ["inherited", "frontier", FRONTIER], "v1 routes to the new active profile");
});

test("follow mode resolves the current defaults after a startup-none or legacy clear, as v1 does", () => {
	for (const clear of [createSessionProfileClear("none"), createSessionProfileClear()]) {
		const transcript = { records: [clear], defaults: { profiles, active: "frontier" }, env: { GENTLE_PI_PROFILE_FOLLOW: "1" } };
		assert.deepEqual(replay("current", transcript), replay("v1", transcript));
		assert.deepEqual(replay("current", transcript).routing, FRONTIER);
	}
});

test("current reads an explicit bind with or without a startup state exactly as v1", () => {
	for (const startup of [{ origin: "global" as const, name: "team", modelProfiles: TEAM }, "none" as const, undefined]) {
		const transcript = { records: [createSessionProfileBind("local", LOCAL, startup)], defaults: { profiles, active: "frontier", foreignPin: "team" } };
		assert.deepEqual(replay("current", transcript), replay("v1", transcript));
	}
});

// Clear (section 10): the record sequences the A2 clear writes, by newest entry.
const teamStartup = { origin: "global" as const, name: "team", modelProfiles: TEAM };
const invalid = { kind: "bind", origin: "user", name: "" };
const clearTranscripts: Record<string, Transcript> = {
	"known startup profile": { records: [createSessionProfileBind("local", LOCAL, teamStartup), createSessionProfileStartupBind("global", "team", TEAM)], defaults: { profiles, active: "team", foreignPin: "frontier" } },
	"known no profile": { records: [createSessionProfileBind("local", LOCAL, "none"), createSessionProfileClear("none")], defaults: { profiles, foreignPin: "team" } },
	"unknown startup state": { records: [userBind("local", LOCAL), createSessionProfileClear()], defaults: { profiles, active: "frontier" } },
	"invalid newest entry, startup known": { records: [userBind("local", LOCAL), invalid, createSessionProfileStartupBind("global", "team", TEAM)], defaults: { profiles, active: "team" } },
	"invalid newest entry, startup unknown": { records: [userBind("local", LOCAL), invalid, createSessionProfileClear()], defaults: { profiles, active: "frontier" } },
	"follow mode": { records: [createSessionProfileBind("local", LOCAL, teamStartup), createSessionProfileClear()], defaults: { profiles, active: "frontier" }, env: { GENTLE_PI_PROFILE_FOLLOW: "1" } },
};

for (const [name, transcript] of Object.entries(clearTranscripts)) {
	test(`a clear routes the same in v1 and current: ${name}`, () => {
		assert.deepEqual(launchRouting("current", transcript), launchRouting("v1", transcript));
		assert.equal(replay("current", transcript).authority, true, "the clear restores authority");
	});
}

test("a clear back to a startup profile with an orchestrator raises no v1 definition drift notice", () => {
	const transcript = clearTranscripts["known startup profile"]!;
	const v1 = replay("v1", transcript);
	assert.deepEqual([v1.notice, roles(v1.routing)], [undefined, roles(TEAM)]);
	assert.deepEqual([replay("current", transcript).label, replay("current", transcript).notice], ["team", undefined]);
});

test("a legacy clear after an explicit choice that carried its startup state freezes the defaults at resume, as v1", () => {
	const startup = { origin: "global" as const, name: "team", modelProfiles: TEAM };
	const transcript = { records: [createSessionProfileBind("local", LOCAL, startup), createSessionProfileClear()], defaults: { profiles, active: "frontier" } };
	assert.deepEqual(replay("current", transcript), replay("v1", transcript));
	assert.equal(replay("current", transcript).label, "frontier");
});

// Reviewers (section 10): the reviewer selection of a version without A1 reads
// the binding, then a live pin, then models.json.
const PINNED: AgentModelConfig = { "review-risk": { model: "openai/pinned-risk" } };

test("gap (section 10): after a startup-none clear a pin appears; a reviewer without A1 follows it, the current one does not", () => {
	const transcript = { records: [createSessionProfileClear("none")], defaults: { profiles: { ...profiles, pinned: PINNED }, localPin: "pinned" } };
	assert.deepEqual(replayReviewerRouting("v1", transcript), PINNED, "v1 without A1 follows the new pin");
	assert.deepEqual(replayReviewerRouting("current", transcript), {}, "current keeps no session profile");
});

test("a startup record's orchestrator feeds the current refuter and validator; a reviewer without A1 falls back to settings.json", (t) => {
	const agentHome = mkdtempSync(join(tmpdir(), "gentle-pi-v1-agent-home-"));
	const previous = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previous;
		rmSync(agentHome, { recursive: true, force: true });
	});
	writeFileSync(join(agentHome, "settings.json"), JSON.stringify({ defaultProvider: "pidefault", defaultModel: "settings-model" }));
	const transcript = { records: [createSessionProfileStartupBind("global", "team", TEAM)], defaults: { profiles, active: "frontier" } };
	const current = replayReviewerRouting("current", transcript), v1 = replayReviewerRouting("v1", transcript);
	assert.deepEqual([current, v1], [TEAM, TEAM], "both read the recorded definition, orchestrator included");
	for (const role of ["review-refuter", "review-validator"]) {
		assert.equal(__testing.reviewHostRelaySelection(role, current).selection, "openai/gpt-5", `current ${role} uses the startup record's orchestrator`);
		assert.equal(v1ReviewHostRelaySelection(role, v1).selection, "pidefault/settings-model", `v1 ${role} without A1 falls back to settings.json`);
	}
});
