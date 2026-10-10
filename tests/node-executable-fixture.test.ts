import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const preload = fileURLToPath(new URL("./support/node-executable-fixture.cjs", import.meta.url));
const { invocation } = createRequire(import.meta.url)(preload);

test("fixture adapter preserves arguments, environment, streams and exit status", (t) => {
	const root = mkdtempSync(join(tmpdir(), "node-executable-fixture-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const script = join(root, "fake runtime.mjs");
	writeFileSync(script, "#!/usr/bin/env node\nconsole.log(JSON.stringify([process.argv.slice(2), process.env.FIXTURE_VALUE])); console.error('fixture stderr'); process.exit(7);\n");
	const args = ["argument with spaces", "literal ; & quote \""];
	const bareScript = join(root, "pi");
	writeFileSync(bareScript, "#!/usr/bin/env node\nprocess.exit(0);\n");
	assert.deepEqual(invocation("pi", args, root, "win32", { PATH: root }), [process.execPath, [bareScript, ...args]]);
	assert.deepEqual(invocation("pi", args, root, "win32", { PATH: join(root, "other") }), ["pi", args]);
	const mapped = invocation(script, args, root, "win32") as [string, string[]];
	assert.deepEqual(mapped, [process.execPath, [script, ...args]]);
	const result = spawnSync(mapped[0], mapped[1], { encoding: "utf8", env: { ...process.env, FIXTURE_VALUE: "env with spaces" } });
	assert.equal(result.status, 7);
	assert.deepEqual(JSON.parse(result.stdout), [args, "env with spaces"]);
	assert.equal(result.stderr.trim(), "fixture stderr");
	assert.deepEqual(invocation(script, args, root, "linux"), [script, args]);
	for (const command of [process.execPath, join(root, "missing.mjs")]) {
		assert.deepEqual(invocation(command, args, root, "win32"), [command, args]);
	}
	const notNode = join(root, "not-node.mjs");
	writeFileSync(notNode, "plain text\n");
	assert.deepEqual(invocation(notNode, args, root, "win32"), [notNode, args]);
	const child = spawnSync(process.execPath, ["--require", preload, "--input-type=module", "-e", "import { spawnSync } from 'node:child_process'; const r = spawnSync(process.argv[1], process.argv.slice(2), { encoding: 'utf8' }); process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status ?? 99);", script, ...args], {
		encoding: "utf8", env: { ...process.env, TEST_NODE_EXECUTABLE_ROOT: root, FIXTURE_VALUE: "env with spaces" },
	});
	if (process.platform === "win32") {
		assert.equal(child.status, 7, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout), [args, "env with spaces"]);
	}
});
