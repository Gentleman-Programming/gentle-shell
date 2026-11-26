import assert from "node:assert/strict";
import { test } from "node:test";
import { loadChatUi as loadUi } from "./support/chat-ui.ts";

test("should paste the clipboard image with alt+v on a Windows host", async (t) => {
	const ui = await loadUi(t, "C:/Users/dev");
	assert.equal(ui.pasteImageKey(), "alt+v");
	assert.equal(ui.isWindowsHost(), true);
});

test("should recognize a Windows home written with backslashes", async (t) => {
	const ui = await loadUi(t, "C:\\Users\\dev");
	assert.equal(ui.isWindowsHost(), true);
	assert.equal(ui.pasteImageKey(), "alt+v");
});

test("should paste the clipboard image with ctrl+v on a POSIX host", async (t) => {
	for (const home of ["/home/dev", "/Users/dev"]) {
		const ui = await loadUi(t, home);
		assert.equal(ui.pasteImageKey(), "ctrl+v", home);
		assert.equal(ui.isWindowsHost(), false, home);
	}
});

test("should default to ctrl+v when the host reports no home", async (t) => {
	const ui = await loadUi(t, undefined as unknown as string);
	assert.equal(ui.pasteImageKey(), "ctrl+v");
});

test("should name the platform's paste key in the attach tooltip", async (t) => {
	const windows = await loadUi(t, "C:/Users/dev");
	assert.match(windows.attachTooltip(), /alt\+v/i);
	const posix = await loadUi(t, "/home/dev");
	assert.match(posix.attachTooltip(), /ctrl\+v/i);
});

test("should pick the key from the platform the session's publisher reports, not the host", async (t) => {
	const windowsHost = await loadUi(t, "C:/Users/dev");
	assert.equal(windowsHost.pasteImageKey("linux"), "ctrl+v", "a Pi running in WSL under a Windows Herdr");
	assert.equal(windowsHost.pasteImageKey("win32"), "alt+v");
	assert.match(windowsHost.attachTooltip("linux"), /ctrl\+v/i);
	const posixHost = await loadUi(t, "/home/dev");
	assert.equal(posixHost.pasteImageKey("win32"), "alt+v");
	assert.equal(posixHost.pasteImageKey("darwin"), "ctrl+v");
});

test("should fall back to the host when the session reports no platform", async (t) => {
	const windowsHost = await loadUi(t, "C:/Users/dev");
	for (const none of [undefined, null, ""]) assert.equal(windowsHost.pasteImageKey(none), "alt+v");
	const posixHost = await loadUi(t, "/home/dev");
	assert.equal(posixHost.pasteImageKey(undefined), "ctrl+v");
});

test("should keep a POSIX home that contains a backslash off the Windows path", async (t) => {
	const ui = await loadUi(t, "/home/team\\dev");
	assert.equal(ui.isWindowsHost(), false);
	assert.equal(ui.pasteImageKey(), "ctrl+v");
});
