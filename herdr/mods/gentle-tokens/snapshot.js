// Reads the Gentle Shell desktop snapshots (T4, docs/desktop-feed.md) and follows the focused
// Gentle Shell terminal, the same way the centre chat (herdr/mods/gentle-chat) does.
//
// CANONICAL COPY, carried byte-identical as `./snapshot.js` by every gentle-* mod that shows
// snapshot data, gentle-chat included (gpui-shell refuses imports outside a mod's folder).
// `targetSession` names the one session every region shows.
//
// Gentle Shell runs bundled (agent dir ~/.gentle-shell/agent), as the npm / Pi extension
// (~/.pi/agent) or with its own home (GENTLE_PI_AGENT_HOME / PI_CODING_AGENT_DIR). Snapshots are
// read from every agent dir in `agentRoots()`; each session's own `identity.agentDir` is where its
// actions go (actions.js).
//
// EVERY SESSION (T11, S10): the window shows every live Gentle Shell session on the machine,
// wherever it runs (Herdr app, the Herdr TUI, Ghostty, any terminal). A session is a live snapshot
// (its publisher's pid still runs) with the Herdr terminal that runs it when one matches
// (`allSessions`), or a Gentle Shell terminal with no snapshot (an older Gentle Shell). The session
// the window is about (`targetSession`) follows Herdr's focus, unless a session that runs outside
// Herdr app was picked in a list (`selectSession`): every mod then shows that one, until Herdr's
// focus moves to another terminal.
//
// ONE READER (S13, herdr/PERF.md): only the leader's FeedSource (gentle-status, always mounted in
// the gentle-shell layout: `start(cx, null, every, { lead: true })`) watches the snapshot folders,
// reads them and runs `ps`; it publishes what it read in shared state only when the digest
// changes (`FEEDS_KEY`, then `FEEDS_DIGEST_KEY`). Every other FeedSource follows: no timer, no
// watch, no `ps`; its `feeds` are the published ones, and setting shared state re-renders every
// mod. A copy in a layout without the leader reads for itself, as before, and publishes nothing.

import { readFile, readdir } from "fs/promises";
import { agents, terminals, panes, focused, home, layout, watchFolder, exec, run, shared, setShared } from "herdr";

export const FEED_SCHEMA = "gentle-shell.desktop-feed/v1";
// Extra agent dirs, one per custom Gentle Shell home: `{ "roots": ["/abs/dir", "~/dir"] }` (or a
// bare array). Optional; the two default homes are always read.
export const rootsFile = () => `${home()}/.config/herdr-app/gentle-shell-roots.json`;
const MAX_ROOTS = 8;
const MAX_FEEDS = 64; // a bounded read per root and refresh, even with many crashed leftovers

const trimSlash = (p) => (p.length > 1 ? p.replace(/[/\\]+$/, "") : p);
export const isAbsolute = (p) => typeof p === "string" && (p.startsWith("/") || /^[A-Za-z]:[/\\]/.test(p));
const expand = (p) => (p === "~" ? home() : p.startsWith("~/") ? `${home()}${p.slice(1)}` : p);

// The agent dirs to read, bundled first: ~/.gentle-shell/agent, ~/.pi/agent, then the entries of
// the roots file (absolute or ~/), without duplicates.
export async function agentRoots() {
  const roots = [`${home()}/.gentle-shell/agent`, `${home()}/.pi/agent`];
  try {
    const parsed = JSON.parse(await readFile(rootsFile(), "utf8"));
    const extra = Array.isArray(parsed) ? parsed : parsed?.roots;
    if (Array.isArray(extra)) for (const r of extra) if (typeof r === "string" && r.trim()) roots.push(expand(r.trim()));
  } catch {
    // no roots file (the usual case) or not JSON: the default homes only
  }
  const seen = new Set();
  return roots.map(trimSlash).filter((r) => isAbsolute(r) && !seen.has(r) && seen.add(r)).slice(0, MAX_ROOTS);
}

// The snapshot folder of an agent dir (lib/desktop-feed-store.ts desktopFeedDirectory).
export const feedDirOf = (root) => `${root}/desktop/sessions`;

// Every live snapshot of every root (default: agentRoots()), newest first. Unreadable, foreign or
// partial files are skipped. A snapshot from an older Gentle Shell without `identity.agentDir`
// gets the root it was found in.
export async function readFeeds(roots) {
  const feeds = [];
  const seen = new Set();
  for (const root of roots ?? await agentRoots()) {
    const dir = feedDirOf(root);
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).slice(0, MAX_FEEDS)) {
      try {
        const feed = JSON.parse(await readFile(`${dir}/${name}`, "utf8"));
        if (feed?.schema !== FEED_SCHEMA || !feed.identity) continue;
        if (!isAbsolute(feed.identity.agentDir)) feed.identity.agentDir = root;
        const id = `${feed.identity.sessionId}@${feed.identity.pid}`;
        if (seen.has(id)) continue; // one home reached twice (a symlink, a repeated root)
        seen.add(id);
        feeds.push(feed);
      } catch {
        // being replaced or not ours: the next refresh reads it again
      }
    }
  }
  return feeds.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

const positive = (n) => Number.isInteger(n) && n > 0;

// Whether each publisher still runs: one `ps` for the pids not checked in the last ALIVE_MS (a
// crashed session leaves its snapshot behind until the next session start sweeps it). Where `ps`
// cannot start (native Windows) or does not answer, one `tasklist` lists the running pids instead.
// A listing that did not answer decides nothing: when neither answers, every snapshot counts as live.
const ALIVE_MS = 5000;
const alive = new Map(); // pid -> { ok, at }

// `tasklist /NH /FO CSV` rows: "Image Name","PID","Session Name","Session#","Mem Usage".
export const parseTasklistPids = (stdout) =>
  new Set([...String(stdout).matchAll(/^"[^"]*","(\d+)"/gm)].map((m) => Number(m[1])));

export async function liveFeeds(feeds) {
  const now = Date.now();
  const want = [...new Set(feeds.map((f) => f.identity?.pid).filter(positive))].filter((pid) => !(now - (alive.get(pid)?.at ?? 0) < ALIVE_MS));
  if (want.length) {
    let running = null;
    try {
      // `ps -p` lists the pids that run; it exits 1 when one of them does not. A `ps` that rejects
      // its own flags (MSYS/Git `ps` on Windows) also exits 1, but writes why on stderr: no answer.
      const r = await exec("ps", ["-o", "pid=", "-p", want.join(",")], { timeout: 3000 });
      if (r.code === 0 || (r.code === 1 && !r.stderr)) running = new Set(String(r.stdout).split(/\s+/).map(Number).filter(positive));
    } catch {
      // `ps` cannot start
    }
    if (!running) {
      try {
        const r = await exec("tasklist", ["/NH", "/FO", "CSV"], { timeout: 3000 });
        if (r.code === 0) running = parseTasklistPids(r.stdout);
      } catch {
        // neither: the publisher's own sweep is the only cleanup
      }
    }
    if (running) for (const pid of want) alive.set(pid, { ok: running.has(pid), at: now });
    if (alive.size > 256) for (const [pid, v] of alive) if (now - v.at > 60000) alive.delete(pid);
  }
  return feeds.filter((f) => alive.get(f.identity?.pid)?.ok !== false);
}

// One session, across every mod and refresh: its agent dir and session id.
export const feedKey = (feed) => (feed?.identity ? `${feed.identity.agentDir}|${feed.identity.sessionId}` : null);

// The snapshot of the session running in `terminal` (an entry of `terminals()`), or null.
// A terminal's own pid, or its foreground process, is the publisher or one of its ancestors
// (the launcher, the shell); a Herdr pane id the publisher saw in HERDR_PANE_ID also matches.
// The nearest process match wins; ties go to the newest snapshot.
// A terminal on another machine (S14: its address is "<machine>/<id>") never matches: its pids are
// that machine's, and the snapshots read here are this computer's.
export function matchFeed(terminal, feeds) {
  if (machineOf(terminal?.address)) return null;
  const pids = [terminal?.pid, terminal?.foreground?.pid].filter(positive);
  const ids = [terminal?.address, terminal?.id, terminal?.pane, terminal?.pane_id].filter((v) => typeof v === "string" && v);
  let best = null;
  let bestRank = Infinity;
  for (const feed of feeds) {
    const id = feed.identity;
    const chain = [id.pid, id.ppid, ...(Array.isArray(id.ancestors) ? id.ancestors : [])].filter(positive);
    let rank = chain.findIndex((pid) => pids.includes(pid));
    if (rank < 0 && id.herdr?.paneId && ids.includes(id.herdr.paneId)) rank = chain.length;
    if (rank >= 0 && rank < bestRank) { best = feed; bestRank = rank; }
  }
  return best;
}

// The machine a Herdr address lives on: "vps/t7" → "vps"; a bare id ("t7", "wMJ:p1") is this
// computer's (null). Herdr prefixes every remote space, tab, pane and terminal id with its machine.
export function machineOf(address) {
  const m = /^([^/]+)\/./.exec(typeof address === "string" ? address : "");
  return m ? m[1] : null;
}

const APPS = new Set(["gentle-shell", "pi"]);
export const isGentle = (v) => typeof v === "string" && APPS.has(v);

// Gentle Shell terminals: the agents that report as gentle-shell / pi, and terminals that say so.
export function gentleTerminals() {
  const set = new Set(agents().filter((a) => isGentle(a.app)).map((a) => a.address));
  return terminals().filter((t) => set.has(t.address) || isGentle(t.agent) || isGentle(t.report?.app) || isGentle(t.app));
}

// Every session the window knows (see the header): { key, feed, terminal } for each live snapshot,
// with the Gentle Shell terminal of this window that runs it or null, newest first; then each
// Gentle Shell terminal of this window no snapshot matches ({ feed: null }). A herdr-core terminal
// this window does not show is another terminal: its session counts as running elsewhere.
export function allSessions(feeds) {
  const out = (feeds ?? []).map((feed) => ({ key: feedKey(feed), feed, terminal: null }));
  const rest = [];
  let shown;
  try { shown = new Set([...panes().map((p) => p.terminal), ...agents().map((a) => a.address)].filter(Boolean)); } catch { shown = null; }
  for (const t of gentleTerminals()) {
    if (shown && !shown.has(t.address)) continue;
    const feed = matchFeed(t, feeds ?? []);
    const s = feed ? out.find((x) => x.feed === feed) : null;
    if (s) { if (!s.terminal) s.terminal = t; } else rest.push({ key: `terminal|${t.address}`, feed: null, terminal: t });
  }
  return [...out, ...rest];
}

// The two kinds of session (S10), shown the same way in every region (a labelled badge with its own
// icon, tokens.js kindBadge, and the sidebar's two Agents sections):
//   herdr  runs in a herdr-core terminal of this window: the Terminal switch shows its real TUI and
//          what you type goes to that terminal (hc send / keys);
//   tui    a Gentle Shell TUI in another terminal (the Herdr TUI, Ghostty, …): no Terminal here;
//          prompts, answers and actions go through its desktop inbox.
//   remote a Herdr terminal of this window on another machine (S14, `hc machine ls`): herdr-core
//          reports its state and the Terminal shows it, but its desktop snapshot and conversation
//          are on that machine, so nothing of them is shown here (no feed, never a local match).
export const SESSION_KINDS = {
  herdr: { kind: "herdr", label: "Herdr", section: "In this window", icon: "kind-herdr", about: "Runs in a Herdr terminal of this window: Chat | Terminal, typed input" },
  tui: { kind: "tui", label: "TUI", section: "Other terminals", icon: "kind-tui", about: "A Gentle Shell TUI in another terminal: no Terminal here, input through its inbox" },
  remote: { kind: "remote", label: "Remote", section: "Other machines", icon: "kind-remote", about: "Runs on another machine: Herdr reports its state and shows its Terminal; its chat and inspector feed stay on that machine" },
};
// A session's kind: a Herdr terminal of this window (on this computer or another machine), or a
// session that runs elsewhere on this computer.
export const sessionKind = (s) => (s?.terminal ? (machineOf(s.terminal.address) ? SESSION_KINDS.remote : SESSION_KINDS.herdr) : SESSION_KINDS.tui);

// S15: a session's live state, the same words in every region (sidebar, tabs, status bar, chat):
//   blocked  a question, a permission prompt, a consent or a blocker waits for the person;
//   working  its turn runs: "Working", "Working · 2 agents", "Working · 2 agents · 1 job";
//   waiting  its turn ended while its background subagents or jobs still run: "Waiting on 2 agents"
//            (never "Idle" while that work runs);
//   idle     nothing runs.
// The publisher's own words (`activity.label`, docs/desktop-feed.md) when it says them; a snapshot
// from an older Gentle Shell gets them from its agents and jobs sections.
const counted = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
export function liveState(feed) {
  const a = feed?.activity ?? {};
  const agents = Number.isInteger(a.agents) ? a.agents : Number(feed?.agents?.active) || 0;
  const jobs = Number.isInteger(a.jobs) ? a.jobs : Array.isArray(feed?.jobs?.running) ? feed.jobs.running.length : 0;
  const work = [agents > 0 ? counted(agents, "agent") : null, jobs > 0 ? counted(jobs, "job") : null].filter(Boolean).join(" · ");
  if (feed?.pendingQuestion || a.state === "blocked") return { status: "blocked", label: "Needs you", agents, jobs, work };
  if (a.state === "working" || a.streaming) return { status: "working", label: work ? `Working · ${work}` : "Working", agents, jobs, work };
  if (a.state === "waiting" || work) return { status: "waiting", label: `Waiting on ${work || "background work"}`, agents, jobs, work };
  return { status: "idle", label: "Idle", agents, jobs, work };
}

// S15: what a session waits for, or null: { kind, word, reason, id }. kind: question (an ask tool),
// permission (a pi dialog: select, confirm, input), consent (a content-free blocker), blocked (the
// session says it waits, nothing more). `id` names this wait, so one notification per question.
const NEED_WORD = { question: "Question", permission: "Permission", consent: "Consent", blocked: "Blocked" };
export function needsYou(feed) {
  const q = feed?.pendingQuestion;
  const a = feed?.activity;
  if (!q && a?.state !== "blocked") return null;
  const kind = !q ? "blocked" : q.kind === "choice" || q.kind === "questionnaire" ? "question" : q.kind === "prompt" ? "permission" : q.kind === "consent" ? "consent" : "blocked";
  const reason = String(q?.question || a?.blockedLabel || "Waiting for your answer").replace(/\s+/g, " ").trim();
  return { kind, word: NEED_WORD[kind], reason, id: String(q?.toolCallId || q?.openedAt || "blocked") };
}

// Every Gentle Shell session that waits for the person, wherever it runs (S15, the sidebar's pinned
// "Needs you"): { key, session, need } for each live snapshot that waits (needsYou), then each
// Gentle Shell terminal of this window Herdr reports blocked whose snapshot says nothing (a remote
// one, an older Gentle Shell). Oldest wait first: the one that waited longest leads.
export function needsYouList(sessions) {
  const out = [];
  let blocked;
  try { blocked = new Map(agents().filter((a) => isGentle(a.app) && a.status === "blocked").map((a) => [a.address, a])); } catch { blocked = new Map(); }
  for (const s of sessions ?? []) {
    const need = s.feed ? needsYou(s.feed) : null;
    if (need) out.push({ key: s.key, session: s, need, since: String(s.feed.pendingQuestion?.openedAt ?? s.feed.updatedAt ?? "") });
    else if (s.terminal && blocked.has(s.terminal.address)) {
      out.push({ key: s.key, session: s, need: { kind: "blocked", word: NEED_WORD.blocked, reason: "Waiting for you in its terminal", id: "herdr" }, since: "" });
    }
  }
  return out.sort((x, y) => x.since.localeCompare(y.since));
}

// Where a session runs, for a row's second line: its Herdr terminal, its Herdr TUI pane, else its pid.
export function whereLabel(s) {
  if (s?.terminal) return s.terminal.address;
  const pane = s?.feed?.identity?.herdr?.paneId;
  if (typeof pane === "string" && pane) return `herdr ${pane}`;
  return s?.feed?.identity?.pid ? `pid ${s.feed.identity.pid}` : "";
}

// The project a session belongs to: the Git root of its folder when the snapshot names one (its
// Changes worktrees), else its real folder.
export function projectOf(feed) {
  const cwd = feed?.identity?.realCwd || feed?.project?.cwd || feed?.identity?.cwd || null;
  if (!cwd) return null;
  const roots = (feed?.changes?.worktrees ?? []).map((w) => w?.root).filter((r) => typeof r === "string" && r && (cwd === r || cwd.startsWith(`${r}/`)));
  return trimSlash(roots.sort((a, b) => b.length - a.length)[0] ?? cwd);
}
// The Herdr space (an entry of `spaces()`) whose folder holds `path`, the deepest one; a space on
// another machine or at the home folder holds nothing here.
export function spaceFor(path, list) {
  if (!path) return null;
  let best = null;
  for (const s of list ?? []) {
    const f = trimSlash(String(s?.folder ?? ""));
    if (!f || s.machine || f === trimSlash(home()) || !(path === f || path.startsWith(`${f}/`))) continue;
    if (!best || f.length > trimSlash(best.folder).length) best = s;
  }
  return best;
}

export const projectName = (path) => String(path ?? "").replace(/[/\\]+$/, "").split(/[/\\]/).pop() || String(path ?? "");

// Shared state naming the picked session that runs outside Herdr app: { key, focus, at }.
export const SESSION_KEY = "gentle-shell.session";
const focusedTerminal = () => {
  try { const f = focused(); return f?.terminal ?? f?.agent ?? null; } catch { return null; }
};

// Shows `s` in every mod. A session Herdr runs gets the keyboard on its terminal (every mod follows
// Herdr's focus); any other one is named in shared state. Call it from a host call (a click).
export function selectSession(s) {
  if (!s) return;
  if (s.terminal) {
    setShared(SESSION_KEY, null);
    try { run("pane.focus", { terminal: s.terminal.address }); } catch { /* a terminal outside the layout */ }
    return;
  }
  setShared(SESSION_KEY, { key: s.key, focus: focusedTerminal(), at: Date.now() });
}

// Forgets a picked session: Herdr's focus decides again (a Herdr tab or agent was chosen).
export function followHerdr() {
  if (shared(SESSION_KEY)) setShared(SESSION_KEY, null);
}

// The picked session's key while it still holds: Herdr's focus has not moved to another terminal.
export function pickedKey() {
  const pick = shared(SESSION_KEY);
  if (!pick || typeof pick.key !== "string") return null;
  const now = focusedTerminal();
  return now && now !== (pick.focus ?? null) ? null : pick.key;
}

// The session the window is about: the picked one (see selectSession), else the focused Gentle
// Shell terminal's, else one in the shown tab. A shown Herdr tab with no Gentle Shell session shows
// none: a Herdr tab or space was chosen, so the window follows it instead of keeping another
// session. Only with no focused tab: the last one shown (`last`, a session key), else a Herdr one,
// else the newest snapshot.
export function targetSession(feeds, last) {
  const all = allSessions(feeds);
  const picked = pickedKey();
  const chosen = picked ? all.find((s) => s.key === picked) : null;
  if (chosen) return chosen;
  const f = focused();
  const byAddr = (a) => (a ? all.find((s) => s.terminal?.address === a) : undefined);
  const inTab = agents().filter((a) => isGentle(a.app) && a.tab === f?.tab);
  const here = byAddr(f?.agent) ?? byAddr(f?.terminal) ?? byAddr(inTab[0]?.address);
  if (here || f?.tab) return here ?? null;
  return (last ? all.find((s) => s.key === last) : undefined) ?? all.find((s) => s.terminal) ?? all[0] ?? null;
}

// The live snapshots as the leader published them ({ digest, at, feeds }), and their digest alone:
// a follower compares the small digest and reads the big value only when it changed.
export const FEEDS_KEY = "gentle-shell.feeds";
export const FEEDS_DIGEST_KEY = "gentle-shell.feeds.digest";
export const FEED_LEADER = "gentle-status";

// Whether the shown layout places the leader mod in a block (gentle-shell.json: the status bar).
export function leaderShown() {
  const has = (n) => n?.content?.mod === FEED_LEADER || (Array.isArray(n?.children) && n.children.some(has));
  try { return has(layout()); } catch { return false; }
}

// Keeps `feeds` fresh. The leader (and a copy without one): a watch on every root's snapshot folder
// plus a gentle fallback timer (a folder may not exist yet, and a missed event must not freeze the
// view). `onChange(cx)` runs only when a snapshot really changed (the publisher rewrites a file
// only when its content changed). A follower reads the leader's shared value (see the header).
export class FeedSource {
  constructor() {
    this.own = []; // what this copy read itself (the leader, or a copy without one)
    this.key = "";
    this.loading = false;
    this.again = false;
    this.watching = new Set(); // the snapshot folders watched now
    this.mode = "alone"; // lead | follow | alone
    this.digest = undefined; // the published digest `cache` belongs to
    this.cache = [];
  }

  start(cx, onChange, every = 10000, { lead = false } = {}) {
    this.onChange = onChange;
    if (lead) { this.mode = "lead"; this.read(cx, every); return; }
    this.mode = "follow";
    if (leaderShown()) return;
    // A layout switch starts the mods while layout() may still be the layout before (measured):
    // look again before reading alone, and on every tick after.
    cx.timer.after(500, (cx) => { if (!leaderShown()) { this.mode = "alone"; this.read(cx, every); } });
  }

  // Reads now and every `every` ms; a copy reading alone stops once its layout places the leader.
  read(cx, every) {
    this.task = cx.timer.every(every, (cx) => {
      if (this.mode === "alone" && leaderShown()) {
        this.mode = "follow";
        this.task?.cancel();
        cx.notify();
        return;
      }
      this.refresh(cx);
    });
    this.refresh(cx);
  }

  // Every live snapshot, newest first. A follower's read is ambient (a render, a timer, a handler);
  // outside one it keeps the last value it read.
  get feeds() {
    if (this.mode !== "follow") return this.own;
    try {
      const digest = shared(FEEDS_DIGEST_KEY);
      if (digest !== this.digest) {
        const v = shared(FEEDS_KEY);
        this.cache = Array.isArray(v?.feeds) ? v.feeds : [];
        this.digest = digest;
      }
    } catch {
      // not in a host call: the last value read
    }
    return this.cache;
  }

  // The leader's publish: from a host call (a timer callback), and only the newest read. Setting
  // shared state re-renders every mod, the leader included.
  publish(cx, key, feeds) {
    cx.timer.after(1, (cx) => {
      if (key !== this.key) return;
      try {
        setShared(FEEDS_KEY, { digest: key, at: Date.now(), feeds });
        setShared(FEEDS_DIGEST_KEY, key);
      } catch {
        cx.notify(); // a copy being closed: at least this one shows it
      }
    });
  }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        do {
          this.again = false;
          const roots = await agentRoots();
          for (const root of roots) this.watch(feedDirOf(root), cx);
          const feeds = await liveFeeds(await readFeeds(roots));
          const key = feeds.map((f) => `${f.identity.agentDir}/${f.identity.sessionId}@${f.updatedAt}`).join("|");
          if (key !== this.key) {
            this.key = key;
            this.own = feeds;
            this.onChange?.(cx);
            if (this.mode === "lead") this.publish(cx, key, feeds);
            else cx.notify();
          }
        } while (this.again);
      } finally {
        this.loading = false;
      }
    });
  }

  // One watch per snapshot folder; a missing folder ends it, and the next refresh tries again.
  watch(dir, cx) {
    if (this.watching.has(dir)) return;
    this.watching.add(dir);
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(dir);
          this.refresh(cx);
        }
      } catch {
        this.watching.delete(dir); // no folder yet: the timer reads and tries the watch again
      }
    });
  }

  // The snapshot of a terminal (an entry of terminals()), or null.
  of(terminal) {
    return terminal ? matchFeed(terminal, this.feeds) : null;
  }

  // Every live session (allSessions) and the one the window is about (targetSession).
  sessions() {
    return allSessions(this.feeds);
  }

  target(last) {
    return targetSession(this.feeds, last);
  }
}
