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

import { readFile, readdir } from "fs/promises";
import { agents, terminals, focused, home, watchFolder } from "herdr";

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
          const feeds = await readFeeds(roots);
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
}
