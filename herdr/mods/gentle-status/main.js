// gentle-status: the window's status bar (region 6, design/herdr-desktop/01-inspector.html
// `.status`, l.281-283), replacing Herdr's `workspace-status` (adapted from it: the palette hint
// reads the real binding of the Gentle commands palette, `mod.open:gentle-palette`, T10). For the focused Gentle Shell session's snapshot:
//   ODD <phase> · todo <n> of <total>   the ODD phase and the current todo position
//   streaming / working / idle      activity (tok/s only when the snapshot carries it); S15: with
//                                   the live work ("working · 2 agents"), and "waiting on 2 agents"
//                                   once the turn ended while subagents or jobs still run
//   <needs you>                     the blocked label while the session waits for the person
//   Jobs <n> running · <m> done     the background jobs (bash_background, monitor)
//   Agents <n> running              S15: the session's subagents that still run, the same count as
//                                   the inspector's Agents tab (background subagents are not jobs)
//   ...                             integrations summary (when published) and ⌘K Commands
//
// Key commands (T10, herdr/keys.json): the status bar is always mounted, unlike the chat (a hidden
// stack child is unloaded while the Terminal shows), so the window-wide keys live here:
//   toggle   Chat ↔ Terminal (layout.select on the `views` stack)
//   stop     the shown session's turn, through its inbox (abort_turn: the TUI's Esc Esc; the
//            session refuses it while its agent is idle)
//   session-next / session-prev   shows the next / previous live session, wherever it runs
//            (T11; `herdr-app do gentle-status.session-next`)
//
// The snapshot reader's leader (S13, snapshot.js FeedSource): being always mounted, the status bar
// is the one mod that reads the snapshots and publishes them in shared state for every other one.
//
// Needs you (S15): the leader is also the one that tells the person when a session starts waiting
// for them (a question, a permission prompt, a consent, a blocker), when its read changed, with no
// timer or poll of its own. Herdr's convention (herdr-app src/window.rs `alert`): the "blocked"
// attention sound when Settings › Sounds is on, and a toast ("<name> needs you") unless the person is
// looking at that session; a click on the toast shows it (`gentle-status.needs-you`). Herdr already
// alerts for the agents of its own terminals, so only sessions without a Herdr terminal in this
// window (TUI sessions) are told here: never twice for one wait. One alert per session and wait
// (its question's toolCallId); waits already open when the window starts are not announced.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, window, keys, layout, nextCommand, notify, playSound, settings } from "herdr";
import { tokens, state, kbd, cap } from "./tokens.js";
import { FeedSource, selectSession, machineOf, liveState, needsYouList, projectName, projectOf } from "./snapshot.js";
import { sendAction, errorText, showTerminal } from "./actions.js";

// The Gentle palette's key as bound (herdr/keys.json binds ⌘K in the layout's section), e.g.
// "⌘K". Unbound, the chat's own ⌘K (while the chat has the keyboard) is the artboard's ⌘K.
const PALETTE = "mod.open:gentle-palette";
function paletteKey() {
  const mac = window()?.platform === "macos";
  const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
  const all = keys().filter((k) => k.action === PALETTE);
  const b = all.find((k) => k.section === "layout:gentle-shell") ?? all.find((k) => k.section === "global") ?? all[0];
  if (!b) return mac ? "⌘K" : null;
  const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
  return parts ? parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("") : null;
}

export default class GentleStatus extends View {
  init(_props, cx) {
    this.last = null;
    this.source = new FeedSource();
    this.alerted = null; // the waits already seen (null until the first read)
    this.lastNeed = null; // the session the last alert was about
    this.source.start(cx, (cx) => cx.timer.after(1, () => this.alert()), 10000, { lead: true });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        try {
          if (c === "toggle") this.toggle();
          else if (c === "stop") this.stop(cx);
          else if (c === "session-next" || c === "session-prev") this.cycle(c === "session-next" ? 1 : -1);
          else if (c === "needs-you") this.showNeed();
        } catch { /* a key command never breaks the bar */ }
      }
    });
  }

  toggle() {
    const find = (node) => (node?.id === "views" ? node : (node?.children ?? []).map(find).find(Boolean));
    const node = find(layout());
    if (!node) return;
    const chat = (node.active ?? node.children?.[0]?.id) === "chat";
    const shown = this.source.target(this.last);
    // A session outside Herdr app has no Terminal here (T11): say where it runs instead.
    if (chat && shown && !shown.terminal) { notify({ title: "Terminal", body: "This session runs in another terminal.", level: "info", timeout: 3000 }); return; }
    if (chat) showTerminal(shown?.terminal?.address ?? null);
    else run("layout.select", { stack: "views", child: "chat" });
  }

  // Every live session in turn (snapshot.js allSessions order: newest snapshot first).
  cycle(step) {
    const all = this.source.sessions();
    if (!all.length) return;
    const at = all.findIndex((s) => s.key === this.source.target(this.last)?.key);
    selectSession(all[(at + step + all.length) % all.length]);
  }

  // S15: a session newly waiting for the person, outside Herdr's own terminals: Herdr's sound and a
  // toast (see the header). Runs from a timer callback after the leader's read changed.
  alert() {
    const waits = needsYouList(this.source.sessions()).filter((w) => !w.session.terminal);
    const idOf = (w) => `${w.key}|${w.need.id}`;
    const fresh = this.alerted ? waits.filter((w) => !this.alerted.has(idOf(w))) : [];
    this.alerted = new Set(waits.map(idOf));
    if (!fresh.length) return;
    let sounds = true;
    try { sounds = settings()?.sounds?.enabled !== false; } catch { sounds = true; }
    if (sounds) playSound("blocked");
    let active = true;
    try { active = window()?.active !== false; } catch { active = true; }
    const target = this.source.target(this.last);
    const shown = target ? target.key : null;
    for (const w of fresh) {
      this.lastNeed = w.key;
      if (active && w.key === shown) continue; // looking at it
      const f = w.session.feed;
      const name = f?.identity?.sessionName || projectName(projectOf(f)) || "Gentle Shell";
      notify({ title: `${name} needs you`, body: `${w.need.word} · ${w.need.reason}`, level: "error", action: { name: "gentle-status.needs-you" } });
    }
  }

  // The toast's click: shows the session the last alert was about, else the first one waiting.
  showNeed() {
    const waits = needsYouList(this.source.sessions());
    const pick = waits.find((w) => w.key === this.lastNeed) ?? waits[0];
    if (pick) selectSession(pick.session);
  }

  // A refusal (idle agent, no session) is a toast: the bar has no line of its own for it.
  stop(cx) {
    const f = this.source.target(this.last)?.feed ?? null;
    cx.spawn(async (cx) => {
      const r = await sendAction(cx, f, "abort_turn", {});
      if (!r.ok) cx.timer.after(1, () => notify({ title: "Stop the agent", body: errorText(r), level: "info", timeout: 4000 }));
    });
  }

  render() {
    const c = tokens();
    const shown = this.source.target(this.last);
    if (shown) this.last = shown.key;
    const f = shown?.feed ?? null;
    const a = f?.activity;
    const items = f?.todo?.items ?? [];
    const at = items.findIndex((t) => t.state === "in_progress" || t.state === "blocked");
    const position = at >= 0 ? `todo ${at + 1} of ${items.length}` : items.length ? `todo ${f.todo.progress?.done ?? 0} of ${items.length} done` : null;
    const running = f?.jobs?.running?.length ?? 0;
    const done = f?.jobs?.recent?.length ?? 0;
    const live = f ? liveState(f) : null;
    const tps = Number(a?.tps ?? a?.tokensPerSecond);
    const key = paletteKey();
    const integrations = Array.isArray(f?.integrations) ? f.integrations : null;

    let bar = h_flex().id("root").size_full().px(14).gap(18).items_center().bg(c.chrome).border_t(1).border_color(c.line)
      .font_family(c.sans).text_size(12).line_height("18px").text_color(c.muted).whitespace_nowrap();
    if (!f) {
      // S14: a Gentle Shell terminal on another machine: its feed is there, not read here.
      const machine = machineOf(shown?.terminal?.address);
      bar = bar.child(div().child(machine ? `Runs on ${machine} · its desktop feed stays on that machine` : "No Gentle Shell session focused"));
    } else {
      // .phase: text colour, the phase word in accent 600.
      // Without a phase: "ODD · todo 5 of 10", or "ODD —" when there is nothing to say.
      bar = bar.child(h_flex().gap(3.5).flex_none().text_color(c.text)
        .child("ODD")
        .when(Boolean(a?.phase) || !position, (el) => el.child(div().font_weight(600).text_color(a?.phase ? c.accent : c.muted).child(a?.phase ? cap(a.phase) : "—")))
        .when(Boolean(position), (el) => el.child(`· ${position}`)));
      if (a?.streaming || a?.state === "working") {
        const word = a.streaming ? "streaming" : "working";
        bar = bar.child(state(c, "work", live.work ? `${word} · ${live.work}` : word,
          Number.isFinite(tps) && tps > 0 ? h_flex().gap(3.5).child("·").child(div().font_family(c.mono).child(`${Math.round(tps)} tok/s`)) : null));
      } else if (a?.state !== "blocked" && live.work) {
        // S15: the turn ended, its background subagents or jobs still run: never "idle".
        bar = bar.child(state(c, "work", `waiting on ${live.work}`));
      } else if (a?.state !== "blocked") {
        bar = bar.child(state(c, "idle", "idle"));
      }
      if (a?.state === "blocked") bar = bar.child(state(c, "need", a.blockedLabel || "Main agent waiting for your answer"));
      bar = bar.child(h_flex().gap(3.5).flex_none()
        .child("Jobs").child(div().font_family(c.mono).child(String(running))).child("running ·")
        .child(div().font_family(c.mono).child(String(done))).child("done"));
      // S15: the subagents still running, the inspector's Agents count (agents.active).
      if (f.agents) bar = bar.child(h_flex().gap(3.5).flex_none()
        .child("Agents").child(div().font_family(c.mono).child(String(f.agents.active ?? 0))).child("running"));
    }
    bar = bar.child(div().flex_1());
    if (integrations) {
      const ready = integrations.filter((i) => i.ok).length;
      bar = bar.child(div().child(`Integrations ${ready}/${integrations.length}`));
    }
    return bar.child(h_flex().id("palette").gap(6).items_center().cursor_pointer().hover((s) => s.text_color(c.text))
      .on_click(() => run("mod.open", { name: "gentle-palette" }))
      // The artboard's kbd sits on the text baseline of an 18px line: 1px lower than centred.
      .when(Boolean(key), (el) => el.child(kbd(c, key).mt(2)))
      .child("Commands"));
  }
}
