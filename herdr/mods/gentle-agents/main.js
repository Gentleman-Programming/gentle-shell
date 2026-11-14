// gentle-agents: the sidebar's agents list, needs-you first (artboard region 1c,
// design/herdr-desktop/01-inspector.html `.sb-sec` / `.agent-row`, l.231-243). Cloned from Herdr
// 0.1.15's `agents` (mod.clone semantics): the same priority order (blocked > done > working >
// idle, then most recent change), pins first, setAgentOrder so agent.next / agent.prev follow
// the list, click focuses the agent. Restyled to two-line rows: the session title and its state
// label, then "<app> · <space> · <address>". Sub-agent trees are in the inspector's Agents tab.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, spaces, run, setAgentOrder, layout } from "herdr";
import { tokens, eyebrow, state } from "./tokens.js";
import { FeedSource } from "./snapshot.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// Herdr status → artboard .state kind and label.
const KIND = { blocked: ["need", "Needs you"], working: ["work", "Working"], done: ["done", "Done"], idle: ["idle", "Idle"] };

// The row title (as the built-in `agents` title()): the Gentle Shell session name, else a tab
// someone named, else the agent's own terminal title, else the program.
function title(a, tab, feed) {
  if (feed?.identity?.sessionName) return feed.identity.sessionName;
  if (tab?.named) return tab.name;
  const live = clean(a.title);
  const path = /^[~/]|^[A-Za-z]:\\/.test((a.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  if (live && live !== a.program?.name && !path && !live.includes("@")) return live;
  return tab?.name && !/^\d+$/.test(tab.name) ? tab.name : a.program?.name ?? a.address;
}

export default class GentleAgents extends View {
  init(_props, cx) {
    // Each agent's last state and when it changed (ms), kept across restarts (as `agents`).
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.source = new FeedSource();
    this.source.start(cx);
  }

  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    const listed = new Set(list.map((a) => a.address));
    for (const [k, v] of Object.entries(this.changed)) if (!listed.has(k) && now - v.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  row(c, a, tab, feed) {
    const [kind, label] = KIND[a.status] ?? KIND.idle;
    const app = a.app ?? a.program?.key ?? a.program?.name ?? "terminal";
    return v_flex().id(`ag-${a.address}`).w_full().h(48.75).flex_none().p(6).rounded(6).cursor_pointer()
      .when(a.focused, (el) => el.bg(c.selected))
      .hover((s) => s.bg(c.selected))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(h_flex().h(19.5).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13).line_height("19.5px").text_color(c.text).child(title(a, tab, feed)))
        .child(state(c, kind, label)))
      .child(div().truncate().text_size(11.5).line_height("17.25px").text_color(c.muted).child(`${app} · ${a.space_name} · ${a.address}`));
  }

  compact(c, a, i) {
    const [kind] = KIND[a.status] ?? KIND.idle;
    return h_flex().id(`ag-${a.address}`).h(26).px(8).gap(4).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(c.selected)).on_click(() => run("pane.focus", { pane: a.pane }))
      .child(div().flex_1().text_right().text_color(c.muted).child(String(i + 1)))
      .child(state(c, kind, ""));
  }

  render() {
    const c = tokens();
    const now = Date.now();
    // Kept sub-agents (with a pane) belong to their parent's tree in the inspector.
    const kids = new Set(terminals().filter((t) => t.parent).map((t) => t.address));
    let list = agents().filter((a) => a.pinned || !kids.has(a.address));
    this.track(list, now);
    const since = (a) => this.changed[a.address]?.at ?? 0;
    list = [...list].sort((x, y) => (y.pinned - x.pinned) || (RANK[y.status] ?? 0) - (RANK[x.status] ?? 0) || since(y) - since(x) || y.seq - x.seq);
    setAgentOrder(list.map((a) => a.address));
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((t) => [t.id, t]));
    const terms = new Map(terminals().map((t) => [t.address, t]));
    const collapsed = narrow();
    return v_flex().id("root").size_full().min_h(0).bg(c.chrome).font_family(c.sans).text_size(13)
      .pt(10).px(collapsed ? 0 : 10).pb(6)
      .when(!collapsed, (el) => el.child(h_flex().flex_none().px(6).pb(6).items_center().justify_between()
        .child(eyebrow(c, "Agents"))
        .child(div().text_size(11.5).line_height("17.25px").text_color(c.muted).child("Needs you first"))))
      .when(list.length === 0 && !collapsed, (el) => el.child(div().px(6).text_size(12).line_height("18px").text_color(c.muted)
        .child("No agent status yet. Agents show up here when they report their status.")))
      .child(v_flex().id("ag-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(list.map((a, i) => (collapsed ? this.compact(c, a, i) : this.row(c, a, tabs.get(a.tab), this.source.of(terms.get(a.address)))))));
  }
}
