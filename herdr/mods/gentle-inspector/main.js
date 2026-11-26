// gentle-inspector: the right inspector of the chosen design (region 5,
// design/herdr-desktop/01-inspector.html `.inspector` / `.itabs` / `.ipanel`, l.271-279 and the
// panel rules l.191-221): a tab strip (Changes, Todo, Agents, Jobs, Review, Session) over one
// panel, for the focused Gentle Shell session's desktop snapshot (docs/desktop-feed.md).
//
// One mod draws the strip and the panels: Herdr 0.1.15 rejects a stack `"header": "tabs"` (L7),
// and a header mod would need its own copy of the snapshot reader anyway. The layout block gives
// the frame (372px, 1px border, radius 10, chrome background).
//
// Actions (T7, ./actions.js): Stop (subagent) and Cancel (job) ask the session's owners, as the
// desktop RPC does; View, Output, Open diff viewer and a change row open the TUI's own screens
// (/gentle:agents, /gentle:jobs, /gentle:changes) in the Terminal; Start review / Skip show the
// Terminal, where the review consent is answered by you; the RDD row runs
// `gentle-ai review mode enable|disable --scope global` after a confirmation that says it is
// global (every repository), as you would in a shell.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, shared, nextCommand } from "herdr";
import { tokens, eyebrow, state, bar, btn, money, sessionCost, span, clock, ago, cap, prettyModel, agentRole } from "./tokens.js";
import { FeedSource, machineOf } from "./snapshot.js";
import { sendAction, errorText, tuiCommand, showTerminal, confirm, confirmed } from "./actions.js";

const ICON = (name) => `mods/gentle-inspector/icons/${name}.svg`;
const TABS = [
  { id: "changes", label: "Changes", icon: "diff" },
  { id: "todo", label: "Todo", icon: "todo" },
  { id: "agents", label: "Agents", icon: "bot" },
  { id: "jobs", label: "Jobs", icon: "jobs" },
  { id: "review", label: "Review", icon: "review" },
  { id: "session", label: "Session", icon: "stats" },
];
const REVEAL = "gentle-inspector.reveal"; // set by gentle-chat's "Open in Changes"
const RDD_EVERY = 30000; // the RDD switch is re-read this often while the Review tab shows

// File status letter and colour (.fst.m warn, .fst.a ok).
// An untracked file is a new file: the artboard's "A" (l.497-498).
const FST = { modified: ["M", "warn"], added: ["A", "ok"], untracked: ["A", "ok"], deleted: ["D", "err"], renamed: ["R", "info"] };
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
    this.busy = null; // the action in flight ("job-<id>", "agent-<id>", "rdd", …)
    this.error = null; // the last action's refusal or failure, shown under the panel
    this.notice = null;
    this.revealAt = 0;
    this.reveal = null; // the changed file "Open in Changes" asked for
    this.rdd = null; // { cwd, effective, source, at } from `gentle-ai review mode status`
    this.source = new FeedSource();
    this.source.start(cx);
    this.waiting = null; // the wake-up set now (see wake): "tick" | "review" | null
    // Commands: a confirm dialog's Confirm (the RDD switch), and tab-<id> to show a tab.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        try {
          if (confirmed(c, cx)) { /* handled */ }
          else if (c.startsWith("tab-") && TABS.some((t) => t.id === c.slice(4))) this.select(c.slice(4), cx);
        } catch (e) {
          this.error = String(e?.message ?? e);
        }
        cx.notify();
      }
    });
  }

  select(id, cx) {
    this.tab = id;
    localStorage.setItem("tab", id);
    this.error = null;
    this.notice = null;
    cx.notify();
  }

  // ---- Actions (T7) ----

  // One action at a time; its refusal shows under the panel.
  act(key, cx, work) {
    if (this.busy) return;
    this.busy = key;
    this.error = null;
    this.notice = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const line = await work(cx);
        if (line) this.error = line;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.busy = null;
      cx.notify();
    });
  }

  owner(key, kind, args, cx) {
    this.act(key, cx, async (cx) => {
      const r = await sendAction(cx, this.feed, kind, args);
      return r.ok ? null : errorText(r);
    });
  }

  // After the await, Herdr's ambient calls (run) only work from a host call: the Terminal is
  // shown from a timer callback (T10, live: a run() right after `hc send` was ignored).
  command(key, text, cx) {
    const address = this.address;
    // A session outside Herdr app (T11): its TUI screens open in its own terminal only.
    if (!address) { this.error = "Open that session's terminal to run /commands."; cx.notify(); return; }
    this.act(key, cx, (cx) => tuiCommand(address, this.feed, text, () => cx.timer.after(1, () => showTerminal(address))));
  }

  // No standing timer (S13): what the shown tab needs, set from render and gone once it is not.
  // Running jobs show their elapsed time: a 1s redraw only while the Jobs tab shows one. The
  // Review tab's RDD row reads `gentle-ai review mode status` (at most every RDD_EVERY).
  wake(cx) {
    const ticking = this.tab === "jobs" && (this.feed?.jobs?.running?.length ?? 0) > 0;
    const review = this.tab === "review" && Boolean(this.feed);
    if (review) this.readRdd(cx); // throttled there: a new project reads at once, the same one every RDD_EVERY
    const want = ticking ? "tick" : review ? "review" : null;
    if (!want || this.waiting === want) return;
    const gen = (this.wakeGen = (this.wakeGen ?? 0) + 1);
    this.waiting = want;
    try {
      cx.timer.after(want === "tick" ? 1000 : RDD_EVERY, (cx) => {
        if (gen !== this.wakeGen) return;
        this.waiting = null;
        if (want === "tick") cx.notify(); // its render sets the next second while a job still runs
        else this.wake(cx);
      });
    } catch {
      this.waiting = null;
    }
  }

  // `gentle-ai review mode status` for the session's project: read-only, re-read now and then.
  readRdd(cx, force = false) {
    const cwd = this.feed?.project?.cwd ?? this.feed?.identity?.cwd;
    if (!cwd || this.rddLoading) return;
    if (!force && this.rdd?.cwd === cwd && Date.now() - this.rdd.at < RDD_EVERY) return;
    this.rddLoading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gentle-ai", ["review", "mode", "status", "--cwd", cwd, "--json"], { cwd, timeout: 15000 });
        const st = r.code === 0 ? JSON.parse(r.stdout)?.status : null;
        this.rdd = { cwd, effective: st?.effective ?? null, source: st?.source ?? null, at: Date.now() };
      } catch {
        this.rdd = { cwd, effective: null, source: null, at: Date.now() };
      }
      this.rddLoading = false;
      cx.notify();
    });
  }

  // The review switch: `gentle-ai review mode enable|disable`, exactly as you would run it, after
  // a confirmation. It is the GLOBAL switch (its default scope): every repository of this user
  // changes, and a repository's own clone-local "off" still wins. Its own output is the answer.
  switchRdd(cx) {
    const cwd = this.rdd?.cwd;
    const on = this.rdd?.effective === "on";
    if (!cwd || this.busy) return;
    const op = on ? "disable" : "enable";
    const args = ["review", "mode", op, "--scope", "global", "--cwd", cwd, "--json"];
    const shown = ["gentle-ai", ...args.map((a) => (a === cwd ? tilde(cwd) : a))].join(" ");
    confirm("gentle-inspector", {
      title: on ? "Turn receipt-driven review off everywhere?" : "Turn receipt-driven review on everywhere?",
      detail: `This is the GLOBAL switch: it changes receipt-driven review for ALL your repositories, not only this one (a repository's own clone-local "off" still wins). ${on ? "Review stops gating new candidates." : "It applies to future candidates only."} Runs, as in a shell: ${shown}`,
      height: 230,
    }, (cx) => this.act("rdd", cx, async () => {
      const r = await exec("gentle-ai", args, { cwd, timeout: 30000 });
      let st = null;
      try { st = JSON.parse(r.stdout)?.status ?? null; } catch { st = null; }
      if (st?.effective) this.rdd = { cwd, effective: st.effective, source: st.source ?? null, at: Date.now() };
      else this.rdd = { ...this.rdd, at: 0 }; // read it again
      if (r.code !== 0) return (r.stderr || r.stdout || `gentle-ai review mode ${op} failed`).trim().split("\n")[0];
      this.notice = `RDD is ${st?.effective ?? (op === "enable" ? "on" : "off")}${st?.source ? ` (${st.source})` : ""}.`;
      return null;
    }));
  }

  // gentle-chat's "Open in Changes" (a shared value): show the Changes tab with that file marked.
  takeReveal() {
    let r = null;
    try { r = shared(REVEAL); } catch { r = null; }
    if (!r || typeof r !== "object" || !(r.at > this.revealAt)) return;
    this.revealAt = r.at;
    this.reveal = typeof r.path === "string" ? r.path : null;
    if (TABS.some((t) => t.id === r.tab)) { this.tab = r.tab; localStorage.setItem("tab", r.tab); }
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
      review: [review ? (REVIEW_SHORT[review] ?? review) : "none", review === "consent" ? "warn" : null],
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
    return v_flex().gap(4).children(rows.map(([k, v], i) => h_flex().id(`kv-${k}-${i}`).min_w(0).overflow_hidden().whitespace_nowrap().gap(12).items_center()
      .child(div().flex_1().min_w(0).truncate().text_color(c.muted).child(k))
      // The value keeps its width up to 60% of the row, then ends in an ellipsis.
      .child(div().flex_none().max_w("60%").truncate().text_right().font_family(c.mono).text_color(c.text).child(v))));
  }

  subhead(c, text) {
    return div().mt(6).mb(2).child(eyebrow(c, text));
  }

  // ---- Panels ----

  changes(c, f) {
    const ch = f.changes;
    const head = this.h2(c, "Changes", btn(c, "open-diff", this.busy === "diff" ? "Opening…" : "Open diff viewer", {
      onClick: (_e, cx) => this.command("diff", "/gentle:changes", cx),
    }).tooltip("Open /gentle:changes in the Terminal"));
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
      const marked = Boolean(this.reveal) && (path === this.reveal || path.endsWith(`/${this.reveal}`) || this.reveal.endsWith(`/${path}`));
      return h_flex().id(`file-${i}`).w_full().min_w(0).overflow_hidden().min_h(28).px(6).py(5).gap(8).items_center().rounded(6).cursor_pointer()
        .when(marked, (el) => el.bg(c.selected))
        .hover((s) => s.bg(c.selected)).tooltip("Open /gentle:changes in the Terminal")
        .on_click((_e, cx) => { this.reveal = path; this.command("diff", "/gentle:changes", cx); })
        .child(div().w(16).flex_none().font_family(c.mono).font_weight(600).text_size(11).line_height("11px").text_color(c[tone]).child(letter))
        .child(h_flex().flex_1().min_w(0).overflow_hidden()
          .when(cut > 0, (el) => el.child(div().flex_shrink(1).min_w(0).truncate().text_color(c.muted).child(path.slice(0, cut))))
          .child(div().flex_none().text_color(c.text).child(path.slice(cut))))
        // null counts: a binary or oversized new file (docs/desktop-feed.md); it shows none.
        .when(file.added !== null, (el) => el.child(div().flex_none().font_family(c.mono).text_color(c.ok).child(`+${file.added ?? 0}`)))
        .when(file.deleted !== null, (el) => el.child(div().flex_none().font_family(c.mono).text_color(c.err).child(`−${file.deleted ?? 0}`)));
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
      const tone = now ? "warn" : null; // .todo .now: warn tick, warn second line (l.205-208)
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
        .child(h_flex().gap(6).items_baseline().min_w(0).overflow_hidden().whitespace_nowrap()
          .child(div().flex_none().font_family(c.mono).font_weight(600).text_size(10.5).line_height("16.8px").text_color(c.accent)
            .child((a.role ? String(a.role) : agentRole(a.name)).toUpperCase()))
          .when(Boolean(a.title), (el) => el.child(div().min_w(0).truncate().font_weight(600).text_color(c.text).child(String(a.title)))))
        // The state and its step give way (truncate); model and spend keep their width.
        .child(h_flex().min_w(0).overflow_hidden().whitespace_nowrap().gap(10).items_center().text_size(12).line_height("18px").text_color(c.muted)
          .child(state(c, kind, null, div().min_w(0).truncate().child(`${word}${step}`)).flex_shrink_1().min_w(0))
          .when(Boolean(a.model), (el) => el.child(div().flex_none().max_w("40%").truncate().child(prettyModel(String(a.model)))))
          .when(Boolean(a.spend?.cost), (el) => el.child(div().flex_none().font_family(c.mono).child(money(a.spend.cost)))))
        .when(live, (el) => el.child(h_flex().mt(4).gap(6)
          .child(btn(c, `ag-view-${i}`, "View", { onClick: (_e, cx) => this.command(`view-${i}`, "/gentle:agents", cx) }).tooltip("Open /gentle:agents in the Terminal"))
          .when(Boolean(a.id), (el) => el.child(btn(c, `ag-stop-${i}`, this.busy === `agent-${a.id}` ? "Stopping…" : "Stop", {
            danger: true, icon: ICON("stop"), onClick: (_e, cx) => this.owner(`agent-${a.id}`, "cancel_subagent", { id: a.id }, cx),
          }).tooltip("Stop this subagent")))));
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
      if (live) {
        kind = "work"; word = "Running";
        action = j.id ? btn(c, `job-cancel-${i}`, this.busy === `job-${j.id}` ? "Cancelling…" : "Cancel", {
          danger: true, onClick: (_e, cx) => this.owner(`job-${j.id}`, "cancel_job", { id: j.id }, cx),
        }).tooltip("Stop this background job") : null;
      }
      else if (j.status === "exited" && (j.exitCode ?? 0) === 0) { kind = "done"; word = "Passed"; }
      else if (j.status === "stopped") { kind = "idle"; word = "Stopped"; }
      else {
        kind = "fail";
        word = j.exitCode != null && j.exitCode !== 0 ? `Failed · exit ${j.exitCode}` : "Failed";
        action = btn(c, `job-output-${i}`, "Output", { onClick: (_e, cx) => this.command(`output-${i}`, "/gentle:jobs", cx) })
          .tooltip("Open /gentle:jobs in the Terminal");
      }
      const elapsed = live ? now - (Number(j.startedAt) || now) : j.elapsedMs;
      return v_flex().id(`job-${live ? "r" : "f"}-${j.id ?? i}`).p(6).gap(2).rounded(6)
        .child(h_flex().min_w(0).overflow_hidden().gap(8).items_center()
          .child(div().flex_1().min_w(0).truncate().font_family(c.mono).text_size(12).line_height("18px").text_color(c.text).child(String(j.label ?? "")))
          .when(Boolean(action), (el) => el.child(action)))
        .child(h_flex().min_w(0).overflow_hidden().whitespace_nowrap().gap(10).items_center().text_size(12).line_height("18px").text_color(c.muted)
          .child(state(c, kind, null, div().min_w(0).truncate().child(word)).flex_shrink_1().min_w(0))
          .child(div().flex_none().font_family(c.mono).child(clock(elapsed)))
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
        .child(div().font_weight(600).text_size(13).line_height("19.5px").text_color(c.text).child(r ? String(r.label || cap(r.state)) : "No review yet"))
        .child(div().truncate().text_color(c.muted).child(r ? (r.scope ? `Candidate: ${r.scope}` : "No candidate yet") : "Nothing has asked for review in this session")));
    const rdd = this.rddRow(c);
    if (!r) return [head, v_flex().gap(10).child(box).child(rdd)];
    const ask = r.state === "ready" || r.state === "consent";
    // Review consent is yours, in the real prompt: both buttons show it in the Terminal.
    const toPrompt = () => { if (this.address) showTerminal(this.address); else { this.error = "Answer the review consent in that session's terminal."; } };
    return [head, v_flex().gap(10).child(box)
      .child(this.kv(c, [["State", REVIEW_SHORT[r.state] ?? r.state]]))
      .child(rdd)
      .when(ask, (el) => el.child(h_flex().gap(6)
        .child(btn(c, "review-start", "Start review", { primary: true, onClick: toPrompt }).tooltip("Answer the review consent in the Terminal"))
        .child(btn(c, "review-skip", "Skip for this change", { onClick: toPrompt }).tooltip("Answer the review consent in the Terminal"))))];
  }

  // The kv row "RDD  on · global" (01-inspector.html l.581); the value is the switch.
  rddRow(c) {
    const st = this.rdd;
    const word = this.busy === "rdd" ? "switching…" : st?.effective ? `${st.effective}${st.source ? ` · ${st.source}` : ""}` : st ? "unknown" : "…";
    const can = Boolean(st?.effective) && !this.busy;
    return h_flex().id("kv-rdd").gap(12).items_center()
      .child(div().flex_1().min_w(0).truncate().text_color(c.muted).child("RDD"))
      .child(div().id("rdd-switch").flex_none().text_right().font_family(c.mono).text_color(c.text).child(word)
        .when(can, (el) => el.cursor_pointer().hover((s) => s.text_color(c.accentSoft))
          .tooltip(st.effective === "on" ? "Turn receipt-driven review off for all repositories (gentle-ai review mode disable)" : "Turn receipt-driven review on for all repositories (gentle-ai review mode enable)")
          .on_click((_e, cx) => this.switchRdd(cx))));
  }

  session(c, f) {
    const st = f.stats ?? {};
    const rows = [
      ["Turns", String(st.turns ?? 0)],
      ["Tool calls", String(st.toolCalls ?? 0)],
      ["Duration", span(st.durationMs)],
      ["Cost", sessionCost(f.cost?.total ?? st.cost)],
      ["Subagent spend", money(f.agents?.spend?.cost ?? 0)],
    ];
    const models = (st.models ?? []).map((m) => [`${prettyModel(m.model) ?? m.model} · ${m.turns} ${m.turns === 1 ? "turn" : "turns"}`, money(m.cost)]);
    const integrations = Array.isArray(f.integrations) ? f.integrations : null;
    return [this.h2(c, "Session"),
      v_flex().gap(10).child(this.kv(c, rows))
        .when(models.length > 0, (el) => el.child(this.subhead(c, "By model")).child(this.kv(c, models))),
      v_flex().mt(14).gap(10).child(this.subhead(c, "Integrations"))
        .when(!integrations, (el) => el.child(this.note(c, "Engram and MCP status are not published by this session yet")))
        .when(Boolean(integrations), (el) => el.child(v_flex().gap(1).children(integrations.map((it, i) => h_flex().id(`int-${i}`).min_w(0).overflow_hidden().min_h(28).px(6).py(5).gap(8).items_center()
          .child(svg(ICON(/engram/i.test(it.name) ? "db" : "plug")).size(13).flex_none().text_color(c.muted))
          .child(div().flex_1().min_w(0).truncate().child(String(it.name ?? "")))
          .child(state(c, it.ok ? "done" : "idle", String(it.state ?? "")))))))];
  }

  empty(c) {
    // S14: a Gentle Shell terminal on another machine publishes its feed there.
    const machine = machineOf(this.address);
    if (machine) {
      return [v_flex().gap(6).pt(4)
        .child(div().font_weight(600).text_size(13).line_height("19.5px").text_color(c.text).child(`Runs on ${machine}`))
        .child(this.note(c, `Its changes, todo, agents, jobs, review and stats are published on ${machine}; this window reads this computer's desktop feed only.`))];
    }
    return [v_flex().gap(6).pt(4)
      .child(div().font_weight(600).text_size(13).line_height("19.5px").text_color(c.text).child("No Gentle Shell session here"))
      .child(this.note(c, "Focus a tab running gentle-shell to see its changes, todo, agents, jobs, review and stats."))];
  }

  render(cx) {
    const c = tokens();
    // The shown session, wherever it runs (snapshot.js targetSession, T11).
    const shown = this.source.target(this.last);
    // A refusal or notice belongs to the session it came from.
    if ((shown?.key ?? null) !== this.last) { this.error = null; this.notice = null; }
    if (shown) this.last = shown.key;
    this.address = shown?.terminal?.address ?? null;
    const f = shown?.feed ?? null;
    this.feed = f;
    this.takeReveal();
    this.wake(cx);
    const body = f ? this[this.tab](c, f) : this.empty(c);
    const line = this.error ?? this.notice;
    return v_flex().id("root").size_full().min_h(0).font_family(c.sans).text_color(c.text)
      .child(this.strip(c, f))
      .child(v_flex().id("ipanel").flex_1().min_h(0).p(14).overflow_y_scrollbar().text_size(12.5).line_height("18.75px")
        .children(body)
        .when(Boolean(line), (el) => el.child(div().mt(10).text_size(12).line_height("18px").text_color(this.error ? c.err : c.muted).child(line))));
  }
}
