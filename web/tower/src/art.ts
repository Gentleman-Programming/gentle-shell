// The painted tower, ported from design/herdr-gentle-shell/11-tower-painted.html.
// Everything is drawn once into canvases at logical 720x450 and handed to Pixi
// as textures; the VGA finish quantizes colours with a soft ordered dither.
import type { RoomId } from "./model";

type G = CanvasRenderingContext2D;
export const W = 720, H = 450;
export const BX = 172, BW = 516, FH = 100, GROUND = 418, LOBBY_H = 66;
export const C = { neon: "#ff76c3", acc: "#f095c8", accS: "#ffb1dd", ok: "#b4e7c7", warn: "#e0c27a", info: "#a9c7ee", vio: "#9146ff", vioL: "#b48cff", teal: "#5ee6e6", red: "#ff718f", ink: "#0c0714" };

export interface RoomDef { id: RoomId; sign: string; x: number; w: number; col: string; tint: string }
const RS: Array<[RoomId, string, number, string, string]> = [
	["map", "MAP", 66, C.teal, "#15283e"], ["workshop", "WORKSHOP", 86, C.neon, "#33182e"], ["lab", "LAB", 68, C.ok, "#173229"],
	["review", "REVIEW", 64, C.warn, "#2c2117"], ["engram", "ENGRAM", 80, C.vioL, "#211a44"], ["engine", "GENTLE AI", 80, C.neon, "#2c1530"],
	["lounge", "LOUNGE", 62, C.accS, "#331a2e"],
];
export const ROOMS: RoomDef[] = (() => { let x = BX + 4; return RS.map(([id, sign, w, col, tint]) => { const r = { id, sign, x, w, col, tint }; x += w + 2; return r; }); })();
export const room = (id: RoomId) => ROOMS.find((r) => r.id === id)!;

export interface Layout { floors: number; roof: number; lobby: number }
/** The building stands on the ground at the bottom of a scene at least `minHeight` tall; more floors make it taller (the page scrolls). */
export function layout(floors: number, minHeight = H): Layout {
	const lobby = Math.max(Math.round(minHeight) - 32 - LOBBY_H, 60 + floors * FH);
	return { floors, lobby, roof: lobby - floors * FH };
}
export const floorTop = (L: Layout, i: number) => L.roof + i * FH;
export const floorLine = (L: Layout, i: number) => floorTop(L, i) + 90;
export const sceneHeight = (L: Layout) => L.lobby + LOBBY_H + 32;

// ---------- helpers ----------
const rnd = (s: number) => { const v = Math.sin(s * 12.9898) * 43758.5453; return v - Math.floor(v); };
export const mk = (w: number, h: number) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
function lg(g: G, x0: number, y0: number, x1: number, y1: number, stops: Array<[number, string]>) { const gr = g.createLinearGradient(x0, y0, x1, y1); stops.forEach(([o, c]) => gr.addColorStop(o, c)); return gr; }
function rg(g: G, x: number, y: number, r: number, stops: Array<[number, string]>) { const gr = g.createRadialGradient(x, y, 0, x, y, r); stops.forEach(([o, c]) => gr.addColorStop(o, c)); return gr; }
function fillR(g: G, x: number, y: number, w: number, h: number, f: string | CanvasGradient) { g.fillStyle = f; g.fillRect(x, y, w, h); }
function rr(g: G, x: number, y: number, w: number, h: number, r: number) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function ell(g: G, x: number, y: number, rx: number, ry: number, f: string | CanvasGradient) { g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fillStyle = f; g.fill(); }
function light(g: G, x: number, y: number, r: number, col: string, a = .5) { g.save(); g.globalCompositeOperation = "lighter"; g.globalAlpha = a; g.fillStyle = rg(g, x, y, r, [[0, col], [1, "rgba(0,0,0,0)"]]); g.fillRect(x - r, y - r, r * 2, r * 2); g.restore(); }
function cone(g: G, x: number, y: number, w: number, h: number, col: string, a = .16) { g.save(); g.globalCompositeOperation = "lighter"; g.globalAlpha = a; g.beginPath(); g.moveTo(x - 3, y); g.lineTo(x + 3, y); g.lineTo(x + w / 2, y + h); g.lineTo(x - w / 2, y + h); g.closePath(); g.fillStyle = lg(g, 0, y, 0, y + h, [[0, col], [1, "rgba(0,0,0,0)"]]); g.fill(); g.restore(); }
export function shade(hex: string, t: number) { const c = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)); return "rgb(" + c.map((v) => Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t)).join(",") + ")"; }
let NOISE: HTMLCanvasElement | undefined;
function grain(g: G, x: number, y: number, w: number, h: number, a = .07) {
	if (!NOISE) { NOISE = mk(128, 128); const n = NOISE.getContext("2d")!, d = n.createImageData(128, 128); for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; } n.putImageData(d, 0, 0); }
	g.save(); g.globalAlpha = a; g.globalCompositeOperation = "overlay"; g.fillStyle = g.createPattern(NOISE, "repeat")!; g.fillRect(x, y, w, h); g.restore();
}
function neonText(g: G, s: string, x: number, y: number, col: string, size = 10, align: CanvasTextAlign = "left") {
	g.save(); g.font = `700 ${size}px "Iosevka Term","JetBrains Mono",ui-monospace,monospace`; g.textAlign = align; g.textBaseline = "top";
	g.shadowColor = col; g.shadowBlur = 8; g.fillStyle = col; g.fillText(s, x, y); g.shadowBlur = 3; g.fillStyle = "#fff"; g.globalAlpha = .6; g.fillText(s, x, y); g.restore();
}
const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + .5) / 16 - .5);
/** The VGA finish: limited palette with a soft ordered dither. */
export function finish(cnv: HTMLCanvasElement, levels = 26, amt = .5, alphaCut = false) {
	const g = cnv.getContext("2d")!, d = g.getImageData(0, 0, cnv.width, cnv.height), a = d.data, w = cnv.width, st = 255 / levels;
	for (let y = 0; y < cnv.height; y++) for (let x = 0; x < w; x++) {
		const i = (y * w + x) * 4, b = B4[(y & 3) * 4 + (x & 3)] * st * amt;
		for (let k = 0; k < 3; k++) a[i + k] = Math.max(0, Math.min(255, Math.round((a[i + k] + b) / st) * st));
		if (alphaCut) a[i + 3] = a[i + 3] > 110 ? 255 : 0;
	}
	g.putImageData(d, 0, 0); return cnv;
}

// ---------- scene pieces ----------
function paintSky(g: G, h: number) {
	fillR(g, 0, 0, W, h, lg(g, 0, 0, 0, h - 32, [[0, "#0d0820"], [.35, "#2a1050"], [.6, "#6a1d6e"], [.78, "#c2456f"], [.9, "#f08a6a"], [1, "#ffc58a"]]));
	for (let i = 0; i < 14; i++) { const y = 60 + rnd(i) * (h - 250), x = rnd(i + 3) * W, w = 80 + rnd(i + 5) * 180, hh = 4 + rnd(i + 9) * 7; g.save(); g.globalAlpha = .35 + rnd(i + 1) * .3; ell(g, x, y, w, hh, lg(g, 0, y - hh, 0, y + hh, [[0, "rgba(60,20,90,0)"], [.5, y > h - 250 ? "#ff9e8a" : "#b04a8a"], [1, "rgba(255,150,120,0)"]])); g.restore(); }
	for (let i = 0; i < 120; i++) { g.globalAlpha = .3 + rnd(i) * .6; fillR(g, rnd(i * 3) * W, rnd(i * 7) * (h * .35), 1, 1, rnd(i) > .8 ? C.teal : "#fff"); } g.globalAlpha = 1;
	const ground = h - 32, sy = ground - 30;
	g.save(); g.beginPath(); g.arc(80, sy, 62, 0, Math.PI * 2); g.clip(); fillR(g, 10, sy - 62, 140, 140, lg(g, 0, sy - 62, 0, sy + 62, [[0, "#fff1b0"], [.45, "#ffae7a"], [1, "#ff5f9a"]]));
	for (let k = 0; k < 7; k++) fillR(g, 0, sy - 16 + k * k * 1.4 + k * 3, 200, 1 + k * .6, "#c2456f"); g.restore(); light(g, 80, sy, 140, "#ff9e7a", .35);
	for (let layer = 0; layer < 2; layer++) { let x = 0, i = layer * 50; while (x < W) { const w = 14 + rnd(i) * 26, hh = (layer ? 40 : 70) + rnd(i + 1) * (layer ? 60 : 90); fillR(g, x, ground - hh, w, hh, layer ? "#24123a" : "#3a1a4e"); if (layer) for (let yy = ground - hh + 4; yy < ground - 4; yy += 5) for (let xx = x + 3; xx < x + w - 2; xx += 4) if (rnd(xx * yy + i) > .82) fillR(g, xx, yy, 2, 2, rnd(xx + yy) > .6 ? "#ffc06a" : C.neon); x += w + 1; i++; } }
	const palm = (x: number, hh: number, l: number) => { g.save(); g.strokeStyle = "#160a20"; g.lineWidth = 4; g.beginPath(); g.moveTo(x, ground); g.quadraticCurveTo(x + l * 10, ground - hh / 2, x + l * 16, ground - hh); g.stroke(); const tx = x + l * 16, ty = ground - hh; g.lineWidth = 3; for (let k = 0; k < 7; k++) { const a = -Math.PI + k * Math.PI / 6; g.beginPath(); g.moveTo(tx, ty); g.quadraticCurveTo(tx + Math.cos(a) * 20, ty + Math.sin(a) * 14 - 8, tx + Math.cos(a) * 36, ty + Math.sin(a) * 14 + 10); g.stroke(); } g.restore(); };
	palm(120, 120, 1); palm(150, 90, -1);
	fillR(g, 0, ground, W, h - ground, lg(g, 0, ground, 0, h, [[0, "#3a1546"], [1, "#12081c"]]));
	g.save(); g.globalAlpha = .5; g.strokeStyle = C.teal; g.lineWidth = 1; for (let k = 0; k < 6; k++) { const y = ground + 3 + k * k * 1.2; g.beginPath(); g.moveTo(0, y + .5); g.lineTo(W, y + .5); g.stroke(); }
	for (let k = -22; k <= 22; k++) { g.beginPath(); g.moveTo(430 + k * 20, ground); g.lineTo(430 + k * 70, h); g.stroke(); } g.restore();
}
function paintShell(g: G, L: Layout, ground: number) {
	const top = L.roof - 14;
	fillR(g, BX - 10, top, BW + 20, ground - top, lg(g, BX - 10, 0, BX + BW + 10, 0, [[0, "#4a2a4a"], [.03, "#2a1838"], [1, "#1a1028"]])); grain(g, BX - 10, top, BW + 20, ground - top, .12);
	fillR(g, BX - 10, top, 3, ground - top, "#ff9e8a");
	fillR(g, BX - 16, top - 6, BW + 32, 8, lg(g, 0, top - 6, 0, top + 2, [[0, "#5a3a5e"], [1, "#24142e"]]));
	const sx = BX + BW - 210; rr(g, sx, top - 34, 120, 28, 4); g.fillStyle = "#120a1a"; g.fill(); g.strokeStyle = "#3a2a4a"; g.lineWidth = 2; g.stroke();
	g.save(); g.translate(sx + 60, top - 20); g.scale(.9, .9); g.strokeStyle = C.neon; g.lineWidth = 3; g.lineCap = "round"; g.shadowColor = C.neon; g.shadowBlur = 12;
	const m = new Path2D("M0,2 C-6,-6 -20,-9 -32,-3 C-41,2 -46,-2 -47,-8 C-52,-1 -48,9 -36,9 C-24,9 -10,6 0,7 C10,6 24,9 36,9 C48,9 52,-1 47,-8 C46,-2 41,2 32,-3 C20,-9 6,-6 0,2 Z"); g.stroke(m); g.shadowBlur = 0; g.lineWidth = 1; g.strokeStyle = "#ffe0f0"; g.stroke(m); g.restore();
	light(g, sx + 60, top - 20, 80, C.neon, .25);
	rr(g, BX + 40, top - 30, 34, 24, 3); g.fillStyle = lg(g, BX + 40, 0, BX + 74, 0, [[0, "#6a4a5a"], [.5, "#3a2836"], [1, "#24161e"]]); g.fill();
}
type Art = (g: G, x: number, y0: number, w: number, b: number, i: number) => void;
const ART: Record<RoomId, Art> = {
	map(g, x, y0, _w, b) {
		rr(g, x + 6, y0 + 28, 34, 24, 2); g.fillStyle = lg(g, 0, y0 + 28, 0, y0 + 52, [[0, "#9a6a46"], [1, "#6a4630"]]); g.fill(); grain(g, x + 6, y0 + 28, 34, 24, .25); g.strokeStyle = "#3a2418"; g.lineWidth = 2; g.stroke();
		g.save(); g.translate(x + 44, b - 14); g.rotate(-.12); fillR(g, 0, 0, 20, 3, "#5a4a6a"); g.fillStyle = lg(g, 0, -6, 0, 0, [[0, "#5a8ad0"], [1, "#2a4a8a"]]); g.fillRect(1, -5, 18, 5); g.restore();
		fillR(g, x + 47, b - 11, 2, 11, "#2a1e30"); fillR(g, x + 60, b - 11, 2, 11, "#2a1e30"); fillR(g, x + 58, y0 + 40, 1, 22, "#8a7a9a"); ell(g, x + 56, y0 + 40, 4, 2, "#cfc0d8"); light(g, x + 54, b - 16, 18, "#a9c7ee", .35);
	},
	workshop(g, x, y0, _w, b) {
		rr(g, x + 6, y0 + 28, 34, 22, 2); g.fillStyle = "#4a3446"; g.fill(); for (let yy = y0 + 30; yy < y0 + 49; yy += 3) for (let xx = x + 8; xx < x + 39; xx += 3) fillR(g, xx, yy, 1, 1, "#2a1c28");
		g.save(); g.strokeStyle = "#b0a8c0"; g.lineWidth = 2; g.beginPath(); g.moveTo(x + 11, y0 + 32); g.lineTo(x + 11, y0 + 46); g.moveTo(x + 18, y0 + 32); g.lineTo(x + 18, y0 + 45); g.stroke(); g.strokeStyle = C.warn; g.beginPath(); g.moveTo(x + 26, y0 + 31); g.lineTo(x + 26, y0 + 46); g.stroke(); g.restore();
		g.fillStyle = lg(g, 0, b - 16, 0, b - 11, [[0, "#8a5a42"], [1, "#4a2e24"]]); g.fillRect(x + 44, b - 16, 38, 5); fillR(g, x + 46, b - 11, 3, 11, "#2a1a20"); fillR(g, x + 77, b - 11, 3, 11, "#2a1a20");
		rr(g, x + 50, b - 34, 22, 18, 3); g.fillStyle = lg(g, x + 50, 0, x + 72, 0, [[0, "#5a4a5e"], [1, "#2a2030"]]); g.fill(); rr(g, x + 53, b - 31, 16, 12, 3); g.fillStyle = "#0a0610"; g.fill(); fillR(g, x + 58, b - 17, 6, 2, "#2a2030"); light(g, x + 61, b - 25, 22, C.neon, .28);
	},
	lab(g, x, y0, w, b) {
		g.save(); g.globalAlpha = .25; g.strokeStyle = "#cfe8d8"; for (let yy = y0 + 30; yy < b - 24; yy += 6) for (let xx = x + 2; xx < x + w; xx += 6) g.strokeRect(xx + .5, yy + .5, 6, 6); g.restore();
		g.fillStyle = lg(g, 0, b - 16, 0, b - 11, [[0, "#7a8a8a"], [1, "#3a4444"]]); g.fillRect(x + 4, b - 16, 40, 5);
		for (let k = 0; k < 6; k++) { const tx = x + 8 + k * 6, c = k < 1 ? C.red : C.ok; rr(g, tx, b - 30, 4, 14, 2); g.fillStyle = "rgba(220,240,240,0.5)"; g.fill(); rr(g, tx, b - 24, 4, 8, 2); g.fillStyle = c; g.fill(); light(g, tx + 2, b - 22, 8, c, .35); }
		fillR(g, x + 52, y0 + 30, 8, 40, "#2a2a34"); [C.red, C.warn, C.ok].forEach((c, k) => { ell(g, x + 56, y0 + 36 + k * 9, 3.5, 3.5, k === 2 ? c : shade(c, -.7)); }); light(g, x + 56, y0 + 54, 16, C.ok, .5);
	},
	review(g, x, _y0, _w, b) {
		[C.red, C.warn, C.teal, C.ok].forEach((c, k) => { const sx = x + 6 + k * 14; rr(g, sx, b - 34, 11, 34, 3); g.fillStyle = lg(g, sx, 0, sx + 11, 0, [[0, "#6a3a2a"], [1, "#2a1610"]]); g.fill(); ell(g, sx + 5.5, b - 26, 3.5, 3.5, c); light(g, sx + 5.5, b - 26, 8, c, .4); fillR(g, sx - 1, b - 16, 13, 3, "#4a2a20"); });
	},
	engram(g, x, y0, _w, b, i) {
		for (let s = 0; s < 2; s++) { const sx = x + 4 + s * 28; fillR(g, sx, y0 + 26, 25, b - y0 - 26, lg(g, sx, 0, sx + 25, 0, [[0, "#4a3048"], [1, "#2a1a2a"]]));
			for (let k = 0; k < 4; k++) { const sy = y0 + 38 + k * 12; fillR(g, sx + 1, sy, 23, 2, "#1a0f18"); for (let bx = sx + 2; bx < sx + 23;) { const bw = 2 + (rnd(bx + k * 13 + s + i) * 2 | 0), bh = 7 + (rnd(bx * 3 + k) * 3 | 0); const col = ["#7a4ab8", "#4a7ab0", "#c86a9a", "#6aa88a", "#c8a85a", "#5ab0b8"][(rnd(bx + k * 7 + s) * 6) | 0]; g.fillStyle = lg(g, bx, 0, bx + bw, 0, [[0, shade(col, .2)], [1, shade(col, -.35)]]); g.fillRect(bx, sy - bh, bw, bh); bx += bw + (rnd(bx) > .85 ? 2 : 0); } } }
		fillR(g, x + 60, b - 14, 18, 4, "#6a4a3a"); fillR(g, x + 72, b - 24, 1, 10, "#c8a85a"); g.beginPath(); g.ellipse(x + 72, b - 24, 6, 3, 0, Math.PI, 0); g.fillStyle = "#2a7a4a"; g.fill(); light(g, x + 72, b - 18, 20, "#ffd88a", .45);
	},
	engine(g, x, y0, _w, b) {
		const rx = x + 16, top = y0 + 28; fillR(g, rx - 8, top - 4, 26, 5, "#9a8aa8"); fillR(g, rx - 8, b - 8, 26, 8, "#6a5a78");
		g.fillStyle = lg(g, rx - 6, 0, rx + 16, 0, [[0, "rgba(80,20,70,0.9)"], [.5, "rgba(255,90,170,0.55)"], [1, "rgba(60,15,60,0.9)"]]); g.fillRect(rx - 6, top + 1, 22, b - top - 9); light(g, rx + 5, (top + b) / 2, 40, C.neon, .55);
		g.save(); g.translate(rx + 5, top + 20); g.strokeStyle = "#ffe0f0"; g.lineWidth = 1.3; g.shadowColor = C.neon; g.shadowBlur = 6; g.beginPath(); for (let a = 0; a < 12; a += .2) { const r = a * .55; g.lineTo(Math.cos(a) * r, Math.sin(a) * r * .9); } g.stroke(); g.strokeStyle = "#7adca0"; g.beginPath(); g.moveTo(0, 7); g.lineTo(0, 24); g.stroke(); g.restore();
		rr(g, x + 40, y0 + 28, 34, 16, 2); g.fillStyle = lg(g, 0, y0 + 28, 0, y0 + 44, [[0, "#efe8f4"], [1, "#b8aec8"]]); g.fill(); g.strokeStyle = "#4a3a58"; g.stroke();
		rr(g, x + 42, b - 30, 30, 22, 2); g.fillStyle = "#2a2036"; g.fill(); for (let k = 0; k < 6; k++) { const lx = x + 47 + (k % 3) * 9, ly = b - 25 + (k / 3 | 0) * 8, c = k === 4 ? C.warn : C.ok; ell(g, lx, ly, 2.2, 2.2, c); light(g, lx, ly, 5, c, .5); }
	},
	lounge(g, x, y0, _w, b) {
		rr(g, x + 8, y0 + 28, 40, 24, 2); g.fillStyle = "#120a1a"; g.fill(); g.fillStyle = lg(g, 0, y0 + 30, 0, y0 + 50, [[0, "#3a1460"], [.5, "#c2456f"], [1, "#ffb07a"]]); g.fillRect(x + 10, y0 + 30, 36, 20);
		g.save(); g.beginPath(); g.rect(x + 10, y0 + 30, 36, 20); g.clip(); ell(g, x + 28, y0 + 50, 9, 9, "#ffe8a0"); g.restore(); fillR(g, x + 27, y0 + 30, 2, 20, "#120a1a");
		g.fillStyle = lg(g, 0, b - 16, 0, b - 12, [[0, "#9a6a4a"], [1, "#5a3a2a"]]); g.fillRect(x + 4, b - 16, 44, 4); fillR(g, x + 4, b - 12, 44, 12, "#3a1c2c"); fillR(g, x + 4, b - 12, 44, 1, C.warn);
		[[x + 8, "#7adca0"], [x + 13, C.warn], [x + 18, C.info], [x + 38, C.accS], [x + 43, C.teal]].forEach(([bx, c]) => { rr(g, bx as number, b - 26, 3, 10, 1); g.fillStyle = c as string; g.fill(); });
	},
};
function paintRoom(g: G, r: RoomDef, y0: number, i: number, reviewOn: boolean) {
	const x = r.x, w = r.w, wallB = y0 + 84;
	g.fillStyle = lg(g, 0, y0 + 6, 0, wallB, [[0, shade(r.tint, -.5)], [.5, r.tint], [1, shade(r.tint, -.2)]]); g.fillRect(x, y0 + 6, w, wallB - y0 - 6);
	g.fillStyle = lg(g, 0, wallB - 24, 0, wallB, [[0, shade(r.tint, -.15)], [1, shade(r.tint, -.45)]]); g.fillRect(x, wallB - 24, w, 24); fillR(g, x, wallB - 25, w, 1, shade(r.tint, .25)); grain(g, x, y0 + 6, w, wallB - y0 - 6, .1);
	g.fillStyle = lg(g, 0, wallB, 0, wallB + 8, [[0, "#3e2a36"], [1, "#22141e"]]); g.fillRect(x, wallB, w, 8); for (let k = x + 5; k < x + w; k += 9) fillR(g, k, wallB + 1, 1, 6, "#1a0f16"); fillR(g, x, wallB, w, 1, "#6a4a5a");
	fillR(g, x + w / 2 - 5, y0 + 6, 10, 3, "#2a2030"); ell(g, x + w / 2, y0 + 10, 6, 2.5, "#fff2d0");
	if (r.id !== "review" || reviewOn) cone(g, x + w / 2, y0 + 10, w * .95, wallB - y0 - 10, shade(r.col, .45));
	neonText(g, r.sign, x + 5, y0 + 13, r.id === "review" && !reviewOn ? shade(r.col, -.5) : r.col, 10);
	ART[r.id](g, x, y0, w, wallB, i);
	if (r.id === "review" && !reviewOn) { g.save(); g.globalAlpha = .6; fillR(g, x, y0 + 6, w, 84, "#07040d"); g.restore(); }
}
function paintFloors(g: G, L: Layout, colors: string[], reviewOn: boolean) {
	for (let i = 0; i < L.floors; i++) {
		const y0 = floorTop(L, i), col = colors[i];
		fillR(g, BX, y0, BW, FH, "#120a1a");
		for (const r of ROOMS) paintRoom(g, r, y0, i, reviewOn);
		for (let k = 0; k < ROOMS.length - 1; k++) { const r = ROOMS[k]; fillR(g, r.x + r.w, y0 + 6, 2, 84, lg(g, r.x + r.w, 0, r.x + r.w + 2, 0, [[0, "#3a2a44"], [1, "#120a18"]])); }
		fillR(g, BX, y0, BW, 6, lg(g, 0, y0, 0, y0 + 6, [[0, "#3a2a44"], [1, "#1a1020"]]));
		fillR(g, BX, y0 + 92, BW, 8, lg(g, 0, y0 + 92, 0, y0 + 100, [[0, "#4a3a54"], [1, "#22162a"]]));
		g.save(); g.shadowColor = col; g.shadowBlur = 8; fillR(g, BX, y0 + 93, BW, 2, col); g.restore();
		rr(g, BX - 26, y0 + 36, 18, 22, 3); g.fillStyle = lg(g, 0, y0 + 36, 0, y0 + 58, [[0, shade(col, .25)], [1, shade(col, -.25)]]); g.fill();
		g.save(); g.font = '800 15px "Iosevka Term","JetBrains Mono",monospace'; g.textAlign = "center"; g.fillStyle = "#120a1a"; g.fillText(String(i + 1), BX - 17, y0 + 53); g.restore();
	}
}
function paintLobby(g: G, L: Layout, projectName: string, projectCol: string) {
	const y0 = L.lobby, b = L.lobby + LOBBY_H;
	g.fillStyle = lg(g, 0, y0, 0, b, [[0, "#2a1834"], [.7, "#3a2240"], [1, "#22142a"]]); g.fillRect(BX, y0, BW, b - y0); grain(g, BX, y0, BW, b - y0, .1);
	for (let x = BX + 12; x < BX + BW; x += 40) fillR(g, x, y0 + 6, 6, b - y0 - 14, lg(g, x, 0, x + 6, 0, [[0, "#4a3454"], [1, "#24162c"]]));
	g.fillStyle = lg(g, 0, b - 10, 0, b, [[0, "#d8cce0"], [1, "#8a7a98"]]); g.fillRect(BX, b - 10, BW, 10); for (let x = BX; x < BX + BW; x += 16) fillR(g, x, b - 10, 1, 10, "#7a6a88");
	neonText(g, projectName.toUpperCase(), BX + BW / 2, y0 + 10, projectCol, 14, "center"); light(g, BX + BW / 2, y0 + 18, 90, projectCol, .18);
	rr(g, BX + 20, y0 + 18, 36, b - y0 - 28, 2); g.fillStyle = "#4a3a2a"; g.fill(); g.fillStyle = lg(g, BX + 22, 0, BX + 54, 0, [[0, "#c8a060"], [.5, "#f0d8a0"], [1, "#8a6a3a"]]); g.fillRect(BX + 22, y0 + 20, 32, b - y0 - 32); fillR(g, BX + 37, y0 + 20, 2, b - y0 - 32, "#5a4020");
	rr(g, BX + 300, b - 32, 90, 22, 3); g.fillStyle = lg(g, 0, b - 32, 0, b - 10, [[0, "#5a3048"], [1, "#2a1420"]]); g.fill(); fillR(g, BX + 300, b - 32, 90, 2, C.warn);
	const bx = BX + 400; g.fillStyle = lg(g, bx, 0, bx + 22, 0, [[0, "#fff"], [.4, "#e4dcee"], [1, "#8a809c"]]); rr(g, bx, b - 28, 22, 18, 2); g.fill(); rr(g, bx + 3, b - 42, 16, 14, 4); g.fill(); ell(g, bx + 11, b - 52, 8, 10, "#e4dcee");
	fillR(g, BX + BW - 14, y0 + 14, 14, b - y0 - 24, "#0a0610"); fillR(g, BX + BW - 16, y0 + 12, 18, 3, "#8a7a98");
	g.beginPath(); g.moveTo(BX + BW - 18, y0 + 6); g.lineTo(W, y0 + 2); g.lineTo(W, y0 + 14); g.lineTo(BX + BW - 18, y0 + 12); g.closePath(); g.fillStyle = lg(g, 0, y0 + 2, 0, y0 + 14, [[0, C.neon], [1, "#7a2a5a"]]); g.fill();
}

export interface BackgroundInput { floors: number; colors: string[]; projectName: string; projectColor: string; reviewOn: boolean; minHeight?: number }
/** The whole static building for one project, finished. */
export function paintBackground(input: BackgroundInput): { canvas: HTMLCanvasElement; layout: Layout } {
	const L = layout(input.floors, input.minHeight), h = sceneHeight(L), c = mk(W, h), g = c.getContext("2d")!;
	paintSky(g, h); paintShell(g, L, L.lobby + LOBBY_H); paintFloors(g, L, input.colors, input.reviewOn); paintLobby(g, L, input.projectName, input.projectColor);
	g.save(); g.globalCompositeOperation = "multiply"; g.fillStyle = "rgba(120,95,160,0.55)"; g.fillRect(BX - 10, L.roof - 14, BW + 20, L.lobby + LOBBY_H - L.roof + 14); g.restore();
	for (let i = 0; i < L.floors; i++) for (const r of ROOMS) { if (r.id === "review" && !input.reviewOn) continue; light(g, r.x + r.w / 2, floorTop(L, i) + 30, r.w * .6, shade(r.col, .5), .12); }
	light(g, BX - 30, L.lobby, 200, "#ff9e7a", .12);
	return { canvas: finish(c, 26, .5), layout: L };
}

// ---------- characters, pre-rendered pose by pose ----------
export type Anim = "walk" | "idle" | "type" | "wave" | "think" | "sip" | "read" | "clip";
export interface Look { shirt: string; hat?: "bowler" | "cap" | "hard" | "goggles"; orch?: boolean; coat?: boolean; mustache?: boolean }
interface Pose { legL?: number; legR?: number; armL?: number; armR?: number; bob?: number; breath?: number; nod?: number; blink?: number; prop?: "book" | "clip" | "cup"; tick?: number; cupx?: number; cupy?: number }
const S = Math.sin, PI = Math.PI;
export const ANIMS: Record<Anim, Pose[]> = {
	walk: Array.from({ length: 8 }, (_, k) => { const a = k / 8 * PI * 2; return { legL: S(a) * .5, legR: -S(a) * .5, armL: -S(a) * .45, armR: S(a) * .45, bob: -Math.abs(S(a)) * 1.2 }; }),
	idle: [{}, { breath: .6 }, { breath: .8 }, { breath: .6 }, {}, { blink: 1 }],
	type: [{ armR: -1.1 }, { armR: -1.35 }, { armR: -1.1, breath: .5 }, { armR: -1.35, nod: .5 }, { armR: -1.1 }, { armR: -1.3, blink: 1 }],
	wave: [{ armR: -2.6 }, { armR: -2.9 }, { armR: -2.6 }, { armR: -2.3 }, { armR: -2.6, blink: 1 }, { armR: -2.9 }],
	think: [{ armR: -2.2, nod: .4 }, { armR: -2.2, nod: .4, breath: .5 }, { armR: -2.2, nod: .4, blink: 1 }, { armR: -2.2, nod: .4 }],
	sip: [{ armR: -.4, prop: "cup", cupx: 5, cupy: 26 }, { armR: -.4, prop: "cup", cupx: 5, cupy: 26, breath: .5 }, { armR: -1.6, prop: "cup", cupx: 6, cupy: 16 }, { armR: -2.4, prop: "cup", cupx: 2, cupy: 10, blink: 1 }, { armR: -1.6, prop: "cup", cupx: 6, cupy: 16 }, { armR: -.4, prop: "cup", cupx: 5, cupy: 26 }],
	read: [{ armR: -1.2, armL: .6, prop: "book", nod: .6 }, { armR: -1.2, armL: .6, prop: "book", nod: .6, breath: .5 }, { armR: -1.25, armL: .6, prop: "book", nod: .6, blink: 1 }, { armR: -1.2, armL: .6, prop: "book", nod: .8 }],
	clip: [{ armR: -1, prop: "clip", tick: 0 }, { armR: -1, prop: "clip", tick: 1 }, { armR: -1, prop: "clip", tick: 2, nod: .5 }, { armR: -1, prop: "clip", tick: 3, blink: 1 }],
};
export const FPS: Record<Anim, number> = { walk: 10, idle: 3, type: 6, wave: 5, think: 2, sip: 2, read: 2, clip: 3 };
export const FRAME_W = 30, FRAME_H = 52;
function limb(p: G, x: number, y: number, ang: number, len: number, w: number, col: string, hand?: boolean) { p.save(); p.translate(x, y); p.rotate(ang); rr(p, -w / 2, 0, w, len, w / 2); p.fillStyle = col; p.fill(); if (hand) ell(p, 0, len, 1.7, 1.7, "#e0a888"); p.restore(); }
export function figure(o: Look, ps: Pose): HTMLCanvasElement {
	const c = mk(FRAME_W, FRAME_H), p = c.getContext("2d")!, cx = 15, top = 4 + (ps.bob ?? 0);
	const body = o.orch ? "#1e1828" : o.shirt, legC = "#2a2448";
	limb(p, cx - 6, top + 17, ps.armL ?? 0, 11, 3, shade(body, -.35), true);
	limb(p, cx - 2.5, top + 29, ps.legL ?? 0, 13, 4, shade(legC, -.25)); ell(p, cx - 2.5 + Math.sin(-(ps.legL ?? 0)) * 13 + 1, top + 43, 3.2, 1.6, C.ink);
	limb(p, cx + 2.5, top + 29, ps.legR ?? 0, 13, 4, legC); ell(p, cx + 2.5 + Math.sin(-(ps.legR ?? 0)) * 13 + 1, top + 43, 3.2, 1.6, C.ink);
	const br = ps.breath ?? 0; p.fillStyle = lg(p, cx - 7, 0, cx + 7, 0, [[0, shade(body, .25)], [.5, body], [1, shade(body, -.45)]]); rr(p, cx - 7, top + 16 - br, 14, 15 + br, 4); p.fill();
	if (o.orch) { p.fillStyle = "#f6eff3"; p.beginPath(); p.moveTo(cx - 3, top + 16 - br); p.lineTo(cx + 3, top + 16 - br); p.lineTo(cx, top + 22); p.fill(); p.fillStyle = o.shirt; p.fillRect(cx - 1, top + 18, 2, 7); }
	if (o.coat) { p.fillStyle = "#f0ecf6"; rr(p, cx - 7, top + 16, 14, 18, 3); p.fill(); }
	const hy = top + 9 + (ps.nod ?? 0); ell(p, cx, hy, 5.5, 6.5, lg(p, cx - 5, 0, cx + 5, 0, [[0, "#f2c8aa"], [.6, "#e0a888"], [1, "#a8705a"]]));
	p.fillStyle = "#2a1b27"; p.beginPath(); p.ellipse(cx - .5, hy - 4, 6, 3.5, 0, Math.PI, 0); p.fill(); p.fillRect(cx - 6, hy - 5, 2, 5);
	if (ps.blink) p.fillRect(cx + 1.6, hy - .4, 2, .8); else ell(p, cx + 2.5, hy - .5, .9, .9, "#1a0f14"); p.fillStyle = "#2a1b27"; p.fillRect(cx + 1, hy - 3, 3, 1);
	if (o.mustache !== false) { p.fillStyle = "#1a0f14"; p.beginPath(); p.moveTo(cx - 3, hy + 3); p.quadraticCurveTo(cx, hy + 1.5, cx + 3, hy + 3); p.quadraticCurveTo(cx + 5, hy + 2.5, cx + 5.5, hy + 1); p.quadraticCurveTo(cx + 5, hy + 4, cx + 2, hy + 4); p.quadraticCurveTo(cx, hy + 3.5, cx - 2, hy + 4); p.quadraticCurveTo(cx - 5, hy + 4, cx - 5.5, hy + 1); p.quadraticCurveTo(cx - 5, hy + 2.5, cx - 3, hy + 3); p.fill(); }
	if (o.hat === "bowler") { ell(p, cx, hy - 5.5, 8, 1.6, "#120c18"); p.beginPath(); p.ellipse(cx, hy - 6, 5.5, 5, 0, Math.PI, 0); p.fillStyle = "#2a2236"; p.fill(); p.fillStyle = o.shirt; p.fillRect(cx - 5.5, hy - 7.6, 11, 1.6); }
	if (o.hat === "cap") { p.beginPath(); p.ellipse(cx, hy - 5.5, 6, 4, 0, Math.PI, 0); p.fillStyle = C.teal; p.fill(); p.fillRect(cx + 3, hy - 6.5, 6, 1.5); }
	if (o.hat === "hard") { p.beginPath(); p.ellipse(cx, hy - 5, 6.5, 5, 0, Math.PI, 0); p.fillStyle = "#e0b84a"; p.fill(); ell(p, cx, hy - 5, 8, 1.4, "#c89a3a"); }
	if (o.hat === "goggles") { p.fillStyle = C.teal; p.fillRect(cx - 4, hy - 2, 9, 2.5); }
	if (ps.prop === "book") { p.save(); p.translate(cx + 6, top + 21); p.rotate(-.2); p.fillStyle = "#7a4ab8"; p.fillRect(-4, -3, 8, 6); p.fillStyle = "#f3ecdf"; p.fillRect(-3, -2, 6, 4); p.restore(); }
	if (ps.prop === "clip") { p.fillStyle = "#8a6a4a"; p.fillRect(cx + 4, top + 19, 6, 8); p.fillStyle = "#f3ecdf"; p.fillRect(cx + 5, top + 20, 4, 6); p.fillStyle = "#2a1838"; p.fillRect(cx + 5, top + 21 + (ps.tick ?? 0), 3, .8); }
	if (ps.prop === "cup") { p.fillStyle = "#f3ecdf"; p.fillRect(cx + 3 + (ps.cupx ?? 0), top + (ps.cupy ?? 20), 3, 4); p.fillStyle = C.warn; p.fillRect(cx + 3 + (ps.cupx ?? 0), top + (ps.cupy ?? 20), 3, 1); }
	limb(p, cx + 6, top + 17, ps.armR ?? 0, 11, 3, shade(body, -.2), true);
	return finish(c, 26, .4, true);
}
export function bubble(st: "need" | "done"): HTMLCanvasElement {
	const c = mk(18, 18), p = c.getContext("2d")!, col = st === "need" ? C.warn : C.ok; rr(p, 1, 1, 16, 12, 4); p.fillStyle = col; p.fill();
	p.beginPath(); p.moveTo(7, 13); p.lineTo(11, 13); p.lineTo(9, 17); p.fill(); p.fillStyle = "#1a0f26"; p.font = "800 10px ui-monospace,monospace"; p.textAlign = "center"; p.fillText(st === "need" ? "?" : "✓", 9, 11);
	return finish(c, 26, .3, true);
}
export function elephant(): HTMLCanvasElement {
	const c = mk(30, 24), p = c.getContext("2d")!; const body = lg(p, 0, 4, 0, 22, [[0, "#c8a8ff"], [.5, "#8a5ae0"], [1, "#4a2a8a"]]);
	ell(p, 11, 14, 10, 8, body); ell(p, 21, 9, 7, 7, body); ell(p, 18, 10, 4, 5.5, "#4ab8c0");
	p.strokeStyle = "#8a5ae0"; p.lineWidth = 3; p.lineCap = "round"; p.beginPath(); p.moveTo(26, 11); p.quadraticCurveTo(29, 17, 26, 21); p.stroke();
	ell(p, 23, 7.5, 1, 1, "#1a0f14"); p.strokeStyle = "#e0f0ff"; p.lineWidth = .8; p.strokeRect(21.5, 6.3, 3, 2.4); p.fillStyle = "#4a2a8a"; p.fillRect(4, 20, 4, 4); p.fillRect(14, 20, 4, 4);
	return finish(c, 26, .4, true);
}
