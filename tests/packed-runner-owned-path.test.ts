import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveInstalledJitiStaticEntry } from "../scripts/test-packed-runner.mjs";

function withAliasedConsumer(run: (consumer: string, sdkManifest: string, jitiRoot: string) => void): void {
	const disposable = mkdtempSync(join(tmpdir(), "packed-owned-path-"));
	try {
		const actual = join(disposable, "actual");
		const consumer = join(disposable, "alias", "consumer");
		const actualConsumer = join(actual, "consumer");
		const sdkRoot = join(actualConsumer, "node_modules", "@earendil-works", "pi-coding-agent");
		const jitiRoot = join(actualConsumer, "node_modules", "jiti");
		mkdirSync(sdkRoot, { recursive: true });
		mkdirSync(join(jitiRoot, "dist"), { recursive: true });
		symlinkSync(actual, join(disposable, "alias"), "dir");
		writeFileSync(join(sdkRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.87.1", dependencies: { jiti: "2.7.0" } }));
		writeFileSync(join(jitiRoot, "package.json"), JSON.stringify({ name: "jiti", version: "2.7.0", exports: { "./static": { types: "./dist/jiti.d.ts", import: "./dist/jiti.mjs" }, "./package.json": "./package.json" } }));
		run(consumer, join(consumer, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), jitiRoot);
	} finally {
		rmSync(disposable, { recursive: true, force: true });
	}
}

const checks = { sdkManifest: "sdk-manifest", sdkVersion: "sdk-version", jitiManifest: "jiti-manifest-owned", jitiStaticExport: "jiti-static-export", jitiEntry: "jiti-entry-owned", jitiVersion: "jiti-version" };

test("accepts a canonical Jiti manifest beneath an aliased ancestor", () => {
	withAliasedConsumer((consumer, sdkManifest, jitiRoot) => {
		writeFileSync(join(jitiRoot, "dist", "jiti.mjs"), "export const createJiti = () => {};\n");
		const seen: string[] = [];
		const entry = resolveInstalledJitiStaticEntry(consumer, sdkManifest, "0.87.1", (check: string) => seen.push(check), checks);
		assert.equal(entry, join(consumer, "node_modules", "jiti", "dist", "jiti.mjs"));
		assert.equal(realpathSync.native(entry), join(realpathSync.native(jitiRoot), "dist", "jiti.mjs"));
		assert.ok(seen.includes("jiti-manifest-owned"));
	});
});

test("rejects a symlink within the owned Jiti static entry", () => {
	withAliasedConsumer((consumer, sdkManifest, jitiRoot) => {
		writeFileSync(join(jitiRoot, "dist", "real.mjs"), "export const createJiti = () => {};\n");
		symlinkSync("real.mjs", join(jitiRoot, "dist", "jiti.mjs"));
		assert.throws(() => resolveInstalledJitiStaticEntry(consumer, sdkManifest, "0.87.1", () => {}, checks), /refusing symbolic link in owned package/);
	});
});
