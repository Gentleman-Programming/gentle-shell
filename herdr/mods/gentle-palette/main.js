// gentle-palette: the Gentle commands palette (⌘K), T10 / S9. The artboard promises it twice
// ("⌘K Commands" in the status bar, l.618, and "⌘K sends the slash command", l.669-670) without
// drawing it, so it is built from the artboard's own pieces: the .perm-menu surface (raised,
// 1px line-strong, radius 12, 6px padding, rows 7px 8px radius 6 with a hover fill), .eyebrow
// group titles, kbd hints and the i-search / i-cmd symbols (l.305, l.314).
//
// What it lists, for the Gentle Shell session the window is about (snapshot.js targetTerminal):
//   Needs you      every session (any agent) waiting for the person → focuses it
//   Session        Stop the agent (while it works), then pi's session commands (new, resume,
//                  fork, compact, name, export, …) from the session's snapshot `commands`
//   View           Chat, Terminal, Expand all / Collapse all, the inspector tabs, with their keys
//   Permission     the four live modes (the chat's menu path: Super-YOLO asks first)
//   Profiles       the saved model profiles (S12), the session's one checked: the chat applies the
//                  chosen one in this session (apply_profile, its confirmation dialog included);
//                  and "Refresh plan usage" (the usage panel's r, refresh_usage)
//   Commands       the session's own commands (extension commands, prompt templates, skills)
// Choosing a row runs it on the path the rest of the desktop uses (actions.js, a byte-identical
// copy): a slash command is typed into the TUI with `hc send` (refused while a question is open),
// then the Terminal shows when its result is a TUI screen, else the Chat; Stop goes to the
// session's inbox (abort_turn). The palette stays open until that answered, so a refusal shows
// in it. The chat is unloaded while the Terminal shows (a hidden stack child), so what only the
// chat does — a permission mode (Super-YOLO's dialog) and a command that needs an argument (it
// goes into the composer) — is a consume-once `gentle-chat.request` the chat takes on its
// command or when it mounts. Opened with `mod.open:gentle-palette` (herdr/keys.json ⌘K, the
// chat's ⌘K, the status bar's "Commands").
// T11 (S10): every live session counts, wherever it runs (snapshot.js allSessions). For a session
// outside Herdr app there is no Terminal row, and only its prompt templates and skills are listed:
// the chat sends them through its inbox; every other command is TUI code that stays in its terminal.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { agents, closeOverlay, layout, props, run, setShared, shared } from "herdr";
import { sendAction, errorText, tuiCommand, showTerminal } from "./actions.js";
import { tokens, eyebrow, kbd, sessionTitle } from "./tokens.js";
import { FeedSource, selectSession, followHerdr } from "./snapshot.js";

const MOD = "gentle-palette";
const icon = (name, size = 15) => svg(`mods/${MOD}/icons/${name}.svg`).size(size).flex_none();

// The bindings herdr/keys.json ships for the Gentle layout (shown beside their rows).
export const KEYS = {
  palette: "⌘K", chat: "⌘J", stop: "⌘.", expand: "⌘O",
  changes: "⌥⌘1", todo: "⌥⌘2", agents: "⌥⌘3", jobs: "⌥⌘4", review: "⌥⌘5", session: "⌥⌘6",
};

const TABS = [
  { id: "changes", label: "Changes", icon: "diff" },
  { id: "todo", label: "Todo", icon: "todo" },
  { id: "agents", label: "Agents", icon: "bot" },
  { id: "jobs", label: "Jobs", icon: "jobs" },
  { id: "review", label: "Review", icon: "review" },
  { id: "session", label: "Session", icon: "stats" },
];

// gentle-chat's PERM (ui.js), the same four modes and words.
const PERM = [
  { mode: "normal", label: "Normal", about: "Standard permission prompts", tone: null },
  { mode: "auto", label: "Auto", about: "Independent checks; extra model calls", tone: null },
  { mode: "yolo", label: "YOLO", about: "Scoped work; destructive actions ask", tone: "warn" },
  { mode: "super-yolo", label: "Super-YOLO", about: "No permission prompts; private paths blocked; consent remains", tone: "err" },
];

const LIST_H = 440;
const TAG = { builtin: "pi", extension: "ext", prompt: "prompt", skill: "skill" };

// Every row the palette offers for `feed` (the session's snapshot) and the window's sessions.
// Pure but for `agents()`: rows carry what to run, never run it.
export function paletteRows(feed, sessions, blockedAgents, elsewhere = false) {
  const rows = [];
  const add = (section, row) => rows.push({ section, ...row });
  const seen = new Set();
  for (const { key, terminal, feed: f } of sessions) {
    const q = f?.pendingQuestion;
    if (!q && f?.activity?.state !== "blocked") continue;
    if (terminal) seen.add(terminal.address);
    const name = f?.identity?.sessionName || sessionTitle(terminal?.title) || "Gentle Shell";
    const id = terminal ? terminal.address : key;
    add("Needs you", { id: `need-${id}`, label: name, detail: q?.question || f?.activity?.blockedLabel || "Waiting for you", icon: "bolt", tone: "warn", act: terminal ? { kind: "focus", terminal: terminal.address } : { kind: "select", key } });
  }
  for (const a of blockedAgents) {
    if (seen.has(a.address)) continue;
    add("Needs you", { id: `need-${a.address}`, label: a.tab_name || a.space_name || a.program?.name || "Agent", detail: `${a.program?.name ?? "Agent"} waits for you`, icon: "bolt", tone: "warn", act: { kind: "focus", terminal: a.address } });
  }
  // Outside Herdr app only prompt templates and skills run from here (they become a prompt).
  const commands = (feed?.commands?.items ?? []).filter((c) => !elsewhere || c.source === "prompt" || c.source === "skill");
  if (feed?.activity?.state === "working") add("Session", { id: "stop", label: "Stop the agent", detail: "Stops this turn, as Esc Esc in the terminal", icon: "stop", tone: "err", key: KEYS.stop, act: { kind: "stop" } });
  for (const c of commands.filter((c) => c.source === "builtin")) {
    add("Session", { id: `cmd-${c.name}`, label: `/${c.name}`, mono: true, detail: c.description, tag: c.args ? c.args : null, icon: c.terminal ? "term" : "cmd", act: { kind: "command", command: c } });
  }
  add("View", { id: "view-chat", label: "Chat", detail: "The conversation", icon: "chat", key: KEYS.chat, act: { kind: "view", which: "chat" } });
  if (!elsewhere) add("View", { id: "view-terminal", label: "Terminal", detail: "The real Gentle Shell TUI", icon: "term", key: KEYS.chat, act: { kind: "view", which: "terminal" } });
  // The chat's minimal view (S11): every row open, or back to one line per item.
  add("View", { id: "view-expand", label: "Expand all", detail: "Open every tool call, thought, diff and subagent in the chat", icon: "chat", key: KEYS.expand, act: { kind: "expand", expanded: true } });
  add("View", { id: "view-collapse", label: "Collapse all", detail: "The minimal chat: one line per tool call, thought, diff and subagent", icon: "chat", key: KEYS.expand, act: { kind: "expand", expanded: false } });
  for (const t of TABS) add("View", { id: `tab-${t.id}`, label: t.label, detail: "Inspector tab", icon: t.icon, key: KEYS[t.id], act: { kind: "tab", tab: t.id } });
  const mode = feed?.permission?.mode;
  if (feed) {
    for (const m of PERM) add("Permission", { id: `mode-${m.mode}`, label: m.label, detail: m.about, icon: "shield", tone: m.tone, checked: m.mode === mode, act: { kind: "mode", mode: m.mode } });
  }
  if (feed) {
    const list = feed.profiles;
    for (const pr of Array.isArray(list?.items) ? list.items : []) {
      const on = pr.name === list.active;
      const roles = Array.isArray(pr.roles) ? pr.roles.length : 0;
      const detail = [on ? "This session's profile" : "Use in this session", `${roles} ${roles === 1 ? "role" : "roles"}`, pr.tier].filter(Boolean).join(" · ");
      add("Profiles", { id: `profile-${pr.name}`, label: pr.name, detail, icon: "bot", checked: on, tag: list.default === pr.name ? "default" : null, act: { kind: "profile", name: pr.name } });
    }
    add("Profiles", { id: "usage-refresh", label: "Refresh plan usage", detail: "Fetch the subscription windows again, as the usage panel's r", icon: "stats", act: { kind: "usage" } });
  }
  for (const c of commands.filter((c) => c.source !== "builtin")) {
    add("Commands", { id: `cmd-${c.name}`, label: `/${c.name}`, mono: true, detail: c.description, tag: TAG[c.source] ?? c.source, icon: c.terminal ? "term" : "cmd", act: { kind: "command", command: c } });
  }
  return rows;
}

// Case-insensitive: every word of the query in the label or the detail ("/" is optional).
// Inside each section, an exact name comes first, then names that start with the query.
export function filterRows(rows, query) {
  const q = String(query ?? "").toLowerCase().trim().replace(/^\//, "");
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  const sections = [...new Set(rows.map((r) => r.section))];
  const name = (r) => r.label.toLowerCase().replace(/^\//, "");
  const score = (r) => (name(r) === q ? 0 : name(r).startsWith(q) ? 1 : 2);
  return rows
    .filter((r) => {
      const hay = `${r.label} ${r.detail ?? ""} ${r.section}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .map((r, i) => ({ r, i, k: sections.indexOf(r.section) * 4 + score(r) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);
}

// The views stack (herdr/layouts/gentle-shell.json): which child shows.
function chatShowing() {
  const find = (node) => (node?.id === "views" ? node : (node?.children ?? []).map(find).find(Boolean));
  const node = find(layout());
  return (node?.active ?? node?.children?.[0]?.id) === "chat";
}

function showChat() {
  try { run("layout.select", { stack: "views", child: "chat" }); } catch { /* not in the Gentle layout */ }
}

// Hands work only the chat does to it: consume-once in shared; the chat takes it now (its
// command) or, while the Terminal shows (a hidden stack child gets no commands), as soon as it
// shows again (setting shared state re-renders it, and its render takes the request, S13).
function chatRequest(req) {
  setShared("gentle-chat.request", { ...req, at: Date.now() });
  if (chatShowing()) run("gentle-chat.request");
  else showChat();
}

export default class GentlePalette extends View {
  init(_props, cx) {
    this.query = "";
    this.at = 0;
    this.busy = null; // the row running now (its hc send or action)
    this.error = null;
    // The chat names its session when it opens the palette (⌘K in the chat); otherwise the
    // session the window is about.
    const named = shared("gentle-palette.terminal");
    const fresh = named && Number.isFinite(named.at) && Math.abs(Date.now() - named.at) < 3000;
    this.named = fresh ? { session: typeof named.key === "string" ? named.key : null, address: typeof named.address === "string" ? named.address : null } : null;
    this.last = null;
    this.terminal = null;
    this.source = new FeedSource();
    this.source.start(cx, null, 5000);
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Run a command, switch a view or a mode…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.choose(this.shown()[this.at], cx));
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
  }

  close() {
    try { closeOverlay(props().overlay); } catch { /* already closed */ }
  }

  // The palette's session: the one the chat named when it opened it, else the shown one.
  feed() {
    const sessions = this.source.sessions();
    const n = this.named;
    const hinted = n ? sessions.find((s) => (n.session && s.key === n.session) || (n.address && s.terminal?.address === n.address)) : null;
    const session = hinted ?? this.source.target(this.last);
    if (session) this.last = session.key;
    this.terminal = session?.terminal?.address ?? null;
    return { session, term: session?.terminal ?? null, feed: session?.feed ?? null, sessions };
  }

  shown() {
    const { session, feed, sessions } = this.feed();
    let blocked = [];
    try { blocked = agents().filter((a) => a.status === "blocked"); } catch { blocked = []; }
    return filterRows(paletteRows(feed, sessions, blocked, Boolean(session && !session.terminal)), this.query);
  }

  // Runs a row (see the header): instant rows close first; a send or an action keeps the
  // palette open until it answered, then closes from a host call (the timer).
  choose(row, cx) {
    if (!row || this.busy) return;
    const act = row.act;
    const { feed, session, sessions } = this.feed();
    this.error = null;
    if (act.kind === "focus") {
      this.close();
      followHerdr();
      run("agent.focus", { terminal: act.terminal });
      showChat();
    } else if (act.kind === "select") {
      // A session outside Herdr app (T11): every region shows it.
      this.close();
      selectSession(sessions.find((s) => s.key === act.key));
      showChat();
    } else if (act.kind === "view") {
      this.close();
      if (act.which === "chat") showChat();
      else showTerminal(this.terminal);
    } else if (act.kind === "tab") {
      this.close();
      run(`gentle-inspector.tab-${act.tab}`);
    } else if (act.kind === "expand") {
      this.close();
      chatRequest({ kind: "expand", expanded: act.expanded });
    } else if (act.kind === "mode") {
      this.close();
      chatRequest({ kind: "mode", mode: act.mode });
    } else if (act.kind === "profile") {
      // The chat runs it: the owner may ask for a confirmation dialog first.
      this.close();
      chatRequest({ kind: "profile", name: act.name });
    } else if (act.kind === "usage") {
      this.work(row.id, cx, async (cx) => {
        const r = await sendAction(cx, feed, "refresh_usage", {});
        return r.ok ? null : errorText(r);
      }, () => {});
    } else if (act.kind === "stop") {
      this.work(row.id, cx, async (cx) => {
        const r = await sendAction(cx, feed, "abort_turn", {});
        return r.ok ? null : errorText(r);
      }, () => {});
    } else if (act.kind === "command") {
      const c = act.command;
      const text = `/${c.name}`;
      if (c.args) { this.close(); chatRequest({ kind: "command", text, args: c.args }); return; }
      // Outside Herdr app the chat sends it through the session's inbox (send_prompt).
      if (session && !session.terminal) { this.close(); chatRequest({ kind: "command", text, terminal: false }); return; }
      const terminal = c.terminal !== false;
      this.work(row.id, cx, () => tuiCommand(this.terminal, feed, text, null), () => (terminal ? showTerminal(this.terminal) : showChat()));
    }
    cx.notify();
  }

  work(id, cx, fn, after) {
    this.busy = id;
    cx.notify();
    cx.spawn(async (cx) => {
      let line = null;
      try { line = await fn(cx); } catch (e) { line = String(e?.message ?? e); }
      this.busy = null;
      if (line) { this.error = line; cx.notify(); return; }
      cx.timer.after(1, () => { try { after(); } finally { this.close(); } });
    });
  }

  render() {
    const c = tokens();
    const rows = this.shown();
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    const kids = [];
    let section = null;
    let selectedChild = 0;
    rows.forEach((r, i) => {
      if (r.section !== section) {
        section = r.section;
        kids.push(div().px(8).pt(kids.length ? 10 : 4).pb(4).child(eyebrow(c, section, section === "Needs you" ? c.warn : c.muted)));
      }
      if (i === this.at) selectedChild = kids.length;
      kids.push(this.row(c, r, i === this.at, i));
    });
    if (!rows.length) kids.push(div().px(8).py(10).text_size(12.5).text_color(c.muted).child(this.feed().feed ? "No command matches." : "No Gentle Shell session here. Start one with + in the tab bar."));
    this.scroll.scroll_to_item(selectedChild);
    const { feed } = this.feed();
    const name = feed?.identity?.sessionName || null;
    return v_flex().id("palette").track_focus(this.handle).w_full().p(6).gap(6)
      .bg(c.raised).text_color(c.text).font_family(c.sans).text_size(13).line_height(1.5)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { this.close(); cx.stop_propagation(); return; }
        if (e.key === "down") this.at = (this.at + 1) % Math.max(1, rows.length);
        else if (e.key === "up") this.at = (this.at + Math.max(1, rows.length) - 1) % Math.max(1, rows.length);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      // The search field: .field's look (1px accent when focused, radius 12, background fill).
      .child(h_flex().flex_none().h(38).px(10).gap(8).items_center().rounded(12).border(1).border_color(c.accent).bg(c.card)
        .child(icon("search", 15).text_color(c.muted))
        .child(Input.new(this.input).flex_1().h_full().text_size(13.5).text_color(c.text))
        .when(Boolean(name), (el) => el.child(div().flex_none().max_w(180).truncate().text_size(12).text_color(c.muted).child(name)))
        .child(kbd(c, "Esc")))
      // A popup is as tall as its content: the list has a fixed height (about 12 rows).
      .child(v_flex().id("palette-list").flex_none().h(LIST_H).overflow_y_scrollbar().track_scroll(this.scroll).children(kids))
      .when(Boolean(this.error), (el) => el.child(div().px(8).text_size(12).text_color(c.err).child(this.error)))
      .child(h_flex().flex_none().px(8).pt(2).gap(14).items_center().text_size(11.5).text_color(c.muted)
        .child(h_flex().gap(3).items_center().child(kbd(c, "↑↓")).child("move"))
        .child(h_flex().gap(3).items_center().child(kbd(c, "Enter")).child("run"))
        .child(div().flex_1())
        .child(h_flex().gap(4).items_center().child(icon("term", 13)).child("opens in the Terminal")));
  }

  // A .perm-menu row: 18px icon column, 13px semibold label (mono for a command), 12px muted
  // detail; the right edge carries its key, its argument or its source.
  row(c, r, on, i) {
    const color = r.tone === "warn" ? c.warn : r.tone === "err" ? c.err : c.text;
    return h_flex().id(`row-${i}`).w_full().items_center().gap(8).px(8).py(7).rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(c.selected))
      .when(this.busy === r.id, (el) => el.opacity(0.6))
      .hover((s) => s.bg(c.selected))
      .on_mouse_move((_e, cx) => { if (this.at !== i) { this.at = i; cx.notify(); } })
      .on_click((_e, cx) => this.choose(r, cx))
      .child(div().w(18).h(18).flex_none().flex().items_center().justify_center()
        .child(r.checked ? icon("check", 13).text_color(c.accent) : icon(r.icon, 13).text_color(r.tone ? color : c.muted)))
      .child(h_flex().flex_1().min_w(0).items_baseline().gap(10)
        .child(div().flex_none().font_weight(600).text_size(13).text_color(color)
          .when(Boolean(r.mono), (el) => el.font_family(c.mono).text_size(12.5)).child(r.label))
        .when(Boolean(r.detail), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(12).text_color(c.muted).child(r.detail))))
      .when(Boolean(r.key), (el) => el.child(kbd(c, r.key)))
      .when(!r.key && Boolean(r.tag), (el) => el.child(div().flex_none().font_family(c.mono).text_size(10.5).text_color(c.faint).child(r.tag)));
  }
}
