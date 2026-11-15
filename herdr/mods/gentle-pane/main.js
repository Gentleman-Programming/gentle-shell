// gentle-pane: the Terminal view's header (herdr/layouts/gentle-shell.json, the `main` child of
// the `views` stack). Cloned from Herdr 0.1.15's `pane` header (mod.clone semantics: props
// { pane, terminal } from the app, click focuses the pane, the hover buttons split, zoom and close
// it) and restyled as the chat header's first row (design/herdr-desktop/01-inspector.html .seg,
// l.96-99, and the artboard's open question "Chat button in the pane header"): the session's name,
// its folder and state, and the same Chat | Terminal switch with Terminal active, so the way back
// to the chat is always on screen (⌘J too).

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, home } from "herdr";
import { tokens, state, sessionTitle, kindBadge } from "./tokens.js";
import { FeedSource, SESSION_KINDS, machineOf } from "./snapshot.js";

const ICON = (name) => `mods/gentle-pane/icons/${name}.svg`;
// The layout's view stack and its chat child (herdr/layouts/gentle-shell.json).
const STACK = "views";
const CHAT = "chat";
const KIND = { blocked: ["need", "Needs you"], working: ["work", "Working"], done: ["done", "Done"] };

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class GentlePane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.source = new FeedSource();
    this.source.start(cx);
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(c, id, icon, command, args, tip) {
    return div().id(id).p(3).rounded(4).text_color(c.faint).tooltip(tip)
      .hover((s) => s.bg(c.selected).text_color(c.text))
      .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
      .child(svg(ICON(icon)).size(14));
  }

  // .seg: the chat header's Chat | Terminal switch, Terminal active here. On a narrow card
  // (`compact`) the segments keep their icons and say their words in tooltips.
  viewSwitch(c, compact) {
    const seg = (id, icon, label, active, onClick) => h_flex().id(id).items_center().gap(6).px(compact ? 6 : 9).py(2).rounded(6)
      .border(1).border_color(active ? c.lineStrong : "#00000000").when(active, (el) => el.bg(c.selected))
      .text_size(12).text_color(active ? c.text : c.muted).cursor_pointer().hover((st) => st.text_color(c.text))
      .when(Boolean(onClick), (el) => el.on_click(onClick))
      .child(svg(ICON(icon)).size(13).flex_none()).when(!compact, (el) => el.child(label));
    return h_flex().flex_none().ml_auto().p(2).gap(2).border(1).border_color(c.lineStrong).rounded(8)
      .child(seg("sw-chat", "chat", "Chat", false, (_e, cx) => { cx.stop_propagation(); run("layout.select", { stack: STACK, child: CHAT }); })
        .tooltip("Show the chat (⌘J)"))
      .child(seg("sw-term", "term", "Terminal", true, null).tooltip("The real Gentle Shell TUI"));
  }

  render() {
    const c = tokens();
    const p = this.me();
    if (!p) return div();
    const pane = p.pane;
    // The Gentle Shell session this terminal runs, for its name (snapshot.js allSessions).
    const session = p.terminal ? this.source.sessions().find((s) => s.terminal?.address === p.terminal) ?? null : null;
    const feed = session?.feed ?? null;
    // S14: a Gentle Shell terminal on another machine has no snapshot here; its badge names the machine.
    const remote = session && machineOf(p.terminal);
    const name = feed?.identity?.sessionName || sessionTitle(p.title) || ((p.program?.agent || p.program?.shell) && p.program.name) || p.program?.name || "shell";
    const [kind, word] = KIND[p.status] ?? [null, null];
    const compact = Number.isFinite(this.w) && this.w < 420;
    return h_flex().id(`pane-head-${pane}`).size_full().px(14).gap(10).items_center()
      .on_size_change((size, cx) => { if (Math.abs((this.w ?? 0) - size.width) >= 1) { this.w = size.width; cx.notify(); } })
      .bg(c.chrome).border_b(1).border_color(c.line).font_family(c.sans).text_size(12).text_color(c.muted)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      // The name gives way first on a narrow card: the switch always stays whole.
      .child(div().min_w(56).flex_shrink_1().max_w(320).truncate().text_size(14).font_weight(600).text_color(c.text).child(name))
      // A Gentle Shell terminal of this window: the Herdr kind badge, as in the chat header.
      .when(Boolean(feed), (el) => el.child(kindBadge(c, SESSION_KINDS.herdr, "gentle-pane")))
      .when(Boolean(remote), (el) => el.child(kindBadge(c, SESSION_KINDS.remote, "gentle-pane", remote)))
      .child(div().flex_1().min_w(0).flex_shrink_1().truncate().child(folder(p.cwd)))
      .when(Boolean(kind), (el) => el.child(state(c, kind, word)))
      .when(this.hovered, (el) => el
        .child(this.button(c, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }, "Split right"))
        .child(this.button(c, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }, "Split down"))
        .child(this.button(c, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }, p.zoomed ? "Unzoom" : "Zoom"))
        .child(this.button(c, `ph-x-${pane}`, "close", "pane.close", { pane }, "Close")))
      .child(this.viewSwitch(c, compact));
  }
}
