// gentle-spaces: Herdr spaces as the artboard's "Projects" (region 1b,
// design/herdr-desktop/01-inspector.html `.sb-sec` / `.space`, l.231-240). Cloned from Herdr
// 0.1.15's `spaces` (mod.clone semantics) and restyled: click selects, drag reorders, right-click
// opens the space menu, + opens a new space; each row tells its Gentle Shell sessions instead of
// git (machine groups and worktree nesting are not in the artboard and were left out).
//
// Row: 22px two-letter avatar, the space name and "<n> sessions · $<live spend>" (or the status),
// the count of sessions that need you on the right. The block is sized to its rows (see fit()).
// T11 (S10): every live Gentle Shell session counts, wherever it runs: one outside Herdr app
// belongs to the space whose folder holds its project (its Git root), and a project no space
// holds is a row of its own after the spaces (a click shows its newest session everywhere). The
// count says each kind (snapshot.js SESSION_KINDS): "1 Herdr · 2 TUI · $4.74".

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, agents, terminals, run, openOverlay, layout } from "herdr";
import { tokens, eyebrow, money } from "./tokens.js";
import { FeedSource, isGentle, followHerdr, selectSession, projectOf, projectName, spaceFor, SESSION_KINDS } from "./snapshot.js";

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

// "gentle-pi" → "gp", "herdr-zoo" → "hz", "web" → "we".
export function initials(name) {
  const parts = String(name ?? "?").toLowerCase().split(/[-_.\s/]+/).filter(Boolean);
  if (parts.length >= 2) return parts[0][0] + parts[1][0];
  return (parts[0] ?? "?").slice(0, 2);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// "1 Herdr · 2 TUI": the sessions of each kind, the kind's own word (snapshot.js SESSION_KINDS).
const kinds = (info) => [[info.herdr, SESSION_KINDS.herdr.label], [info.tui, SESSION_KINDS.tui.label]]
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
  fit(rows) {
    const want = PAD_TOP + HEADER + Math.min(Math.max(rows, 1), MAX_ROWS) * ROW + PAD_BOTTOM;
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
      const s = (by[a.space] ??= { n: 0, herdr: 0, tui: 0, cost: 0, need: 0 });
      s.n++;
      s.herdr++;
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
      const row = space ? (by[space.id] ??= { n: 0, herdr: 0, tui: 0, cost: 0, need: 0 }) : extra.get(project) ?? { id: `project-${project}`, name: projectName(project), path: project, n: 0, herdr: 0, tui: 0, cost: 0, need: 0, sessions: [] };
      row.n++; row.tui++; row.need += need; row.cost += cost;
      if (!space) { row.sessions.push(s); extra.set(project, row); }
    }
    return { by, extra: [...extra.values()] };
  }

  row(c, w, info, on = w.active) {
    const n = info?.n ?? 0;
    const small = n === 0
      ? "No Gentle Shell session"
      : `${kinds(info)} · ${money(info.cost)}`; // the artboard's "3 sessions · $4.74 today", per kind (S10): live spend, not a daily total
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
    this.fit(sp.length + (collapsed ? 0 : extra.length));
    // The highlighted project is the shown session's (snapshot.js targetSession): a session outside
    // Herdr app shows its own project, else Herdr's shown space.
    const shown = this.source.target(this.last);
    if (shown) this.last = shown.key;
    const outside = shown && !shown.terminal && shown.feed ? projectOf(shown.feed) : null;
    const outsideSpace = outside ? spaceFor(outside, sp) : null;
    const isOn = (w) => (outside ? outsideSpace?.id === w.id : w.active);
    return v_flex().id("root").size_full().min_h(0).bg(c.chrome).font_family(c.sans).text_size(13)
      .pt(PAD_TOP).px(collapsed ? 0 : 10).pb(PAD_BOTTOM)
      .child(h_flex().h(HEADER).flex_none().px(6).pb(6).items_center().justify_between()
        .when(collapsed, (el) => el.px(0).justify_center())
        .when(!collapsed, (el) => el.child(eyebrow(c, "Projects")))
        .child(div().id("space-new").size(32).flex_none().flex().items_center().justify_center().rounded(8).text_color(c.muted)
          .hover((s) => s.bg(c.selected).text_color(c.text)).tooltip("Open a project")
          .on_click(() => run("space.new")).child(svg("mods/gentle-spaces/icons/plus.svg").size(13))))
      .child(v_flex().id("space-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(collapsed, (el) => el.items_center())
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(sp.map((w, i) => (collapsed ? this.compact(c, w, i, info[w.id]) : this.row(c, w, info[w.id], isOn(w)))))
        .children(collapsed ? [] : extra.map((p) => this.projectRow(c, p, Boolean(outside) && !outsideSpace && p.path === outside))));
  }
}
