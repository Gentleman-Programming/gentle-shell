import assert from "node:assert/strict";
import test from "node:test";
import pretty from "../extensions/pi-pretty.ts";

test("bundled pretty cannot replace or restore an editor owned by the host", async () => {
	const handlers = new Map<string, Function[]>();
	const pi = { on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } };
	const owner = () => "custom";
	let editor: unknown = owner;
	let indicator: unknown;
	let message: unknown;
	let visible = true;
	const ctx = { mode: "tui", ui: {
		getEditorComponent: () => editor,
		setEditorComponent: (value: unknown) => { editor = value; },
		setWorkingIndicator: (value: unknown) => { indicator = value; },
		setWorkingMessage: (value: unknown) => { message = value; },
		setWorkingVisible(value: boolean) { visible = value; },
		theme: { fg: (role: string, text: string) => `<${role}>${text}</${role}>`, bold: (text: string) => text },
	} };
	await pretty(pi, undefined, async (api: any) => {
		api.on("session_start", (_event: unknown, context: any) => {
			context.ui.setEditorComponent(() => "pretty");
			context.ui.setWorkingIndicator({ frames: ["foreign"] });
		});
		api.on("session_shutdown", (_event: unknown, context: any) => context.ui.setEditorComponent(undefined));
	}, {});
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	assert.equal(editor, owner);
	assert.equal(visible, false, "the prompt frame owns the live working state without a duplicate loader row");
	assert.equal(indicator, undefined);
	assert.equal(message, undefined);
	for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
	assert.equal(editor, owner);
	assert.equal(visible, true);
	assert.equal(indicator, undefined);
	assert.equal(message, undefined);
});

test("disabled shell leaves bundled editor behavior untouched", async () => {
	let received: unknown;
	const pi = {};
	await pretty(pi, undefined, async (api: unknown) => { received = api; }, { GENTLE_PI_SHELL: "0" });
	assert.equal(received, pi);
});
