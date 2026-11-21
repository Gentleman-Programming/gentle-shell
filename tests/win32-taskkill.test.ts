import assert from "node:assert/strict";
import test from "node:test";
import { windowsTaskkillPath } from "../lib/win32-taskkill.ts";

test("windowsTaskkillPath trusts only an absolute SystemRoot and otherwise falls back to C:\\Windows", () => {
	assert.equal(windowsTaskkillPath({}), "C:\\Windows\\System32\\taskkill.exe");
	assert.equal(windowsTaskkillPath({ SystemRoot: "relative\\dir" }), "C:\\Windows\\System32\\taskkill.exe", "a relative SystemRoot is never trusted");
	assert.equal(windowsTaskkillPath({ windir: "E:\\Custom" }), "E:\\Custom\\System32\\taskkill.exe", "windir is the fallback spelling");
	assert.equal(windowsTaskkillPath({ SystemRoot: "D:\\Win", windir: "E:\\Ignored" }), "D:\\Win\\System32\\taskkill.exe", "SystemRoot wins over windir");
});
