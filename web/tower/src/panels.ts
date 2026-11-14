// Panels that open on demand: intercom, artifact viewer, Engram library, bar tab.
import { FLOOR_COLORS, money, todoProgress } from "./model";
import type { Project, TowerArtifact, TowerSnapshot } from "./types";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function postAction(action: Record<string, unknown>): Promise<boolean> {
	try {
		const r = await fetch("api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
		return r.status === 202;
	} catch { return false; }
}

/** A small, escape-first Markdown renderer: headings, lists, code, bold, italic, inline code. No raw HTML. */
export function renderMarkdown(md: string): string {
	const inline = (t: string) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|\W)\*([^*]+)\*(?=\W|$)/g, "$1<i>$2</i>");
	const out: string[] = [];
	let list: "ul" | "ol" | null = null, code = false;
	const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
	for (const line of md.split("\n")) {
		if (line.startsWith("```")) { close(); out.push(code ? "</code></pre>" : "<pre><code>"); code = !code; continue; }
		if (code) { out.push(esc(line) + "\n"); continue; }
		const h = /^(#{1,4})\s+(.*)$/.exec(line);
		const ul = /^\s*[-*]\s+(.*)$/.exec(line);
		const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		if (h) { close(); out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`); }
		else if (ul || ol) { const kind = ul ? "ul" : "ol"; if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; } out.push(`<li>${inline((ul ?? ol)![1])}</li>`); }
		else if (!line.trim()) { close(); }
		else { close(); out.push(`<p>${inline(line)}</p>`); }
	}
	close(); if (code) out.push("</code></pre>");
	return out.join("");
}

// ---------- modal shell ----------
function modal(id: string, title: string, sub: string, body: string, wide = false): HTMLElement {
	document.getElementById(id)?.remove();
	const el = document.createElement("section");
	el.id = id; el.className = `modal px${wide ? " wide" : ""}`; el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true"); el.setAttribute("aria-label", title);
	el.innerHTML = `<header><b>${esc(title)}</b><small>${esc(sub)}</small><button class="x" aria-label="Close">✕</button></header><div class="body">${body}</div>`;
	document.body.appendChild(el);
	const todo = document.getElementById("todo"); if (todo) todo.hidden = true;
	const dim = document.getElementById("dim")!; dim.hidden = false;
	const close = () => { el.remove(); if (!document.querySelector(".modal")) dim.hidden = true; };
	el.querySelector(".x")!.addEventListener("click", close);
	dim.onclick = () => document.querySelectorAll(".modal").forEach((m) => m.remove()) ?? (dim.hidden = true);
	(el.querySelector("button, input, textarea") as HTMLElement | null)?.focus();
	return el;
}
export function closeModals(): boolean {
	const any = document.querySelectorAll(".modal").length > 0;
	document.querySelectorAll(".modal").forEach((m) => m.remove());
	document.getElementById("dim")!.hidden = true;
	return any;
}

// ---------- intercom ----------
const sentLog = new Map<string, string[]>();
export function renderIntercom(s: TowerSnapshot, floor: number): void {
	const el = document.getElementById("intercom")!;
	el.hidden = false;
	const prog = todoProgress(s.todos);
	const mine = sentLog.get(s.sessionId) ?? [];
	el.style.setProperty("--c", FLOOR_COLORS[floor % FLOOR_COLORS.length]);
	el.innerHTML = `<header><span class="fkey">${floor + 1}</span><div><b>${esc(s.name)}</b><small>${esc(s.project.name)} · ${money(s.cost.total)}${prog.now ? ` · now: ${esc(prog.now.title)}` : ""}</small></div><button class="x" aria-label="Close intercom">✕</button></header>
		<div class="log" role="log" aria-live="polite">
			${s.waiting ? `<div class="waiting">? A question is waiting for you in the terminal. Answer it there, or tell the floor here.</div>` : ""}
			${s.said ? `<div class="m"><small>orchestrator · latest</small>${renderMarkdown(s.said)}</div>` : `<div class="m muted">No reply yet.</div>`}
			${mine.map((t) => `<div class="m you">${esc(t)}</div>`).join("")}
			${s.notice ? `<div class="notice ${s.notice.ok ? "ok" : "bad"}">${esc(s.notice.text)}</div>` : ""}
		</div>
		<form class="say"><label class="sr" for="say">Message this floor</label><textarea id="say" rows="2" placeholder="Talk to floor ${floor + 1}… Enter sends, Shift+Enter new line"></textarea><button class="btn primary">Send</button></form>`;
	el.querySelector(".x")!.addEventListener("click", () => { el.hidden = true; });
	const form = el.querySelector("form")!, box = el.querySelector("textarea")!;
	box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } e.stopPropagation(); });
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const text = box.value.trim(); if (!text) return;
		box.value = "";
		const ok = await postAction({ type: "message", sessionId: s.sessionId, text });
		sentLog.set(s.sessionId, [...(sentLog.get(s.sessionId) ?? []), ok ? text : `${text} (not sent)`].slice(-8));
		renderIntercom(s, floor);
		(document.getElementById("say") as HTMLTextAreaElement)?.focus();
	});
	const log = el.querySelector(".log")!; log.scrollTop = log.scrollHeight;
}

// ---------- artifact viewer ----------
let mermaidReady: Promise<typeof import("mermaid")["default"]> | undefined;
export async function openArtifact(s: TowerSnapshot, a: TowerArtifact): Promise<void> {
	const url = `api/artifact?session=${encodeURIComponent(s.sessionId)}&path=${encodeURIComponent(a.path)}`;
	const name = a.path.split("/").pop() ?? a.path;
	const el = modal("viewer", name, `${a.kind} · ${s.name}`, `<div class="paper">Loading…</div>`, true);
	const paper = el.querySelector(".paper")!;
	try {
		if (a.kind === "image") { paper.innerHTML = `<img src="${esc(url)}" alt="${esc(name)}">`; return; }
		const r = await fetch(url);
		if (!r.ok) throw new Error(String(r.status));
		const text = await r.text();
		if (a.kind === "doc") { paper.innerHTML = renderMarkdown(text); return; }
		mermaidReady ??= import("mermaid").then((m) => { m.default.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" }); return m.default; });
		const mermaid = await mermaidReady;
		const { svg } = await mermaid.render(`mmd-${Date.now()}`, text);
		paper.innerHTML = svg;
	} catch {
		paper.innerHTML = `<p class="muted">Could not open this file. It may have moved or be outside the project.</p>`;
	}
}
export function openArtifacts(s: TowerSnapshot): void {
	const items = s.artifacts ?? [];
	const el = modal("artifacts", "Artifacts", `${s.name} · newest first`, items.length
		? `<ul class="files">${items.map((a, i) => `<li><button data-i="${i}"><span class="kind ${a.kind}">${a.kind}</span>${esc(a.path.split("/").slice(-2).join("/"))}</button></li>`).join("")}</ul>`
		: `<p class="muted">This floor has not written any docs, diagrams or images yet.</p>`);
	el.querySelectorAll<HTMLButtonElement>("button[data-i]").forEach((b) => b.addEventListener("click", () => void openArtifact(s, items[+b.dataset.i!])));
}

// ---------- Engram library ----------
interface Memory { id: number; type?: string; title?: string; content?: string; created_at?: string; review_after?: string }
const SHELVES: Record<string, string> = { decision: "Decisions", bugfix: "Bug fixes", preference: "Your preferences", architecture: "Architecture", discovery: "Discoveries", pattern: "Patterns" };
const SPINE = ["#7a4ab8", "#4a7ab0", "#c86a9a", "#6aa88a", "#c8a85a", "#5ab0b8"];
export function openLibrary(project: Project): void {
	const el = modal("library", "Engram · the library", `${project.id} · what your agents remember`, `<div class="lib"><div class="shelves"><input class="search" placeholder="Search memories…" aria-label="Search memories" value="${esc(project.id)}"><div class="shelfset"></div></div><article class="page muted">Pick a book.</article></div>`, true);
	const set = el.querySelector(".shelfset")!, page = el.querySelector(".page")!, input = el.querySelector("input")!;
	const show = (m: Memory) => { page.classList.remove("muted"); page.innerHTML = `<h3>${esc(m.title ?? "Untitled")}</h3><div class="tag">${esc(m.type ?? "memory")}${m.created_at ? ` · ${esc(m.created_at)}` : ""}</div>${renderMarkdown(m.content ?? "")}`; };
	const SHOWN = 6;
	const open = new Set<string>();
	// A book is a readable row with a coloured spine; a shelf shows a few and folds the rest.
	const shelf = (label: string, items: Memory[], folded = false) => {
		if (!items.length) return "";
		const all = open.has(label), visible = folded && !all ? [] : all ? items : items.slice(0, SHOWN);
		const more = items.length - visible.length;
		return `<div class="shelf"><h4>${esc(label)}<span>${items.length}</span></h4><div class="books">${visible.map((m) => `<button class="book" data-id="${m.id}" title="${esc(m.title ?? "")}"><i style="background:${SPINE[m.id % SPINE.length]}"></i><span>${esc(m.title ?? "Untitled")}</span></button>`).join("")}</div>${more > 0 ? `<button class="more" data-shelf="${esc(label)}">${folded && !all ? `Show ${more} waiting for review` : `Show all ${items.length}`}</button>` : ""}</div>`;
	};
	let found: Memory[] = [];
	const draw = (review: Memory[]) => {
		const byType = new Map<string, Memory[]>();
		for (const m of found) { const k = SHELVES[m.type ?? ""] ? m.type! : "other"; byType.set(k, [...(byType.get(k) ?? []), m]); }
		set.innerHTML = ([...byType].map(([k, v]) => shelf(SHELVES[k] ?? "Other", v)).join("") + shelf("Waiting for your review", review, true)) || `<p class="muted">Nothing found.</p>`;
		set.querySelectorAll<HTMLButtonElement>(".book").forEach((b) => b.addEventListener("click", () => {
			set.querySelectorAll(".book[aria-pressed]").forEach((x) => x.removeAttribute("aria-pressed"));
			b.setAttribute("aria-pressed", "true");
			const m = [...found, ...review].find((x) => x.id === +b.dataset.id!); if (m) show(m);
		}));
		set.querySelectorAll<HTMLButtonElement>(".more").forEach((b) => b.addEventListener("click", () => { open.add(b.dataset.shelf!); draw(review); }));
	};
	let review: Memory[] = [];
	const search = async () => {
		const q = input.value.trim();
		try {
			const [r1, r2] = await Promise.all([
				q ? fetch(`api/memory/search?${new URLSearchParams({ project: project.id, q })}`) : Promise.resolve(undefined),
				fetch(`api/memory/review?${new URLSearchParams({ project: project.id })}`),
			]);
			found = r1 && r1.ok ? await r1.json() : [];
			review = r2.ok ? ((await r2.json()).observations ?? []) : [];
			draw(review);
		} catch { set.innerHTML = `<p class="muted">Engram is not reachable. Is it running?</p>`; }
	};
	let t: ReturnType<typeof setTimeout> | undefined;
	input.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => void search(), 300); });
	input.addEventListener("keydown", (e) => e.stopPropagation());
	void search();
}

// ---------- a new floor ----------
export function openNewFloor(project: Project): void {
	const el = modal("new-floor", "New floor", `${project.id} · a new Gentle Shell session`, `<form class="newfloor">
		<label for="nf-prompt">What should this floor work on? <small>optional — you can also tell it later</small></label>
		<textarea id="nf-prompt" rows="4" placeholder="Fix the login bug and add a test for it"></textarea>
		<p class="muted">It opens in a new terminal window in <code>${esc(project.cwd)}</code> and shows up here as a floor.</p>
		<div class="row"><span class="status" role="status"></span><button class="btn primary">Open the floor</button></div></form>`);
	const form = el.querySelector("form")!, box = el.querySelector("textarea")!, status = el.querySelector(".status")!;
	box.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit(); e.stopPropagation(); });
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const prompt = box.value.trim();
		status.textContent = "Opening…";
		const ok = await postAction({ type: "new-floor", project: project.cwd, ...(prompt ? { prompt } : {}) });
		status.textContent = ok ? "Opened. It will appear as a new floor in a moment." : "Could not open a new floor.";
		if (ok) setTimeout(() => closeModals(), 1500);
	});
	box.focus();
}

// ---------- the bar tab ----------
export function openTab(projects: Project[]): void {
	const sessions = projects.flatMap((p) => p.sessions);
	const byModel = new Map<string, { cost: number; tokens: number }>();
	for (const s of sessions) for (const m of s.models ?? []) { const v = byModel.get(m.model) ?? { cost: 0, tokens: 0 }; v.cost += m.cost; v.tokens += m.tokens; byModel.set(m.model, v); }
	const total = sessions.reduce((a, s) => a + s.cost.total, 0);
	const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
	const row = (l: string, sub: string, v: string) => `<div class="r"><span>${esc(l)} <small>${esc(sub)}</small></span><span>${v}</span></div>`;
	modal("tab", "The bar · your tab", "open sessions right now", `<div class="receipt"><h3>THE GENTLEMAN CLUB</h3><div class="c">tab · ${sessions.length} open session${sessions.length === 1 ? "" : "s"}</div>
		${[...byModel].sort((a, b) => b[1].cost - a[1].cost).map(([m, v]) => row(m, `${k(v.tokens)} tok`, money(v.cost))).join("") || '<div class="c">no model usage yet</div>'}<hr>
		${projects.map((p) => row(p.id, `${p.sessions.length} floor${p.sessions.length === 1 ? "" : "s"}`, money(p.sessions.reduce((a, s) => a + s.cost.total, 0)))).join("")}<hr>
		${sessions.filter((s) => !s.basic).map((s) => row(s.name, s.project.name, money(s.cost.total))).join("")}<hr>
		<div class="r tot"><span>TOTAL</span><span>${money(total)}</span></div><div class="c">thank you, come again</div></div>`);
}
