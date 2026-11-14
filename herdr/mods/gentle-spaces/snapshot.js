// Reads the Gentle Shell desktop snapshots (T4, docs/desktop-feed.md) and follows the focused
// Gentle Shell terminal, the same way the centre chat (herdr/mods/gentle-chat) does.
//
// CANONICAL COPY, carried byte-identical as `./snapshot.js` by every gentle-* mod that shows
// snapshot data (gpui-shell refuses imports outside a mod's folder). `readFeeds` and `matchFeed`
// are copied from herdr/mods/gentle-chat/session.js (owned by the chat task) and must keep the
// same rules; `targetTerminal` mirrors GentleChat.target() so every region shows one session.

import { readFile, readdir } from "fs/promises";
import { agents, terminals, focused, home, watchFolder } from "herdr";

export const FEED_SCHEMA = "gentle-shell.desktop-feed/v1";
// <agentDir>/desktop/sessions, agentDir = ~/.gentle-shell/agent (as gentle-chat/session.js).
export const feedDir = () => `${home()}/.gentle-shell/agent/desktop/sessions`;
const MAX_FEEDS = 64; // a bounded read per refresh, even with many crashed leftovers

// Every live snapshot, newest first. Unreadable, foreign or partial files are skipped.
export async function readFeeds() {
  let names;
  try {
    names = await readdir(feedDir());
  } catch {
    return [];
  }
  const feeds = [];
  for (const name of names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).slice(0, MAX_FEEDS)) {
    try {
      const feed = JSON.parse(await readFile(`${feedDir()}/${name}`, "utf8"));
      if (feed?.schema === FEED_SCHEMA && feed.identity) feeds.push(feed);
    } catch {
      // being replaced or not ours: the next refresh reads it again
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

// Keeps `feeds` fresh: a watch on the snapshot folder plus a gentle fallback timer (the folder may
// not exist yet, and a missed event must not freeze the view). `onChange(cx)` runs only when a
// snapshot really changed (the publisher rewrites a file only when its content changed).
export class FeedSource {
  constructor() {
    this.feeds = [];
    this.key = "";
    this.loading = false;
    this.again = false;
    this.watching = false;
  }

  start(cx, onChange, every = 10000) {
    this.onChange = onChange;
    cx.timer.every(every, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    if (!this.watching) this.watch(cx);
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        do {
          this.again = false;
          const feeds = await readFeeds();
          const key = feeds.map((f) => `${f.identity.sessionId}@${f.updatedAt}`).join("|");
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

  watch(cx) {
    this.watching = true;
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          await watchFolder(feedDir());
          this.refresh(cx);
        }
      } catch {
        this.watching = false; // no folder yet: the timer reads and tries the watch again
      }
    });
  }

  // The snapshot of a terminal (an entry of terminals()), or null.
  of(terminal) {
    return terminal ? matchFeed(terminal, this.feeds) : null;
  }
}
