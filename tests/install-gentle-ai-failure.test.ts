import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The postinstall entry with a stub installer that fails the way a Windows Go source
// build does: GentleAiInstallerError caused by execFile's error, which carries stdout
// and stderr. pnpm shows this stderr in its lifecycle output, and the installer wizard
// reports the line its one-line detail rule selects.
function postinstall(failure: string) {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-postinstall-failure-"));
	try {
		const scripts = join(root, "node_modules", "gentle-pi", "scripts");
		mkdirSync(scripts, { recursive: true });
		copyFileSync(new URL("../scripts/install-gentle-ai.mjs", import.meta.url), join(scripts, "install-gentle-ai.mjs"));
		copyFileSync(new URL("../scripts/install-tui-mode-setting.mjs", import.meta.url), join(scripts, "install-tui-mode-setting.mjs"));
		writeFileSync(join(scripts, "gentle-ai-installer.mjs"), `export const INSTALLER_VERSION = "4.0.0";\nexport async function installGentleAi() {\n${failure}\n}\n`);
		return spawnSync(process.execPath, [join(scripts, "install-gentle-ai.mjs")], { encoding: "utf8",
			env: { ...process.env, GENTLE_PI_AGENT_HOME: join(root, "agent"), GENTLE_PI_SKIP_GENTLE_AI_INSTALL: "0" } });
	} finally { rmSync(root, { recursive: true, force: true }); }
}

test("a failed postinstall prints the whole cause chain with codes and the failing command's output, and exits 1", () => {
	const result = postinstall(`
	const go = Object.assign(new Error("Command failed: C:\\\\go\\\\bin\\\\go.exe install pkg@v4.0.0\\ngo: downloading pkg v4.0.0\\ngo: verifying pkg@v4.0.0: checksum mismatch"),
		{ code: 1, stdout: "", stderr: "go: downloading pkg v4.0.0\\ngo: verifying pkg@v4.0.0: checksum mismatch\\n" });
	throw Object.assign(new Error("Gentle AI Go SumDB source installation failed for pkg@v4.0.0.", { cause: go }), { code: "GENTLE_AI_GO_INSTALL_FAILED" });`);
	assert.equal(result.status, 1);
	assert.equal(result.stderr, [
		"gentle-pi could not install its package-local Gentle AI v4.0.0 binary: Gentle AI Go SumDB source installation failed for pkg@v4.0.0. (code GENTLE_AI_GO_INSTALL_FAILED)",
		"  caused by Error: Command failed: C:\\go\\bin\\go.exe install pkg@v4.0.0 (code 1)",
		"    stderr:",
		"    | go: downloading pkg v4.0.0",
		"    | go: verifying pkg@v4.0.0: checksum mismatch",
		// Last, in the `Error:` form the installer wizard's one-line detail selects.
		"  root cause Error: go: verifying pkg@v4.0.0: checksum mismatch",
		"",
	].join("\n"));
});

test("a failed postinstall without a cause reads exactly as before", () => {
	for (const [failure, shown] of [["throw new Error(\"plain failure\");", "plain failure"], ["throw \"boom\";", "boom"]]) {
		const result = postinstall(failure);
		assert.equal(result.status, 1);
		assert.equal(result.stderr, `gentle-pi could not install its package-local Gentle AI v4.0.0 binary: ${shown}\n`);
	}
});

test("a failed postinstall bounds each output to its last 4000 characters, reports a signal, and ends a cause cycle", () => {
	const bounded = postinstall(`
	const timeout = Object.assign(new Error("Command failed: go.exe install"), { code: null, signal: "SIGTERM", stderr: "x".repeat(5000) + "\\nlast line", stdout: "progress\\n" });
	throw new Error("top", { cause: timeout });`);
	assert.equal(bounded.status, 1);
	assert.match(bounded.stderr, /caused by Error: Command failed: go\.exe install \(signal SIGTERM\)/);
	assert.match(bounded.stderr, /stderr \(last 4000 characters\):/);
	assert.doesNotMatch(bounded.stderr, /x{3991}/);
	assert.match(bounded.stderr, /stdout:\n {4}\| progress/);
	assert.match(bounded.stderr, /root cause Error: last line\n$/, "stderr wins over stdout");
	const cyclic = postinstall(`
	const first = new Error("first");
	const second = new Error("second", { cause: first });
	Object.assign(first, { cause: second });
	throw new Error("top", { cause: first });`);
	assert.equal(cyclic.status, 1);
	assert.equal(cyclic.stderr.split("\n").filter((line) => line.startsWith("  caused by ")).length, 6);
	assert.match(cyclic.stderr, /further causes omitted\n$/);
});
