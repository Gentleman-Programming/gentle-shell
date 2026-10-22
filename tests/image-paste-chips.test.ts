import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { resetCapabilitiesCache, setCapabilities, stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import { GentlePromptEditor, imageAttachmentsWidget, modelAcceptsImages } from "../extensions/gentle-shell.ts";
import type { ClipboardImage } from "../lib/clipboard-image.ts";
import { ImageAttachments } from "../lib/image-attachments.ts";

// Prompt chips for pasted images (gentle-shell#2464): the paste key inserts an
// atomic `[Image #N]`, one Backspace removes it, and Pi's own paste handler
// stays the fallback for files, text and unsupported formats.

type CtorParams = ConstructorParameters<typeof CustomEditor>;

const PNG_2X1 = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00,
]);
const PASTE_KEY = "\x1bv";
const BACKSPACE = "\x7f";
const png = (): ClipboardImage => ({ bytes: PNG_2X1, mimeType: "image/png" });
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => resetCapabilitiesCache());

function chipEditor(read: (() => Promise<ClipboardImage | null>) | undefined, attachments: ImageAttachments | undefined = new ImageAttachments()) {
	const tui = { terminal: { rows: 30, columns: 100 }, requestRender() {} } as unknown as CtorParams[0];
	const identity = (text: string) => text;
	const theme = { borderColor: identity, selectList: {
		selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity,
	} } as unknown as CtorParams[1];
	const keybindings = { matches: (data: string, action: string) => action === "app.clipboard.pasteImage" && data === PASTE_KEY } as unknown as CtorParams[2];
	const editor = new GentlePromptEditor(tui, theme, keybindings, {
		fg: (_role, text) => text, bold: identity, requestRender() {}, pending: () => false,
		now: () => 0, doubleEscCancelEnabled: () => false, dispatchQueuedText() {},
		attachments: read ? attachments : undefined, readClipboardImage: read,
	});
	editor.focused = true;
	const piPastes: string[] = [];
	// Pi's interactive mode installs its handler only when none is set yet.
	if (!editor.onPasteImage) editor.onPasteImage = () => piPastes.push(editor.getText());
	return { editor, attachments, piPastes };
}

test("the paste key inserts an image chip, spaced from adjacent text", async () => {
	const { editor, attachments, piPastes } = chipEditor(async () => png());
	editor.setText("look");
	editor.handleInput(PASTE_KEY);
	await settle();
	assert.equal(editor.getText(), "look [Image #1]");
	assert.deepEqual(piPastes, []);
	assert.equal(attachments.size, 1);
});

test("one Backspace removes the whole chip; typed look-alike text stays ordinary", async () => {
	const { editor } = chipEditor(async () => png());
	editor.setText("look");
	editor.handleInput(PASTE_KEY);
	await settle();
	editor.handleInput(BACKSPACE);
	assert.equal(editor.getText(), "look ");
	editor.setText("[Image #7]");
	editor.handleInput(BACKSPACE);
	assert.equal(editor.getText(), "[Image #7");
});

test("without a clipboard image Pi's own paste handler runs unchanged", async () => {
	const { editor, piPastes } = chipEditor(async () => null);
	editor.setText("draft");
	editor.handleInput(PASTE_KEY);
	await settle();
	assert.equal(editor.getText(), "draft");
	assert.deepEqual(piPastes, ["draft"]);
	const failing = chipEditor(async () => { throw new Error("clipboard busy"); });
	failing.editor.handleInput(PASTE_KEY);
	await settle();
	assert.equal(failing.piPastes.length, 1);
});

test("a repeated paste key during a slow clipboard read inserts one chip", async () => {
	let resolve!: (image: ClipboardImage) => void;
	const { editor, piPastes } = chipEditor(() => new Promise((done) => { resolve = done; }));
	editor.handleInput(PASTE_KEY);
	editor.handleInput(PASTE_KEY);
	resolve(png());
	await settle();
	assert.equal(editor.getText(), "[Image #1]");
	assert.deepEqual(piPastes, []);
});

test("an editor without attachments keeps Pi's paste handler as a plain property", async () => {
	const { editor, piPastes } = chipEditor(undefined);
	editor.handleInput(PASTE_KEY);
	await settle();
	assert.equal(piPastes.length, 1);
	assert.equal(editor.getText(), "");
});

test("the attachment strip lists chips still in the draft and falls back to text", () => {
	setCapabilities({ images: null, trueColor: false, hyperlinks: false });
	const attachments = new ImageAttachments();
	attachments.add(png());
	let draft = "see [Image #1]";
	let vision = true;
	const theme = { fg: (role: string, text: string) => `<${role}>${text}</${role}>` };
	const strip = imageAttachmentsWidget(attachments, () => draft, theme, () => vision);
	assert.deepEqual(strip.render(80), ["<accent>[Image #1]</accent> <dim>png · 2×1 · 29 B</dim>"]);
	vision = false;
	assert.match(strip.render(200)[0] ?? "", /<warning> · not sent: the current model does not accept images<\/warning>/);
	draft = "chip deleted";
	assert.deepEqual(strip.render(80), []);
});

test("terminals with an image protocol get a thumbnail under the chip label", () => {
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
	const attachments = new ImageAttachments();
	attachments.add(png());
	const strip = imageAttachmentsWidget(attachments, () => "[Image #1]", { fg: (_role, text) => text }, () => true, () => true);
	const lines = strip.render(80);
	assert.equal(stripAnsi(lines[0] ?? ""), "[Image #1] png · 2×1 · 29 B");
	assert.ok(lines.length > 1, "a preview row follows the label");
	assert.ok(lines.slice(1).some((line) => line.includes("\x1b_G")), "the preview uses the Kitty graphics protocol");
});

test("models without declared input capabilities are treated as image-capable", () => {
	assert.equal(modelAcceptsImages(undefined), true);
	assert.equal(modelAcceptsImages({}), true);
	assert.equal(modelAcceptsImages({ input: ["text", "image"] }), true);
	assert.equal(modelAcceptsImages({ input: ["text"] }), false);
});
