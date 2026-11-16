// gentle-agents: the sidebar's agents list, needs-you first (artboard region 1c,
// design/herdr-desktop/01-inspector.html `.sb-sec` / `.agent-row`, l.231-243). Cloned from Herdr
// 0.1.15's `agents` (mod.clone semantics): the same priority order (blocked > done > working >
// idle, then most recent change), pins first, setAgentOrder so agent.next / agent.prev follow
// the list, click focuses the agent. Restyled to two-line rows: the session title and its state
// label, then "<app> · <space> · <address>". Sub-agent trees are in the inspector's Agents tab.
// T11 (S10): every live Gentle Shell session that runs outside Herdr app (the Herdr TUI, Ghostty,
// …) is a row too, from its snapshot: its name, state, spend, project and where it runs; a click
// shows it in every region (snapshot.js selectSession). The two kinds are two sections, each with
// its eyebrow and count, needs-you first inside each: "Herdr · In this window" (the agents of
// this window's herdr-core terminals) and "TUI · Other terminals" (Gentle Shell TUIs elsewhere);
// every row also carries its kind badge (tokens.js kindBadge, snapshot.js SESSION_KINDS).
// S14: an agent on another machine (a remote space, `hc machine ls`) stays in this window's section
// with the Remote badge named after its machine; what it shows is herdr-core's (state, title,
// space): its snapshot is on that machine, so no spend or session name from it.
// S15: a row's state counts the session's live work (snapshot.js liveState): "Working · 2 agents"
// while its turn runs, "Waiting on 2 agents" once the turn ended but its subagents or jobs still
// run (Herdr calls that terminal idle), never "Idle" while that work runs.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, spaces, run, setAgentOrder, layout } from "herdr";
import { tokens, eyebrow, state, sessionTitle, sessionCost, kindBadge } from "./tokens.js";
import { FeedSource, followHerdr, selectSession, projectOf, projectName, whereLabel, machineOf, liveState, SESSION_KINDS } from "./snapshot.js";

const MOD = "gentle-agents";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// pi titles its terminal "π - <folder>"; π is a letter, so it is cut by name first.
const clean = (s) => sessionTitle(s).replace(/^[^\p{L}\p{N}]+/u, "").trim();
const RANK = { blocked: 4, done: 3, working: 2, waiting: 2, idle: 1 };
// Herdr status → artboard .state kind and label.
const KIND = { blocked: ["need", "Needs you"], working: ["work", "Working"], waiting: ["work", "Waiting"], done: ["done", "Done"], idle: ["idle", "Idle"] };

// A Herdr agent's state with its snapshot's live work (S15): needs you when either says so; the
// snapshot's working / waiting words (with their counts) over Herdr's idle or done; else Herdr's.
function herdrState(a, feed) {
  const live = feed ? liveState(feed) : null;
  if (a.status === "blocked" || live?.status === "blocked") return { status: "blocked", label: KIND.blocked[1] };
  if (live && (live.status === "waiting" || live.status === "working")) return live;
  return { status: a.status, label: (KIND[a.status] ?? KIND.idle)[1] };
}

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

  row(c, a, tab, feed, on) {
    const st = herdrState(a, feed);
    const [kind] = KIND[st.status] ?? KIND.idle;
    const label = st.label;
    const app = a.app ?? a.program?.key ?? a.program?.name ?? "terminal";
    const machine = machineOf(a.address);
    return v_flex().id(`ag-${a.address}`).w_full().h(48.75).flex_none().p(6).rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(c.selected))
      .hover((s) => s.bg(c.selected))
      .when(Boolean(machine), (el) => el.tooltip(`Runs on ${machine}: herdr-core reports its state; its chat and inspector feed stay on that machine`))
      .on_click(() => { followHerdr(); run("pane.focus", { pane: a.pane }); })
      .child(h_flex().h(19.5).min_w(0).overflow_hidden().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13).line_height("19.5px").text_color(c.text).child(title(a, tab, feed)))
        .child(state(c, kind, label)))
      .child(h_flex().h(17.25).gap(6).items_center().min_w(0).overflow_hidden()
        .child(machine ? kindBadge(c, SESSION_KINDS.remote, MOD, machine) : kindBadge(c, SESSION_KINDS.herdr, MOD))
        .child(div().min_w(0).truncate().text_size(11.5).line_height("17.25px").text_color(c.muted).child(`${app} · ${a.space_name} · ${a.address}`)));
  }

  // A session outside Herdr app (T11): the same two lines, from its snapshot. Its state: needs you
  // while a question or prompt is open, working, else idle; the second line names its project,
  // its spend and where it runs.
  elsewhereRow(c, s, on) {
    const f = s.feed;
    const st = liveState(f);
    const [kind] = KIND[st.status] ?? KIND.idle;
    const label = st.label;
    const title = f.identity?.sessionName || projectName(projectOf(f)) || "Gentle Shell";
    return v_flex().id(`ag-${s.key}`).w_full().h(48.75).flex_none().p(6).rounded(6).cursor_pointer()
      .when(on, (el) => el.bg(c.selected))
      .hover((st) => st.bg(c.selected))
      .tooltip(`Runs outside Herdr app (${whereLabel(s)}) · ${f.identity?.cwd ?? ""}`)
      .on_click(() => selectSession(s))
      .child(h_flex().h(19.5).min_w(0).overflow_hidden().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(13).line_height("19.5px").text_color(c.text).child(title))
        .child(state(c, kind, label)))
      .child(h_flex().h(17.25).gap(6).items_center().min_w(0).overflow_hidden()
        .child(kindBadge(c, SESSION_KINDS.tui, MOD))
        .child(div().min_w(0).truncate().text_size(11.5).line_height("17.25px").text_color(c.muted)
          .child(`${projectName(projectOf(f))} · ${sessionCost(Number(f.cost?.total) || 0)} · ${whereLabel(s)}`)));
  }

  // A section's head: the kind's eyebrow ("HERDR · IN THIS WINDOW") and its row count.
  head(c, kind, n, first) {
    return h_flex().flex_none().px(6).pt(first ? 0 : 12).pb(6).items_center().justify_between()
      .child(eyebrow(c, `${kind.label} · ${kind.section}`))
      .child(div().font_family(c.mono).text_size(11.5).line_height("17.25px").text_color(c.muted).child(String(n)));
  }

  // An empty section: one calm line.
  none(c, text) {
    return div().flex_none().px(6).pb(4).text_size(12).line_height("18px").text_color(c.faint).child(text);
  }

  compact(c, a, i, feed) {
    const [kind] = KIND[herdrState(a, feed).status] ?? KIND.idle;
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
    const terms = new Map(terminals().map((t) => [t.address, t]));
    const feedOf = new Map(list.map((a) => [a.address, this.source.of(terms.get(a.address))]));
    const rank = (a) => RANK[herdrState(a, feedOf.get(a.address)).status] ?? 0;
    list = [...list].sort((x, y) => (y.pinned - x.pinned) || rank(y) - rank(x) || since(y) - since(x) || y.seq - x.seq);
    setAgentOrder(list.map((a) => a.address));
    const tabs = new Map(spaces().flatMap((s) => s.tabs).map((t) => [t.id, t]));
    const collapsed = narrow();
    // The shown session (snapshot.js targetSession) is the highlighted row, Herdr's or not.
    const shown = this.source.target(this.last);
    if (shown) this.last = shown.key;
    const elsewhere = this.source.sessions().filter((s) => s.feed && !s.terminal)
      .sort((x, y) => (RANK[statusOf(y.feed)] ?? 0) - (RANK[statusOf(x.feed)] ?? 0) || String(y.feed.updatedAt).localeCompare(String(x.feed.updatedAt)));
    const herdrOn = (a) => (shown ? shown.terminal?.address === a.address : a.focused);
    if (collapsed) {
      return v_flex().id("root").size_full().min_h(0).bg(c.chrome).font_family(c.sans).text_size(13).pt(10).pb(6)
        .child(v_flex().id("ag-list").flex_1().min_h(0).overflow_y_scrollbar().children(list.map((a, i) => this.compact(c, a, i, feedOf.get(a.address)))));
    }
    // Two sections, one scroll: this window's Herdr terminals, then TUIs in other terminals.
    return v_flex().id("root").size_full().min_h(0).bg(c.chrome).font_family(c.sans).text_size(13)
      .pt(10).px(10).pb(6)
      .child(v_flex().id("ag-list").flex_1().min_h(0).overflow_y_scrollbar()
        .child(this.head(c, SESSION_KINDS.herdr, list.length, true))
        .when(list.length === 0, (el) => el.child(this.none(c, "No agent in this window yet.")))
        .children(list.map((a) => this.row(c, a, tabs.get(a.tab), feedOf.get(a.address), herdrOn(a))))
        .child(this.head(c, SESSION_KINDS.tui, elsewhere.length, false))
        .when(elsewhere.length === 0, (el) => el.child(this.none(c, "No Gentle Shell TUI in another terminal.")))
        .children(elsewhere.map((s) => this.elsewhereRow(c, s, shown?.key === s.key))));
  }
}

// A snapshot's state in Herdr's words: blocked (a question, prompt or consent waits), working,
// waiting (S15: only its background subagents or jobs run), idle.
function statusOf(f) {
  return liveState(f).status;
}
