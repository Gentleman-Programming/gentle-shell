// gentle-sidebar: the sidebar's brand row and its plan-usage footer (artboard regions 1a and 1d,
// design/herdr-desktop/01-inspector.html). Adapted from Herdr 0.1.15's `workspace-chrome`
// (mod.clone semantics: the same two-part mod, `props.part` picks the part) and restyled.
//
// props: { part: "brand" | "usage" }
//   brand  `.brand` (l.226-230): 46px row, mark + "Gentle Shell", left room for the traffic lights.
//   usage  `.sb-foot` (l.244-248): "Plan usage · <plan>", 5h / 7d bars, the reset line and a gear.
// Data: the focused Gentle Shell session's snapshot `usage` (docs/desktop-feed.md).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, run, window } from "herdr";
import { tokens, eyebrow, bar, until, windowLabel } from "./tokens.js";
import { FeedSource, targetTerminal } from "./snapshot.js";

const ICON = (name) => `mods/gentle-sidebar/icons/${name}.svg`;

export default class GentleSidebar extends View {
  init(_props, cx) {
    if (props()?.part !== "usage") return;
    this.source = new FeedSource();
    this.source.start(cx);
    this.last = null;
    // The reset line counts down in minutes: redraw once a minute, nothing faster.
    cx.timer.every(60000, (cx) => cx.notify());
  }

  brand(c) {
    const w = window();
    // .brand padding 0 14px 0 78px: the macOS traffic lights sit in the first 78px.
    const lights = w?.platform === "macos" && !w?.fullscreen;
    return h_flex().id("brand").size_full().bg(c.chrome).font_family(c.sans).items_center().gap(10).pr(14).pl(lights ? 78 : 14)
      .child(svg(ICON("mark")).size(26).flex_none().text_color(c.accent))
      .child(div().font_weight(700).text_size(13).line_height("19.5px").text_color(c.text).child("Gentle Shell"));
  }

  usage(c) {
    const term = targetTerminal(this.last);
    if (term) this.last = term.address;
    const feed = this.source?.of(term);
    const u = feed?.usage ?? null;
    const windows = (u?.limits ?? []).flatMap((l) => l?.windows ?? []).slice(0, 2);
    const plan = u?.plan ? `Plan usage · ${u.plan}` : "Plan usage";
    // .usage: grid 22px | 1fr | 36px, gap 8; the first window's bar is accent, the next muted.
    const row = (w, i) => h_flex().id(`usage-${i}`).h(17.25).gap(8).items_center()
      .child(div().w(22).flex_none().font_family(c.mono).text_size(11).text_color(c.muted).child(windowLabel(w)))
      .child(bar(c, w.usedPercent, i === 0 ? "accent" : null))
      .child(div().w(36).flex_none().text_right().font_family(c.mono).text_size(11.5).text_color(c.text).child(`${Math.round(Number(w.usedPercent) || 0)}%`));
    const first = windows[0];
    const reset = first && until(first.resetAt);
    const note = !feed
      ? "No Gentle Shell session focused"
      : !u || !windows.length
        ? (u?.status && u.status !== "ok" ? `Plan usage ${u.status}` : "No plan usage reported")
        : reset ? `${windowLabel(first)} resets ${reset}` : "";
    return v_flex().id("usage").size_full().bg(c.chrome).font_family(c.sans).border_t(1).border_color(c.line)
      .pt(10).px(16).pb(12).gap(7).text_size(12)
      .child(eyebrow(c, plan))
      .children(windows.map(row))
      .child(h_flex().h(17.25).items_center().justify_between().text_size(11.5).line_height("17.25px").text_color(c.muted)
        .child(div().min_w(0).truncate().child(note))
        .child(div().id("usage-settings").flex_none().text_color(c.muted).cursor_pointer().hover((s) => s.text_color(c.text))
          .tooltip("Settings").on_click(() => run("app.settings"))
          .child(svg(ICON("gear")).size(13))));
  }

  render() {
    const c = tokens();
    return props()?.part === "usage" ? this.usage(c) : this.brand(c);
  }
}
