import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { childContextExtensionPaths } from "../extensions/gentle-agents.ts";

// #1690: children of an isolated standalone parent load the forwarded package
// root, and a parent without the injection signal falls back to the curated
// child-context/child-safety/nan-provider entries. These tests pin both halves.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionsDir = join(repoRoot, "extensions");
const frozenFallback = [join(extensionsDir, "child-context.ts"), join(extensionsDir, "child-safety.ts"), join(extensionsDir, "nan-provider.ts")];

function assertFrozenFallback(paths: string[]): void {
	assert.deepEqual(paths, frozenFallback, "the curated child fallback is frozen by #1690; ship new child behavior in the package");
}

// Pi (package-manager.js resolveExtensionEntries/collectAutoExtensionEntries)
// loads only the entries from a package.json `pi.extensions` or an index.ts/
// index.js when the directory has one; otherwise it loads every top-level
// .ts/.js file. Ignore files there could also hide an entry.
function packageEntrypointProblems(manifest: { pi?: { extensions?: unknown } }, entries: string[]): string[] {
	const problems: string[] = [];
	if (JSON.stringify(manifest.pi?.extensions) !== JSON.stringify(["./extensions"])) problems.push("pi.extensions is not [\"./extensions\"]");
	for (const name of ["index.ts", "index.js", "package.json", ".gitignore", ".ignore", ".fdignore"]) {
		if (entries.includes(name)) problems.push(`extensions/${name} narrows Pi's top-level discovery`);
	}
	for (const name of ["child-context.ts", "child-safety.ts", "nan-provider.ts"]) {
		if (!entries.includes(name)) problems.push(`extensions/${name} is not a top-level entrypoint`);
	}
	return problems;
}

test("the curated child fallback is frozen by #1690 to child-context, child-safety and nan-provider; new child behavior ships in the package", () => {
	assertFrozenFallback(childContextExtensionPaths());
});

test("forwarding the package root gives children child-context, child-safety and nan-provider as top-level package entrypoints", () => {
	// This mirrors Pi's discovery rules by hand (package-manager.js
	// resolveExtensionEntries/collectAutoExtensionEntries). The end-to-end proof
	// is the live probe recorded in odd/tasks/fix-1690-standalone-child-package.md.
	const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
	const entries = readdirSync(extensionsDir);
	assert.deepEqual(packageEntrypointProblems(manifest, entries), []);
});

// Helper self-checks: these exercise the test helpers above, not product code,
// and do not count as product coverage.

test("helper self-check: assertFrozenFallback rejects an extra entry and a reordered list", () => {
	assert.throws(() => assertFrozenFallback([...frozenFallback, join(extensionsDir, "gentle-ai.ts")]), "an extra entry must fail");
	assert.throws(() => assertFrozenFallback([...frozenFallback].reverse()), "the order is part of the contract");
});

test("helper self-check: packageEntrypointProblems flags each rule that narrows Pi's discovery", () => {
	const manifest = { pi: { extensions: ["./extensions"] } };
	const entries = ["child-context.ts", "child-safety.ts", "nan-provider.ts", "gentle-ai.ts"];
	assert.deepEqual(packageEntrypointProblems(manifest, entries), []);
	assert.deepEqual(packageEntrypointProblems(manifest, [...entries, "index.ts"]), ["extensions/index.ts narrows Pi's top-level discovery"]);
	assert.deepEqual(packageEntrypointProblems(manifest, [...entries, "package.json"]), ["extensions/package.json narrows Pi's top-level discovery"]);
	assert.deepEqual(packageEntrypointProblems(manifest, entries.filter((name) => name !== "child-safety.ts")), ["extensions/child-safety.ts is not a top-level entrypoint"]);
	assert.deepEqual(packageEntrypointProblems({ pi: { extensions: ["./extensions/gentle-ai.ts"] } }, entries), ["pi.extensions is not [\"./extensions\"]"]);
});
