import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";
import {
	CHILD_PACKAGE_INJECTION_ENV,
	childPackageExtensionArgs,
	encodeChildPackageInjection,
	parseChildPackageInjection,
} from "../lib/child-package-injection.ts";

const envWith = (value: string | undefined) => ({ [CHILD_PACKAGE_INJECTION_ENV]: value });

test("the env name follows the GENTLE_SHELL_* launcher naming", () => {
	assert.equal(CHILD_PACKAGE_INJECTION_ENV, "GENTLE_SHELL_CHILD_PACKAGE_INJECTION");
});

test("encode and parse round-trip both launcher shapes", () => {
	for (const value of [
		{ noExtensions: false, extensionPaths: ["/pkg"] },
		{ noExtensions: true, extensionPaths: ["/agent/npm/node_modules/other", "/agent/extensions/a.ts", "/pkg"] },
	]) {
		const encoded = encodeChildPackageInjection(value);
		assert.deepEqual(JSON.parse(encoded), { version: 1, ...value });
		assert.deepEqual(parseChildPackageInjection(envWith(encoded)), value);
	}
});

test("parse returns undefined when the value is absent or empty", () => {
	assert.equal(parseChildPackageInjection({}), undefined);
	assert.equal(parseChildPackageInjection(envWith(undefined)), undefined);
	assert.equal(parseChildPackageInjection(envWith("")), undefined);
});

test("parse rejects malformed values without throwing", () => {
	const rejected = [
		"{not json",
		"null",
		"[]",
		"42",
		JSON.stringify({ noExtensions: false, extensionPaths: ["/pkg"] }),
		JSON.stringify({ version: 2, noExtensions: false, extensionPaths: ["/pkg"] }),
		JSON.stringify({ version: "1", noExtensions: false, extensionPaths: ["/pkg"] }),
		JSON.stringify({ version: 1, extensionPaths: ["/pkg"] }),
		JSON.stringify({ version: 1, noExtensions: "false", extensionPaths: ["/pkg"] }),
		JSON.stringify({ version: 1, noExtensions: false }),
		JSON.stringify({ version: 1, noExtensions: false, extensionPaths: "/pkg" }),
		JSON.stringify({ version: 1, noExtensions: false, extensionPaths: [] }),
		JSON.stringify({ version: 1, noExtensions: false, extensionPaths: [42] }),
		JSON.stringify({ version: 1, noExtensions: false, extensionPaths: [null] }),
		JSON.stringify({ version: 1, noExtensions: false, extensionPaths: [""] }),
		JSON.stringify({ version: 1, noExtensions: false, extensionPaths: ["pkg"] }),
		JSON.stringify({ version: 1, noExtensions: true, extensionPaths: ["/pkg", "./extensions/a.ts"] }),
	];
	for (const value of rejected) {
		assert.doesNotThrow(() => parseChildPackageInjection(envWith(value)), value);
		assert.equal(parseChildPackageInjection(envWith(value)), undefined, value);
	}
});

test("parse checks absoluteness with the injected path flavor, so Windows paths are accepted", () => {
	const windows = encodeChildPackageInjection({ noExtensions: false, extensionPaths: ["C:\\x\\gentle-pi"] });
	assert.deepEqual(parseChildPackageInjection(envWith(windows), win32), { noExtensions: false, extensionPaths: ["C:\\x\\gentle-pi"] });
	assert.equal(parseChildPackageInjection(envWith(windows), posix), undefined);
	const driveRelative = encodeChildPackageInjection({ noExtensions: false, extensionPaths: ["C:x"] });
	assert.equal(parseChildPackageInjection(envWith(driveRelative), win32), undefined);
});

test("childPackageExtensionArgs emits plain argv elements, with --no-extensions first for a takeover", () => {
	assert.deepEqual(childPackageExtensionArgs({ noExtensions: false, extensionPaths: ["/pkg"] }), ["--extension", "/pkg"]);
	assert.deepEqual(
		childPackageExtensionArgs({ noExtensions: true, extensionPaths: ["/other dir/pkg", "C:\\x y\\a.ts", "/pkg"] }),
		["--no-extensions", "--extension", "/other dir/pkg", "--extension", "C:\\x y\\a.ts", "--extension", "/pkg"],
	);
});
