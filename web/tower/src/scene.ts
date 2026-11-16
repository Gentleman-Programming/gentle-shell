// The Pixi scene: one painted building per project, animated people on top.
import { AnimatedSprite, Application, Container, Graphics, Sprite, Text, Texture, TextureSource, UPDATE_PRIORITY } from "pixi.js";
import { ANIMS, BX, BW, bubble, elephant, figure, floorLine, floorTop, FPS, LOBBY_H, paintBackground, room, type Anim, type Layout, type Look } from "./art";
import { floorState, helperRoom, orchestratorRoom, type RoomId } from "./model";
import type { Project, TowerArtifact, TowerSnapshot, TowerSubagent } from "./types";

/** Strictness order; the door shows the most permissive floor of the building. */
export const MODE_RANK: Record<string, number> = { normal: 0, auto: 1, yolo: 2, "super-yolo": 3 };

TextureSource.defaultOptions.scaleMode = "nearest";

export interface Pick { kind: "orchestrator" | "helper"; floor: number; session: TowerSnapshot; helper?: TowerSubagent }

interface Person { key: string; sprite: AnimatedSprite; anim: Anim; look: Look; x: number; tx: number; floor: number; pick: Pick; badge?: Sprite }

const textureCache = new Map<string, Texture[]>();
function frames(look: Look, anim: Anim): Texture[] {
	const key = JSON.stringify(look) + anim;
	let t = textureCache.get(key);
	if (!t) { t = ANIMS[anim].map((p) => Texture.from(figure(look, p))); textureCache.set(key, t); }
	return t;
}
const BUBBLES = { need: () => Texture.from(bubble("need")), done: () => Texture.from(bubble("done")) };
let bubbleTex: { need: Texture; done: Texture } | undefined;
let elephantTex: Texture | undefined;

const ROLE_LOOK: Record<string, Look> = {
	explore: { shirt: "#2a8a9a", hat: "cap", mustache: false },
	worker: { shirt: "#c89a3a", hat: "hard", mustache: false },
	verify: { shirt: "#d8d4e4", hat: "goggles", coat: true, mustache: false },
};
const lookFor = (a: TowerSubagent): Look => ROLE_LOOK[a.role] ?? { shirt: "#8a7a98", mustache: false };
function animFor(p: Pick, roomId: RoomId, walking: boolean, reduce: boolean): Anim {
	if (walking) return "walk";
	if (reduce) return "idle";
	if (p.kind === "orchestrator") { const st = floorState(p.session); return st === "need" ? "wave" : st === "done" ? "sip" : roomId === "workshop" ? "type" : "think"; }
	if (roomId === "lounge") return "sip";
	if (roomId === "lab") return "clip";
	if (roomId === "map" || roomId === "engram") return "read";
	if (roomId === "workshop") return "type";
	return "idle";
}
const ROOM_IDS: RoomId[] = ["map", "workshop", "lab", "review", "engram", "engine", "lounge"];
/** What a click on a room does, named for the hover label. */
const roomAction = (id: RoomId, floor: number) => (id === "map" ? `Tasks · floor ${floor + 1}` : id === "engram" ? "Engram library" : id === "lounge" || id === "engine" ? "Your tab" : `Floor ${floor + 1} · Talk, Tasks, Artifacts`);
export interface Rect { x: number; y: number; w: number; h: number }
interface Hover { label: () => string; rect: () => Rect | undefined; room?: boolean }
const boundsOf = (c: Container): Rect | undefined => { if (c.destroyed) return undefined; const b = c.getBounds(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };

const roomX = (id: RoomId, slot: number) => { const r = room(id); return r.x + 14 + ((slot * 17) % Math.max(18, r.w - 22)); };

export class TowerScene {
	app = new Application();
	private bg = new Sprite();
	private people = new Container();
	private props = new Container();
	private notes = new Graphics();
	private byKey = new Map<string, Person>();
	layout: Layout | undefined;
	onPick: (p: Pick | undefined) => void = () => {};
	onRoom: (room: RoomId, floor: number) => void = () => {};
	onDoor: (floor: number) => void = () => {};
	onArtifact: (floor: number, artifact: TowerArtifact) => void = () => {};
	private world = new Container();
	private door = new Container();
	private floors = 0;
	private reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
	private bgKey = "";
	/** Hover feedback: an outline over what a click would act on, and a label naming the action. */
	private glow = new Graphics();
	private hovered: Hover | undefined;
	private hotTargets = new WeakMap<Container, Hover>();
	private tip = document.createElement("div");
	private tipText = "";
	private pointer = { x: 0, y: 0 };
	private pointerInside = false;

	/** The room under a scene point, with its floor. */
	private roomAt(x: number, y: number): { id: RoomId; floor: number } | undefined {
		const L = this.layout; if (!L) return undefined;
		const floor = Math.floor((y - L.roof) / 100);
		const id = ROOM_IDS.find((r) => { const d = room(r); return x >= d.x && x < d.x + d.w; });
		return id && floor >= 0 && floor < this.floors ? { id, floor } : undefined;
	}
	/** A room's rectangle on a floor, in scene units. */
	roomRect(id: RoomId, floor: number): Rect | undefined {
		const L = this.layout; if (!L || floor < 0 || floor >= this.floors) return undefined;
		const r = room(id);
		return { x: r.x, y: floorTop(L, floor) + 6, w: r.w, h: 84 };
	}
	/** A whole floor of rooms, in scene units. */
	floorRect(floor: number): Rect | undefined {
		const a = this.roomRect("map", floor), b = this.roomRect("lounge", floor);
		return a && b ? { x: a.x, y: a.y, w: b.x + b.w - a.x, h: a.h } : undefined;
	}
	/** The orchestrator of a floor, in scene units. */
	personRect(floor: number): Rect | undefined {
		const p = [...this.byKey.values()].find((x) => x.floor === floor && x.pick.kind === "orchestrator");
		return p ? boundsOf(p.sprite) : undefined;
	}
	doorRect(): Rect | undefined { return this.door.children.length ? boundsOf(this.door) : undefined; }
	/** Scene units to page (client) pixels: the canvas is scaled by CSS. */
	toClient(r: Rect): Rect {
		const c = this.app.canvas, b = c.getBoundingClientRect(), k = b.width / (c.width || 1);
		return { x: b.left + r.x * k, y: b.top + r.y * k, w: r.w * k, h: r.h * k };
	}
	/** Registers the same object for clicks and for the frame's single hover owner. */
	private hot(c: Container, label: () => string) {
		c.eventMode = "static"; c.cursor = "pointer";
		this.hotTargets.set(c, { label, rect: () => boundsOf(c) });
	}
	private updateHover() {
		const events = this.app.renderer.events;
		let h: Hover | undefined;
		let r: { id: RoomId; floor: number } | undefined;
		if (this.pointerInside) {
			const p = { x: 0, y: 0 };
			events.mapPositionToPoint(p, this.pointer.x, this.pointer.y);
			// Use Pixi's own topmost click target, after movement and snapshot redraws.
			const target = events.rootBoundary.hitTest(p.x, p.y);
			if (target === this.bg) r = this.roomAt(p.x, p.y);
			else if (target) h = this.hotTargets.get(target);
		}
		this.bg.cursor = r ? "pointer" : "default";
		if (r) h = { room: true, label: () => roomAction(r!.id, r!.floor), rect: () => this.roomRect(r!.id, r!.floor) };
		this.hovered = h;
		events.setCursor(h ? "pointer" : "default");
		this.drawHover();
	}
	private drawHover() {
		const g = this.glow.clear(), h = this.hovered, r = h?.rect();
		if (!h || !r) { this.hovered = undefined; this.tip.hidden = true; this.tipText = ""; return; }
		if (h.room) g.rect(r.x + .5, r.y + .5, r.w - 1, r.h - 1).fill({ color: 0xffb1dd, alpha: .1 }).stroke({ width: 1, color: 0xff76c3, alpha: .95 });
		else g.roundRect(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3, 2).fill({ color: 0xffb1dd, alpha: .14 }).stroke({ width: 1, color: 0xffb1dd });
		const text = h.label(), was = this.tipText;
		if (!text) { this.tip.hidden = true; this.tipText = ""; return; }
		if (text === was && !this.tip.hidden) return;
		this.tipText = text; this.tip.textContent = text; this.tip.hidden = false;
		this.placeTip();
	}
	private placeTip() {
		const w = this.tip.offsetWidth, x = Math.min(this.pointer.x + 14, innerWidth - w - 8);
		this.tip.style.transform = `translate(${Math.max(8, x)}px, ${this.pointer.y + 18}px)`;
	}

	async mount(host: HTMLElement): Promise<void> {
		await this.app.init({ width: 720, height: 450, background: "#07040d", antialias: false, resolution: 1, autoDensity: false, preference: "webgl" });
		host.appendChild(this.app.canvas);
		this.app.stage.addChild(this.bg, this.notes, this.props, this.world, this.door, this.people, this.glow);
		// A static stage makes passive decoration inherit interactivity, intercepting
		// the very target whose hover drew it. Only actual click targets are active.
		this.app.stage.eventMode = "passive";
		this.notes.eventMode = this.props.eventMode = this.glow.eventMode = "none";
		this.bg.eventMode = "static";
		this.bg.on("pointertap", (e) => {
			const p = e.getLocalPosition(this.bg), r = this.roomAt(p.x, p.y);
			if (r) this.onRoom(r.id, r.floor); else this.onPick(undefined);
		});
		this.tip.className = "tip px"; this.tip.setAttribute("role", "tooltip"); this.tip.hidden = true;
		document.body.appendChild(this.tip);
		const canvas = this.app.canvas;
		const track = (e: PointerEvent) => { this.pointerInside = true; this.pointer = { x: e.clientX, y: e.clientY }; if (!this.tip.hidden) this.placeTip(); };
		canvas.addEventListener("pointerenter", track);
		canvas.addEventListener("pointermove", track);
		canvas.addEventListener("pointerleave", () => { this.pointerInside = false; this.updateHover(); });
		bubbleTex = { need: BUBBLES.need(), done: BUBBLES.done() };
		elephantTex = Texture.from(elephant());
		this.app.ticker.add((t) => this.tick(t.deltaMS / 1000));
		// Pixi updates world transforms during its LOW-priority render. Resolve
		// hover afterwards, against the same positions that were just painted.
		this.app.ticker.add(() => this.updateHover(), undefined, UPDATE_PRIORITY.UTILITY);
	}

	show(project: Project, colors: string[], reviewOn = true, minHeight = 450): void {
		const key = `${project.cwd}|${project.sessions.length}|${colors.join()}|${reviewOn}|${Math.round(minHeight)}`;
		if (key !== this.bgKey) {
			this.bgKey = key;
			const { canvas, layout } = paintBackground({ floors: project.sessions.length, colors, projectName: project.id, projectColor: colors[0] ?? "#f095c8", reviewOn, minHeight });
			this.layout = layout;
			// Each background is a fresh canvas texture: free the one it replaces (never the shared character textures).
			const previous = this.bg.texture;
			this.bg.texture = Texture.from(canvas);
			if (previous && previous !== Texture.EMPTY && previous !== Texture.WHITE) previous.destroy(true);
			this.app.renderer.resize(canvas.width, canvas.height);
			this.props.removeChildren();
			for (let i = 0; i < project.sessions.length; i++) {
				const e = new Sprite(elephantTex);
				e.x = room("engram").x + 58; e.y = floorLine(layout, i) - 24;
				this.props.addChild(e);
			}
			for (const p of this.byKey.values()) p.sprite.destroy();
			this.byKey.clear();
			this.people.removeChildren();
		}
		const L = this.layout!;
		this.floors = project.sessions.length;
		this.drawNotes(project, L);
		this.drawWorld(project, L);
		this.drawDoor(project, L);
		const seen = new Set<string>();
		project.sessions.forEach((s, floor) => {
			const slots = new Map<RoomId, number>();
			const place = (id: RoomId) => { const n = slots.get(id) ?? 0; slots.set(id, n + 1); return roomX(id, n); };
			const orch: Pick = { kind: "orchestrator", floor, session: s };
			this.upsert(`${s.sessionId}:orch`, { shirt: colors[floor], orch: true, hat: "bowler" }, orch, place(orchestratorRoom(s)), floor, L);
			for (const a of s.subagents.slice(0, 8)) this.upsert(`${s.sessionId}:${a.id}`, lookFor(a), { kind: "helper", floor, session: s, helper: a }, place(helperRoom(a)), floor, L);
			for (const k of [`${s.sessionId}:orch`, ...s.subagents.slice(0, 8).map((a) => `${s.sessionId}:${a.id}`)]) seen.add(k);
		});
		for (const [k, p] of this.byKey) if (!seen.has(k)) { p.sprite.destroy(); p.badge?.destroy(); this.byKey.delete(k); }
	}

	/** Live bits on every floor: the cost meter, and the artifacts where they were made. */
	private drawWorld(project: Project, L: Layout) {
		for (const c of this.world.removeChildren()) c.destroy();
		const engine = room("engine"), map = room("map"), shop = room("workshop");
		project.sessions.forEach((s, i) => {
			const y0 = floorTop(L, i);
			if (!s.basic) {
				const meter = new Text({ text: `$${s.cost.total.toFixed(2)}`, style: { fontFamily: "Iosevka Term, JetBrains Mono, monospace", fontSize: 10, fontWeight: "800", fill: 0x1a1028 } });
				meter.eventMode = "none"; meter.resolution = 4; meter.x = engine.x + 44; meter.y = y0 + 30;
				this.world.addChild(meter);
			}
			const newest = (kind: TowerArtifact["kind"]) => s.artifacts?.find((a) => a.kind === kind);
			const hot = (g: Graphics, a: TowerArtifact | undefined) => {
				if (!a) return;
				this.hot(g, () => `Open ${a.kind}: ${a.path.split("/").pop() ?? a.path}`);
				g.on("pointertap", (e) => { e.stopPropagation(); this.onArtifact(i, a); });
				this.world.addChild(g);
			};
			// a diagram is pinned on the map corkboard
			const d = newest("diagram");
			if (d) { const g = new Graphics(); g.rect(map.x + 44, y0 + 28, 15, 11).fill(0x2a4a8a).rect(map.x + 46, y0 + 30, 4, 3).stroke({ width: .6, color: 0xcfe0ff }).rect(map.x + 52, y0 + 34, 4, 3).stroke({ width: .6, color: 0xcfe0ff }).circle(map.x + 51, y0 + 28, 1.6).fill(0xff76c3); hot(g, d); }
			// a document lies on the workshop desk
			const doc = newest("doc");
			if (doc) { const g = new Graphics(); g.rect(shop.x + 66, y0 + 65, 11, 4).fill(0xe0b84a).rect(shop.x + 66, y0 + 67, 11, 1).fill(0xc89a3a); hot(g, doc); }
			// an image hangs framed on the workshop wall
			const img = newest("image");
			if (img) { const g = new Graphics(); g.rect(shop.x + 44, y0 + 28, 13, 11).fill(0x8a6a4a).rect(shop.x + 45, y0 + 29, 11, 9).fill(0xe4dcee).rect(shop.x + 46, y0 + 30, 9, 2).fill(0x2a1838).rect(shop.x + 47, y0 + 35, 7, 2).fill(0xffb1dd); hot(g, img); }
		});
	}

	/** The door and its bouncer show the most permissive floor: rope closed (normal), half open (auto), BRB (yolo), wide open (super-yolo). */
	private drawDoor(project: Project, L: Layout) {
		for (const c of this.door.removeChildren()) c.destroy();
		let floor = -1, rank = -1;
		project.sessions.forEach((s, i) => { const r = MODE_RANK[s.permission ?? ""] ?? -1; if (r > rank) { rank = r; floor = i; } });
		if (floor < 0) return;
		const mode = project.sessions[floor].permission!;
		const dx = BX + BW + 4, dy = L.lobby + LOBBY_H;
		const g = new Graphics();
		if (mode === "normal" || mode === "auto") {
			for (const x of [dx + 2, dx + 26]) g.rect(x, dy - 16, 2, 16).fill(0xc8a060).circle(x + 1, dy - 17, 2).fill(0xc8a060);
			if (mode === "normal") g.moveTo(dx + 3, dy - 14).quadraticCurveTo(dx + 15, dy - 6, dx + 27, dy - 14).stroke({ width: 2, color: 0xc83a5a });
			else g.moveTo(dx + 27, dy - 14).lineTo(dx + 28, dy - 3).stroke({ width: 2, color: 0xc83a5a });
		}
		if (mode === "super-yolo") g.rect(BX + BW - 14, L.lobby + 14, 30, LOBBY_H - 24).fill({ color: 0xe0c27a, alpha: .4 });
		g.rect(dx - 18, L.lobby + 4, 46, LOBBY_H - 4).fill({ color: 0x000000, alpha: 0.001 });
		const label = () => `Permissions: ${mode} · floor ${floor + 1}`;
		this.hot(g, label);
		g.on("pointertap", (e) => { e.stopPropagation(); this.onDoor(floor); });
		this.door.addChild(g);
		if (mode === "normal" || mode === "auto") {
			const b = new AnimatedSprite(frames({ shirt: "#1e1828", orch: true }, this.reduce ? "idle" : "idle"));
			b.anchor.set(.5, 1); b.x = dx + 15; b.y = dy + 2; b.animationSpeed = FPS.idle / 60; if (!this.reduce) b.play();
			this.hot(b, label); b.on("pointertap", (e) => { e.stopPropagation(); this.onDoor(floor); });
			this.door.addChild(b);
		}
		const sign = mode === "yolo" ? "BRB" : mode === "super-yolo" ? "OPEN" : "";
		if (sign) {
			const t = new Text({ text: sign, style: { fontFamily: "Iosevka Term, JetBrains Mono, monospace", fontSize: mode === "yolo" ? 8 : 11, fontWeight: "800", fill: mode === "yolo" ? 0x1a1028 : 0xff718f, dropShadow: mode === "yolo" ? undefined : { color: 0xff718f, blur: 6, distance: 0, alpha: 1, angle: 0 } } });
			t.eventMode = "none"; t.resolution = 4;
			if (mode === "yolo") { const plate = new Graphics().rect(dx + 4, dy - 22, 22, 10).fill(0xe4dcee); plate.eventMode = "none"; this.door.addChild(plate); t.x = dx + 7; t.y = dy - 21; }
			else { t.x = dx - 4; t.y = L.lobby - 6; }
			this.door.addChild(t);
		}
	}

	/** The MAP corkboard notes are the floor's tasks: tick when done, pink pin now, amber pin blocked. */
	private drawNotes(project: Project, L: Layout) {
		const g = this.notes.clear(), map = room("map");
		project.sessions.forEach((s, i) => {
			const y0 = floorTop(L, i);
			s.todos.filter((t) => t.status !== "dropped").slice(0, 6).forEach((t, k) => {
				const x = map.x + 8 + (k % 3) * 10, y = y0 + 30 + Math.floor(k / 3) * 11;
				g.rect(x, y, 8, 8).fill(t.status === "done" ? 0xe8f4ec : t.status === "pending" ? 0xd8d0c4 : 0xf6eff3);
				g.rect(x + 1, y + 3, 6, 1).fill(0x9a8aa0).rect(x + 1, y + 5, 4, 1).fill(0x9a8aa0);
				if (t.status === "done") g.moveTo(x + 1.5, y + 4.5).lineTo(x + 3.5, y + 6.5).lineTo(x + 7, y + 1.5).stroke({ width: 1.2, color: 0x2a8a5a });
				const pin = t.status === "in_progress" ? 0xff76c3 : t.status === "blocked" ? 0xe0c27a : t.status === "done" ? 0x5a9a6a : 0x8a7a8a;
				g.circle(x + 4, y, 1.6).fill(pin);
			});
		});
	}

	private upsert(key: string, look: Look, pick: Pick, tx: number, floor: number, L: Layout) {
		let p = this.byKey.get(key);
		if (!p) {
			const sprite = new AnimatedSprite(frames(look, "idle"));
			sprite.anchor.set(.5, 1);
			this.hot(sprite, () => {
				const pk = this.byKey.get(key)?.pick; if (!pk) return "";
				if (pk.kind === "helper" && pk.helper) return `${pk.helper.name} · ${pk.helper.status} · details`;
				return pk.session.basic ? `${pk.session.name} · details` : `Talk to ${pk.session.name}`;
			});
			sprite.x = tx; sprite.y = floorLine(L, floor) + 3;
			sprite.on("pointertap", (e) => { e.stopPropagation(); this.onPick(this.byKey.get(key)?.pick); });
			this.people.addChild(sprite);
			p = { key, sprite, anim: "idle", look, x: tx, tx, floor, pick };
			this.byKey.set(key, p);
		}
		p.pick = pick; p.tx = Math.max(BX + 8, Math.min(BX + BW - 8, tx)); p.floor = floor; p.sprite.y = floorLine(L, floor) + 3;
		const st = pick.kind === "orchestrator" ? floorState(pick.session) : undefined;
		if (st === "need" || st === "done") {
			if (!p.badge) { p.badge = new Sprite(bubbleTex![st]); p.badge.eventMode = "none"; p.badge.anchor.set(.5, 1); this.people.addChild(p.badge); }
			p.badge.texture = bubbleTex![st];
		} else if (p.badge) { p.badge.destroy(); p.badge = undefined; }
	}

	private tick(dt: number) {
		for (const p of this.byKey.values()) {
			const walking = Math.abs(p.tx - p.x) > .5 && !this.reduce;
			if (walking) { p.x += Math.sign(p.tx - p.x) * Math.min(Math.abs(p.tx - p.x), 24 * dt); p.sprite.scale.x = p.tx < p.x ? -1 : 1; }
			else { p.x = p.tx; p.sprite.scale.x = 1; }
			const roomId = ROOM_IDS.find((id) => { const r = room(id); return p.x >= r.x && p.x < r.x + r.w; }) ?? "workshop";
			const anim = animFor(p.pick, roomId, walking, this.reduce);
			if (anim !== p.anim) {
				p.anim = anim;
				p.sprite.textures = frames(p.look, anim);
				p.sprite.animationSpeed = FPS[anim] / 60;
				if (this.reduce) p.sprite.gotoAndStop(0); else p.sprite.play();
			}
			p.sprite.x = Math.round(p.x);
			if (p.badge) { p.badge.x = p.sprite.x; p.badge.y = p.sprite.y - 50; }
		}
	}
}
