// gentle-spaces: Herdr spaces as the artboard's "Projects" (region 1b,
// design/herdr-desktop/01-inspector.html `.sb-sec` / `.space`, l.231-240). Cloned from Herdr
// 0.1.15's `spaces` (mod.clone semantics) and restyled: click selects, drag reorders, right-click
// opens the space menu, + opens a new space; each row tells its Gentle Shell sessions instead of
// git (worktree nesting is not in the artboard and was left out; machine groups came back in S14).
//
// Row: 22px two-letter avatar, the space name and "<n> sessions · $<live spend>" (or the status),
// the count of sessions that need you on the right. The block is sized to its rows (see fit()).
// T11 (S10): every live Gentle Shell session counts, wherever it runs: one outside Herdr app
// belongs to the space whose folder holds its project (its Git root), and a project no space
// holds is a row of its own after the spaces (a click shows its newest session everywhere). The
// count says each kind (snapshot.js SESSION_KINDS): "1 Herdr · 2 TUI · $4.74".
// S14 (remote machines): once a space or a machine is not this computer (`hc machine ls`, Herdr's
// `machines()`), the list groups by machine as Herdr's `spaces` does (machines.js): a header per
// machine with its icon, name and state (ready / loading… / unavailable), + for a new space there
// (`space.new {machine}`: its tabs and Gentle Shell sessions start on that machine), and a click
// on an unavailable one opens Settings › Machines (its login guidance). A remote space counts its
// Gentle Shell sessions from herdr-core ("1 Remote"): their snapshots and spend stay on that
// machine, so no spend is shown for them. With only this computer, nothing changes.
// S15 (Needs you): pinned above Projects, only while at least one Gentle Shell session waits for the
// person (a question, a permission prompt, a consent, a blocker), wherever it runs: one row per
// session (snapshot.js needsYouList, the one that waited longest first) with its name, what it
// waits for (Question, Permission, Consent, Blocked), its kind badge (Herdr / TUI / Remote) and the
// waiting reason; a click shows that session (selectSession). Read from the shared feeds, like the
// rest of this mod: no timer, watch or read of its own. The notification is the status bar's
// (gentle-status, the feed leader).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, terminals, machines, run, openOverlay, layout } from "herdr";
import { tokens, eyebrow, money, kindBadge } from "./tokens.js";
import { FeedSource, isGentle, followHerdr, selectSession, projectOf, projectName, spaceFor, machineOf, needsYouList, sessionKind, SESSION_KINDS } from "./snapshot.js";
import { machineGroups, STATE_WORD } from "./machines.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Artboard metrics: .sb-sec padding 10 10 6, header 32px button + 6px, .space 6px padding around
// 19.5px + 17.25px lines (48.75px).
const PAD_TOP = 10, PAD_BOTTOM = 6, HEADER = 38, ROW = 48.75, MAX_ROWS = 6;
// A machine header and a machine's "New space there" row (S14).
const MACHINE = 26, EMPTY = 28;
// The pinned Needs you section (S15): its eyebrow row, its rows (the space row's height), at most
// NEED_ROWS of them (then one "+N more" line), and the gap before Projects.
const NEED_HEAD = 26, NEED_ROWS = 4, NEED_MORE = 22, NEED_GAP = 8;
const MOD = "gentle-spaces";

// "gentle-pi" → "gp", "herdr-zoo" → "hz", "web" → "we".
export function initials(name) {
  const parts = String(name ?? "?").toLowerCase().split(/[-_.\s/]+/).filter(Boolean);
  if (parts.length >= 2) return parts[0][0] + parts[1][0];
  return (parts[0] ?? "?").slice(0, 2);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// "1 Herdr · 2 TUI": the sessions of each kind, the kind's own word (snapshot.js SESSION_KINDS).
const kinds = (info) => [[info.herdr, SESSION_KINDS.herdr.label], [info.tui, SESSION_KINDS.tui.label], [info.remote ?? 0, SESSION_KINDS.remote.label]]
  .filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`).join(" · ");

export default class GentleSpaces extends View {
  init(_props, cx) {
    this.pressed = null;
    this.over = null;
    this.source = new FeedSource();
    this.source.start(cx);
  }

  // Sizes the `spaces` block to the section's natural height (the artboard's sections are not
  // split by weight: Projects takes its rows, Agents the rest), up to MAX_ROWS rows.
  // `extra`: the machine headers and empty-machine rows (S14), in px, on top of the rows.
  fit(rows, extra = 0) {
    // (extra also carries the Needs you section's height, S15)
    const want = PAD_TOP + HEADER + Math.min(Math.max(rows, 1), MAX_ROWS) * ROW + extra + PAD_BOTTOM;
    const node = find(layout(), "spaces");
    if (node && Math.abs((node.size?.px ?? 0) - want) > 0.5) run("layout.resize", { id: "spaces", px: want });
  }

  // Gentle Shell sessions per space: their count, live spend and how many need you. Sessions
  // outside Herdr app join the space that holds their project, or a project row of their own
  // (`extra`, keyed by the project's path, newest session first).
  sessions(sp) {
    const terms = new Map(terminals().map((t) => [t.address, t]));
    const by = {};
    const extra = new Map();
    for (const a of agents()) {
      if (!isGentle(a.app)) continue;
      const s = (by[a.space] ??= { n: 0, herdr: 0, tui: 0, remote: 0, cost: 0, need: 0 });
      s.n++;
      // A terminal on another machine: herdr-core's state only, its snapshot stays there.
      if (machineOf(a.address)) s.remote++;
      else s.herdr++;
      if (a.status === "blocked") s.need++;
      const feed = this.source.of(terms.get(a.address));
      s.cost += Number(feed?.cost?.total) || 0;
    }
    for (const s of this.source.sessions()) {
      if (!s.feed || s.terminal) continue;
      const project = projectOf(s.feed);
      const space = spaceFor(project, sp);
      const need = s.feed.pendingQuestion || s.feed.activity?.state === "blocked" ? 1 : 0;
      const cost = Number(s.feed.cost?.total) || 0;
      const row = space ? (by[space.id] ??= { n: 0, herdr: 0, tui: 0, remote: 0, cost: 0, need: 0 }) : extra.get(project) ?? { id: `project-${project}`, name: projectName(project), path: project, n: 0, herdr: 0, tui: 0, cost: 0, need: 0, sessions: [] };
      row.n++; row.tui++; row.need += need; row.cost += cost;
      if (!space) { row.sessions.push(s); extra.set(project, row); }
    }
    return { by, extra: [...extra.values()] };
  }

  row(c, w, info, on = w.active) {
    const n = info?.n ?? 0;
    // A space on another machine: its sessions' spend is in their snapshots there, so none is shown.
    const small = n === 0
      ? "No Gentle Shell session"
      : w.machine ? kinds(info) : `${kinds(info)} · ${money(info.cost)}`; // the artboard's "3 sessions · $4.74 today", per kind (S10): live spend, not a daily total
    return h_flex().id(`space-${w.id}`).relative().w_full().min_w(0).overflow_hidden().h(ROW).flex_none().p(6).gap(10).items_center().rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(c.selected))
      .hover((s) => s.bg(c.selected))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .on_mouse_down("left", () => { this.pressed = w.id; this.over = w.id; })
      .on_mouse_move((_e, cx) => {
        if (this.pressed !== null && this.over !== w.id) { this.over = w.id; cx.notify(); }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        this.pressed = null;
        this.over = null;
        if (from !== null && from !== w.id) {
          const index = spaces().findIndex((s) => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) { followHerdr(); run("space.select", { id: w.id }); }
        cx.notify();
      })
      .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } }))
      // [aria-current] box-shadow: inset 2px 0 0 accent.
      .when(on, (el) => el.child(div().absolute().left(0).top(0).bottom(0).w(2).bg(c.accent)))
      .child(div().size(22).flex_none().rounded(6).bg(c.raised).flex().items_center().justify_center()
        .font_family(c.mono).font_weight(700).text_size(10.5).line_height("10.5px").text_color(on ? c.accentSoft : c.muted)
        .child(initials(w.name)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(13).line_height("19.5px").text_color(c.text).child(w.name))
        .child(div().truncate().text_size(11.5).line_height("17.25px").text_color(c.muted).child(small)))
      .when((info?.need ?? 0) > 0, (el) => el.child(div().flex_none().font_family(c.mono).font_weight(600).text_size(11).line_height("11px").text_color(c.warn)
        .tooltip(`${plural(info.need, "session")} need${info.need === 1 ? "s" : ""} you`).child(String(info.need))));
  }

  // A project no Herdr space holds (T11): the space row's look; a click shows its session that
  // needs you, else its newest one. It has no space menu and does not reorder.
  projectRow(c, info, on) {
    const pick = info.sessions.find((s) => s.feed.pendingQuestion || s.feed.activity?.state === "blocked") ?? info.sessions[0];
    return h_flex().id(info.id).relative().w_full().min_w(0).overflow_hidden().h(ROW).flex_none().p(6).gap(10).items_center().rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(c.selected))
      .hover((s) => s.bg(c.selected))
      .tooltip(`${info.path} · runs outside Herdr app`)
      .on_click(() => selectSession(pick))
      .when(on, (el) => el.child(div().absolute().left(0).top(0).bottom(0).w(2).bg(c.accent)))
      .child(div().size(22).flex_none().rounded(6).bg(c.raised).flex().items_center().justify_center()
        .font_family(c.mono).font_weight(700).text_size(10.5).line_height("10.5px").text_color(on ? c.accentSoft : c.muted)
        .child(initials(info.name)))
      .child(v_flex().flex_1().min_w(0)
        .child(div().truncate().text_size(13).line_height("19.5px").text_color(c.text).child(info.name))
        .child(div().truncate().text_size(11.5).line_height("17.25px").text_color(c.muted).child(`${kinds(info)} · ${money(info.cost)}`)))
      .when(info.need > 0, (el) => el.child(div().flex_none().font_family(c.mono).font_weight(600).text_size(11).line_height("11px").text_color(c.warn)
        .tooltip(`${plural(info.need, "session")} need${info.need === 1 ? "s" : ""} you`).child(String(info.need))));
  }

  // A machine's header (S14), Herdr's `spaces` machine header in the section's look: its icon,
  // name and state; + opens a new space there while it is reachable; an unavailable machine opens
  // Settings › Machines, where Herdr shows what it needs (a login, a new host key, herdr-core).
  machineHead(c, g) {
    const id = g.name ?? "local";
    const off = g.state === "unavailable";
    const word = g.name ? STATE_WORD[g.state] : "";
    const tone = g.state === "ready" ? c.ok : g.state === "loading" ? c.muted : c.warn;
    return h_flex().id(`machine-${id}`).h(MACHINE).flex_none().px(6).gap(7).items_center().rounded(6)
      .font_family(c.mono).text_size(11).line_height("15.4px").text_color(c.muted)
      .tooltip(g.name ? `${g.name} · ${word}${off ? " · click for Settings › Machines" : ""}` : "This computer")
      .when(off, (el) => el.cursor_pointer().hover((s) => s.bg(c.selected)).on_click(() => run("app.settings", { section: "machines" })))
      .child(svg(`mods/gentle-spaces/icons/${g.name ? "server" : "monitor"}.svg`).size(13).flex_none())
      .child(div().flex_1().min_w(0).truncate().font_weight(600).child(String(g.name ?? "This computer").toUpperCase()))
      .when(Boolean(word), (el) => el.child(div().flex_none().text_color(tone).child(word)))
      .when(!off, (el) => el.child(div().id(`machine-new-${id}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
        .cursor_pointer().hover((s) => s.bg(c.selected).text_color(c.text))
        .tooltip(`New space on ${g.name ?? "this computer"}`)
        .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: g.name ?? "" }); })
        .child(svg("mods/gentle-spaces/icons/plus.svg").size(11))));
  }

  // A machine with no space yet: one calm row that opens a new space there.
  machineEmpty(c, g) {
    const id = g.name ?? "local";
    const off = g.state !== "ready";
    return h_flex().id(`machine-empty-${id}`).h(EMPTY).flex_none().px(6).gap(7).items_center().rounded(6)
      .text_size(12).line_height("18px").text_color(c.faint)
      .when(!off, (el) => el.cursor_pointer().hover((s) => s.bg(c.selected).text_color(c.text))
        .on_click(() => run("space.new", { machine: g.name ?? "" }))
        .child(svg("mods/gentle-spaces/icons/plus.svg").size(11).flex_none()).child("New space there"))
      .when(off, (el) => el.child(g.state === "loading" ? "Loading…" : "Not reachable now"));
  }

  // S15: the pinned Needs you section's height for `n` waiting sessions (0 when none).
  needHeight(n, collapsed) {
    if (!n) return 0;
    if (collapsed) return 26 + NEED_GAP;
    return NEED_HEAD + Math.min(n, NEED_ROWS) * ROW + (n > NEED_ROWS ? NEED_MORE : 0) + NEED_GAP;
  }

  // One waiting session: its name and what it waits for, then its kind badge and the reason.
  needRow(c, w, on) {
    const s = w.session;
    const f = s.feed;
    const kind = sessionKind(s);
    const machine = machineOf(s.terminal?.address);
    const name = f?.identity?.sessionName || (f ? projectName(projectOf(f)) : null) || s.terminal?.title || "Gentle Shell";
    return v_flex().id(`need-${w.key}`).w_full().min_w(0).overflow_hidden().h(ROW).flex_none().p(6).rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(c.selected))
      .hover((st) => st.bg(c.selected))
      .tooltip(`${w.need.word}: ${w.need.reason}`)
      .on_click(() => selectSession(s))
      .child(h_flex().h(19.5).min_w(0).overflow_hidden().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13).line_height("19.5px").text_color(c.text).child(name))
        .child(div().flex_none().font_family(c.mono).font_weight(600).text_size(10.5).line_height("13.5px").text_color(c.warn).child(w.need.word.toUpperCase())))
      .child(h_flex().h(17.25).gap(6).items_center().min_w(0).overflow_hidden()
        .child(kindBadge(c, kind, MOD, machine))
        .child(div().min_w(0).truncate().text_size(11.5).line_height("17.25px").text_color(c.muted).child(w.need.reason)));
  }

  needs(c, waits, shownKey, collapsed) {
    if (collapsed) {
      return h_flex().w_full().h(26).mb(NEED_GAP).flex_none().justify_center()
        .child(h_flex().id("needs").w(32).h(26).gap(4).rounded(6).justify_center().items_center().cursor_pointer()
          .hover((s) => s.bg(c.selected)).tooltip(`${plural(waits.length, "session")} need${waits.length === 1 ? "s" : ""} you`)
          .on_click(() => selectSession(waits[0].session))
          .child(div().size(5).rounded(3).bg(c.warn))
          .child(div().font_family(c.mono).text_size(11).text_color(c.warn).child(String(waits.length))));
    }
    const more = waits.length - NEED_ROWS;
    return v_flex().id("needs").flex_none().mb(NEED_GAP)
      .child(h_flex().h(NEED_HEAD).flex_none().px(6).pb(6).items_center().justify_between()
        .child(eyebrow(c, "Needs you", c.warn))
        .child(div().font_family(c.mono).text_size(11.5).line_height("17.25px").text_color(c.warn).child(String(waits.length))))
      .children(waits.slice(0, NEED_ROWS).map((w) => this.needRow(c, w, w.key === shownKey)))
      .when(more > 0, (el) => el.child(div().h(NEED_MORE).flex_none().px(6).text_size(11.5).line_height("17.25px").text_color(c.muted)
        .child(`+${more} more waiting`)));
  }

  compact(c, w, i, info) {
    return h_flex().id(`space-${w.id}`).w(32).h(26).rounded(6).justify_center().items_center().cursor_pointer()
      .when(w.active, (el) => el.bg(c.selected))
      .hover((s) => s.bg(c.selected))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? c.text : c.muted).child(String(i + 1)))
      .when((info?.need ?? 0) > 0, (el) => el.child(div().size(5).rounded(3).bg(c.warn)));
  }

  render() {
    const c = tokens();
    const sp = spaces();
    const { by: info, extra } = this.sessions(sp);
    const collapsed = narrow();
    // S14: grouped by machine once one is not this computer (machines.js); null keeps the plain list.
    let groups = null;
    try { groups = collapsed ? null : machineGroups(sp, machines()); } catch { groups = null; }
    const heads = groups ? groups.length * MACHINE + groups.filter((g) => !g.spaces.length).length * EMPTY : 0;
    const waits = needsYouList(this.source.sessions());
    this.fit(sp.length + (collapsed ? 0 : extra.length), heads + this.needHeight(waits.length, collapsed));
    // The highlighted project is the shown session's (snapshot.js targetSession): a session outside
    // Herdr app shows its own project, else Herdr's shown space.
    const shown = this.source.target(this.last);
    if (shown) this.last = shown.key;
    const outside = shown && !shown.terminal && shown.feed ? projectOf(shown.feed) : null;
    const outsideSpace = outside ? spaceFor(outside, sp) : null;
    const isOn = (w) => (outside ? outsideSpace?.id === w.id : w.active);
    return v_flex().id("root").size_full().min_h(0).bg(c.chrome).font_family(c.sans).text_size(13)
      .pt(PAD_TOP).px(collapsed ? 0 : 10).pb(PAD_BOTTOM)
      .when(waits.length > 0, (el) => el.child(this.needs(c, waits, shown ? shown.key : null, collapsed)))
      .child(h_flex().h(HEADER).flex_none().px(6).pb(6).items_center().justify_between()
        .when(collapsed, (el) => el.px(0).justify_center())
        .when(!collapsed, (el) => el.child(eyebrow(c, "Projects")))
        .child(div().id("space-new").size(32).flex_none().flex().items_center().justify_center().rounded(8).text_color(c.muted)
          .hover((s) => s.bg(c.selected).text_color(c.text)).tooltip("Open a project")
          .on_click(() => run("space.new")).child(svg("mods/gentle-spaces/icons/plus.svg").size(13))))
      .child(v_flex().id("space-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(collapsed, (el) => el.items_center())
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(groups
          ? groups.flatMap((g) => [this.machineHead(c, g), ...(g.spaces.length ? g.spaces.map((w) => this.row(c, w, info[w.id], isOn(w))) : [this.machineEmpty(c, g)]),
            // Projects no space holds run on this computer: they close its group.
            ...(g.name === null ? extra.map((p) => this.projectRow(c, p, Boolean(outside) && !outsideSpace && p.path === outside)) : [])])
          : sp.map((w, i) => (collapsed ? this.compact(c, w, i, info[w.id]) : this.row(c, w, info[w.id], isOn(w)))))
        .children(collapsed || groups ? [] : extra.map((p) => this.projectRow(c, p, Boolean(outside) && !outsideSpace && p.path === outside))));
  }
}
