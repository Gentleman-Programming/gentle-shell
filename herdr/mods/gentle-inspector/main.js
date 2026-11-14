// gentle-inspector: the right inspector of the chosen design (region 5,
// design/herdr-desktop/01-inspector.html `.inspector` / `.itabs` / `.ipanel`, l.271-279 and the
// panel rules l.191-221): a tab strip (Changes, Todo, Agents, Jobs, Review, Session) over one
// panel, for the focused Gentle Shell session's desktop snapshot (docs/desktop-feed.md).
//
// One mod draws the strip and the panels: Herdr 0.1.15 rejects a stack `"header": "tabs"` (L7),
// and a header mod would need its own copy of the snapshot reader anyway. The layout block gives
// the frame (372px, 1px border, radius 10, chrome background).
//
// Actions are T7: Stop / View (subagents), Cancel / Output (jobs), Start review / Skip, Open diff
// viewer render as the artboard's buttons and do nothing yet (TODO(T7)).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { home } from "herdr";
import { tokens, eyebrow, state, bar, btn, money, span, clock, ago, cap } from "./tokens.js";
import { FeedSource, targetTerminal } from "./snapshot.js";

const ICON = (name) => `mods/gentle-inspector/icons/${name}.svg`;
const TABS = [
  { id: "changes", label: "Changes", icon: "diff" },
  { id: "todo", label: "Todo", icon: "todo" },
  { id: "agents", label: "Agents", icon: "bot" },
  { id: "jobs", label: "Jobs", icon: "jobs" },
  { id: "review", label: "Review", icon: "review" },
  { id: "session", label: "Session", icon: "stats" },
];
const TODO_T7 = () => {}; // TODO(T7): the action goes through the desktop action channel.

// File status letter and colour (.fst.m warn, .fst.a ok).
const FST = { modified: ["M", "warn"], added: ["A", "ok"], untracked: ["U", "ok"], deleted: ["D", "err"], renamed: ["R", "info"] };
// Subagent status → .state kind and word.
const AGENT = {
  queued: ["queue", "Queued"], running: ["work", "Running"], waiting: ["need", "Waiting"],
  completed: ["done", "Done"], failed: ["fail", "Failed"], cancelled: ["idle", "Cancelled"], timed_out: ["fail", "Timed out"],
};
// Review state → icon tone (REVIEW_SIDEBAR_LABELS in lib/review-sidebar-state.ts gives the words).
const REVIEW_TONE = {
  ready: "muted", consent: "warn", forecast: "info", reviewing: "info", in_review: "info", checking: "info",
  approved: "ok", closed: "ok", correction: "warn", declined: "muted", invalidated: "warn", unavailable: "muted", unknown: "muted",
};
const REVIEW_SHORT = { in_review: "in review", timed_out: "timed out" };

const tilde = (p) => {
  const h = home();
  return h && String(p).startsWith(h) ? "~" + String(p).slice(h.length) : String(p ?? "");
};
// ".worktrees/herdr-gentle-shell" for a linked worktree, else the folder's last part.
const worktreeName = (root) => {
  const s = String(root ?? "");
  const i = s.indexOf("/.worktrees/");
  return i >= 0 ? s.slice(i + 1) : tilde(s).split("/").filter(Boolean).pop() ?? s;
};

export default class GentleInspector extends View {
  init(_props, cx) {
    this.tab = TABS.some((t) => t.id === localStorage.getItem("tab")) ? localStorage.getItem("tab") : "changes";
    this.last = null;
    this.source = new FeedSource();
    this.source.start(cx);
    // Running jobs show their elapsed time: a 1s redraw only while one is shown.
    cx.timer.every(1000, (cx) => {
      if (this.tab === "jobs" && (this.feed?.jobs?.running?.length ?? 0) > 0) cx.notify();
    });
  }

  select(id, cx) {
    this.tab = id;
    localStorage.setItem("tab", id);
    cx.notify();
  }

  // ---- Tab strip (.itabs / .itab) ----

  counts(f) {
    if (!f) return {};
    const todo = f.todo?.progress;
    const blockedTodo = (f.todo?.items ?? []).some((t) => t.state === "blocked") || (f.activity?.state === "blocked" && f.todo?.current);
    const runningTodo = (f.todo?.items ?? []).some((t) => t.state === "in_progress");
    const agentsActive = f.agents?.active ?? 0;
    const jobsRunning = f.jobs?.running?.length ?? 0;
    const review = f.review?.state;
    return {
      changes: [f.changes ? String(f.changes.summary?.files ?? 0) : "…", null],
      todo: [todo?.total ? `${todo.done}/${todo.total}` : "0", blockedTodo ? "warn" : runningTodo ? "info" : null],
      agents: [agentsActive ? `${agentsActive} run` : String(f.agents?.spend?.runs ?? 0), agentsActive ? "info" : null],
      jobs: [jobsRunning ? `${jobsRunning} run` : String(f.jobs?.recent?.length ?? 0), jobsRunning ? "info" : null],
      review: [review ? (REVIEW_SHORT[review] ?? review) : "off", review === "consent" ? "warn" : null],
      session: [`${f.stats?.turns ?? 0} turns`, null],
    };
  }

  strip(c, f) {
    const counts = this.counts(f);
    return h_flex().id("itabs").flex_none().pt(6).px(6).gap(2).border_b(1).border_color(c.line)
      .children(TABS.map((t) => {
        const on = this.tab === t.id;
        const [count, tone] = counts[t.id] ?? ["", null];
        return v_flex().id(`itab-${t.id}`).relative().flex_1().min_w(0).items_center().gap(2).pt(6).px(2).pb(7)
          .rounded_tl(6).rounded_tr(6).text_size(11).line_height("16.5px").cursor_pointer()
          .text_color(on ? c.text : c.muted)
          .hover((s) => s.text_color(c.text).bg(c.selected))
          .on_click((_e, cx) => this.select(t.id, cx))
          .child(svg(ICON(t.icon)).size(15).flex_none())
          .child(div().whitespace_nowrap().child(t.label))
          .child(div().h(10.5).whitespace_nowrap().font_family(c.mono).font_weight(600).text_size(10.5).line_height("10.5px")
            .text_color(tone ? c[tone] : c.muted).child(count))
          // [aria-selected] box-shadow: inset 0 -2px 0 accent.
          .when(on, (el) => el.child(div().absolute().left(0).right(0).bottom(0).h(2).bg(c.accent)));
      }));
  }

  // ---- Panel pieces ----

  h2(c, title, right) {
    return h_flex().flex_none().mb(10).items_center().justify_between().text_size(13).line_height("19.5px").font_weight(600).text_color(c.text)
      .child(div().child(title))
      .when(Boolean(right), (el) => el.child(right));
  }

  note(c, text) {
    return div().text_size(12).line_height("18px").text_color(c.muted).child(text);
  }

  kv(c, rows) {
    return v_flex().gap(4).children(rows.map(([k, v], i) => h_flex().id(`kv-${k}-${i}`).gap(12).items_center()
      .child(div().flex_1().min_w(0).truncate().text_color(c.muted).child(k))
      .child(div().flex_none().text_right().font_family(c.mono).text_color(c.text).child(v))));
  }

  subhead(c, text) {
    return div().mt(6).mb(2).child(eyebrow(c, text));
  }

  // ---- Panels ----

  changes(c, f) {
    const ch = f.changes;
    const head = this.h2(c, "Changes", btn(c, "open-diff", "Open diff viewer", { onClick: TODO_T7 }));
    if (!ch) return [head, this.note(c, "Scanning the working tree…")];
    const s = ch.summary ?? { files: 0, added: 0, deleted: 0 };
    const wt = ch.worktrees?.[0];
    const sum = h_flex().gap(10).items_baseline().text_size(13).line_height("19.5px")
      .child(div().font_weight(600).text_color(c.text).child(s.files === 1 ? "1 file" : `${s.files} files`))
      .child(div().font_family(c.mono).text_color(c.ok).child(`+${s.added}`))
      .child(div().font_family(c.mono).text_color(c.err).child(`−${s.deleted}`));
    if (!ch.files?.length) return [head, v_flex().gap(10).child(sum).child(this.note(c, "Working tree clean"))];
    const where = wt ? h_flex().gap(4).text_size(12).line_height("18px").text_color(c.muted)
      .child(div().flex_none().child(ch.worktrees.length > 1 ? `${ch.worktrees.length} worktrees ·` : "Worktree"))
      .child(div().min_w(0).truncate().font_family(c.mono).text_color(c.muted).child(worktreeName(wt.root)))
      .child(div().flex_none().child("· uncommitted")) : null;
    const rows = ch.files.map((file, i) => {
      const [letter, tone] = FST[file.status] ?? ["?", "muted"];
      const path = String(file.path ?? "");
      const cut = path.lastIndexOf("/") + 1;
      return h_flex().id(`file-${i}`).w_full().min_h(28).px(6).py(5).gap(8).items_center().rounded(6).cursor_pointer()
        .hover((s) => s.bg(c.selected)).on_click(TODO_T7)
        .child(div().w(16).flex_none().font_family(c.mono).font_weight(600).text_size(11).line_height("11px").text_color(c[tone]).child(letter))
        .child(h_flex().flex_1().min_w(0).overflow_hidden()
          .when(cut > 0, (el) => el.child(div().flex_shrink(1).min_w(0).truncate().text_color(c.muted).child(path.slice(0, cut))))
          .child(div().flex_none().text_color(c.text).child(path.slice(cut))))
        .child(div().flex_none().font_family(c.mono).text_color(c.ok).child(`+${file.added ?? 0}`))
        .child(div().flex_none().font_family(c.mono).text_color(c.err).child(`−${file.deleted ?? 0}`));
    });
    return [head, v_flex().gap(10).child(sum).when(Boolean(where), (el) => el.child(where))
      .child(v_flex().gap(1).children(rows))
      .when(Boolean(ch.truncated), (el) => el.child(this.note(c, `Showing the first ${ch.files.length} files`)))];
  }

  todo(c, f) {
    const td = f.todo ?? { items: [], progress: { done: 0, total: 0 } };
    const head = this.h2(c, "Todo");
    const { done = 0, total = 0 } = td.progress ?? {};
    if (!td.items?.length) return [head, this.note(c, "No tasks in this session yet")];
    const blocked = f.activity?.state === "blocked";
    const items = td.items.map((t, i) => {
      const isDone = t.state === "done";
      const dropped = t.state === "dropped";
      const now = t.state === "in_progress" || t.state === "blocked";
      const tone = t.state === "blocked" || (now && blocked) ? "warn" : now ? "info" : null;
      const tick = div().size(16).flex_none().mt(1).rounded(4).border(1.5).flex().items_center().justify_center()
        .border_color(isDone ? c.ok : tone ? c[tone] : c.lineStrong)
        .when(isDone, (el) => el.text_color(c.ok).child(svg(ICON("check")).size(13)))
        .when(now, (el) => el.child(div().size(6).rounded(2).bg(c[tone ?? "warn"])));
      const sub = t.note ?? (now && blocked ? f.activity?.blockedLabel ?? "Waiting for your answer" : null);
      return h_flex().id(`todo-${t.id ?? i}`).px(6).py(4).gap(8).items_start()
        .child(tick)
        .child(v_flex().flex_1().min_w(0)
          .child(div().text_color(isDone || dropped ? c.muted : c.text).when(isDone || dropped, (el) => el.line_through()).child(String(t.title ?? "")))
          .when(Boolean(sub), (el) => el.child(div().text_size(11.5).line_height("17.25px").text_color(c[tone ?? "muted"]).child(String(sub)))));
    });
    return [head, v_flex().gap(10)
      .child(h_flex().gap(10).items_center().text_size(13).line_height("19.5px")
        .child(div().flex_none().font_weight(600).text_color(c.text).child(`${done} of ${total}`))
        .child(bar(c, total ? (done / total) * 100 : 0, "ok")))
      .child(v_flex().gap(1).children(items))
      .when(Boolean(td.truncated), (el) => el.child(this.note(c, `Showing the first ${td.items.length} tasks`)))];
  }

  agents(c, f) {
    const ag = f.agents;
    const spent = ag?.spend?.cost ? div().font_family(c.mono).font_weight(400).text_color(c.muted).child(`${money(ag.spend.cost)} spent`) : null;
    const head = this.h2(c, "Agents", spent);
    if (!ag?.items?.length) return [head, this.note(c, "No subagents in this session")];
    const cards = ag.items.map((a, i) => {
      const [kind, word] = AGENT[a.state] ?? ["idle", cap(a.state)];
      const live = a.state === "running" || a.state === "waiting"; // .acts only on a live subagent
      const step = a.step && a.step !== a.state && !["running", "queued", "completed", "failed", "cancelled", "timed_out"].includes(a.step) ? ` · ${a.step}` : "";
      return v_flex().id(`ag-${a.id ?? i}`).when(i > 0, (el) => el.mt(6)).p(8).gap(2).rounded(8).border(1).border_color(c.line)
        .child(h_flex().gap(6).items_baseline().min_w(0)
          .child(div().flex_none().font_family(c.mono).font_weight(600).text_size(10.5).line_height("16.8px").text_color(c.accent)
            .child(String(a.role ?? a.name ?? "agent").toUpperCase()))
          .when(Boolean(a.title), (el) => el.child(div().min_w(0).truncate().font_weight(600).text_color(c.text).child(String(a.title)))))
        .child(h_flex().gap(10).items_center().text_size(12).line_height("18px").text_color(c.muted)
          .child(state(c, kind, `${word}${step}`))
          .when(Boolean(a.model), (el) => el.child(div().min_w(0).truncate().child(String(a.model))))
          .when(Boolean(a.spend?.cost), (el) => el.child(div().flex_none().font_family(c.mono).child(money(a.spend.cost)))))
        .when(live, (el) => el.child(h_flex().mt(4).gap(6)
          .child(btn(c, `ag-view-${i}`, "View", { onClick: TODO_T7 }))
          .child(btn(c, `ag-stop-${i}`, "Stop", { danger: true, icon: ICON("stop"), onClick: TODO_T7 }))));
    });
    return [head, v_flex().children(cards)];
  }

  jobs(c, f) {
    const head = this.h2(c, "Jobs");
    const running = f.jobs?.running ?? [];
    const recent = f.jobs?.recent ?? [];
    if (!running.length && !recent.length) return [head, this.note(c, "No background jobs in this session")];
    const now = Date.now();
    const job = (j, i, live) => {
      let kind, word, action = null;
      if (live) { kind = "work"; word = "Running"; action = btn(c, `job-cancel-${i}`, "Cancel", { danger: true, onClick: TODO_T7 }); }
      else if (j.status === "exited" && (j.exitCode ?? 0) === 0) { kind = "done"; word = "Passed"; }
      else if (j.status === "stopped") { kind = "idle"; word = "Stopped"; }
      else {
        kind = "fail";
        word = j.exitCode != null && j.exitCode !== 0 ? `Failed · exit ${j.exitCode}` : "Failed";
        action = btn(c, `job-output-${i}`, "Output", { onClick: TODO_T7 });
      }
      const elapsed = live ? now - (Number(j.startedAt) || now) : j.elapsedMs;
      return v_flex().id(`job-${live ? "r" : "f"}-${j.id ?? i}`).p(6).gap(2).rounded(6)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().font_family(c.mono).text_size(12).line_height("18px").text_color(c.text).child(String(j.label ?? "")))
          .when(Boolean(action), (el) => el.child(action)))
        .child(h_flex().gap(10).items_center().text_size(12).line_height("18px").text_color(c.muted)
          .child(state(c, kind, word))
          .child(div().font_family(c.mono).child(clock(elapsed)))
          .when(!live && Boolean(j.endedAt), (el) => el.child(div().child(ago(j.endedAt, now)))));
    };
    return [head, v_flex().gap(10)
      .when(running.length > 0, (el) => el.child(this.subhead(c, "Running")).children(running.map((j, i) => job(j, i, true))))
      .when(recent.length > 0, (el) => el.child(this.subhead(c, "Finished")).children(recent.map((j, i) => job(j, i, false))))];
  }

  review(c, f) {
    const head = this.h2(c, "Review");
    const r = f.review;
    const tone = r ? REVIEW_TONE[r.state] ?? "muted" : "muted";
    const box = h_flex().p(10).gap(10).items_center().rounded(8).border(1).border_color(c.line)
      .child(svg(ICON("review")).size(15).flex_none().text_color(c[tone]))
      .child(v_flex().flex_1().min_w(0)
        .child(div().font_weight(600).text_size(13).line_height("19.5px").text_color(c.text).child(r ? String(r.label || cap(r.state)) : "Review is off"))
        .child(div().truncate().text_color(c.muted).child(r ? (r.scope ? `Candidate: ${r.scope}` : "No candidate yet") : "RDD is not active in this session")));
    if (!r) return [head, v_flex().gap(10).child(box)];
    const ask = r.state === "ready" || r.state === "consent";
    return [head, v_flex().gap(10).child(box)
      .child(this.kv(c, [["State", REVIEW_SHORT[r.state] ?? r.state]]))
      .when(ask, (el) => el.child(h_flex().gap(6)
        .child(btn(c, "review-start", "Start review", { primary: true, onClick: TODO_T7 }))
        .child(btn(c, "review-skip", "Skip for this change", { onClick: TODO_T7 }))))];
  }

  session(c, f) {
    const st = f.stats ?? {};
    const rows = [
      ["Turns", String(st.turns ?? 0)],
      ["Tool calls", String(st.toolCalls ?? 0)],
      ["Duration", span(st.durationMs)],
      ["Cost", money(f.cost?.total ?? st.cost)],
      ["Subagent spend", money(f.agents?.spend?.cost ?? 0)],
    ];
    const models = (st.models ?? []).map((m) => [`${m.model} · ${m.turns} ${m.turns === 1 ? "turn" : "turns"}`, money(m.cost)]);
    const integrations = Array.isArray(f.integrations) ? f.integrations : null;
    return [this.h2(c, "Session"),
      v_flex().gap(10).child(this.kv(c, rows))
        .when(models.length > 0, (el) => el.child(this.subhead(c, "By model")).child(this.kv(c, models))),
      v_flex().mt(14).gap(10).child(this.subhead(c, "Integrations"))
        .when(!integrations, (el) => el.child(this.note(c, "Engram and MCP status are not published by this session yet")))
        .when(Boolean(integrations), (el) => el.child(v_flex().gap(1).children(integrations.map((it, i) => h_flex().id(`int-${i}`).min_h(28).px(6).py(5).gap(8).items_center()
          .child(svg(ICON(/engram/i.test(it.name) ? "db" : "plug")).size(13).flex_none().text_color(c.muted))
          .child(div().flex_1().min_w(0).truncate().child(String(it.name ?? "")))
          .child(state(c, it.ok ? "done" : "idle", String(it.state ?? "")))))))];
  }

  empty(c) {
    return [v_flex().gap(6).pt(4)
      .child(div().font_weight(600).text_size(13).line_height("19.5px").text_color(c.text).child("No Gentle Shell session here"))
      .child(this.note(c, "Focus a tab running gentle-shell to see its changes, todo, agents, jobs, review and stats."))];
  }

  render() {
    const c = tokens();
    const term = targetTerminal(this.last);
    if (term) this.last = term.address;
    const f = this.source.of(term);
    this.feed = f;
    const body = f ? this[this.tab](c, f) : this.empty(c);
    return v_flex().id("root").size_full().min_h(0).font_family(c.sans).text_color(c.text)
      .child(this.strip(c, f))
      .child(v_flex().id("ipanel").flex_1().min_h(0).p(14).overflow_y_scrollbar().text_size(12.5).line_height("18.75px")
        .children(body));
  }
}
