// The centre column of design/herdr-desktop/01-inspector.html (region 4: header 4a, log 4b,
// composer 4c), drawn from the view's state. Every number is the artboard's; FIDELITY.md maps
// each one to its CSS line. `v` is the GentleChat view, `p` the palette (tokens.js).

import { div, svg } from "gpui-kit";
import { home } from "herdr";
import { v_flex, h_flex, TextView, Textarea, Popover } from "gpui-base";
import { alpha, mono, R } from "./tokens.js";
import { money, prettyModel, seconds, parsePatch } from "./feed.js";
import { SESSION_KINDS, machineOf, liveState } from "./snapshot.js";

const MOD = "gentle-chat";
// A session that runs outside Herdr app (T11): what the Terminal switch and ⌘J say instead.
export const ELSEWHERE = "This session runs in another terminal";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR = "#00000000";
const CLIP = 6000; // characters of a tool's output shown when expanded
const HUNK_ROWS = 80; // diff rows drawn per hunk

export const icon = (name, size = 15) => svg(`mods/${MOD}/icons/${name}.svg`).size(size).flex_none();
const clip = (s) => (s.length > CLIP ? s.slice(0, CLIP) + "\n… (truncated)" : s);
const firstLine = (s) => String(s ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";

// One centred lane of the log: .log-in max-width 780, padding 0 28 (l.116).
export const lane = (el) => div().flex_none().w_full().max_w(780).px(28).self_center().child(el);

// .num (l.50): mono; tabular figures are the font's own.
const num = (text, color) => div().font_family(mono()).when(Boolean(color), (el) => el.text_color(color)).child(text);

// kbd (l.47): 0 5px, 1px line-strong, radius 5, muted 11px mono. An inline box is as tall as
// the font's content area, not the line: 13.5 + 2 × 1 = 15.5 (measured in the render).
const kbd = (p, text) => div().flex_none().px(5).border(1).border_color(p.lineStrong).rounded(R.kbd).text_color(p.muted)
  .text_size(11).line_height("13.5px").font_family(mono()).child(text);

// pi titles its terminal "π - <folder>": the name without the prefix.
export const sessionTitle = (title) => String(title ?? "").replace(/^\s*π\s*[-–—·:]?\s*/u, "").trim();

// Rough text widths for the header's fit (12px: sans ≈ 0.56 em per character, mono 0.5).
const textW = (s, size = 12, monoFont = false) => String(s ?? "").length * size * (monoFont ? 0.5 : 0.56);

// .state (l.79-88): a 7px dot (a ring for idle, dashed for queue) and a label, never colour alone.
// The ring is ::before, which `* { box-sizing: border-box }` does not reach: 5px + 2 × 1.5px = 8px.
export function stateLabel(p, kind, label) {
  const color = { work: p.info, need: p.warn, done: p.ok, idle: p.muted, fail: p.err, queue: p.muted }[kind] ?? p.muted;
  let dot = div().flex_none().rounded_full();
  if (kind === "idle" || kind === "queue") {
    dot = dot.w(8).h(8).border(1.5).border_color(color);
    if (kind === "queue") dot = dot.border_dashed();
  } else dot = dot.w(7).h(7).bg(color);
  // No pulse on a working dot (S13, herdr/PERF.md): a native loop redraws the whole window every
  // frame for as long as it is drawn (≈40 % CPU while a session works). The word says it.
  return h_flex().gap(6).items_center().text_size(12).whitespace_nowrap().text_color(color).child(dot).child(label);
}

// .btn (l.92-95): 5px 10px, radius 8, 1px #ffffff17, muted 12px; hover accent border.
function btn(p, id, label, { danger = false, tip = null, onClick = null, iconName = null } = {}) {
  return h_flex().id(id).flex_none().items_center().gap(6).px(10).py(5).rounded(R.sm).border(1).border_color(p.btnLine)
    .text_size(12).text_color(p.muted).whitespace_nowrap().cursor_pointer()
    .hover((s) => (danger ? s.border_color(p.err).text_color(p.err) : s.border_color(p.accent).text_color(p.accentSoft)))
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .when(Boolean(onClick), (el) => el.on_click(onClick))
    .when(Boolean(iconName), (el) => el.child(icon(iconName, 13)))
    .child(label);
}

const chev = (open) => icon(open ? "down" : "chev", 13);

// A tool's path as the artboard writes it: relative to the session's project or one of its
// worktrees ("herdr/mods/gentle-chat/main.js"), else from the home folder ("~/…").
function shortPath(v, path) {
  const s = v.snap;
  const roots = [s?.project?.cwd, ...(s?.changes?.worktrees ?? []).map((w) => w?.root), v.feed.cwd, v.cwd]
    .filter((r) => typeof r === "string" && r.length > 1).map((r) => r.replace(/\/+$/, "")).sort((a, b) => b.length - a.length);
  const root = roots.find((r) => path.startsWith(r + "/"));
  if (root) return path.slice(root.length + 1);
  let h = "";
  try { h = home(); } catch { h = ""; }
  return h && path.startsWith(h + "/") ? "~" + path.slice(h.length) : path;
}

// The summary beside a tool's name, with its path shortened.
function toolSay(v, call) {
  const path = [call.args?.path, call.args?.file_path].find((x) => typeof x === "string" && x);
  return path && call.summary.startsWith(path) ? shortPath(v, path) + call.summary.slice(path.length) : call.summary;
}

// ---------------------------------------------------------------- 4a header (l.259-270, 369-399)

// The feed carries the mode token ("gentleman"); the header shows it as a name, or null when unknown.
export function personaLabel(persona) {
  const raw = typeof persona === "string" ? persona : persona?.name ?? null;
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : null;
}

export function header(v, p) {
  const s = v.snap;
  const f = v.feed;
  const { stack } = v.stackProps();
  const title = s?.identity?.sessionName || f.name || sessionTitle(v.agentInfo?.title) || "Gentle Shell";
  // The session's kind badge follows its name (S10): Herdr or TUI, as in the sidebar and tabs.
  // S15: then its live state while it is not idle, the sidebar's words ("Working · 2 agents",
  // "Waiting on 2 agents", "Needs you"); an idle session keeps the artboard's quiet header. A
  // narrow card (< 640px) leaves it to the sidebar and the status bar: the name keeps the room.
  const live = s ? liveState(s) : null;
  const herdrWorking = v.agentInfo?.status === "working";
  const roomy = (v.headW ?? Infinity) >= 640;
  const shownLive = !roomy ? null : live && live.status !== "idle" ? live : herdrWorking ? { status: "working", label: "Working" } : null;
  const row1 = h_flex().min_h(30).items_center().justify_between().gap(16).min_w(0).overflow_hidden()
    .child(h_flex().flex_1().min_w(v.elsewhere() ? 150 : 0).gap(8).items_center()
      .child(div().id("title").min_w(0).truncate().text_size(14).font_semibold()
        .tooltip(v.address ? `${v.address}${v.file ? ` · ${v.file}` : ""}` : v.file ? `${ELSEWHERE} · ${v.file}` : "No Gentle Shell session")
        .child(title))
      .when(Boolean(v.key), (el) => el.child(machineOf(v.address)
        ? kindBadge(p, SESSION_KINDS.remote, machineOf(v.address))
        : kindBadge(p, v.elsewhere() ? SESSION_KINDS.tui : SESSION_KINDS.herdr)))
      .when(Boolean(shownLive), (el) => el.child(div().id("chat-state").flex_none()
        .child(stateLabel(p, shownLive.status === "blocked" ? "need" : "work", shownLive.label)))))
    .when(Boolean(stack), (el) => el.child(v.elsewhere() ? elsewhere(v, p) : viewSwitch(v, p)));
  // No clip here: the Model and permission menus open from this row.
  const row2 = h_flex().items_center().justify_between().gap(16).min_w(0)
    .child(crumbs(v, p))
    .child(facts(v, p));
  return v_flex().id("chat-head").flex_none().gap(4).px(14).pt(8).pb(7).border_b(1).border_color(p.line).bg(p.chrome)
    .rounded_t(R.window - 1)
    .on_size_change((size, cx) => { if (Math.abs((v.headW ?? 0) - size.width) >= 1) { v.headW = size.width; cx.notify(); } })
    .on_mouse_down("left", () => v.focus.focus())
    .child(row1).child(row2);
}

// .seg (l.96-99): Chat | Terminal, run("layout.select") on the layout stack.
function viewSwitch(v, p) {
  const showing = v.showing();
  const seg = (id, iconName, label, active, onClick) => h_flex().id(id).items_center().gap(6).px(9).py(2).rounded(R.inner)
    .border(1).border_color(active ? p.lineStrong : CLEAR).when(active, (el) => el.bg(p.selected))
    .text_size(12).text_color(active ? p.text : p.muted).cursor_pointer().hover((st) => st.text_color(p.text))
    .on_click(onClick).child(icon(iconName, 13)).child(label);
  return h_flex().flex_none().p(2).gap(2).border(1).border_color(p.lineStrong).rounded(R.sm)
    .child(seg("sw-chat", "chat", "Chat", showing, (_e, cx) => v.go("chat", cx)))
    .child(seg("sw-term", "term", "Terminal", !showing, (_e, cx) => v.go("terminal", cx)));
}

// A session's own spend as its TUI footer writes it (lib/shell-bar.ts formatCost): $33.46 from a
// dollar up, $0.247 below (S10). The per-message costs in the log keep feed.js money().
const sessionCost = (n) => { const v = Number(n); return Number.isFinite(v) ? `$${v >= 1 ? v.toFixed(2) : v.toFixed(3)}` : "$0.000"; };

// A session's kind (snapshot.js SESSION_KINDS) as the shared badge (tokens.js kindBadge of the other
// mods): its icon and word in the kbd's mono look; Herdr in the info tone, TUI in accent-soft, a
// remote session (S14) in the warn tone with its machine's name.
export function kindBadge(p, kind, machine) {
  const remote = kind.kind === "remote";
  return h_flex().id("kind").flex_none().h(17).px(5).gap(4).items_center().rounded(R.kbd).border(1).border_color(p.lineStrong)
    .font_family(mono()).font_semibold().text_size(10.5).line_height(1.25).text_color(kind.kind === "herdr" ? p.info : remote ? p.warn : p.accentSoft)
    .when(remote, (el) => el.max_w(120).overflow_hidden())
    .tooltip(remote && machine ? `${kind.about} (${machine})` : kind.about)
    .child(icon(kind.icon, 11).flex_none())
    .child(remote && machine ? div().min_w(0).truncate().child(machine) : kind.label);
}

// T11 (S10): a session that runs outside Herdr app has no Terminal here. The switch's place says
// where it runs (its Herdr TUI pane, else its pid), in the switch's muted look.
function elsewhere(v, p) {
  const id = v.snap?.identity;
  const where = id?.herdr?.paneId ? `Herdr ${id.herdr.paneId}` : id?.pid ? `pid ${id.pid}` : null;
  // It gives way to the session's name: the words truncate, the icon stays.
  return h_flex().id("sw-elsewhere").min_w(0).flex_shrink_1().items_center().gap(6).px(9).py(4).border(1).border_color(p.line).rounded(R.sm)
    .text_size(12).text_color(p.muted)
    .tooltip(`${ELSEWHERE}${where ? ` (${where})` : ""}: answer its prompts and run /commands there. Messages, answers, Stop and modes work from here.`)
    // A narrow header says it in two words (the tooltip keeps the whole sentence).
    .child(icon("term", 13).flex_none()).child(div().min_w(0).truncate().child((v.headW ?? Infinity) < 760 ? "Other terminal" : ELSEWHERE));
}

// .crumbs (l.263-264): project / branch · N changed. The project is the Herdr space the session
// runs in ("gentle-pi"), else its folder's name.
function crumbs(v, p) {
  const pr = v.snap?.project;
  const cwd = pr?.cwd ?? v.feed.cwd ?? v.cwd;
  const project = v.agentInfo?.space_name || (cwd ? cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || cwd : null);
  const sep = (t) => div().flex_none().text_color(p.faint).child(t);
  // The names give way (truncate with an ellipsis); icons, separators and the count keep their
  // width. The branch gives way first (shrink 3 to the project's 1); a narrow header (< 560px)
  // keeps only the project, so a name never shrinks to nothing between its icons.
  const give = (el, n = 1) => el.flex_shrink(n).min_w(0).truncate();
  const wide = (v.headW ?? Infinity) >= 560;
  const projectEl = div().child(project ?? "No project");
  const parts = [icon("folder", 13), give(projectEl)];
  if (pr?.branch && wide) parts.push(sep("/"), icon("branch", 13), give(div().child(pr.branch), 3));
  if (Number.isInteger(pr?.dirty) && wide) parts.push(sep("·"), div().flex_none().child(pr.dirty === 0 ? "clean" : `${pr.dirty} changed`));
  return h_flex().mt(1).min_w(0).overflow_hidden().items_center().gap(6).text_size(12).text_color(p.muted).whitespace_nowrap()
    .children(parts);
}

export const PERM = [
  { mode: "normal", label: "Normal", about: "Standard permission prompts", tone: null },
  { mode: "auto", label: "Auto", about: "Independent checks; extra model calls", tone: null },
  { mode: "yolo", label: "YOLO", about: "Scoped work; destructive actions ask", tone: "warn" },
  { mode: "super-yolo", label: "Super-YOLO", about: "No permission prompts; private paths blocked; consent remains", tone: "err" },
];

// .facts-row (l.265-270): Model, Persona, Ctx, Cost, permission menu. Empty fields say so.
function facts(v, p) {
  const s = v.snap;
  const f = v.feed;
  const fact = (id, kids, tip) => h_flex().id(id).items_center().gap(6).px(4).py(3).rounded(R.inner).whitespace_nowrap()
    .text_color(p.text).when(Boolean(tip), (el) => el.tooltip(tip)).children(kids);
  const k = (t) => div().text_color(p.muted).child(t);
  const none = (t = "—") => div().text_color(p.muted).child(t);

  const model = [prettyModel(s?.model?.id ?? f.model), s?.model?.effort ?? (s ? null : f.thinking), s?.model?.profile?.name]
    .filter(Boolean).join(" · ");
  // Model opens the profiles menu (S12: list, active, per-agent models, Apply); Persona opens the
  // TUI's own screen (/gentle:persona) in the Terminal.
  // A narrow card keeps a compact "Model ▾" so the profiles menu stays one click away.
  const modelFact = (compact) => profileMenu(v, p, fact("f-model", [k("Model"), ...(compact ? [] : [model ? div().child(model) : none()]), icon("down", 13).text_color(p.muted)],
    compact ? `Model · ${model || "—"} (switch profile)` : "Model · effort · profile (switch profile)").cursor_pointer().hover((st) => st.bg(p.selected))
    .when(v.busy === "profile", (el) => el.opacity(0.6)));
  const persona = personaLabel(s?.persona);
  const personaFact = fact("f-persona", [icon("user", 13).text_color(p.muted), persona ? div().child(persona) : none("No persona")],
    "Persona (opens /gentle:persona in the Terminal)").cursor_pointer().hover((st) => st.bg(p.selected))
    .on_click((_e, cx) => v.command("persona", "/gentle:persona", cx));

  const ctx = s?.context;
  const pct = Number.isFinite(ctx?.percent) ? Math.max(0, Math.min(100, Math.round(ctx.percent))) : null;
  const kTok = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const ctxTip = Number.isFinite(ctx?.tokens) && Number.isFinite(ctx?.window) ? `Context window · ${kTok(ctx.tokens)} / ${kTok(ctx.window)}` : "Context window";
  const ctxFact = fact("f-ctx", [k("Ctx"), bar(p, pct, p.info, 46), pct === null ? none() : num(`${pct}%`)], ctxTip);

  const total = Number.isFinite(s?.cost?.total) ? s.cost.total : f.total;
  // The TUI footer's own words: "$32.57 sub" on a subscription (S10).
  const sub = Boolean(s?.cost?.subscription);
  const costFact = fact("f-cost", [k("Cost"), num(sessionCost(total)), ...(sub ? [k("sub")] : [])], sub ? "Session spend (subscription)" : "Session spend");

  // Narrow cards drop facts instead of clipping (the artboard has room for all): Persona first,
  // then Ctx, then Model, then Cost; the permission menu always stays. Widths are estimates
  // (padding 4 + 4, gap 6, gap 14 between facts); the crumbs keep 180px.
  const permLabel = PERM.find((m) => m.mode === s?.permission?.mode)?.label ?? (s?.permission?.mode || "—");
  const est = {
    persona: 14 + 13 + 6 + textW(persona ?? "No persona"),
    ctx: 14 + 8 + textW("Ctx") + 6 + 46 + 6 + textW(pct === null ? "—" : `${pct}%`, 12, true),
    model: 14 + 8 + textW("Model") + 6 + textW(model || "—") + 6 + 13,
    cost: 14 + 8 + textW("Cost") + 6 + textW(sessionCost(total), 12, true) + (sub ? 6 + textW("sub") : 0),
  };
  const room = Number.isFinite(v.headW) ? v.headW - 28 - 16 - 180 : Infinity;
  let need = 20 + 13 + 6 + textW(permLabel) + 6 + 13 + Object.values(est).reduce((a, b) => a + b, 0);
  const drop = new Set();
  const compactModel = 14 + 8 + textW("Model") + 6 + 13;
  for (const k of ["persona", "ctx", "model", "cost"]) if (need > room) { drop.add(k); need -= est[k] - (k === "model" ? compactModel : 0); }
  return h_flex().flex_none().items_center().gap(14).text_size(12)
    .child(modelFact(drop.has("model")))
    .when(!drop.has("persona"), (el) => el.child(personaFact))
    .when(!drop.has("ctx"), (el) => el.child(ctxFact))
    .when(!drop.has("cost"), (el) => el.child(costFact))
    .child(permission(v, p));
}

// .bar (l.89-91): 4px, pill, raised groove.
export function bar(p, pct, color, width) {
  return div().flex_none().w(width).h(4).rounded_full().bg(p.raised).overflow_hidden()
    .when(pct !== null && pct > 0, (el) => el.child(div().h_full().w(`${pct}%`).rounded_full().bg(color)));
}

// .perm + .perm-menu (l.102-112): the four live modes. Choosing one asks the session's permission
// owner (the one /gentle:mode uses); Super-YOLO asks first.
function permission(v, p) {
  const perm = v.snap?.permission;
  const cur = PERM.find((m) => m.mode === perm?.mode);
  const yolo = Boolean(perm?.yolo);
  const pill = h_flex().id("perm").items_center().gap(6).px(9).py(3).rounded_full().border(1).text_size(12).whitespace_nowrap()
    .cursor_pointer()
    .when(v.busy === "perm", (el) => el.opacity(0.6))
    .border_color(yolo ? alpha(p.warn, 0x99 / 255) : p.lineStrong)
    .when(yolo, (el) => el.bg(alpha(p.warn, 0x14 / 255)))
    .text_color(yolo ? p.warn : cur ? p.text : p.muted)
    .tooltip(perm?.detail ? `Permission mode: ${cur?.label ?? perm.mode} · ${perm.detail}` : `Permission mode: ${cur?.label ?? "unknown"}`)
    .child(icon("shield", 13)).child(cur?.label ?? (perm?.mode || "—")).child(icon("down", 13));
  const item = (m) => {
    const on = m === cur;
    const color = m.tone === "warn" ? p.warn : m.tone === "err" ? p.err : p.text;
    return h_flex().id(`perm-${m.mode}`).w_full().items_start().gap(8).px(8).py(7).rounded(R.inner).cursor_pointer()
      .hover((st) => st.bg(p.selected)).tooltip(on ? `${m.label} is this session's mode` : `Switch this session to ${m.label}`)
      .on_click((_e, cx) => v.setMode(m.mode, cx))
      .child(div().w(18).h(18).flex_none().items_center().justify_center().flex()
        .when(on, (el) => el.child(icon("check", 13).text_color(p.accent))))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().font_semibold().text_size(13).text_color(color).child(m.label))
        .child(div().text_size(12).text_color(p.muted).child(m.about)));
  };
  const menu = v_flex().mt(6).w(330).p(6).bg(p.raised).border(1).border_color(p.lineStrong).rounded(R.md).shadow_lg()
    .text_color(p.text).children(PERM.map(item));
  // The menu's top-right corner on the pill: below it, right-aligned, 6px down (l.107).
  return Popover.new("perm-menu").anchor("top_right").open(Boolean(v.permOpen))
    .on_open_change((open, cx) => { v.permOpen = open; cx.notify(); })
    .trigger(pill).content(menu);
}

// The profiles menu (S12), in the permission menu's look (.perm-menu l.102-112): the saved
// profiles (/gentle:profiles' store) with the session's one checked, the per-agent models of the
// hovered (or selected) profile, Apply ("Use in this session", through the session's own
// /gentle:profiles apply), and "Manage in Terminal" (the TUI screen, Herdr sessions only).
const PROFILE_ROWS = 12; // agent rows shown before "+N more"
function profileMenu(v, p, trigger) {
  const list = v.snap?.profiles ?? null;
  const active = list?.active ?? null;
  // The session's profile first, then the store's order.
  const items = (Array.isArray(list?.items) ? list.items : []).slice().sort((a, b) => (b.name === active) - (a.name === active));
  const shown = items.find((i) => i.name === v.profAt) ?? items.find((i) => i.name === active) ?? items[0] ?? null;
  const tag = (text, color) => div().flex_none().px(5).rounded(R.kbd).border(1).border_color(p.lineStrong)
    .font_family(mono()).text_size(10.5).line_height("14px").text_color(color ?? p.muted).child(text);
  const about = (i) => [`${i.roles.length}${i.truncated ? "+" : ""} ${i.roles.length === 1 ? "role" : "roles"}`, i.tier, i.mode && i.mode !== "organic" ? i.mode : null]
    .filter(Boolean).join(" · ");
  const item = (i) => {
    const on = i.name === active;
    const picked = i.name === shown?.name;
    return h_flex().id(`prof-${i.name}`).w_full().items_start().gap(8).px(8).py(7).rounded(R.inner).cursor_pointer()
      .when(picked, (el) => el.bg(p.selected)).hover((st) => st.bg(p.selected))
      .tooltip(on ? `${i.name} is this session's profile` : `Show ${i.name}; Apply uses it in this session`)
      .on_mouse_move((_e, cx) => { if (v.profAt !== i.name) { v.profAt = i.name; cx.notify(); } })
      .on_click((_e, cx) => { v.profAt = i.name; cx.notify(); })
      .child(div().w(18).h(18).flex_none().items_center().justify_center().flex()
        .when(on, (el) => el.child(icon("check", 13).text_color(p.accent))))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center()
          .child(div().font_semibold().text_size(13).text_color(p.text).truncate().child(i.name))
          .when(list?.default === i.name, (el) => el.child(tag("default"))))
        .child(div().text_size(12).text_color(p.muted).child(about(i))));
  };
  const route = (agent, r, key) => h_flex().id(key).w_full().gap(8).items_baseline().px(8).py(2).text_size(12)
    .tooltip(`${agent}: ${r.model}${r.thinking && r.thinking !== "inherit" ? ` · ${r.thinking}` : ""}`)
    .child(div().w(132).flex_none().truncate().font_family(mono()).text_size(11.5).text_color(p.muted).child(agent))
    .child(div().flex_1().min_w(0).truncate().text_color(p.text).child(prettyModel(r.model) || r.model))
    .when(Boolean(r.thinking) && r.thinking !== "inherit", (el) => el.child(div().flex_none().text_color(p.muted).child(r.thinking)));
  const detail = shown ? v_flex().w_full().gap(1).pt(6).mt(2).border_t(1).border_color(p.line)
    .when(Boolean(shown.orchestrator), (el) => el.child(route("orchestrator", shown.orchestrator, "prof-orch")))
    .children(shown.roles.slice(0, PROFILE_ROWS).map((r) => route(r.agent, r, `prof-role-${r.agent}`)))
    .when(shown.roles.length > PROFILE_ROWS || shown.truncated, (el) => el.child(div().px(8).py(2).text_size(11.5).text_color(p.faint)
      .child(`+${Math.max(0, shown.roles.length - PROFILE_ROWS)} more in /gentle:profiles`)))
    .when(!shown.roles.length && !shown.orchestrator, (el) => el.child(div().px(8).py(2).text_size(12).text_color(p.muted)
      .child("No routing entries: every agent inherits its default model."))) : null;
  const canApply = Boolean(shown) && shown.name !== active && !v.busy;
  const apply = h_flex().id("prof-apply").flex_none().items_center().px(10).py(5).rounded(R.sm).text_size(12).font_semibold()
    .when(canApply, (el) => el.bg(p.accent).text_color(p.onAccent).cursor_pointer().hover((st) => st.opacity(0.88))
      .on_click((_e, cx) => v.applyProfile(shown.name, cx)))
    .when(!canApply, (el) => el.border(1).border_color(p.btnLine).text_color(p.faint))
    .tooltip(shown && shown.name === active ? `${shown.name} is already this session's profile` : "Use this profile in this session (as /gentle:profiles does)")
    .child(shown && shown.name === active ? "In use" : "Apply");
  const manage = !v.elsewhere()
    ? div().id("prof-manage").text_size(12).text_color(p.muted).cursor_pointer().hover((st) => st.text_color(p.accentSoft))
      .tooltip("Opens /gentle:profiles in the Terminal").on_click((_e, cx) => { v.profOpen = false; v.command("model", "/gentle:profiles", cx); })
      .child("Manage in Terminal")
    : div().text_size(12).text_color(p.faint).child("Manage in that session's terminal");
  const empty = !list
    ? "This session publishes no profiles. Update Gentle Shell and restart it."
    : "No saved profiles. Create them with /gentle:profiles.";
  const menu = v_flex().mt(6).w(420).p(6).bg(p.raised).border(1).border_color(p.lineStrong).rounded(R.md).shadow_lg()
    .text_color(p.text)
    .child(h_flex().px(8).pt(2).pb(6).items_center().justify_between()
      .child(div().font_family(mono()).font_weight(600).text_size(11).text_color(p.muted).child("PROFILES"))
      .when(Boolean(active), (el) => el.child(div().text_size(12).text_color(p.muted).child(`Session: ${active}`))))
    .when(!items.length, (el) => el.child(div().px(8).py(7).text_size(12.5).text_color(p.muted).child(empty)))
    .child(v_flex().id("prof-list").w_full().max_h(260).overflow_y_scrollbar().children(items.map(item)))
    .when(Boolean(detail), (el) => el.child(detail))
    .child(h_flex().px(8).pt(8).pb(2).items_center().justify_between().child(manage).when(Boolean(shown), (el) => el.child(apply)));
  // The menu's top-left corner under the Model fact, 6px down (the permission menu's offset).
  return Popover.new("prof-menu").anchor("top_left").open(Boolean(v.profOpen))
    .on_open_change((open, cx) => { v.profOpen = open; if (open) v.profAt = null; cx.notify(); })
    .trigger(trigger).content(menu);
}

// ---------------------------------------------------------------- 4b log (l.115-172)

// Consecutive assistant messages are one reply (.msg-ai, gap 10); everything else stands alone.
export function entries(items) {
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === "assistant" && last?.kind === "turn") last.items.push(it);
    else if (it.kind === "assistant") out.push({ kind: "turn", id: it.id, items: [it] });
    else out.push(it);
  }
  return out;
}

export function entry(v, p, e, live) {
  if (e.kind === "user") return userMessage(p, e);
  if (e.kind === "note") return noteCard(v, p, e);
  if (e.kind === "skill") {
    return card(v, p, `skill-${e.id}`, false, [glyph(p, "✦", p.accent), name("skill"), arg(p, e.name)],
      () => markdownBody(p, `sk-${e.id}`, e.text));
  }
  if (e.kind === "compaction") {
    const said = Number.isFinite(e.tokens) ? `Compacted from ${grouped(e.tokens)} tokens` : "Compacted";
    return card(v, p, `cmp-${e.id}`, false, [glyph(p, "⊟", p.muted), name("compaction"), arg(p, said)],
      () => markdownBody(p, `cm-${e.id}`, e.summary));
  }
  if (e.kind === "branch") {
    return card(v, p, `br-${e.id}`, false, [glyph(p, "⑂", p.muted), name("branch"), arg(p, firstLine(e.summary))],
      () => markdownBody(p, `bs-${e.id}`, e.summary));
  }
  return turn(v, p, e, live);
}

// ---- The minimal view (T12, S11; MINIMAL.md): every non-text item is one row in the .tool look
// (l.135-140: 1px line, surface, radius 8; summary 7px 10px, gap 8, 12.5px; status, semibold
// name, mono 12px muted argument, a muted note, the chevron). A click on the row opens it and
// closes it again; ⌘O (gentle-chat.expand) opens or closes every row. The body is built only
// while it is open.

function card(v, p, id, def, kids, body, note = null) {
  const open = v.isOpen(id, def);
  return v_flex().w_full().min_w(0).overflow_hidden().border(1).border_color(p.line).bg(p.surface).rounded(R.sm)
    .child(summaryRow(v, p, id, [...kids, note, chev(open)], def))
    .when(open, (el) => el.child(body()));
}

const glyph = (p, text, color) => div().flex_none().w(13).text_center().text_color(color).child(text);
const name = (text) => div().flex_none().font_semibold().child(text);
// One line for a row: tabs, line breaks and runs of spaces become one space, so a summary never
// carries a break or a tab stop past the truncation (a bash argument with "\t" did).
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const arg = (p, text) => div().flex_1().min_w(0).truncate().font_family(mono()).text_size(12).text_color(p.muted).child(oneLine(text));
const grouped = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// .tool-body (l.141) holding markdown: 1px rule, 8px 10px 10px, 13px.
const markdownBody = (p, key, text) => div().w_full().border_t(1).border_color(p.line).px(10).pt(8).pb(10).text_size(13)
  .child(TextView.markdown(key, text).selectable(true));

// A custom message the session displays (subagent output, review notes, …). One short line
// stays as it is; anything longer is a row that opens to the whole message, as the TUI's
// message renderers fold theirs.
function noteCard(v, p, e) {
  const first = firstLine(e.text);
  // A user-role message the runtime wrote (a Gentle Agents wake, a harness note; feed.js
  // systemMessage) is never a "You" bubble: one closed notice row that opens to its text.
  if (e.system) {
    return card(v, p, `note-${e.id}`, false, [icon("mark", 13).text_color(p.muted), name(e.label || "System"), arg(p, first),
      e.time ? div().flex_none().text_size(11.5).text_color(p.faint).child(e.time) : null],
    () => markdownBody(p, `n-${e.id}`, e.text));
  }
  if (e.text.trim() === first && first.length <= 160) {
    return div().px(10).py(6).rounded(R.sm).border_l(2).border_color(p.accent).bg(p.surface).text_size(12)
      .min_w(0).overflow_hidden().child(TextView.markdown(`n-${e.id}`, e.text).selectable(true));
  }
  return card(v, p, `note-${e.id}`, false, [icon("chat", 13).text_color(p.accent), name(e.type || "note"), arg(p, first)],
    () => markdownBody(p, `n-${e.id}`, e.text));
}

// .msg-user (l.120-122): right, max 82%, bubble 9px 13px, radius 12, 14px/1.55; meta 11.5px.
function userMessage(p, e) {
  return h_flex().w_full().justify_end()
    .child(v_flex().max_w("82%").items_end().gap(4)
      .child(div().bg(p.user).border(1).border_color(p.lineStrong).rounded(R.md).px(13).py(9).text_size(14).line_height(1.55)
        .child(TextView.markdown(`u-${e.id}`, e.text).selectable(true)))
      .child(div().text_size(11.5).text_color(p.muted).child(e.time ? `You · ${e.time}` : "You")));
}

const EXPLORE = { read: "read", grep: "search", find: "search", glob: "search", ls: "list" };

function turn(v, p, e, live) {
  const parts = [];
  e.items.forEach((it, i) => {
    const lastItem = live && i === e.items.length - 1;
    const blocks = it.blocks;
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      const key = `${it.id}-${k}`;
      if (b.type === "text") {
        parts.push(div().w_full().text_size(14).line_height(1.6).child(TextView.markdown(`a-${key}`, b.text).selectable(true)));
      } else if (b.type === "thinking") {
        // Consecutive thinking blocks are one run, one row (pi's AssistantMessageComponent).
        let j = k + 1;
        while (j < blocks.length && blocks[j].type === "thinking") j++;
        const run = j - k > 1 ? { type: "thinking", text: blocks.slice(k, j).map((x) => x.text.trim()).join("\n\n") } : b;
        parts.push(thinking(v, p, run, key, it.seconds, lastItem && j === blocks.length));
        k = j - 1;
      } else {
        // A run of read-only tools is one "Explored" group (.tool-group, l.143-145).
        let j = k;
        while (j < blocks.length && blocks[j].type === "tool" && EXPLORE[blocks[j].call.name]) j++;
        if (j - k >= 2) {
          parts.push(toolGroup(v, p, blocks.slice(k, j).map((x) => x.call), key, live));
          k = j - 1;
        } else parts.push(toolCard(v, p, b.call, key, live));
      }
    }
    if (it.error) parts.push(div().w_full().min_w(0).text_size(12).text_color(p.err).child(`⚠ ${it.error}`));
  });
  return v_flex().w_full().gap(10).children(parts);
}

// .think (l.132-134): italic muted 12.5px summary; body 2px line-strong rule, muted 13px.
// Closed by default when the session hides thinking blocks (pi's hideThinkingBlock), open
// otherwise, as the TUI draws them.
function thinking(v, p, b, key, secs, now) {
  const id = `th-${key}`;
  const def = !v.hideThinking;
  const open = v.isOpen(id, def);
  const label = now ? "Thinking…" : Number.isFinite(secs) && secs > 0 ? `Thought for ${secs}s` : "Thought";
  return v_flex()
    .child(h_flex().id(id).gap(6).items_center().text_size(12.5).italic().text_color(p.muted).cursor_pointer()
      .hover((st) => st.text_color(p.text)).on_click((_e, cx) => v.toggle(id, def, cx))
      .child(chev(open)).child(label))
    .when(open, (el) => el.child(div().mt(6).ml(6).pl(12).border_l(2).border_color(p.lineStrong).text_size(13).text_color(p.muted)
      .child(TextView.markdown(`tht-${key}`, b.text).selectable(true))));
}

function mark(p, call, live) {
  const r = call.result;
  if (r) return div().flex_none().text_color(r.error ? p.err : p.ok).child(r.error ? "✕" : "✓");
  // A running tool: a still mark in the working colour (S13: no spinner while a tool runs, which
  // can be minutes; the Send button keeps its spinner for the second a send takes).
  return div().flex_none().text_color(live ? p.info : p.faint).child("•");
}

// What a finished tool says beside its arguments: "· 299 lines", "· 6 matches".
function countNote(call) {
  const r = call.result;
  if (!r || r.error) return "";
  const n = r.text.split("\n").filter((l) => l.trim()).length;
  if (call.name === "read") return ` · ${n} lines`;
  if (EXPLORE[call.name] === "search") return ` · ${n} ${n === 1 ? "match" : "matches"}`;
  return "";
}

// The dim note at the right of a tool summary: a bash outcome, or why it failed (the TUI keeps a
// failed card's error tail while collapsed), and the time it took. The tail and the time are
// separate pieces: the tail may truncate, the time never does.
function sideNote(call) {
  const r = call.result;
  if (!r) return { tail: "", took: "" };
  const took = seconds(r.ms) || "";
  const last = firstLine(r.text.split("\n").filter((l) => l.trim()).pop() ?? "");
  const said = r.error || call.name === "bash" ? last : "";
  // A failure's tail keeps its whole line (the row truncates it to fit); an outcome its 40.
  const tail = !r.error && said.length > 40 ? said.slice(0, 39) + "…" : said;
  return { tail, took };
}

// .tool (l.135-142): 1px line, surface, radius 8; summary 7px 10px, 12.5px.
function toolCard(v, p, call, key, live) {
  if (call.name === "subagent_run") return subagentCard(v, p, call, key);
  const patch = call.name === "edit" && call.result?.patch ? parsePatch(call.result.patch) : null;
  if (patch?.hunks.length) return diffCard(v, p, call, key, patch, live);
  const id = `tool-${key}`;
  const open = v.isOpen(id, false);
  const r = call.result;
  const { tail, took } = sideNote(call);
  const args = JSON.stringify(call.args, null, 2) ?? "";
  const argsSay = args.includes("\n") && args.length > call.summary.length + 20;
  const failed = Boolean(r?.error) && Boolean(tail);
  const said = oneLine(toolSay(v, call) + countNote(call));
  // One piece of the row takes the room that is left and truncates: the error's tail on a
  // failure (the argument then keeps at most a third of the row, and is dropped when empty),
  // else the argument (the outcome keeps at most a third). The bounded piece gives way too once
  // the other is gone, so mark, name, time and chevron always stay inside the card.
  const bounded = (el) => el.flex_grow_0().flex_shrink_1().min_w(0).max_w("33%");
  const argEl = div().min_w(0).truncate().font_family(mono()).text_size(12).text_color(p.muted).child(said);
  return v_flex().w_full().min_w(0).overflow_hidden().border(1).border_color(p.line).bg(p.surface).rounded(R.sm)
    .child(summaryRow(v, p, id, [
      mark(p, call, live),
      div().flex_none().font_semibold().child(call.name),
      failed ? (said ? bounded(argEl) : null) : argEl.flex_1(),
      tail ? div().id(`${id}-tail`).min_w(0).truncate().text_color(failed ? p.err : p.muted)
        .map((el) => (failed ? el.flex_1() : bounded(el))).child(took ? `${oneLine(tail)} ·` : oneLine(tail)) : null,
      took ? div().flex_none().text_color(failed ? p.err : p.muted).child(took) : null,
      chev(open),
    ]))
    .when(open, (el) => el.child(v_flex().gap(8).border_t(1).border_color(p.line).px(10).pt(8).pb(10).text_size(12)
      .when(argsSay, (e2) => e2.child(pre(p, clip(args), p.muted)))
      .child(pre(p, r ? clip(r.text || "(no output)") : live ? "Running…" : "No result yet", r?.error ? p.err : p.text))));
}

// Every summary row is one line that never paints past its card: the row clips, and each
// caller gives exactly one middle piece flex_1 + min_w(0) + truncate.
function summaryRow(v, p, id, kids, def = false) {
  return h_flex().id(id).w_full().min_w(0).overflow_hidden().whitespace_nowrap().items_center().gap(8).px(10).py(7).text_size(12.5).rounded(R.sm).cursor_pointer()
    .hover((st) => st.bg(p.selected)).on_click((_e, cx) => v.toggle(id, def, cx))
    .children(kids.filter(Boolean));
}

// .tool-body pre (l.142): mono 12px/1.55, pre-wrap.
const pre = (p, text, color) => div().w_full().font_family(mono()).text_size(12).line_height(1.55).text_color(color).child(text);

// .tool-group (l.143-145): "✓ Explored · 3 reads, 1 search  0.8s", expands to the cards.
function toolGroup(v, p, calls, key, live) {
  const id = `grp-${key}`;
  const open = v.isOpen(id, false);
  const counts = {};
  for (const c of calls) counts[EXPLORE[c.name]] = (counts[EXPLORE[c.name]] ?? 0) + 1;
  const plural = { read: "reads", search: "searches", list: "lists" };
  const said = Object.entries(counts).map(([k, n]) => `${n} ${n === 1 ? k : plural[k]}`).join(", ");
  const failed = calls.some((c) => c.result?.error);
  const pending = calls.some((c) => !c.result);
  const ms = calls.reduce((n, c) => n + (c.result?.ms ?? 0), 0);
  const m = pending ? div().flex_none().text_color(live ? p.info : p.faint).child("•")
    : div().flex_none().text_color(failed ? p.err : p.ok).child(failed ? "✕" : "✓");
  // The words give way (no grow: the time sits right after them, as in .tool-group).
  return v_flex().w_full().min_w(0)
    .child(h_flex().id(id).w_full().min_w(0).overflow_hidden().whitespace_nowrap().gap(8).py(2).items_center().text_size(12.5)
      .text_color(p.muted).cursor_pointer()
      .hover((st) => st.text_color(p.text)).on_click((_e, cx) => v.toggle(id, false, cx))
      .child(chev(open)).child(m).child(div().flex_shrink_1().min_w(0).truncate().child(`Explored · ${said}`))
      .when(ms > 0, (el) => el.child(div().flex_none().text_color(p.muted).child(seconds(ms)))))
    .when(open, (el) => el.child(v_flex().mt(8).gap(6).children(calls.map((c, i) => toolCard(v, p, c, `${key}-${i}`, live)))));
}

// .tool.diff + .hunk + .diff-foot (l.146-154). The artboard draws it open; the minimal view
// (S11) starts it as its summary row (file, +N −M) like the TUI's command-only edit card.
function diffCard(v, p, call, key, patch, live) {
  const id = `diff-${key}`;
  const open = v.isOpen(id, false);
  const at = Math.min(v.hunkAt.get(id) ?? 0, patch.hunks.length - 1);
  const h = patch.hunks[at];
  const row = (bg, ln, sign, signColor, text, textColor) => h_flex().w_full().pr(10).when(Boolean(bg), (el) => el.bg(bg))
    .child(div().w(40).flex_none().pr(8).text_right().text_color(p.muted).child(ln))
    .child(div().w(16).flex_none().when(Boolean(signColor), (el) => el.text_color(signColor)).child(sign))
    .child(div().flex_1().min_w(0).truncate().text_color(textColor ?? p.text).child(text || " "));
  const rows = [row(p.raised, "", "", null, h.header, p.muted)];
  for (const r of h.rows.slice(0, HUNK_ROWS)) {
    if (r.kind === "a") rows.push(row(alpha(p.ok, 0x14 / 255), String(r.ln), "+", p.ok, r.text));
    else if (r.kind === "d") rows.push(row(alpha(p.err, 0x14 / 255), String(r.ln), "−", p.err, r.text));
    else rows.push(row(null, String(r.ln), "", null, r.text));
  }
  if (h.rows.length > HUNK_ROWS) rows.push(row(null, "", "", null, `… ${h.rows.length - HUNK_ROWS} more lines`, p.muted));
  const path = typeof call.args?.path === "string" ? shortPath(v, call.args.path) : toolSay(v, call);
  return v_flex().w_full().min_w(0).overflow_hidden().border(1).border_color(p.line).bg(p.surface).rounded(R.sm)
    .child(summaryRow(v, p, id, [
      mark(p, call, live),
      div().flex_none().font_semibold().child(call.name),
      div().flex_1().min_w(0).truncate().font_family(mono()).text_size(12).text_color(p.muted).child(oneLine(path)),
      num(`+${patch.added}`, p.ok).flex_none(),
      num(`−${patch.deleted}`, p.err).flex_none(),
      chev(open),
    ]))
    .when(open, (el) => el.child(v_flex().border_t(1).border_color(p.line)
      .child(v_flex().py(4).font_family(mono()).text_size(12).line_height(1.6).children(rows))
      .child(h_flex().justify_between().items_center().gap(8).px(10).py(6).border_t(1).border_color(p.line).text_size(12).text_color(p.muted)
        .child(`Hunk ${at + 1} of ${patch.hunks.length}`)
        .child(h_flex().gap(6)
          .child(btn(p, `${id}-next`, "Next hunk", {
            tip: patch.hunks.length > 1 ? null : "This edit has one hunk",
            onClick: (_e, cx) => { v.hunkAt.set(id, (at + 1) % patch.hunks.length); cx.notify(); },
          }))
          .child(btn(p, `${id}-changes`, "Open in Changes", {
            tip: "Show this file in the inspector's Changes tab",
            onClick: (_e, cx) => v.openInChanges(typeof call.args?.path === "string" ? shortPath(v, call.args.path) : "", cx),
          }))))));
}

const AGENT_STATE = {
  queued: ["queue", "Queued"], running: ["work", "Running"], starting: ["work", "Running"], waiting: ["need", "Waiting"],
  completed: ["done", "Done"], failed: ["fail", "Failed"], timed_out: ["fail", "Timed out"], cancelled: ["idle", "Cancelled"],
};

// .sub (l.155-160): a subagent run, live from the snapshot's agents when it lists the task. The
// minimal view (S11) draws it as one row in the .tool look (role, task, state, model, spend);
// open, it is the artboard's card, whose title row closes it again.
function subagentCard(v, p, call, key) {
  const a = call.args ?? {};
  const started = call.result?.agent ?? null;
  const live = started?.taskId ? v.snap?.agents?.items?.find((x) => x.id === started.taskId) : null;
  const name = String(live?.name ?? started?.agent ?? a.agent ?? "agent");
  const role = name.replace(/^gentle-ai-/, "").replace(/^gentle-/, "");
  const title = oneLine(a.label || firstLine(a.task) || name);
  const status = live?.state ?? started?.status ?? (call.result ? (call.result.error ? "failed" : "completed") : "queued");
  const [kind, label] = AGENT_STATE[status] ?? ["idle", status];
  const model = prettyModel(live?.model ?? started?.model);
  const cost = live?.spend?.cost;
  const step = live?.step ?? started?.lastStep;
  const running = kind === "work" || kind === "need" || kind === "queue";
  const taskId = live?.id ?? started?.taskId ?? null;
  const stopping = Boolean(taskId) && v.busy === `stop-${taskId}`;
  const id = `sub-${key}`;
  const roleTag = div().flex_none().font_family(mono()).text_size(11).text_color(p.accent).child(role.toUpperCase());
  if (!v.isOpen(id, false)) {
    return v_flex().w_full().min_w(0).overflow_hidden().border(1).border_color(p.line).bg(p.surface).rounded(R.sm)
      .child(summaryRow(v, p, id, [
        roleTag,
        // The task takes what is left; the state's word and the model give way after it (at
        // most a third each); role, spend and chevron keep their width.
        div().flex_1().min_w(0).truncate().child(title),
        stateLabel(p, kind, div().min_w(0).truncate().child(label)).flex_grow_0().flex_shrink_1().min_w(0).max_w("33%"),
        model ? div().flex_grow_0().flex_shrink_1().min_w(0).max_w("33%").truncate().text_size(12).text_color(p.muted).child(model) : null,
        Number.isFinite(cost) ? num(money(cost), p.muted).flex_none().text_size(12) : null,
        chev(false),
      ]));
  }
  return v_flex().w_full().min_w(0).overflow_hidden().gap(4).px(12).py(10).border(1).border_color(p.lineStrong).rounded(R.md).bg(p.surface)
    .child(h_flex().items_start().gap(12).min_w(0)
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(h_flex().id(id).gap(8).items_center().min_w(0).overflow_hidden().whitespace_nowrap().text_size(13).font_semibold().cursor_pointer()
          .hover((st) => st.text_color(p.accentSoft)).on_click((_e, cx) => v.toggle(id, false, cx))
          .child(roleTag)
          .child(div().flex_1().min_w(0).truncate().child(title))
          .child(chev(true).text_color(p.muted)))
        .child(h_flex().flex_wrap().gap(12).items_center().text_size(12).text_color(p.muted)
          .child(stateLabel(p, kind, label))
          .when(Boolean(model), (el) => el.child(div().child(model)))
          .when(Number.isFinite(cost), (el) => el.child(num(money(cost))))))
      // View opens the TUI's /gentle:agents; Stop asks the subagent owner (as desktop RPC
      // cancel_subagent). Only a subagent that still runs has them (the inspector's .acts, l.213).
      .when(running, (el) => el.child(h_flex().flex_none().gap(6).items_start()
        .child(btn(p, `sub-view-${key}`, "View", { tip: "Open /gentle:agents in the Terminal", onClick: (_e, cx) => v.command(`view-${key}`, "/gentle:agents", cx) }))
        .when(Boolean(taskId), (el) => el.child(btn(p, `sub-stop-${key}`, stopping ? "Stopping…" : "Stop", {
          danger: true, iconName: "stop", tip: "Stop this subagent", onClick: (_e, cx) => v.stopAgent(taskId, cx),
        }))))))
    .when(Boolean(step) && step !== status, (el) => el.child(div().mt(2).pt(6).border_t(1).border_color(p.line)
      .font_family(mono()).text_size(12).text_color(p.muted).truncate().child(`› ${step}`)))
    // The run's own answer (its result text), as the TUI's expanded card shows it.
    .when(Boolean(call.result?.text?.trim()), (el) => el.child(div().mt(2).pt(6).border_t(1).border_color(p.line)
      .text_size(13).child(TextView.markdown(`sr-${key}`, clip(call.result.text)).selectable(true))));
}

// The options a pending question offers: its own, then "Something else…" when it takes a
// typed answer. "(Recommended)" in a label becomes the badge. A question the session marks
// `terminalOnly` (consent, a relayed provider decision, several questions) offers none here.
export function askOptions(pq) {
  if (pq?.terminalOnly) return [];
  return choiceRows(pq);
}

function choiceRows(pq) {
  const opts = (pq?.options ?? []).map((o) => {
    const raw = String(o.label ?? "");
    const rec = /\s*\(recommended\)\s*$/i.test(raw);
    return { label: raw.replace(/\s*\(recommended\)\s*$/i, ""), about: o.description ?? null, rec, custom: false };
  });
  if (opts.length && pq.custom) opts.push({ label: "Something else…", about: "Type your own answer in the composer.", rec: false, custom: true });
  return opts;
}

// .ask (l.161-171): the open question, clickable options, keys 1–N.
export function askCard(v, p, pq) {
  const opts = askOptions(pq);
  const done = v.answered;
  const n = opts.length;
  const foot = done
    ? (opts[done.index]?.custom ? "Type your answer in the composer; it goes to this question." : `Answer sent: ${done.index + 1}. The agent continues.`)
    : n ? `Press ${n === 1 ? "1" : `1–${n}`} or click · Esc answers later` : "Answer it in the Terminal view.";
  // Terminal-only: the options are shown for reading, never numbered or clickable.
  const shown = n ? [] : (pq.terminalOnly ? choiceRows(pq).filter((o) => !o.custom) : []);
  const readOnly = (o, i) => v_flex().id(`ask-ro-${i}`).w_full().min_w(0).overflow_hidden().gap(1).px(10).py(6).rounded(R.sm).border(1).border_color(p.line).bg(p.background)
    .child(div().min_w(0).font_semibold().text_size(13.5).child(o.label))
    .when(Boolean(o.about), (el) => el.child(div().text_size(12.5).text_color(p.muted).child(o.about)));
  const many = (pq.questions?.length ?? 0) > 1 ? ` · 1 of ${pq.questions.length}` : "";
  const opt = (o, i) => {
    const pressed = done?.index === i;
    return h_flex().id(`ask-${i}`).w_full().min_w(0).overflow_hidden().min_h(44).items_start().gap(10).px(10).py(8).rounded(R.sm).border(1)
      .border_color(pressed ? p.accent : p.line).bg(pressed ? p.selected : p.background)
      .when(Boolean(done) && !pressed, (el) => el.opacity(0.55))
      .when(!done, (el) => el.cursor_pointer().hover((st) => st.border_color(p.accent)).on_click((_e, cx) => v.answer(i, cx)))
      .child(div().w(26).flex_none()
        .child(div().w(22).h(22).flex().items_center().justify_center().border(1).border_color(p.lineStrong).rounded(R.inner)
          .font_family(mono()).font_semibold().text_size(12).line_height(1).text_color(p.accentSoft).child(String(i + 1))))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().min_w(0).items_center().flex_wrap()
          .child(div().min_w(0).font_semibold().text_size(13.5).child(o.label))
          .when(o.rec, (el) => el.child(div().flex_none().ml(8).font_family(mono()).font_semibold().text_size(10.5).line_height(1)
            .text_color(p.accent).child("RECOMMENDED"))))
        .when(Boolean(o.about), (el) => el.child(div().text_size(12.5).text_color(p.muted).child(o.about))));
  };
  // A 3px accent left edge on a 1px line-strong card: Herdr draws one border colour per
  // element, so the accent is the outer fill showing through a 3px left inset, and the card
  // keeps its top, right and bottom borders.
  return h_flex().w_full().rounded(R.md).bg(p.accent).pl(3)
    .child(v_flex().flex_1().min_w(0).gap(8).py(12).pl(14).pr(14).bg(p.surface)
      .rounded_tl(R.md - 3).rounded_bl(R.md - 3).rounded_tr(R.md).rounded_br(R.md)
      .border_t(1).border_r(1).border_b(1).border_color(p.lineStrong)
      .child(div().font_family(mono()).font_semibold().text_size(11).line_height(1.4).text_color(p.accent)
        .child(`QUESTION · THE AGENT WAITS FOR YOU${many.toUpperCase()}`))
      .child(div().min_w(0).text_size(14.5).font_semibold().child(pq.header && pq.header !== pq.question ? `${pq.header}: ${pq.question}` : pq.question))
      .when(n > 0, (el) => el.child(v_flex().mt(2).gap(6).children(opts.map(opt))))
      .when(shown.length > 0, (el) => el.child(v_flex().mt(2).gap(6).children(shown.map(readOnly))))
      .child(h_flex().min_w(0).items_center().justify_between().gap(8)
        .child(div().flex_1().min_w(0).text_size(12).text_color(p.muted).child(foot))
        // A prompt or consent has no options here: it is answered in the real terminal, by you.
        .when(n === 0, (el) => el.child(btn(p, "ask-terminal", "Answer in Terminal", { iconName: "term", tip: "Answer it in the Terminal", onClick: () => v.toTerminal() })))));
}

// ---------------------------------------------------------------- 4c composer (l.175-184)

// The "/" menu (T10): the session's commands above the field, in the .perm-menu look (l.107-111:
// raised, 1px line-strong, radius 12, 6px padding, shadow; rows 7px 8px radius 6, hover fill).
// The artboard has no open state of it; rows show "/name", the argument it takes, the
// description, and the terminal mark when the command answers in the TUI. At most 8 rows show,
// around the selected one.
const SLASH_ROWS = 8;
// Where the Textarea starts its text inside its box (its own left padding), for the placeholder.
const PLACEHOLDER_INSET = 0;
function slashMenu(v, p) {
  const m = v.slashMenu();
  if (!m) return null;
  const from = Math.max(0, Math.min(m.at - Math.floor(SLASH_ROWS / 2), m.items.length - SLASH_ROWS));
  const rows = m.items.slice(from, from + SLASH_ROWS).map((c, k) => {
    const i = from + k;
    const on = i === m.at;
    return h_flex().id(`slash-${i}`).w_full().items_center().gap(10).px(8).py(7).rounded(R.inner).cursor_pointer()
      .when(on, (el) => el.bg(p.selected)).hover((st) => st.bg(p.selected))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => v.slashPick(i, false, cx))
      .child(div().flex_none().font_family(mono()).text_size(12.5).font_semibold().text_color(on ? p.accentSoft : p.text).child(`/${c.name}`))
      .when(Boolean(c.args), (el) => el.child(div().flex_none().font_family(mono()).text_size(12).text_color(p.faint).child(c.args)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(p.muted).child(c.description ?? ""))
      .when(c.terminal !== false, (el) => el.child(icon("term", 13).text_color(p.faint)));
  });
  const more = m.items.length > SLASH_ROWS ? `${m.at + 1} of ${m.items.length}` : null;
  return v_flex().id("slash-menu").absolute().left(0).right(0).bottom(66).p(6).bg(p.raised).border(1).border_color(p.lineStrong)
    .rounded(R.md).shadow_lg().text_color(p.text)
    .children(rows)
    .child(h_flex().px(8).pt(4).gap(14).items_center().text_size(11.5).text_color(p.muted)
      .child(h_flex().gap(3).items_center().child(kbd(p, "↑↓")).child("move"))
      .child(h_flex().gap(3).items_center().child(kbd(p, "Enter")).child("run"))
      .child(h_flex().gap(3).items_center().child(kbd(p, "Tab")).child("complete"))
      .child(div().flex_1())
      .when(Boolean(more), (el) => el.child(div().font_family(mono()).child(more))));
}

// The Send button, or Stop while the agent works and the draft is empty (the artboard draws
// only Send; Stop keeps its 32px size and radius in the .btn.danger look, l.92-95, with the
// i-stop symbol, l.308). Typing while it works brings Send back: the message is queued, as in
// the terminal.
function sendOrStop(v, p) {
  if (v.working() && !v.draft.trim() && v.key) {
    const stopping = v.busy === "stop";
    return h_flex().id("stop").h(32).flex_none().items_center().gap(6).px(12).rounded(R.sm).border(1).border_color(p.lineStrong)
      .text_color(p.text).font_semibold().text_size(13).cursor_pointer()
      .when(stopping, (el) => el.opacity(0.6))
      .hover((st) => st.border_color(p.err).text_color(p.err))
      .tooltip("Stop the agent's turn (Esc Esc)")
      .on_click((_e, cx) => v.stop(cx))
      .child(icon("stop", 13).text_color(p.err)).child(stopping ? "Stopping…" : "Stop");
  }
  return h_flex().id("send").h(32).flex_none().items_center().gap(6).px(12).rounded(R.sm)
    .bg(v.key ? p.accent : p.raised).text_color(v.key ? p.onAccent : p.faint).font_semibold().text_size(13)
    .cursor_pointer().on_click((_e, cx) => v.send(cx))
    .child(v.sending ? div().frames(SPINNER, 90) : icon("send", 13)).child("Send");
}

export function composer(v, p, pq) {
  const menu = slashMenu(v, p);
  // Clip, text and Send share one centre line (S8 report "no esta centrado"): the row centres
  // its three, and the text sits in a 42px box (the artboard's textarea height, l.179) whose one
  // line is centred; a longer draft grows the box, the clip and Send stay on its centre.
  const field = h_flex().w_full().items_center().gap(8).pl(12).pr(8).py(8).border(1)
    .border_color(v.typing ? p.accent : p.lineStrong).rounded(R.md).bg(p.background)
    // Attach: the clipboard's image (or files) into the session's draft, as Ctrl+V in the terminal.
    .child(h_flex().id("attach").w(32).h(32).flex_none().items_center().justify_center().rounded(R.sm).text_color(p.muted)
      .cursor_pointer().when(v.busy === "attach", (el) => el.opacity(0.6))
      .hover((st) => st.bg(p.selected).text_color(p.text)).tooltip("Attach: paste the clipboard image into the draft (Ctrl+V)")
      .on_click((_e, cx) => v.attach(cx)).child(icon("clip", 15)))
    .child(div().flex_1().min_w(0).key_context("GentleChatComposer").on_action("gentle_chat_send", (_e, cx) => v.send(cx))
      // While the "/" menu is open, ↑/↓/Tab are its keys (main.js binds them in GentleSlashMenu).
      .child(div().w_full().key_context(menu ? "GentleSlashMenu" : "GentleSlashIdle")
        .on_action("gentle_chat_slash_up", (_e, cx) => v.slashMove(-1, cx))
        .on_action("gentle_chat_slash_down", (_e, cx) => v.slashMove(1, cx))
        .on_action("gentle_chat_slash_complete", (_e, cx) => v.slashPick(v.slashAt, true, cx))
        .child(div().relative().w_full().min_h(42).flex().items_center()
          .child(Textarea.new(v.input).w_full().text_size(14).line_height(1.5).text_color(p.text).bg(CLEAR))
          // The placeholder: one line, muted, an ellipsis when the card is narrow. It paints
          // under nothing that listens, so a click still reaches the field.
          .when(!v.draft, (el) => el.child(div().absolute().top(0).bottom(0).left(PLACEHOLDER_INSET).right(0).flex().items_center()
            .child(div().w_full().min_w(0).truncate().text_size(14).line_height(1.5).text_color(p.muted).child(v.placeholder ?? "")))))))
    .child(sendOrStop(v, p));
  const hint = (key, text) => h_flex().flex_none().items_center().gap(3).child(kbd(p, key)).child(text);
  // The hints row is one line: a narrow card drops hints from the right (Esc Esc, then ⌘J,
  // then /, then ⇧ Enter) instead of wrapping or clipping; Enter send and the minimal view's
  // toggle stay.
  const w = Number.isFinite(v.composerW) ? Math.min(780, v.composerW - 32) : 780;
  const show = { esc: w >= 700, term: w >= 540 && !v.elsewhere(), cmd: w >= 450, nl: w >= 360 };
  // S11: "⌘O Expand all" / "⌘O Collapse all", the TUI's ctrl+o for every row of the log.
  const expand = h_flex().id("expand-all").flex_none().items_center().gap(3).rounded(R.kbd).cursor_pointer()
    .hover((st) => st.text_color(p.text))
    .tooltip(v.expandAll ? "Back to the minimal view: every tool call, thought, diff and subagent as one line" : "Open every tool call, thought, diff and subagent in the chat")
    .on_click((_e, cx) => v.expandToggle(cx))
    .child(kbd(p, "⌘O")).child(v.expandAll ? "collapse all" : "expand all");
  return v_flex().id("composer").flex_none().px(16).pt(10).pb(12).border_t(1).border_color(p.line).bg(p.chrome)
    .rounded_b(R.window - 1)
    .on_size_change((size, cx) => { if (Math.abs((v.composerW ?? 0) - size.width) >= 1) { v.composerW = size.width; cx.notify(); } })
    .child(v_flex().w_full().max_w(780).self_center()
      .child(div().w_full().relative().child(field).when(Boolean(menu), (el) => el.child(menu)))
      .when(Boolean(v.error), (el) => el.child(div().mt(6).text_size(12).text_color(p.err).child(v.error)))
      .when(!v.error && Boolean(v.notice), (el) => el.child(div().mt(6).text_size(12).text_color(p.muted).child(v.notice)))
      .child(h_flex().mt(6).gap(14).items_center().overflow_hidden().whitespace_nowrap().text_size(11.5).text_color(p.muted)
        .child(hint("Enter", "send"))
        .when(show.nl, (el) => el.child(hint("⇧ Enter", "new line")))
        .when(show.cmd, (el) => el.child(hint("/", "commands")))
        .when(show.term, (el) => el.child(hint("⌘J", "Terminal")))
        .child(div().flex_1())
        .child(expand)
        .when(show.esc, (el) => el.child(div().flex_none().child("Esc Esc stops the agent")))));
}
