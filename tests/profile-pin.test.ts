import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createProfile, emptyProfilesFile, profilesFilePath, writeProfilesFileSync } from "../lib/agent-profiles.ts";
import {
	PROFILE_PIN_KIND,
	PROFILE_PIN_VERSION,
	REPO_PROFILE_DECLARATION_GITIGNORE_RULES,
	clearProfilePinSync,
	evaluateProfilePin,
	localProfilePinPath,
	normalizeProfilePin,
	parseProfilePinText,
	readProfilePin,
	readProfilePinResult,
	readProfilePinStatus,
	repoProfileDeclarationPath,
	resolveProfilePin,
	serializeProfilePin,
	setProfilePinWorktreeResolverForTesting,
	writeProfilePinSync,
} from "../lib/agent-profile-pin.ts";
import type { AgentModelConfig } from "../lib/model-routing-authority.ts";
import type { WorktreeIdentity } from "../lib/session-worktree-registry.ts";

// Per-repository agent-model profile pins: two layers holding only a profile name,
// resolved at launch against the global profiles store. These tests never touch
// Git; the worktree identity is injected, which is also how the launch path binds
// the pin to the repository the child will work in.

const root = mkdtempSync(join(tmpdir(), "gentle-pi-profile-pin-"));
after(() => rmSync(root, { recursive: true, force: true }));

function identityAt(name: string): WorktreeIdentity {
	return { root: join(root, name, "worktree"), commonDir: join(root, name, "git-common") };
}

function storeAt(configHome: string, profiles: Record<string, AgentModelConfig>): void {
	const file = Object.entries(profiles).reduce(
		(current, [name, config]) => createProfile(current, name, config),
		emptyProfilesFile(),
	);
	writeProfilesFileSync(profilesFilePath(configHome), file);
}

test("pin paths follow the shared clone and the worktree", () => {
	assert.equal(localProfilePinPath("/clone/.git"), join("/clone/.git", "gentle-ai", "profile-pin.json"));
	assert.equal(repoProfileDeclarationPath("/clone"), join("/clone", ".pi", "gentle-ai", "profile.json"));
});

test("the suggested ignore rules expose only the repository declaration", () => {
	const repo = join(root, "ignored-declaration");
	mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "--quiet", repo]);
	writeFileSync(join(repo, ".gitignore"), ".pi/\n");
	writeProfilePinSync(repoProfileDeclarationPath(repo), "team");
	writeFileSync(join(repo, ".pi", "gentle-ai", "private.json"), "private\n");
	writeFileSync(join(repo, ".pi", "other.json"), "other\n");
	writeFileSync(
		join(repo, ".gitignore"),
		`.pi/\n${REPO_PROFILE_DECLARATION_GITIGNORE_RULES.join("\n")}\n`,
	);
	const visible = execFileSync(
		"git",
		["-C", repo, "ls-files", "--others", "--exclude-standard", "--", ".pi"],
		{ encoding: "utf8" },
	).trim().split(/\r?\n/).filter(Boolean);
	assert.deepEqual(visible, [".pi/gentle-ai/profile.json"]);
});

test("the pin artifact is byte-identical for the same profile", () => {
	const text = serializeProfilePin("deep-work");
	assert.equal(
		text,
		[
			"{",
			`  "kind": "${PROFILE_PIN_KIND}",`,
			`  "version": ${PROFILE_PIN_VERSION},`,
			'  "profile": "deep-work"',
			"}",
			"",
		].join("\n"),
	);
	assert.equal(serializeProfilePin("deep-work"), text, "stable key order and indentation");
	assert.deepEqual(parseProfilePinText(text), { status: "valid", profile: "deep-work" });
});

test("the pin parser rejects foreign kinds, versions, names, and malformed input", () => {
	const invalid = [
		"{",
		"[]",
		"null",
		'"deep-work"',
		JSON.stringify({ kind: "gentle-pi.agent_model_profiles", version: 1, profile: "deep-work" }),
		JSON.stringify({ kind: PROFILE_PIN_KIND, version: 2, profile: "deep-work" }),
		JSON.stringify({ kind: PROFILE_PIN_KIND, version: 1 }),
		JSON.stringify({ kind: PROFILE_PIN_KIND, version: 1, profile: "not a name" }),
		JSON.stringify({ kind: PROFILE_PIN_KIND, version: 1, profile: "__proto__" }),
		JSON.stringify({ kind: PROFILE_PIN_KIND, version: 1, profile: "" }),
	];
	for (const text of invalid) assert.deepEqual(parseProfilePinText(text), { status: "invalid" }, text);
});

test("writeProfilePinSync creates parents, round-trips, and leaves no temp file behind", () => {
	const path = join(root, "write", "gentle-ai", "profile-pin.json");
	writeProfilePinSync(path, "deep-work");
	assert.equal(readFileSync(path, "utf8"), serializeProfilePin("deep-work"));
	assert.equal(readProfilePin(path), "deep-work");
	writeProfilePinSync(path, "team");
	assert.equal(readProfilePin(path), "team");
	assert.deepEqual(readdirSync(join(root, "write", "gentle-ai")).filter((entry) => entry.includes(".tmp")), []);
	assert.equal(readProfilePin(join(root, "write", "absent.json")), undefined);
});

test("an invalid pin file reads as no pin, and an illegal name is refused before writing", () => {
	const dir = join(root, "invalid");
	mkdirSync(dir, { recursive: true });
	const malformed = join(dir, "profile-pin.json");
	writeFileSync(malformed, "{ not json\n");
	assert.equal(readProfilePin(malformed), undefined);
	writeFileSync(malformed, JSON.stringify({ kind: PROFILE_PIN_KIND, version: 1, profile: "bad name" }));
	assert.equal(readProfilePin(malformed), undefined);
	const refused = join(dir, "refused.json");
	assert.throws(() => writeProfilePinSync(refused, "bad name"), /Invalid profile name/);
	assert.equal(existsSync(refused), false);
});

test("readProfilePinStatus reads both layers and reports nothing outside a Git worktree", () => {
	const identity = identityAt("status");
	// A local pin alone: the declaration is still reported as absent rather than
	// inferred from the layer that won.
	mkdirSync(identity.commonDir, { recursive: true });
	writeProfilePinSync(localProfilePinPath(identity.commonDir), "team");
	const status = readProfilePinStatus(identity.root, () => identity);
	assert.ok(status);
	assert.equal(status.root, identity.root);
	assert.equal(status.commonDir, identity.commonDir);
	assert.equal(status.localPath, localProfilePinPath(identity.commonDir));
	assert.equal(status.repoPath, repoProfileDeclarationPath(identity.root));
	assert.deepEqual(status.local, { status: "valid", profile: "team" });
	assert.deepEqual(status.repo, { status: "missing" });
	assert.equal(readProfilePinStatus(identity.root, () => undefined), undefined);
	assert.equal(
		readProfilePinStatus(identity.root, () => {
			throw new Error("git is unavailable");
		}),
		undefined,
		"a failing resolver reads as no pin instead of failing the panel",
	);
});

test("an ambient Git identity miss is retried after the directory becomes a repository", () => {
	const repo = join(root, "late-git-init");
	mkdirSync(repo, { recursive: true });
	assert.equal(readProfilePinStatus(repo), undefined);
	execFileSync("git", ["init", "--quiet", repo]);
	const status = readProfilePinStatus(repo);
	assert.ok(status, "a prior miss must not hide a Git identity that appeared later");
	assert.equal(status.repoPath, repoProfileDeclarationPath(status.root));
});

test("an ambient Git identity is resolved again after the repository identity changes", () => {
	const cwd = join(root, "replaced-repository");
	const before = identityAt("replaced-before");
	const afterReplacement = identityAt("replaced-after");
	let calls = 0;
	setProfilePinWorktreeResolverForTesting(() => {
		calls += 1;
		return calls === 1 ? before : afterReplacement;
	});
	try {
		assert.equal(readProfilePinStatus(cwd)?.root, before.root);
		assert.equal(readProfilePinStatus(cwd)?.root, afterReplacement.root);
		assert.equal(calls, 2, "each status read observes the repository identity that exists now");
	} finally {
		setProfilePinWorktreeResolverForTesting();
	}
});

test("resolveProfilePin prefers the local pin and returns role entries without the orchestrator", () => {
	const identity = identityAt("precedence");
	const configHome = join(root, "precedence", "config");
	storeAt(configHome, {
		"local-choice": {
			orchestrator: { model: "nan/glm5.3" },
			explore: { model: "openai/alpha", thinking: "minimal" },
		},
		"declared-choice": { explore: { model: "openai/beta" } },
	});
	writeProfilePinSync(localProfilePinPath(identity.commonDir), "local-choice");
	writeProfilePinSync(repoProfileDeclarationPath(identity.root), "declared-choice");
	const resolved = resolveProfilePin({ cwd: identity.root, configHome, resolveWorktree: () => identity });
	assert.ok(resolved);
	assert.equal(resolved.source, "local");
	assert.equal(resolved.profile, "local-choice");
	assert.equal(resolved.path, localProfilePinPath(identity.commonDir));
	assert.deepEqual(resolved.modelProfiles, { explore: { model: "openai/alpha", thinking: "minimal" } });
	assert.equal("orchestrator" in resolved.modelProfiles, false, "the orchestrator is not subagent routing");
});

test("resolveProfilePin falls back to the repository declaration", () => {
	const identity = identityAt("declaration");
	const configHome = join(root, "declaration", "config");
	storeAt(configHome, { declared: { explore: { model: "openai/beta" } } });
	writeProfilePinSync(repoProfileDeclarationPath(identity.root), "declared");
	const resolved = resolveProfilePin({ cwd: identity.root, configHome, resolveWorktree: () => identity });
	assert.ok(resolved);
	assert.equal(resolved.source, "repo");
	assert.equal(resolved.profile, "declared");
	assert.equal(resolved.path, repoProfileDeclarationPath(identity.root));
	assert.deepEqual(resolved.modelProfiles, { explore: { model: "openai/beta", thinking: undefined } });
});

test("a stale or invalid local layer does not mask a usable repository declaration", () => {
	const identity = identityAt("stale");
	const configHome = join(root, "stale", "config");
	storeAt(configHome, { declared: { explore: { model: "openai/beta" } } });
	writeProfilePinSync(repoProfileDeclarationPath(identity.root), "declared");
	// The local pin names a profile the store no longer defines, which must degrade
	// to the next layer instead of failing every launch in the clone.
	writeProfilePinSync(localProfilePinPath(identity.commonDir), "deleted-profile");
	assert.equal(
		resolveProfilePin({ cwd: identity.root, configHome, resolveWorktree: () => identity })?.profile,
		"declared",
	);
	writeFileSync(localProfilePinPath(identity.commonDir), "{ not json\n");
	assert.equal(
		resolveProfilePin({ cwd: identity.root, configHome, resolveWorktree: () => identity })?.profile,
		"declared",
	);
});

test("with no usable layer and no readable store, resolveProfilePin reports no pin", () => {
	const identity = identityAt("absent");
	const configHome = join(root, "absent", "config");
	storeAt(configHome, { team: { explore: { model: "openai/alpha" } } });
	// No pin file at all: today's global routing, and the store is not even read.
	assert.equal(resolveProfilePin({ cwd: identity.root, configHome, resolveWorktree: () => identity }), undefined);
	writeProfilePinSync(repoProfileDeclarationPath(identity.root), "team");
	// A store that was deleted or corrupted leaves the pin unresolvable; the launch
	// keeps the global routing instead of throwing.
	const missingStore = join(root, "absent", "missing-config");
	assert.equal(
		resolveProfilePin({ cwd: identity.root, configHome: missingStore, resolveWorktree: () => identity }),
		undefined,
	);
	const invalidStore = join(root, "absent", "invalid-config");
	mkdirSync(invalidStore, { recursive: true });
	writeFileSync(profilesFilePath(invalidStore), "{ not json\n");
	assert.equal(
		resolveProfilePin({ cwd: identity.root, configHome: invalidStore, resolveWorktree: () => identity }),
		undefined,
	);
	// A session outside every Git worktree can never carry a pin.
	assert.equal(resolveProfilePin({ cwd: identity.root, configHome, resolveWorktree: () => undefined }), undefined);
});

test("the read result separates a missing pin from a file that is not a pin", () => {
	const dir = join(root, "read-result");
	mkdirSync(dir, { recursive: true });
	const missing = join(dir, "missing.json");
	assert.deepEqual(readProfilePinResult(missing), { status: "missing" });
	const invalid = join(dir, "invalid.json");
	writeFileSync(invalid, "{ not json\n");
	assert.deepEqual(readProfilePinResult(invalid), { status: "invalid" });
	const valid = join(dir, "valid.json");
	writeProfilePinSync(valid, "team");
	assert.deepEqual(readProfilePinResult(valid), { status: "valid", profile: "team" });
});

test("clearProfilePinSync removes a pin and tolerates an already-missing file", () => {
	const path = join(root, "clear", "gentle-ai", "profile-pin.json");
	writeProfilePinSync(path, "team");
	clearProfilePinSync(path);
	assert.equal(existsSync(path), false);
	assert.doesNotThrow(() => clearProfilePinSync(path), "clearing a missing pin is already the desired state");
});

test("evaluateProfilePin reports the winner, invalid files by path, and stale names without hiding a lower layer", () => {
	const identity = identityAt("evaluate");
	mkdirSync(identity.commonDir, { recursive: true });
	// No layers at all: nothing wins and nothing is reported.
	assert.deepEqual(evaluateProfilePin(readProfilePinStatus(identity.root, () => identity), { team: {} }), { invalid: [], stale: [] });
	// A stale local layer is reported AND does not mask a usable declaration.
	writeProfilePinSync(localProfilePinPath(identity.commonDir), "deleted-profile");
	writeProfilePinSync(repoProfileDeclarationPath(identity.root), "declared");
	const evaluation = evaluateProfilePin(readProfilePinStatus(identity.root, () => identity), { declared: {} });
	assert.deepEqual(evaluation.winner, {
		source: "repo",
		profile: "declared",
		path: repoProfileDeclarationPath(identity.root),
	});
	assert.deepEqual(evaluation.stale, [{
		source: "local",
		profile: "deleted-profile",
		path: localProfilePinPath(identity.commonDir),
	}]);
	// A file that is not a pin is reported by its exact path, separately from a stale
	// name, and still does not mask the declaration below it.
	writeFileSync(localProfilePinPath(identity.commonDir), "{ not json\n");
	const invalid = evaluateProfilePin(readProfilePinStatus(identity.root, () => identity), { declared: {} });
	assert.deepEqual(invalid.invalid, [{ source: "local", path: localProfilePinPath(identity.commonDir) }]);
	assert.deepEqual(invalid.winner, {
		source: "repo",
		profile: "declared",
		path: repoProfileDeclarationPath(identity.root),
	});
});

test("resolveProfilePin carries both read layers and the invalid and stale reports", () => {
	const identity = identityAt("carry");
	const configHome = join(root, "carry", "config");
	storeAt(configHome, { declared: { explore: { model: "openai/beta" } } });
	writeProfilePinSync(repoProfileDeclarationPath(identity.root), "declared");
	// Create the local layer as a real pin first, then corrupt it, so the parent
	// directory exists without depending on any other helper.
	writeProfilePinSync(localProfilePinPath(identity.commonDir), "deleted-profile");
	writeFileSync(localProfilePinPath(identity.commonDir), "{ not json\n");
	const resolved = resolveProfilePin({ cwd: identity.root, configHome, resolveWorktree: () => identity });
	assert.ok(resolved);
	assert.equal(resolved.profile, "declared");
	assert.deepEqual(resolved.status.local, { status: "invalid" });
	assert.deepEqual(resolved.status.repo, { status: "valid", profile: "declared" });
	assert.deepEqual(resolved.invalidLayers, [{ source: "local", path: localProfilePinPath(identity.commonDir) }]);
	assert.deepEqual(resolved.staleLayers, []);
});

test("two worktrees of one clone read the same clone-local pin but keep their own declaration", () => {
	const commonDir = join(root, "shared", "git-common");
	const firstWorktree = join(root, "shared", "worktree-a");
	const secondWorktree = join(root, "shared", "worktree-b");
	writeProfilePinSync(localProfilePinPath(commonDir), "team");
	const first = readProfilePinStatus(firstWorktree, () => ({ root: firstWorktree, commonDir }));
	const second = readProfilePinStatus(secondWorktree, () => ({ root: secondWorktree, commonDir }));
	assert.deepEqual(first?.local, { status: "valid", profile: "team" });
	assert.deepEqual(second?.local, { status: "valid", profile: "team" }, "the local pin lives in the shared Git common directory");
	assert.deepEqual(second?.repo, { status: "missing" }, "the declaration is per worktree, not shared with the sibling");
});

test("each status read resolves the current worktree identity and injected resolvers stay isolated", () => {
	let calls = 0;
	const injected = identityAt("memo-injected");
	setProfilePinWorktreeResolverForTesting((cwd) => {
		calls += 1;
		return { root: join(cwd, "worktree"), commonDir: join(cwd, "git-common") };
	});
	try {
		readProfilePinStatus(join(root, "memo-a"));
		readProfilePinStatus(join(root, "memo-a"));
		assert.equal(calls, 2, "each status read resolves the identity that exists now");
		readProfilePinStatus(join(root, "memo-b"));
		assert.equal(calls, 3, "a second directory resolves its own identity");
		// A resolver injected per call remains independent from the ambient seam.
		readProfilePinStatus(join(root, "memo-a"), () => injected);
		assert.equal(calls, 3, "the injected resolver does not touch the ambient resolver");
	} finally {
		setProfilePinWorktreeResolverForTesting();
	}
});

test("normalizeProfilePin accepts only a value-level pin this version writes", () => {
	assert.equal(normalizeProfilePin({ kind: PROFILE_PIN_KIND, version: PROFILE_PIN_VERSION, profile: "deep-work" }), "deep-work");
	assert.equal(normalizeProfilePin({ kind: PROFILE_PIN_KIND, version: 2, profile: "deep-work" }), undefined);
	assert.equal(normalizeProfilePin({ kind: "other", version: PROFILE_PIN_VERSION, profile: "deep-work" }), undefined);
	assert.equal(normalizeProfilePin({ kind: PROFILE_PIN_KIND, version: PROFILE_PIN_VERSION, profile: "bad name" }), undefined);
	assert.equal(normalizeProfilePin("deep-work"), undefined);
});
