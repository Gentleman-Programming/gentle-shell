import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { bindSessionProfile } from "../lib/session-profile-binding.ts";
import {
	ORCHESTRATOR_MODE_ENV,
	resolveOrchestratorMode,
} from "../lib/orchestrator-mode-policy.ts";

// ---------------------------------------------------------------------------
// full-delegation-mode S2/S7: the effective mode follows the live profile.
//
// Every case here exists because the mode is read on the hot path of a prompt
// build: it must never throw, never read a frozen startup snapshot, and never
// let an unrecognized override pass for a decision.
// ---------------------------------------------------------------------------

const roots: string[] = [];
function configHomeWithProfiles(profiles: unknown): string {
	const home = mkdtempSync(join(tmpdir(), "gp-orch-mode-"));
	roots.push(home);
	if (profiles !== undefined) {
		writeFileSync(join(home, "profiles.json"), typeof profiles === "string" ? profiles : JSON.stringify(profiles));
	}
	return home;
}
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function storeWith(workflow?: Record<string, unknown>): unknown {
	return {
		kind: "gentle-pi.agent_model_profiles",
		version: 1,
		active: "normal",
		profiles: {
			normal: { orchestrator: { model: "gpt-5.4" } },
			"frontier-local": { orchestrator: { model: "claude-opus-4-6" } },
		},
		...(workflow === undefined ? {} : { workflow }),
	};
}

function bind(sessionId: string, profile: string): void {
	bindSessionProfile(sessionId, profile, { orchestrator: { model: "gpt-5.4" } });
}

test("a session with no profile anywhere resolves to the organic default", () => {
	const storeWithoutActive = {
		kind: "gentle-pi.agent_model_profiles",
		version: 1,
		profiles: { normal: { orchestrator: { model: "gpt-5.4" } } },
	};
	const resolution = resolveOrchestratorMode({
		cwd: process.cwd(),
		configHome: configHomeWithProfiles(storeWithoutActive),
		sessionId: "mode-none",
		env: {},
	});
	assert.equal(resolution.mode, "organic");
	assert.equal(resolution.source, "default");
	assert.equal(resolution.profileName, undefined);
});

test("a session that never bound a profile inherits the global active profile's mode", () => {
	const resolution = resolveOrchestratorMode({
		cwd: process.cwd(),
		configHome: configHomeWithProfiles(storeWith({ "frontier-local": { orchestratorMode: "full-delegation" } })),
		sessionId: "mode-fresh",
		env: {},
	});
	// `active` is "normal" in the fixture, which carries no workflow entry.
	assert.equal(resolution.profileName, "normal");
	assert.equal(resolution.mode, "organic");
	assert.equal(resolution.source, "session_profile");
});

test("a bound profile in full delegation mode wins, and names itself as the source", () => {
	bind("mode-full", "frontier-local");
	const resolution = resolveOrchestratorMode({
		cwd: process.cwd(),
		configHome: configHomeWithProfiles(storeWith({ "frontier-local": { orchestratorMode: "full-delegation" } })),
		sessionId: "mode-full",
		env: {},
	});
	assert.equal(resolution.mode, "full-delegation");
	assert.equal(resolution.source, "session_profile");
	assert.equal(resolution.profileName, "frontier-local");
});

test("a profile without a workflow entry still decides, as organic", () => {
	bind("mode-organic", "normal");
	const resolution = resolveOrchestratorMode({
		cwd: process.cwd(),
		configHome: configHomeWithProfiles(storeWith({ "frontier-local": { orchestratorMode: "full-delegation" } })),
		sessionId: "mode-organic",
		env: {},
	});
	assert.equal(resolution.mode, "organic");
	assert.equal(resolution.source, "session_profile");
	assert.equal(resolution.profileName, "normal");
});

test("the bound profile is re-read on every call, so a live switch flips the mode both ways", () => {
	const home = configHomeWithProfiles(storeWith({ "frontier-local": { orchestratorMode: "full-delegation" } }));
	bind("mode-switch", "frontier-local");
	const options = { cwd: process.cwd(), configHome: home, sessionId: "mode-switch", env: {} };
	assert.equal(resolveOrchestratorMode(options).mode, "full-delegation");

	// Switching to the organic profile restores today's rules on the next read.
	bind("mode-switch", "normal");
	assert.equal(resolveOrchestratorMode(options).mode, "organic");

	// And back again, without any process restart.
	bind("mode-switch", "frontier-local");
	assert.equal(resolveOrchestratorMode(options).mode, "full-delegation");
});

test("the env override wins over the profile and says so", () => {
	bind("mode-env", "normal");
	const resolution = resolveOrchestratorMode({
		cwd: process.cwd(),
		configHome: configHomeWithProfiles(storeWith()),
		sessionId: "mode-env",
		env: { [ORCHESTRATOR_MODE_ENV]: "full-delegation" },
	});
	assert.equal(resolution.mode, "full-delegation");
	assert.equal(resolution.source, "environment");
	assert.equal(resolution.envValue, "full-delegation");
});

test("an unrecognized env value is reported but never honoured", () => {
	bind("mode-env-bad", "frontier-local");
	const resolution = resolveOrchestratorMode({
		cwd: process.cwd(),
		configHome: configHomeWithProfiles(storeWith({ "frontier-local": { orchestratorMode: "full-delegation" } })),
		sessionId: "mode-env-bad",
		env: { [ORCHESTRATOR_MODE_ENV]: "super-delegation" },
	});
	assert.equal(resolution.mode, "full-delegation");
	assert.equal(resolution.source, "session_profile");
	assert.equal(resolution.envValue, "super-delegation");
});

test("a missing, malformed or unreadable profiles store fails closed to organic", () => {
	for (const store of [undefined, "{not json", { kind: "wrong" }]) {
		bind("mode-broken", "frontier-local");
		const resolution = resolveOrchestratorMode({
			cwd: process.cwd(),
			configHome: configHomeWithProfiles(store),
			sessionId: "mode-broken",
			env: {},
		});
		assert.equal(resolution.mode, "organic", `store=${JSON.stringify(store)}`);
		// The profile layer was consulted and could not answer: that is a
		// different situation from having no profile at all, and the report says so.
		assert.equal(resolution.source, "session_profile");
		assert.equal(resolution.profileName, "frontier-local");
	}
});

test("a bound profile the store no longer defines resolves to organic instead of throwing", () => {
	bind("mode-ghost", "deleted-profile");
	const resolution = resolveOrchestratorMode({
		cwd: process.cwd(),
		configHome: configHomeWithProfiles(storeWith({ "frontier-local": { orchestratorMode: "full-delegation" } })),
		sessionId: "mode-ghost",
		env: {},
	});
	assert.equal(resolution.mode, "organic");
	assert.equal(resolution.profileName, "deleted-profile");
});
