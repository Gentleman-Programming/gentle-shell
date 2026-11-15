// gentle-sidebar: the sidebar's brand row and its plan-usage footer (artboard regions 1a and 1d,
// design/herdr-desktop/01-inspector.html). Adapted from Herdr 0.1.15's `workspace-chrome`
// (mod.clone semantics: the same two-part mod, `props.part` picks the part) and restyled.
//
// props: { part: "brand" | "usage" }
//   brand  `.brand` (l.226-230): 46px row, mark + "Gentle Shell", left room for the traffic lights.
//   usage  `.sb-foot` (l.244-248): "Plan usage · <plan>", one bar per window, the reset line, a
//          refresh and a gear.
// Data: the shown Gentle Shell session's snapshot `usage` (docs/desktop-feed.md), wherever it runs
// (snapshot.js targetSession, T11).
//
// S12: the footer shows what the TUI usage panel (alt+u) shows for the session: its provider's
// plan and EVERY window it reports (each limit's windows, named "<limit> <window>" when there are
// several limits, as the panel names them), then the other providers the panel lists (the
// session's subagent routes) with their windows or the panel's own note. The block grows to its
// rows (the artboard's 111px holds two windows) and shrinks back. The refresh button asks the
// session's usage owner for the panel's `r` (the `refresh_usage` action, actions.js).
//
// S14: the footer ends with "Add machine", Herdr's own sidebar entry (`workspace-chrome` footer:
// `mod.open machine-add`, the shipped dialog that lists the ssh-config hosts and says what each
// needs). Its machines and their state are the Projects headers (gentle-spaces). Not in the
// artboard: one more 24.25px line under the usage rows.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { layout, props, run, window } from "herdr";
import { tokens, eyebrow, bar, until, windowLabel } from "./tokens.js";
import { FeedSource } from "./snapshot.js";
import { sendAction, errorText } from "./actions.js";

const ICON = (name) => `mods/gentle-sidebar/icons/${name}.svg`;
// .sb-foot: padding 10 / 12, gap 7; the eyebrow (15.4px + 1px of leading) and 17.25px rows.
const PAD = 10 + 12;
const EYEBROW = 16.25;
const LINE = 17.25 + 7;
const MAX_LINES = 10; // rows drawn at most (windows, other providers, the reset line)
const BASE_PX = 111; // the artboard's footer: two windows and the reset line

// "fetch failed · r to retry" is the TUI's key; here the refresh button does it.
const noteText = (note) => String(note ?? "").replace(/\s*·\s*r to \w+$/, "");
const find = (node, id) => (node?.id === id ? node : (node?.children ?? []).map((c) => find(c, id)).find(Boolean));

// One provider's rows: every window of every limit (the panel's rows), in its order.
function windowRows(entry) {
  const limits = Array.isArray(entry?.limits) ? entry.limits : [];
  const named = limits.length > 1;
  return limits.flatMap((l) => (Array.isArray(l?.windows) ? l.windows : []).map((w) => ({
    label: named ? [l.name, windowLabel(w)].filter(Boolean).join(" ") : windowLabel(w),
    pct: Number(w?.usedPercent) || 0,
    resetAt: w?.resetAt ?? null,
    reached: Boolean(l?.limitReached),
  })));
}

export default class GentleSidebar extends View {
  init(_props, cx) {
    if (props()?.part !== "usage") return;
    this.source = new FeedSource();
    this.source.start(cx);
    this.last = null;
    this.busy = false;
    this.error = null;
    // The reset line counts down in minutes: looked at once a minute, redrawn only when its words
    // changed (S13: a redraw is the whole window's).
    this.resetAt = null;
    this.resetShown = "";
    cx.timer.every(60000, (cx) => { if ((this.resetAt === null ? "" : until(this.resetAt)) !== this.resetShown) cx.notify(); });
  }

  brand(c) {
    const w = window();
    // .brand padding 0 14px 0 78px: the macOS traffic lights sit in the first 78px.
    const lights = w?.platform === "macos" && !w?.fullscreen;
    return h_flex().id("brand").size_full().bg(c.chrome).font_family(c.sans).items_center().gap(10).pr(14).pl(lights ? 78 : 14)
      .child(svg(ICON("mark")).size(26).flex_none().text_color(c.accent))
      .child(div().font_weight(700).text_size(13).line_height("19.5px").text_color(c.text).child("Gentle Shell"));
  }

  // The panel's `r`: the session's usage owner refetches (the snapshot follows).
  refresh(feed, cx) {
    if (this.busy || !feed) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let r;
      try { r = await sendAction(cx, feed, "refresh_usage", {}); } catch (e) { r = { ok: false, error: { message: String(e?.message ?? e) } }; }
      this.busy = false;
      this.error = r.ok ? null : r.error?.code === "unknown_kind" ? "Restart this session to refresh from here" : errorText(r);
      cx.notify();
    });
  }

  // Sizes the footer block to its lines (artboard: 111px for two windows), like gentle-spaces.
  fit(lines) {
    const want = Math.max(BASE_PX, PAD + EYEBROW + Math.min(lines, MAX_LINES) * LINE);
    const node = find(layout(), "sidebar-footer");
    if (node && Math.abs((node.size?.px ?? 0) - want) > 0.5) run("layout.resize", { id: "sidebar-footer", px: want });
  }

  usage(c) {
    const shown = this.source?.target(this.last);
    if (shown) this.last = shown.key;
    const feed = shown?.feed ?? null;
    const u = feed?.usage ?? null;
    const own = windowRows(u);
    const others = (Array.isArray(u?.providers) ? u.providers : []).filter((p) => p?.provider && p.provider !== u.provider);
    const title = u?.plan || u?.provider;
    const plan = title ? `Plan usage · ${title}` : "Plan usage";
    // .usage: grid 22px | 1fr | 36px, gap 8; the first window's bar is accent, the next muted.
    // A label longer than 22px (a named limit) takes the room it needs, up to half the row.
    const wide = own.some((w) => w.label.length > 3) || others.length > 0;
    const row = (w, i, key) => h_flex().id(`usage-${key}-${i}`).h(17.25).min_w(0).overflow_hidden().gap(8).items_center()
      .child(div().when(!wide, (el) => el.w(22)).when(wide, (el) => el.min_w(22).max_w(110)).flex_none().truncate().font_family(c.mono).text_size(11)
        .text_color(w.reached ? c.err : c.muted).child(w.label))
      .child(bar(c, w.pct, key === "own" && i === 0 ? "accent" : null))
      .child(div().w(36).flex_none().text_right().font_family(c.mono).text_size(11.5).text_color(c.text).child(`${Math.round(w.pct)}%`));
    const lines = [];
    own.slice(0, MAX_LINES).forEach((w, i) => lines.push(row(w, i, "own")));
    // The other providers the TUI panel lists: their windows, else the panel's note.
    for (const p of others) {
      if (lines.length >= MAX_LINES - 1) break;
      const rows = windowRows(p);
      lines.push(h_flex().id(`usage-p-${p.provider}`).h(17.25).min_w(0).overflow_hidden().whitespace_nowrap().gap(6).items_center().text_size(11.5).text_color(c.muted)
        .child(div().flex_none().max_w(rows.length ? "100%" : "60%").truncate().font_family(c.mono).text_size(11).child(p.plan ? `${p.provider} · ${p.plan}` : p.provider))
        .when(!rows.length, (el) => el.child(div().min_w(0).truncate().text_color(c.faint).child(noteText(p.note) || p.status || ""))));
      rows.slice(0, Math.max(0, MAX_LINES - 1 - lines.length)).forEach((w, i) => lines.push(row(w, i, p.provider)));
    }
    const first = own[0];
    const reset = first && until(first.resetAt);
    this.resetAt = first ? first.resetAt ?? null : null;
    this.resetShown = this.resetAt === null ? "" : until(this.resetAt);
    const note = this.error
      ? this.error
      : !feed
        ? "No Gentle Shell session focused"
        : !u
          ? "No plan usage reported"
          : !own.length
            ? noteText(u.note) || (u.status && u.status !== "ok" ? `Plan usage ${u.status}` : "No plan usage reported")
            : reset ? `${first.label} resets ${reset}` : "";
    this.fit(lines.length + 2); // + the reset line and Add machine
    return v_flex().id("usage").size_full().bg(c.chrome).font_family(c.sans).border_t(1).border_color(c.line)
      .pt(10).px(16).pb(12).gap(7).text_size(12)
      .child(eyebrow(c, plan))
      .children(lines)
      .child(h_flex().h(17.25).min_w(0).overflow_hidden().gap(8).items_center().justify_between().text_size(11.5).line_height("17.25px").text_color(this.error ? c.err : c.muted)
        .child(div().min_w(0).flex_1().truncate().child(note))
        .when(Boolean(feed), (el) => el.child(div().id("usage-refresh").flex_none().text_color(c.muted).cursor_pointer()
          .when(this.busy, (d) => d.opacity(0.5))
          .hover((s) => s.text_color(c.text))
          .tooltip(this.busy ? "Refreshing plan usage…" : "Refresh plan usage (the usage panel's r)")
          .on_click((_e, cx) => this.refresh(feed, cx))
          .child(svg(ICON("refresh")).size(13))))
        .child(div().id("usage-settings").flex_none().text_color(c.muted).cursor_pointer().hover((s) => s.text_color(c.text))
          .tooltip("Settings").on_click(() => run("app.settings"))
          .child(svg(ICON("gear")).size(13))))
      // Herdr's Add machine (workspace-chrome): another computer over ssh, its spaces in Projects.
      .child(h_flex().id("add-machine").h(17.25).min_w(0).overflow_hidden().gap(8).items_center().text_size(11.5).line_height("17.25px")
        .text_color(c.muted).cursor_pointer().hover((s) => s.text_color(c.text))
        .tooltip("Add a machine you reach over ssh: its projects and Gentle Shell sessions show here")
        .on_click(() => run("mod.open", { name: "machine-add" }))
        .child(svg(ICON("server-plus")).size(13).flex_none())
        .child(div().min_w(0).truncate().child("Add machine")));
  }

  render() {
    const c = tokens();
    return props()?.part === "usage" ? this.usage(c) : this.brand(c);
  }
}
