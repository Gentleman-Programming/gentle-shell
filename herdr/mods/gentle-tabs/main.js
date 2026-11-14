// gentle-tabs: the shown space's tabs as the artboard's session tabs (region 2,
// design/herdr-desktop/01-inspector.html `.tabs` / `.tab`, l.251-256). Cloned from Herdr 0.1.15's
// `tabs` (mod.clone semantics): click selects, drag reorders, double-click renames, right-click
// opens the tab menu, the wheel moves between tabs, the active tab scrolls into view. Restyled:
// 34px tabs on the bar's bottom edge, a state dot and the Gentle Shell session name, the active
// tab in the canvas colour with a 2px accent top edge. The Files / Changes buttons of `tabs` are
// gone (the inspector replaces them); + starts a new Gentle Shell session.

import { View, div, svg } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, agents, terminals, run, openOverlay, window, layout, settings } from "herdr";
import { tokens, stateDot } from "./tokens.js";
import { FeedSource, isGentle } from "./snapshot.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Herdr status → artboard .state kind (the tab shows only the dot; the word is its tooltip).
const KIND = { blocked: ["need", "Needs you"], working: ["work", "Working"], done: ["done", "Done"], idle: ["idle", "Idle"] };

export default class GentleTabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.source = new FeedSource();
    this.source.start(cx);
  }

  // The tab's name: the Gentle Shell session name of its agent, else the name it was given.
  name(tab) {
    const a = agents().find((x) => x.tab === tab.id && isGentle(x.app));
    const term = a && terminals().find((t) => t.address === a.address);
    const session = this.source.of(term)?.identity?.sessionName;
    if (session) return session;
    if (tab.named || !/^\d+$/.test(tab.name)) return tab.name;
    return a?.title?.trim() || (a ? "Gentle Shell" : `Tab ${tab.name}`);
  }

  item(c, tab, i, shown, space, active) {
    const on = tab.active;
    const [kind, word] = KIND[tab.status] ?? KIND.idle;
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex().id(`tab-${tab.id}`).relative().h(34).flex_none().max_w(260).px(12).gap(8).items_center()
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
        else run("tab.select", { id: tab.id });
      })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: tab.id, space: space.id } } }); })
      .child(div().flex_none().tooltip(word).child(stateDot(c, kind)))
      .child(div().min_w(0).truncate().child(tab.zoomed ? `${this.name(tab)} (zoomed)` : this.name(tab)));
  }

  render() {
    const c = tokens();
    const space = spaces().find((s) => s.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex((t) => t.active);
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
    return h_flex().id("root").size_full().min_w(0).pl(lights).pr(10).gap(2).items_end().bg(c.chrome).font_family(c.sans)
      .border_b(1).border_color(c.line)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel((e) => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").min_w(0).h_full().items_end().gap(2).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_s, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map((t, i) => this.item(c, t, i, shown, space, active))))
      // .tab-add: a 32px icon button, margin 0 0 4px 4px.
      .child(div().id("tab-new").size(32).ml(4).mb(4).flex_none().flex().items_center().justify_center().rounded(8).text_color(c.muted)
        .hover((s) => s.bg(c.selected).text_color(c.text)).tooltip("New Gentle Shell session")
        .on_mouse_down("left", stop)
        .on_click(() => run("tab.new", { argv: ["gentle-shell"] }))
        .child(svg("mods/gentle-tabs/icons/plus.svg").size(13)));
  }
}
