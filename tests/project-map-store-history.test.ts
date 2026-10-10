import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { advanceProjectMapStore, initializeProjectMapStore } from "../lib/project-map-store.ts";
import {
	PROJECT_MAP_STORE_HISTORY_LIMIT,
	appendProjectMapStoreHistory,
	pruneProjectMapStoreHistory,
	readProjectMapStoreHistory,
} from "../lib/project-map-store-history.ts";
import { PROJECT_MAP_STORE_DIAGNOSTIC_CODES, type ProjectMapStoreDescriptorV1 } from "../lib/project-map-store-schema.ts";

const REPOSITORY_ID = `sha256:${"a".repeat(64)}`;
const EPOCH = "123e4567-e89b-12d3-a456-426614174000";
const CREATED_AT = "2026-09-24T12:00:00Z";

function digest(bytes: string): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function withRoot(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "project-map-store-history-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function descriptor(generation: number): ProjectMapStoreDescriptorV1 {
	return {
		schema: "gentle-shell.project-map-store/v1",
		kind: "descriptor",
		repository_id: REPOSITORY_ID,
		generation,
		epoch: EPOCH,
		predecessor: generation === 0 ? null : `sha256:${"b".repeat(64)}`,
		created_at: CREATED_AT,
		updated_at: CREATED_AT,
	};
}

function initialize(root: string): ProjectMapStoreDescriptorV1 {
	const result = initializeProjectMapStore({ root, repositoryId: REPOSITORY_ID, epoch: EPOCH, now: CREATED_AT });
	assert.deepEqual(result.diagnostics, []);
	assert.ok(result.descriptor);
	return result.descriptor;
}

function advance(root: string, observed: ProjectMapStoreDescriptorV1): ReturnType<typeof advanceProjectMapStore> {
	const bytes = readFileSync(join(root, "store.json"), "utf8");
	return advanceProjectMapStore({
		root,
		expected: { generation: observed.generation, epoch: observed.epoch, predecessor: digest(bytes) },
		now: "2026-09-24T12:01:00Z",
	});
}

test("appends each superseded descriptor to history", () => {
	withRoot((root) => {
		const initial = initialize(root);
		const result = advance(root, initial);
		assert.ok(result.descriptor);
		const history = readProjectMapStoreHistory(root, 20);
		assert.deepEqual(history.diagnostics, []);
		assert.deepEqual(history.history.map((entry) => entry.generation), [0]);
		assert.ok(readdirSync(join(root, "history")).includes(`0-${EPOCH}.json`));
	});
});

test("pins the literal history cap and prunes valid entries oldest-first", () => {
	withRoot((root) => {
		assert.equal(PROJECT_MAP_STORE_HISTORY_LIMIT, 20);
		for (let generation = 0; generation <= 20; generation += 1) {
			assert.deepEqual(appendProjectMapStoreHistory(root, descriptor(generation)), []);
		}
		assert.equal(readdirSync(join(root, "history")).length, 21);
		assert.deepEqual(pruneProjectMapStoreHistory(root), []);
		const history = readProjectMapStoreHistory(root, 21);
		assert.equal(readdirSync(join(root, "history")).length, 20);
		assert.deepEqual(history.history.map((entry) => entry.generation), Array.from({ length: 20 }, (_, index) => index + 1));
	});
});

test("counts malformed history files toward the cap and removes them before valid entries", () => {
	withRoot((root) => {
		for (let generation = 0; generation < 20; generation += 1) {
			assert.deepEqual(appendProjectMapStoreHistory(root, descriptor(generation)), []);
		}
		writeFileSync(join(root, "history", "broken.json"), "{ not json", "utf8");
		const diagnostics = pruneProjectMapStoreHistory(root);
		assert.ok(diagnostics.some((diagnostic) => diagnostic.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED));
		assert.equal(readdirSync(join(root, "history")).length, 20);
		assert.ok(!readdirSync(join(root, "history")).includes("broken.json"));
		assert.deepEqual(readProjectMapStoreHistory(root, 20).history.map((entry) => entry.generation), Array.from({ length: 20 }, (_, generation) => generation));
	});
});

test("reports an unparsable history file without blocking a swap", () => {
	withRoot((root) => {
		const initial = initialize(root);
		mkdirSync(join(root, "history"), { recursive: true });
		writeFileSync(join(root, "history", "broken.json"), "{ not json", "utf8");
		const result = advance(root, initial);
		assert.ok(result.descriptor);
		assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === PROJECT_MAP_STORE_DIAGNOSTIC_CODES.STORE_CORRUPTED));
	});
});
