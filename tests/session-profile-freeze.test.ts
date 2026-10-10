import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createProfile, emptyProfilesFile, profilesFilePath, setActiveProfile, writeProfilesFileSync } from "../lib/agent-profiles.ts";
import { clearProfilePinSync, localProfilePinPath, repoProfileDeclarationPath, writeProfilePinSync } from "../lib/agent-profile-pin.ts";
import type { AgentModelConfig } from "../lib/model-routing-authority.ts";
import { bindSessionProfile, resetSessionProfileBindingsForTesting } from "../lib/session-profile-binding.ts";
import {
	PROFILE_FOLLOW_ENV,
	freezeSessionProfileAtStartup,
	inheritedProfileDriftNotice,
	profileFollowEnabled,
	sessionProfileRoutingAt,
	readFrozenInheritedProfile,
	resetFrozenInheritedProfilesForTesting,
	resolveInheritedProfile,
	resolveSessionProfile,
	sessionProfileLabel,
	sessionProfileModelProfiles,
} from "../lib/session-profile-freeze.ts";
import type { WorktreeIdentity, WorktreeResolver } from "../lib/session-worktree-registry.ts";

// Inherited profile freeze (gentle-shell#1064 slice 3b-ii). A parent session that
// never pressed Enter resolves `p → P → G` once and keeps that snapshot; `follow`
// keeps the live resolution; children never freeze. The worktree identity is
// injected, so these tests never run Git.

const root = mkdtempSync(join(tmpdir(), "gentle-pi-profile-freeze-"));
after(() => rmSync(root, { recursive: true, force: true }));

const FRONTIER: AgentModelConfig = { worker: { model: "anthropic/claude-opus", thinking: "high" } };
const LOCAL: AgentModelConfig = { worker: { model: "ollama/qwen", thinking: "low" } };
const TEAM: AgentModelConfig = { worker: { model: "openai/gpt-5" }, orchestrator: { model: "openai/gpt-5" } };

let caseIndex = 0;
interface Fixture {
	configHome: string;
	identity: WorktreeIdentity;
	resolveWorktree: WorktreeResolver;
	cwd: string;
	setActive(name: string | undefined): void;
	pinLocal(name: string | undefined): void;
	declareRepo(name: string | undefined): void;
	editProfile(name: string, config: AgentModelConfig): void;
}

function fixture(profiles: Record<string, AgentModelConfig> = { frontier: FRONTIER, local: LOCAL, team: TEAM }): Fixture {
	const base = join(root, `case-${caseIndex++}`);
	const configHome = join(base, "config");
	const identity = { root: join(base, "worktree"), commonDir: join(base, "git-common") };
	mkdirSync(identity.root, { recursive: true });
	let current = profiles;
	let active: string | undefined;
	const write = () => {
		let file = Object.entries(current).reduce((acc, [name, config]) => createProfile(acc, name, config), emptyProfilesFile());
		if (active !== undefined) file = setActiveProfile(file, active);
		writeProfilesFileSync(profilesFilePath(configHome), file);
	};
	write();
	return {
		configHome,
		identity,
		resolveWorktree: () => identity,
		cwd: identity.root,
		setActive(name) { active = name; write(); },
		pinLocal(name) {
			const path = localProfilePinPath(identity.commonDir);
			if (name === undefined) clearProfilePinSync(path); else writeProfilePinSync(path, name);
		},
		declareRepo(name) {
			const path = repoProfileDeclarationPath(identity.root);
			if (name === undefined) clearProfilePinSync(path); else writeProfilePinSync(path, name);
		},
		editProfile(name, config) { current = { ...current, [name]: config }; write(); },
	};
}

function options(f: Fixture, sessionId: string | undefined, env: NodeJS.ProcessEnv = {}) {
	return { sessionId, cwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree, env };
}

beforeEach(() => {
	resetFrozenInheritedProfilesForTesting();
	resetSessionProfileBindingsForTesting();
});

test("resolveInheritedProfile reports the local pin with its origin", () => {
	const f = fixture();
	f.pinLocal("frontier");
	f.declareRepo("team");
	f.setActive("local");
	assert.deepEqual(resolveInheritedProfile({ cwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree }), {
		name: "frontier",
		origin: "local",
		modelProfiles: FRONTIER,
	});
});

test("resolveInheritedProfile falls to the repository declaration, without the orchestrator key", () => {
	const f = fixture();
	f.declareRepo("team");
	f.setActive("local");
	const profile = resolveInheritedProfile({ cwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree });
	assert.deepEqual(JSON.parse(JSON.stringify(profile)), {
		name: "team",
		origin: "repo",
		modelProfiles: { worker: { model: "openai/gpt-5" } },
	});
});

test("resolveInheritedProfile falls to the global active profile in profiles.json", () => {
	const f = fixture();
	f.setActive("local");
	assert.deepEqual(resolveInheritedProfile({ cwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree }), {
		name: "local",
		origin: "global",
		modelProfiles: LOCAL,
	});
});

test("resolveInheritedProfile returns undefined when no layer has a profile", () => {
	const f = fixture();
	assert.equal(resolveInheritedProfile({ cwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree }), undefined);
});

test("resolveInheritedProfile reads the repository declaration of a non-Git project", () => {
	const f = fixture();
	f.declareRepo("team");
	f.setActive("local");
	const profile = resolveInheritedProfile({ cwd: f.cwd, configHome: f.configHome, resolveWorktree: () => undefined });
	assert.equal(profile?.name, "team");
	assert.equal(profile?.origin, "repo");
});

test("a session freezes the inherited profile once: later pin and active changes do not move it", () => {
	const f = fixture();
	f.pinLocal("frontier");
	const first = resolveSessionProfile(options(f, "session-a"));
	assert.equal(first.kind, "inherited");
	f.pinLocal("local");
	f.setActive("team");
	const second = resolveSessionProfile(options(f, "session-a"));
	assert.deepEqual(second, { kind: "inherited", profile: { name: "frontier", origin: "local", modelProfiles: FRONTIER } });
	assert.deepEqual(sessionProfileModelProfiles(second), FRONTIER);
});

test("editing the frozen profile in profiles.json does not change the frozen content", () => {
	const f = fixture();
	f.setActive("frontier");
	freezeSessionProfileAtStartup(options(f, "session-a"));
	f.editProfile("frontier", LOCAL);
	assert.deepEqual(sessionProfileModelProfiles(resolveSessionProfile(options(f, "session-a"))), FRONTIER);
});

test("a session started after the change freezes the new default; the open one keeps its own", () => {
	const f = fixture();
	f.pinLocal("frontier");
	freezeSessionProfileAtStartup(options(f, "session-a"));
	f.pinLocal("local");
	freezeSessionProfileAtStartup(options(f, "session-b"));
	assert.equal(readFrozenInheritedProfile("session-a")?.profile?.name, "frontier");
	assert.equal(readFrozenInheritedProfile("session-b")?.profile?.name, "local");
});

test("startup freeze is idempotent: a second call keeps the first snapshot", () => {
	const f = fixture();
	f.setActive("frontier");
	freezeSessionProfileAtStartup(options(f, "session-a"));
	f.setActive("local");
	freezeSessionProfileAtStartup(options(f, "session-a"));
	assert.equal(readFrozenInheritedProfile("session-a")?.profile?.name, "frontier");
});

test("a session with no profile anywhere freezes 'no profile' and keeps today's routing", () => {
	const f = fixture();
	const first = resolveSessionProfile(options(f, "session-a"));
	assert.deepEqual(first, { kind: "inherited", profile: undefined });
	assert.equal(sessionProfileModelProfiles(first), undefined);
	f.pinLocal("frontier");
	const second = resolveSessionProfile(options(f, "session-a"));
	assert.deepEqual(second, { kind: "inherited", profile: undefined });
	assert.equal(sessionProfileModelProfiles(second), undefined);
	assert.equal(sessionProfileLabel(second), undefined);
});

test("an explicit Enter binding outranks the frozen inherited profile", () => {
	const f = fixture();
	f.pinLocal("frontier");
	freezeSessionProfileAtStartup(options(f, "session-a"));
	bindSessionProfile("session-a", "team", { worker: { model: "openai/gpt-5" } });
	const resolution = resolveSessionProfile(options(f, "session-a"));
	assert.deepEqual(resolution, { kind: "explicit", name: "team", modelProfiles: { worker: { model: "openai/gpt-5" } } });
	assert.equal(sessionProfileLabel(resolution), "team (session)");
});

test("follow mode re-resolves p → P → G on every call and never freezes", () => {
	const f = fixture();
	const env = { [PROFILE_FOLLOW_ENV]: "1" };
	f.pinLocal("frontier");
	freezeSessionProfileAtStartup(options(f, "session-a", env));
	assert.equal(readFrozenInheritedProfile("session-a"), undefined);
	assert.equal(resolveSessionProfile(options(f, "session-a", env)).kind, "follow");
	assert.deepEqual(sessionProfileModelProfiles(resolveSessionProfile(options(f, "session-a", env))), FRONTIER);
	f.pinLocal("local");
	assert.deepEqual(sessionProfileModelProfiles(resolveSessionProfile(options(f, "session-a", env))), LOCAL);
	assert.equal(readFrozenInheritedProfile("session-a"), undefined);
});

test("Enter in follow mode makes the binding explicit: later defaults no longer apply", () => {
	const f = fixture();
	const env = { [PROFILE_FOLLOW_ENV]: "1" };
	f.pinLocal("frontier");
	bindSessionProfile("session-a", "team", { worker: { model: "openai/gpt-5" } });
	f.pinLocal("local");
	const resolution = resolveSessionProfile(options(f, "session-a", env));
	assert.equal(resolution.kind, "explicit");
	assert.deepEqual(sessionProfileModelProfiles(resolution), { worker: { model: "openai/gpt-5" } });
});

test("profileFollowEnabled accepts only GENTLE_PI_PROFILE_FOLLOW=1", () => {
	assert.equal(PROFILE_FOLLOW_ENV, "GENTLE_PI_PROFILE_FOLLOW");
	assert.equal(profileFollowEnabled({ GENTLE_PI_PROFILE_FOLLOW: "1" }), true);
	assert.equal(profileFollowEnabled({ GENTLE_PI_PROFILE_FOLLOW: "0" }), false);
	assert.equal(profileFollowEnabled({ GENTLE_PI_PROFILE_FOLLOW: "" }), false);
	assert.equal(profileFollowEnabled({}), false);
});

test("subagent children never freeze: they resolve live", () => {
	const f = fixture();
	const env = { GENTLE_PI_AGENTS_CHILD: "1" };
	f.pinLocal("frontier");
	freezeSessionProfileAtStartup(options(f, "child-a", env));
	assert.equal(readFrozenInheritedProfile("child-a"), undefined);
	const resolution = resolveSessionProfile(options(f, "child-a", env));
	assert.equal(resolution.kind, "live");
	assert.equal(readFrozenInheritedProfile("child-a"), undefined);
	f.pinLocal("local");
	assert.deepEqual(sessionProfileModelProfiles(resolveSessionProfile(options(f, "child-a", env))), LOCAL);
});

test("without a session id the resolution is live and nothing is frozen", () => {
	const f = fixture();
	f.pinLocal("frontier");
	const resolution = resolveSessionProfile(options(f, undefined));
	assert.equal(resolution.kind, "live");
	assert.deepEqual(sessionProfileModelProfiles(resolution), FRONTIER);
});

test("labels keep today's spelling: (session), (local), (repo), bare global name", () => {
	const f = fixture();
	f.pinLocal("frontier");
	assert.equal(sessionProfileLabel(resolveSessionProfile(options(f, "s-local"))), "frontier (local)");
	f.pinLocal(undefined);
	f.declareRepo("team");
	assert.equal(sessionProfileLabel(resolveSessionProfile(options(f, "s-repo"))), "team (repo)");
	f.declareRepo(undefined);
	f.setActive("local");
	assert.equal(sessionProfileLabel(resolveSessionProfile(options(f, "s-global"))), "local");
});

test("drift notice: shown once per distinct change of the defaults", () => {
	const f = fixture();
	f.pinLocal("frontier");
	const opts = options(f, "session-a");
	freezeSessionProfileAtStartup(opts);
	assert.equal(inheritedProfileDriftNotice(opts), undefined, "no drift while the defaults match");
	f.pinLocal("local");
	assert.equal(
		inheritedProfileDriftNotice(opts),
		'el Gentleman: the default profile changed to "local" (local), this session keeps "frontier" (local). Press Enter on a profile in /gentle:profiles to adopt it.',
	);
	assert.equal(inheritedProfileDriftNotice(opts), undefined, "the same change is not repeated");
	f.pinLocal(undefined);
	f.setActive("team");
	assert.equal(
		inheritedProfileDriftNotice(opts),
		'el Gentleman: the default profile changed to "team" (global), this session keeps "frontier" (local). Press Enter on a profile in /gentle:profiles to adopt it.',
	);
	assert.equal(inheritedProfileDriftNotice(opts), undefined);
	assert.equal(readFrozenInheritedProfile("session-a")?.profile?.name, "frontier", "the notice never adopts the new default");
});

test("drift notice: an edit of the default profile's content counts as a change", () => {
	const f = fixture();
	f.setActive("frontier");
	const opts = options(f, "session-a");
	freezeSessionProfileAtStartup(opts);
	f.editProfile("frontier", LOCAL);
	assert.match(inheritedProfileDriftNotice(opts) ?? "", /changed to "frontier" \(global\), this session keeps "frontier" \(global\)/);
});

test("drift notice: memory is per session", () => {
	const f = fixture();
	f.pinLocal("frontier");
	freezeSessionProfileAtStartup(options(f, "session-a"));
	freezeSessionProfileAtStartup(options(f, "session-b"));
	f.pinLocal("local");
	assert.notEqual(inheritedProfileDriftNotice(options(f, "session-a")), undefined);
	assert.notEqual(inheritedProfileDriftNotice(options(f, "session-b")), undefined);
});

test("drift notice covers a session frozen without a profile and a default that disappears", () => {
	const f = fixture();
	const none = options(f, "session-none");
	freezeSessionProfileAtStartup(none);
	f.pinLocal("frontier");
	assert.equal(
		inheritedProfileDriftNotice(none),
		'el Gentleman: the default profile changed to "frontier" (local), this session keeps no profile. Press Enter on a profile in /gentle:profiles to adopt it.',
	);
	const kept = options(f, "session-kept");
	freezeSessionProfileAtStartup(kept);
	f.pinLocal(undefined);
	assert.equal(
		inheritedProfileDriftNotice(kept),
		'el Gentleman: the default profile changed to no profile, this session keeps "frontier" (local). Press Enter on a profile in /gentle:profiles to adopt it.',
	);
});

test("drift notice is never shown after an explicit Enter, in follow mode, or in a child", () => {
	const f = fixture();
	f.pinLocal("frontier");
	const explicit = options(f, "session-explicit");
	freezeSessionProfileAtStartup(explicit);
	bindSessionProfile("session-explicit", "team", TEAM);
	const follow = options(f, "session-follow", { [PROFILE_FOLLOW_ENV]: "1" });
	const child = options(f, "session-child", { GENTLE_PI_AGENTS_CHILD: "1" });
	f.pinLocal("local");
	assert.equal(inheritedProfileDriftNotice(explicit), undefined);
	assert.equal(inheritedProfileDriftNotice(follow), undefined);
	assert.equal(inheritedProfileDriftNotice(child), undefined);
});

test("drift comparison on a session not frozen yet freezes the current default and reports nothing", () => {
	const f = fixture();
	f.pinLocal("frontier");
	assert.equal(inheritedProfileDriftNotice(options(f, "session-a")), undefined);
	assert.equal(readFrozenInheritedProfile("session-a")?.profile?.name, "frontier");
});

test("sessionProfileRoutingAt: explicit and frozen profiles apply to any target, a foreign repository included", () => {
	const session = fixture();
	session.pinLocal("frontier");
	const foreign = fixture();
	foreign.pinLocal("local");
	const target = { cwd: foreign.cwd, configHome: foreign.configHome, resolveWorktree: foreign.resolveWorktree, foreignRepository: true };
	assert.deepEqual(sessionProfileRoutingAt(resolveSessionProfile(options(session, "session-a")), target), FRONTIER);
	bindSessionProfile("session-b", "team", TEAM);
	assert.deepEqual(sessionProfileRoutingAt(resolveSessionProfile(options(session, "session-b")), target), TEAM);
});

test("sessionProfileRoutingAt: a session frozen without a profile keeps a foreign repository's own defaults", () => {
	const session = fixture();
	const foreign = fixture();
	foreign.pinLocal("local");
	const resolution = resolveSessionProfile(options(session, "session-a"));
	session.pinLocal("frontier");
	assert.deepEqual(sessionProfileRoutingAt(resolution, { cwd: foreign.cwd, configHome: foreign.configHome, resolveWorktree: foreign.resolveWorktree, foreignRepository: true }), LOCAL);
	assert.equal(sessionProfileRoutingAt(resolution, { cwd: session.cwd, configHome: session.configHome, resolveWorktree: session.resolveWorktree }), undefined, "its own clone keeps no profile");
});

test("sessionProfileRoutingAt: a session frozen without a profile never picks up the global active profile in a foreign repository", () => {
	const session = fixture();
	const resolution = resolveSessionProfile(options(session, "session-a"));
	const foreign = fixture();
	foreign.setActive("team");
	assert.equal(sessionProfileRoutingAt(resolution, { cwd: foreign.cwd, configHome: foreign.configHome, resolveWorktree: foreign.resolveWorktree, foreignRepository: true }), undefined);
	foreign.declareRepo("local");
	assert.deepEqual(sessionProfileRoutingAt(resolution, { cwd: foreign.cwd, configHome: foreign.configHome, resolveWorktree: foreign.resolveWorktree, foreignRepository: true }), LOCAL, "the foreign repository's own declaration still applies");
});

test("sessionProfileRoutingAt: follow reads the defaults of the target", () => {
	const session = fixture();
	session.pinLocal("frontier");
	const other = fixture();
	other.pinLocal("local");
	const resolution = resolveSessionProfile(options(session, "session-a", { [PROFILE_FOLLOW_ENV]: "1" }));
	assert.deepEqual(sessionProfileRoutingAt(resolution, { cwd: other.cwd, configHome: other.configHome, resolveWorktree: other.resolveWorktree }), LOCAL);
});
