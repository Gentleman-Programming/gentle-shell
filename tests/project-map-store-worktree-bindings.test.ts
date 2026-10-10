import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	bindProjectMapStoreWorktree,
	listProjectMapStoreWorktreeBindings,
	readProjectMapStoreWorktreeBinding,
} from "../lib/project-map-store-worktrees.ts";
import { initializeProjectMapStore } from "../lib/project-map-store.ts";
import {
	PROJECT_MAP_STORE_DIAGNOSTIC_CODES,
	serializeProjectMapStoreValue,
	type ProjectMapStoreWorktreeBindingV1,
} from "../lib/project-map-store-schema.ts";

const REPOSITORY_ID = `sha256:${"a".repeat(64)}`;
const EPOCH = "123e4567-e89b-12d3-a456-426614174000";
const NOW = "2026-09-25T12:00:00.000Z";
const BASE_COMMIT = "a".repeat(40);
const OTHER_BASE_COMMIT = "b".repeat(64);

function bindingPath(root: string, capabilityId: string): string {
	return join(root, "worktrees", `${createHash("sha256").update(capabilityId).digest("hex")}.json`);
}

function withRoot(run: (root: string, sandbox: string) => void): void {
	const sandbox = mkdtempSync(join(tmpdir(), "project-map-store-worktree-bindings-"));
	const root = join(sandbox, "isolated", "project-map", "store");
	mkdirSync(root, { recursive: true });
	try {
		run(root, sandbox);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
}

function initialize(root: string): void {
	const result = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: NOW });
	assert.ok(result.descriptor, result.diagnostics.map((entry) => entry.message).join("\n"));
	assert.deepEqual(result.diagnostics, []);
}

function bind(root: string, overrides: Partial<Parameters<typeof bindProjectMapStoreWorktree>[0]> = {}) {
	return bindProjectMapStoreWorktree({
		root,
		capabilityId: "project-map",
		branch: "feat/project-map",
		worktreeRoot: "/workspace/project-map-worktrees/project-map",
		sessionId: "session-a",
		baseCommit: BASE_COMMIT,
		now: NOW,
		...overrides,
	});
}

function codes(result: { diagnostics: { code: string }[] }): string[] {
	return result.diagnostics.map((entry) => entry.code);
}

function binding(capabilityId = "project-map", overrides: Partial<ProjectMapStoreWorktreeBindingV1> = {}): ProjectMapStoreWorktreeBindingV1 {
	return {
		schema: "gentle-shell.project-map-store/v1",
		kind: "worktree-binding",
		capability_id: capabilityId,
		branch: "feat/project-map",
		worktree_root: "/workspace/project-map-worktrees/project-map",
		session_id: "session-a",
		base_commit: BASE_COMMIT,
		created_at: NOW,
		...overrides,
	};
}

function inventory(root: string): { exists: boolean; entries: string[] } {
	const exists = existsSync(root);
	if (!exists) return { exists, entries: [] };
	const entries: string[] = [];
	const visit = (directory: string, relative: string): void => {
		for (const entry of readdirSync(directory).sort()) {
			const path = join(directory, entry);
			const entryRelative = join(relative, entry);
			const stat = lstatSync(path);
			const type = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other";
			entries.push(`${entryRelative}:${type}`);
			if (stat.isDirectory()) visit(path, entryRelative);
		}
	};
	visit(root, "");
	return { exists, entries };
}

function fileIdentity(path: string): { ino: number; mtimeMs: number } {
	const stat = statSync(path);
	return { ino: stat.ino, mtimeMs: stat.mtimeMs };
}

test("writes and reads a worktree binding in canonical form", () => {
	withRoot((root) => {
		initialize(root);
		const written = bind(root);
		assert.deepEqual(written.diagnostics, []);
		assert.deepEqual(written.binding, binding());
		assert.equal(readFileSync(bindingPath(root, "project-map"), "utf8"), serializeProjectMapStoreValue("worktree-binding", binding()).record);
		const read = readProjectMapStoreWorktreeBinding({ root, capabilityId: "project-map" });
		assert.equal(read.status, "bound");
		assert.deepEqual(read.binding, binding());
		assert.deepEqual(read.diagnostics, []);
	});
});

test("treats an identical worktree bind as an idempotent no-op", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(bind(root).binding);
		const path = bindingPath(root, "project-map");
		const before = readFileSync(path, "utf8");
		const beforeIdentity = fileIdentity(path);
		const repeated = bind(root);
		assert.deepEqual(repeated.binding, binding());
		assert.deepEqual(repeated.diagnostics, []);
		assert.equal(readFileSync(path, "utf8"), before);
		assert.deepEqual(fileIdentity(path), beforeIdentity);
	});
});

test("treats a later identical worktree bind as an idempotent no-op", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(bind(root).binding);
		const path = bindingPath(root, "project-map");
		const before = readFileSync(path, "utf8");
		const beforeIdentity = fileIdentity(path);
		const repeated = bind(root, { now: "2026-09-25T12:01:00.000Z" });
		assert.deepEqual(repeated.binding, binding());
		assert.deepEqual(repeated.diagnostics, []);
		assert.equal(readFileSync(path, "utf8"), before);
		assert.deepEqual(fileIdentity(path), beforeIdentity);
	});
});

test("refuses every conflicting worktree bind and preserves the first record bytes", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(bind(root).binding);
		const path = bindingPath(root, "project-map");
		const before = readFileSync(path, "utf8");
		for (const overrides of [
			{ branch: "feat/other-capability" },
			{ worktreeRoot: "/workspace/project-map-worktrees/other" },
			{ sessionId: "session-b" },
			{ baseCommit: OTHER_BASE_COMMIT },
		]) {
			const refused = bind(root, overrides);
			assert.equal(refused.binding, null);
			assert.deepEqual(codes(refused), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.WORKTREE_ALREADY_BOUND]);
			assert.equal(readFileSync(path, "utf8"), before);
		}
	});
});

test("classifies malformed, non-canonical, and mismatched worktree records as corrupted", () => {
	withRoot((root) => {
		initialize(root);
		const path = bindingPath(root, "project-map");
		mkdirSync(join(root, "worktrees"));
		writeFileSync(path, "{ not json", "utf8");
		const malformed = readProjectMapStoreWorktreeBinding({ root, capabilityId: "project-map" });
		assert.equal(malformed.status, "corrupted");
		assert.equal(malformed.binding, null);
		assert.ok(malformed.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED));
		writeFileSync(path, JSON.stringify(binding()), "utf8");
		const nonCanonical = readProjectMapStoreWorktreeBinding({ root, capabilityId: "project-map" });
		assert.equal(nonCanonical.status, "corrupted");
		assert.equal(nonCanonical.binding, null);
		assert.ok(nonCanonical.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED));
		writeFileSync(path, serializeProjectMapStoreValue("worktree-binding", binding("other-capability")).record!, "utf8");
		const mismatched = readProjectMapStoreWorktreeBinding({ root, capabilityId: "project-map" });
		assert.equal(mismatched.status, "corrupted");
		assert.equal(mismatched.binding, null);
		assert.ok(mismatched.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED && entry.path === "$.capability_id"));
	});
});

test("lists valid worktree bindings sorted by capability and reports corrupt entries", () => {
	withRoot((root) => {
		initialize(root);
		assert.ok(bind(root, { capabilityId: "zebra", branch: "feat/zebra", worktreeRoot: "/workspace/zebra" }).binding);
		assert.ok(bind(root, { capabilityId: "alpha", branch: "feat/alpha", worktreeRoot: "/workspace/alpha" }).binding);
		writeFileSync(join(root, "worktrees", "broken.json"), JSON.stringify(binding("broken")), "utf8");
		const listed = listProjectMapStoreWorktreeBindings({ root });
		assert.deepEqual(listed.bindings, [
			binding("alpha", { branch: "feat/alpha", worktree_root: "/workspace/alpha" }),
			binding("zebra", { branch: "feat/zebra", worktree_root: "/workspace/zebra" }),
		]);
		assert.deepEqual(listed.diagnostics.map((entry) => entry.code), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED]);
		assert.match(listed.diagnostics[0].message, /broken\.json/);
	});
});

test("refuses an uninitialized store without creating worktree evidence", () => {
	withRoot((root, sandbox) => {
		rmSync(root, { recursive: true, force: true });
		const before = inventory(sandbox);
		const refused = bind(root);
		assert.equal(refused.binding, null);
		assert.deepEqual(codes(refused), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);
		assert.deepEqual(inventory(sandbox), before);
	});
});

test("refuses an invalid bind instant without creating sandbox evidence", () => {
	withRoot((root, sandbox) => {
		initialize(root);
		const before = inventory(sandbox);
		const refused = bind(root, { now: "not-an-instant" });
		assert.equal(refused.binding, null);
		assert.ok(refused.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD));
		assert.equal(existsSync(join(root, "worktrees")), false);
		assert.deepEqual(inventory(sandbox), before);
	});
});

test("refuses invalid bind fields without creating sandbox evidence", () => {
	withRoot((root, sandbox) => {
		initialize(root);
		for (const overrides of [
			{ branch: "main" },
			{ worktreeRoot: "relative/worktree" },
			{ baseCommit: "a".repeat(39) },
		]) {
			const before = inventory(sandbox);
			const refused = bind(root, overrides);
			assert.equal(refused.binding, null);
			assert.ok(refused.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.INVALID_FIELD));
			assert.equal(existsSync(join(root, "worktrees")), false);
			assert.deepEqual(inventory(sandbox), before);
		}
	});
});

test("reads free and bound worktree bindings without a store descriptor", () => {
	withRoot((root) => {
		const free = readProjectMapStoreWorktreeBinding({ root, capabilityId: "project-map" });
		assert.equal(free.status, "free");
		assert.equal(free.binding, null);
		assert.deepEqual(free.diagnostics, []);
		mkdirSync(join(root, "worktrees"));
		writeFileSync(bindingPath(root, "project-map"), serializeProjectMapStoreValue("worktree-binding", binding()).record!, "utf8");
		const bound = readProjectMapStoreWorktreeBinding({ root, capabilityId: "project-map" });
		assert.equal(bound.status, "bound");
		assert.deepEqual(bound.binding, binding());
		assert.deepEqual(bound.diagnostics, []);
	});
});

test("releases the store lock when binding refuses an unreadable target", () => {
	withRoot((root) => {
		initialize(root);
		writeFileSync(join(root, "worktrees"), "not a directory", "utf8");
		const refused = bind(root);
		assert.equal(refused.binding, null);
		assert.ok(refused.diagnostics.some((entry) => entry.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE));
		assert.equal(existsSync(bindingPath(root, "project-map")), false);
		assert.equal(existsSync(join(root, "store.lock")), false);
	});
});

test("releases the store lock when binding record writing fails", (t) => {
	if (process.getuid?.() === 0) {
		t.skip("permission bits do not block here");
		return;
	}
	withRoot((root) => {
		initialize(root);
		const worktrees = join(root, "worktrees");
		mkdirSync(worktrees);
		chmodSync(worktrees, 0o555);
		try {
			const refused = bind(root);
			assert.equal(refused.binding, null);
			assert.deepEqual(codes(refused), [PROJECT_MAP_STORE_DIAGNOSTIC_CODES.UNREADABLE_STORE]);
			assert.equal(refused.diagnostics[0]?.message, "Worktree binding record could not be written.");
			assert.equal(existsSync(bindingPath(root, "project-map")), false);
			assert.equal(existsSync(join(root, "store.lock")), false);
		} finally {
			chmodSync(worktrees, 0o700);
		}
	});
});

test("hashes adversarial capability ids into the worktrees directory", () => {
	withRoot((root, sandbox) => {
		initialize(root);
		const before = inventory(sandbox);
		const capabilityId = "../../escape";
		const filename = `${createHash("sha256").update(capabilityId).digest("hex")}.json`;
		const written = bind(root, { capabilityId, branch: "feat/escape", worktreeRoot: "/workspace/escape" });
		assert.ok(written.binding);
		assert.deepEqual(readdirSync(join(root, "worktrees")), [filename]);
		assert.deepEqual(inventory(sandbox), {
			exists: true,
			entries: [...before.entries, "isolated/project-map/store/worktrees:directory", `isolated/project-map/store/worktrees/${filename}:file`],
		});
	});
});
