// Gentle Tower web app: live floors from Gentle Shell over SSE.
import "pixi.js/unsafe-eval";
import "./style.css";
import { floorTop } from "./art";
import { FLOOR_COLORS, floorState, groupProjects, money, todoProgress } from "./model";
import { TowerScene, type Pick } from "./scene";
import type { Project, TowerSnapshot, TowerTodo } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scene = new TowerScene();
let projects: Project[] = [];
let current = "";
let selected: Pick | undefined;
let todoFloor: number | undefined;
let scale = 2;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const STATE_LABEL = { need: "waiting for you", work: "working", done: "finished" } as const;
const GLYPH = { need: "?", work: "…", done: "✓" } as const;
const TODO_COLOR: Record<TowerTodo["status"], string> = { done: "#b4e7c7", in_progress: "#ff76c3", blocked: "#e0c27a", pending: "#3a2a4a", dropped: "#2a2030" };

function project(): Project | undefined {
	return projects.find((p) => p.cwd === current)
		?? projects.find((p) => p.sessions.some((s) => floorState(s) === "need"))
		?? projects[0];
}

function renderProjects() {
	const el = $("projects");
	el.innerHTML = projects.map((p, k) => {
		const need = p.sessions.filter((s) => floorState(s) === "need").length;
		return `<button data-cwd="${esc(p.cwd)}" aria-pressed="${p === project()}" title="${esc(p.cwd)} (Alt+${k + 1})"><i style="background:${FLOOR_COLORS[k % FLOOR_COLORS.length]}"></i>${esc(p.id)}<span class="cnt">${p.sessions.length}</span>${need ? '<span class="nd">?</span>' : ""}</button>`;
	}).join("");
	el.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { current = b.dataset.cwd!; selected = undefined; todoFloor = undefined; render(); }));
}

function renderFloors(p: Project) {
	const L = scene.layout; if (!L) return;
	const el = $("floors");
	el.innerHTML = p.sessions.map((s, i) => {
		const st = floorState(s), col = FLOOR_COLORS[i % FLOOR_COLORS.length], prog = todoProgress(s.todos);
		const crew = s.subagents.map((a) => a.name).join(", ") || "no helpers";
		const segs = s.todos.filter((t) => t.status !== "dropped").map((t) => `<i class="${t.status}" style="background:${TODO_COLOR[t.status]}"></i>`).join("");
		const now = prog.now ? `${prog.now.status === "blocked" ? '<b class="warn">blocked:</b>' : "now:"} <b>${esc(prog.now.title)}</b>` : prog.total ? "<b>all done</b>" : "no task list yet";
		return `<div class="floor" style="top:${(floorTop(L, i) + 50) * scale}px;--c:${col}">
			<button class="fl px" data-i="${i}" aria-pressed="${selected?.floor === i}"><span class="key" style="background:${col}">${i + 1}</span><span class="nm">${esc(s.name)}</span><span class="st ${st}">${GLYPH[st]}</span><span class="sub">${money(s.cost.total)} · ${esc(crew)}</span></button>
			<button class="prog px" data-i="${i}" aria-expanded="${todoFloor === i}" aria-label="Tasks of floor ${i + 1}: ${prog.done} of ${prog.total} done"><span class="segs">${segs}</span><span class="now">${prog.done}/${prog.total} · ${now}</span></button>
		</div>`;
	}).join("");
	el.querySelectorAll<HTMLButtonElement>(".fl").forEach((b) => b.addEventListener("click", () => { const i = +b.dataset.i!; select({ kind: "orchestrator", floor: i, session: p.sessions[i] }); }));
	el.querySelectorAll<HTMLButtonElement>(".prog").forEach((b) => b.addEventListener("click", () => { const i = +b.dataset.i!; todoFloor = todoFloor === i ? undefined : i; render(); }));
}

function renderTodo(p: Project) {
	const el = $("todo");
	if (todoFloor === undefined || !p.sessions[todoFloor]) { el.hidden = true; return; }
	const s = p.sessions[todoFloor], prog = todoProgress(s.todos);
	el.hidden = false;
	el.innerHTML = `<h3><span style="background:${FLOOR_COLORS[todoFloor % FLOOR_COLORS.length]}"></span>${esc(s.name)}<small>${prog.done} of ${prog.total} done</small></h3>`
		+ (s.todos.length ? `<ol>${s.todos.map((t, k) => `<li class="${t.status}"><span class="ic" style="background:${TODO_COLOR[t.status]}">${t.status === "done" ? "✓" : t.status === "blocked" ? "!" : ""}</span><span>${k + 1}. ${esc(t.title)}</span><span class="st">${t.status.replace("_", " ")}</span>${t.note ? `<span class="meta">${esc(t.note)}</span>` : ""}</li>`).join("")}</ol>` : `<p class="empty">This session has no task list yet.</p>`);
}

function renderSelection() {
	const el = $("sel");
	if (!selected) { el.hidden = true; return; }
	const s = selected.session, st = floorState(s);
	el.hidden = false;
	if (selected.kind === "helper" && selected.helper) {
		const a = selected.helper;
		el.innerHTML = `<div><div class="nm">${esc(a.name)} · floor ${selected.floor + 1}</div><div class="meta">${esc(a.status)}${a.lastStep ? ` · ${esc(a.lastStep)}` : ""} · ${money(a.cost)} · ${a.tokens.toLocaleString()} tokens</div></div>`;
		return;
	}
	const prog = todoProgress(s.todos);
	const ctx = s.context.percent === null ? "context —" : `context ${Math.round(s.context.percent)}%`;
	el.innerHTML = `<div><div class="nm">Floor ${selected.floor + 1} · ${esc(s.name)}</div><div class="meta">${STATE_LABEL[st]} · ${prog.done}/${prog.total} tasks${prog.now ? ` · now: ${esc(prog.now.title)}` : ""} · ${money(s.cost.total)} · ${ctx} · ${esc(s.model)}${s.effort ? ` (${esc(s.effort)})` : ""}${s.phase ? ` · ${esc(s.phase)}` : ""}</div></div>`;
}

function select(p: Pick | undefined) { selected = p; renderSelection(); const pr = project(); if (pr) renderFloors(pr); }

function render() {
	const p = project();
	$("empty").hidden = !!p;
	$("stage").hidden = !p;
	renderProjects();
	if (!p) return;
	current = p.cwd;
	scene.show(p, p.sessions.map((_, i) => FLOOR_COLORS[i % FLOOR_COLORS.length]));
	fit();
	renderFloors(p);
	renderTodo(p);
	if (selected) { const s = p.sessions.find((x) => x.sessionId === selected!.session.sessionId); selected = s ? { ...selected, session: s, helper: selected.helper && s.subagents.find((a) => a.id === selected!.helper!.id) } : undefined; }
	renderSelection();
}

function fit() {
	const c = scene.app.canvas;
	scale = Math.max(1, Math.floor(Math.min(innerWidth / 720, innerHeight / 450) + 0.05));
	c.style.width = `${c.width * scale}px`;
	c.style.height = `${c.height * scale}px`;
}

function connect() {
	const es = new EventSource("api/events");
	es.onmessage = (e) => {
		$("offline").hidden = true;
		const data = JSON.parse(e.data) as { sessions: TowerSnapshot[] };
		projects = groupProjects(data.sessions);
		render();
	};
	let lost: ReturnType<typeof setTimeout> | undefined;
	es.onopen = () => { clearTimeout(lost); $("offline").hidden = true; };
	// EventSource reconnects by itself; only say so when it stays down.
	es.onerror = () => { clearTimeout(lost); lost = setTimeout(() => { if (es.readyState !== EventSource.OPEN) $("offline").hidden = false; }, 4000); };
}

addEventListener("keydown", (e) => {
	if (e.key === "Escape") { if (todoFloor !== undefined) { todoFloor = undefined; render(); } else select(undefined); }
	if (e.altKey && /^[1-9]$/.test(e.key) && projects[+e.key - 1]) { current = projects[+e.key - 1].cwd; selected = undefined; render(); }
	const p = project();
	if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key) && p?.sessions[+e.key - 1]) { e.preventDefault(); select({ kind: "orchestrator", floor: +e.key - 1, session: p.sessions[+e.key - 1] }); }
});
addEventListener("resize", () => { fit(); const p = project(); if (p) renderFloors(p); });

await scene.mount($("canvas"));
scene.onPick = (p) => select(p);
connect();
