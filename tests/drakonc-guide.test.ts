import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import installDrakoncGuide, { GUIDE_AGENT_REQUEST, GUIDE_PROMPT_HINT } from "../extensions/drakonc-guide.ts";
import { GUIDE_STEPS, GuidePopover, GuideTour, guidePlacement, guideSteps, type GuideStep } from "../lib/drakonc-guide.ts";
import { sidebarState } from "../lib/shell-sidebar.ts";
import { buildCommandPaletteGroups } from "../lib/command-palette-catalog.ts";
import { stripAnsi } from "../lib/terminal-theme.ts";
import { isolatedConfigEnv, keymapsConfigHome, removeIsolatedConfigHomes } from "./isolated-config-home.ts";

// /drakonc:guide: a driver.js-style tour. Each step is a popover next to the
// part of the screen it describes; the agent drives it with the drakonc_guide
// tool and explains each step in the chat, or the user steps through it
// locally with the arrow keys when no agent is available.

after(removeIsolatedConfigHomes);

const plainTheme = { fg: (_color: string, text: string) => text };
const ALL = new Set(GUIDE_STEPS.flatMap((step) => step.requires ? [step.requires] : []));

function sample(): GuideStep[] {
	return [
		{ id: "welcome", title: "Welcome", body: "Hello there.", region: "center" },
		{ id: "palette", title: "Command palette", body: "Every command, searchable.", region: "editor", command: "drakonc:commands", keymap: "commands" },
		{ id: "end", title: "Done", body: "Bye.", region: "center" },
	];
}

test("the tour keeps only steps whose command or tool exists, and starts with a welcome and ends with a goodbye", () => {
	const full = guideSteps(ALL);
	assert.equal(full[0]!.id, "welcome");
	assert.equal(full.at(-1)!.id, "end");
	assert.ok(full.length >= 12, "it covers what Drakonc Shell can do");
	const bare = guideSteps(new Set(["drakonc:commands"]));
	assert.deepEqual(bare.map((step) => step.id), ["welcome", "prompt", "palette", "end"]);
	for (const step of GUIDE_STEPS) assert.ok(step.title && step.body, step.id);
});

test("the popover shows the step, its counter, how to try it with its current key, and the local keys", () => {
	const tour = new GuideTour(sample());
	tour.next();
	const popover = new GuidePopover({ tour, mode: "local", theme: plainTheme, env: isolatedConfigEnv({ DRAKONC_PI_CONFIG_HOME: keymapsConfigHome({ commands: "alt+j" }) }), done: () => {} });
	const text = popover.render(56).map(stripAnsi).join("\n");
	assert.match(text, /Command palette\s+2\/3/);
	assert.match(text, /Every command, searchable\./);
	assert.match(text, /Prueba: \/drakonc:commands · alt\+j/);
	assert.match(text, /→ siguiente · ← atrás · esc salir/);
	for (const line of popover.render(56)) assert.ok(stripAnsi(line).length <= 56, line);
	const agent = new GuidePopover({ tour, mode: "agent", theme: plainTheme, env: isolatedConfigEnv({}), done: () => {} });
	assert.match(agent.render(56).map(stripAnsi).join("\n"), /Chat: \/drakonc:guide stop termina/);
});

test("los textos en español caben en el ancho de la ventana y no se cortan", () => {
	const env = isolatedConfigEnv({});
	for (const step of guideSteps(ALL)) {
		for (const mode of ["local", "agent"] as const) {
			const tour = new GuideTour(GUIDE_STEPS);
			tour.show(step.id);
			for (const width of [40, 56]) {
				for (const line of new GuidePopover({ tour, mode, theme: plainTheme, env, done: () => {} }).render(width).map(stripAnsi)) {
					assert.ok(line.length <= width, `${step.id}/${width}: ${line}`);
					assert.ok(!line.includes("…"), `${step.id}/${width} se corta: ${line}`);
				}
			}
		}
	}
});

test("locally, arrows and enter move through the steps, and esc or the last step ends the tour", () => {
	const results: string[] = [];
	const tour = new GuideTour(sample());
	const popover = new GuidePopover({ tour, mode: "local", theme: plainTheme, env: isolatedConfigEnv({}), done: (result) => results.push(result) });
	popover.handleInput("\x1b[C");
	assert.equal(tour.current().id, "palette");
	popover.handleInput("\x1b[D");
	assert.equal(tour.current().id, "welcome");
	popover.handleInput("\x1b[D");
	assert.equal(tour.current().id, "welcome", "back on the first step stays there");
	popover.handleInput("\r");
	popover.handleInput(" ");
	assert.equal(tour.current().id, "end");
	popover.handleInput("\r");
	assert.deepEqual(results, ["finished"]);
	const early: string[] = [];
	new GuidePopover({ tour: new GuideTour(sample()), mode: "local", theme: plainTheme, env: isolatedConfigEnv({}), done: (result) => early.push(result) }).handleInput("\x1b");
	assert.deepEqual(early, ["ended"]);
});

test("the popover sits beside the region it describes and never takes the prompt's focus in agent mode", () => {
	assert.deepEqual(guidePlacement("sidebar", 160, 53, "local"), { anchor: "right-center", offsetX: -54, width: 56, nonCapturing: false });
	assert.deepEqual(guidePlacement("sidebar", 120, undefined, "agent"), { anchor: "center", width: 56, nonCapturing: true });
	assert.deepEqual(guidePlacement("editor", 100, undefined, "agent"), { anchor: "bottom-center", offsetY: -6, width: 56, nonCapturing: true });
	assert.deepEqual(guidePlacement("center", 44, undefined, "local"), { anchor: "center", width: 40, nonCapturing: false });
});

interface Overlay { component: { render(width: number): string[]; handleInput(data: string): void }; options: () => Record<string, unknown>; done(value: unknown): void; settled: Promise<unknown> }

function harness(options: { model?: boolean; env?: NodeJS.ProcessEnv } = {}) {
	const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
	const tools = new Map<string, { execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<{ content: { text: string }[] }> }>();
	const handlers = new Map<string, (event: unknown, ctx?: ExtensionContext) => unknown>();
	const messages: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
	const pi = {
		registerCommand: (name: string, command: never) => commands.set(name, command),
		registerTool: (tool: { name: string }) => tools.set(tool.name, tool as never),
		on: (name: string, handler: never) => handlers.set(name, handler),
		getCommands: () => [{ name: "drakonc:commands" }, { name: "drakonc:guide" }],
		getAllTools: () => [],
		sendMessage: (message: Record<string, unknown>, sendOptions: Record<string, unknown>) => messages.push({ message, options: sendOptions }),
	} as unknown as ExtensionAPI;
	installDrakoncGuide(pi, isolatedConfigEnv(options.env ?? {}));
	const overlays: Overlay[] = [];
	const notices: string[] = [];
	const tui = { terminal: { columns: 160, rows: 40 }, requestRender() {} };
	const ctx = {
		hasUI: true, mode: "tui", model: options.model === false ? undefined : { id: "m", provider: "p" }, isIdle: () => true,
		ui: {
			notify: (message: string) => notices.push(message),
			custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Overlay["component"], customOptions: { overlayOptions: Record<string, unknown> | (() => Record<string, unknown>) }) => {
				let resolve!: (value: unknown) => void;
				const settled = new Promise((done) => { resolve = done; });
				// Pi reads overlay options once, when the overlay opens.
				const placed = typeof customOptions.overlayOptions === "function" ? customOptions.overlayOptions() : customOptions.overlayOptions;
				const overlay = { options: () => placed, settled } as Overlay;
				overlay.done = resolve;
				overlay.component = factory(tui, plainTheme, undefined, resolve);
				overlays.push(overlay);
				return settled;
			},
		},
	} as unknown as ExtensionContext;
	const call = async (params: unknown) => (await tools.get("drakonc_guide")!.execute("t", params, undefined, undefined, ctx)).content[0]!.text;
	return { commands, tools, handlers, messages, overlays, notices, ctx, tui, call };
}

test("/drakonc:guide asks the agent to drive the tour, which shows one step at a time beside the prompt", async () => {
	const h = harness();
	await h.commands.get("drakonc:guide")!.handler("", h.ctx);
	assert.deepEqual(h.messages, [{ message: { customType: "drakonc-guide", content: GUIDE_AGENT_REQUEST, display: false }, options: { triggerTurn: true } }]);
	assert.deepEqual(h.notices, ["Iniciando el recorrido guiado con el agente…"]);
	const started = await h.call({ action: "start" });
	assert.match(started, /^Paso 1\/4 · Bienvenido a Drakonc Shell/);
	assert.match(started, /Pasos del recorrido: Bienvenido a Drakonc Shell, El prompt, Paleta de comandos, Fin del recorrido/);
	assert.equal(h.overlays.length, 1);
	assert.equal(h.overlays[0]!.options().nonCapturing, true, "el usuario sigue escribiendo en el prompt");
	assert.match(await h.call({ action: "next" }), /^Paso 2\/4 · El prompt/);
	assert.equal(await h.overlays[0]!.settled, "moved", "un paso de otra región reabre la ventana allí");
	assert.equal(h.overlays.length, 2);
	assert.match(h.overlays[1]!.component.render(56).map(stripAnsi).join("\n"), /El prompt\s+2\/4/);
	assert.deepEqual(h.overlays[1]!.options(), { anchor: "bottom-center", offsetY: -6, width: 56, nonCapturing: true });
	assert.match(await h.call({ action: "show", step: "palette" }), /^Paso 3\/4 · Paleta de comandos/);
	assert.match(await h.call({ action: "show", step: "nope" }), /Paso desconocido "nope"\. Pasos: welcome, prompt, palette, end/);
	assert.match(await h.call({ action: "previous" }), /^Paso 2\/4/);
	await h.call({ action: "next" });
	assert.match(await h.call({ action: "next" }), /^Paso 4\/4 · Fin del recorrido.*\nEste es el último paso: llama a drakonc_guide con action "end"/s);
	assert.match(await h.call({ action: "next" }), /Este era el último paso/);
	assert.equal(await h.call({ action: "end" }), "Recorrido terminado.");
	assert.equal(await h.overlays.at(-1)!.settled, "ended", "la ventana se cierra");
	assert.equal(await h.call({ action: "next" }), 'No hay ningún recorrido en marcha. Llama a drakonc_guide con action "start".');
});

test("/drakonc:guide stop and session shutdown close the popover; starting again replaces it", async () => {
	const h = harness();
	await h.call({ action: "start" });
	await h.call({ action: "start" });
	assert.equal(h.overlays.length, 2);
	await h.overlays[0]!.settled;
	await h.commands.get("drakonc:guide")!.handler("stop", h.ctx);
	await h.overlays[1]!.settled;
	assert.equal(h.notices.at(-1), "Recorrido guiado terminado.");
	await h.commands.get("drakonc:guide")!.handler("stop", h.ctx);
	assert.equal(h.notices.at(-1), "No hay ningún recorrido guiado en marcha.");
	await h.call({ action: "start" });
	h.handlers.get("session_shutdown")!({});
	await h.overlays[2]!.settled;
});

test("without a model, or with local, the tour runs locally with the arrow keys", async () => {
	for (const [model, args] of [[false, ""], [true, "local"]] as const) {
		const h = harness({ model });
		const run = h.commands.get("drakonc:guide")!.handler(args, h.ctx);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(h.messages.length, 0, "ningún turno del agente");
		assert.equal(h.overlays[0]!.options().nonCapturing, false, "la ventana se queda con las teclas");
		for (let i = 0; i < 4; i++) {
			h.overlays.at(-1)!.component.handleInput("\r");
			await new Promise((resolve) => setImmediate(resolve));
		}
		await run;
		assert.equal(h.overlays.length, 3, "bienvenida, luego el prompt abajo y luego vuelta al centro");
		assert.equal(h.notices.at(-1), "Recorrido completado. Ejecuta /drakonc:guide cuando quieras verlo otra vez.");
	}
});

test("the agent is told about the tour, children get neither the tool nor the command", () => {
	const h = harness();
	const event = { systemPromptOptions: { appendSystemPrompt: "" } };
	h.handlers.get("before_agent_start")!(event);
	assert.equal(event.systemPromptOptions.appendSystemPrompt, GUIDE_PROMPT_HINT);
	const child = harness({ env: { DRAKONC_PI_AGENTS_CHILD: "1" } });
	assert.equal(child.commands.size + child.tools.size, 0);
	assert.ok(sidebarState(h.tui as never), "the fake terminal carries sidebar state");
});

test("without a terminal the agent still walks the steps in text, and no popover opens", async () => {
	const h = harness();
	(h.ctx as unknown as { mode: string }).mode = "rpc";
	assert.match(await h.call({ action: "start" }), /^Paso 1\/4 · Bienvenido a Drakonc Shell/);
	assert.match(await h.call({ action: "next" }), /^Paso 2\/4 · El prompt/);
	assert.equal(await h.call({ action: "end" }), "Recorrido terminado.");
	assert.equal(h.overlays.length, 0);
	assert.equal(await h.call({ action: "next" }), 'No hay ningún recorrido en marcha. Llama a drakonc_guide con action "start".');
});

test("the palette lists the guided tour", () => {
	const groups = buildCommandPaletteGroups([{ name: "drakonc:guide", description: "Tour" }], {});
	assert.deepEqual(groups.flatMap((group) => group.items.map((item) => [group.title, item.label])), [["Session", "Guided tour of Drakonc Shell"]]);
});

test("a usage error lists the accepted arguments", async () => {
	const h = harness();
	await h.commands.get("drakonc:guide")!.handler("bogus", h.ctx);
	assert.equal(h.notices.at(-1), "Uso: /drakonc:guide [local|stop]");
});
