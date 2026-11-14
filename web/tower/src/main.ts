// Gentle Tower web app: live floors from Gentle Shell over SSE.
import "pixi.js/unsafe-eval";
import "./style.css";
import { floorTop } from "./art";
import { FLOOR_COLORS, floorState, groupProjects, money, todoProgress } from "./model";
import { TowerScene, type Pick } from "./scene";
import { closeModals, openArtifact, openArtifacts, openLibrary, openNewFloor, openTab, postAction, renderIntercom } from "./panels";
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
			<button class="fl px" data-i="${i}" aria-pressed="${selected?.floor === i}"><span class="fkey" style="background:${col}">${i + 1}</span><span class="nm">${esc(s.name)}</span><span class="st ${st}">${GLYPH[st]}</span><span class="sub">${s.basic ? "" : `${money(s.cost.total)} · `}${esc(crew)}</span></button>
			${s.basic
				? `<div class="prog px" style="opacity:.6;cursor:default"><span class="now">Details need the tower in this session</span></div>`
				: `<button class="prog px" data-i="${i}" aria-expanded="${todoFloor === i}" aria-label="Tasks of floor ${i + 1}: ${prog.done} of ${prog.total} done"><span class="segs">${segs}</span><span class="now">${prog.done}/${prog.total} · ${now}</span></button>`}
		</div>`;
	}).join("");
	el.querySelectorAll<HTMLButtonElement>(".fl").forEach((b) => b.addEventListener("click", () => { const i = +b.dataset.i!; select({ kind: "orchestrator", floor: i, session: p.sessions[i] }); }));
	el.querySelectorAll<HTMLButtonElement>("button.prog").forEach((b) => b.addEventListener("click", () => { const i = +b.dataset.i!; todoFloor = todoFloor === i ? undefined : i; render(); }));
}

function renderTodo(p: Project) {
	const el = $("todo");
	if (todoFloor === undefined || !p.sessions[todoFloor]) { el.hidden = true; return; }
	const s = p.sessions[todoFloor], prog = todoProgress(s.todos);
	el.hidden = false;
	el.innerHTML = `<h3><span style="background:${FLOOR_COLORS[todoFloor % FLOOR_COLORS.length]}"></span>${esc(s.name)}<small>${prog.done} of ${prog.total} done</small></h3>`
		+ (s.todos.length ? `<ol>${s.todos.map((t, k) => `<li class="${t.status}"><span class="ic" style="background:${TODO_COLOR[t.status]}">${t.status === "done" ? "✓" : t.status === "blocked" ? "!" : ""}</span><span>${k + 1}. ${esc(t.title)}</span><span class="st">${t.status.replace("_", " ")}</span>${t.note ? `<span class="meta">${esc(t.note)}</span>` : ""}</li>`).join("")}</ol>` : `<p class="empty">This session has no task list yet.</p>`);
}

const LOWER: Record<string, string[]> = { "super-yolo": ["yolo", "auto", "normal"], yolo: ["auto", "normal"], auto: ["normal"], normal: [] };
let intercomFloor: number | undefined;
let armedStop: string | undefined;

function renderSelection() {
	const el = $("sel");
	if (!selected) { el.hidden = true; return; }
	const s = selected.session, st = floorState(s), floor = selected.floor;
	el.hidden = false;
	if (selected.kind === "helper" && selected.helper) {
		const a = selected.helper, armed = armedStop === a.id, running = a.status === "running" || a.status === "queued" || a.status === "waiting";
		el.innerHTML = `<div><div class="nm">${esc(a.name)} · floor ${floor + 1}</div><div class="meta">${esc(a.status)}${a.lastStep ? ` · ${esc(a.lastStep)}` : ""} · ${money(a.cost)} · ${a.tokens.toLocaleString()} tokens</div></div>${running ? `<button class="btn ${armed ? "danger" : ""}" id="stop">${armed ? "Click again to stop" : "Stop helper"}</button>` : ""}`;
		el.querySelector("#stop")?.addEventListener("click", async () => {
			if (!armed) { armedStop = a.id; renderSelection(); return; }
			armedStop = undefined;
			await postAction({ type: "cancel-helper", sessionId: s.sessionId, helperId: a.id });
			renderSelection();
		});
		return;
	}
	if (s.basic) {
		el.innerHTML = `<div><div class="nm">Floor ${floor + 1} · ${esc(s.name)}</div><div class="meta">${esc(s.project.name)} · Live in Gentle Shell · open details by restarting it with the tower</div></div>`;
		return;
	}
	const prog = todoProgress(s.todos);
	const ctx = s.context.percent === null ? "context —" : `context ${Math.round(s.context.percent)}%`;
	const lower = LOWER[s.permission ?? ""] ?? [];
	el.innerHTML = `<div><div class="nm">Floor ${floor + 1} · ${esc(s.name)}</div><div class="meta">${s.waiting ? "a question is waiting in the terminal" : STATE_LABEL[st]} · ${prog.done}/${prog.total} tasks${prog.now ? ` · now: ${esc(prog.now.title)}` : ""} · ${money(s.cost.total)} · ${ctx} · ${esc(s.model)}${s.effort ? ` (${esc(s.effort)})` : ""}${s.phase ? ` · ${esc(s.phase)}` : ""}</div></div>
		<button class="btn primary" id="talk">Talk <kbd>T</kbd></button><button class="btn" id="tasks">Tasks</button><button class="btn" id="arts">Artifacts${s.artifacts?.length ? ` (${s.artifacts.length})` : ""}</button>
		${s.permission ? `<label class="door">Permissions <select id="door" aria-label="Permissions (the web can only lower them)"><option selected>${esc(s.permission)}</option>${lower.map((m) => `<option value="${m}">lower to ${m}</option>`).join("")}</select></label>` : ""}`;
	el.querySelector("#talk")!.addEventListener("click", () => openIntercom(floor));
	el.querySelector("#tasks")!.addEventListener("click", () => { todoFloor = floor; render(); });
	el.querySelector("#arts")!.addEventListener("click", () => openArtifacts(s));
	el.querySelector("#door")?.addEventListener("change", async (e) => {
		const mode = (e.target as HTMLSelectElement).value;
		if (LOWER[s.permission ?? ""]?.includes(mode)) await postAction({ type: "permission", sessionId: s.sessionId, mode });
	});
}

function openIntercom(floor: number) {
	const p = project(); if (!p?.sessions[floor] || p.sessions[floor].basic) return;
	intercomFloor = floor;
	renderIntercom(p.sessions[floor], floor);
}

function renderLobby(p: Project) {
	const L = scene.layout; if (!L) return;
	const review = p.sessions.find((s) => s.review)?.review;
	const btn = $("review-btn") as HTMLButtonElement;
	btn.textContent = `Review: ${review ?? "—"}`;
	btn.setAttribute("aria-pressed", String(review === "on"));
	btn.disabled = !review;
}

function select(p: Pick | undefined) { selected = p; renderSelection(); const pr = project(); if (pr) renderFloors(pr); }

function render() {
	const p = project();
	$("empty").hidden = !!p;
	$("stage").hidden = !p;
	renderProjects();
	if (!p) return;
	current = p.cwd;
	fit();
	scene.show(p, p.sessions.map((_, i) => FLOOR_COLORS[i % FLOOR_COLORS.length]), p.sessions.some((s) => s.review === "on") || !p.sessions.some((s) => s.review), innerHeight / scale);
	sizeCanvas();
	renderFloors(p);
	renderTodo(p);
	renderLobby(p);
	if (intercomFloor !== undefined && !$("intercom").hidden && p.sessions[intercomFloor]) {
		const draft = $("intercom").querySelector("textarea")?.value ?? "";
		renderIntercom(p.sessions[intercomFloor], intercomFloor);
		const box = $("intercom").querySelector("textarea"); if (box) box.value = draft;
	}
	if (selected) { const s = p.sessions.find((x) => x.sessionId === selected!.session.sessionId); selected = s ? { ...selected, session: s, helper: selected.helper && s.subagents.find((a) => a.id === selected!.helper!.id) } : undefined; }
	renderSelection();
}

// The scene fills the window's width; its sky grows to fill the height, with the building on the ground.
function fit() { scale = Math.max(1, innerWidth / 720); }
function sizeCanvas() {
	const c = scene.app.canvas;
	c.style.width = `${c.width * scale}px`;
	c.style.height = `${c.height * scale}px`;
	document.documentElement.style.setProperty("--floor-w", `${Math.max(170, Math.min(320, 172 * scale - 28))}px`);
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
	if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
	if (e.key === "Escape") { if (closeModals()) return; if (!$("intercom").hidden) { $("intercom").hidden = true; return; } if (todoFloor !== undefined) { todoFloor = undefined; render(); } else select(undefined); }
	if ((e.key === "t" || e.key === "T") && !e.metaKey && !e.ctrlKey) { e.preventDefault(); openIntercom(selected?.floor ?? 0); }
	if ((e.key === "n" || e.key === "N") && !e.metaKey && !e.ctrlKey) { const p = project(); if (p) { e.preventDefault(); openNewFloor(p); } }
	if (e.altKey && /^[1-9]$/.test(e.key) && projects[+e.key - 1]) { current = projects[+e.key - 1].cwd; selected = undefined; render(); }
	const p = project();
	if ((e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key) && p?.sessions[+e.key - 1]) { e.preventDefault(); select({ kind: "orchestrator", floor: +e.key - 1, session: p.sessions[+e.key - 1] }); }
});
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 120); });

await scene.mount($("canvas"));
scene.onPick = (p) => select(p);
scene.onRoom = (roomId, floor) => {
	const p = project(); if (!p) return;
	if (roomId === "engram") return openLibrary(p);
	if (roomId === "lounge" || roomId === "engine") return openTab(projects);
	if (roomId === "map") { todoFloor = floor; render(); return; }
	select({ kind: "orchestrator", floor, session: p.sessions[floor] });
};
scene.onDoor = (floor) => { const p = project(); if (!p) return; select({ kind: "orchestrator", floor, session: p.sessions[floor] }); (document.getElementById("door") as HTMLSelectElement | null)?.focus(); };
scene.onArtifact = (floor, a) => { const p = project(); if (p?.sessions[floor]) void openArtifact(p.sessions[floor], a); };
$("lib-btn").addEventListener("click", () => { const p = project(); if (p) openLibrary(p); });
$("newfloor-btn").addEventListener("click", () => { const p = project(); if (p) openNewFloor(p); });
$("tab-btn").addEventListener("click", () => openTab(projects));
$("review-btn").addEventListener("click", async () => {
	const p = project(); const s = p?.sessions.find((x) => x.review); if (!s) return;
	const next = s.review !== "on";
	if (!next && !confirm("Turn review mode off for every floor? Outside reviews stop until you turn it back on.")) return;
	await postAction({ type: "review", sessionId: s.sessionId, enabled: next });
});
connect();
