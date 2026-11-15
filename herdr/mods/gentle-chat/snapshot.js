// Reads the Gentle Shell desktop snapshots (T4, docs/desktop-feed.md) and follows the focused
// Gentle Shell terminal, the same way the centre chat (herdr/mods/gentle-chat) does.
//
// CANONICAL COPY, carried byte-identical as `./snapshot.js` by every gentle-* mod that shows
// snapshot data, gentle-chat included (gpui-shell refuses imports outside a mod's folder).
// `targetTerminal` mirrors GentleChat.target() so every region shows one session.
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

import { readFile, readdir } from "fs/promises";
import { agents, terminals, panes, focused, home, watchFolder, exec, run, shared, setShared } from "herdr";

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
// crashed session leaves its snapshot behind until the next session start sweeps it). Without
// `ps` (Windows) every snapshot counts as live.
const ALIVE_MS = 5000;
const alive = new Map(); // pid -> { ok, at }
export async function liveFeeds(feeds) {
  const now = Date.now();
  const want = [...new Set(feeds.map((f) => f.identity?.pid).filter(positive))].filter((pid) => !(now - (alive.get(pid)?.at ?? 0) < ALIVE_MS));
  if (want.length) {
    try {
      // `ps -p` lists the pids that run; it exits 1 when one of them does not.
      const r = await exec("ps", ["-o", "pid=", "-p", want.join(",")], { timeout: 3000 });
      if (r.code === 0 || r.code === 1) {
        const running = new Set(String(r.stdout).split(/\s+/).map(Number).filter(positive));
        for (const pid of want) alive.set(pid, { ok: running.has(pid), at: now });
      }
    } catch {
      // no ps: the publisher's own sweep is the only cleanup
    }
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
export function matchFeed(terminal, feeds) {
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
export const SESSION_KINDS = {
  herdr: { kind: "herdr", label: "Herdr", section: "In this window", icon: "kind-herdr", about: "Runs in a Herdr terminal of this window: Chat | Terminal, typed input" },
  tui: { kind: "tui", label: "TUI", section: "Other terminals", icon: "kind-tui", about: "A Gentle Shell TUI in another terminal: no Terminal here, input through its inbox" },
};
// A session's kind: a Herdr terminal of this window runs it, or it runs elsewhere.
export const sessionKind = (s) => (s?.terminal ? SESSION_KINDS.herdr : SESSION_KINDS.tui);

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
// Shell terminal's, else one in the shown tab, else the last one shown (`last`, a session key),
// else a Herdr one, else the newest snapshot. Mirrors targetTerminal for Herdr terminals.
export function targetSession(feeds, last) {
  const all = allSessions(feeds);
  const picked = pickedKey();
  const chosen = picked ? all.find((s) => s.key === picked) : null;
  if (chosen) return chosen;
  const f = focused();
  const byAddr = (a) => (a ? all.find((s) => s.terminal?.address === a) : undefined);
  const inTab = agents().filter((a) => isGentle(a.app) && a.tab === f?.tab);
  return byAddr(f?.agent) ?? byAddr(f?.terminal) ?? byAddr(inTab[0]?.address)
    ?? (last ? all.find((s) => s.key === last) : undefined) ?? all.find((s) => s.terminal) ?? all[0] ?? null;
}

// The Gentle Shell terminal the window is about: the focused one, else one in the shown tab,
// else the last one shown (`last`), else the first. Mirrors GentleChat.target().
export function targetTerminal(last) {
  const all = gentleTerminals();
  const f = focused();
  const byAddr = (a) => (a ? all.find((t) => t.address === a) : undefined);
  const inTab = agents().filter((a) => isGentle(a.app) && a.tab === f?.tab);
  return byAddr(f?.agent) ?? byAddr(f?.terminal) ?? byAddr(inTab[0]?.address) ?? byAddr(last) ?? all[0] ?? null;
}

// Keeps `feeds` fresh: a watch on every root's snapshot folder plus a gentle fallback timer (a
// folder may not exist yet, and a missed event must not freeze the view). `onChange(cx)` runs only
// when a snapshot really changed (the publisher rewrites a file only when its content changed).
export class FeedSource {
  constructor() {
    this.feeds = [];
    this.key = "";
    this.loading = false;
    this.again = false;
    this.watching = new Set(); // the snapshot folders watched now
  }

  start(cx, onChange, every = 10000) {
    this.onChange = onChange;
    cx.timer.every(every, (cx) => this.refresh(cx));
    this.refresh(cx);
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
            this.feeds = feeds;
            this.onChange?.(cx);
            cx.notify();
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
