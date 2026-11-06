import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStartupChoice, omitStartupVersion, resolveStartupRelaunch } from "../lib/gentle-shell-startup-flow.ts";

test("relaunch resolves the activated version's own Node and preserves arguments without shell quoting", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "startup-relaunch-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const version = join(root, "versions", "4.2.0-1.2.0");
	const pkg = join(version, "node_modules", "gentle-pi");
	mkdirSync(join(pkg, "scripts"), { recursive: true });
	mkdirSync(join(pkg, "bin"));
	writeFileSync(join(version, ".gentle-shell-version"), "4.2.0-1.2.0\n");
	writeFileSync(join(pkg, "bin", "gentle-shell.mjs"), "// verified launcher\n");
	writeFileSync(join(pkg, "scripts", "bundled-install.mjs"), `export function prefixLayout({root}) { return {node: root + '/runtime/new node/bin/node'}; }`);
	if (process.platform === "win32") writeFileSync(join(root, "current"), "4.2.0-1.2.0\n");
	else symlinkSync("versions/4.2.0-1.2.0", join(root, "current"));
	const argv = ["--home", "path with spaces", "--continue", "a;literal"];
	const result = await resolveStartupRelaunch({ root, home: tmpdir(), platform: process.platform, env: {}, argv });
	assert.equal(result.command, root + "/runtime/new node/bin/node");
	assert.deepEqual(result.args, [join(pkg, "bin", "gentle-shell.mjs"), ...argv]);
	assert.equal(result.env.GENTLE_SHELL_SKIP_STARTUP_UPDATE, "1");
});

function effects(code = 0) {
	const events: string[] = [];
	return { events, omit: () => { events.push("omit"); }, upgrade: async () => { events.push("upgrade"); return code; },
		relaunch: async () => { events.push("relaunch"); return 17; } };
}

test("not now and cancellation never update or persist; cancellation exits 130", async () => {
	const deps = effects();
	assert.equal(await applyStartupChoice("skip", deps), undefined);
	assert.equal(await applyStartupChoice("cancel", deps), 130);
	assert.deepEqual(deps.events, []);
});

test("omit persists only the selected version and launches normally", async () => {
	const deps = effects();
	assert.equal(await applyStartupChoice("omit", deps), undefined);
	assert.deepEqual(deps.events, ["omit"]);
	let stored = '{"home":"link","provisioned":{"a":1},"other":true}';
	omitStartupVersion(() => stored, (text) => { stored = text; }, "4.2.0");
	assert.deepEqual(JSON.parse(stored), { home: "link", provisioned: { a: 1 }, other: true, skippedStartupRelease: "4.2.0" });
});

test("malformed settings are not overwritten by omit; normal launch remains possible", async () => {
	for (const text of ["{broken", "[]", "null", '"text"']) {
		let writes = 0;
		assert.throws(() => omitStartupVersion(() => text, () => { writes++; }, "4.2.0"));
		assert.equal(writes, 0);
	}
	const deps = effects();
	deps.omit = () => { throw new Error("read-only config"); };
	assert.equal(await applyStartupChoice("omit", deps), undefined);
	assert.deepEqual(deps.events, []);
});

test("accepted update reopens active Shell only after upgrade success and preserves exit status", async () => {
	const deps = effects();
	assert.equal(await applyStartupChoice("update", deps), 17);
	assert.deepEqual(deps.events, ["upgrade", "relaunch"]);
});

test("failed upgrade keeps ordinary launch; failed relaunch never falls through to old Shell", async () => {
	const deps = effects(1);
	assert.equal(await applyStartupChoice("update", deps), undefined);
	assert.deepEqual(deps.events, ["upgrade"]);
	const successful = effects();
	successful.relaunch = async () => { throw new Error("new runtime failed"); };
	await assert.rejects(applyStartupChoice("update", successful), /new runtime failed/);
	assert.deepEqual(successful.events, ["upgrade"]);
});
