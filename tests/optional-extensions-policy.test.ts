import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OPTIONAL_EXTENSION_IDS,
	OPTIONAL_EXTENSIONS_SCHEMA,
	isOptionalExtensionEnabled,
	resolveOptionalExtensionsPolicy,
	writeOptionalExtensionsPolicy,
} from "../lib/optional-extensions-policy.ts";

test("optional extensions default to all disabled when config file is absent", (t) => {
	const home = mkdtempSync(join(tmpdir(), "opt-ext-default-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));

	const resolved = resolveOptionalExtensionsPolicy({ gentlePiConfigHome: home });
	assert.deepEqual(resolved.enabled, []);
	assert.equal(resolved.source, "default");
	assert.equal(resolved.malformed, false);
	for (const id of OPTIONAL_EXTENSION_IDS) {
		assert.equal(isOptionalExtensionEnabled(id, { gentlePiConfigHome: home }), false);
	}
});

test("writeOptionalExtensionsPolicy persists normalized selection and handles malformed files safely", (t) => {
	const home = mkdtempSync(join(tmpdir(), "opt-ext-write-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));

	const file = writeOptionalExtensionsPolicy(["gentle-todo", "codegraph-tools", "gentle-todo"], {
		gentlePiConfigHome: home,
	});
	const resolved = resolveOptionalExtensionsPolicy({ gentlePiConfigHome: home });
	assert.deepEqual(resolved.enabled, ["gentle-todo", "codegraph-tools"]);
	assert.equal(resolved.source, "global_file");
	assert.equal(resolved.malformed, false);
	assert.equal(isOptionalExtensionEnabled("gentle-todo", { gentlePiConfigHome: home }), true);
	assert.equal(isOptionalExtensionEnabled("gentle-design", { gentlePiConfigHome: home }), false);

	writeFileSync(file, JSON.stringify({ schema: OPTIONAL_EXTENSIONS_SCHEMA, enabled: ["unknown-ext"] }));
	const malformed = resolveOptionalExtensionsPolicy({ gentlePiConfigHome: home });
	assert.deepEqual(malformed.enabled, []);
	assert.equal(malformed.malformed, true);
});
