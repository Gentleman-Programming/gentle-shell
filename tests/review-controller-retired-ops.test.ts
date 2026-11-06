import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

function scratchDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	test.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function runRetiredOperation(parameters: Record<string, unknown>): Promise<Record<string, unknown>> {
	const cwd = scratchDir("gentle-pi-retired-ops-");
	return await __testing.executeReviewControllerOperation(parameters, cwd, null);
}

function assertRetiredEnvelope(details: Record<string, unknown>, operation: string): void {
	assert.equal(details.operation, operation);
	assert.equal(details.status, "blocked");
	assert.equal(details.outcome, "legacy-operation-retired");
	assert.equal(details.mutation_performed, false);
	assert.equal(details.mutation_outcome, "none");
	assert.match(String(details.reason), /retired/i);
	assert.match(String(details.reason), /bundle/i);
	assert.match(String(details.next_action), /gentle-ai review/);
	assert.match(String(details.next_action), /gentle-ai\/reviews/);
}

test("EXPORT is retired: returns a structured not-supported envelope without touching disk", async () => {
	const details = await runRetiredOperation({ operation: "export", outputPath: "/nonexistent/out.review-bundle", operationId: "export-attempt" });
	assertRetiredEnvelope(details, "export");
});

test("EXPORT retirement does not require the legacy transport parameters", async () => {
	const details = await runRetiredOperation({ operation: "export" });
	assertRetiredEnvelope(details, "export");
});

test("IMPORT is retired: returns a structured not-supported envelope even when acknowledged", async () => {
	const details = await runRetiredOperation({
		operation: "import",
		inputPath: "/nonexistent/in.review-bundle",
		operationId: "import-attempt",
		acknowledgeUntrustedBundleSource: "true",
	});
	assertRetiredEnvelope(details, "import");
});

test("IMPORT retirement does not require the legacy transport parameters", async () => {
	const details = await runRetiredOperation({ operation: "import" });
	assertRetiredEnvelope(details, "import");
});
