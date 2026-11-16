import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import type { Project, TowerSnapshot } from "../web/tower/src/types.ts";

test("hover test typechecks and skips cleanly with only root dependencies", (t) => {
	const root = mkdtempSync(join(tmpdir(), "gentle-tower-hover-ci-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "tests"), { recursive: true });
	mkdirSync(join(root, "web", "tower", "src"), { recursive: true });
	for (const file of ["package.json", "tsconfig.json", "tests/tower-web-hover.test.ts", ...["types.ts", "model.ts", "art.ts", "scene.ts"].map((name) => `web/tower/src/${name}`)]) {
		copyFileSync(new URL(`../${file}`, import.meta.url), join(root, file));
	}
	// Link only the root installation. No nested web dependency directory exists.
	symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "junction");
	assert.equal(existsSync(join(root, "web", "tower", "node_modules")), false);
	const configFile = join(root, "tsconfig.json");
	const config = ts.readConfigFile(configFile, ts.sys.readFile);
	assert.equal(config.error, undefined);
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root, undefined, configFile);
	assert.deepEqual(parsed.errors, []);
	assert.deepEqual(parsed.fileNames, [join(root, "tests", "tower-web-hover.test.ts")]);
	const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options));
	const formatted = ts.formatDiagnostics(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: (file) => file, getNewLine: () => "\n" });
	assert.equal(diagnostics.length, 0, formatted);
	// A nested test runner must not inherit the outer runner's child-test protocol.
	const env = { ...process.env };
	delete env.NODE_TEST_CONTEXT;
	const args = ["--experimental-strip-types", "--test", "--test-reporter=tap", "--test-name-pattern=^Tower Pixi hover$", join(root, "tests", "tower-web-hover.test.ts")];
	const run = () => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10_000, env });
	const skipped = run();
	assert.equal(skipped.status, 0, `${skipped.stdout}\n${skipped.stderr}`);
	assert.match(skipped.stdout, /Tower Pixi hover/);
	assert.match(skipped.stdout, /install web\/tower dependencies to exercise Pixi hover/);
	// A present but broken install is an error, not a misleading dependency skip.
	mkdirSync(join(root, "web", "tower", "node_modules", "pixi.js"), { recursive: true });
	const broken = run();
	assert.notEqual(broken.status, 0);
	assert.match(`${broken.stdout}\n${broken.stderr}`, /ERR_MODULE_NOT_FOUND/);
});

// Load the same extensionless local imports Vite resolves, without starting a
// browser or replacing Pixi's event boundary with a synthetic hit test.
registerHooks({ resolve(specifier, context, next) {
	if (context.parentURL?.includes("/web/tower/src/") && /^\.\/[^.]+$/.test(specifier)) return next(`${specifier}.ts`, context);
	return next(specifier, context);
} });

type Listener = (event: { clientX: number; clientY: number }) => void;
class Canvas {
	width = 720;
	height = 450;
	style: { cursor?: string } = {};
	isConnected = true;
	listeners = new Map<string, Listener[]>();
	addEventListener(name: string, fn: Listener) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]); }
	dispatch(name: string, x: number, y: number) { for (const fn of this.listeners.get(name) ?? []) fn({ clientX: x, clientY: y }); }
	getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
	getContext() {
		const canvas = this;
		const gradient = { addColorStop() {} };
		return new Proxy({
			canvas,
			createLinearGradient: () => gradient,
			createRadialGradient: () => gradient,
			createPattern: () => ({}),
			createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
			getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
			measureText: (text: string) => ({ width: text.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
		} as Record<PropertyKey, unknown>, { get: (target, key) => target[key] ?? (() => {}) });
	}
}
class Tooltip {
	className = "";
	hidden = false;
	textContent = "";
	offsetWidth = 100;
	style = { transform: "" };
	setAttribute() {}
}
const tips: Tooltip[] = [];
Object.defineProperty(globalThis, "HTMLCanvasElement", { value: Canvas, configurable: true });
Object.defineProperty(globalThis, "CanvasRenderingContext2D", { value: class {}, configurable: true });
Object.defineProperty(globalThis, "Path2D", { value: class { constructor(_path?: string) {} }, configurable: true });
Object.defineProperty(globalThis, "matchMedia", { value: () => ({ matches: true }), configurable: true });
Object.defineProperty(globalThis, "innerWidth", { value: 720, configurable: true });
Object.defineProperty(globalThis, "document", { value: {
	createElement: (tag: string) => tag === "canvas" ? new Canvas() : new Tooltip(),
	body: { appendChild: (tip: Tooltip) => tips.push(tip) },
}, configurable: true });

// Root-only installs need not have the separately installed web project's dependencies.
// URL imports follow the runtime-only test convention: root tsc must not pull the
// Pixi scene into its graph, while the web project's own tsc still checks it.
const pixi = new URL("../web/tower/node_modules/pixi.js/", import.meta.url);
if (!existsSync(pixi)) {
	test("Tower Pixi hover", { skip: "install web/tower dependencies to exercise Pixi hover" }, () => {});
} else {
const { EventBoundary, FederatedPointerEvent } = await import(new URL("lib/events/index.mjs", pixi).href);
const { updateRenderGroupTransforms } = await import(new URL("lib/scene/container/utils/updateRenderGroupTransforms.mjs", pixi).href);
// The real renderer installs this mixin during initialization, which the canvas stub skips.
await import(new URL("lib/events/init.mjs", pixi).href);
const { TowerScene } = await import(new URL("../web/tower/src/scene.ts", import.meta.url).href);
const { room, floorLine, BX, BW } = await import(new URL("../web/tower/src/art.ts", import.meta.url).href);

async function setup() {
	const scene = new TowerScene();
	const canvas = new Canvas();
	const boundary = new EventBoundary(scene.app.stage);
	const frames: Array<{ fn: (ticker: { deltaMS: number }) => void; priority: number }> = [];
	const events = {
		rootBoundary: boundary,
		mapPositionToPoint: (point: { x: number; y: number }, x: number, y: number) => { point.x = x; point.y = y; },
		setCursor: (cursor: string) => { canvas.style.cursor = cursor === "default" ? "inherit" : cursor; },
	};
	scene.app.init = async () => {
		Object.defineProperty(scene.app, "renderer", { value: { canvas, events, resize(w: number, h: number) { canvas.width = w; canvas.height = h; } } });
		Object.defineProperty(scene.app, "ticker", { value: { add: (fn: (ticker: { deltaMS: number }) => void, _ctx?: unknown, priority = 0) => { frames.push({ fn, priority }); } } });
	};
	await scene.mount({ appendChild() {} } as unknown as HTMLElement);
	const session: TowerSnapshot = {
		version: 1, sessionId: "floor-1", name: "Alpha", project: { cwd: "/w/app", name: "app" }, model: "model",
		context: { percent: null, window: 0 }, cost: { total: 1, input: 0, output: 0 },
		todos: [{ id: 1, title: "Investigate", status: "in_progress" }], subagents: [{ id: "helper-1", role: "explore", name: "explore", status: "running", cost: 0, tokens: 0 }],
		phase: "implementing", permission: "normal", artifacts: [{ path: "/w/app/flow.mmd", kind: "diagram" }, { path: "/w/app/notes.md", kind: "doc" }, { path: "/w/app/shot.png", kind: "image" }], updatedAt: 1,
	};
	const project: Project = { id: "app", cwd: "/w/app", sessions: [session] };
	scene.show(project, ["#f095c8"]);
	// Renderer-free setup must still apply Pixi's actual world transforms before hit testing.
	scene.app.stage.enableRenderGroup();
	const render = () => updateRenderGroupTransforms(scene.app.stage.renderGroup!, true);
	render();
	const tip = tips.at(-1)!;
	const pixi = (name: string, x: number, y: number) => {
		render();
		const e = new FederatedPointerEvent(null);
		e.type = name; e.pointerType = "mouse"; e.pointerId = 1; e.button = 0; e.global.set(x, y);
		boundary.mapEvent(e);
		canvas.style.cursor = boundary.cursor ?? "inherit";
	};
	// Pixi renders at LOW priority (-25), between scene movement and hover.
	const nextFrame = () => {
		for (const f of frames.filter((f) => f.priority > -25)) f.fn({ deltaMS: 16 });
		render();
		for (const f of frames.filter((f) => f.priority < -25)) f.fn({ deltaMS: 16 });
	};
	const move = (x: number, y: number) => { pixi("pointermove", x, y); canvas.dispatch("pointermove", x, y); nextFrame(); };
	const click = (x: number, y: number) => { pixi("pointerdown", x, y); pixi("pointerup", x, y); };
	return { scene, session, project, tip, canvas, move, click, frame: nextFrame };
}

const roomCases = [
	["map", "Tasks · floor 1"], ["workshop", "Floor 1 · Talk, Tasks, Artifacts"],
	["lab", "Floor 1 · Talk, Tasks, Artifacts"], ["review", "Floor 1 · Talk, Tasks, Artifacts"],
	["engram", "Engram library"], ["engine", "Your tab"], ["lounge", "Your tab"],
] as const;

test("hovering every room keeps its own label and cursor through stationary frames and clicks", async () => {
	const { scene, tip, canvas, move, click } = await setup();
	const selected: string[] = [];
	scene.onRoom = (id, floor) => selected.push(`${id}:${floor}`);
	const y = scene.layout!.roof + 14;
	// Start on LOUNGE, then visit MAP and the other rooms, with a held pointer.
	for (const [id, label] of [roomCases[6], ...roomCases]) {
		const x = room(id).x + 3;
		for (let i = 0; i < 30; i++) {
			move(x, y);
			assert.equal(tip.hidden, false, `${id} frame ${i}`);
			assert.equal(tip.textContent, label, `${id} frame ${i}`);
			assert.equal(canvas.style.cursor, "pointer", `${id} frame ${i}`);
		}
		const before = selected.length;
		click(x, y);
		assert.equal(selected.length, before + 1);
		assert.equal(selected.at(-1), `${id}:0`);
	}
	// Decoration is not a separate target: notes and the elephant still click the room.
	for (const [id, x, y] of [["map", room("map").x + 12, scene.layout!.roof + 35], ["engram", room("engram").x + 65, floorLine(scene.layout!, 0) - 12]] as const) {
		move(x, y); click(x, y);
		assert.equal(tip.textContent, id === "map" ? "Tasks · floor 1" : "Engram library");
		assert.equal(selected.at(-1), `${id}:0`);
	}
});

test("people, artifact and door own hover and clicks over rooms, including after a redraw", async () => {
	const { scene, session, project, tip, canvas, move, click, frame } = await setup();
	const picks: string[] = [], doors: number[] = [], artifacts: string[] = [];
	scene.onPick = (p) => { if (p) picks.push(p.kind === "helper" ? p.helper!.id : p.session.name); };
	scene.onDoor = (floor) => doors.push(floor);
	scene.onArtifact = (_floor, artifact) => artifacts.push(artifact.path);
	const L = scene.layout!;
	const cases = [
		{ x: room("workshop").x + 14, y: floorLine(L, 0) - 20, label: "Talk to Alpha", action: () => assert.equal(picks.at(-1), "Alpha") },
		{ x: room("map").x + 14, y: floorLine(L, 0) - 20, label: "explore · running · details", action: () => assert.equal(picks.at(-1), "helper-1") },
		{ x: room("map").x + 50, y: L.roof + 33, label: "Open diagram: flow.mmd", action: () => assert.equal(artifacts.at(-1), "/w/app/flow.mmd") },
		{ x: room("workshop").x + 50, y: L.roof + 33, label: "Open image: shot.png", action: () => assert.equal(artifacts.at(-1), "/w/app/shot.png") },
		{ x: room("workshop").x + 70, y: L.roof + 66, label: "Open doc: notes.md", action: () => assert.equal(artifacts.at(-1), "/w/app/notes.md") },
		{ x: BX + BW + 19, y: L.lobby + 42, label: "Permissions: normal · floor 1", action: () => assert.equal(doors.at(-1), 0) },
		{ x: BX + BW - 10, y: L.lobby + 20, label: "Permissions: normal · floor 1", action: () => assert.equal(doors.at(-1), 0) },
	];
	for (const c of cases) {
		for (let i = 0; i < 30; i++) {
			move(c.x, c.y);
			assert.equal(tip.hidden, false, `${c.label} frame ${i}`);
			assert.equal(tip.textContent, c.label, `${c.label} frame ${i}`);
			assert.equal(canvas.style.cursor, "pointer", `${c.label} frame ${i}`);
		}
		const before = picks.length + doors.length + artifacts.length;
		click(c.x, c.y); c.action();
		assert.equal(picks.length + doors.length + artifacts.length, before + 1, c.label);
	}
	// Live snapshots reconstruct the door while the pointer has not moved.
	session.permission = "auto";
	scene.show(project, ["#f095c8"]);
	frame();
	assert.equal(tip.hidden, false);
	assert.equal(tip.textContent, "Permissions: auto · floor 1");
	const door = cases.at(-1)!;
	const before = doors.length;
	click(door.x, door.y);
	assert.equal(doors.length, before + 1);
	assert.equal(doors.at(-1), 0);
	// Moving a person on a new snapshot also resolves the old position to the room.
	move(cases[0].x, cases[0].y);
	session.phase = "checking";
	scene.show(project, ["#f095c8"]);
	frame();
	assert.equal(tip.textContent, "Floor 1 · Talk, Tasks, Artifacts");
	move(room("lab").x + 14, floorLine(L, 0) - 20);
	assert.equal(tip.textContent, "Talk to Alpha");
});

test("leaving the building clears the previous label and canvas cursor", async () => {
	const { scene, tip, canvas, move } = await setup();
	move(room("lounge").x + 3, scene.layout!.roof + 14);
	assert.equal(tip.textContent, "Your tab");
	move(20, 20);
	assert.equal(tip.hidden, true);
	assert.notEqual(canvas.style.cursor, "pointer");
	move(room("lounge").x + 3, scene.layout!.roof + 14);
	canvas.dispatch("pointerleave", 0, 0);
	assert.equal(tip.hidden, true);
	assert.notEqual(canvas.style.cursor, "pointer");
});
}
