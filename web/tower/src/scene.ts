// The Pixi scene: one painted building per project, animated people on top.
import { AnimatedSprite, Application, Container, Graphics, Sprite, Texture, TextureSource } from "pixi.js";
import { ANIMS, BX, BW, bubble, elephant, figure, floorLine, floorTop, FPS, paintBackground, room, type Anim, type Layout, type Look } from "./art";
import { floorState, helperRoom, orchestratorRoom, type RoomId } from "./model";
import type { Project, TowerSnapshot, TowerSubagent } from "./types";

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
	private floors = 0;
	private reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
	private bgKey = "";

	async mount(host: HTMLElement): Promise<void> {
		await this.app.init({ width: 720, height: 450, background: "#07040d", antialias: false, resolution: 1, autoDensity: false, preference: "webgl" });
		host.appendChild(this.app.canvas);
		this.app.stage.addChild(this.bg, this.notes, this.props, this.people);
		this.app.stage.eventMode = "static";
		this.bg.eventMode = "static";
		this.bg.on("pointertap", (e) => {
			const p = e.getLocalPosition(this.bg), L = this.layout;
			const floor = L ? Math.floor((p.y - L.roof) / 100) : -1;
			const r = (["map", "workshop", "lab", "review", "engram", "engine", "lounge"] as RoomId[]).find((id) => { const x = room(id); return p.x >= x.x && p.x < x.x + x.w; });
			if (L && r && floor >= 0 && floor < this.floors) this.onRoom(r, floor); else this.onPick(undefined);
		});
		bubbleTex = { need: BUBBLES.need(), done: BUBBLES.done() };
		elephantTex = Texture.from(elephant());
		this.app.ticker.add((t) => this.tick(t.deltaMS / 1000));
	}

	show(project: Project, colors: string[], reviewOn = true): void {
		const key = `${project.cwd}|${project.sessions.length}|${colors.join()}|${reviewOn}`;
		if (key !== this.bgKey) {
			this.bgKey = key;
			const { canvas, layout } = paintBackground({ floors: project.sessions.length, colors, projectName: project.id, projectColor: colors[0] ?? "#f095c8", reviewOn });
			this.layout = layout;
			this.bg.texture = Texture.from(canvas);
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
			sprite.anchor.set(.5, 1); sprite.eventMode = "static"; sprite.cursor = "pointer";
			sprite.x = tx; sprite.y = floorLine(L, floor) + 3;
			sprite.on("pointertap", (e) => { e.stopPropagation(); this.onPick(this.byKey.get(key)?.pick); });
			this.people.addChild(sprite);
			p = { key, sprite, anim: "idle", look, x: tx, tx, floor, pick };
			this.byKey.set(key, p);
		}
		p.pick = pick; p.tx = Math.max(BX + 8, Math.min(BX + BW - 8, tx)); p.floor = floor; p.sprite.y = floorLine(L, floor) + 3;
		const st = pick.kind === "orchestrator" ? floorState(pick.session) : undefined;
		if (st === "need" || st === "done") {
			if (!p.badge) { p.badge = new Sprite(bubbleTex![st]); p.badge.anchor.set(.5, 1); this.people.addChild(p.badge); }
			p.badge.texture = bubbleTex![st];
		} else if (p.badge) { p.badge.destroy(); p.badge = undefined; }
	}

	private tick(dt: number) {
		for (const p of this.byKey.values()) {
			const walking = Math.abs(p.tx - p.x) > .5 && !this.reduce;
			if (walking) { p.x += Math.sign(p.tx - p.x) * Math.min(Math.abs(p.tx - p.x), 24 * dt); p.sprite.scale.x = p.tx < p.x ? -1 : 1; }
			else { p.x = p.tx; p.sprite.scale.x = 1; }
			const roomId = (["map", "workshop", "lab", "review", "engram", "engine", "lounge"] as RoomId[]).find((id) => { const r = room(id); return p.x >= r.x && p.x < r.x + r.w; }) ?? "workshop";
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
