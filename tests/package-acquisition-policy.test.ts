import assert from "node:assert/strict";
import test from "node:test";
import { packageAcquisitionVerdict, recognizePackageAcquisitions } from "../lib/package-acquisition-policy.ts";

const passes = (command: string) => assert.equal(packageAcquisitionVerdict(command).action, "pass", command);
const confirms = (command: string, offending?: string[]) => {
	const verdict = packageAcquisitionVerdict(command);
	assert.equal(verdict.action, "confirm", command);
	if (offending) assert.deepEqual(verdict.offending, offending, command);
};

test("exact registry versions pass, scoped and unscoped, prerelease and build included", () => {
	for (const command of [
		"npm install left-pad@1.3.0",
		"npm i @scope/pkg@2.0.1-beta.1+build.5",
		"npm add a@1.0.0 @b/c@0.0.1",
		"pnpm add left-pad@1.3.0",
		"pnpm install @scope/pkg@1.2.3",
		"pnpm i left-pad@1.3.0 --save-dev",
		"npx cowsay@1.6.0 hello",
		"npm exec cowsay@1.6.0 -- hello",
		"npm exec --package=cowsay@1.6.0 -- cowsay hello",
		"npx -p cowsay@1.6.0 -p lolcatjs@2.3.5 cowsay hi",
		"pnpm dlx cowsay@1.6.0 hello",
	]) {
		// A pass must come from a recognized exact spec, never from a command that went unrecognized.
		assert.ok(recognizePackageAcquisitions(command).length > 0, command);
		passes(command);
	}
});

test("non-exact specs ask for confirmation and are named", () => {
	confirms("npm install left-pad", ["left-pad"]);
	confirms("npm i left-pad@^1.0.0", ["left-pad@^1.0.0"]);
	confirms("npm i left-pad@~1.0.0 left-pad@>=1 left-pad@1.x left-pad@* left-pad@1.0.0-2.0.0 left-pad@1||2");
	confirms("npm i left-pad@latest", ["left-pad@latest"]);
	confirms("npm i left-pad@next", ["left-pad@next"]);
	confirms("npm i left-pad@1.2", ["left-pad@1.2"]);
	confirms("npm i left-pad@v1.2.3", ["left-pad@v1.2.3"]);
	confirms("npm i alias@npm:left-pad@1.3.0", ["alias@npm:left-pad@1.3.0"]);
	confirms("npm i user/repo", ["user/repo"]);
	confirms("npm i github:user/repo", ["github:user/repo"]);
	confirms("npm i git+https://example.com/r.git", ["git+https://example.com/r.git"]);
	confirms("pnpm add https://example.com/p.tgz", ["https://example.com/p.tgz"]);
	confirms("npm i file:../local", ["file:../local"]);
	confirms("pnpm add link:../local", ["link:../local"]);
	confirms("npm i ./pkg.tgz", ["./pkg.tgz"]);
	confirms("npm i ../pkg", ["../pkg"]);
	confirms("npm i /abs/pkg", ["/abs/pkg"]);
	confirms("npm i .", ["."]);
	confirms("npx cowsay hello", ["cowsay"]);
	confirms("npx cowsay@latest hello", ["cowsay@latest"]);
	confirms("npm exec cowsay", ["cowsay"]);
	confirms("pnpm dlx cowsay", ["cowsay"]);
	confirms("pnpm dlx --package=cowsay cowsay hi", ["cowsay"]);
	confirms("npm i left-pad@1.3.0 other", ["other"]);
});

test("specs that cannot be determined ask for confirmation", () => {
	confirms("npm i $(cat pkgs.txt)");
	confirms("npm i `cat pkgs.txt`");
	confirms("npm i left-pad@${VERSION}");
	confirms("npm i left-pad@$VERSION");
	confirms('npm i "left-pad@$VERSION"');
	confirms("npm i left-*");
	confirms("npm i left-pad@1.?.0");
	confirms("pnpm dlx $TOOL");
	confirms("npm i left-pad@1.3.0 --mystery value", ["--mystery value"]);
});

test("lockfile installs and unrelated commands are not acquisitions", () => {
	for (const command of [
		"npm install",
		"npm i",
		"npm ci",
		"npm install --no-audit --ignore-scripts",
		"pnpm install",
		"pnpm i --frozen-lockfile",
		"pnpm install --filter app",
		"npx",
		"npm test",
		"npm run build",
		"npm publish",
		"pnpm run build",
		"pnpm exec tsc",
		"pnpm dlx",
		"echo npm i left-pad",
		"grep 'npm install foo' notes.txt",
		"ls -la",
		"",
	]) {
		assert.deepEqual(recognizePackageAcquisitions(command), [], command);
		passes(command);
	}
	// A mystery flag with nothing after it cannot hide a spec.
	passes("npm install --mystery");
});

test("chained commands, env assignments and wrappers are recognized", () => {
	assert.equal(recognizePackageAcquisitions("cd app && npm i left-pad").length, 1);
	assert.equal(recognizePackageAcquisitions("npm ci || npm i left-pad").length, 1);
	assert.equal(recognizePackageAcquisitions("echo hi; pnpm add left-pad").length, 1);
	assert.equal(recognizePackageAcquisitions("echo hi | npx cowsay").length, 1);
	assert.equal(recognizePackageAcquisitions("npm i a@1.0.0\npnpm add b").length, 2);
	assert.equal(recognizePackageAcquisitions("CI=1 NODE_ENV=dev npm i left-pad").length, 1);
	assert.equal(recognizePackageAcquisitions("env CI=1 npm i left-pad").length, 1);
	assert.equal(recognizePackageAcquisitions("sudo npm i left-pad").length, 1);
	assert.equal(recognizePackageAcquisitions("echo $(npm i left-pad)").length, 1);
	assert.equal(recognizePackageAcquisitions("./node_modules/.bin/npx cowsay").length, 1);
	confirms("npm i a@1.0.0 && npm i b");
	confirms("npm i a@1.0.0 && pnpm dlx b@latest", ["b@latest"]);
	confirms("CI=1 npm i left-pad", ["left-pad"]);
	passes("CI=1 npm i a@1.0.0 && pnpm add b@2.0.0 | cat");
});

test("global installs are tracked and judged by the same rule", () => {
	const [short] = recognizePackageAcquisitions("npm i -g typescript@5.4.5");
	assert.equal(short.global, true);
	assert.deepEqual(short.specs, ["typescript@5.4.5"]);
	assert.equal(recognizePackageAcquisitions("npm install --global typescript@5.4.5")[0].global, true);
	assert.equal(recognizePackageAcquisitions("pnpm add -g typescript@5.4.5")[0].global, true);
	assert.equal(recognizePackageAcquisitions("pnpm -g add typescript@5.4.5")[0].global, true);
	assert.equal(recognizePackageAcquisitions("npm i typescript@5.4.5")[0].global, false);
	passes("npm i -g typescript@5.4.5");
	confirms("npm i -g typescript", ["typescript"]);
	confirms("pnpm add --global typescript@latest", ["typescript@latest"]);
});

test("option values are skipped and never mistaken for specs", () => {
	passes("npm i --prefix ./app --registry https://registry.npmjs.org left-pad@1.3.0");
	passes("npm i -w packages/a left-pad@1.3.0");
	passes("pnpm --filter app add left-pad@1.3.0");
	passes("pnpm -C app add left-pad@1.3.0");
	passes("pnpm add left-pad@1.3.0 --config.foo=bar");
	passes("npm i -- left-pad@1.3.0");
	confirms("npm i -- left-pad", ["left-pad"]);
});

test("recognition reports the manager, form and head offset", () => {
	const command = "echo hi && npx cowsay";
	const [found] = recognizePackageAcquisitions(command);
	assert.equal(found.manager, "npm");
	assert.equal(found.form, "exec");
	assert.equal(found.triggerIndex, command.indexOf("npx"));
	assert.equal(packageAcquisitionVerdict(command).triggerIndex, command.indexOf("npx"));
	assert.equal(recognizePackageAcquisitions("pnpm dlx cowsay")[0].manager, "pnpm");
	assert.equal(recognizePackageAcquisitions("pnpm dlx cowsay")[0].form, "dlx");
	assert.equal(recognizePackageAcquisitions("pnpm add x")[0].form, "install");
});

test("install-form -p/--package never hides a bare spec", () => {
	for (const command of ["npm i -p lodash", "pnpm add -p lodash", "npm install --package lodash"]) {
		assert.equal(packageAcquisitionVerdict(command).action, "confirm", command);
	}
	assert.equal(packageAcquisitionVerdict("npx -p cowsay@1.2.3 cowsay").action, "pass");
});

test("npm install and install-test aliases are recognized", () => {
	for (const alias of ["in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "it", "install-test"]) {
		assert.equal(packageAcquisitionVerdict(`npm ${alias} lodash`).action, "confirm", alias);
		assert.equal(packageAcquisitionVerdict(`npm ${alias} lodash@1.2.3`).action, "pass", alias);
	}
});

test("an unknown option before the subcommand never hides the acquisition", () => {
	for (const command of ["npm --no-color install lodash", "npm --no-update-notifier i lodash", "npm --foo bar install lodash"]) {
		assert.equal(packageAcquisitionVerdict(command).action, "confirm", command);
	}
	assert.equal(packageAcquisitionVerdict("npm --no-color install lodash@1.2.3").action, "pass");
	assert.equal(packageAcquisitionVerdict("npm --no-color run build").action, "pass");
});

test("several unknown options or values before the subcommand never hide the acquisition", () => {
	for (const command of ["npm --foo bar --baz qux install lodash", "npm --foo bar baz install lodash", "npm --foo bar -g install lodash", "pnpm --foo bar --baz qux add lodash"]) {
		assert.equal(packageAcquisitionVerdict(command).action, "confirm", command);
	}
	assert.equal(packageAcquisitionVerdict("npm --foo bar --baz qux run build").action, "pass");
	assert.equal(packageAcquisitionVerdict("npm --foo bar baz run build && echo done").action, "pass");
});

test("an unknown option's scan stops at the segment operator", () => {
	assert.equal(packageAcquisitionVerdict("npm --foo bar run y; npm i lodash@1.2.3").action, "pass");
	assert.equal(packageAcquisitionVerdict("npm --foo bar run y; npm i lodash").action, "confirm");
});

test("a `--package` given before `exec`/`dlx` still names the packages to fetch", () => {
	confirms("npm --package=evil exec -- bin@1.0.0", ["evil"]);
	confirms("npm --package evil exec -- bin@1.0.0", ["evil"]);
	confirms("pnpm --package=evil dlx bin@1.0.0", ["evil"]);
	passes("npm --package=evil@1.0.0 exec -- bin@1.0.0");
	// Before a non-exec subcommand `-p` is npm's boolean `--parseable`, never a package.
	passes("npm -p install left-pad@1.3.0");
	confirms("npm -p install left-pad", ["left-pad"]);
	confirms("npm -p left-pad install a@1.0.0", ["-p left-pad"]);
	// A bare `-p` never takes another option as its value, so the `--package` after it still counts.
	confirms("npm -p --package evil exec -- bin@1.0.0", ["evil"]);
	confirms("npm --package -p evil exec -- bin@1.0.0", ["evil"]);
});

test("pnpm's `-w`/`--workspace-root` take no value, npm's `-w` names a workspace", () => {
	passes("pnpm add -w left-pad@1.3.0");
	passes("pnpm add --workspace-root left-pad@1.3.0");
	passes("pnpm -w add left-pad@1.3.0");
	confirms("pnpm add -w left-pad", ["left-pad"]);
	passes("npm i -w pkg-a left-pad@1.3.0");
	confirms("npm i -w pkg-a left-pad", ["left-pad"]);
});

test("plain `npm exec` keeps reading `--package` after the command until `--`; npx hands it to the command", () => {
	confirms("npm exec --package=cowsay@1.6.0 cowsay hi --package=evil", ["evil"]);
	confirms("npm exec cowsay@1.6.0 hi -p evil", ["evil"]);
	confirms("npm x --package=cowsay@1.6.0 cowsay --package evil", ["evil"]);
	passes("npm exec --package=cowsay@1.6.0 cowsay hi --package=lolcatjs@2.3.5");
	// After `--` every word belongs to the command.
	passes("npm exec --package=cowsay@1.6.0 -- cowsay hi --package=evil");
	passes("npm exec cowsay@1.6.0 -- hi --package=evil");
	// npx passes everything after the command to it.
	passes("npx cowsay@1.6.0 hi --package=evil");
	// Other options after the command stay the command's business.
	passes("npm exec cowsay@1.6.0 --fix src");
});
