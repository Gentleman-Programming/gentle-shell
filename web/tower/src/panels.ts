// Panels that open on demand: intercom, artifact viewer, Engram library, bar tab.
import { FLOOR_COLORS, money, sentMessage, settleOutbox, todoProgress, type Outgoing } from "./model";
import type { Project, TowerArtifact, TowerChatTurn, TowerSnapshot } from "./types";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function postAction(action: Record<string, unknown>): Promise<boolean> {
	try {
		const r = await fetch("api/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action) });
		return r.status === 202;
	} catch { return false; }
}

/** Escape-first Markdown renderer: headings, paragraphs, lists (incl. task lists), tables,
 * code blocks, blockquotes, rules, links, bold, italic, strikethrough, inline code. No raw HTML. */
export function renderMarkdown(md: string): string {
	const inline = (t: string) => {
		const codes: string[] = [];
		let out = esc(t).replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
		out = out
			.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
			.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
			.replace(/~~([^~]+)~~/g, "<s>$1</s>")
			.replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?=[^\w*]|$)/g, "$1<i>$2</i>")
			.replace(/(^|[^\w])_([^_\s][^_]*)_(?=[^\w]|$)/g, "$1<i>$2</i>");
		return out.replace(/\u0000(\d+)\u0000/g, (_m, n) => `<code>${codes[+n]}</code>`);
	};
	const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
	const isRule = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let list: "ul" | "ol" | null = null, para: string[] = [];
	const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
	const close = () => { flush(); if (list) { out.push(`</${list}>`); list = null; } };
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*```/.test(line)) {
			close();
			const code: string[] = [];
			for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(esc(lines[i]));
			out.push(`<pre><code>${code.join("\n")}</code></pre>`);
			continue;
		}
		if (line.includes("|") && i + 1 < lines.length && isRule(lines[i + 1])) {
			close();
			const head = cells(line);
			const rows: string[][] = [];
			for (i += 2; i < lines.length && lines[i].includes("|") && lines[i].trim(); i++) rows.push(cells(lines[i]));
			i--;
			out.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
			continue;
		}
		const h = /^(#{1,6})\s+(.*)$/.exec(line);
		const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
		const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
		const quote = /^\s*>\s?(.*)$/.exec(line);
		if (h) { close(); const lv = Math.min(6, h[1].length + 2); out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); }
		else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { close(); out.push("<hr>"); }
		else if (quote) { close(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); }
		else if (ul || ol) {
			flush();
			const kind = ul ? "ul" : "ol";
			if (list !== kind) { if (list) out.push(`</${list}>`); out.push(`<${kind}>`); list = kind; }
			const body = (ul ?? ol)![1], task = /^\[([ xX])\]\s+(.*)$/.exec(body);
			out.push(task ? `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}> ${inline(task[2])}</li>` : `<li>${inline(body)}</li>`);
		}
		else if (!line.trim()) close();
		else { if (list) { out.push(`</${list}>`); list = null; } para.push(line.trim()); }
	}
	close();
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
// The panel is bound to one session. Live updates rewrite its header and log
// only; the form is built once, so typing keeps its focus, caret and draft.
// The log is a conversation: your messages on the right, the agent's on the left,
// newest at the bottom. What you send shows at once and waits there until the
// session's own record of it arrives.
const outbox = new Map<string, Outgoing[]>();
/** Per session: chat turns that already acknowledged a delivered message, kept across renders. */
const consumedTurns = new Map<string, Set<string>>();
const latest = new Map<string, { s: TowerSnapshot; floor: number }>();
const drawn = new WeakMap<HTMLElement, string>();
function intercomHead(s: TowerSnapshot, floor: number): string {
	const prog = todoProgress(s.todos);
	return `<span class="fkey">${floor + 1}</span><div><b>${esc(s.name)}</b><small>${esc(s.project.name)} · ${money(s.cost.total)}${prog.now ? ` · now: ${esc(prog.now.title)}` : ""}</small></div><button class="x" aria-label="Close intercom">✕</button>`;
}
const STATE_TEXT = { sending: "sending…", sent: "sent", failed: "not sent" } as const;
const time = (at: number) => (at > 0 ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
function bubble(role: "you" | "agent", body: string, meta: string, extra = ""): string {
	return `<div class="m ${role}${extra}"><small>${role === "you" ? "you" : "orchestrator"}${meta ? ` · ${meta}` : ""}</small>${body}</div>`;
}
function intercomLog(s: TowerSnapshot): string {
	const chat = s.chat ?? [];
	// Older publishers send only the latest words: show them as the one agent turn there is.
	const turns: TowerChatTurn[] = s.chat ? chat : s.said ? [{ role: "agent", text: s.said, at: 0 }] : [];
	// The local copy goes once the session holds it and the request succeeded; a failure always stays visible.
	let consumed = consumedTurns.get(s.sessionId);
	if (!consumed) consumedTurns.set(s.sessionId, (consumed = new Set()));
	const { keep, show: pending } = settleOutbox(outbox.get(s.sessionId) ?? [], chat, consumed);
	outbox.set(s.sessionId, keep);
	// One timeline: a reply newer than your message appears below it.
	const items = [
		...turns.map((t) => ({ at: t.at, html: bubble(t.role, t.role === "you" ? `<p>${esc(t.text)}</p>` : renderMarkdown(t.text), time(t.at)) })),
		...pending.map((o) => ({ at: o.at, html: bubble("you", `<p>${esc(o.text)}</p>`, STATE_TEXT[o.state], o.state === "failed" ? " failed" : " pending") })),
	].sort((a, b) => a.at - b.at);
	// Successful requests need no line of their own; failures stay visible. Older publishers still say "Message delivered".
	const notice = s.notice && (s.notice.ok ? s.notice.text.split(" · ").filter((t) => t !== "Message delivered").join(" · ") : s.notice.text);
	return `${s.omitted?.chat ? `<div class="m muted"><small>Earlier messages are in the terminal.</small></div>` : ""}
			${items.length ? items.map((i) => i.html).join("") : `<div class="m muted">No messages yet. Ask this floor anything.</div>`}
			${s.waiting ? `<div class="waiting">? A question is waiting for you in the terminal. Answer it there, or tell the floor here.</div>` : ""}
			${notice ? `<div class="notice ${s.notice!.ok ? "ok" : "bad"}">${esc(notice)}</div>` : ""}`;
}
/** The session the open intercom talks to, if any. */
export function intercomSession(): string | undefined {
	const el = document.getElementById("intercom");
	return el && !el.hidden ? el.dataset.session : undefined;
}
export function closeIntercom(): void {
	const el = document.getElementById("intercom")!;
	el.hidden = true;
	delete el.dataset.session;
}
export function renderIntercom(s: TowerSnapshot, floor: number): void {
	const el = document.getElementById("intercom")!;
	latest.set(s.sessionId, { s, floor });
	el.hidden = false;
	el.style.setProperty("--c", FLOOR_COLORS[floor % FLOOR_COLORS.length]);
	const same = el.dataset.session === s.sessionId && el.querySelector("form.say");
	if (!same) {
		el.dataset.session = s.sessionId;
		el.innerHTML = `<header></header><div class="log" role="log" aria-live="polite"></div>
		<form class="say"><label class="sr" for="say">Message this floor</label><textarea id="say" rows="2"></textarea><button class="btn primary">Send</button></form>`;
		const form = el.querySelector("form")!, box = el.querySelector("textarea")!;
		box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } e.stopPropagation(); });
		form.addEventListener("submit", async (e) => {
			e.preventDefault();
			const text = box.value.trim(); if (!text) return;
			box.value = "";
			// Turns already in the chat when sending can never be this message's echo.
			const out: Outgoing = { ...sentMessage(text, Date.now(), latest.get(s.sessionId)?.s.chat ?? []), state: "sending" };
			outbox.set(s.sessionId, [...(outbox.get(s.sessionId) ?? []), out].slice(-8));
			// Only the log of the session that sent it, and only if its intercom is still open.
			const refresh = () => { const now = latest.get(s.sessionId); if (now && intercomSession() === s.sessionId) updateLog(el, now.s, true); };
			refresh();
			out.state = (await postAction({ type: "message", sessionId: s.sessionId, text })) ? "sent" : "failed";
			refresh();
		});
	}
	const head = el.querySelector("header")!;
	head.innerHTML = intercomHead(s, floor);
	head.querySelector(".x")!.addEventListener("click", () => closeIntercom());
	el.querySelector("textarea")!.placeholder = `Talk to floor ${floor + 1}… Enter sends, Shift+Enter new line`;
	updateLog(el, s, !same);
	if (!same) el.querySelector("textarea")!.focus();
}
/** Redraws the conversation only when it changed; follows the newest message only if you were already at the bottom. */
function updateLog(el: HTMLElement, s: TowerSnapshot, toEnd = false): void {
	const log = el.querySelector<HTMLElement>(".log")!;
	const html = intercomLog(s);
	if (html === drawn.get(log) && !toEnd) return;
	const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
	drawn.set(log, html);
	log.innerHTML = html;
	if (toEnd || atEnd) log.scrollTop = log.scrollHeight;
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
	// Requests can overlap: only the newest search may draw its results.
	let generation = 0;
	const search = async () => {
		const q = input.value.trim();
		const mine = ++generation;
		try {
			const [r1, r2] = await Promise.all([
				q ? fetch(`api/memory/search?${new URLSearchParams({ project: project.id, q })}`) : Promise.resolve(undefined),
				fetch(`api/memory/review?${new URLSearchParams({ project: project.id })}`),
			]);
			const nextFound: Memory[] = r1 && r1.ok ? await r1.json() : [];
			const nextReview: Memory[] = r2.ok ? ((await r2.json()).observations ?? []) : [];
			if (mine !== generation) return;
			found = nextFound;
			review = nextReview;
			draw(review);
		} catch { if (mine === generation) set.innerHTML = `<p class="muted">Engram is not reachable. Is it running?</p>`; }
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
	const submit = form.querySelector("button")!;
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		// One request at a time: every accepted one opens another terminal.
		if (submit.disabled) return;
		submit.disabled = true;
		const prompt = box.value.trim();
		status.textContent = "Opening…";
		const ok = await postAction({ type: "new-floor", project: project.cwd, ...(prompt ? { prompt } : {}) });
		status.textContent = ok ? "Opened. It will appear as a new floor in a moment." : "Could not open a new floor.";
		if (ok) setTimeout(() => closeModals(), 1500);
		else submit.disabled = false;
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
