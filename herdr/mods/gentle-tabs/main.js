// gentle-tabs: the shown space's tabs as the artboard's session tabs (region 2,
// design/herdr-desktop/01-inspector.html `.tabs` / `.tab`, l.251-256). Cloned from Herdr 0.1.15's
// `tabs` (mod.clone semantics): click selects, drag reorders, double-click renames, right-click
// opens the tab menu, the wheel moves between tabs, the active tab scrolls into view. Restyled:
// 34px tabs on the bar's bottom edge, a state dot and the Gentle Shell session name, the active
// tab in the canvas colour with a 2px accent top edge. The Files / Changes buttons of `tabs` are
// gone (the inspector replaces them); + starts a new Gentle Shell session.
// T11 (S10): the bar shows the shown session's project: its Herdr space's tabs, then one tab per
// live session of that project that runs outside Herdr app (from its snapshot: name and state);
// a click shows that session in every region (snapshot.js selectSession). A Gentle Shell tab ends
// with its kind badge (tokens.js kindBadge): Herdr for this window's terminals, TUI for the others.
// Window buttons: the layout hides the system title bar (`"titlebar": "none"`), so where the
// system draws no buttons (`window().buttons`: Windows, Linux) the bar draws minimise, maximise
// (restore when maximised) and close at its end, as Herdr's `tabs` does, with its vector icons on
// Windows (icons/win-*.svg, copied from Herdr app's defaults, Apache-2.0). macOS keeps its
// traffic lights at the layout's `traffic_lights`.
// S15: a tab's state counts its session's live work (snapshot.js liveState): its dot stays working
// and its word says "Working · 2 agents" or "Waiting on 2 agents" while background subagents or jobs
// run, even when Herdr calls the terminal idle.

import { View, div, svg } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, agents, terminals, run, openOverlay, window, layout, settings } from "herdr";
import { tokens, stateDot, sessionTitle, kindBadge } from "./tokens.js";
import { FeedSource, isGentle, followHerdr, selectSession, projectOf, spaceFor, machineOf, liveState, SESSION_KINDS } from "./snapshot.js";
import { newTabArgs } from "./new-tab.js";

const MOD = "gentle-tabs";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Herdr status → artboard .state kind (the tab shows only the dot; the word is its tooltip).
const KIND = { blocked: ["need", "Needs you"], working: ["work", "Working"], waiting: ["work", "Waiting"], done: ["done", "Done"], idle: ["idle", "Idle"] };

export default class GentleTabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.source = new FeedSource();
    this.source.start(cx);
  }

  // The tab's name: the Gentle Shell session name of its agent, else the name someone gave the
  // tab, else the terminal's own title without pi's "π - " prefix.
  name(tab) {
    const a = agents().find((x) => x.tab === tab.id && isGentle(x.app));
    const term = a && terminals().find((t) => t.address === a.address);
    const session = this.source.of(term)?.identity?.sessionName;
    if (session) return session;
    if (tab.named || !/^\d+$/.test(tab.name)) return tab.name;
    return sessionTitle(a?.title) || (a ? "Gentle Shell" : `Tab ${tab.name}`);
  }

  // Herdr's tab state with its Gentle Shell session's live work (S15): needs you when either says
  // so; the snapshot's working / waiting words over Herdr's idle or done; else Herdr's.
  tabState(tab) {
    const a = agents().find((x) => x.tab === tab.id && isGentle(x.app));
    const feed = a ? this.source.of(terminals().find((t) => t.address === a.address)) : null;
    const live = feed ? liveState(feed) : null;
    if (tab.status === "blocked" || live?.status === "blocked") return KIND.blocked;
    if (live && (live.status === "waiting" || live.status === "working")) return [KIND[live.status][0], live.label];
    return KIND[tab.status] ?? KIND.idle;
  }

  item(c, tab, i, shown, space, active, outside) {
    const on = tab.active && !outside;
    const [kind, word] = this.tabState(tab);
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex().id(`tab-${tab.id}`).relative().h(34).flex_none().max_w(260).overflow_hidden().whitespace_nowrap().px(12).gap(8).items_center()
      .rounded_tl(8).rounded_tr(8).text_size(12.5).line_height("18.75px").cursor_pointer()
      .when(i <= active, (el) => el.on_size_change((_s, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
      .when(on, (el) => el.bg(c.canvas).text_color(c.text)
        // box-shadow: inset 0 2px 0 accent, 1px 0 0 line, -1px 0 0 line.
        .border_l(1).border_r(1).border_color(c.line)
        .child(div().absolute().top(0).left(0).right(0).h(2).rounded_tl(8).rounded_tr(8).bg(c.accent)))
      .when(!on, (el) => el.text_color(c.muted).hover((s) => s.text_color(c.text)))
      .on_mouse_down("left", (e, cx) => { stop(e, cx); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: tab.id }); })
      .on_mouse_up("left", () => {
        const from = this.pressed;
        this.pressed = null;
        if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex((x) => x.id === tab.id) + 1 });
        else { followHerdr(); run("tab.select", { id: tab.id }); }
      })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: space.id } } }); })
      .child(div().flex_none().tooltip(word).child(stateDot(c, kind)))
      .child(div().flex_shrink_1().min_w(0).truncate().child(tab.zoomed ? `${this.name(tab)} (zoomed)` : this.name(tab)))
      // S14: a tab of a space on another machine says so, with its machine's name.
      .when(agents().some((x) => x.tab === tab.id && isGentle(x.app)), (el) => el.child(space?.machine
        ? kindBadge(c, SESSION_KINDS.remote, MOD, space.machine)
        : machineOf(tab.id) ? kindBadge(c, SESSION_KINDS.remote, MOD, machineOf(tab.id)) : kindBadge(c, SESSION_KINDS.herdr, MOD)));
  }

  // A session outside Herdr app (T11): the tab's look, its state from the snapshot, a click shows it.
  elsewhere(c, s, on) {
    const f = s.feed;
    const live = liveState(f);
    const [kind] = KIND[live.status] ?? KIND.idle;
    const word = live.label;
    const pane = f.identity?.herdr?.paneId;
    return h_flex().id(`tab-${s.key}`).relative().h(34).flex_none().max_w(260).overflow_hidden().whitespace_nowrap().px(12).gap(8).items_center()
      .rounded_tl(8).rounded_tr(8).text_size(12.5).line_height("18.75px").cursor_pointer()
      .tooltip(`Runs outside Herdr app${pane ? ` (Herdr ${pane})` : ` (pid ${f.identity?.pid})`}`)
      .when(on, (el) => el.bg(c.canvas).text_color(c.text)
        .border_l(1).border_r(1).border_color(c.line)
        .child(div().absolute().top(0).left(0).right(0).h(2).rounded_tl(8).rounded_tr(8).bg(c.accent)))
      .when(!on, (el) => el.text_color(c.muted).hover((st) => st.text_color(c.text)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => selectSession(s))
      .child(div().flex_none().tooltip(word).child(stateDot(c, kind)))
      .child(div().flex_shrink_1().min_w(0).truncate().child(f.identity?.sessionName || "Gentle Shell"))
      .child(kindBadge(c, SESSION_KINDS.tui, MOD));
  }

  render() {
    const c = tokens();
    const list = spaces();
    // The shown session's project (snapshot.js targetSession): a session outside Herdr app shows
    // its own project's tabs, else Herdr's shown space.
    const target = this.source.target(this.last);
    if (target) this.last = target.key;
    const outside = target && !target.terminal && target.feed ? projectOf(target.feed) : null;
    const space = outside ? spaceFor(outside, list) : list.find((s) => s.active);
    const project = outside ?? null;
    const others = this.source.sessions().filter((s) => s.feed && !s.terminal && (project
      ? projectOf(s.feed) === project || (space && spaceFor(projectOf(s.feed), list)?.id === space.id)
      : space && spaceFor(projectOf(s.feed), list)?.id === space.id));
    const shown = space?.tabs ?? [];
    const active = outside ? -1 : shown.findIndex((t) => t.active);
    if (shown[active]?.id !== this.selected) {
      this.selected = shown[active]?.id;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    // The sidebar normally leaves room for the macOS window buttons; hidden or narrow, the bar does.
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    const lights = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / (settings().zoom ?? 1) - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const stop = (_e, cx) => cx.stop_propagation();
    const win = w?.platform === "windows";
    const control = (id, label, tip, action) => div().id(id).size(28).mb(6).flex_none().flex().items_center().justify_center()
      .rounded(6).text_size(14).text_color(c.muted).tooltip(tip)
      .hover((s) => s.bg(c.selected).text_color(c.text))
      .on_mouse_down("left", stop).on_click(() => run(action)).child(label);
    return h_flex().id("root").size_full().min_w(0).pl(lights).pr(10).gap(2).items_end().bg(c.chrome).font_family(c.sans)
      .border_b(1).border_color(c.line)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel((e) => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      // .tab-add (a 32px icon button, margin 0 0 4px 4px) right after the last tab, as in the
      // artboard: it is the scroller's last item, so it follows the tabs instead of the bar's end.
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_end().gap(2).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_s, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map((t, i) => this.item(c, t, i, shown, space, active, Boolean(outside))))
        .children(others.map((s) => this.elsewhere(c, s, target?.key === s.key)))
        .child(div().id("tab-new").size(32).ml(4).mb(4).flex_none().flex().items_center().justify_center().rounded(8).text_color(c.muted)
          .hover((s) => s.bg(c.selected).text_color(c.text)).tooltip("New Gentle Shell session")
          .on_mouse_down("left", stop)
          // A new Gentle Shell session in the shown session's project folder, else the space's (new-tab.js).
          .on_click(() => run("tab.new", newTabArgs(space, target?.feed ? projectOf(target.feed) : null)))
          .child(svg("mods/gentle-tabs/icons/plus.svg").size(13))))
      .when(Boolean(w?.buttons), (el) => el.child(h_flex().id("window-buttons").flex_none().items_end().gap(2).ml(6)
        .child(control("minimize", win ? svg("mods/gentle-tabs/icons/win-min.svg").size(16) : "−", "Minimise", "window.minimize"))
        .child(control("maximize", win ? svg(`mods/gentle-tabs/icons/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", w.maximized ? "Restore" : "Maximise", "window.maximize"))
        .child(control("close-window", svg(`mods/gentle-tabs/icons/${win ? "win-close" : "close"}.svg`).size(win ? 16 : 13), "Close", "window.close"))));
  }
}
