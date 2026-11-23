import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, TuiAltScreen, type Component, type TUI } from "@earendil-works/pi-tui";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { clearSessionView, findSessionChatContainer, runSessionViewClear, SESSION_VIEW_CLEAR_NOTICE, type SessionViewClearHost } from "../lib/session-view-clear.ts";

// /drakonc:clear vacía la vista de la conversación sin tocar la sesión. Estas
// pruebas usan el TUI de pantalla completa real (TuiAltScreen) y el viewport
// real de Pi, y montan el árbol como lo monta InteractiveMode: el documento
// (encabezado, recursos cargados y conversación) primero, el layout después.
// Un fixture hecho a mano ya dejó pasar fallos en este repositorio.

const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\s+$/, "");
const lines = (rows: readonly string[]): Component => ({ render: () => [...rows], invalidate() {} });

function terminal(columns: number, rows: number): never {
	return {
		start() {}, stop() {}, async drainInput() {}, write() {},
		get columns() { return columns; }, get rows() { return rows; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
		kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
	} as never;
}

type Mounted = {
	tui: TuiAltScreen;
	document: Container;
	header: Container;
	chat: Container;
	frame(): Promise<string[]>;
	close(): void;
};

/** El árbol que monta InteractiveMode en pantalla completa (interactive-mode.js:438-444, 746-768). */
function mountFullscreen(columns = 60, rows = 14): Mounted {
	const document = new Container();
	const header = new Container();
	const chat = new Container();
	document.addChild(header);
	document.addChild(new Container());
	document.addChild(chat);
	header.addChild(lines(["ENCABEZADO DE PI"]));
	chat.addChild(lines(["hola usuario"]));
	chat.addChild(lines(["respuesta del agente"]));
	const viewport = createChatViewport({
		document,
		pendingMessages: new Container(),
		status: new Container(),
		widgetsAbove: new Container(),
		editor: lines(["╭─ prompt ─╮"]),
		widgetsBelow: new Container(),
		footer: new Container(),
		scrollbar: "auto",
	});
	const tui = new TuiAltScreen(terminal(columns, rows), false);
	tui.addChild(document);
	tui.addChild(new Container());
	tui.addChild(new Container());
	tui.addChild(new Container());
	tui.addChild(new Container());
	tui.addChild(new Container());
	tui.addChild(new Container());
	tui.setLayoutRoot(viewport.root);
	tui.start();
	return {
		tui, document, header, chat,
		async frame() {
			tui.requestRender(true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			return ((tui as unknown as { previousScreen: string[] }).previousScreen ?? []).map(strip);
		},
		close() { tui.stop(); },
	};
}

function fixtureHost(overrides: Partial<SessionViewClearHost> = {}): SessionViewClearHost & { notices: Array<{ message: string; type?: string }> } {
	const notices: Array<{ message: string; type?: string }> = [];
	return {
		notices,
		notify: (message, type) => notices.push({ message, type }),
		isIdle: () => true,
		...overrides,
	};
}

/** Un SessionManager real sobre un directorio temporal: nada toca el HOME real. */
function fixtureSession(t: { after(fn: () => void): void }) {
	const root = mkdtempSync(join(tmpdir(), "drakonc-clear-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const manager = SessionManager.create(root, join(root, "sessions"));
	manager.appendMessage({ role: "user", content: "primer mensaje", timestamp: 1 });
	manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "primera respuesta" }], timestamp: 2 } as never);
	manager.appendMessage({ role: "user", content: "segundo mensaje", timestamp: 3 });
	return manager;
}

test("limpiar deja la vista vacía y conserva encabezado y prompt", async (t) => {
	const view = mountFullscreen();
	t.after(() => view.close());
	const before = await view.frame();
	assert.ok(before.some((row) => row.includes("hola usuario")), `la conversación se pinta antes de limpiar, got ${JSON.stringify(before)}`);
	assert.equal(clearSessionView(view.tui), 2, "oculta los dos bloques del turno");
	const after = await view.frame();
	assert.ok(!after.some((row) => row.includes("hola usuario") || row.includes("respuesta del agente")), `la vista queda vacía, got ${JSON.stringify(after)}`);
	assert.ok(after.some((row) => row.includes("ENCABEZADO DE PI")), "el encabezado sigue ahí");
	assert.ok(after.some((row) => row.includes("prompt")), "el prompt sigue ahí");
	assert.equal(view.chat.children.length, 0);
});

test("un turno posterior se muestra solo, sin los mensajes anteriores", async (t) => {
	const view = mountFullscreen();
	t.after(() => view.close());
	assert.equal(clearSessionView(view.tui), 2);
	view.chat.addChild(lines(["mensaje nuevo"]));
	view.chat.addChild(lines(["respuesta nueva"]));
	const screen = await view.frame();
	assert.ok(screen.some((row) => row.includes("mensaje nuevo")), `el turno nuevo se ve, got ${JSON.stringify(screen)}`);
	assert.ok(screen.some((row) => row.includes("respuesta nueva")));
	assert.ok(!screen.some((row) => row.includes("hola usuario") || row.includes("respuesta del agente")), "lo anterior no vuelve");
});

test("los mensajes de la sesión y lo que recibe el modelo no cambian", async (t) => {
	const manager = fixtureSession(t);
	const file = manager.getSessionFile();
	const before = readFileSync(file!, "utf8");
	const contextBefore = JSON.stringify(manager.buildContextEntries());
	const view = mountFullscreen();
	t.after(() => view.close());
	assert.equal(clearSessionView(view.tui), 2);
	assert.equal(readFileSync(file!, "utf8"), before, "el archivo de sesión queda idéntico");
	const contextAfter = manager.buildContextEntries();
	assert.equal(JSON.stringify(contextAfter), contextBefore, "el contexto del turno siguiente es el mismo");
	assert.deepEqual(contextAfter.map((entry) => entry.type), ["message", "message", "message"]);
	const texts = JSON.stringify(contextAfter);
	for (const text of ["primer mensaje", "primera respuesta", "segundo mensaje"]) assert.ok(texts.includes(text), `el contexto conserva «${text}»`);
});

test("el comando avisa en español tras limpiar", async (t) => {
	const view = mountFullscreen();
	t.after(() => view.close());
	const host = fixtureHost();
	assert.equal(runSessionViewClear(view.tui, host), 2);
	assert.deepEqual(host.notices, [{ message: SESSION_VIEW_CLEAR_NOTICE, type: "info" }]);
	assert.match(SESSION_VIEW_CLEAR_NOTICE, /conserva todo el contexto/);
	assert.match(SESSION_VIEW_CLEAR_NOTICE, /reanuda la sesión/);
});

test("con un turno en curso no limpia y avisa", async (t) => {
	const view = mountFullscreen();
	t.after(() => view.close());
	const host = fixtureHost({ isIdle: () => false });
	assert.equal(runSessionViewClear(view.tui, host), undefined);
	assert.equal(view.chat.children.length, 2, "la vista no se toca a mitad de turno");
	assert.match(host.notices[0]?.message ?? "", /turno termine/);
	assert.equal(host.notices[0]?.type, "warning");
});

test("falla cerrado cuando la forma de Pi no coincide, sin tocar nada", () => {
	const document = new Container();
	const chat = new Container();
	document.addChild(new Container());
	document.addChild(chat); // falta el contenedor de recursos cargados
	chat.addChild(lines(["hola"]));
	const notices: Array<{ message: string; type?: string }> = [];
	let renders = 0;
	const tui = { mode: "regular", children: [document], requestRender: () => { renders++; } } as unknown as TUI;
	assert.equal(findSessionChatContainer(tui), undefined);
	assert.equal(runSessionViewClear(tui, { notify: (message, type) => notices.push({ message, type }), isIdle: () => true }), undefined);
	assert.equal(chat.children.length, 1, "el chat no se vació");
	assert.equal(renders, 0, "no pide repintado si no encontró la vista");
	assert.match(notices[0]?.message ?? "", /No se pudo localizar la vista/);
});

test("en el modo regular el documento es el primer hijo montado del TUI", () => {
	const document = new Container();
	const chat = new Container();
	document.addChild(new Container());
	document.addChild(new Container());
	document.addChild(chat);
	chat.addChild(lines(["hola"]));
	let renders = 0;
	const tui = { mode: "regular", children: [document, new Container()], requestRender: () => { renders++; } } as unknown as TUI;
	assert.equal(findSessionChatContainer(tui), chat);
	assert.equal(clearSessionView(tui), 1);
	assert.equal(renders, 1);
	assert.equal(chat.children.length, 0);
});

test("el contrato de Pi que localiza el chat sigue en su distribucion", () => {
	// Si Pi reordena el documento o deja de montarlo primero, el comando falla
	// cerrado (avisa y no limpia); esta prueba lo hace visible antes que el TUI.
	const source = readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js", import.meta.url), "utf8");
	const order = source.indexOf("this.documentContainer.addChild(this.headerContainer);");
	assert.ok(order > 0, "Pi sigue encadenando el documento");
	const sequence = source.slice(order, order + 400);
	const loaded = sequence.indexOf("this.documentContainer.addChild(this.loadedResourcesContainer);");
	const chat = sequence.indexOf("this.documentContainer.addChild(this.chatContainer);");
	assert.ok(loaded > 0 && chat > loaded, "el orden es encabezado, recursos cargados y conversación");
	assert.match(source, /this\.mountInteractiveTui\(this\.renderer, \[\s*this\.documentContainer,/, "el documento se monta primero");
	assert.match(source, /tui\.setLayoutRoot\(this\.fullscreenLayoutRoot\)/, "la pantalla completa monta el layout con el documento dentro");
});

test("la extensión registra /drakonc:clear con el módulo de la vista", () => {
	const source = readFileSync(new URL("../extensions/drakonc-shell.ts", import.meta.url), "utf8");
	assert.match(source, /import \{ runSessionViewClear \} from "\.\.\/lib\/session-view-clear\.ts";/);
	assert.match(source, /const CLEAR_COMMAND_NAME = "drakonc:clear";/);
	assert.match(source, /pi\.registerCommand\(CLEAR_COMMAND_NAME, \{[\s\S]{0,400}?runSessionViewClear\(sessionViewTui\(\), \{ notify: \(message, type\) => ctx\.ui\.notify\(message, type\), isIdle: \(\) => ctx\.isIdle\(\) \}\);/);
});
